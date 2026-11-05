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
  'derniereRelance', 'nbRelances',
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
    const today = new Date().toISOString().slice(0, 10);
    const c = items[idx];
    const nb = (parseInt(c.nbRelances, 10) || 0) + 1;
    const note = `Brouillon de relance n°${nb} créé le ${today.split('-').reverse().join('/')} pour ${to.join(', ')}${draft.inThread ? " (dans le fil d'origine)" : ''}.`;
    items[idx] = { ...c, derniereRelance: today, nbRelances: String(nb), notes: c.notes ? `${c.notes}\n${note}` : note, updatedAt: new Date().toISOString() };
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
