// OVJU — Shop-Server: Statik + Pricing + Warenkorb-Checkout + Rechnungen + Admin + PayPal
// Start: node server.js   →   http://<host>:4488   (Admin: /admin, Standard-Passwort: ovju-admin)
import http from 'node:http';
import { createGzip, constants as zc } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync, statSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const ORDERS = path.join(__dirname, 'orders');
const DATA = path.join(__dirname, 'data');
const PORT = process.env.PORT || 4488;
const MAX_JSON = 4 * 1024 * 1024;      // Checkout-JSON (ohne Modelle)
const MAX_STL = 90 * 1024 * 1024;      // pro Modell-Datei (binär)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.stl': 'model/stl', '.svg': 'image/svg+xml',
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
  if (typeof settings.pricing.gravur !== 'number') settings.pricing.gravur = 3.00;
  if (!settings.pricing.volumen) settings.pricing.volumen = { prozent: 60, euro: 0 };
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
  'text', 'textSize', 'textPos', 'font', 'textStyle', 'saucer', 'customPoints', 'color'];
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
function priceItem(item) {
  const p = settings.pricing[item.product];
  if (!p) throw new Error('Unbekanntes Produkt');
  const qty = Math.max(1, Math.min(50, parseInt(item.qty, 10) || 1));
  let unit = p.single;
  if (item.product === 'eierbecher' && item.saucer) unit += p.untersetzer;
  if (String(item.config?.text || '').trim()) unit += settings.pricing.gravur || 0;
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
function isAdmin(req) {
  return (req.headers['x-admin-key'] || '') === settings.adminKey;
}
async function readOrder(id) {
  return JSON.parse(await readFile(path.join(ORDERS, id, 'order.json'), 'utf8'));
}
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
    (c.text ? ` · Gravur „${c.text}“${c.textStyle === 'gehaemmert' ? ' (gehämmert)' : c.textStyle === 'gestanzt' ? ' (gestanzt)' : ''}` : '') +
    (it.saucer ? ' · mit Untersetzer' : '') +
    (it.code ? ` · Design-Code ${it.code}` : '');
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
  const { customer, items, payment, paypalOrderId, couponCode } = data;
  if (!customer?.name || !customer?.email || !customer?.street || !customer?.zip || !customer?.city) {
    return send(res, 400, { ok: false, error: 'Bitte Adresse vollständig ausfüllen' });
  }
  if (!Array.isArray(items) || !items.length || items.length > 20) {
    return send(res, 400, { ok: false, error: 'Warenkorb ist leer' });
  }
  const totals = computeTotals(items, couponCode);
  const orderId = newOrderId();
  await mkdir(path.join(ORDERS, orderId), { recursive: true });
  const account = userFromReq(req);
  const order = {
    orderId,
    userId: account?.id || null,
    createdAt: new Date().toISOString(),
    status: 'neu',
    payment: payment === 'paypal' ? 'paypal' : 'vorkasse',
    paymentStatus: payment === 'paypal' ? 'bezahlt' : 'offen',
    paypalOrderId: paypalOrderId || null,
    customer,
    lines: totals.lines.map((l, i) => ({
      product: l.product, qty: l.qty, saucer: !!l.saucer, config: l.config,
      colorName: l.colorName, unit: l.unit, off: l.off, line: l.line,
      stlFile: `modell-${i + 1}-${l.product}.stl`,
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

async function handleComplete(req, res, id) {
  let order;
  try { order = await readOrder(id); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
  if (!order.invoiceNo) {
    order.invoiceNo = settings.invoicePrefix + String(settings.nextInvoice++).padStart(4, '0');
    await saveSettings();
  }
  order.filesComplete = order.lines.every((l) => existsSync(path.join(ORDERS, id, l.stlFile)));
  await writeFile(path.join(ORDERS, id, 'rechnung.html'), invoiceHTML(order));
  await writeOrder(order);
  console.log(`📦 Bestellung ${id} — ${order.lines.length} Position(en), ${money(order.total)}, ${order.payment} (${order.customer.name})`);
  send(res, 200, { ok: true, invoiceUrl: `/orders/${id}/rechnung.html`, invoiceNo: order.invoiceNo });
}

// ---------------------------------------------------------------------------
// Admin-Seite (Login clientseitig, API mit x-admin-key)
// ---------------------------------------------------------------------------
function adminHTML() {
  return readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
}

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(url.pathname);

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
      return send(res, 200, { ok: true, token: createSession(user.id), user: publicUser(user) });
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
    if (p === '/api/auth/me') {
      const u = userFromReq(req);
      if (!u) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const orders = (await listOrders())
        .filter((o) => o.userId === u.id || (o.customer?.email || '').toLowerCase() === u.email)
        .map((o) => ({
          orderId: o.orderId, createdAt: o.createdAt, status: o.status || 'neu',
          total: o.total, invoiceNo: o.invoiceNo, trackingNo: o.trackingNo || '',
          pieces: (o.lines || []).reduce((s, l) => s + (l.qty || 0), 0),
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
      return send(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, error: 'Zahlung nicht abgeschlossen' });
    }

    // --- Admin-API
    if (p === '/api/admin/data') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      return send(res, 200, { ok: true, settings, orders: await listOrders() });
    }
    if (req.method === 'POST' && p === '/api/admin/settings') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const patch = JSON.parse((await readBody(req)).toString('utf8'));
      // Nur bekannte Wurzel-Schlüssel übernehmen
      for (const k of ['pricing', 'company', 'paypal', 'invoicePrefix', 'adminKey', 'colors', 'coupons']) {
        if (patch[k] !== undefined) settings[k] = patch[k];
      }
      await saveSettings();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/admin/order-update') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const { orderId, status, trackingNo, adminNote } = JSON.parse((await readBody(req)).toString('utf8'));
      const order = await readOrder(orderId);
      if (status !== undefined) {
        if (!['neu', 'bezahlt', 'im-druck', 'versendet', 'storniert'].includes(status)) {
          return send(res, 400, { ok: false, error: 'Ungültiger Status' });
        }
        order.status = status;
        if (status === 'bezahlt') order.paymentStatus = 'bezahlt';
      }
      if (trackingNo !== undefined) order.trackingNo = trackingNo;
      if (adminNote !== undefined) order.adminNote = adminNote;
      await writeOrder(order);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/export') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      return send(res, 200, { exportedAt: new Date().toISOString(), settings, orders: await listOrders() });
    }
    if (p === '/api/admin/orders.csv') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const orders = await listOrders();
      const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = [['Bestellung', 'Datum', 'Status', 'Zahlart', 'Rechnung', 'Name', 'E-Mail', 'Straße', 'PLZ', 'Ort', 'Positionen', 'Gutschein', 'Summe', 'Tracking'].join(';')];
      for (const o of orders) {
        rows.push([
          csvEsc(o.orderId), csvEsc(new Date(o.createdAt).toLocaleString('de-DE')), csvEsc(o.status || 'neu'),
          csvEsc(o.payment || ''), csvEsc(o.invoiceNo || ''), csvEsc(o.customer?.name || o.name || ''),
          csvEsc(o.customer?.email || o.email || ''), csvEsc(o.customer?.street || ''), csvEsc(o.customer?.zip || ''),
          csvEsc(o.customer?.city || ''),
          csvEsc((o.lines || []).map((l) => `${l.qty}x ${itemLabel(l)}`).join(' | ')),
          csvEsc(o.coupon ? o.coupon.code : ''),
          csvEsc((o.total ?? 0).toFixed(2).replace('.', ',')), csvEsc(o.trackingNo || ''),
        ].join(';'));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ovju-bestellungen.csv"' });
      return res.end('﻿' + rows.join('\n'));
    }
    if (req.method === 'POST' && p === '/api/admin/order-status') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const { orderId, status } = JSON.parse((await readBody(req)).toString('utf8'));
      if (!['neu', 'bezahlt', 'im-druck', 'versendet', 'storniert'].includes(status)) {
        return send(res, 400, { ok: false, error: 'Ungültiger Status' });
      }
      const order = await readOrder(orderId);
      order.status = status;
      if (status === 'bezahlt') order.paymentStatus = 'bezahlt';
      await writeOrder(order);
      return send(res, 200, { ok: true });
    }

    // --- Seiten & Dateien
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p === '/admin' || p === '/admin/') return send(res, 200, adminHTML(), 'text/html; charset=utf-8');

    if (p.startsWith('/orders/')) {
      const file = path.normalize(path.join(__dirname, p));
      if (!file.startsWith(ORDERS + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
        return send(res, 404, { ok: false, error: 'Nicht gefunden' });
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🥚 OVJU Shop läuft → http://0.0.0.0:${PORT}  (Admin: /admin)`);
});
