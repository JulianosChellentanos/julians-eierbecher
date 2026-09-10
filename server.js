// OVJU — Shop-Server: Statik + Pricing + Warenkorb-Checkout + Rechnungen + Admin + PayPal
// Start: node server.js   →   http://<host>:4488   (Admin: /admin, Standard-Passwort: ovju-admin)
import http from 'node:http';
import { createGzip, constants as zc } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync, statSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createMailer, baseUrlFor, mailSettings } from './lib/mailer.js';
import { orderConfirmation, orderStatus, statusMailAllowed, STATUS_MAIL, welcome, passwordReset, adminNewOrder, customMessage } from './lib/mail-templates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const ORDERS = path.join(__dirname, 'orders');
const DATA = path.join(__dirname, 'data');
const PORT = process.env.PORT || 4488;
const SERVER_STARTED = new Date().toISOString();
const MAX_JSON = 4 * 1024 * 1024;      // Checkout-JSON (ohne Modelle)
const MAX_STL = 90 * 1024 * 1024;      // pro Modell-Datei (binär)

// ---------------------------------------------------------------------------
// Hooks — werden im Abschnitt „E-Mail-Versand“ (unten) mit den Mail-Aktionen befüllt.
// Aufrufe sind immer in try/catch gekapselt: ein Hook darf keinen Request scheitern lassen.
// ---------------------------------------------------------------------------
export const hooks = {
  orderCompleted: async (order) => {},
  statusChanged: async (order, prevStatus, opts) => {},
  userRegistered: async (user) => {},
};
async function runHook(name, ...args) {
  try { await hooks[name]?.(...args); } catch (err) { console.error(`Hook ${name} fehlgeschlagen:`, err?.message || err); }
}

// ---------------------------------------------------------------------------
// Bestellstatus-Modell
// ---------------------------------------------------------------------------
const STATUSES = ['neu', 'bezahlt', 'im-druck', 'gedruckt', 'versendet', 'abgeschlossen', 'storniert'];
const STATUS_LABELS = {
  neu: 'Neu', bezahlt: 'Bezahlt', 'im-druck': 'Im Druck', gedruckt: 'Gedruckt',
  versendet: 'Versendet', abgeschlossen: 'Abgeschlossen', storniert: 'Storniert',
};
const CARRIERS = ['dhl', 'hermes', 'dpd', 'gls', 'post', 'sonstige', ''];
const CARRIER_LABELS = { dhl: 'DHL', hermes: 'Hermes', dpd: 'DPD', gls: 'GLS', post: 'Deutsche Post', sonstige: 'Sonstige', '': '' };
const PRINT_STATES = ['offen', 'druckt', 'fertig'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.stl': 'model/stl', '.3mf': 'model/3mf', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.hdr': 'application/octet-stream',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Einstellungen (data/settings.json) — Preise, Rabatte, Firma, PayPal, Admin
// ---------------------------------------------------------------------------
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const DEFAULT_SETTINGS = {
  adminKey: 'ovju-admin',
  invoicePrefix: 'RE-2026-',
  nextInvoice: 1,
  pricing: {
    currency: 'EUR',
    eierbecher: {
      single: 9.90, untersetzer: 4.90,
      discounts: [{ qty: 2, off: 20 }, { qty: 4, off: 35 }, { qty: 6, off: 40 }],
    },
    vase: {
      single: 24.90,
      discounts: [{ qty: 2, off: 10 }, { qty: 3, off: 15 }],
    },
    shipping: { flat: 4.90, freeFrom: 39 },
    gravur: 3.00,
    // Größenaufschlag: mehr Volumen = mehr Filament & Druckzeit.
    // relVol = (Höhe/Normalhöhe) · Breitenfaktor² ; Aufschlag nur oberhalb Normal.
    volumen: { prozent: 60, euro: 0 },
  },
  company: {
    name: 'OVJU — Julians Eierbecher', owner: 'Julian Sendlhofer',
    street: 'Musterstraße 1', zip: '00000', city: 'Musterstadt',
    email: 'jsendlhofer.js@gmail.com', phone: '',
    ustId: '', kleinunternehmer: true,
    iban: 'DE00 0000 0000 0000 0000 00', bic: '', bank: '',
  },
  paypal: { enabled: false, sandbox: true, clientId: '', secret: '' },
  colors: null,   // wird beim ersten Start aus content.json übernommen
  coupons: [],    // [{ code, type: 'percent'|'fixed', value, minOrder, active }]
  // Druck-Schätzwerte je Stück bei Normalhöhe (Admin: Warteschlange, Filamentbedarf);
  // Skalierung ≈ (Höhe/Normalhöhe)^1.5
  printing: { minutesEgg: 75, minutesVase: 210, gramsEgg: 22, gramsVase: 110 },
  // E-Mail-Versand (SMTP) — wird von der E-Mail-Integration (Phase 2) genutzt
  mail: {
    enabled: false, host: '', port: 465, secure: 'ssl', user: '', pass: '',
    from: '', fromName: 'OVJU', replyTo: '', adminTo: '', adminCopy: true,
    autoStatusMails: true, publicUrl: '',
  },
};

let settings;
function loadSettings() {
  mkdirSync(DATA, { recursive: true });
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    settings = structuredClone(DEFAULT_SETTINGS);
  }
  // Filament-Farben einmalig aus content.json übernehmen
  if (!Array.isArray(settings.colors)) {
    try {
      const content = JSON.parse(readFileSync(path.join(PUBLIC, 'content.json'), 'utf8'));
      settings.colors = content.colors.map((c) => ({ ...c, active: true, note: '' }));
    } catch { settings.colors = []; }
  }
  if (!Array.isArray(settings.coupons)) settings.coupons = [];
  // Ein leeres/ungültiges Admin-Passwort würde den Admin entweder für alle öffnen oder dauerhaft aussperren
  if (typeof settings.adminKey !== 'string' || !settings.adminKey.trim()) {
    console.warn('⚠️  settings.adminKey ungültig — Standard-Passwort wird verwendet');
    settings.adminKey = DEFAULT_SETTINGS.adminKey;
  }
  if (typeof settings.pricing.gravur !== 'number') settings.pricing.gravur = 3.00;
  if (!settings.pricing.volumen) settings.pricing.volumen = { prozent: 60, euro: 0 };
  settings.printing = { ...DEFAULT_SETTINGS.printing, ...(settings.printing || {}) };
  settings.mail = { ...DEFAULT_SETTINGS.mail, ...(settings.mail || {}) };
  // Migration: Finishes (matt/glanz/metall) + bekannte Silk-/Glossy-PLA-Farben
  if (!settings.colorsV2) {
    for (const c of settings.colors) if (!c.finish) c.finish = 'matt';
    const have = new Set(settings.colors.map((c) => c.id));
    const neu = [
      { id: 'gold', name: 'Gold', hex: '#d4af37', finish: 'metall', note: 'Silk/Metallic PLA' },
      { id: 'silber', name: 'Silber', hex: '#c7c9cc', finish: 'metall', note: 'Silk/Metallic PLA' },
      { id: 'kupfer', name: 'Kupfer', hex: '#b87333', finish: 'metall', note: 'Silk/Metallic PLA' },
      { id: 'feuerrot', name: 'Feuerrot', hex: '#c8102e', finish: 'glanz', note: 'Glossy PLA' },
      { id: 'tiefschwarz', name: 'Tiefschwarz', hex: '#1a1a1c', finish: 'glanz', note: 'Glossy PLA' },
      { id: 'perlmutt', name: 'Perlmutt', hex: '#ece6da', finish: 'metall', note: 'Silk PLA' },
    ];
    for (const c of neu) if (!have.has(c.id)) settings.colors.push({ ...c, active: true });
    settings.colorsV2 = true;
  }
  saveSettings();
}
async function saveSettings() {
  await mkdir(DATA, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Kundenkonten (data/users.json) & Sessions (data/sessions.json)
// ---------------------------------------------------------------------------
const USERS_FILE = path.join(DATA, 'users.json');
const SESS_FILE = path.join(DATA, 'sessions.json');
let users = [];
let sessions = {};
function loadUsers() {
  try { users = JSON.parse(readFileSync(USERS_FILE, 'utf8')).users || []; } catch { users = []; }
  try { sessions = JSON.parse(readFileSync(SESS_FILE, 'utf8')); } catch { sessions = {}; }
  // alte Sessions (> 90 Tage) aufräumen
  const cutoff = Date.now() - 90 * 864e5;
  for (const [t, s] of Object.entries(sessions)) if (s.createdAt < cutoff) delete sessions[t];
}
const saveUsers = () => writeFile(USERS_FILE, JSON.stringify({ users }, null, 2));

// ---------------------------------------------------------------------------
// Design-Codes (data/designs.json): kurzer Code ⇄ komplette Konfiguration.
// Der Code ist ein Hash der kanonischen Konfiguration → gleiches Design = gleicher Code.
// ---------------------------------------------------------------------------
const DESIGNS_FILE = path.join(DATA, 'designs.json');
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // ohne I/L/O/0/1 (verwechselbar)
const DESIGN_KEYS = ['product', 'preset', 'height', 'width', 'pattern', 'ribs', 'depth', 'twist', 'flow', 'flowWaves',
  'text', 'textSize', 'textPos', 'font', 'textStyle', 'textColor', 'saucer', 'customPoints', 'color'];
let designs = {};
function loadDesigns() {
  try { designs = JSON.parse(readFileSync(DESIGNS_FILE, 'utf8')); } catch { designs = {}; }
}
const saveDesigns = () => writeFile(DESIGNS_FILE, JSON.stringify(designs));
function canonicalDesign(cfg) {
  const out = {};
  for (const k of DESIGN_KEYS) {
    let v = cfg?.[k];
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (typeof v === 'number') v = Math.round(v * 1000) / 1000;
    if (k === 'customPoints') {
      if (!Array.isArray(v)) continue;
      v = v.slice(0, 40).map((pt) => [Math.round((pt[0] ?? pt.t ?? 0) * 1000) / 1000, Math.round((pt[1] ?? pt.r ?? 0) * 1000) / 1000]);
    } else if (typeof v === 'string') v = v.slice(0, 40);
    else if (typeof v !== 'number' && typeof v !== 'boolean') continue;
    out[k] = v;
  }
  return out;
}
function designCode(cfg) {
  const canon = canonicalDesign(cfg);
  const json = JSON.stringify(canon);
  const digest = crypto.createHash('sha256').update(json).digest();
  const chars = [...digest].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  // 6 Zeichen; bei Kollision mit einem ANDEREN Design verlängern
  for (let len = 6; len <= chars.length; len++) {
    const code = chars.slice(0, len);
    const ex = designs[code];
    if (!ex || JSON.stringify(ex.config) === json) return { code, canon, isNew: !ex };
  }
  return { code: chars, canon, isNew: !designs[chars] };
}
const normalizeCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^OVJU/, '');

// Vorschaubilder zu Design-Codes (data/thumbs/CODE.jpg, ≤ 80 KB, vom Client gerendert)
const THUMBS = path.join(DATA, 'thumbs');

// ---------------------------------------------------------------------------
// Design-Listen (data/lists.json): Sammlungen von Design-Codes, z. B. für eine
// Hochzeit. Besitzer bearbeiten per Token, alle anderen lesen per Code/Link.
// ---------------------------------------------------------------------------
const LISTS_FILE = path.join(DATA, 'lists.json');
let lists = {};
function loadLists() { try { lists = JSON.parse(readFileSync(LISTS_FILE, 'utf8')); } catch { lists = {}; } }
const saveLists = () => writeFile(LISTS_FILE, JSON.stringify(lists));
function newListCode() {
  for (;;) {
    let c = 'L';
    for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!lists[c]) return c;
  }
}
const LIST_OCCASIONS = ['hochzeit', 'geburtstag', 'taufe', 'weihnachten', 'firma', 'sonstiges'];
function cleanListItems(items) {
  const out = [];
  for (const it of Array.isArray(items) ? items.slice(0, 60) : []) {
    const code = normalizeCode(it?.code);
    if (!designs[code]) continue;
    const qty = Math.max(1, Math.min(50, Math.round(+it.qty || 1)));
    const ex = out.find((o) => o.code === code);
    if (ex) ex.qty = Math.min(50, ex.qty + qty); else out.push({ code, qty });
  }
  return out;
}
function publicList(l) {
  return {
    code: l.code, name: l.name, occasion: l.occasion, note: l.note || '',
    createdAt: l.createdAt, updatedAt: l.updatedAt,
    items: l.items.map((it) => ({ ...it, config: designs[it.code]?.config || null })).filter((it) => it.config),
  };
}

const saveSessions = () => writeFile(SESS_FILE, JSON.stringify(sessions));
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { userId, createdAt: Date.now() };
  saveSessions();
  return token;
}
function userFromReq(req) {
  const s = sessions[req.headers['x-auth'] || ''];
  return s ? users.find((u) => u.id === s.userId) : null;
}
const publicUser = (u) => ({ name: u.name, email: u.email, address: u.address || null });

// --- Passwort vergessen: Token nur als SHA-256-Hash im Konto (user.reset = { hash, exp }), 60 Minuten gültig
const RESET_TTL = 60 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function userByResetToken(token) {
  const t = String(token || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
  const h = Buffer.from(sha256(t), 'hex');
  const now = Date.now();
  let found = null;
  for (const u of users) {   // alle Konten durchgehen (kein Abbruch → keine Zeitmessung möglich)
    const r = u.reset;
    if (!r || !/^[0-9a-f]{64}$/.test(String(r.hash || ''))) continue;
    if (crypto.timingSafeEqual(h, Buffer.from(r.hash, 'hex')) && Number(r.exp) > now) found = u;
  }
  return found;
}
// Rate-Limit für „Passwort vergessen“ (im Speicher): max. 3 Anfragen je E-Mail in 15 Minuten,
// je IP großzügiger (10), damit ein Proxy ohne X-Forwarded-For nicht alle Kunden gemeinsam sperrt.
// Der Speicher ist hart gedeckelt (FORGOT_MAX_KEYS) und wird höchstens einmal pro Minute durchgekehrt.
const FORGOT_IP_MAX = 10;
const FORGOT_MAX_KEYS = 5000;
const forgotHits = new Map();
let forgotSweep = 0;
function forgotLimited(key, max = 3, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const hits = (forgotHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { forgotHits.set(key, hits); return true; }
  hits.push(now);
  forgotHits.set(key, hits);
  if (forgotHits.size > FORGOT_MAX_KEYS && now - forgotSweep > 60_000) {
    forgotSweep = now;
    for (const [k, v] of forgotHits) if (!v.some((t) => now - t < windowMs)) forgotHits.delete(k);
  }
  // Map ist einfügegeordnet → bei Überlauf fliegen die ältesten Schlüssel raus
  while (forgotHits.size > FORGOT_MAX_KEYS) forgotHits.delete(forgotHits.keys().next().value);
  return false;
}
// X-Forwarded-For ist clientgesteuert — nur hinter eigenem Reverse-Proxy auswerten (TRUST_PROXY=1 = ein Proxy,
// der seinen Wert hinten anhängt); ohne Proxy zählt die Socket-Adresse
const TRUST_PROXY = Math.max(0, parseInt(process.env.TRUST_PROXY || '0', 10) || 0);
function clientIp(req) {
  const ip = req.socket?.remoteAddress || '';
  if (!TRUST_PROXY) return ip;
  const list = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list[list.length - TRUST_PROXY] || ip;
}

// ---------------------------------------------------------------------------
// E-Mail-Versand (lib/mailer.js + lib/mail-templates.js) — Protokoll in data/mail-outbox.json
//   Hooks (unten): Bestellbestätigung + Admin-Kopie, Status-Mails, Willkommensmail.
//   Jede aus einer Bestellung heraus in den Versand gegebene Mail wird in order.mailsSent[key] = Zeitpunkt
//   vermerkt (key = 'bestaetigung' | Status) und in der Historie notiert (by 'mail') —
//   so gibt es je Status nur eine automatische Mail, auch wenn er erneut gesetzt wird.
//   Ist der Versand nicht eingerichtet, bleibt mailsSent frei (Historie sagt „nicht gesendet“),
//   damit die Automatik nach der Einrichtung greift; der Eintrag liegt im Versandprotokoll.
// ---------------------------------------------------------------------------
const mailer = createMailer({ dataDir: DATA, getSettings: () => settings, log: (m) => console.log('✉️ ', m) });
const MAIL_KEYS = ['enabled', 'host', 'port', 'secure', 'user', 'pass', 'from', 'fromName', 'replyTo', 'adminTo', 'adminCopy', 'autoStatusMails', 'publicUrl', 'allowSelfSigned'];
const EMAIL_RE = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;
const isEmail = (s) => EMAIL_RE.test(String(s || '').trim());
const customerAddress = (order) => ({ name: String(order.customer?.name || '').trim(), email: String(order.customer?.email || '').trim().toLowerCase() });
const httpError = (code, message) => Object.assign(new Error(message), { httpCode: code });
/** Einstellungen fürs Admin-UI/Export: Geheimnisse maskiert (leer + …Set) — SMTP-Passwort, PayPal-Secret und Admin-Passwort verlassen den Server nie. */
const adminSettingsView = () => {
  const { adminKey, ...rest } = settings;
  return {
    ...rest,
    mail: { ...settings.mail, pass: '', passSet: !!settings.mail?.pass },
    paypal: { ...settings.paypal, secret: '', secretSet: !!settings.paypal?.secret },
  };
};

/** Mail-Vermerk: Bestellung frisch lesen (unter Sperre), damit kein veraltetes Objekt zwischenzeitliche Änderungen überschreibt. */
async function noteMailSent(order, key, subject, to) {
  const release = await lockOrder(order.orderId);
  try {
    const o = await readOrder(order.orderId);
    o.mailsSent[key] = new Date().toISOString();
    addHistory(o, o.status, `E-Mail „${subject}“ → ${to}`, 'mail');
    await writeOrder(o);
  } finally { release(); }
}
/** Ehrlicher Vermerk ohne mailsSent, wenn die Mail nicht in den Versand ging (deaktiviert/fehler). */
async function noteMailSkipped(order, note) {
  const release = await lockOrder(order.orderId);
  try {
    const o = await readOrder(order.orderId);
    addHistory(o, o.status, note, 'mail');
    await writeOrder(o);
  } finally { release(); }
}
/** Ergebnis von mailer.queue() vermerken: eingereiht/gesendet → mailsSent[key], sonst Hinweis. */
async function noteQueued(order, key, subject, to, q) {
  if (q.status === 'wartet' || q.status === 'gesendet') return noteMailSent(order, key, subject, to);
  return noteMailSkipped(order, `E-Mail „${subject}“ an ${to} nicht gesendet: ${q.error || q.status} — liegt im Versandprotokoll`);
}
/** Mail zu einer Bestellung rendern (Admin: Vorschau & Versand). kind: bestaetigung | status | freitext */
function renderOrderMail(order, { kind, status, subject, text } = {}) {
  const baseUrl = baseUrlFor(settings);
  switch (kind) {
    case 'bestaetigung':
      return { key: 'bestaetigung', kind, ...orderConfirmation({ order, settings, baseUrl }) };
    case 'status': {
      const st = String(status || order.status || '');
      if (!STATUSES.includes(st)) throw httpError(400, 'Ungültiger Status');
      if (!statusMailAllowed(st)) throw httpError(400, `Für den Status „${STATUS_LABELS[st] || st}“ gibt es keine Mail-Vorlage`);
      return { key: st, kind: `status:${st}`, ...orderStatus({ order, status: st, settings, baseUrl }) };
    }
    case 'freitext': {
      const subj = String(subject || '').trim().slice(0, 200);
      const body = String(text || '').trim().slice(0, 20000);
      if (!subj || !body) throw httpError(400, 'Bitte Betreff und Text ausfüllen');
      return { key: null, kind, ...customMessage({ order, subject: subj, text: body, settings, baseUrl }) };
    }
    default:
      throw httpError(400, 'Unbekannte Mail-Art (bestaetigung | status | freitext)');
  }
}

// Bestellung abgeschlossen → Bestätigung an den Kunden, Kopie an den Shop (adminTo, sonst Firmen-Adresse)
hooks.orderCompleted = async (order) => {
  if (order.mailsSent?.bestaetigung) return;   // /complete wurde doppelt aufgerufen
  const baseUrl = baseUrlFor(settings);
  const mc = mailSettings(settings.mail);
  const cust = customerAddress(order);
  let customerMail = null;   // { subject, q } — nur wenn eine Kundenadresse vorliegt
  if (isEmail(cust.email)) {
    const m = orderConfirmation({ order, settings, baseUrl });
    const q = await mailer.queue({ to: cust, subject: m.subject, text: m.text, html: m.html, kind: 'bestaetigung', ref: order.orderId });
    customerMail = { subject: m.subject, q };
  }
  const adminTo = mc.adminTo || String(settings.company?.email || '').trim();
  if (mc.adminCopy && isEmail(adminTo)) {
    const m = adminNewOrder({ order, settings, baseUrl });
    await mailer.queue({ to: adminTo, subject: m.subject, text: m.text, html: m.html, kind: 'admin-neu', ref: order.orderId });
  }
  if (customerMail) await noteQueued(order, 'bestaetigung', customerMail.subject, cust.email, customerMail.q);
};
// Statuswechsel → Status-Mail (nur mit notify, aktivierter Automatik und passender Vorlage; je Status einmal)
hooks.statusChanged = async (order, prevStatus, { notify = true } = {}) => {
  const status = order.status;
  if (!notify || !mailSettings(settings.mail).autoStatusMails || !statusMailAllowed(status)) return;
  if (order.mailsSent?.[status]) return;
  const cust = customerAddress(order);
  if (!isEmail(cust.email)) return;
  const m = orderStatus({ order, status, settings, baseUrl: baseUrlFor(settings) });
  const q = await mailer.queue({ to: cust, subject: m.subject, text: m.text, html: m.html, kind: `status:${status}`, ref: order.orderId });
  await noteQueued(order, status, m.subject, cust.email, q);
};
// Neues Kundenkonto → Willkommensmail
hooks.userRegistered = async (user) => {
  if (!isEmail(user?.email)) return;
  const m = welcome({ user, settings, baseUrl: baseUrlFor(settings) });
  await mailer.queue({ to: { name: user.name, email: user.email }, subject: m.subject, text: m.text, html: m.html, kind: 'willkommen', ref: user.id });
};

// ---------------------------------------------------------------------------
// Preisberechnung (Server = einzige Wahrheit)
// ---------------------------------------------------------------------------
// Normalgrößen (Standard-Höhe des Produkts, Breite 100 %)
const NORMAL_HEIGHT = { eierbecher: 58, vase: 150 };

/** Größenaufschlag in € — Mehrvolumen relativ zur Normalgröße, nur nach oben. */
function volumeSurcharge(product, config, basePrice) {
  const vol = settings.pricing.volumen || {};
  const h = Number(config?.height) || NORMAL_HEIGHT[product] || 1;
  const w = Number(config?.width) || 1;
  const rel = (h / (NORMAL_HEIGHT[product] || h)) * w * w;
  const extra = Math.max(0, rel - 1); // Mehrvolumen-Anteil (1 = +100 %)
  if (extra <= 0) return 0;
  return Math.round(extra * ((vol.prozent || 0) / 100 * basePrice + (vol.euro || 0)) * 100) / 100;
}

function discountFor(product, qty) {
  const tiers = settings.pricing[product]?.discounts || [];
  let off = 0;
  for (const t of tiers) if (qty >= t.qty && t.off > off) off = t.off;
  return off;
}
// Gravur-Regel (Spiegel der Geometrie): bei Lamellen/Fjordwelle über 2,5 mm Tiefe gibt es keine Gravur
function gravurAllowed(c) {
  const depth = +c?.depth || 0;
  if ((c?.pattern === 'lamellen' || c?.pattern === 'koralle') && depth > 2.5) return false;
  return true;
}
function priceItem(item) {
  const p = settings.pricing[item.product];
  if (!p) throw new Error('Unbekanntes Produkt');
  const qty = Math.max(1, Math.min(50, parseInt(item.qty, 10) || 1));
  let unit = p.single;
  if (item.product === 'eierbecher' && item.saucer) unit += p.untersetzer;
  if (String(item.config?.text || '').trim() && gravurAllowed(item.config)) unit += settings.pricing.gravur || 0;
  unit += volumeSurcharge(item.product, item.config, p.single);
  unit = Math.round(unit * 100) / 100;
  const off = discountFor(item.product, qty);
  const lineFull = unit * qty;
  const line = Math.round(lineFull * (1 - off / 100) * 100) / 100;
  return { qty, unit, off, lineFull: Math.round(lineFull * 100) / 100, line };
}
function computeTotals(items, couponCode) {
  const lines = items.map((it) => ({ ...it, ...priceItem(it) }));
  const subtotal = Math.round(lines.reduce((s, l) => s + l.line, 0) * 100) / 100;
  // Gutschein
  let coupon = null;
  let afterCoupon = subtotal;
  if (couponCode) {
    const c = settings.coupons.find((x) => x.active && x.code.trim().toLowerCase() === String(couponCode).trim().toLowerCase());
    if (c && subtotal >= (c.minOrder || 0)) {
      const off = c.type === 'fixed' ? Math.min(c.value, subtotal) : subtotal * c.value / 100;
      coupon = { code: c.code, type: c.type, value: c.value, off: Math.round(off * 100) / 100 };
      afterCoupon = Math.round((subtotal - coupon.off) * 100) / 100;
    }
  }
  const ship = settings.pricing.shipping;
  const shipping = items.length === 0 ? 0 : (afterCoupon >= ship.freeFrom ? 0 : ship.flat);
  const total = Math.round((afterCoupon + shipping) * 100) / 100;
  return { lines, subtotal, coupon, shipping, total };
}
function money(v) {
  return v.toLocaleString('de-DE', { style: 'currency', currency: settings.pricing.currency });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  if (res.headersSent) { if (!res.writableEnded) res.end(); return; }   // Antwort ging schon raus (z. B. Fehler nach Hook)
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req, limit = MAX_JSON) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Anfrage zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function newOrderId() {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `OV-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
/** Vergleich mit dem Admin-Passwort in konstanter Zeit; ein leeres/ungültiges Passwort passt nie. */
function adminKeyMatches(k) {
  const a = Buffer.from(typeof settings.adminKey === 'string' ? settings.adminKey : '');
  const s = Buffer.from(String(k ?? ''));
  return a.length > 0 && s.length === a.length && crypto.timingSafeEqual(s, a);
}
function isAdmin(req) {
  return adminKeyMatches(req.headers['x-admin-key']);
}
async function readOrder(id) {
  return normalizeOrder(JSON.parse(await readFile(path.join(ORDERS, id, 'order.json'), 'utf8')));
}
// Lesen-Ändern-Schreiben je Bestellung serialisieren, damit parallele Requests (Admin-Klicks, Mail-Hooks
// nach der Antwort) einander nicht überschreiben:  const release = await lockOrder(id); try { … } finally { release(); }
const orderLocks = new Map();
function lockOrder(id) {
  const prev = orderLocks.get(id) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  orderLocks.set(id, chain);
  return prev.then(() => () => {
    release();
    if (orderLocks.get(id) === chain) orderLocks.delete(id);
  });
}
/**
 * Migration beim Lesen (ohne Schreiben): Bestellhistorie, Druckstatus je Position,
 * Versandfelder. Sehr alte Bestellungen (Einzelmodell ohne `lines`) bekommen eine
 * synthetische Position, damit Admin und Druckzettel sie einheitlich anzeigen können.
 */
function normalizeOrder(order) {
  if (!order || typeof order !== 'object') return order;
  if (!order.status) order.status = 'neu';
  if (!order.payment) order.payment = 'vorkasse';
  if (!order.paymentStatus) order.paymentStatus = 'offen';
  if (!order.customer && (order.name || order.email)) {
    order.customer = { name: order.name || '', email: order.email || '', street: '', zip: '', city: '', note: order.notes || '' };
  }
  if (!Array.isArray(order.lines)) {
    order.lines = order.config ? [{
      product: order.config.product || 'eierbecher', qty: order.qty || 1, saucer: !!order.config.saucer,
      config: order.config, colorName: order.colorName || order.config.colorName || '',
      stlFile: order.stlFile || '', legacy: true,
    }] : [];
  }
  for (const l of order.lines) {
    if (!l.print || !PRINT_STATES.includes(l.print.status)) l.print = { status: 'offen' };
  }
  if (order.carrier === undefined) order.carrier = '';
  if (order.paidAt === undefined) order.paidAt = null;
  if (order.shippedAt === undefined) order.shippedAt = null;
  if (order.trackingNo === undefined) order.trackingNo = '';
  if (order.adminNote === undefined) order.adminNote = '';
  if (order.completedAt === undefined) order.completedAt = null;   // Zeitpunkt des (ersten) /complete
  if (!order.mailsSent || typeof order.mailsSent !== 'object') order.mailsSent = {};   // { bestaetigung|Status: ISO }
  if (!Array.isArray(order.history)) {
    order.history = [{ at: order.createdAt, status: 'neu', note: 'Bestellung eingegangen', by: 'system' }];
    if (order.payment === 'paypal' && order.paymentStatus === 'bezahlt') {
      order.history.push({ at: order.createdAt, status: 'neu', note: 'Zahlung per PayPal', by: 'kunde' });
    }
    if (order.status !== 'neu') {
      order.history.push({ at: order.createdAt, status: order.status, note: 'Status nachgetragen (vor Einführung der Historie)', by: 'admin' });
    }
  }
  return order;
}
function addHistory(order, status, note, by = 'admin') {
  if (!Array.isArray(order.history)) order.history = [];
  const entry = { at: new Date().toISOString(), status, by };
  if (note) entry.note = String(note).slice(0, 300);
  order.history.push(entry);
  return entry;
}
/** Setzt den Bestellstatus inkl. Historie und Zeitstempeln; liefert true, wenn sich etwas geändert hat. */
function setOrderStatus(order, status, note, by = 'admin') {
  if (!STATUSES.includes(status) || order.status === status) return false;
  order.status = status;
  if (status === 'bezahlt' && order.paymentStatus !== 'bezahlt') {
    order.paymentStatus = 'bezahlt';
    order.paidAt = order.paidAt || new Date().toISOString();
  }
  if (status === 'versendet') order.shippedAt = new Date().toISOString();
  addHistory(order, status, note || `Status → ${STATUS_LABELS[status]}`, by);
  return true;
}
const orderIsPaid = (o) => o.status === 'bezahlt' || (o.status === 'neu' && o.paymentStatus === 'bezahlt');
async function writeOrder(order) {
  await writeFile(path.join(ORDERS, order.orderId, 'order.json'), JSON.stringify(order, null, 2));
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function itemLabel(it) {
  const c = it.config || {};
  const patt = { glatt: 'Glatt', rippen: 'Rippen', wellen: 'Wellen', zickzack: 'Zickzack', querwellen: 'Querwellen', lamellen: 'Lamellen', gehaemmert: 'Gehämmert', skelett: 'Voronoi', koralle: 'Fjordwelle' }[c.pattern] || c.pattern;
  return `${it.product === 'vase' ? 'Vase' : 'Eierbecher'} „${c.preset === 'eigene' ? 'Eigene Form' : (c.preset || '')}“ · ${patt}` +
    ` · ${c.height} mm · ${it.colorName || ''}` +
    (c.text ? ` · Gravur „${c.text}“${{ gehaemmert: ' (gehämmert)', gestanzt: ' (gestanzt)', kissen: ' (Kissen)', farbe: ` (Farbschrift${it.textColorName ? ' ' + it.textColorName : ''} — 3MF, 2 Filamente)` }[c.textStyle] || ''}` : '') +
    (it.saucer ? ' · mit Untersetzer' : '') +
    (it.code ? ` · Design-Code ${it.code}` : '');
}

// Anzeigenamen für Druckzettel & Admin (Spiegel der Client-Labels)
const PATTERN_LABELS = { glatt: 'Glatt', rippen: 'Rippen', wellen: 'Wellen', zickzack: 'Zickzack', querwellen: 'Querwellen', lamellen: 'Lamellen', gehaemmert: 'Gehämmert', skelett: 'Voronoi', koralle: 'Fjordwelle' };
const PRESET_LABELS = { flasche: 'Flasche', kugel: 'Kugel', tropfen: 'Tropfen', zylinder: 'Zylinder', kurve: 'Kurve', kelch: 'Kelch', schale: 'Schale', tulpe: 'Tulpe', eigene: 'Eigene Form' };
const FONT_LABELS = { helvetiker: 'Modern', optimer: 'Soft', gentilis: 'Fein', droid_sans: 'Kräftig', droid_serif: 'Klassisch', marcellus: 'Edel', greatvibes: 'Kalligrafie' };
const TEXT_STYLE_LABELS = { gestanzt: 'Gestanzt', gepraegt: 'Geprägt', gehaemmert: 'Gehämmert', kissen: 'Kissen', farbe: 'Farbschrift' };
const FLOW_LABELS = { spirale: 'Spirale', gegen: 'Gegenläufig', fluss: 'Wellenfluss', zick: 'Zickzack' };
function colorByRef(id, name) {
  const cols = settings.colors || [];
  return (id && cols.find((c) => c.id === id)) || (name && cols.find((c) => c.name === name)) || null;
}
// Farbwerte aus der Bestellung (config.colorHex kommt vom Kunden) nur als echte Hex-Farbe in style-Attribute lassen
const safeHex = (h) => (/^#[0-9a-f]{3,8}$/i.test(String(h || '')) ? h : '#cccccc');

// ---------------------------------------------------------------------------
// Druckzettel (A4, schwarz/weiß-tauglich) — GET /admin/druckzettel/<ID>?k=<adminKey>
// ---------------------------------------------------------------------------
function druckzettelHTML(order) {
  const cu = order.customer || {};
  const dt = (iso) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const rows = order.lines.map((l, i) => {
    const c = l.config || {};
    const body = colorByRef(c.color, l.colorName);
    const bodyHex = safeHex(body?.hex || c.colorHex || '#ffffff');
    const bodyName = l.colorName || body?.name || '—';
    const finish = { matt: 'matt', glanz: 'glänzend', metall: 'metallic' }[body?.finish || c.colorFinish] || '';
    const hasText = !!String(c.text || '').trim();
    const txtCol = c.textStyle === 'farbe' ? colorByRef(c.textColor, l.textColorName) : null;
    const flow = (c.twist && c.pattern !== 'glatt' && c.pattern !== 'querwellen') ? ` · Verlauf ${FLOW_LABELS[c.flow] || 'Spirale'} ${c.twist}` : '';
    const gravur = hasText
      ? `<b>„${esc(c.text)}“</b><br>${esc(TEXT_STYLE_LABELS[c.textStyle] || c.textStyle || 'Gestanzt')} · Schrift ${esc(FONT_LABELS[c.font] || c.font || 'Modern')} · ${esc(c.textSize ?? '')} mm`
        + (c.textStyle === 'farbe' ? `<br><span class="sw" style="background:${esc(safeHex(txtCol?.hex || '#000'))}"></span> Schriftfarbe ${esc(txtCol?.name || l.textColorName || c.textColor || '?')} (2. Filament)` : '')
      : '<span class="muted">keine</span>';
    const file = l.stlFile ? `${esc(l.stlFile)}${/\.3mf$/i.test(l.stlFile) ? ' <small>(3MF, 2 Filamente)</small>' : ''}` : '—';
    const pr = l.print || { status: 'offen' };
    return `<tr>
      <td class="c"><span class="box ${pr.status === 'fertig' ? 'x' : ''}"></span></td>
      <td class="c big">${l.qty}×</td>
      <td><b>${l.product === 'vase' ? 'Vase' : 'Eierbecher'} „${esc(PRESET_LABELS[c.preset] || c.preset || '')}“</b>${l.saucer ? '<br>+ Untersetzer' : ''}
        <br><small>Pos. ${i + 1}${l.code ? ` · Code ${esc(l.code)}` : ''}</small></td>
      <td>${esc(PATTERN_LABELS[c.pattern] || c.pattern || '')}${c.pattern && c.pattern !== 'glatt' ? ` · ${esc(c.depth ?? '')} mm` : ''}${esc(flow)}<br>Höhe ${esc(c.height)} mm${c.width && c.width !== 1 ? ` · Breite ${Math.round(c.width * 100)} %` : ''}</td>
      <td><span class="sw" style="background:${esc(bodyHex)}"></span> ${esc(bodyName)}${finish ? `<br><small>${finish}</small>` : ''}</td>
      <td>${gravur}</td>
      <td class="file">${file}</td>
      <td class="note"></td>
    </tr>`;
  }).join('');
  const pay = order.payment === 'paypal' ? `PayPal${order.paypalOrderId ? ` (${esc(order.paypalOrderId)})` : ''}` : 'Vorkasse';
  const payState = order.paymentStatus === 'bezahlt' ? `bezahlt${order.paidAt ? ' am ' + dt(order.paidAt) : ''}` : 'OFFEN';
  const pieces = order.lines.reduce((s, l) => s + (l.qty || 0), 0);
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Druckzettel ${esc(order.orderId)}</title>
  <style>
    @page{size:A4;margin:12mm}
    body{font-family:system-ui,sans-serif;color:#111;max-width:190mm;margin:14px auto;padding:0 10px;font-size:12.5px;line-height:1.4}
    .head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:12px;gap:16px}
    h1{font-size:30px;margin:0;letter-spacing:.02em} .muted{color:#555}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin:10px 0 14px}
    .meta b{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#555;margin-bottom:2px}
    table{width:100%;border-collapse:collapse;margin:8px 0}
    th,td{border:1px solid #333;padding:6px 7px;text-align:left;vertical-align:top}
    th{font-size:10px;text-transform:uppercase;letter-spacing:.05em;background:#eee}
    td.c{text-align:center} td.big{font-size:18px;font-weight:700;white-space:nowrap}
    td.file{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;max-width:120px}
    td.note{min-width:70px}
    .box{display:inline-block;width:16px;height:16px;border:2px solid #111;border-radius:3px;vertical-align:middle;position:relative}
    .box.x::after{content:'✓';position:absolute;left:1px;top:-4px;font-size:15px;font-weight:700}
    .sw{display:inline-block;width:14px;height:14px;border:1px solid #333;border-radius:3px;vertical-align:-2px;margin-right:3px}
    .notes{border:1px solid #333;border-radius:6px;min-height:70px;padding:6px 8px;margin-top:10px}
    .notes b{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#555}
    .foot{display:flex;justify-content:space-between;gap:16px;border-top:1px solid #333;margin-top:12px;padding-top:6px;font-size:11.5px}
    .noprint{margin:16px 0}.noprint button{padding:9px 20px;border-radius:999px;border:none;background:#111;color:#fff;font-weight:600;cursor:pointer;font-size:14px}
    @media print{.noprint{display:none}body{margin:0}}
  </style></head><body>
  <div class="noprint"><button onclick="print()">🖨️ Druckzettel drucken</button> <a href="/admin" style="margin-left:12px">← zurück zum Admin</a></div>
  <div class="head">
    <div><div class="muted">OVJU · Druckzettel</div><h1>${esc(order.orderId)}</h1></div>
    <div style="text-align:right">Bestellt am<br><b>${dt(order.createdAt)}</b>${order.invoiceNo ? `<br><small>Rechnung ${esc(order.invoiceNo)}</small>` : ''}</div>
  </div>
  <div class="meta">
    <div><b>Kunde &amp; Lieferadresse</b>${esc(cu.name)}<br>${esc(cu.street)}<br>${esc(cu.zip)} ${esc(cu.city)}<br><span class="muted">${esc(cu.email)}</span></div>
    <div><b>Auftrag</b>${order.lines.length} Position(en) · ${pieces} Stück${cu.note ? `<br><b style="margin-top:6px">Kundenhinweis</b>${esc(cu.note)}` : ''}${order.adminNote ? `<br><b style="margin-top:6px">Interne Notiz</b>${esc(order.adminNote)}` : ''}</div>
  </div>
  <table><tr><th>gedruckt</th><th>Menge</th><th>Produkt / Form</th><th>Muster · Höhe</th><th>Farbe</th><th>Gravur</th><th>Datei</th><th>Notiz</th></tr>${rows}</table>
  <div class="notes"><b>Notizen</b></div>
  <div class="foot">
    <span>Status: <b>${esc(STATUS_LABELS[order.status] || order.status)}</b></span>
    <span>Zahlung: ${pay} · <b>${payState}</b></span>
    <span>Gesamt: <b>${order.total != null ? money(order.total) : '—'}</b></span>
  </div>
  </body></html>`;
}

// ---------------------------------------------------------------------------
// Rechnung (HTML, druckbar → PDF über Browser-Druck)
// ---------------------------------------------------------------------------
function invoiceHTML(order) {
  const co = settings.company;
  const vatNote = co.kleinunternehmer
    ? 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'
    : `Im Gesamtbetrag enthaltene USt (19 %): ${money(order.total - order.total / 1.19)}`;
  const payNote = order.payment === 'paypal'
    ? `Bezahlt per PayPal am ${new Date(order.createdAt).toLocaleDateString('de-DE')}.`
    : `Bitte überweise den Gesamtbetrag innerhalb von 14 Tagen unter Angabe der Rechnungsnummer:<br>
       <b>${esc(co.iban)}</b>${co.bic ? ` · BIC: ${esc(co.bic)}` : ''}${co.bank ? ` · ${esc(co.bank)}` : ''}`;
  const rows = order.lines.map((l) => `
    <tr><td>${esc(itemLabel(l))}</td><td class="r">${l.qty}</td><td class="r">${money(l.unit)}</td>
    <td class="r">${l.off ? '−' + l.off + ' %' : '—'}</td><td class="r">${money(l.line)}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Rechnung ${esc(order.invoiceNo)}</title>
  <style>
    body{font-family:system-ui;color:#1d1a16;max-width:800px;margin:40px auto;padding:0 24px;font-size:14px;line-height:1.5}
    .head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:36px}
    h1{font-size:1.5rem;margin:0 0 4px} .muted{color:#6b6257} .sender{font-size:11px;color:#6b6257;margin-bottom:6px}
    table{width:100%;border-collapse:collapse;margin:22px 0}
    th,td{padding:9px 10px;border-bottom:1px solid #e5ddce;text-align:left;vertical-align:top}
    th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b6257}
    .r{text-align:right;white-space:nowrap} .tot td{border:none;padding:4px 10px}
    .grand td{font-weight:700;font-size:1.05rem;border-top:2px solid #1d1a16}
    .note{background:#faf6ee;border:1px solid #e5ddce;border-radius:10px;padding:14px 18px;margin-top:24px}
    @media print{body{margin:10mm auto}.noprint{display:none}}
    .noprint{margin-top:30px}.noprint button{padding:10px 22px;border-radius:999px;border:none;background:#1d1a16;color:#fff;font-weight:600;cursor:pointer}
  </style></head><body>
  <div class="head">
    <div><h1>Rechnung</h1><div class="muted">Nr. ${esc(order.invoiceNo)} · ${new Date(order.createdAt).toLocaleDateString('de-DE')}<br>Bestellung ${esc(order.orderId)}</div></div>
    <div style="text-align:right"><b>${esc(co.name)}</b><br>${esc(co.owner)}<br>${esc(co.street)}<br>${esc(co.zip)} ${esc(co.city)}<br>${esc(co.email)}${co.phone ? '<br>' + esc(co.phone) : ''}${co.ustId ? '<br>USt-IdNr. ' + esc(co.ustId) : ''}</div>
  </div>
  <div class="sender">${esc(co.name)} · ${esc(co.street)} · ${esc(co.zip)} ${esc(co.city)}</div>
  <div><b>${esc(order.customer.name)}</b><br>${esc(order.customer.street)}<br>${esc(order.customer.zip)} ${esc(order.customer.city)}</div>
  <table><tr><th>Artikel (individuell 3D-gedruckt)</th><th class="r">Menge</th><th class="r">Einzelpreis</th><th class="r">Rabatt</th><th class="r">Summe</th></tr>${rows}</table>
  <table style="max-width:340px;margin-left:auto">
    <tr class="tot"><td>Zwischensumme</td><td class="r">${money(order.subtotal)}</td></tr>
    ${order.coupon ? `<tr class="tot"><td>Gutschein „${esc(order.coupon.code)}“</td><td class="r">−${money(order.coupon.off)}</td></tr>` : ''}
    <tr class="tot"><td>Versand</td><td class="r">${order.shipping === 0 ? 'kostenlos' : money(order.shipping)}</td></tr>
    <tr class="tot grand"><td>Gesamtbetrag</td><td class="r">${money(order.total)}</td></tr>
  </table>
  <p class="muted">${vatNote}</p>
  <div class="note">${payNote}</div>
  <p class="muted" style="margin-top:26px">Vielen Dank für deine Bestellung! Jedes Stück wird individuell für dich gedruckt — Lieferzeit ca. 5–8 Werktage.</p>
  <p class="muted" style="font-size:11px">Produkthinweise: Alle Artikel bestehen aus pflanzenbasiertem PLA (nicht spülmaschinengeeignet, nicht dauerhaft über 50 °C aussetzen).
  Vasen sind für Trockenblumen konzipiert; das Material wird imprägniert und ist in der Regel wasserfest — eine Garantie für Wasserdichtigkeit wird nicht übernommen.
  Bei individuell gestalteten Formen (Formen-Editor) wird keine Garantie für die Standfestigkeit übernommen.</p>
  <div class="noprint"><button onclick="print()">🖨️ Drucken / als PDF speichern</button></div>
  </body></html>`;
}

// ---------------------------------------------------------------------------
// PayPal (REST) — aktiv, sobald in den Einstellungen Zugangsdaten hinterlegt sind
// ---------------------------------------------------------------------------
function paypalBase() {
  return settings.paypal.sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
}
async function paypalToken() {
  const auth = Buffer.from(`${settings.paypal.clientId}:${settings.paypal.secret}`).toString('base64');
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error('PayPal-Auth fehlgeschlagen');
  return (await r.json()).access_token;
}
const paypalEnabled = () => !!(settings.paypal?.enabled && settings.paypal?.clientId);
const PAYPAL_ID_RE = /^[A-Z0-9]{10,30}$/;
// Eingelöste Zahlungen (data/paypal-captures.json): PayPal-Order-ID → { amount, currency, capturedAt, usedBy }.
// Der Checkout gilt nur als bezahlt, wenn die ID hier mit passendem Betrag liegt und noch keiner Bestellung zugeordnet ist.
const CAPTURES_FILE = path.join(DATA, 'paypal-captures.json');
const CAPTURES_MAX = 500;
let paypalCaptures = {};
function loadCaptures() { try { paypalCaptures = JSON.parse(readFileSync(CAPTURES_FILE, 'utf8')) || {}; } catch { paypalCaptures = {}; } }
async function saveCaptures() {
  const ids = Object.keys(paypalCaptures);
  if (ids.length > CAPTURES_MAX) for (const id of ids.slice(0, ids.length - CAPTURES_MAX)) delete paypalCaptures[id];   // älteste zuerst (Einfügereihenfolge)
  await writeFile(CAPTURES_FILE, JSON.stringify(paypalCaptures, null, 2));
}
/** Betrag/Währung aus einer PayPal-Order-Antwort (Capture bevorzugt, sonst purchase_unit) */
function paypalAmountOf(j) {
  const pu = j?.purchase_units?.[0];
  const a = pu?.payments?.captures?.[0]?.amount || pu?.amount || {};
  return { amount: String(a.value ?? ''), currency: String(a.currency_code ?? '') };
}
/**
 * Zahlung zu einer PayPal-Order-ID bestätigen: aus dem Capture-Speicher, sonst Nachfrage bei PayPal
 * (status COMPLETED). Liefert den Eintrag oder wirft einen Fehler mit lesbarer Meldung.
 */
async function verifyPaypalCapture(id) {
  let cap = paypalCaptures[id];
  if (!cap) {
    const token = await paypalToken();
    const r = await fetch(`${paypalBase()}/v2/checkout/orders/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = r.ok ? await r.json() : null;
    if (!j || j.status !== 'COMPLETED') throw new Error('Zahlung nicht bestätigt');
    cap = { ...paypalAmountOf(j), capturedAt: new Date().toISOString(), usedBy: null };
    paypalCaptures[id] = cap;
  }
  return cap;
}

// ---------------------------------------------------------------------------
// Bestellungen
// ---------------------------------------------------------------------------
async function listOrders() {
  if (!existsSync(ORDERS)) return [];
  const dirs = (await readdir(ORDERS, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
  const orders = [];
  for (const d of dirs) {
    try { orders.push(await readOrder(d)); } catch { /* unvollständig */ }
  }
  return orders;
}

async function handleCheckout(req, res) {
  const data = JSON.parse((await readBody(req)).toString('utf8'));
  const { items, payment, paypalOrderId, couponCode } = data;
  // Kundendaten: nur die bekannten Felder, ohne Steuerzeichen, mit Längengrenzen (Notiz darf Zeilenumbrüche haben)
  const clip = (v, n, nl = false) => String(v ?? '').replace(nl ? /[^\S\n]+|[\x00-\x08\x0b-\x1f\x7f]+/g : /[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n);
  const customer = {
    name: clip(data.customer?.name, 120), email: clip(data.customer?.email, 254).toLowerCase(),
    street: clip(data.customer?.street, 200), zip: clip(data.customer?.zip, 20), city: clip(data.customer?.city, 120),
    note: clip(data.customer?.note, 1000, true),
  };
  if (!customer.name || !isEmail(customer.email) || !customer.street || !customer.zip || !customer.city) {
    return send(res, 400, { ok: false, error: 'Bitte Adresse vollständig ausfüllen' });
  }
  if (!Array.isArray(items) || !items.length || items.length > 20) {
    return send(res, 400, { ok: false, error: 'Warenkorb ist leer' });
  }
  const totals = computeTotals(items, couponCode);
  // PayPal: Zahlung serverseitig bestätigen (Capture-Speicher bzw. Nachfrage bei PayPal), Betrag/Währung
  // müssen zur Bestellung passen und die PayPal-ID darf nur einmal verwendet werden — sonst keine Bestellung
  let paypalCap = null;
  if (payment === 'paypal') {
    if (!paypalEnabled()) return send(res, 400, { ok: false, error: 'PayPal nicht aktiviert' });
    if (!PAYPAL_ID_RE.test(String(paypalOrderId || ''))) return send(res, 400, { ok: false, error: 'Ungültige PayPal-Zahlungs-ID' });
    try { paypalCap = await verifyPaypalCapture(paypalOrderId); } catch (err) {
      console.error(`PayPal-Prüfung ${paypalOrderId} fehlgeschlagen:`, err?.message || err);
      return send(res, 400, { ok: false, error: 'Zahlung nicht bestätigt' });
    }
    if (paypalCap.usedBy) return send(res, 400, { ok: false, error: 'Zahlung nicht bestätigt (bereits einer Bestellung zugeordnet)' });
    if (paypalCap.amount !== totals.total.toFixed(2) || paypalCap.currency !== settings.pricing.currency) {
      return send(res, 400, { ok: false, error: 'Zahlung nicht bestätigt (Betrag weicht von der Bestellung ab)' });
    }
  }
  const orderId = newOrderId();
  if (paypalCap) { paypalCap.usedBy = orderId; await saveCaptures(); }
  await mkdir(path.join(ORDERS, orderId), { recursive: true });
  const account = userFromReq(req);
  const order = {
    orderId,
    userId: account?.id || null,
    createdAt: new Date().toISOString(),
    status: 'neu',
    payment: paypalCap ? 'paypal' : 'vorkasse',
    paymentStatus: paypalCap ? 'bezahlt' : 'offen',
    paidAt: paypalCap ? paypalCap.capturedAt : null,
    paypalOrderId: paypalCap ? String(paypalOrderId) : null,
    customer,
    lines: totals.lines.map((l, i) => ({
      product: l.product, qty: l.qty, saucer: !!l.saucer, config: l.config,
      colorName: l.colorName, unit: l.unit, off: l.off, line: l.line,
      // Farbschrift (zweites Filament) kommt als 3MF mit zwei Teilen, sonst STL
      stlFile: `modell-${i + 1}-${l.product}.${(String(l.config?.text || '').trim() && l.config?.textStyle === 'farbe') ? '3mf' : 'stl'}`,
    })),
    subtotal: totals.subtotal, coupon: totals.coupon, shipping: totals.shipping, total: totals.total,
    invoiceNo: null, filesComplete: false,
    trackingNo: '', adminNote: '',
  };
  await writeOrder(order);
  send(res, 200, { ok: true, orderId, itemCount: order.lines.length, total: order.total });
}

async function handleStlUpload(req, res, id, idx) {
  let order;
  try { order = await readOrder(id); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
  if (order.filesComplete) return send(res, 400, { ok: false, error: 'Bestellung abgeschlossen' });
  const i = parseInt(idx, 10);
  if (!(i >= 0 && i < order.lines.length)) return send(res, 400, { ok: false, error: 'Ungültiger Index' });
  const file = path.join(ORDERS, id, order.lines[i].stlFile);
  const out = createWriteStream(file);
  let size = 0, aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_STL && !aborted) { aborted = true; out.destroy(); req.destroy(); send(res, 413, { ok: false, error: 'Datei zu groß' }); }
  });
  req.pipe(out);
  out.on('finish', () => { if (!aborted) send(res, 200, { ok: true, bytes: size }); });
  out.on('error', () => { if (!aborted) send(res, 500, { ok: false, error: 'Speicherfehler' }); });
}

// Idempotent: ein zweiter Aufruf (Retry, Doppelklick, Dritte) liefert nur noch die Rechnungsdaten —
// keine neue Rechnungsnummer, kein erneutes Schreiben, keine zweite Bestätigungsmail
async function handleComplete(req, res, id) {
  let order;
  const release = await lockOrder(id);
  try {
    try { order = await readOrder(id); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
    if (order.completedAt) return send(res, 200, { ok: true, invoiceUrl: `/orders/${id}/rechnung.html`, invoiceNo: order.invoiceNo });
    if (!order.invoiceNo) {
      order.invoiceNo = settings.invoicePrefix + String(settings.nextInvoice++).padStart(4, '0');
      await saveSettings();
    }
    order.filesComplete = order.lines.every((l) => existsSync(path.join(ORDERS, id, l.stlFile)));
    order.completedAt = new Date().toISOString();
    await writeFile(path.join(ORDERS, id, 'rechnung.html'), invoiceHTML(order));
    await writeOrder(order);
  } finally { release(); }
  console.log(`📦 Bestellung ${id} — ${order.lines.length} Position(en), ${money(order.total)}, ${order.payment} (${order.customer.name})`);
  send(res, 200, { ok: true, invoiceUrl: `/orders/${id}/rechnung.html`, invoiceNo: order.invoiceNo });
  await runHook('orderCompleted', order);
}

// ---------------------------------------------------------------------------
// Admin-Seite (Login clientseitig, API mit x-admin-key)
// ---------------------------------------------------------------------------
function adminHTML() {
  return readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
}

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // URL-Parsen/Dekodieren geschützt: kaputte Prozentkodierung oder ein ungültiger Host-Header dürfen den
  // Prozess nicht beenden (400 statt unbehandelter Ausnahme). Der Host wird nirgends ausgewertet → feste Basis.
  let url, p;
  try {
    url = new URL(req.url, 'http://localhost');
    p = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, { ok: false, error: 'Ungültige URL' });
  }

  try {
    // --- öffentliche API
    if (p === '/api/pricing') {
      const pr = settings.pricing;
      return send(res, 200, {
        currency: pr.currency,
        products: {
          eierbecher: { single: pr.eierbecher.single, untersetzer: pr.eierbecher.untersetzer, discounts: pr.eierbecher.discounts },
          vase: { single: pr.vase.single, discounts: pr.vase.discounts },
        },
        shipping: pr.shipping,
        gravur: pr.gravur,
        volumen: pr.volumen,
        normalHeight: NORMAL_HEIGHT,
        paypal: { enabled: settings.paypal.enabled && !!settings.paypal.clientId, clientId: settings.paypal.clientId, sandbox: settings.paypal.sandbox },
      });
    }
    // --- Kundenkonten
    if (req.method === 'POST' && p === '/api/auth/register') {
      const { name, email, password } = JSON.parse((await readBody(req)).toString('utf8'));
      const mail = String(email || '').trim().toLowerCase();
      if (!name?.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return send(res, 400, { ok: false, error: 'Bitte Name und gültige E-Mail angeben' });
      if (String(password || '').length < 6) return send(res, 400, { ok: false, error: 'Passwort: mindestens 6 Zeichen' });
      if (users.some((u) => u.email === mail)) return send(res, 400, { ok: false, error: 'Für diese E-Mail existiert schon ein Konto — bitte anmelden' });
      const salt = crypto.randomBytes(16).toString('hex');
      const user = { id: crypto.randomUUID(), name: name.trim(), email: mail, salt, hash: hashPw(password, salt), address: null, createdAt: new Date().toISOString() };
      users.push(user);
      await saveUsers();
      send(res, 200, { ok: true, token: createSession(user.id), user: publicUser(user) });
      return runHook('userRegistered', { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt });
    }
    if (req.method === 'POST' && p === '/api/auth/login') {
      const { email, password } = JSON.parse((await readBody(req)).toString('utf8'));
      const u = users.find((x) => x.email === String(email || '').trim().toLowerCase());
      const ok = u && crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), Buffer.from(hashPw(password || '', u.salt), 'hex'));
      if (!ok) return send(res, 401, { ok: false, error: 'E-Mail oder Passwort falsch' });
      return send(res, 200, { ok: true, token: createSession(u.id), user: publicUser(u) });
    }
    if (req.method === 'POST' && p === '/api/auth/logout') {
      delete sessions[req.headers['x-auth'] || ''];
      await saveSessions();
      return send(res, 200, { ok: true });
    }
    // Passwort vergessen: Link per Mail (Antwort verrät nicht, ob ein Konto existiert)
    if (req.method === 'POST' && p === '/api/auth/forgot') {
      let body; try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch { body = {}; }
      const mail = String(body?.email || '').trim().toLowerCase();
      if (mail.length > 254 || !isEmail(mail)) return send(res, 400, { ok: false, error: 'Bitte eine gültige E-Mail-Adresse angeben' });   // 254 = RFC-5321-Maximum
      // IP-Limit zuerst und kurzschließend: eine gesperrte IP legt keine neuen Mail-Schlüssel mehr an
      if (forgotLimited(`ip:${clientIp(req)}`, FORGOT_IP_MAX) || forgotLimited(`mail:${mail}`)) {
        return send(res, 429, { ok: false, error: 'Zu viele Anfragen — bitte in 15 Minuten noch einmal versuchen.' });
      }
      send(res, 200, { ok: true });
      const u = users.find((x) => x.email === mail);
      if (!u) return;
      try {
        const token = crypto.randomBytes(24).toString('base64url');
        u.reset = { hash: sha256(token), exp: Date.now() + RESET_TTL };
        await saveUsers();
        const m = passwordReset({ user: { name: u.name, email: u.email }, link: `${baseUrlFor(settings)}/?reset=${token}`, settings });
        await mailer.queue({ to: { name: u.name, email: u.email }, subject: m.subject, text: m.text, html: m.html, kind: 'passwort-reset', ref: u.id });
      } catch (err) { console.error('Passwort-Reset-Mail fehlgeschlagen:', err?.message || err); }
      return;
    }
    // Neues Passwort mit Token aus der Mail; meldet alle bisherigen Sitzungen ab und startet eine neue
    if (req.method === 'POST' && p === '/api/auth/reset') {
      let body; try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch { body = {}; }
      const u = userByResetToken(body?.token);
      if (!u) return send(res, 400, { ok: false, error: 'Link ungültig oder abgelaufen' });
      if (String(body?.password || '').length < 6) return send(res, 400, { ok: false, error: 'Passwort: mindestens 6 Zeichen' });
      u.salt = crypto.randomBytes(16).toString('hex');
      u.hash = hashPw(body.password, u.salt);
      delete u.reset;
      for (const [t, s] of Object.entries(sessions)) if (s.userId === u.id) delete sessions[t];
      await saveUsers();
      return send(res, 200, { ok: true, token: createSession(u.id), user: publicUser(u) });
    }
    if (p === '/api/auth/me') {
      const u = userFromReq(req);
      if (!u) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const orders = (await listOrders())
        .filter((o) => o.userId === u.id || (o.customer?.email || '').toLowerCase() === u.email)
        .map((o) => ({
          orderId: o.orderId, createdAt: o.createdAt, status: o.status || 'neu',
          total: o.total, invoiceNo: o.invoiceNo, trackingNo: o.trackingNo || '', carrier: o.carrier || '',
          paidAt: o.paidAt || null, shippedAt: o.shippedAt || null,
          pieces: (o.lines || []).reduce((s, l) => s + (l.qty || 0), 0),
          // Zeitleiste fürs Konto — nur echte Statuswechsel mit Zeitpunkt; interne Notizen (Admin/Automatik/Mail) bleiben hier
          history: (o.history || []).filter((h) => h && h.by !== 'mail')
            .filter((h, i, a) => i === 0 || h.status !== a[i - 1].status)
            .slice(-30).map((h) => ({ at: h.at, status: h.status })),
        }));
      return send(res, 200, { ok: true, user: publicUser(u), orders });
    }
    if (req.method === 'POST' && p === '/api/auth/address') {
      const u = userFromReq(req);
      if (!u) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const { street, zip, city } = JSON.parse((await readBody(req)).toString('utf8'));
      u.address = { street: street || '', zip: zip || '', city: city || '' };
      await saveUsers();
      return send(res, 200, { ok: true });
    }

    // --- Galerie (Produktfotos, gepflegt über den Admin)
    if (p === '/api/gallery') {
      const dir = path.join(PUBLIC, 'img', 'gallery');
      if (!existsSync(dir)) return send(res, 200, []);
      const files = (await readdir(dir)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
      return send(res, 200, files.map((f) => ({
        file: `/img/gallery/${f}`,
        cat: (f.match(/^(eierbecher|vase|galerie)-/) || [, 'galerie'])[1],
      })));
    }
    const mImg = p.match(/^\/api\/admin\/gallery\/([a-zA-Z0-9._-]+)$/);
    if (req.method === 'PUT' && p === '/api/admin/gallery') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const cat = ['eierbecher', 'vase', 'galerie'].includes(url.searchParams.get('cat')) ? url.searchParams.get('cat') : 'galerie';
      const rawName = (url.searchParams.get('name') || 'foto.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!/\.(jpe?g|png|webp)$/i.test(rawName)) return send(res, 400, { ok: false, error: 'Nur JPG/PNG/WebP' });
      const body = await readBody(req, 10 * 1024 * 1024);
      if (body.length < 100) return send(res, 400, { ok: false, error: 'Leere Datei' });
      const dir = path.join(PUBLIC, 'img', 'gallery');
      await mkdir(dir, { recursive: true });
      const fname = `${cat}-${Date.now().toString(36)}-${rawName}`;
      await writeFile(path.join(dir, fname), body);
      return send(res, 200, { ok: true, file: `/img/gallery/${fname}` });
    }
    if (req.method === 'DELETE' && mImg) {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const file = path.join(PUBLIC, 'img', 'gallery', mImg[1]);
      if (existsSync(file)) await rm(file);
      return send(res, 200, { ok: true });
    }

    // --- Design-Codes: speichern (POST) & laden (GET /api/design/CODE)
    if (req.method === 'POST' && p === '/api/design') {
      let cfg;
      try { cfg = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')).config; } catch { cfg = null; }
      if (!cfg || !['vase', 'eierbecher'].includes(cfg.product)) return send(res, 400, { ok: false, error: 'Ungültiges Design' });
      const { code, canon, isNew } = designCode(cfg);
      if (isNew) {
        designs[code] = { config: canon, createdAt: Date.now(), loads: 0 };
        await saveDesigns();
      }
      return send(res, 200, { ok: true, code });
    }
    const mDesign = p.match(/^\/api\/design\/([A-Za-z0-9-]{4,40})$/);
    if (req.method === 'GET' && mDesign) {
      const code = normalizeCode(mDesign[1]);
      const d = designs[code];
      if (!d) return send(res, 404, { ok: false, error: 'Diesen Design-Code gibt es nicht — bitte prüfen (z. B. B statt 8).' });
      d.loads = (d.loads || 0) + 1; d.lastLoad = Date.now();
      saveDesigns();
      return send(res, 200, { ok: true, code, config: d.config });
    }

    // --- Vorschaubild eines Designs (PUT: data-URL JPEG vom Client, GET: Bild)
    const mThumb = p.match(/^\/api\/design\/([A-Za-z0-9-]{4,40})\/thumb$/);
    if (mThumb) {
      const code = normalizeCode(mThumb[1]);
      const file = path.join(THUMBS, `${code}.jpg`);
      if (req.method === 'PUT') {
        if (!designs[code]) return send(res, 404, { ok: false, error: 'Design unbekannt' });
        const raw = (await readBody(req, 120 * 1024)).toString('utf8');
        const m = raw.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return send(res, 400, { ok: false, error: 'Nur JPEG (data-URL)' });
        await mkdir(THUMBS, { recursive: true });
        await writeFile(file, Buffer.from(m[1], 'base64'));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET') {
        if (!existsSync(file)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
        return res.end(await readFile(file));
      }
    }

    // --- Design-Listen
    if (req.method === 'POST' && p === '/api/list') {
      let b; try { b = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch { b = {}; }
      const name = String(b.name || '').trim().slice(0, 60) || 'Meine Liste';
      const code = newListCode();
      const token = crypto.randomBytes(16).toString('hex');
      const l = {
        code, token, name, occasion: LIST_OCCASIONS.includes(b.occasion) ? b.occasion : 'sonstiges',
        note: String(b.note || '').slice(0, 300), items: cleanListItems(b.items),
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      lists[code] = l;
      await saveLists();
      return send(res, 200, { ok: true, code, token, list: publicList(l) });
    }
    const mList = p.match(/^\/api\/list\/([A-Za-z0-9-]{4,20})$/);
    if (mList) {
      const code = normalizeCode(mList[1]);
      const l = lists[code];
      if (!l) return send(res, 404, { ok: false, error: 'Diese Liste gibt es nicht — bitte den Code prüfen.' });
      if (req.method === 'GET') return send(res, 200, { ok: true, list: publicList(l) });
      let b; try { b = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch { b = {}; }
      if (!b.token || b.token !== l.token) return send(res, 403, { ok: false, error: 'Nur der Besitzer kann diese Liste ändern.' });
      if (req.method === 'DELETE') { delete lists[code]; await saveLists(); return send(res, 200, { ok: true }); }
      if (req.method === 'PUT') {
        if (b.name !== undefined) l.name = String(b.name).trim().slice(0, 60) || l.name;
        if (b.occasion !== undefined && LIST_OCCASIONS.includes(b.occasion)) l.occasion = b.occasion;
        if (b.note !== undefined) l.note = String(b.note).slice(0, 300);
        if (b.items !== undefined) l.items = cleanListItems(b.items);
        l.updatedAt = Date.now();
        await saveLists();
        return send(res, 200, { ok: true, list: publicList(l) });
      }
    }

    if (p === '/api/colors') {
      return send(res, 200, settings.colors.filter((c) => c.active).map(({ id, name, hex, finish }) => ({ id, name, hex, finish: finish || 'matt' })));
    }
    if (req.method === 'POST' && p === '/api/quote') {
      const { items, couponCode } = JSON.parse((await readBody(req)).toString('utf8'));
      const t = computeTotals(items || [], couponCode);
      return send(res, 200, {
        ok: true,
        lines: t.lines.map((l) => ({ qty: l.qty, unit: l.unit, off: l.off, line: l.line })),
        subtotal: t.subtotal, coupon: t.coupon, couponValid: couponCode ? !!t.coupon : null,
        shipping: t.shipping, total: t.total,
      });
    }
    if (req.method === 'POST' && p === '/api/checkout') return await handleCheckout(req, res);
    const mUp = p.match(/^\/api\/order\/([A-Z0-9-]+)\/stl\/(\d+)$/);
    if (req.method === 'PUT' && mUp) return await handleStlUpload(req, res, mUp[1], mUp[2]);
    const mDone = p.match(/^\/api\/order\/([A-Z0-9-]+)\/complete$/);
    if (req.method === 'POST' && mDone) return await handleComplete(req, res, mDone[1]);

    // --- PayPal
    if (req.method === 'POST' && p === '/api/paypal/create') {
      if (!settings.paypal.enabled) return send(res, 400, { ok: false, error: 'PayPal nicht aktiviert' });
      const { items, couponCode } = JSON.parse((await readBody(req)).toString('utf8'));
      const t = computeTotals(items, couponCode);
      const token = await paypalToken();
      const r = await fetch(`${paypalBase()}/v2/checkout/orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{ amount: { currency_code: settings.pricing.currency, value: t.total.toFixed(2) }, description: 'OVJU — individuelle 3D-Drucke' }],
        }),
      });
      const j = await r.json();
      return send(res, r.ok ? 200 : 500, r.ok ? { ok: true, id: j.id } : { ok: false, error: j.message || 'PayPal-Fehler' });
    }
    const mCap = p.match(/^\/api\/paypal\/capture\/([A-Z0-9]+)$/i);
    if (req.method === 'POST' && mCap) {
      const token = await paypalToken();
      const r = await fetch(`${paypalBase()}/v2/checkout/orders/${mCap[1]}/capture`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const j = await r.json();
      const ok = r.ok && j.status === 'COMPLETED';
      // Eingelöste Zahlung merken — der Checkout prüft dagegen (Betrag, Währung, einmalige Verwendung)
      if (ok && !paypalCaptures[mCap[1]]) {
        paypalCaptures[mCap[1]] = { ...paypalAmountOf(j), capturedAt: new Date().toISOString(), usedBy: null };
        await saveCaptures();
      }
      return send(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, error: 'Zahlung nicht abgeschlossen' });
    }

    // --- Admin-API
    const orderIdOk = (id) => typeof id === 'string' && /^[A-Z0-9-]+$/.test(id);
    if (p === '/api/admin/data') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      return send(res, 200, {
        ok: true, settings: adminSettingsView(), orders: await listOrders(),
        statuses: STATUSES, statusLabels: STATUS_LABELS, carriers: CARRIER_LABELS, normalHeight: NORMAL_HEIGHT,
        mailStatuses: Object.keys(STATUS_MAIL),   // Status mit Mail-Vorlage (Admin blendet Status-Mail-Knöpfe danach ein)
        info: { node: process.version, uptime: Math.round(process.uptime()), startedAt: SERVER_STARTED },
      });
    }
    if (req.method === 'POST' && p === '/api/admin/settings') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const patch = JSON.parse((await readBody(req)).toString('utf8'));
      // Admin-Passwort: nur ein nicht-leerer String (≥ 8 Zeichen) — leer würde den Admin für alle öffnen, Nicht-Strings sperren aus
      if (patch.adminKey !== undefined) {
        if (typeof patch.adminKey !== 'string' || patch.adminKey.trim().length < 8) return send(res, 400, { ok: false, error: 'Admin-Passwort: mindestens 8 Zeichen' });
        settings.adminKey = patch.adminKey.trim();
      }
      // Nur bekannte Wurzel-Schlüssel übernehmen
      for (const k of ['pricing', 'company', 'invoicePrefix', 'colors', 'coupons', 'printing']) {
        if (patch[k] !== undefined) settings[k] = patch[k];
      }
      // PayPal: Secret-Maske wie beim SMTP-Passwort — leer = gespeichertes behalten, null = löschen
      if (patch.paypal && typeof patch.paypal === 'object') {
        const prev = settings.paypal || {};
        const next = { ...DEFAULT_SETTINGS.paypal, ...prev };
        for (const k of ['enabled', 'sandbox', 'clientId']) if (patch.paypal[k] !== undefined) next[k] = patch.paypal[k];
        if (patch.paypal.secret === null) next.secret = '';
        else if (String(patch.paypal.secret ?? '')) next.secret = String(patch.paypal.secret);
        settings.paypal = next;
      }
      settings.printing = { ...DEFAULT_SETTINGS.printing, ...(settings.printing || {}) };
      // E-Mail: nur bekannte Felder; Passwort-Maske — leer = gespeichertes behalten, null = löschen
      if (patch.mail && typeof patch.mail === 'object') {
        const prev = settings.mail || {};
        const next = { ...DEFAULT_SETTINGS.mail, ...prev };
        for (const k of MAIL_KEYS) if (patch.mail[k] !== undefined) next[k] = patch.mail[k];
        if (patch.mail.pass === null) next.pass = '';
        else if (!String(patch.mail.pass ?? '')) next.pass = prev.pass || '';
        settings.mail = mailSettings(next);
      } else settings.mail = { ...DEFAULT_SETTINGS.mail, ...(settings.mail || {}) };
      await saveSettings();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/admin/order-update') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { orderId, status, paymentStatus, trackingNo, carrier, adminNote, note } = body;
      if (!orderIdOk(orderId)) return send(res, 400, { ok: false, error: 'Ungültige Bestellnummer' });
      if (status !== undefined && !STATUSES.includes(status)) return send(res, 400, { ok: false, error: 'Ungültiger Status' });
      if (paymentStatus !== undefined && !['offen', 'bezahlt'].includes(paymentStatus)) return send(res, 400, { ok: false, error: 'Ungültiger Zahlungsstatus' });
      if (carrier !== undefined && !CARRIERS.includes(carrier)) return send(res, 400, { ok: false, error: 'Unbekannter Versender' });
      let order, prevStatus;
      const release = await lockOrder(orderId);
      try {
        try { order = await readOrder(orderId); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
        prevStatus = order.status;
        const now = new Date().toISOString();
        // „Zahlung verbuchen“ schickt paymentStatus UND status 'bezahlt' — dann nur ein Historieneintrag (über setOrderStatus)
        const paidViaStatus = status === 'bezahlt' && order.status !== 'bezahlt';
        if (paymentStatus !== undefined && paymentStatus !== order.paymentStatus) {
          order.paymentStatus = paymentStatus;
          if (paymentStatus === 'bezahlt') {
            order.paidAt = now;
            if (!paidViaStatus) addHistory(order, order.status, note || 'Zahlung eingegangen', 'admin');
          } else {
            order.paidAt = null;
            delete order.mailsSent.bezahlt;   // Fehlklick zurückgenommen → die echte Bezahlt-Mail darf später noch raus
            addHistory(order, order.status, note || 'Zahlung auf „offen“ zurückgesetzt', 'admin');
          }
        }
        if (carrier !== undefined) order.carrier = carrier;
        const trackingChanged = trackingNo !== undefined && String(trackingNo).trim() !== (order.trackingNo || '');
        if (trackingNo !== undefined) order.trackingNo = String(trackingNo).trim().slice(0, 80);
        if (adminNote !== undefined) order.adminNote = String(adminNote).slice(0, 2000);
        if (status !== undefined) {
          const shipNote = status === 'versendet' && order.trackingNo
            ? `Versendet${order.carrier ? ' mit ' + CARRIER_LABELS[order.carrier] : ''} · ${order.trackingNo}` : null;
          const payNote = paidViaStatus && paymentStatus === 'bezahlt' ? 'Zahlung eingegangen' : null;
          setOrderStatus(order, status, note || shipNote || payNote, 'admin');
        } else if (trackingChanged && order.trackingNo) {
          addHistory(order, order.status, `Sendungsnummer hinterlegt${order.carrier ? ' (' + CARRIER_LABELS[order.carrier] + ')' : ''}: ${order.trackingNo}`, 'admin');
        }
        await writeOrder(order);
      } finally { release(); }
      send(res, 200, { ok: true, order });
      if (order.status !== prevStatus) await runHook('statusChanged', order, prevStatus, { notify: body.notify !== false });
      return;
    }
    // Druckstatus je Position — mit Automatik für den Bestellstatus (im-druck / gedruckt)
    if (req.method === 'POST' && p === '/api/admin/line-print') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const { orderId, idx, status, note } = JSON.parse((await readBody(req)).toString('utf8'));
      if (!orderIdOk(orderId)) return send(res, 400, { ok: false, error: 'Ungültige Bestellnummer' });
      if (!PRINT_STATES.includes(status)) return send(res, 400, { ok: false, error: 'Ungültiger Druckstatus' });
      let order, prevStatus, wasPrinted;
      const release = await lockOrder(orderId);
      try {
        try { order = await readOrder(orderId); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
        const i = parseInt(idx, 10);
        if (!(i >= 0 && i < order.lines.length)) return send(res, 400, { ok: false, error: 'Ungültige Position' });
        const line = order.lines[i];
        const prev = line.print || { status: 'offen' };
        const now = new Date().toISOString();
        const print = { status };
        if (status === 'druckt') { print.startedAt = prev.status === 'druckt' && prev.startedAt ? prev.startedAt : now; }
        if (status === 'fertig') { print.startedAt = prev.startedAt || now; print.doneAt = now; }
        if (note !== undefined) print.note = String(note).slice(0, 300);
        else if (prev.note) print.note = prev.note;
        line.print = print;
        const label = `Position ${i + 1} (${line.qty}× ${line.product === 'vase' ? 'Vase' : 'Eierbecher'})`;
        addHistory(order, order.status, { offen: `${label}: Druck zurückgesetzt`, druckt: `${label}: Druck gestartet`, fertig: `${label}: gedruckt` }[status], 'admin');
        prevStatus = order.status;
        wasPrinted = order.status === 'gedruckt';   // Nachdruck: aus „gedruckt“ zurück nach „im Druck“
        const allDone = () => order.lines.every((l) => l.print?.status === 'fertig');
        if (status === 'druckt' && (orderIsPaid(order) || wasPrinted)) {
          setOrderStatus(order, 'im-druck', wasPrinted ? 'Automatisch: Nachdruck gestartet' : 'Automatisch: erster Druck gestartet', 'system');
        } else if (status === 'fertig' && allDone() && (orderIsPaid(order) || order.status === 'im-druck')) {
          setOrderStatus(order, 'gedruckt', 'Automatisch: alle Positionen gedruckt', 'system');
        } else if (status === 'offen' && wasPrinted && !allDone()) {
          setOrderStatus(order, 'im-druck', 'Automatisch: Position zurückgesetzt (Nachdruck)', 'system');
        }
        await writeOrder(order);
      } finally { release(); }
      send(res, 200, { ok: true, order });
      // Rückstufung gedruckt → im-druck ohne Kundenmail (sonst käme nach „Fertig gedruckt“ noch „Im Druck“)
      if (order.status !== prevStatus) await runHook('statusChanged', order, prevStatus, { notify: !wasPrinted, auto: true });
      return;
    }
    if (p === '/api/admin/users') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      return send(res, 200, { ok: true, users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, createdAt: u.createdAt, address: u.address || null })) });
    }
    const mAdminOrder = p.match(/^\/api\/admin\/order\/([A-Z0-9-]+)$/);
    if (req.method === 'GET' && mAdminOrder) {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try { return send(res, 200, { ok: true, order: await readOrder(mAdminOrder[1]) }); }
      catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
    }
    if (p === '/api/admin/export') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      // Backup ohne Geheimnisse (SMTP-Passwort, PayPal-Secret, Admin-Passwort) — die Datei landet im Download-Ordner
      return send(res, 200, { exportedAt: new Date().toISOString(), settings: adminSettingsView(), orders: await listOrders() });
    }
    if (p === '/api/admin/orders.csv') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const orders = await listOrders();
      // Formel-Injection (Excel/Calc): Zellen, die mit = + - @ Tab/CR beginnen, bekommen ein Hochkomma (OWASP)
      const csvEsc = (v) => {
        let s = String(v ?? '');
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return `"${s.replace(/"/g, '""')}"`;
      };
      const rows = [['Bestellung', 'Datum', 'Status', 'Zahlart', 'Rechnung', 'Name', 'E-Mail', 'Straße', 'PLZ', 'Ort', 'Positionen', 'Gutschein', 'Summe', 'Tracking', 'Versender', 'Bezahlt am', 'Versendet am'].join(';')];
      for (const o of orders) {
        rows.push([
          csvEsc(o.orderId), csvEsc(new Date(o.createdAt).toLocaleString('de-DE')), csvEsc(o.status || 'neu'),
          csvEsc(o.payment || ''), csvEsc(o.invoiceNo || ''), csvEsc(o.customer?.name || o.name || ''),
          csvEsc(o.customer?.email || o.email || ''), csvEsc(o.customer?.street || ''), csvEsc(o.customer?.zip || ''),
          csvEsc(o.customer?.city || ''),
          csvEsc((o.lines || []).map((l) => `${l.qty}x ${itemLabel(l)}`).join(' | ')),
          csvEsc(o.coupon ? o.coupon.code : ''),
          csvEsc((o.total ?? 0).toFixed(2).replace('.', ',')), csvEsc(o.trackingNo || ''),
          csvEsc(CARRIER_LABELS[o.carrier] || ''),
          csvEsc(o.paidAt ? new Date(o.paidAt).toLocaleString('de-DE') : ''),
          csvEsc(o.shippedAt ? new Date(o.shippedAt).toLocaleString('de-DE') : ''),
        ].join(';'));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ovju-bestellungen.csv"' });
      return res.end('﻿' + rows.join('\n'));
    }
    // Kompatibel: alter Kurz-Endpoint (nur Status)
    if (req.method === 'POST' && p === '/api/admin/order-status') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const { orderId, status } = JSON.parse((await readBody(req)).toString('utf8'));
      if (!orderIdOk(orderId)) return send(res, 400, { ok: false, error: 'Ungültige Bestellnummer' });
      if (!STATUSES.includes(status)) return send(res, 400, { ok: false, error: 'Ungültiger Status' });
      let order, prevStatus;
      const release = await lockOrder(orderId);
      try {
        try { order = await readOrder(orderId); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
        prevStatus = order.status;
        setOrderStatus(order, status, null, 'admin');
        await writeOrder(order);
      } finally { release(); }
      send(res, 200, { ok: true, order });
      if (order.status !== prevStatus) await runHook('statusChanged', order, prevStatus, { notify: true });
      return;
    }
    // --- E-Mail (Admin): Vorschau & Versand zu einer Bestellung, Testmail, Protokoll, erneut senden
    if (req.method === 'POST' && (p === '/api/admin/mail-preview' || p === '/api/admin/mail-send')) {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try {
        const body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8'));
        if (!orderIdOk(body.orderId)) return send(res, 400, { ok: false, error: 'Ungültige Bestellnummer' });
        let order;
        try { order = await readOrder(body.orderId); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
        const m = renderOrderMail(order, body);
        const cust = customerAddress(order);
        if (p === '/api/admin/mail-preview') return send(res, 200, { ok: true, subject: m.subject, html: m.html, text: m.text, to: cust.email, kind: m.kind });
        if (!isEmail(cust.email)) return send(res, 400, { ok: false, error: 'Die Bestellung hat keine gültige Kunden-E-Mail' });
        const r = await mailer.send({ to: cust, subject: m.subject, text: m.text, html: m.html, kind: m.kind, ref: order.orderId });
        if (r.ok && m.key) await noteMailSent(order, m.key, m.subject, cust.email);
        if (!r.ok && /nicht eingerichtet/.test(r.error || '')) r.error += ' — die Nachricht liegt im Versandprotokoll und kann nach der Einrichtung erneut gesendet werden';
        return send(res, 200, { ok: !!r.ok, id: r.id, error: r.error || '' });
      } catch (err) {
        return send(res, err.httpCode || 500, { ok: false, error: err.message || 'Serverfehler' });
      }
    }
    if (req.method === 'POST' && p === '/api/admin/mail-test') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
        const to = String(body.to || '').trim();
        if (to && !isEmail(to)) return send(res, 400, { ok: false, error: 'Ungültige Empfängeradresse', log: [] });
        const override = {};
        if (body.settings && typeof body.settings === 'object') for (const k of MAIL_KEYS) if (body.settings[k] !== undefined) override[k] = body.settings[k];
        const r = await mailer.test(override, to);
        return send(res, 200, { ok: !!r.ok, error: r.error || '', log: r.log || [] });
      } catch (err) {
        return send(res, 500, { ok: false, error: err.message || 'Serverfehler', log: [] });
      }
    }
    if (p === '/api/admin/mail-log') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try {
        const limit = parseInt(url.searchParams.get('limit'), 10) || 200;
        return send(res, 200, { ok: true, entries: await mailer.list({ limit }), config: mailer.config() });
      } catch (err) {
        return send(res, 500, { ok: false, error: err.message || 'Serverfehler' });
      }
    }
    if (req.method === 'POST' && p === '/api/admin/mail-resend') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try {
        const { id } = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
        if (typeof id !== 'string' || !/^[a-z0-9]{6,40}$/.test(id)) return send(res, 400, { ok: false, error: 'Ungültige Protokoll-ID' });
        const r = await mailer.resend(id);
        return send(res, 200, { ok: !!r.ok, error: r.error || '' });
      } catch (err) {
        return send(res, 500, { ok: false, error: err.message || 'Serverfehler' });
      }
    }
    // Druckzettel (Seite, A4) — Key per Header oder ?k=
    const mZettel = p.match(/^\/admin\/druckzettel\/([A-Z0-9-]+)$/);
    if (req.method === 'GET' && mZettel) {
      if (!isAdmin(req) && !adminKeyMatches(url.searchParams.get('k'))) return send(res, 401, 'Nicht angemeldet — bitte über den Admin-Bereich öffnen.', 'text/plain; charset=utf-8');
      let order;
      try { order = await readOrder(mZettel[1]); } catch { return send(res, 404, 'Bestellung unbekannt', 'text/plain; charset=utf-8'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(druckzettelHTML(order));
    }

    // --- Seiten & Dateien
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p === '/admin' || p === '/admin/') return send(res, 200, adminHTML(), 'text/html; charset=utf-8');

    if (p.startsWith('/orders/')) {
      const file = path.normalize(path.join(__dirname, p));
      // Nur Rechnung (Link in Mails/Konto) und Modelldateien (reine Geometrie) — order.json mit Kundendaten,
      // interner Notiz und Historie wird nie ausgeliefert
      const base = path.basename(file);
      const allowed = base === 'rechnung.html' || /\.(stl|3mf)$/i.test(base);
      if (!allowed || !file.startsWith(ORDERS + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
        return send(res, 404, { ok: false, error: 'Nicht gefunden' });
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return createReadStream(file).pipe(res);
    }

    // Statische Dateien — mit Browser-Cache & gzip für Text-Assets
    let file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { ok: false, error: 'Verboten' });
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
    const ext = path.extname(file);
    const stat = statSync(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // vendor/fonts/env ändern sich praktisch nie → lange cachen;
    // eigene HTML/JS/CSS mit Revalidierung (ETag aus mtime+Größe)
    const isAsset = p.startsWith('/vendor/') || p.startsWith('/fonts/') || p.startsWith('/env/') || p.startsWith('/img/gallery/');
    headers['Cache-Control'] = isAsset ? 'public, max-age=2592000, immutable' : 'no-cache';
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const compressible = ['.html', '.css', '.js', '.json', '.svg'].includes(ext);
    if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && stat.size > 1024) {
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
      res.writeHead(200, headers);
      return createReadStream(file).pipe(createGzip({ level: zc.Z_BEST_SPEED })).pipe(res);
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    send(res, 500, { ok: false, error: 'Serverfehler' });
  }
});

loadSettings();
loadDesigns();
loadLists();
loadUsers();
loadCaptures();
// Sicherheitsnetz: ein einzelner Fehler außerhalb der try/catch-Pfade darf den Shop nicht beenden
process.on('unhandledRejection', (err) => console.error('Unbehandelte Promise-Ablehnung:', err));
process.on('uncaughtException', (err) => console.error('Unbehandelte Ausnahme:', err));
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🥚 OVJU Shop läuft → http://0.0.0.0:${PORT}  (Admin: /admin)`);
  // Outbox laden: wartende Zustellungen aus der Zeit vor dem Neustart sofort weiterverarbeiten
  mailer.resume().catch((e) => console.error('✉️  Outbox konnte nicht geladen werden:', e?.message || e));
});
