#!/usr/bin/env node
// formsam — Prüfung Lieferzeit je Farbe, Farben „auf Anfrage“ und Anfrageformular (POST /api/anfrage, Admin-Liste „Anfragen“).
//   node tools/test-anfrage.mjs   → Exit 0/1
//
// Teil 1 ohne Server: Regel in public/js/pricing.js (lieferzeitNorm, laengereLieferzeit, positionLieferzeit, bestellLieferzeit,
// anfrageFarbeVon) und die Mail-Vorlagen (Bestätigung mit order.lieferzeit bzw. allgemeiner Lieferzeit, Meldung „Anfrage“).
// Teil 2 mit eigener Shop-Instanz (DATA_DIR/ORDERS_DIR unter tmp-tests/test-anfrage/, freier Port, TRUST_PROXY=1 für die Gesamtbremse),
// Mails an einen Fake-SMTP in diesem Prozess, PayPal gegen eine Attrappe (node --import, ersetzt fetch für *.paypal.com — es geht nie
// eine Anfrage an PayPal). Firmendaten und Kundschaft sind erfunden.
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'tmp-tests', 'test-anfrage');
const DATA = path.join(DIR, 'data'), ORDERS = path.join(DIR, 'orders');
const PP_LOG = path.join(DIR, 'paypal-aufrufe.log'), STUB = path.join(DIR, 'paypal-attrappe.mjs');
const ADMIN = 'test-anfrage-admin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return true; }
  fail++; console.log(`❌ ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 700) : ''}`);
  return false;
}

const P = await import(path.join(ROOT, 'public/js/pricing.js'));
const T = await import(path.join(ROOT, 'lib/mail-templates.js'));
const { LEGAL_STAND } = await import(path.join(ROOT, 'lib/legal.js'));

// ---------------------------------------------------------------------------
// Teil 1: Regel ohne Server
// ---------------------------------------------------------------------------
console.log('\n— Lieferzeit-Regel (public/js/pricing.js)');
{
  const n = P.lieferzeitNorm;
  check(n('10-14') === '10–14 Werktage' && n('10 – 14 Werktage') === '10–14 Werktage' && n('10 bis 14 werktage') === '10–14 Werktage' && n('10—14 WT') === '10–14 Werktage',
    'Normalform „10–14 Werktage“ (Bindestrich, Gedankenstrich, „bis“, ohne/klein „Werktage“)');
  check(n('7') === '7 Werktage' && n('1 Werktag') === '1 Werktag' && n('3-3') === '3 Werktage' && n('120') === '120 Werktage' && n('  ') === '' && n(undefined) === '',
    'Einzelwert, Einzahl, gleiche Grenzen, 120, leer = allgemeine');
  check(['2 Wochen', '0', '0-3', '121', '14-10', 'bald', '5–8 Tage', '1-2-3', 'x'.repeat(60), '10 Werktage!'].every((v) => n(v) === null), 'Unsinn → null (Wochen, 0, > 120, umgedreht, Text, zu lang)');
  const L = P.laengereLieferzeit;
  check(L('5–8 Werktage', '10–14 Werktage') === '10–14 Werktage' && L('10–14 Werktage', '7 Werktage') === '10–14 Werktage' && L('8 Werktage', '5–8 Werktage') === '8 Werktage'
    && L('2–3 Wochen', '14 Werktage') === '2–3 Wochen' && L('ca. bald', '7 Werktage') === '7 Werktage', 'Vergleich nach Obergrenze (Werktage, Wochen × 5), dann Untergrenze; ohne Zahl zählt nur allein');
  const farben = [{ id: 'weiss', name: 'Weiß', active: true }, { id: 'gold', name: 'Gold', active: true, lieferzeit: '10–14 Werktage' },
    { id: 'kupfer', name: 'Kupfer', active: true, lieferzeit: '7 Werktage' }, { id: 'perl', name: 'Perlmutt', active: true, aufAnfrage: true },
    { id: 'alt', name: 'Alt', active: false, aufAnfrage: true }];
  const opts = { farbe: (it) => farben.find((f) => f.id === it.color) || null, schriftfarbe: (id) => farben.find((f) => f.id === id) || null, standard: '5–8 Werktage' };
  const it = (color, cfg = {}) => ({ product: 'vase', color, config: { text: '', textStyle: 'gepraegt', ...cfg } });
  check(P.positionLieferzeit(it('weiss'), opts) === '5–8 Werktage' && P.positionLieferzeit(it('unbekannt'), opts) === '5–8 Werktage', 'Farbe ohne eigene Lieferzeit (oder unbekannt) → allgemeine');
  check(P.positionLieferzeit(it('kupfer'), opts) === '7 Werktage', 'eigene kürzere Lieferzeit gilt');
  check(P.positionLieferzeit(it('weiss', { text: 'Anna', textStyle: 'farbe', textColor: 'gold' }), opts) === '10–14 Werktage', 'Farbschrift: die längere von Körper- und Schriftfarbe');
  check(P.positionLieferzeit(it('weiss', { text: 'Anna', textStyle: 'gepraegt', textColor: 'gold' }), opts) === '5–8 Werktage'
    && P.positionLieferzeit(it('weiss', { text: '  ', textStyle: 'farbe', textColor: 'gold' }), opts) === '5–8 Werktage', 'ohne Farbschrift (anderer Stil, leerer Text) zählt die Schriftfarbe nicht');
  const b = P.bestellLieferzeit([it('kupfer'), it('gold'), it('weiss')], opts);
  check(b.text === '10–14 Werktage' && b.abweichend && b.je.join('|') === '7 Werktage|10–14 Werktage|5–8 Werktage', 'Bestellung = längste Position, je Position genannt', b);
  check(P.bestellLieferzeit([it('weiss'), it('weiss')], opts).abweichend === false && P.bestellLieferzeit([], opts).text === '5–8 Werktage', 'gleiche Lieferzeiten: nicht abweichend; leer → allgemeine');
  const a1 = P.anfrageFarbeVon(it('perl'), opts), a2 = P.anfrageFarbeVon(it('weiss', { text: 'A', textStyle: 'farbe', textColor: 'perl' }), opts);
  check(a1?.farbe.id === 'perl' && a1.schrift === false && a2?.farbe.id === 'perl' && a2.schrift === true && P.anfrageFarbeVon(it('alt'), opts) === null && P.anfrageFarbeVon(it('gold'), opts) === null,
    'auf Anfrage: Körper- und Schriftfarbe erkannt; inaktive Farbe zählt nicht (eigene Sperre), normale nicht');
  check(/^Die Schriftfarbe „Perlmutt“ gibt es derzeit nur auf Anfrage/.test(P.anfrageMeldung(a2)), 'Meldung nennt Schriftfarbe', P.anfrageMeldung(a2));
  // Farbschrift nur, wenn sie gedruckt (und berechnet) wird: sichtbare Zeichen, Gravur beim Muster erlaubt — wie der Farbschrift-Aufpreis
  const unsichtbar = it('weiss', { text: '\u200b\u202e', textStyle: 'farbe', textColor: 'perl' });
  const zuTief = it('weiss', { text: 'Anna', textStyle: 'farbe', textColor: 'perl', pattern: 'lamellen', depth: 3 });
  check(!P.mitFarbschrift(unsichtbar) && !P.mitFarbschrift(zuTief) && P.mitFarbschrift(it('weiss', { text: 'Anna', textStyle: 'farbe', textColor: 'perl' }))
    && P.anfrageFarbeVon(unsichtbar, opts) === null && P.anfrageFarbeVon(zuTief, opts) === null
    && P.positionLieferzeit(it('weiss', { text: '\u200b', textStyle: 'farbe', textColor: 'gold' }), opts) === '5–8 Werktage',
  'Schriftfarbe zählt nur bei gedruckter Farbschrift (nur unsichtbare Zeichen oder Gravur gesperrt → weder Lieferzeit noch Sperre)');
  check(P.mitFarbschrift(it('weiss', { text: '\u00ad', textStyle: 'farbe', textColor: 'gold' })), 'weiches Trennzeichen zählt wie im Preis als sichtbarer Strich');
  const A = P.lieferzeitAllgemein;
  check(A(farben.filter((f) => f.id !== 'gold'), '5–8 Werktage') === '5–8 Werktage' && A(farben, '5–8 Werktage') === '5–8 Werktage, einzelne Farben länger'
    && A(farben, '5–8 Werktage', { kurz: true }) === '5–14 Werktage', 'allgemeine Angabe: mit längerer Farbe „…, einzelne Farben länger“ bzw. kurz die Spanne; kürzere (Kupfer 7) ändert nichts');
  check(A([{ id: 'g', active: true, aufAnfrage: true, lieferzeit: '20 Werktage' }, { id: 'h', active: false, lieferzeit: '30 Werktage' }], '5–8 Werktage') === '5–8 Werktage'
    && A(farben, 'nach Absprache') === 'nach Absprache', 'Farben auf Anfrage und inaktive zählen nicht; allgemeine ohne Zahl bleibt unverändert');
}

console.log('\n— Mail-Vorlagen');
{
  const SET = { company: { name: 'formsam', owner: 'Paula Probe', email: 'hallo@formsam.example', kleinunternehmer: true }, shop: { lieferzeit: '5–8 Werktage' }, pricing: { currency: 'EUR' } };
  const ORDER = (extra = {}) => ({ orderId: 'FS-261126-ABC123', accessKey: 'k', createdAt: '2026-11-26T09:00:00Z', status: 'neu', payment: 'vorkasse', paymentStatus: 'offen',
    customer: { name: 'Erika Beispiel', email: 'erika@example.invalid', street: 'Weg 1', zip: '12345', city: 'Stadt' },
    lines: [{ product: 'vase', qty: 1, unit: 24.9, off: 0, line: 24.9, colorName: 'Gold', config: { preset: 'flasche', pattern: 'glatt', height: 150 } }],
    subtotal: 24.9, shipping: 4.9, total: 29.8, invoiceNo: 'RE-2026-0001', ...extra });
  const neu = T.orderConfirmation({ order: ORDER({ lieferzeit: '10–14 Werktage' }), settings: SET, baseUrl: 'https://formsam.example' });
  const alt = T.orderConfirmation({ order: ORDER(), settings: SET, baseUrl: 'https://formsam.example' });
  check(neu.text.includes('Lieferzeit: 10–14 Werktage.') && alt.text.includes('Lieferzeit: 5–8 Werktage.'), 'Bestätigung: order.lieferzeit, ältere Bestellung ohne Feld → allgemeine');
  const m = T.adminAnfrage({ anfrage: { id: 'AF-261126-AB12', at: '2026-11-26T10:00:00Z', anlass: 'farbe', farbe: { id: 'perl', name: 'Perlmutt' }, name: 'Erika <b>Beispiel</b>', email: 'erika@example.invalid',
    nachricht: 'Zeile 1\nZeile <2>', benachrichtigen: true, code: 'K7P3QX' }, settings: SET, baseUrl: 'https://formsam.example' });
  check(m.subject === 'Farbe anfragen „Perlmutt“ · Erika <b>Beispiel</b>' && m.text.includes('Benachrichtigen: ja') && m.text.includes('Design: https://formsam.example/?d=K7P3QX')
    && m.html.includes('Zeile 1<br>Zeile &lt;2&gt;') && m.html.includes('Erika &lt;b&gt;Beispiel&lt;/b&gt;') && !m.html.includes('<b>Beispiel</b>') && m.html.includes('K7P-3QX'),
  'Meldung „Anfrage“: Betreff mit Farbe, Benachrichtigung, Design-Link, Nachricht maskiert mit Zeilenumbrüchen', m.subject);
  const ms = T.adminAnfrage({ anfrage: { id: 'AF-261126-AB13', at: '2026-11-26T10:00:00Z', anlass: 'farbe', farbe: { id: 'feuerrot', name: 'Feuerrot', schrift: true }, name: 'Erika', email: 'erika@example.invalid',
    nachricht: 'Hallo', benachrichtigen: false, code: null }, settings: SET, baseUrl: 'https://formsam.example' });
  check(ms.subject === 'Farbe anfragen Schriftfarbe „Feuerrot“ · Erika' && ms.text.includes('Schriftfarbe: Feuerrot (Farbschrift der Gravur)') && ms.html.includes('Schriftfarbe Feuerrot'),
    'Meldung zu einer Schriftfarbe: Betreff und Angaben nennen die Schriftfarbe', ms.subject);
}

// ---------------------------------------------------------------------------
// Teil 2: Shop-Instanz
// ---------------------------------------------------------------------------
function parseMime(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  const headers = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) { const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
  const parts = [];
  const b = (headers['content-type'] || '').match(/boundary="?([^";]+)"?/)?.[1];
  if (b) for (const seg of body.split(`--${b}`).slice(1)) { if (seg.startsWith('--')) break; parts.push(parseMime(seg.replace(/^\r\n/, ''))); }
  return { headers, body, parts };
}
const allParts = (m) => (m.parts.length ? m.parts.flatMap(allParts) : [m]);
const qp = (s) => Buffer.from(s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
const decodeWords = (v) => String(v || '').replace(/=\?UTF-8\?B\?([^?]*)\?=(\s+(?==\?))?/gi, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
function mail(raw) {
  const top = parseMime(raw);
  const ps = allParts(top);
  const t = ps.find((p) => /^text\/plain/.test(p.headers['content-type'] || '') && !p.headers['content-disposition']);
  const h = ps.find((p) => /^text\/html/.test(p.headers['content-type'] || '') && !p.headers['content-disposition']);
  return { headers: top.headers, subject: decodeWords(top.headers.subject), text: t ? qp(t.body) : '', html: h ? qp(h.body) : '' };
}
function listen(srv, port = 0) { return new Promise((r, j) => { srv.once('error', j); srv.listen(port, '127.0.0.1', () => r(srv.address().port)); }); }
async function freePort() { const s = net.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; }
async function fakeSmtp() {
  const got = [];
  const socks = new Set();
  const srv = net.createServer((sock) => {
    socks.add(sock); sock.on('close', () => socks.delete(sock)); sock.on('error', () => {});
    let buf = '', inData = false, lines = [], rcpts = [];
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; got.push({ rcpts, ...mail(Buffer.from(lines.join('\r\n'), 'latin1').toString('utf8')) }); lines = []; rcpts = []; sock.write('250 ok\r\n'); } else lines.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH/i.test(line)) sock.write('235 ok\r\n');
        else if (/^RCPT TO:/i.test(line)) { rcpts.push(line.slice(8).replace(/^\s*<|>\s*$/g, '')); sock.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 los\r\n'); }
        else if (/^QUIT/i.test(line)) sock.end('221 tschüss\r\n');
        else sock.write('250 ok\r\n');
      }
    });
    sock.write('220 fake ESMTP\r\n');
  });
  const port = await listen(srv);
  return { port, got, close: () => new Promise((r) => { srv.close(() => r()); for (const s of socks) s.destroy(); }) };
}
// PayPal-Attrappe (wie tools/test-paypal.mjs): fetch für *.paypal.com ersetzt, jeder Aufruf eine Zeile in PP_LOG
const ATTRAPPE = `import { appendFileSync } from 'node:fs';
const echt = globalThis.fetch, LOG = process.env.PP_LOG;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!/^https:\\/\\/[^/]*paypal\\.com\\//.test(u)) return echt(url, opts);
  appendFileSync(LOG, (opts.method || 'GET') + ' ' + u.replace(/^https:\\/\\/[^/]+/, '') + '\\n');
  if (/\\/v1\\/oauth2\\/token$/.test(u)) return json(200, { access_token: 'TOKEN', expires_in: 32400 });
  if (/\\/v2\\/checkout\\/orders$/.test(u)) return json(201, { id: 'PPTEST' + Math.random().toString(36).slice(2, 10).toUpperCase(), status: 'CREATED' });
  return json(404, {});
};
console.log('PAYPAL-ATTRAPPE AKTIV');
`;
const ppAufrufe = () => (existsSync(PP_LOG) ? readFileSync(PP_LOG, 'utf8').trim().split('\n').filter(Boolean) : []);

const VASE = { product: 'vase', preset: 'flasche', height: 150, width: 1, pattern: 'rippen', ribs: 48, depth: 0.9, twist: 0, flow: 'spirale', flowWaves: 3, text: '', textSize: 7,
  textPos: 0.55, textStyle: 'gepraegt', font: 'helvetiker', customPoints: null, saucer: false, colorFinish: 'matt', color: 'elfenbein' };
const KUNDE = { name: 'Erika Beispiel', email: 'kunde@formsam.example', street: 'Beispielweg 3', zip: '12345', city: 'Beispielstadt', note: '' };
/** kleinste gültige 3MF (ZIP mit Endsatz) — für Positionen mit Farbschrift (zwei Filamente) */
const mini3mf = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100), Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
function miniStl() {
  const b = Buffer.alloc(134); b.write('test-stl', 0, 'ascii'); b.writeUInt32LE(1, 80);
  [0, 0, 1, 0, 0, 0, 10, 0, 0, 0, 10, 0].forEach((v, i) => b.writeFloatLE(v, 84 + i * 4));
  return b;
}
const FIRMA = { name: 'formsam', owner: 'Paula Probe', street: 'Probeweg 7', zip: '54321', city: 'Probstadt', country: 'Deutschland', email: 'firma@formsam.example',
  phone: '+49 30 1234567', kleinunternehmer: false, ustId: 'DE123456789', iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFFXXX', bank: 'Probebank' };

let child = null, port = 0, smtp = null, logText = '';
async function start() {
  child = spawn(process.execPath, ['--import', STUB, path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, ORDERS_DIR: ORDERS, TRUST_PROXY: '1', PP_LOG } });
  child.stdout.on('data', (d) => { logText += d; });
  child.stderr.on('data', (d) => { logText += d; if (/TypeError|ReferenceError|SyntaxError/.test(d)) console.log('   [server]', String(d).trim().slice(0, 300)); });
  for (let i = 0; i < 100 && !/PAYPAL-ATTRAPPE AKTIV/.test(logText); i++) await sleep(50);
  if (!/PAYPAL-ATTRAPPE AKTIV/.test(logText)) throw new Error('PayPal-Attrappe nicht geladen – Abbruch vor der ersten Anfrage');
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/pricing`); if (r.ok) return; } catch { /* startet noch */ } await sleep(150); }
  throw new Error('Shop startet nicht');
}
async function stop() { if (child) { const c = child; child = null; c.kill('SIGTERM'); await new Promise((r) => c.once('exit', r)); } }
// jede Anfrage mit eigener (erfundener) Absenderadresse — TRUST_PROXY=1 wertet X-Forwarded-For aus (Bremse je IP)
let ipNr = 1;
const neueIp = () => `198.51.100.${(ipNr++ % 250) + 1}`;
async function req(method, p, body, headers = {}) {
  const h = { 'x-forwarded-for': headers['x-forwarded-for'] || '203.0.113.7', ...headers }; let data;
  if (Buffer.isBuffer(body)) { data = body; h['content-type'] = 'application/octet-stream'; } else if (typeof body === 'string') { data = body; h['content-type'] = 'application/json'; }
  else if (body !== undefined) { data = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: h, body: data, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: r.status, headers: Object.fromEntries(r.headers), text, json, setCookie: r.headers.getSetCookie?.() || [] };
}
const admin = (method, p, body, headers = {}) => req(method, p, body, { 'x-admin-key': ADMIN, ...headers });
const order = (id) => JSON.parse(readFileSync(path.join(ORDERS, id, 'order.json'), 'utf8'));
const liste = () => JSON.parse(readFileSync(path.join(DATA, 'anfragen.json'), 'utf8'));
const warte = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } return false; };
const item = (color, cfg = {}, extra = {}) => ({ product: 'vase', qty: 1, saucer: false, config: { ...VASE, color, ...cfg }, color, colorName: extra.colorName || color, code: null, ...extra });
/** Lieferzeit, wie die Kasse im Browser sie anzeigt (pricing.js mit /api/colors und /api/pricing) — expectedLieferzeit */
async function kassenLieferzeit(items) {
  const cols = (await req('GET', '/api/colors')).json || [], pr = (await req('GET', '/api/pricing')).json;
  const f = (id) => cols.find((c) => c.id === id) || null;
  return P.bestellLieferzeit(items, { farbe: (it) => f(it.color), schriftfarbe: f, standard: String(pr?.shop?.lieferzeit || '').trim() || '5–8 Werktage' }).text;
}
async function bestellung(items, kunde = {}) {
  const q = await req('POST', '/api/quote', { items });
  const co = await req('POST', '/api/checkout', { customer: { ...KUNDE, ...kunde }, items, payment: 'vorkasse', paypalOrderId: null, couponCode: null, beschaffenheit: true, mitSchluessel: true,
    expectedTotal: q.json?.total, expectedLieferzeit: await kassenLieferzeit(items) });
  if (!co.json?.ok) throw new Error(`Kasse: ${co.status} ${co.text.slice(0, 200)}`);
  const { orderId, accessKey, itemCount } = co.json;
  for (let i = 0; i < itemCount; i++) {
    const farbschrift = String(items[i].config.text || '').trim() && items[i].config.textStyle === 'farbe';
    await req('PUT', `/api/order/${orderId}/stl/${i}`, farbschrift ? mini3mf() : miniStl(), { 'x-order-key': accessKey });
  }
  const complete = await req('POST', `/api/order/${orderId}/complete`, {}, { 'x-order-key': accessKey });
  if (complete.status !== 200) throw new Error(`Abschluss: ${complete.status} ${complete.text.slice(0, 200)}`);
  return { orderId, accessKey, complete };
}
async function farbenSpeichern(fn) {
  const d = await admin('GET', '/api/admin/data');
  const st = d.json.settings;
  return admin('POST', '/api/admin/settings', { baseRev: st.rev, colors: fn(structuredClone(st.colors)) });
}
const anfrage = (body, ip = neueIp()) => req('POST', '/api/anfrage', { anlass: 'farbe', farbe: 'perlmutt', name: 'Erika Beispiel', email: 'erika@example.invalid', nachricht: 'Hallo!', website: '', ...body }, { 'x-forwarded-for': ip });
/** Datum + n Werktage (Mo–Fr) → „Monat Jahr“ — wie lieferMonat() im Server */
function monatNach(iso, werktage) {
  const d = new Date(iso);
  for (let k = werktage; k > 0;) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) k--; }
  return d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' });
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true }); mkdirSync(ORDERS, { recursive: true });
  writeFileSync(STUB, ATTRAPPE); writeFileSync(PP_LOG, '');
  smtp = await fakeSmtp();
  port = await freePort();
  // Anfragen von früher: eine 13 Monate alte (wird beim Start gelöscht) und eine von gestern (bleibt)
  const vor13 = new Date(); vor13.setUTCMonth(vor13.getUTCMonth() - 13);
  writeFileSync(path.join(DATA, 'anfragen.json'), JSON.stringify([
    { id: 'AF-250101-AAAA', at: vor13.toISOString(), anlass: 'angebot', farbe: null, name: 'Alt Anfrage', email: 'alt@example.invalid', nachricht: 'alt', benachrichtigen: false, code: null, status: 'erledigt', erledigtAt: null },
    { id: 'AF-261125-BBBB', at: new Date(Date.now() - 864e5).toISOString(), anlass: 'angebot', farbe: null, name: 'Gestern Anfrage', email: 'gestern@example.invalid', nachricht: 'gestern', benachrichtigen: false, code: null, status: 'offen', erledigtAt: null },
  ]));
  writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
    adminKey: ADMIN, wartung: { aktiv: false }, company: FIRMA, shop: { lieferzeit: '5–8 Werktage', liefergebiet: 'Deutschland' },
    legal: { hoster: 'Probe-Hosting GmbH, Serverweg 1, 10115 Berlin', serverOrt: 'Berlin (Deutschland)', avVertrag: true, mailVersand: 'eigen' },
    paypal: { enabled: true, sandbox: true, clientId: 'ATTRAPPE-CLIENT', secret: 'ATTRAPPE-SECRET' },
    mail: { enabled: true, host: '127.0.0.1', port: smtp.port, secure: 'none', user: 'shop', pass: 'pw', from: 'shop@formsam.example', fromName: 'formsam',
      replyTo: 'hallo@formsam.example', adminTo: 'admin@formsam.example', adminCopy: false, autoStatusMails: false, publicUrl: `http://127.0.0.1:${port}` },
  }, null, 2));
  await start();

  console.log('\n— Aufbewahrung');
  await warte(() => /Anfrage\(n\) älter als 12 Monate gelöscht/.test(logText), 15000);
  check(!liste().some((a) => a.id === 'AF-250101-AAAA') && liste().some((a) => a.id === 'AF-261125-BBBB') && /Anfrage\(n\) älter als 12 Monate gelöscht/.test(logText),
    'beim Start: Anfrage älter als 12 Monate gelöscht, jüngere bleibt', liste().map((a) => a.id).slice(0, 3));

  console.log('\n— Bestand ohne neue Felder');
  let cols = (await req('GET', '/api/colors')).json;
  check(Array.isArray(cols) && cols.length > 5 && cols.every((c) => c.lieferzeit === '' && c.aufAnfrage === false), '/api/colors: Farben ohne Felder → allgemeine Lieferzeit, bestellbar', cols?.[0]);
  const pr = (await req('GET', '/api/pricing')).json;
  check(pr?.kontakt?.email === 'hallo@formsam.example', '/api/pricing → kontakt.email = Antwortadresse (Reply-To)', pr?.kontakt);

  console.log('\n— Einstellungen: Lieferzeit und „auf Anfrage“ je Farbe');
  for (const [wert, wie] of [['2 Wochen', 'Wochen'], ['0', '0'], ['121', '> 120'], ['14-10', 'umgedreht'], ['bald', 'Text']]) {
    const r = await farbenSpeichern((c) => c.map((f) => (f.id === 'gold' ? { ...f, lieferzeit: wert } : f)));
    check(r.status === 400 && /^Farbe „Gold“: Lieferzeit bitte in Werktagen angeben/.test(r.json?.error || ''), `Lieferzeit „${wert}“ (${wie}) → 400 mit deutscher Meldung`, r.json);
  }
  let r = await farbenSpeichern((c) => c.map((f) => (f.id === 'gold' ? { ...f, aufAnfrage: 'ja' } : f)));
  check(r.status === 400 && /„auf Anfrage“ muss ja oder nein sein/.test(r.json?.error || ''), '„auf Anfrage“ kein Wahrheitswert → 400', r.json);
  cols = (await req('GET', '/api/colors')).json;
  check(cols.every((c) => c.lieferzeit === '' && !c.aufAnfrage), 'abgelehnte Speicherungen ändern nichts');
  r = await farbenSpeichern((c) => c.map((f) => (f.id === 'gold' ? { ...f, lieferzeit: '10-14' } : f.id === 'kupfer' ? { ...f, lieferzeit: '7' } : f.id === 'silber' ? { ...f, lieferzeit: '120 werktage' }
    : f.id === 'perlmutt' ? { ...f, aufAnfrage: true } : f.id === 'lavendel' ? { ...f, active: false } : f)));
  check(r.status === 200 && r.json?.ok, 'Speichern: Gold 10-14, Kupfer 7, Silber 120, Perlmutt auf Anfrage, Lavendel aus dem Shop', r.json);
  cols = (await req('GET', '/api/colors')).json;
  const c = (id) => cols.find((x) => x.id === id);
  check(c('gold')?.lieferzeit === '10–14 Werktage' && c('kupfer')?.lieferzeit === '7 Werktage' && c('silber')?.lieferzeit === '120 Werktage' && c('perlmutt')?.aufAnfrage === true
    && c('elfenbein')?.lieferzeit === '' && !c('lavendel'), '/api/colors: Normalform, aufAnfrage, inaktive Farbe fehlt wie bisher', [c('gold'), c('perlmutt')]);
  // Admin-Tab von vor dem Update (kennt die Felder nicht): ändert den Namen, Lieferzeit und Anfrage bleiben
  r = await farbenSpeichern((c2) => c2.map(({ lieferzeit, aufAnfrage, ...f }) => (f.id === 'gold' ? { ...f, name: 'Gold' } : f)));
  cols = (await req('GET', '/api/colors')).json;
  check(r.status === 200 && c('gold')?.lieferzeit === '10–14 Werktage' && c('perlmutt')?.aufAnfrage === true, 'älterer Admin-Tab ohne die Felder: gespeicherte Werte bleiben', r.json);
  check((await req('POST', '/api/admin/settings', { colors: [] })).status === 401, 'Einstellungen nur mit Admin-Passwort');

  console.log('\n— Lieferzeit der Bestellung (längste Position, Farbschrift, Standard)');
  const b1 = await bestellung([item('gold', {}, { colorName: 'Gold (metallic)' }), item('elfenbein')]);
  check(order(b1.orderId).lieferzeit === '10–14 Werktage' && b1.complete.json?.lieferzeit === '10–14 Werktage', 'Gold + Elfenbein → 10–14 Werktage (order.lieferzeit, Antwort von /complete)', order(b1.orderId).lieferzeit);
  const b2 = await bestellung([item('elfenbein', { text: 'Anna', textStyle: 'farbe', textColor: 'silber' })]);
  check(order(b2.orderId).lieferzeit === '120 Werktage', 'Farbschrift in Silber (120 Werktage) auf Elfenbein → 120 Werktage', order(b2.orderId).lieferzeit);
  const b3 = await bestellung([item('elfenbein'), item('salbei')]);
  check(order(b3.orderId).lieferzeit === '5–8 Werktage', 'Farben ohne eigene Lieferzeit → allgemeine', order(b3.orderId).lieferzeit);
  const b4 = await bestellung([item('kupfer')]);
  check(order(b4.orderId).lieferzeit === '7 Werktage', 'nur Kupfer (7 Werktage) → kürzere eigene Lieferzeit', order(b4.orderId).lieferzeit);
  const b5 = await bestellung([item('elfenbein', { text: '\u200b', textStyle: 'farbe', textColor: 'silber' })]);
  check(order(b5.orderId).lieferzeit === '5–8 Werktage', 'Schriftfarbe Silber ohne sichtbaren Gravurtext (keine Farbschrift, kein Aufpreis) → allgemeine Lieferzeit', order(b5.orderId).lieferzeit);
  // Kasse zeigt eine kürzere Lieferzeit als die Bestellung hätte (Farbe inzwischen geändert bzw. Kassen-Tab von vor dem Update) → 409
  {
    const items = [item('gold'), item('elfenbein')];
    const q2 = await req('POST', '/api/quote', { items });
    const ordner = () => readdirSync(ORDERS).length, n0 = ordner();
    const kasse = (extra) => req('POST', '/api/checkout', { customer: KUNDE, items, payment: 'vorkasse', beschaffenheit: true, mitSchluessel: true, expectedTotal: q2.json?.total, ...extra }, { 'x-forwarded-for': neueIp() });
    let k = await kasse({ expectedLieferzeit: '5–8 Werktage' });
    check(k.status === 409 && k.json?.code === 'lieferzeit' && k.json?.lieferzeit === '10–14 Werktage' && /jetzt 10–14 Werktage\. Bitte prüf die Kasse/.test(k.json?.error || '') && ordner() === n0,
      'Kasse zeigte 5–8, Bestellung hätte 10–14 → 409 „lieferzeit“ mit neuer Lieferzeit, keine Bestellung', k.json);
    k = await kasse({});
    check(k.status === 409 && k.json?.code === 'lieferzeit' && /bitte lade die Seite neu/.test(k.json?.error || '') && ordner() === n0, 'Kassen-Tab ohne expectedLieferzeit (zeigt die allgemeine) → 409 mit Bitte ums Neuladen', k.json);
    k = await req('POST', '/api/paypal/create', { customer: KUNDE, items, payment: 'paypal', beschaffenheit: true, mitSchluessel: true, expectedTotal: q2.json?.total, expectedLieferzeit: '7 Werktage' }, { 'x-forwarded-for': neueIp() });
    check(k.status === 409 && k.json?.code === 'lieferzeit', '/api/paypal/create prüft die Lieferzeit ebenso (vor der Zahlung)', k.json);
    k = await kasse({ expectedLieferzeit: '20–25 Werktage' });
    check(k.status === 200 && k.json?.ok, 'Kasse zeigte eine längere Lieferzeit (Farbe inzwischen schneller) → Bestellung mit der kürzeren', k.json);
    if (k.json?.orderId) check(order(k.json.orderId).lieferzeit === '10–14 Werktage', '… order.lieferzeit = die des Servers', order(k.json.orderId).lieferzeit);
    k = await req('POST', '/api/checkout', { customer: KUNDE, items: [item('elfenbein')], payment: 'vorkasse', beschaffenheit: true, mitSchluessel: true, expectedTotal: (await req('POST', '/api/quote', { items: [item('elfenbein')] })).json?.total }, { 'x-forwarded-for': neueIp() });
    check(k.status === 200, 'Kassen-Tab ohne Feld mit Farbe ohne eigene Lieferzeit → wie bisher 200', k.json);
  }
  await warte(() => smtp.got.some((m) => m.subject.includes(b4.orderId)));
  const bestaetigung = (id) => smtp.got.find((m) => m.subject.includes(id) && m.rcpts.includes(KUNDE.email));
  check(bestaetigung(b1.orderId)?.text.includes('Lieferzeit: 10–14 Werktage.') && bestaetigung(b2.orderId)?.text.includes('Lieferzeit: 120 Werktage.') && bestaetigung(b3.orderId)?.text.includes('Lieferzeit: 5–8 Werktage.'),
    'Bestellbestätigung nennt die Lieferzeit der Bestellung', bestaetigung(b1.orderId)?.text.match(/Lieferzeit:.*$/m)?.[0]);
  const rech = (id) => readFileSync(path.join(ORDERS, id, 'rechnung.html'), 'utf8');
  check(rech(b1.orderId).includes('Lieferzeit:&nbsp;10–14&nbsp;Werktage') && rech(b2.orderId).includes('Lieferzeit:&nbsp;120&nbsp;Werktage'), 'Rechnung nennt die Lieferzeit der Bestellung');
  const at2 = order(b2.orderId).invoiceAt || order(b2.orderId).completedAt;
  check(rech(b2.orderId).includes(`voraussichtlich ${monatNach(at2, 120)}`) && monatNach(at2, 120) !== monatNach(at2, 8), 'Leistungszeitpunkt (Regelbesteuerung) aus der längsten Lieferzeit (120 Werktage)', rech(b2.orderId).match(/voraussichtlich [^<]*/)?.[0]);
  // spätere Änderung der Farbe ändert nichts an der Bestellung; „Erneut senden“ nimmt order.lieferzeit
  await farbenSpeichern((c2) => c2.map((f) => (f.id === 'gold' ? { ...f, lieferzeit: '' } : f)));
  const log = (await admin('GET', '/api/admin/mail-log')).json?.entries || [];
  const e1 = log.find((x) => x.orderId === b1.orderId && x.kind === 'bestaetigung');
  const vorher = smtp.got.length;
  r = await admin('POST', '/api/admin/mail-resend', { id: e1?.id });
  await warte(() => smtp.got.length > vorher);
  const erneut = smtp.got.slice(vorher).find((m) => m.subject.includes(b1.orderId));
  check(r.json?.ok && erneut?.text.includes('Lieferzeit: 10–14 Werktage.') && order(b1.orderId).lieferzeit === '10–14 Werktage', '„Erneut senden“ nach Änderung der Farbe: Lieferzeit der Bestellung', [r.json, erneut?.text.match(/Lieferzeit:.*$/m)?.[0]]);
  await farbenSpeichern((c2) => c2.map((f) => (f.id === 'gold' ? { ...f, lieferzeit: '10–14 Werktage' } : f)));

  console.log('\n— Farbe „auf Anfrage“: Server lehnt ab');
  const perl = item('perlmutt', {}, { colorName: 'Perlmutt (metallic)' });
  r = await req('POST', '/api/quote', { items: [perl] });
  check(r.status === 400 && /^Die Farbe „Perlmutt“ gibt es derzeit nur auf Anfrage/.test(r.json?.error || ''), '/api/quote → 400 (Körperfarbe)', r.json);
  r = await req('POST', '/api/quote', { items: [item('elfenbein', { text: 'Anna', textStyle: 'farbe', textColor: 'perlmutt' })] });
  check(r.status === 400 && /^Die Schriftfarbe „Perlmutt“ gibt es derzeit nur auf Anfrage/.test(r.json?.error || ''), '/api/quote → 400 (Schriftfarbe einer Farbschrift)', r.json);
  r = await req('POST', '/api/quote', { items: [item('elfenbein', { text: 'Anna', textStyle: 'gepraegt', textColor: 'perlmutt' })] });
  check(r.status === 200, 'Schriftfarbe ohne Farbschrift (geprägt) zählt nicht', r.json);
  r = await req('POST', '/api/quote', { items: [item('elfenbein', { text: '\u200b\u202e', textStyle: 'farbe', textColor: 'perlmutt' }), item('elfenbein', { text: 'Anna', textStyle: 'farbe', textColor: 'lavendel', pattern: 'lamellen', depth: 3 })] });
  check(r.status === 200 && r.json?.lines?.every((l) => !l.parts?.farbschrift), 'Schriftfarbe ohne gedruckte Farbschrift (nur unsichtbare Zeichen, Gravur beim Muster gesperrt) sperrt nicht – wie der Preis', r.json?.error || r.json?.lines?.map((l) => l.parts));
  r = await req('POST', '/api/quote', { items: [{ ...perl, color: undefined, colorName: 'Perlmutt · metallic' }] });
  check(r.status === 400 && /nur auf Anfrage/.test(r.json?.error || ''), 'ältere Zeile nur mit Farbnamen → ebenfalls 400', r.json);
  r = await req('POST', '/api/checkout', { customer: KUNDE, items: [item('elfenbein'), perl], payment: 'vorkasse', beschaffenheit: true, mitSchluessel: true, expectedTotal: 59.8 });
  check(r.status === 400 && /nur auf Anfrage/.test(r.json?.error || ''), '/api/checkout → 400, keine Bestellung', r.json);
  r = await req('POST', '/api/quote', { items: [item('lavendel')] });
  check(r.status === 400 && /derzeit nicht verfügbar/.test(r.json?.error || ''), 'inaktive Farbe wie bisher („nicht verfügbar“)', r.json);
  const q = await req('POST', '/api/quote', { items: [item('elfenbein')] });
  r = await req('POST', '/api/paypal/create', { customer: KUNDE, items: [item('elfenbein')], payment: 'paypal', beschaffenheit: true, mitSchluessel: true, expectedTotal: q.json?.total });
  const ppVorher = ppAufrufe().length;
  check(r.status === 200 && /^PPTEST/.test(r.json?.id || '') && ppVorher >= 2, 'Kontrolle: /api/paypal/create mit bestellbarer Farbe geht an die Attrappe', [r.status, ppAufrufe()]);
  r = await req('POST', '/api/paypal/create', { customer: KUNDE, items: [perl], payment: 'paypal', beschaffenheit: true, mitSchluessel: true, expectedTotal: q.json?.total });
  check(r.status === 400 && /nur auf Anfrage/.test(r.json?.error || '') && ppAufrufe().length === ppVorher, '/api/paypal/create → 400 vor jedem PayPal-Aufruf', [r.json, ppAufrufe().slice(ppVorher)]);

  console.log('\n— Anfrageformular POST /api/anfrage');
  smtp.got.length = 0;
  const design = await req('POST', '/api/design', { config: { ...VASE, color: 'perlmutt' } });
  r = await anfrage({ benachrichtigen: true, nachricht: 'Hallo,\r\nich hätte gern Perlmutt.', code: design.json?.code, name: '  Erika   Beispiel ' });
  check(r.status === 200 && r.json?.ok && /^AF-\d{6}-[A-F0-9]{4}$/.test(r.json?.id || '') && r.json?.antwortVon === 'hallo@formsam.example', 'gültige Farbanfrage → 200 mit Kennung und Antwortadresse', r.json);
  check(r.headers['x-content-type-options'] === 'nosniff' && r.headers['cache-control'] === 'no-store' && /frame-ancestors/.test(r.headers['content-security-policy'] || ''), 'Schutz-Kopfzeilen und no-store', r.headers);
  await warte(() => smtp.got.length >= 1);
  await sleep(400);
  const m1 = smtp.got[0];
  check(smtp.got.length === 1 && m1?.rcpts.join() === 'admin@formsam.example', 'genau eine Mail – an die Admin-Adresse, keine an die Kundin', smtp.got.map((m) => m.rcpts));
  check(m1?.headers['reply-to'] === 'erika@example.invalid' && m1?.headers['auto-submitted'] === 'auto-generated' && m1.subject === 'Farbe anfragen „Perlmutt“ · Erika Beispiel',
    'Reply-To = Kundin, Auto-Submitted, Betreff mit Farbe', [m1?.headers['reply-to'], m1?.headers['auto-submitted'], m1?.subject]);
  check(m1?.text.includes('ich hätte gern Perlmutt.') && m1.text.includes('Benachrichtigen: ja') && m1.text.includes(`/?d=${design.json?.code}`), 'Mail: Nachricht, Benachrichtigung, Design-Link', m1?.text.slice(0, 400));
  const e = liste().find((x) => x.id === r.json?.id);
  check(e && e.name === 'Erika Beispiel' && e.email === 'erika@example.invalid' && e.farbe?.name === 'Perlmutt' && e.benachrichtigen === true && e.code === design.json?.code && e.status === 'offen'
    && e.nachricht === 'Hallo,\nich hätte gern Perlmutt.', 'gespeichert in data/anfragen.json (Name zusammengefasst, Zeilenumbruch normalisiert)', e);
  r = await anfrage({ anlass: 'angebot', farbe: undefined, benachrichtigen: true, code: 'GIBTESNICHT' });
  const e2 = liste().find((x) => x.id === r.json?.id);
  check(r.status === 200 && e2?.anlass === 'angebot' && e2.farbe === null && e2.benachrichtigen === false && e2.code === null, 'Angebot ohne Farbe: Benachrichtigung nur bei Farben, unbekannter Code entfällt', e2);
  await warte(() => smtp.got.length >= 2);
  await sleep(300);
  const anzahl = liste().length, mails = smtp.got.length;
  r = await anfrage({ website: 'https://spam.example' });
  await sleep(600);
  check(r.status === 200 && r.json?.ok && !r.json?.id && liste().length === anzahl && smtp.got.length === mails, 'Fallen-Feld gefüllt → stille 200, keine Mail, kein Eintrag', { j: r.json, n: [liste().length, anzahl], m: [smtp.got.length, mails], s: smtp.got.map((x) => x.subject) });
  for (const [body, re, was] of [
    [{ name: 'E' }, /Namen/, 'Name 1 Zeichen'], [{ name: 'x'.repeat(81) }, /Namen/, 'Name 81 Zeichen'], [{ name: 'Erika <b>' }, /Namen/, 'Name mit <'],
    [{ email: 'keine-adresse' }, /gültige E-Mail/, 'E-Mail ungültig'], [{ email: 'jürgen@example.invalid' }, /Umlaute/, 'Umlaut vor dem @'],
    [{ nachricht: '   ' }, /was du dir wünschst/, 'Nachricht leer'], [{ nachricht: 'x'.repeat(3001) }, /zu lang/, 'Nachricht 3001 Zeichen'],
    [{ anlass: 'spam' }, /Anlass/, 'Anlass unbekannt'], [{ farbe: 'gibtesnicht' }, /Farbe gibt es/, 'Farbe unbekannt'], [{ farbe: 'lavendel' }, /Farbe gibt es/, 'Farbe aus dem Shop genommen'],
    [{ farbe: undefined }, /Welche Farbe/, 'Farbanfrage ohne Farbe'],
  ]) {
    r = await anfrage(body);
    check(r.status === 400 && re.test(r.json?.error || ''), `${was} → 400`, r.json);
  }
  r = await anfrage({ nachricht: 'y'.repeat(3000), name: 'x'.repeat(80) });
  check(r.status === 200, 'Grenzen: Name 80, Nachricht 3000 Zeichen → 200', r.json);
  for (const [body, re, was] of [
    [{ name: '\u200b\u200b\u200b' }, /Namen/, 'Name nur aus unsichtbaren Zeichen'], [{ nachricht: '\u200b\u2060\u200b' }, /was du dir wünschst/, 'Nachricht nur aus unsichtbaren Zeichen'],
    [{ nachricht: '😀'.repeat(3001) }, /zu lang/, 'Nachricht 3001 Emoji (vorher still gekürzt)'],
  ]) {
    r = await anfrage(body);
    check(r.status === 400 && re.test(r.json?.error || ''), `${was} → 400`, r.json);
  }
  r = await anfrage({ name: 'Eri\u202eka\u0085 Bei\u200bspiel', nachricht: 'Zeile\u2028zwei\u202e', farbe: 'feuerrot', schrift: true });
  const e3 = liste().find((x) => x.id === r.json?.id);
  check(r.status === 200 && e3?.name === 'Erika Beispiel' && e3?.nachricht === 'Zeile\nzwei' && e3?.farbe?.schrift === true && e3?.farbe?.name === 'Feuerrot',
    'Name/Nachricht ohne Steuer-, Bidi- und Null-Breiten-Zeichen; Schriftfarbe vermerkt', e3);
  r = await anfrage({ anlass: 'angebot', farbe: undefined, schrift: true });
  check(r.status === 200 && liste().find((x) => x.id === r.json?.id)?.farbe === null, 'schrift ohne Farbanfrage wird ignoriert');
  await warte(() => smtp.got.some((m) => m.subject === 'Farbe anfragen Schriftfarbe „Feuerrot“ · Erika Beispiel'));
  check(smtp.got.some((m) => m.subject === 'Farbe anfragen Schriftfarbe „Feuerrot“ · Erika Beispiel' && m.text.includes('Schriftfarbe: Feuerrot')), 'Meldung an den Shop nennt die Schriftfarbe', smtp.got.map((m) => m.subject).slice(-3));
  r = await req('POST', '/api/anfrage', '{kaputt', { 'x-forwarded-for': neueIp() });
  check(r.status === 400 && r.json?.error === 'Ungültige Anfrage', 'kaputtes JSON → 400', r.json);
  r = await req('POST', '/api/anfrage', JSON.stringify({ anlass: 'angebot', name: 'Erika', email: 'e@example.invalid', nachricht: 'x'.repeat(17000) }), { 'x-forwarded-for': neueIp() });
  check(r.status === 413, 'Body über 16 KB → 413', r.status);
  r = await req('GET', '/api/anfrage');
  check(r.status === 404 || r.status === 405, 'GET /api/anfrage → keine Seite', r.status);

  console.log('\n— Bremsen');
  const ip = '192.0.2.50';
  const st = [];
  for (let i = 0; i < 6; i++) st.push((await anfrage({ anlass: 'angebot', farbe: undefined, nachricht: `Nr. ${i}` }, ip)).status);
  r = await anfrage({ anlass: 'angebot', farbe: undefined }, ip);
  check(st.slice(0, 5).every((s) => s === 200) && st[5] === 429 && r.status === 429 && /hallo@formsam\.example/.test(r.json?.error || '') && r.headers['retry-after'] === '3600',
    '5 Anfragen je IP und Stunde, die 6. → 429 mit Hinweis auf die Adresse', [st, r.json]);
  r = await anfrage({ name: 'E' }, '192.0.2.51');
  check(r.status === 400, 'ungültige Anfragen zählen nicht gegen die Bremse (nur gültige)');
  const st48 = [];
  for (let i = 1; i <= 11; i++) st48.push((await anfrage({ anlass: 'angebot', farbe: undefined, nachricht: `/48 Nr. ${i}` }, `2001:db8:77:${i.toString(16)}::1`)).status);
  r = await anfrage({ anlass: 'angebot', farbe: undefined }, '2001:db8:78:1::1');
  check(st48.slice(0, 10).every((x) => x === 200) && st48[10] === 429 && r.status === 200, 'IPv6: höchstens 10 je /48 und Stunde (aus verschiedenen /64), anderes /48 weiter frei', st48);
  const zaehl = liste().filter((a) => Date.now() - Date.parse(a.at) < 3600e3).length;
  let gesamt = [];
  for (let i = 0; i < 60 - zaehl + 2; i++) gesamt.push((await anfrage({ anlass: 'angebot', farbe: undefined, nachricht: `Flut ${i}` })).status);
  const ersteSperre = gesamt.indexOf(429);
  check(ersteSperre >= 0 && gesamt.slice(ersteSperre).every((s) => s === 429) && liste().filter((a) => Date.now() - Date.parse(a.at) < 3600e3).length === 50,
    'insgesamt höchstens 50 Anfragen je Stunde (aus verschiedenen Netzen), danach 429', { zaehl, ersteSperre, n: liste().length });

  console.log('\n— Admin-Liste „Anfragen“');
  r = await req('GET', '/api/admin/anfragen');
  check(r.status === 401, 'ohne Anmeldung → 401', r.status);
  check((await req('POST', '/api/admin/anfrage-status', { id: e?.id, status: 'erledigt' })).status === 401 && (await req('POST', '/api/admin/anfrage-loeschen', { id: e?.id })).status === 401,
    'Status/Löschen ohne Anmeldung → 401');
  r = await admin('GET', '/api/admin/anfragen');
  const al = r.json?.anfragen || [];
  check(r.status === 200 && al.length === liste().length && al.every((a, i) => i === 0 || String(al[i - 1].at) >= String(a.at)), 'mit Anmeldung: alle Einträge, neueste oben', al.length);
  r = await admin('POST', '/api/admin/anfrage-status', { id: e.id, status: 'erledigt' });
  check(r.status === 200 && liste().find((x) => x.id === e.id)?.status === 'erledigt' && !!liste().find((x) => x.id === e.id)?.erledigtAt, '„erledigt“ markieren', r.json);
  check((await admin('POST', '/api/admin/anfrage-status', { id: e.id, status: 'weg' })).status === 400 && (await admin('POST', '/api/admin/anfrage-status', { id: 'AF-000000-0000', status: 'offen' })).status === 404
    && (await admin('POST', '/api/admin/anfrage-loeschen', { id: '../x' })).status === 400, 'ungültiger Status 400, unbekannte Kennung 404, kaputte Kennung 400');
  const d = await admin('GET', '/api/admin/data');
  check(d.json?.anfragenOffen === liste().filter((a) => a.status !== 'erledigt').length, 'Übersicht: Zahl offener Anfragen', d.json?.anfragenOffen);
  // „Erneut“ im Versandprotokoll baut die Meldung aus der gespeicherten Anfrage neu
  await warte(async () => ((await admin('GET', '/api/admin/mail-log')).json?.entries || []).some((x) => x.kind === 'admin-anfrage' && x.status === 'gesendet' && x.ref === e.id));
  const ea = ((await admin('GET', '/api/admin/mail-log')).json?.entries || []).find((x) => x.kind === 'admin-anfrage' && x.ref === e.id);
  const v2 = smtp.got.length;
  r = await admin('POST', '/api/admin/mail-resend', { id: ea?.id });
  await warte(() => smtp.got.length > v2);
  check(r.json?.ok && smtp.got.slice(v2).some((m) => m.subject === 'Farbe anfragen „Perlmutt“ · Erika Beispiel' && m.headers['reply-to'] === 'erika@example.invalid'), '„Erneut“ im Versandprotokoll', r.json);
  r = await admin('POST', '/api/admin/anfrage-loeschen', { id: e.id });
  check(r.status === 200 && !liste().some((x) => x.id === e.id), 'löschen', r.json);
  // höchstens 1000 Einträge: die ältesten fallen weg
  await stop();
  const viele = Array.from({ length: 1000 }, (_, i) => ({ id: `AF-261126-${(i + 0x1000).toString(16).toUpperCase().slice(-4)}`, at: new Date(Date.now() - (1000 - i) * 60e3).toISOString(), anlass: 'angebot', farbe: null, name: `N ${i}`, email: 'n@example.invalid', nachricht: 'n', benachrichtigen: false, code: null, status: 'offen', erledigtAt: null }));
  writeFileSync(path.join(DATA, 'anfragen.json'), JSON.stringify(viele));
  await start();
  r = await anfrage({ anlass: 'angebot', farbe: undefined, nachricht: 'Nr. 1001' });
  check(r.status === 200 && liste().length === 1000 && liste()[0].id === viele[1].id && liste().at(-1).id === r.json?.id, 'höchstens 1000 Einträge – der älteste fällt weg', liste().length);

  console.log('\n— Rechtstexte, FAQ, Startseite');
  const ds = (await req('GET', '/datenschutz')).text;
  const anfrageAbschnitt = ds.match(/<section id="anfrage"[\s\S]*?<\/section>/)?.[0] || '';
  check(anfrageAbschnitt && /Art\.(&nbsp;| )6 Abs\.(&nbsp;| )1 lit\.(&nbsp;| )b DSGVO/.test(anfrageAbschnitt) && /lit\.(&nbsp;| )f DSGVO/.test(anfrageAbschnitt) && anfrageAbschnitt.includes('12 Monaten')
    && anfrageAbschnitt.includes('eigenen Mailserver') && anfrageAbschnitt.includes('keine automatische Mail') && anfrageAbschnitt.includes('unsichtbares Feld'), 'Datenschutz: Abschnitt „Anfrageformular“ (Daten, Zweck, lit. b/f, eigener Mailserver, 12 Monate)', anfrageAbschnitt.slice(0, 200));
  check(ds.includes('dem Anfrageformular und der Widerrufsfunktion zählt der Server') && ds.includes('<dt>Anfragen (Farbe anfragen, individuelles Angebot)</dt>') && ds.includes('jeder Anfrage über das Anfrageformular'),
    'Datenschutz: Bremse, Speicherdauer und Benachrichtigung nennen die Anfragen');
  const agb = (await req('GET', '/agb')).text;
  check(/Die Lieferzeit beträgt 5–8 Werktage\. Ist bei der gewählten Farbe eine andere Lieferzeit angegeben, gilt diese/.test(agb) && agb.includes('gilt für die ganze Bestellung die längste Lieferzeit ihrer Positionen'),
    'AGB § 7: Lieferzeit der Farbe, sonst allgemeine, bei mehreren die längste');
  check(agb.includes('Bei Vorkasse beginnt die Frist am Tag nach deinem Überweisungsauftrag an deine Bank'), 'AGB § 7: Fristbeginn weiter aus lib/lieferfrist.js');
  const vs = (await req('GET', '/versand')).text;
  check(vs.includes('<li>Gold: 10–14 Werktage</li>') && vs.includes('<li>Kupfer: 7 Werktage</li>') && vs.includes('<li>Silber: 120 Werktage</li>') && !vs.includes('<li>Elfenbein:')
    && /Nur auf Anfrage und deshalb nicht direkt bestellbar: Perlmutt\./.test(vs) && !vs.includes('Lavendel') && vs.includes('einzelne Farben abweichend'), 'Versandseite: Farben mit eigener Lieferzeit und auf Anfrage automatisch gelistet');
  check(LEGAL_STAND === '2026-11-26' && ds.includes('Stand: <time datetime="2026-11-26">26. November 2026</time>'), 'Stand der Rechtstexte: 26. November 2026', LEGAL_STAND);
  const startseite = (await req('GET', '/')).text;
  const ld = JSON.parse(startseite.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] || '{}');
  const faq = (ld['@graph'] || []).find((x) => x['@type'] === 'FAQPage');
  const fq = faq?.mainEntity?.find((x) => /Individuelles/.test(x.name));
  check(fq && fq.acceptedAnswer.text.includes('schreib mir an hallo@formsam.example') && fq.acceptedAnswer.text.includes('Anfrageformular') && !/[<>]/.test(fq.acceptedAnswer.text), 'FAQ (JSON-LD): Eintrag „individuelles Angebot“ mit Kontaktadresse, ohne HTML', fq?.acceptedAnswer?.text);
  const fl = faq?.mainEntity?.find((x) => /Wie lange dauert/.test(x.name));
  check(fl?.acceptedAnswer.text.includes('dauert es 5–8 Werktage, einzelne Farben länger.'), 'FAQ (JSON-LD): Lieferzeit mit Einschränkung, weil Gold/Silber länger brauchen', fl?.acceptedAnswer?.text);
  check(startseite.includes('id="anfrage-modal"') && startseite.includes('id="anf-website"') && startseite.includes('href="/datenschutz#anfrage"') && startseite.includes('data-anfrage="angebot"') && startseite.includes('data-kontakt-mail'),
    'Startseite: Anfrage-Dialog mit Fallen-Feld und Datenschutz-Link, Links „Individuelles Angebot“, Kontaktadresse');

  console.log('\n— Wartungsmodus');
  r = await admin('POST', '/api/admin/settings', { baseRev: (await admin('GET', '/api/admin/data')).json.settings.rev, wartung: { kennwort: 'pruef-kennwort-1', aktiv: true } });
  r = await anfrage({ anlass: 'angebot', farbe: undefined });
  check(r.status === 503 && r.json?.code === 'wartung', 'im Wartungsmodus gesperrt wie andere APIs (503)', [r.status, r.json]);
}

try { await main(); } catch (err) { fail++; console.log('❌ Abbruch:', err?.stack || err); }
finally { await stop(); await smtp?.close(); rmSync(DIR, { recursive: true, force: true }); }
console.log(`\n${fail ? '❌' : '✓'} ${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
