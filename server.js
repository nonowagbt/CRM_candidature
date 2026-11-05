// CRM Candidatures — serveur multi-utilisateur.
// Lancer : node server.js  puis ouvrir http://localhost:3000
//
// Variables d'environnement (ou fichier .env) :
//   PORT=3000                 port d'écoute
//   HOST=127.0.0.1            interface d'écoute (0.0.0.0 pour un serveur en ligne, derrière un proxy HTTPS)
//   ALLOWED_HOSTS=localhost   noms d'hôte acceptés, séparés par des virgules (ex. crm.mondomaine.fr)
//   COOKIE_SECURE=false       true dès que le site est servi en HTTPS
//   ALLOW_SIGNUP=true         false pour fermer les inscriptions
//   SECRET_KEY=<64 hex>       clé de chiffrement des mots de passe Gmail (sinon générée dans data/secret.key)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Node 18 n'expose pas globalThis.crypto (Web Crypto) dans les scripts ; imapflow en a besoin.
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const MailComposer = require('nodemailer/lib/mail-composer');
const { ImapFlow } = require('imapflow');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'localhost,127.0.0.1,[::1]').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP !== 'false';
const SESSION_DAYS = 30;

const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const KEY_FILE = path.join(DATA_DIR, 'secret.key');
const LEGACY_ITEMS = path.join(DATA_DIR, 'candidatures.json');
const LEGACY_SETTINGS = path.join(DATA_DIR, 'settings.json');
const userDir = (id) => path.join(DATA_DIR, 'users', id);

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// ---------- Fichiers ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------- Chiffrement des mots de passe Gmail ----------
function loadKey() {
  if (process.env.SECRET_KEY) {
    if (!/^[0-9a-f]{64}$/i.test(process.env.SECRET_KEY)) throw new Error('SECRET_KEY doit faire 64 caractères hexadécimaux');
    return Buffer.from(process.env.SECRET_KEY, 'hex');
  }
  if (!fs.existsSync(KEY_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
}
const KEY = loadKey();
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  if (!blob) return '';
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---------- Comptes ----------
let users = readJson(USERS_FILE, []);
const saveUsers = () => writeJson(USERS_FILE, users);
const findUser = (email) => users.find((u) => u.email === email);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
// Hash factice pour que « compte inconnu » et « mauvais mot de passe » prennent le même temps.
const DUMMY_USER = { ...hashPassword('dummy-password') };

// ---------- Sessions (seul le SHA-256 du jeton est stocké) ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
let sessions = readJson(SESSIONS_FILE, {});
const saveSessions = () => writeJson(SESSIONS_FILE, sessions);
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions[sha256(token)] = { userId, expires: Date.now() + SESSION_DAYS * 864e5 };
  saveSessions();
  return token;
}
function getSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([\w-]+)/);
  if (!m) return null;
  const key = sha256(m[1]);
  const s = sessions[key];
  if (!s) return null;
  if (s.expires < Date.now()) { delete sessions[key]; saveSessions(); return null; }
  return { key, ...s };
}
function destroyUserSessions(userId, exceptKey) {
  for (const [k, s] of Object.entries(sessions)) if (s.userId === userId && k !== exceptKey) delete sessions[k];
  saveSessions();
}
const sessionCookie = (token, maxAge) =>
  `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;

// ---------- Anti-force brute (par IP et par email) ----------
const attempts = new Map();
const LIMIT = 8, WINDOW = 15 * 60 * 1000;
function tooManyAttempts(...keys) {
  const now = Date.now();
  return keys.some((k) => { const a = attempts.get(k); return a && a.count >= LIMIT && now - a.first < WINDOW; });
}
function recordFailure(...keys) {
  const now = Date.now();
  for (const k of keys) {
    const a = attempts.get(k);
    if (!a || now - a.first > WINDOW) attempts.set(k, { count: 1, first: now });
    else a.count++;
  }
}

// ---------- Données par utilisateur ----------
const DEFAULT_SETTINGS = {
  gmailUser: '', gmailAppPasswordEnc: '', senderName: '', titre: 'Mes candidatures', tagline: '',
  pitch: '', signature: '', relanceJours: 21,
};
const cache = new Map();
function store(userId) {
  if (!cache.has(userId)) {
    const dir = userDir(userId);
    cache.set(userId, {
      items: readJson(path.join(dir, 'candidatures.json'), []),
      settings: { ...DEFAULT_SETTINGS, ...readJson(path.join(dir, 'settings.json'), {}) },
    });
  }
  return cache.get(userId);
}
const saveItems = (userId) => writeJson(path.join(userDir(userId), 'candidatures.json'), store(userId).items);
const saveSettings = (userId) => writeJson(path.join(userDir(userId), 'settings.json'), store(userId).settings);

// Le premier compte créé récupère les données de la version mono-utilisateur.
function migrateLegacy(user) {
  const s = store(user.id);
  if (fs.existsSync(LEGACY_ITEMS)) {
    s.items = readJson(LEGACY_ITEMS, []);
    fs.renameSync(LEGACY_ITEMS, `${LEGACY_ITEMS}.migre`);
  }
  if (fs.existsSync(LEGACY_SETTINGS)) {
    const old = readJson(LEGACY_SETTINGS, {});
    if (old.gmailAppPassword) old.gmailAppPasswordEnc = encrypt(old.gmailAppPassword);
    delete old.gmailAppPassword;
    Object.assign(s.settings, old);
    fs.renameSync(LEGACY_SETTINGS, `${LEGACY_SETTINGS}.migre`);
  }
  if (!s.settings.gmailAppPasswordEnc && process.env.GMAIL_APP_PASSWORD) {
    s.settings.gmailAppPasswordEnc = encrypt(process.env.GMAIL_APP_PASSWORD.replace(/\s/g, ''));
    s.settings.gmailUser = s.settings.gmailUser || process.env.GMAIL_USER || '';
  }
  saveItems(user.id);
  saveSettings(user.id);
}

const ALLOWED_FIELDS = [
  'entreprise', 'poste', 'type', 'canal', 'email', 'contact', 'lienOffre',
  'dateCandidature', 'dateReponse', 'dateEntretien', 'statut', 'notes', 'thread', 'adresse',
  'derniereRelance', 'nbRelances', 'brouillonRelance',
];
function sanitize(body) {
  const out = {};
  for (const k of ALLOWED_FIELDS) if (body[k] !== undefined) out[k] = String(body[k]).slice(0, 5000);
  return out;
}

const SETTINGS_FIELDS = { gmailUser: 200, senderName: 120, titre: 80, tagline: 200, pitch: 3000, signature: 1000 };
function publicSettings(s) {
  const { gmailAppPasswordEnc, ...rest } = s;
  return { ...rest, hasPassword: Boolean(gmailAppPasswordEnc), gmail: Boolean(s.gmailUser && gmailAppPasswordEnc) };
}

// ---------- Gmail ----------
function imapClient(user, pass) {
  return new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, logger: false, auth: { user, pass: String(pass).replace(/\s/g, '') } });
}

// Crée un brouillon dans Gmail (IMAP APPEND dans Brouillons), rattaché au fil d'origine si possible.
async function createGmailDraft(settings, { to, subject, text, thread }) {
  const client = imapClient(settings.gmailUser, decrypt(settings.gmailAppPasswordEnc));
  await client.connect();
  try {
    const boxes = await client.list();
    const drafts = boxes.find((b) => b.specialUse === '\\Drafts');
    const allMail = boxes.find((b) => b.specialUse === '\\All');
    if (!drafts) throw new Error('Dossier Brouillons introuvable dans Gmail');

    let reply = null;
    if (thread && allMail && /^[0-9a-f]+$/i.test(thread)) {
      const lock = await client.getMailboxLock(allMail.path);
      try {
        const uids = await client.search({ threadId: BigInt('0x' + thread).toString() }, { uid: true });
        if (uids && uids.length) {
          const last = await client.fetchOne(String(uids[uids.length - 1]), { envelope: true, headers: ['references'] }, { uid: true });
          const refs = last.headers ? last.headers.toString().replace(/^references:\s*/i, '').replace(/\s+/g, ' ').trim() : '';
          reply = { messageId: last.envelope.messageId, subject: last.envelope.subject, references: refs };
        }
      } finally { lock.release(); }
    }

    const mail = {
      from: settings.senderName ? `"${settings.senderName.replace(/"/g, '')}" <${settings.gmailUser}>` : settings.gmailUser,
      to, text,
      subject: reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : subject,
    };
    if (reply && reply.messageId) {
      mail.inReplyTo = reply.messageId;
      mail.references = [reply.references, reply.messageId].filter(Boolean).join(' ');
    }
    const raw = await new MailComposer(mail).compile().build();
    await client.append(drafts.path, raw, ['\\Draft', '\\Seen']);
    return { inThread: Boolean(reply), subject: mail.subject };
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---------- Synchronisation avec Gmail + centre de notifications ----------
// Lit les mails récents (envoyés et reçus) :
//  - mail envoyé après la candidature → relance (date, compteur) ;
//  - mail reçu lié à une candidature ou au recrutement → notification classée (refus, entretien,
//    accusé de réception, offre clôturée, réponse) avec statut suggéré ;
//    « Postulé » passe à « Réponse reçue » pour une vraie réponse (pas un simple accusé de réception).
// Correspondance : fil Gmail, adresse exacte, puis nom de l'entreprise (utile pour Indeed, LinkedIn…).
const { simpleParser } = require('mailparser');
const SYNC_FIRST_DAYS = 60;
const syncFile = (userId) => path.join(userDir(userId), 'sync.json');
const notifFile = (userId) => path.join(userDir(userId), 'notifications.json');
const syncRunning = new Map();
const addrList = (c) => (c.email || '').toLowerCase().split(/[,;]/).map((e) => e.trim()).filter(Boolean);
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
const frDate = (d) => d.split('-').reverse().join('/');
const norm = (t) => (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const PLATFORMS = [
  ['Indeed', /(^|\.)indeed\.com$/], ['LinkedIn', /(^|\.)linkedin\.com$/], ['Hellowork', /(^|\.)hellowork\.com$/],
  ['Welcome to the Jungle', /welcometothejungle\.com$|welcomekit\.co$/], ['JobTeaser', /jobteaser\.com$/], ['APEC', /apec\.fr$/],
  ['France Travail', /francetravail\.fr$|pole-emploi\.fr$/],
  ['Site carrière', /successfactors|myworkday|smartrecruiters|teamtailor|taleez|digitalrecruiters|beetween|njoyn|recruitee|lever\.co|greenhouse|join\.com|gestmax|csod|oraclecloud|cloud\.oracle\.com|jobvite|icims|talent-soft|flatchr/],
];
// Alertes d'offres, newsletters : jamais de notification.
const NOISE_FROM = /match\.indeed\.com|jobalert\.indeed\.com|notification@emails\.hellowork|newsletter@|alerte@emails\.hellowork|jobs-listings@linkedin|jobalerts-noreply@linkedin|news@|marketing@|twinehq\.com/;
// Mails automatiques des plateformes qui ne sont pas des réponses (sondages, rappels, activation de compte…).
const NOISE_SUBJECT = /^suite de votre candidature au poste|avez[- ]vous finalis|finalisez votre candidature|r[ée]capitulatif de votre semaine|vient de consulter votre (cv|profil)|account created|confirmation de votre identit|identit[ée] confirm|activation de la prochaine|activez votre|activate your|complete your (profile|candidate)|votre avis à la suite/i;
const RECRUIT_RE = /candidature|postul|application|entretien|interview|recrutement|recruit|stage|alternance|poste|offre d.emploi|ton profil|votre profil/i;
const KINDS = {
  refus: /(ne (pouvons|pourrons|sommes) pas (en mesure de )?(donner|y donner|réserver) (une )?suite|pas (pu )?(été )?retenue?|au regret|malheureusement|regrettons|not (been )?(selected|moving forward)|unfortunately|ne correspond (malheureusement )?pas|autres? profils?|poste (a été |est )?pourvu|offre (a été )?pourvue|n'a pas été retenue|décidé de ne pas donner suite|aucun poste|pas de (poste|besoin)|n'ayant pas de (besoin|poste)|équipe (est )?(déjà )?complète|passé à l'étape suivante.{0,80}sans)/i,
  entretien: /(entretien|interview|rendez-vous|rdv|créneau|disponibilit|échanger (ensemble|avec (vous|toi))|appel (téléphonique|visio)|visio|teams|google meet|calendly|bookings|rencontrer)/i,
  cloture: /(n'est plus disponible|a été fermée|offre (a été |est )?(clôturée|fermée|expirée)|no longer (available|accepting))/i,
  accuse: /(bien re[çc]u|candidature est arrivée|accus(é|ons) (de )?r[ée]ception|confirm(ons|ation) (de )?(la )?r[ée]ception|nous (allons|reviendrons) (étudier|vers vous)|thank you for (applying|your application)|candidature a (bien )?été (envoyée|enregistrée|prise en compte)|has been (received|submitted)|we('| wi)ll review)/i,
};
function classify(text) {
  if (KINDS.refus.test(text)) return 'refus';
  if (KINDS.cloture.test(text)) return 'cloture';
  if (KINDS.accuse.test(text) && !/entretien|interview/i.test(text.slice(0, 400))) return 'accuse';
  if (KINDS.entretien.test(text)) return 'entretien';
  return 'reponse';
}
const platformOf = (addr) => { const dom = addr.split('@')[1] || ''; const p = PLATFORMS.find(([, re]) => re.test(dom)); return p ? p[0] : null; };

function pickCandidature(cands, subject) {
  if (cands.length <= 1) return cands[0];
  // Plusieurs candidatures possibles : celle dont le poste ressemble le plus à l'objet, sinon la plus récente.
  const words = norm(subject).split(' ').filter((w) => w.length > 3);
  const score = (c) => words.filter((w) => norm(c.poste).includes(w)).length;
  return [...cands].sort((a, b) => score(b) - score(a) || (b.dateCandidature || '').localeCompare(a.dateCandidature || ''))[0];
}
function byCompanyName(items, haystack) {
  const h = ` ${norm(haystack)} `;
  return items.filter((c) => {
    if (/à compléter|a completer/i.test(c.entreprise || '')) return false;
    const n = norm((c.entreprise || '').replace(/\(.*?\)/g, ''));
    return n.length >= 3 && h.includes(` ${n} `);
  });
}

async function bodySnippet(client, uid) {
  try {
    const m = await client.fetchOne(String(uid), { source: { start: 0, maxLength: 150000 } }, { uid: true });
    const parsed = await simpleParser(m.source);
    let text = parsed.text || (parsed.html ? String(parsed.html).replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ') : '');
    // Retire les citations des mails précédents
    text = text.split(/\n\s*(?:Le .{5,80}a écrit|On .{5,80}wrote|De ?: |From: |-----Original|________________)/)[0];
    return text.replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

async function syncGmail(user) {
  if (syncRunning.has(user.id)) return syncRunning.get(user.id);
  const job = (async () => {
    const s = store(user.id);
    const { settings } = s;
    if (!settings.gmailUser || !settings.gmailAppPasswordEnc) return { skipped: true, changes: [], notifications: 0 };
    const state = readJson(syncFile(user.id), { lastSync: null, seen: [] });
    const seen = new Set(state.seen || []);
    const notifSeen = new Set(state.notifSeen || []);
    const notifs = readJson(notifFile(user.id), []);
    const me = settings.gmailUser.toLowerCase();
    const sinceBase = state.lastSync && state.lastNotifSync ? Math.min(new Date(state.lastSync), new Date(state.lastNotifSync)) : null;
    const since = sinceBase ? new Date(sinceBase - 864e5) : new Date(Date.now() - SYNC_FIRST_DAYS * 864e5);

    const byThread = new Map();
    for (const c of s.items) if (c.thread && /^[0-9a-f]+$/i.test(c.thread)) byThread.set(BigInt('0x' + c.thread).toString(), c);

    const client = imapClient(settings.gmailUser, decrypt(settings.gmailAppPasswordEnc));
    await client.connect();
    const changes = [];
    let newNotifs = 0;
    try {
      const allMail = (await client.list()).find((b) => b.specialUse === '\\All');
      if (!allMail) throw new Error('Dossier « Tous les messages » introuvable dans Gmail');
      const lock = await client.getMailboxLock(allMail.path);
      try {
        const uids = await client.search({ since }, { uid: true });
        const msgs = [];
        if (uids && uids.length) {
          for await (const m of client.fetch(uids.slice(-500), { envelope: true, threadId: true, flags: true, internalDate: true }, { uid: true })) msgs.push(m);
        }
        msgs.sort((a, b) => new Date(a.internalDate) - new Date(b.internalDate));
        for (const m of msgs) {
          const env = m.envelope || {};
          const id = env.messageId || `uid:${m.uid}`;
          const doChanges = !seen.has(id), doNotif = !notifSeen.has(id);
          if ((!doChanges && !doNotif) || (m.flags && m.flags.has('\\Draft'))) continue;
          seen.add(id); notifSeen.add(id);
          const fromObj = (env.from && env.from[0]) || {};
          const from = (fromObj.address || '').toLowerCase();
          const fromName = fromObj.name || from;
          const to = [...(env.to || []), ...(env.cc || [])].map((a) => (a.address || '').toLowerCase());
          const outgoing = from === me;
          const when = new Date(env.date || m.internalDate);
          const date = dayOf(when);
          const subject = env.subject || '';
          const threadHex = m.threadId ? BigInt(m.threadId).toString(16) : null;

          let c = m.threadId && byThread.get(String(m.threadId));
          if (!c) {
            const targets = outgoing ? to : [from];
            c = pickCandidature(s.items.filter((x) => addrList(x).some((a) => targets.includes(a))), subject);
          }
          const platform = outgoing ? null : platformOf(from);
          if (!c && !outgoing && (platform || RECRUIT_RE.test(subject))) {
            // Plateformes et sites carrière : le nom de l'entreprise est dans l'expéditeur ou l'objet.
            c = pickCandidature(byCompanyName(s.items, `${fromName} ${subject}`), subject);
          }

          if (outgoing) {
            if (!c || !doChanges) continue;
            if (!c.dateCandidature || date <= c.dateCandidature) continue; // le mail de candidature lui-même
            if (c.derniereRelance && c.derniereRelance >= date && !c.brouillonRelance) continue;
            const nb = (parseInt(c.nbRelances, 10) || 0) + 1;
            Object.assign(c, { derniereRelance: date, nbRelances: String(nb), brouillonRelance: '', updatedAt: new Date().toISOString() });
            const note = `Relance n°${nb} envoyée le ${frDate(date)} (détectée dans Gmail).`;
            c.notes = c.notes ? `${c.notes}\n${note}` : note;
            changes.push({ id: c.id, entreprise: c.entreprise, type: 'relance', date });
            notifs.push({ id: crypto.randomUUID(), kind: 'relance', date: when.toISOString(), subject: subject.slice(0, 300), from: me, fromName: 'Toi',
              snippet: `Relance envoyée à ${to.join(', ')}`, candidatureId: c.id, entreprise: c.entreprise, thread: threadHex, read: true });
            continue;
          }

          if (NOISE_FROM.test(from) || NOISE_SUBJECT.test(subject)) continue;
          if (!c && !platform && !RECRUIT_RE.test(subject)) continue; // sans rapport avec les candidatures

          const snippet = await bodySnippet(client, m.uid);
          const kind = classify(`${subject} ${snippet}`);
          if (!c && kind === 'reponse' && !platform) continue; // trop incertain pour notifier

          let suggestion = null;
          if (c) {
            if (kind === 'refus' && !['refus_direct', 'refus_entretien', 'retenu'].includes(c.statut)) suggestion = c.statut === 'entretien' || c.dateEntretien ? 'refus_entretien' : 'refus_direct';
            if (kind === 'entretien' && ['postule', 'repondu'].includes(c.statut)) suggestion = 'entretien';
            if (kind === 'cloture' && c.statut === 'postule') suggestion = 'cloture';
            if (doChanges && !['accuse', 'cloture'].includes(kind) && c.statut === 'postule' && (!c.dateCandidature || date >= c.dateCandidature)) {
              Object.assign(c, { statut: 'repondu', dateReponse: c.dateReponse || date, updatedAt: new Date().toISOString() });
              const note = `Réponse reçue le ${frDate(date)} : « ${subject.slice(0, 120)} » (détectée dans Gmail).`;
              c.notes = c.notes ? `${c.notes}\n${note}` : note;
              changes.push({ id: c.id, entreprise: c.entreprise, type: 'reponse', date });
            }
          }
          notifs.push({
            id: crypto.randomUUID(), kind, date: when.toISOString(), subject: subject.slice(0, 300),
            from, fromName: String(fromName).slice(0, 120), platform, snippet: snippet.slice(0, 400), thread: threadHex,
            candidatureId: c ? c.id : null, entreprise: c ? c.entreprise : null, suggestion,
            read: (Date.now() - when) / 864e5 > 3, // l'historique importé au premier passage arrive déjà « lu »
          });
          newNotifs++;
        }
      } finally { lock.release(); }
    } finally {
      await client.logout().catch(() => {});
    }
    if (changes.length) saveItems(user.id);
    notifs.sort((a, b) => b.date.localeCompare(a.date));
    writeJson(notifFile(user.id), notifs.slice(0, 300));
    const now = new Date().toISOString();
    writeJson(syncFile(user.id), { lastSync: now, lastNotifSync: now, seen: [...seen].slice(-5000), notifSeen: [...notifSeen].slice(-5000) });
    return { changes, notifications: newNotifs, lastSync: now };
  })();
  syncRunning.set(user.id, job);
  try { return await job; } finally { syncRunning.delete(user.id); }
}

// ---------- Plateformes : suivi via Gmail + import de l'historique LinkedIn ----------
const TRACKED_PLATFORMS = ['LinkedIn', 'Indeed', 'Hellowork', 'Welcome to the Jungle'];

// Lecteur CSV minimal (guillemets, virgules et retours à la ligne dans les champs).
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

// Dates LinkedIn : « 11/5/26, 9:19 AM » (mois/jour/année), parfois ISO.
function parseLinkedinDate(v) {
  v = String(v || '').trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const d = new Date(v);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

function guessType(title) {
  const t = norm(title);
  if (/\b(stage|stagiaire|intern|internship)\b/.test(t)) return 'Stage';
  if (/\b(alternance|alternant|apprenti|apprentissage)\b/.test(t)) return 'Alternance';
  if (/\bcdd\b/.test(t)) return 'CDD';
  if (/\b(freelance|independant)\b/.test(t)) return 'Freelance';
  return 'CDI';
}

const titleWords = (t) => new Set(norm(t).split(' ').filter((w) => w.length > 2 && !['les', 'des', 'pour', 'avec', 'stage', 'h f', 'f h'].includes(w)));
function sameCompany(a, b) {
  const x = norm((a || '').replace(/\(.*?\)/g, '')).replace(/\b(inc|sas|sa|sarl|group|groupe|france|ltd|gmbh)\b/g, '').trim();
  const y = norm((b || '').replace(/\(.*?\)/g, '')).replace(/\b(inc|sas|sa|sarl|group|groupe|france|ltd|gmbh)\b/g, '').trim();
  return Boolean(x && y) && (x === y || (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y)));
}
function similarTitle(a, b) {
  const A = titleWords(a), B = titleWords(b);
  if (!A.size || !B.size) return norm(a) === norm(b);
  const common = [...A].filter((w) => B.has(w)).length;
  return common / Math.min(A.size, B.size) >= 0.6; // 60 % des mots du plus court intitulé en commun
}

function importLinkedinCsv(items, csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('Fichier vide ou illisible');
  const head = rows[0].map((h) => norm(h));
  const col = (...names) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = col('application date', 'date'), iCompany = col('company'), iTitle = col('job title', 'title'),
    iUrl = col('job url', 'url'), iEmail = col('contact email', 'email');
  if (iCompany === -1 || iTitle === -1) throw new Error("Ce n'est pas le fichier « Job Applications.csv » de LinkedIn (colonnes Company Name / Job Title introuvables)");
  const now = new Date().toISOString();
  let added = 0, skipped = 0;
  for (const r of rows.slice(1)) {
    const entreprise = (r[iCompany] || '').trim(), poste = (r[iTitle] || '').trim();
    if (!entreprise && !poste) continue;
    const lienOffre = iUrl >= 0 ? (r[iUrl] || '').trim() : '';
    const date = iDate >= 0 ? parseLinkedinDate(r[iDate]) : '';
    // Doublon : même lien d'offre, ou même entreprise (même partiellement) + intitulé de poste proche.
    const dup = items.some((c) => (lienOffre && c.lienOffre === lienOffre) || (sameCompany(c.entreprise, entreprise) && similarTitle(c.poste, poste)));
    if (dup) { skipped++; continue; }
    const email = iEmail >= 0 && EMAIL_RE.test((r[iEmail] || '').trim()) ? r[iEmail].trim() : '';
    items.push({
      id: crypto.randomUUID(), createdAt: now, updatedAt: now, entreprise: entreprise || 'À compléter', poste,
      type: guessType(poste), canal: 'LinkedIn', email, lienOffre: /^https?:\/\//.test(lienOffre) ? lienOffre : '',
      dateCandidature: date, statut: 'postule', notes: 'Importée depuis l\'historique LinkedIn.',
    });
    added++;
  }
  return { added, skipped };
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2e6) { reject(new Error('Corps trop volumineux')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON invalide')); } });
  });
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(status === 204 ? undefined : JSON.stringify(data));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};
function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(content);
  });
}

const clientIp = (req) => req.socket.remoteAddress || '?';

async function handleAuth(req, res, url, method) {
  if (url === '/api/auth/options' && method === 'GET') return send(res, 200, { signup: ALLOW_SIGNUP || users.length === 0, firstAccount: users.length === 0 });

  if ((url === '/api/auth/login' || url === '/api/auth/signup') && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const ip = clientIp(req);
    if (tooManyAttempts(`ip:${ip}`, `email:${email}`)) return send(res, 429, { error: 'Trop de tentatives. Réessaie dans 15 minutes.' });

    if (url === '/api/auth/signup') {
      if (!ALLOW_SIGNUP && users.length > 0) return send(res, 403, { error: 'Les inscriptions sont fermées' });
      if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Adresse email invalide' });
      if (password.length < 8) return send(res, 400, { error: 'Le mot de passe doit faire au moins 8 caractères' });
      if (password.length > 200) return send(res, 400, { error: 'Mot de passe trop long' });
      if (findUser(email)) { recordFailure(`ip:${ip}`); return send(res, 409, { error: 'Un compte existe déjà avec cet email' }); }
      const user = { id: crypto.randomUUID(), email, ...hashPassword(password), createdAt: new Date().toISOString() };
      users.push(user);
      saveUsers();
      if (users.length === 1) migrateLegacy(user);
      else {
        store(user.id).settings.gmailUser = /@gmail\.com$/.test(email) ? email : '';
        saveSettings(user.id);
        saveItems(user.id);
      }
      return send(res, 201, { email }, { 'Set-Cookie': sessionCookie(createSession(user.id), SESSION_DAYS * 86400) });
    }

    const user = findUser(email);
    const ok = verifyPassword(password, user || DUMMY_USER);
    if (!user || !ok) { recordFailure(`ip:${ip}`, `email:${email}`); return send(res, 401, { error: 'Email ou mot de passe incorrect' }); }
    attempts.delete(`email:${email}`);
    return send(res, 200, { email }, { 'Set-Cookie': sessionCookie(createSession(user.id), SESSION_DAYS * 86400) });
  }

  if (url === '/api/auth/logout' && method === 'POST') {
    const s = getSession(req);
    if (s) { delete sessions[s.key]; saveSessions(); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  return null;
}

async function handleApi(req, res, url, method, user, session) {
  const s = store(user.id);
  const { items } = s;

  if (url === '/api/auth/me' && method === 'GET') return send(res, 200, { email: user.email });

  if (url === '/api/auth/password' && method === 'POST') {
    const body = await readBody(req);
    if (tooManyAttempts(`email:${user.email}`)) return send(res, 429, { error: 'Trop de tentatives. Réessaie dans 15 minutes.' });
    if (!verifyPassword(String(body.current || ''), user)) { recordFailure(`email:${user.email}`); return send(res, 400, { error: 'Mot de passe actuel incorrect' }); }
    const next = String(body.next || '');
    if (next.length < 8 || next.length > 200) return send(res, 400, { error: 'Le nouveau mot de passe doit faire au moins 8 caractères' });
    Object.assign(user, hashPassword(next));
    saveUsers();
    destroyUserSessions(user.id, session.key); // déconnecte les autres appareils
    return send(res, 200, { ok: true });
  }

  if (url === '/api/candidatures' && method === 'GET') return send(res, 200, items);

  if (url === '/api/candidatures' && method === 'POST') {
    const body = sanitize(await readBody(req));
    if (!body.entreprise) return send(res, 400, { error: "Le champ 'entreprise' est obligatoire" });
    const now = new Date().toISOString();
    const item = { id: crypto.randomUUID(), statut: 'postule', createdAt: now, updatedAt: now, ...body };
    items.push(item);
    saveItems(user.id);
    return send(res, 201, item);
  }

  if (url === '/api/import' && method === 'POST') {
    const body = await readBody(req);
    if (!Array.isArray(body)) return send(res, 400, { error: 'Un tableau JSON est attendu' });
    const now = new Date().toISOString();
    s.items = body.slice(0, 5000).map((c) => ({ id: crypto.randomUUID(), createdAt: c.createdAt || now, updatedAt: now, ...sanitize(c) }));
    saveItems(user.id);
    return send(res, 200, { count: s.items.length });
  }

  // ---- Plateformes ----
  if (url === '/api/platforms' && method === 'GET') {
    const list = readJson(notifFile(user.id), []);
    const gmail = Boolean(s.settings.gmailUser && s.settings.gmailAppPasswordEnc);
    const lastSync = readJson(syncFile(user.id), {}).lastSync || null;
    return send(res, 200, {
      gmail, lastSync,
      platforms: TRACKED_PLATFORMS.map((name) => {
        const mails = list.filter((n) => n.platform === name);
        return {
          name, mails: mails.length, lastMail: mails.reduce((m, n) => (n.date > m ? n.date : m), '') || null,
          candidatures: items.filter((c) => c.canal === name).length,
        };
      }),
    });
  }
  if (url === '/api/import/linkedin' && method === 'POST') {
    const body = await readBody(req);
    const result = importLinkedinCsv(items, String(body.csv || '').slice(0, 1.5e6));
    if (result.added) saveItems(user.id);
    return send(res, 200, { ...result, items });
  }

  // ---- Synchronisation Gmail ----
  if (url === '/api/sync' && method === 'POST') {
    const result = await syncGmail(user);
    return send(res, 200, { ...result, items: s.items });
  }
  if (url === '/api/sync' && method === 'GET') {
    return send(res, 200, { lastSync: readJson(syncFile(user.id), {}).lastSync || null, gmail: Boolean(s.settings.gmailUser && s.settings.gmailAppPasswordEnc) });
  }

  // ---- Centre de notifications ----
  if (url === '/api/notifications' && method === 'GET') {
    const list = readJson(notifFile(user.id), []);
    return send(res, 200, { notifications: list, unread: list.filter((n) => !n.read).length });
  }
  if (url === '/api/notifications/read' && method === 'POST') {
    const body = await readBody(req);
    const list = readJson(notifFile(user.id), []);
    const ids = Array.isArray(body.ids) ? new Set(body.ids) : null;
    for (const n of list) if (!ids || ids.has(n.id)) n.read = true;
    writeJson(notifFile(user.id), list);
    return send(res, 200, { unread: list.filter((n) => !n.read).length });
  }
  const na = url.match(/^\/api\/notifications\/([\w-]+)\/(apply|dismiss|create|link)$/);
  if (na && method === 'POST') {
    const list = readJson(notifFile(user.id), []);
    const n = list.find((x) => x.id === na[1]);
    if (!n) return send(res, 404, { error: 'Notification introuvable' });
    const body = await readBody(req);
    let item = null;
    if (na[2] === 'dismiss') {
      list.splice(list.indexOf(n), 1);
    } else if (na[2] === 'apply') {
      item = items.find((c) => c.id === n.candidatureId);
      const statut = String(body.statut || n.suggestion || '');
      if (!item) return send(res, 404, { error: 'Candidature introuvable' });
      if (!['repondu', 'entretien', 'retenu', 'refus_entretien', 'refus_direct', 'cloture'].includes(statut)) return send(res, 400, { error: 'Statut invalide' });
      const day = n.date.slice(0, 10);
      Object.assign(item, { statut, dateReponse: item.dateReponse || day, updatedAt: new Date().toISOString() });
      if (statut === 'entretien' && !item.dateEntretien) item.dateEntretien = day;
      Object.assign(n, { suggestion: null, applied: statut, read: true });
    } else if (na[2] === 'link') {
      item = items.find((c) => c.id === String(body.candidatureId || ''));
      if (!item) return send(res, 404, { error: 'Candidature introuvable' });
      // Les prochains mails de cet expéditeur seront reconnus (sauf adresses génériques des plateformes).
      if (!addrList(item).includes(n.from) && !platformOf(n.from)) item.email = [item.email, n.from].filter(Boolean).join(', ');
      Object.assign(n, { candidatureId: item.id, entreprise: item.entreprise, read: true });
      if (n.kind === 'refus') n.suggestion = item.statut === 'entretien' || item.dateEntretien ? 'refus_entretien' : 'refus_direct';
      if (n.kind === 'entretien' && ['postule', 'repondu'].includes(item.statut)) n.suggestion = 'entretien';
      if (n.kind === 'cloture' && item.statut === 'postule') n.suggestion = 'cloture';
    } else { // create
      const domain = (n.from.split('@')[1] || '').split('.').slice(-2, -1)[0] || '';
      // Nom d'expéditeur sans les mots génériques (« NewCorp Recrutement » → « NewCorp »), sinon le domaine.
      const generic = /\b(no-?reply|ne-?pas-?repondre|recrutement|recruitment|recruiting|candidatures?|rh|hr|system|talent|acquisition|team|équipe|l'équipe|de|d'|the|careers?|jobs?)\b/gi;
      const cleaned = n.fromName && n.fromName !== n.from ? n.fromName.replace(/\s*(via|sur|on)\s+\w+.*$/i, '').replace(/\(.*?\)/g, ' ').replace(generic, ' ').replace(/[-–|:]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
      const guess = cleaned.length >= 2 ? cleaned : domain.charAt(0).toUpperCase() + domain.slice(1);
      const now = new Date().toISOString();
      item = {
        id: crypto.randomUUID(), createdAt: now, updatedAt: now,
        entreprise: String(body.entreprise || guess || 'À compléter').slice(0, 200), poste: String(body.poste || n.subject || '').slice(0, 300),
        canal: n.platform || 'Email', type: 'Stage', email: n.platform ? '' : n.from,
        dateCandidature: n.date.slice(0, 10),
        statut: { refus: 'refus_direct', entretien: 'entretien', accuse: 'postule', cloture: 'cloture' }[n.kind] || 'repondu',
        dateReponse: n.kind === 'accuse' ? '' : n.date.slice(0, 10), thread: n.thread || '', notes: `Créée depuis la notification « ${n.subject} ».`,
      };
      items.push(item);
      Object.assign(n, { candidatureId: item.id, entreprise: item.entreprise, read: true, suggestion: null });
    }
    if (item) saveItems(user.id);
    writeJson(notifFile(user.id), list);
    return send(res, 200, { notifications: list, unread: list.filter((x) => !x.read).length, item });
  }

  if ((url === '/api/settings' || url === '/api/config') && method === 'GET') return send(res, 200, publicSettings(s.settings));

  if (url === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    const next = { ...s.settings };
    for (const [k, max] of Object.entries(SETTINGS_FIELDS)) if (body[k] !== undefined) next[k] = String(body[k]).trim().slice(0, max);
    if (next.gmailUser && !EMAIL_RE.test(next.gmailUser)) return send(res, 400, { error: 'Adresse Gmail invalide' });
    if (body.relanceJours !== undefined) {
      const j = parseInt(body.relanceJours, 10);
      if (!(j >= 1 && j <= 365)) return send(res, 400, { error: 'Délai de relance : entre 1 et 365 jours' });
      next.relanceJours = j;
    }
    // Mot de passe d'application : vide = on garde l'actuel ; clearPassword = on l'efface.
    if (body.clearPassword) next.gmailAppPasswordEnc = '';
    else if (body.gmailAppPassword) next.gmailAppPasswordEnc = encrypt(String(body.gmailAppPassword).replace(/\s/g, '').slice(0, 64));
    if (next.gmailUser !== s.settings.gmailUser) writeJson(syncFile(user.id), { lastSync: null, seen: [] }); // nouveau compte Gmail : on repart de zéro
    s.settings = next;
    saveSettings(user.id);
    return send(res, 200, publicSettings(s.settings));
  }

  if (url === '/api/settings/test' && method === 'POST') {
    const body = await readBody(req);
    const gmailUser = String(body.gmailUser || s.settings.gmailUser || '').trim();
    const pass = String(body.gmailAppPassword || decrypt(s.settings.gmailAppPasswordEnc) || '');
    if (!gmailUser || !pass) return send(res, 400, { error: "Renseigne l'adresse Gmail et le mot de passe d'application" });
    if (tooManyAttempts(`gmail:${user.id}`)) return send(res, 429, { error: 'Trop de tests. Réessaie dans 15 minutes.' });
    recordFailure(`gmail:${user.id}`); // compte chaque test, réussi ou non
    const client = imapClient(gmailUser, pass);
    try {
      await client.connect();
      const drafts = (await client.list()).find((b) => b.specialUse === '\\Drafts');
      return send(res, 200, { ok: true, drafts: drafts ? drafts.path : null });
    } finally { await client.logout().catch(() => {}); }
  }

  const r = url.match(/^\/api\/candidatures\/([\w-]+)\/relance$/);
  if (r && method === 'POST') {
    const idx = items.findIndex((c) => c.id === r[1]);
    if (idx === -1) return send(res, 404, { error: 'Candidature introuvable' });
    const settings = s.settings;
    if (!settings.gmailUser || !settings.gmailAppPasswordEnc) return send(res, 400, { error: "Gmail non configuré : ouvre ⚙️ Paramètres pour ajouter ton adresse et ton mot de passe d'application" });
    const body = await readBody(req);
    const to = String(body.to || '').split(/[,;]/).map((e) => e.trim()).filter(Boolean);
    if (!to.length || to.length > 10 || !to.every((e) => EMAIL_RE.test(e))) return send(res, 400, { error: 'Adresse(s) email invalide(s)' });
    const subject = String(body.subject || '').trim().slice(0, 300);
    const text = String(body.body || '').trim().slice(0, 20000);
    if (!subject || !text) return send(res, 400, { error: "L'objet et le message sont obligatoires" });
    const draft = await createGmailDraft(settings, { to: to.join(', '), subject, text, thread: items[idx].canal === 'Email' ? items[idx].thread : null });
    // Le brouillon ne compte comme relance qu'une fois envoyé (détecté par la synchronisation).
    const today = new Date().toISOString().slice(0, 10);
    const c = items[idx];
    const note = `Brouillon de relance créé le ${today.split('-').reverse().join('/')} pour ${to.join(', ')}${draft.inThread ? " (dans le fil d'origine)" : ''}.`;
    items[idx] = { ...c, brouillonRelance: today, notes: c.notes ? `${c.notes}\n${note}` : note, updatedAt: new Date().toISOString() };
    saveItems(user.id);
    return send(res, 200, { ...items[idx], draft });
  }

  const m = url.match(/^\/api\/candidatures\/([\w-]+)$/);
  if (m) {
    const idx = items.findIndex((c) => c.id === m[1]);
    if (idx === -1) return send(res, 404, { error: 'Candidature introuvable' });
    if (method === 'PUT') {
      items[idx] = { ...items[idx], ...sanitize(await readBody(req)), updatedAt: new Date().toISOString() };
      saveItems(user.id);
      return send(res, 200, items[idx]);
    }
    if (method === 'DELETE') {
      items.splice(idx, 1);
      saveItems(user.id);
      return send(res, 204);
    }
  }
  return send(res, 404, { error: 'Route inconnue' });
}

const PUBLIC_AUTH = ['/api/auth/options', '/api/auth/login', '/api/auth/signup', '/api/auth/logout'];

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = req.url.split('?')[0];
  try {
    // Protection DNS rebinding : seul un hôte connu est servi.
    const host = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.includes(host)) { res.writeHead(403); return res.end('Hote non autorise'); }

    if (!url.startsWith('/api/')) return serveStatic(req, res);

    // Protection CSRF : une requête venant d'un autre site est refusée,
    // et les écritures exigent du JSON (ce qui impose un contrôle CORS que nous ne validons jamais).
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).host.toLowerCase(); } catch { /* origine invalide */ }
      if (originHost !== (req.headers.host || '').toLowerCase()) return send(res, 403, { error: 'Origine non autorisée' });
    }
    if (!['GET', 'DELETE'].includes(method) && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      return send(res, 415, { error: 'Content-Type application/json requis' });
    }

    if (PUBLIC_AUTH.includes(url)) {
      const handled = await handleAuth(req, res, url, method);
      return handled !== null ? handled : send(res, 405, { error: 'Méthode non autorisée' });
    }

    const session = getSession(req);
    const user = session && users.find((u) => u.id === session.userId);
    if (!user) return send(res, 401, { error: 'Non connecté' });
    return await handleApi(req, res, url, method, user, session);
  } catch (e) {
    if (res.headersSent) return undefined;
    if (e.authenticationFailed) return send(res, 502, { error: "Connexion Gmail refusée : vérifie l'adresse et le mot de passe d'application dans ⚙️ Paramètres" });
    if (e.responseText || ['ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(e.code)) return send(res, 502, { error: `Gmail injoignable : ${e.message}` });
    return send(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`CRM Candidatures → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (${users.length} compte(s))`);
  if (!users.length) console.log('Aucun compte : le premier compte créé récupérera les données existantes.');
  if (HOST !== '127.0.0.1' && !COOKIE_SECURE) console.warn('⚠ Serveur exposé sans COOKIE_SECURE=true : place-le derrière HTTPS.');
});
