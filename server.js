// CRM Candidatures — serveur local.
// Lancer : node server.js  puis ouvrir http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Node 18 n'expose pas globalThis.crypto (Web Crypto) dans les scripts ; imapflow en a besoin.
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

// Charge le fichier .env (identifiants Gmail).
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = process.env.PORT || 3000;
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

// ---------- Paramètres (data/settings.json, avec repli sur .env) ----------
const DEFAULT_SETTINGS = {
  gmailUser: '', gmailAppPassword: '', senderName: '', titre: 'Mes candidatures', tagline: '',
  pitch: '', signature: '', relanceJours: 21,
};
function loadSettings() {
  let saved = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { saved = {}; }
  }
  return {
    ...DEFAULT_SETTINGS,
    gmailUser: process.env.GMAIL_USER || '',
    gmailAppPassword: process.env.GMAIL_APP_PASSWORD || '',
    senderName: process.env.SENDER_NAME || '',
    ...saved,
  };
}
function saveSettings(next) {
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE);
}
let settings = loadSettings();
const gmailEnabled = () => Boolean(settings.gmailUser && settings.gmailAppPassword);
// Version envoyée au navigateur : jamais le mot de passe.
const publicSettings = () => {
  const { gmailAppPassword, ...rest } = settings;
  return { ...rest, hasPassword: Boolean(gmailAppPassword), gmail: gmailEnabled() };
};
const SETTINGS_FIELDS = { gmailUser: 200, senderName: 120, titre: 80, tagline: 200, pitch: 3000, signature: 1000 };

function imapClient(user = settings.gmailUser, pass = settings.gmailAppPassword) {
  return new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true, logger: false,
    auth: { user, pass: String(pass).replace(/\s/g, '') },
  });
}

const MailComposer = require('nodemailer/lib/mail-composer');
const { ImapFlow } = require('imapflow');

// Crée un brouillon dans Gmail (IMAP APPEND dans le dossier Brouillons).
// Si l'ID du fil Gmail est connu, le brouillon est rattaché à la conversation d'origine.
async function createGmailDraft({ to, subject, text, thread }) {
  const client = imapClient();
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
      from: settings.senderName ? `"${settings.senderName.replace(/"/g, '')}" <${settings.gmailUser}>` : settings.gmailUser, to, text,
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
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data', 'candidatures.json');
const SEED_FILE = path.join(ROOT, 'data', 'seed.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    const now = new Date().toISOString();
    const items = seed.map((c) => ({ id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...c }));
    saveData(items);
    return items;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(items) {
  // Écriture atomique : on écrit dans un fichier temporaire puis on renomme.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const ALLOWED_FIELDS = [
  'entreprise', 'poste', 'type', 'canal', 'email', 'contact', 'lienOffre',
  'dateCandidature', 'dateReponse', 'dateEntretien', 'statut', 'notes', 'thread', 'adresse',
  'derniereRelance', 'nbRelances',
];

function sanitize(body) {
  const out = {};
  for (const k of ALLOWED_FIELDS) {
    if (body[k] !== undefined) out[k] = String(body[k]).slice(0, 5000);
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) { reject(new Error('Corps trop volumineux')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('JSON invalide')); }
    });
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(content);
  });
}

let items = loadData();

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/api/')) {
      // Protection : seul ce CRM (ouvert sur localhost) peut appeler l'API.
      // - Host vérifié contre le « DNS rebinding » ;
      // - JSON obligatoire pour les écritures, ce qui force un contrôle CORS que nous ne validons jamais.
      const host = (req.headers.host || '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(res, 403, { error: 'Hôte non autorisé' });
      if (method !== 'GET' && method !== 'DELETE' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        return send(res, 415, { error: 'Content-Type application/json requis' });
      }
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return send(res, 403, { error: 'Origine non autorisée' });
    }

    if (url === '/api/candidatures' && method === 'GET') return send(res, 200, items);

    if (url === '/api/candidatures' && method === 'POST') {
      const body = sanitize(await readBody(req));
      if (!body.entreprise) return send(res, 400, { error: "Le champ 'entreprise' est obligatoire" });
      const now = new Date().toISOString();
      const item = { id: crypto.randomUUID(), statut: 'postule', createdAt: now, updatedAt: now, ...body };
      items.push(item);
      saveData(items);
      return send(res, 201, item);
    }

    if (url === '/api/import' && method === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body)) return send(res, 400, { error: 'Un tableau JSON est attendu' });
      const now = new Date().toISOString();
      items = body.map((c) => ({ id: c.id || crypto.randomUUID(), createdAt: c.createdAt || now, updatedAt: now, ...sanitize(c) }));
      saveData(items);
      return send(res, 200, { count: items.length });
    }

    if ((url === '/api/config' || url === '/api/settings') && method === 'GET') return send(res, 200, publicSettings());

    if (url === '/api/settings' && method === 'PUT') {
      const body = await readBody(req);
      const next = { ...settings };
      for (const [k, max] of Object.entries(SETTINGS_FIELDS)) {
        if (body[k] !== undefined) next[k] = String(body[k]).trim().slice(0, max);
      }
      if (next.gmailUser && !EMAIL_RE.test(next.gmailUser)) return send(res, 400, { error: 'Adresse Gmail invalide' });
      if (body.relanceJours !== undefined) {
        const j = parseInt(body.relanceJours, 10);
        if (!(j >= 1 && j <= 365)) return send(res, 400, { error: 'Délai de relance : entre 1 et 365 jours' });
        next.relanceJours = j;
      }
      // Mot de passe : champ vide = on garde l'actuel ; clearPassword = on l'efface.
      if (body.clearPassword) next.gmailAppPassword = '';
      else if (body.gmailAppPassword) next.gmailAppPassword = String(body.gmailAppPassword).replace(/\s/g, '').slice(0, 64);
      settings = next;
      saveSettings(settings);
      return send(res, 200, publicSettings());
    }

    // Teste la connexion Gmail avec les valeurs du formulaire (ou celles enregistrées).
    if (url === '/api/settings/test' && method === 'POST') {
      const body = await readBody(req);
      const user = String(body.gmailUser || settings.gmailUser || '').trim();
      const pass = String(body.gmailAppPassword || settings.gmailAppPassword || '');
      if (!user || !pass) return send(res, 400, { error: 'Renseigne l\'adresse Gmail et le mot de passe d\'application' });
      const client = imapClient(user, pass);
      try {
        await client.connect();
        const boxes = await client.list();
        const drafts = boxes.find((b) => b.specialUse === '\\Drafts');
        return send(res, 200, { ok: true, drafts: drafts ? drafts.path : null });
      } finally {
        await client.logout().catch(() => {});
      }
    }

    // Relance : crée un brouillon dans Gmail, puis met à jour la candidature.
    const r = url.match(/^\/api\/candidatures\/([\w-]+)\/relance$/);
    if (r && method === 'POST') {
      const idx = items.findIndex((c) => c.id === r[1]);
      if (idx === -1) return send(res, 404, { error: 'Candidature introuvable' });
      if (!gmailEnabled()) return send(res, 400, { error: 'Gmail non configuré : ouvre ⚙️ Paramètres pour ajouter ton adresse et ton mot de passe d\'application' });
      const body = await readBody(req);
      const to = String(body.to || '').split(/[,;]/).map((e) => e.trim()).filter(Boolean);
      if (!to.length || !to.every((e) => EMAIL_RE.test(e))) return send(res, 400, { error: 'Adresse(s) email invalide(s)' });
      const subject = String(body.subject || '').trim().slice(0, 300);
      const text = String(body.body || '').trim().slice(0, 20000);
      if (!subject || !text) return send(res, 400, { error: "L'objet et le message sont obligatoires" });
      const draft = await createGmailDraft({ to: to.join(', '), subject, text, thread: items[idx].canal === 'Email' ? items[idx].thread : null });
      const today = new Date().toISOString().slice(0, 10);
      const c = items[idx];
      const nb = (parseInt(c.nbRelances, 10) || 0) + 1;
      const note = `Brouillon de relance n°${nb} créé le ${today.split('-').reverse().join('/')} pour ${to.join(', ')}${draft.inThread ? ' (dans le fil d\'origine)' : ''}.`;
      items[idx] = { ...c, derniereRelance: today, nbRelances: String(nb), notes: c.notes ? `${c.notes}\n${note}` : note, updatedAt: new Date().toISOString() };
      saveData(items);
      return send(res, 200, { ...items[idx], draft });
    }

    const m = url.match(/^\/api\/candidatures\/([\w-]+)$/);
    if (m) {
      const idx = items.findIndex((c) => c.id === m[1]);
      if (idx === -1) return send(res, 404, { error: 'Candidature introuvable' });
      if (method === 'PUT') {
        const body = sanitize(await readBody(req));
        items[idx] = { ...items[idx], ...body, updatedAt: new Date().toISOString() };
        saveData(items);
        return send(res, 200, items[idx]);
      }
      if (method === 'DELETE') {
        items.splice(idx, 1);
        saveData(items);
        return send(res, 204, {});
      }
    }

    if (url.startsWith('/api/')) return send(res, 404, { error: 'Route inconnue' });
    return serveStatic(req, res);
  } catch (e) {
    return send(res, e.authenticationFailed || e.responseText ? 502 : 400, { error: e.authenticationFailed ? 'Connexion Gmail refusée : vérifie l\'adresse et le mot de passe d\'application dans ⚙️ Paramètres' : e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CRM Candidatures → http://localhost:${PORT}  (${items.length} candidatures)`);
  console.log(gmailEnabled() ? `Relances → brouillons Gmail de ${settings.gmailUser}` : 'Gmail non configuré → renseigne-le dans ⚙️ Paramètres (sinon les relances s\'ouvrent pré-remplies dans Gmail)');
});
