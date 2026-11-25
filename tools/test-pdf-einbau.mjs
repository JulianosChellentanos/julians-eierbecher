#!/usr/bin/env node
// formsam — Prüfung PDF-Belege und PDF-Rechtstexte im Shop (server.js + lib/html-pdf.js):
//   Bestellbestätigung mit Rechnung, AGB und Widerrufsbelehrung als PDF (bzw. Rechtstexte als HTML bei Platzhalter-Firmendaten),
//   Admin-Kopie mit Rechnung, Storno- und Gutschrift-Mail mit Beleg-PDF, „Erneut“ mit denselben (damals gespeicherten) Dateien,
//   Route /orders/<ID>/<beleg>.pdf mit und ohne Schlüssel, PDF nie neu geschrieben, gleichzeitige Abrufe, Rückfall auf den Link
//   (Zeichen ohne Glyphe, abgeschnittene Beleg-HTML) — die Bestellung läuft dabei immer durch. Dazu Vorlage neuer Belege
//   (thead, Beträge rechtsbündig, Handy-Ansicht) und bereinigte Kundendaten.
//
//   node tools/test-pdf-einbau.mjs   → Exit 0/1
//
// Eigene Shop-Instanz mit DATA_DIR/ORDERS_DIR unter tmp-tests/test-pdf-einbau/ auf einem freien Port, Mails an einen Fake-SMTP in
// diesem Prozess (127.0.0.1) — keine Mail verlässt den Rechner. Firmendaten und Kundschaft sind erfunden. Kein PayPal.
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'tmp-tests', 'test-pdf-einbau');
const DATA = path.join(DIR, 'data'), ORDERS = path.join(DIR, 'orders');
const ADMIN = 'test-pdf-einbau-admin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return true; }
  fail++; console.log(`❌ ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 700) : ''}`);
  return false;
}

// ---------------------------------------------------------------------------
// Fake-SMTP (nimmt alles an) und MIME lesen — Anhänge mit Inhalt
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
  const ps = allParts(parseMime(raw));
  const head = parseMime(raw).headers;
  const t = ps.find((p) => /^text\/plain/.test(p.headers['content-type'] || '') && !p.headers['content-disposition']);
  const h = ps.find((p) => /^text\/html/.test(p.headers['content-type'] || '') && !p.headers['content-disposition']);
  const atts = ps.filter((p) => p.headers['content-disposition']).map((p) => ({
    name: (p.headers['content-disposition'].match(/filename="([^"]+)"/) || [])[1], type: (p.headers['content-type'] || '').split(';')[0],
    content: Buffer.from(p.body.replace(/\s+/g, ''), 'base64'),
  }));
  return { subject: decodeWords(head.subject), text: t ? qp(t.body) : '', html: h ? qp(h.body) : '', atts, names: atts.map((a) => a.name) };
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

// ---------------------------------------------------------------------------
// Shop-Instanz
// ---------------------------------------------------------------------------
const VASE = { product: 'vase', preset: 'flasche', height: 150, width: 1, pattern: 'rippen', ribs: 48, depth: 0.9, twist: 0, flow: 'spirale', flowWaves: 3, text: '', textSize: 7,
  textPos: 0.55, textStyle: 'gepraegt', font: 'helvetiker', customPoints: null, saucer: false, colorFinish: 'matt', color: 'elfenbein' };
function miniStl() {
  const b = Buffer.alloc(134); b.write('test-stl', 0, 'ascii'); b.writeUInt32LE(1, 80);
  [0, 0, 1, 0, 0, 0, 10, 0, 0, 0, 10, 0].forEach((v, i) => b.writeFloatLE(v, 84 + i * 4));
  return b;
}
// Erfundene, vollständige Firmendaten (Rechtstexte als PDF) bzw. Platzhalter wie im Auslieferungszustand (→ HTML-Anhänge)
const FIRMA = { name: 'formsam', owner: 'Paula Probe', street: 'Probeweg 7', zip: '54321', city: 'Probstadt', country: 'Deutschland', email: 'hallo@formsam.example',
  phone: '+49 30 1234567', kleinunternehmer: true, iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFFXXX', bank: 'Probebank' };
const PLATZHALTER = { ...FIRMA, street: 'Musterstraße 1', zip: '00000', city: 'Musterstadt' };

let child = null, port = 0, smtp = null, logText = '';
async function start() {
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, ORDERS_DIR: ORDERS }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { logText += d; });
  child.stderr.on('data', (d) => { logText += d; if (/TypeError|ReferenceError|SyntaxError/.test(d)) console.log('   [server]', String(d).trim().slice(0, 300)); });
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/pricing`); if (r.ok) return; } catch { /* startet noch */ } await sleep(150); }
  throw new Error('Shop startet nicht');
}
async function stop() { if (child) { const c = child; child = null; c.kill('SIGTERM'); await new Promise((r) => c.once('exit', r)); } }
function firma(company) {
  const f = path.join(DATA, 'settings.json');
  const s = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { adminKey: ADMIN, wartung: { aktiv: false }, paypal: { enabled: false, sandbox: true, clientId: '', secret: '' } };
  s.company = { ...(s.company || {}), ...company };
  s.legal = { hoster: 'Probe-Hosting GmbH, Serverweg 1, 10115 Berlin', serverOrt: 'Berlin (Deutschland)', avVertrag: true, mailVersand: 'anbieter' };
  s.shop = { lieferzeit: '5–8 Werktage', liefergebiet: 'Deutschland' };
  s.mail = { enabled: true, host: '127.0.0.1', port: smtp.port, secure: 'none', user: 'shop', pass: 'pw', from: 'shop@formsam.example', fromName: 'formsam',
    replyTo: 'hallo@formsam.example', adminTo: 'admin@formsam.example', adminCopy: true, autoStatusMails: true, publicUrl: `http://127.0.0.1:${port}` };
  writeFileSync(f, JSON.stringify(s, null, 2));
}
async function req(method, p, body, headers = {}) {
  const h = { ...headers }; let data;
  if (Buffer.isBuffer(body)) { data = body; h['content-type'] = 'application/octet-stream'; } else if (body !== undefined) { data = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: h, body: data, redirect: 'manual' });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* kein JSON */ }
  return { status: r.status, headers: Object.fromEntries(r.headers), buf, text: buf.toString('utf8'), json };
}
const admin = (method, p, body) => req(method, p, body, { 'x-admin-key': ADMIN });
const order = (id) => JSON.parse(readFileSync(path.join(ORDERS, id, 'order.json'), 'utf8'));
const datei = (id, f) => path.join(ORDERS, id, f);
const warte = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } return false; };
const mailsZu = (id) => smtp.got.filter((m) => m.subject.includes(id));
async function bestellung({ name = 'Erika Beispiel', email = 'kunde@formsam.example', items = [{}], auth = '' } = {}) {
  const its = items.map((it) => ({ product: 'vase', qty: it.qty || 1, saucer: false, config: { ...VASE, ...(it.config || {}) }, color: 'elfenbein', colorName: it.colorName || 'Elfenbein', code: null }));
  const quote = await req('POST', '/api/quote', { items: its, couponCode: null });
  const co = await req('POST', '/api/checkout', { customer: { name, email, street: 'Beispielweg 3', zip: '12345', city: 'Beispielstadt', note: '' }, items: its, payment: 'vorkasse',
    paypalOrderId: null, couponCode: null, beschaffenheit: true, mitSchluessel: true, expectedTotal: quote.json?.total }, auth ? { 'x-auth': auth } : {});
  if (!co.json?.ok) throw new Error(`Kasse: ${co.status} ${co.text.slice(0, 200)}`);
  const { orderId, accessKey, itemCount } = co.json;
  for (let i = 0; i < itemCount; i++) await req('PUT', `/api/order/${orderId}/stl/${i}`, miniStl(), { 'x-order-key': accessKey });
  const complete = await req('POST', `/api/order/${orderId}/complete`, {}, { 'x-order-key': accessKey });
  return { orderId, accessKey, complete };
}
const istPdf = (b) => Buffer.isBuffer(b) && b.length > 4000 && b.subarray(0, 8).toString('latin1').startsWith('%PDF-1.') && /%%EOF\s*$/.test(b.subarray(-32).toString('latin1'));
const seiten = (b) => (b.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
const pdfLog = () => logText.split('\n').filter((l) => l.includes('📄'));

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true }); mkdirSync(ORDERS, { recursive: true });
  smtp = await fakeSmtp();
  port = await freePort();
  firma(FIRMA);
  await start();

  console.log('\n— Bestellung mit vollständigen (erfundenen) Firmendaten');
  const a = await bestellung({ items: [{ config: { pattern: 'gehaemmert', text: 'Anna & Tom 12.06.2027' } }, { qty: 3, config: { preset: 'kugel', pattern: 'skelett', height: 180 } }] });
  const nrA = a.complete.json?.invoiceNo;
  check(a.complete.status === 200 && a.complete.json?.invoicePdfUrl === `/orders/${a.orderId}/rechnung.pdf?k=${a.accessKey}`, 'Abschluss: Antwort mit invoicePdfUrl (Schlüssel)', a.complete.json);
  await warte(() => mailsZu(a.orderId).length >= 2);
  const confA = mailsZu(a.orderId).find((m) => m.rcpts[0] === 'kunde@formsam.example');
  const admA = mailsZu(a.orderId).find((m) => m.rcpts[0] === 'admin@formsam.example');
  const rechnungName = `formsam-Rechnung-${nrA}.pdf`;
  check(confA && JSON.stringify(confA.names) === JSON.stringify([rechnungName, 'formsam-AGB.pdf', 'formsam-Widerrufsbelehrung.pdf']) && confA.atts.every((x) => x.type === 'application/pdf' && istPdf(x.content)),
    'Bestätigung: Rechnung, AGB und Widerrufsbelehrung als PDF (gültige Dateien)', confA?.names);
  check(confA && confA.text.includes(`Deine Rechnung hängt als PDF an dieser E-Mail: ${rechnungName}.`) && confA.text.includes('Die AGB und die Widerrufsbelehrung (mit Muster-Widerrufsformular) hängen an dieser E-Mail – zum Aufbewahren: formsam-AGB.pdf, formsam-Widerrufsbelehrung.pdf.')
    && confA.html.includes(rechnungName), 'Bestätigung: Text nennt genau die angehängten Dateien', confA?.text.match(/.*hängt.*$/m)?.[0]);
  check(admA && JSON.stringify(admA.names) === JSON.stringify([rechnungName]) && admA.text.includes(`Rechnung als PDF im Anhang: ${rechnungName}`), 'Admin-Kopie: Rechnung als PDF', admA?.names);
  const reA = readFileSync(datei(a.orderId, 'rechnung.pdf'));
  check(sha(confA.atts[0].content) === sha(reA) && sha(admA.atts[0].content) === sha(reA), 'Anhang = gespeicherte orders/<ID>/rechnung.pdf (Kundin und Admin dieselbe Datei)');
  check(['rechnung.pdf', 'agb.pdf', 'widerruf.pdf'].every((f) => (statSync(datei(a.orderId, f)).mode & 0o777) === 0o600) && !readdirSync(path.join(ORDERS, a.orderId)).some((f) => f.endsWith('.tmp')),
    'Dateien 0600, keine Temp-Reste', readdirSync(path.join(ORDERS, a.orderId)));
  check(sha(confA.atts[1].content) === sha(readFileSync(datei(a.orderId, 'agb.pdf'))) && sha(confA.atts[2].content) === sha(readFileSync(datei(a.orderId, 'widerruf.pdf'))),
    'Rechtstext-PDFs je Bestellung gespeichert (Nachweis des verschickten Stands)');
  check(seiten(confA.atts[1].content) >= 3 && seiten(confA.atts[2].content) >= 2 && seiten(reA) === 1, 'Seitenzahlen plausibel (AGB ≥ 3, Widerruf ≥ 2, Rechnung 1)', [seiten(confA.atts[1].content), seiten(confA.atts[2].content), seiten(reA)]);

  console.log('\n— Vorlage neuer Belege');
  const html = readFileSync(datei(a.orderId, 'rechnung.html'), 'utf8');
  check(/<table class="pos posten"><thead><tr><th class="nr">Pos\.<\/th>/.test(html) && /<\/thead><tbody>/.test(html), 'Positionstabelle mit <thead> (wiederholt sich auf Folgeseiten)');
  check(html.includes('.pos .r{text-align:right}') && !/\.ruecksende\{[^}]*nowrap/.test(html), 'Beträge rechtsbündig (.pos .r), Rücksendezeile ohne nowrap');
  check(/@media screen and \(max-width:640px\)\{\.posten thead\{display:none\}/.test(html) && /\.posten \.leer\{display:none\}/.test(html) && /class="r rabatt leer">—/.test(html),
    'Handy (nur Bildschirm): Positionen als Karten, leerer Rabatt ausgeblendet — der PDF-Satz übergeht den Block');
  check(/150&nbsp;mm/.test(html) && /§&nbsp;19 Abs\.&nbsp;1 UStG/.test(html) && /14&nbsp;Tagen/.test(html) && /5–8&nbsp;Werktage/.test(html) && /DE89&nbsp;3704/.test(html), 'Geschützte Leerzeichen: Zahl + Einheit, §, IBAN');
  check(html.includes('<a id="pdf-link" href="rechnung.pdf">PDF herunterladen</a>') && html.includes('location.search') && !html.includes(a.accessKey), 'Leiste: „PDF herunterladen“, Schlüssel nur aus der Adresse (nicht in der Datei)');
  check(order(a.orderId).lines[0].config.text === 'Anna & Tom 12.06.2027', 'Gravur unverändert übernommen');

  console.log('\n— Route /orders/<ID>/<beleg>.pdf');
  const r1 = await req('GET', `/orders/${a.orderId}/rechnung.pdf?k=${a.accessKey}`);
  check(r1.status === 200 && r1.headers['content-type'] === 'application/pdf' && r1.headers['content-disposition'] === `inline; filename="${rechnungName}"` && r1.headers['cache-control'] === 'no-store'
    && /noindex/.test(r1.headers['x-robots-tag'] || '') && r1.headers['referrer-policy'] === 'no-referrer' && sha(r1.buf) === sha(reA), 'mit Schlüssel: 200, PDF, inline mit Dateinamen, no-store, noindex', r1.headers);
  check((await req('GET', `/orders/${a.orderId}/rechnung.pdf`)).status === 404 && (await req('GET', `/orders/${a.orderId}/rechnung.pdf?k=falsch`)).status === 404, 'ohne bzw. mit falschem Schlüssel: 404');
  check((await req('GET', `/orders/${a.orderId}/rechnung.pdf`, undefined, { 'x-admin-key': ADMIN })).status === 200, 'Admin-Kopf: 200');
  const head = await req('HEAD', `/orders/${a.orderId}/rechnung.pdf?k=${a.accessKey}`);
  check(head.status === 200 && head.buf.length === 0 && Number(head.headers['content-length']) === reA.length, 'HEAD: Kopf ohne Inhalt');
  check((await req('GET', `/orders/${a.orderId}/agb.pdf?k=${a.accessKey}`)).status === 404 && (await req('GET', `/orders/${a.orderId}/gutschrift.pdf?k=${a.accessKey}`)).status === 404,
    'Rechtstext-PDF der Bestellung nicht abrufbar; Beleg, den es nicht gibt: 404');
  check((await req('POST', `/orders/${a.orderId}/rechnung.pdf?k=${a.accessKey}`, {})).status === 405, 'POST: 405');
  // nie neu geschrieben: Datei und Zeitstempel bleiben, auch nach erneuten Abrufen
  const mt = statSync(datei(a.orderId, 'rechnung.pdf')).mtimeMs;
  for (let i = 0; i < 3; i++) await req('GET', `/orders/${a.orderId}/rechnung.pdf?k=${a.accessKey}`);
  check(statSync(datei(a.orderId, 'rechnung.pdf')).mtimeMs === mt && sha(readFileSync(datei(a.orderId, 'rechnung.pdf'))) === sha(reA), 'PDF wird nie neu geschrieben (Hash und Zeitstempel stabil)');

  console.log('\n— Zweite Bestellung, Konto, gleichzeitige Abrufe');
  const reg = await req('POST', '/api/auth/register', { name: 'Karl Konto', email: 'konto@formsam.example', password: 'geheim12345' });
  const b = await bestellung({ name: 'Karl Konto', email: 'konto@formsam.example', auth: reg.json?.token });
  await warte(() => mailsZu(b.orderId).length >= 2);
  check(sha(readFileSync(datei(b.orderId, 'agb.pdf'))) === sha(readFileSync(datei(a.orderId, 'agb.pdf'))), 'gleiche Fassung der AGB → dieselben Bytes bei jeder Bestellung');
  const me = await req('GET', '/api/auth/me', undefined, { 'x-auth': reg.json?.token });
  const ko = me.json?.orders?.find((o) => o.orderId === b.orderId);
  check(ko?.invoicePdfUrl === `/orders/${b.orderId}/rechnung.pdf?k=${b.accessKey}` && ko?.invoiceUrl?.endsWith('rechnung.html?k=' + b.accessKey), 'Konto: Rechnung mit PDF-Link', ko);
  const reB = readFileSync(datei(b.orderId, 'rechnung.pdf'));
  unlinkSync(datei(b.orderId, 'rechnung.pdf'));
  const par = await Promise.all(Array.from({ length: 6 }, () => req('GET', `/orders/${b.orderId}/rechnung.pdf?k=${b.accessKey}`)));
  check(par.every((r) => r.status === 200 && sha(r.buf) === sha(reB)) && sha(readFileSync(datei(b.orderId, 'rechnung.pdf'))) === sha(reB) && !readdirSync(path.join(ORDERS, b.orderId)).some((f) => f.endsWith('.tmp')),
    '6 gleichzeitige Abrufe ohne PDF: eine Erzeugung, alle bekommen dieselben Bytes (= vorher, Datum aus dem Beleg)', par.map((r) => r.status));

  console.log('\n— „Erneut“ und Senden aus dem Drawer');
  const log1 = (await admin('GET', '/api/admin/mail-log')).json?.entries || [];
  const eA = log1.find((e) => e.orderId === a.orderId && e.kind === 'bestaetigung');
  const vorher = smtp.got.length;
  const rs = await admin('POST', '/api/admin/mail-resend', { id: eA?.id });
  await warte(() => smtp.got.length > vorher);
  const again = smtp.got.slice(vorher).find((m) => m.subject.includes(a.orderId));
  check(rs.json?.ok && again && JSON.stringify(again.names) === JSON.stringify(confA.names) && again.atts.every((x, i) => sha(x.content) === sha(confA.atts[i].content)), '„Erneut“ (zugestellte Bestätigung): dieselben drei Dateien, bytegleich', again?.names);
  const v2 = smtp.got.length;
  const send = await admin('POST', '/api/admin/mail-send', { orderId: a.orderId, kind: 'bestaetigung' });
  await warte(() => smtp.got.length > v2);
  const sent = smtp.got.slice(v2).find((m) => m.subject.includes(a.orderId));
  check(send.json?.ok && sent && JSON.stringify(sent.names) === JSON.stringify(confA.names), 'Drawer „Bestätigung senden“: dieselben Anhänge', sent?.names);
  const v3 = smtp.got.length;
  const sendAdm = log1.find((e) => e.orderId === a.orderId && e.kind === 'admin-neu') || log1.find((e) => e.ref === a.orderId && e.kind === 'admin-neu');
  const rsAdm = await admin('POST', '/api/admin/mail-resend', { id: sendAdm?.id });
  await warte(() => smtp.got.length > v3);
  const admAgain = smtp.got.slice(v3).find((m) => m.subject.includes(a.orderId));
  check(rsAdm.json?.ok && admAgain && JSON.stringify(admAgain.names) === JSON.stringify([rechnungName]), '„Erneut“ Admin-Kopie: wieder mit Rechnung als PDF', { rs: rsAdm.json, names: admAgain?.names });

  console.log('\n— Storno und Gutschrift');
  const v4 = smtp.got.length;
  const st = await admin('POST', '/api/admin/order-update', { orderId: a.orderId, status: 'storniert' });
  await warte(() => smtp.got.slice(v4).some((m) => m.subject.includes(a.orderId)));
  const stornoNr = order(a.orderId).storno?.nr;
  const stMail = smtp.got.slice(v4).find((m) => m.subject.includes(a.orderId));
  check(st.json?.ok && stornoNr && stMail && JSON.stringify(stMail.names) === JSON.stringify([`formsam-Stornorechnung-${stornoNr}.pdf`]) && istPdf(stMail.atts[0].content)
    && stMail.text.includes('Sie hängt auch als PDF an dieser E-Mail.') && sha(stMail.atts[0].content) === sha(readFileSync(datei(a.orderId, 'storno.pdf'))), 'Storno-Mail mit Stornorechnung als PDF', stMail?.names);
  const rSt = await req('GET', `/orders/${a.orderId}/storno.pdf?k=${a.accessKey}`);
  check(rSt.status === 200 && rSt.headers['content-disposition'] === `inline; filename="formsam-Stornorechnung-${stornoNr}.pdf"`, 'Route storno.pdf: 200 mit Dateinamen');
  check(/<thead><tr><th>Position<\/th><th class="r">Betrag<\/th><\/tr><\/thead>/.test(readFileSync(datei(a.orderId, 'storno.html'), 'utf8')), 'Stornorechnung mit <thead>');
  await admin('POST', '/api/admin/order-update', { orderId: b.orderId, paymentStatus: 'bezahlt', status: 'bezahlt' });
  await admin('POST', '/api/admin/reklamation', { orderId: b.orderId, action: 'anlegen', art: 'gutschein', betrag: 5, grund: 'Kratzer am Rand' });
  const v5 = smtp.got.length;
  const erl = await admin('POST', '/api/admin/reklamation', { orderId: b.orderId, action: 'erledigen' });
  const gsNr = order(b.orderId).reklamation?.gutschriftNo;
  await warte(() => smtp.got.slice(v5).some((m) => m.subject.includes(b.orderId) && m.names.length));
  const gsMail = smtp.got.slice(v5).find((m) => m.subject.includes(b.orderId) && /Gutschein-Code/.test(m.subject));
  check(erl.json?.ok && gsNr && gsMail && JSON.stringify(gsMail.names) === JSON.stringify([`formsam-Gutschrift-${gsNr}.pdf`]) && istPdf(gsMail.atts[0].content) && gsMail.text.includes('Sie hängt auch als PDF an dieser E-Mail.'),
    'Reklamation erledigt (Gutschein): Mail mit Gutschrift als PDF', gsMail?.names);
  const me2 = await req('GET', '/api/auth/me', undefined, { 'x-auth': reg.json?.token });
  check(me2.json?.orders?.find((o) => o.orderId === b.orderId)?.reklamation?.gutschriftPdfUrl === `/orders/${b.orderId}/gutschrift.pdf?k=${b.accessKey}`, 'Konto: Gutschrift mit PDF-Link');

  console.log('\n— Rückfall: keine PDF, Bestellung und Mail trotzdem');
  const c = await bestellung({ name: '王小明 Wang' });
  check(c.complete.status === 200 && c.complete.json?.ok, 'Name mit Zeichen ohne Glyphe (CJK): Bestellung abgeschlossen');
  await warte(() => mailsZu(c.orderId).length >= 2);
  const confC = mailsZu(c.orderId).find((m) => m.rcpts[0] === 'kunde@formsam.example');
  const admC = mailsZu(c.orderId).find((m) => m.rcpts[0] === 'admin@formsam.example');
  check(confC && JSON.stringify(confC.names) === JSON.stringify(['formsam-AGB.pdf', 'formsam-Widerrufsbelehrung.pdf']) && !confC.text.includes('Deine Rechnung hängt') && confC.text.includes(`/orders/${c.orderId}/rechnung.html?k=${c.accessKey}`),
    'Bestätigung ohne Rechnungs-PDF (Text nennt sie nicht, Link bleibt), Rechtstexte als PDF', confC?.names);
  check(admC && admC.names.length === 0 && !admC.text.includes('Rechnung als PDF'), 'Admin-Kopie ohne Anhang');
  const rc = await req('GET', `/orders/${c.orderId}/rechnung.pdf?k=${c.accessKey}`);
  check(rc.status === 302 && rc.headers.location === `/orders/${c.orderId}/rechnung.html?k=${c.accessKey}` && rc.headers['cache-control'] === 'no-store' && !existsSync(datei(c.orderId, 'rechnung.pdf')), 'Route: 302 auf die HTML-Fassung, keine PDF-Datei', rc.headers);
  const zeile = pdfLog().find((l) => l.includes(c.orderId));
  check(zeile && /GLYPH_MISSING U\+738B/.test(zeile) && !/王|Wang/.test(pdfLog().join('\n')), 'Protokoll: nur Code, Codepunkt, Bestellnummer — keine Kundendaten', zeile);
  // absichtlich kaputte Beleg-HTML (abgeschnitten, z. B. nach vollem Datenträger): keine PDF, Mail ohne sie
  writeFileSync(datei(b.orderId, 'rechnung.html'), readFileSync(datei(b.orderId, 'rechnung.html'), 'utf8').replace(/<\/body><\/html>\s*$/, ''));
  unlinkSync(datei(b.orderId, 'rechnung.pdf'));
  const rb = await req('GET', `/orders/${b.orderId}/rechnung.pdf?k=${b.accessKey}`);
  const eB = ((await admin('GET', '/api/admin/mail-log')).json?.entries || []).find((e) => e.orderId === b.orderId && e.kind === 'bestaetigung');
  const v6 = smtp.got.length;
  const rsB = await admin('POST', '/api/admin/mail-resend', { id: eB?.id });
  await warte(() => smtp.got.length > v6);
  const bAgain = smtp.got.slice(v6).find((m) => m.subject.includes(b.orderId));
  check(rb.status === 302 && rsB.json?.ok && bAgain && JSON.stringify(bAgain.names) === JSON.stringify(['formsam-AGB.pdf', 'formsam-Widerrufsbelehrung.pdf']) && !existsSync(datei(b.orderId, 'rechnung.pdf')),
    'abgeschnittene rechnung.html: Route 302, „Erneut“ ohne Rechnungs-PDF', { status: rb.status, names: bAgain?.names });

  console.log('\n— Bereinigte Kundendaten');
  const U = (...cp) => String.fromCodePoint(...cp);   // unsichtbare Zeichen ausdrücklich: LRM, RLO, NEL (C1), ZWSP, PU1 (C1)
  const d = await bestellung({ name: `Erika${U(0x200e)} ${U(0x202e)}Muster${U(0x85)}frau`, items: [{ config: { text: `Für${U(0x200b)} Oma${U(0x91)} ${'x'.repeat(28)}` } }] });
  await warte(() => existsSync(datei(d.orderId, 'rechnung.pdf')));   // entsteht nach der Antwort (Hook der Bestätigung)
  const od = order(d.orderId);
  check(d.complete.status === 200 && od.customer.name === 'Erika Muster frau' && od.lines[0].config.text === ('Für Oma  ' + 'x'.repeat(28)).slice(0, 30)
    && existsSync(datei(d.orderId, 'rechnung.pdf')), 'Steuer-/Formatzeichen entfernt, Gravur auf 30 Zeichen, PDF entsteht', { name: od.customer.name, text: od.lines[0].config.text });

  console.log('\n— Platzhalter-Firmendaten (wie im Auslieferungszustand): Rechtstexte als HTML');
  await stop();
  firma(PLATZHALTER);
  await start();
  const e = await bestellung({ name: 'Petra Platzhalter' });
  await warte(() => mailsZu(e.orderId).length >= 2);
  const confE = mailsZu(e.orderId).find((m) => m.rcpts[0] === 'kunde@formsam.example');
  check(confE && JSON.stringify(confE.names) === JSON.stringify([`formsam-Rechnung-${e.complete.json?.invoiceNo}.pdf`, 'formsam-AGB.html', 'formsam-Widerrufsbelehrung.html'])
    && confE.text.includes('zum Aufbewahren: formsam-AGB.html, formsam-Widerrufsbelehrung.html.') && !existsSync(datei(e.orderId, 'agb.pdf')), 'Rechnung als PDF, AGB/Widerrufsbelehrung als HTML; Text nennt .html', confE?.names);
  check(pdfLog().some((l) => l.includes(e.orderId) && /INCOMPLETE/.test(l)), 'Protokoll: INCOMPLETE');
  // „Erneut“ der früheren Bestätigung: die damals gespeicherten Rechtstext-PDFs (heute gäbe es nur HTML)
  const eA2 = ((await admin('GET', '/api/admin/mail-log')).json?.entries || []).find((x) => x.orderId === b.orderId && x.kind === 'bestaetigung' && x.status === 'gesendet');
  const v7 = smtp.got.length;
  await admin('POST', '/api/admin/mail-resend', { id: eA2?.id });
  await warte(() => smtp.got.length > v7);
  const old = smtp.got.slice(v7).find((m) => m.subject.includes(b.orderId));
  check(old && old.names.includes('formsam-AGB.pdf') && sha(old.atts.find((x) => x.name === 'formsam-AGB.pdf').content) === sha(readFileSync(datei(b.orderId, 'agb.pdf'))), '„Erneut“ nach Änderung der Firmendaten: der damals verschickte Stand (gespeicherte PDF)', old?.names);
}

try { await main(); } catch (err) { fail++; console.log('❌ Abbruch:', err?.stack || err); }
finally { await stop(); await smtp?.close(); }
console.log(`\n${fail ? '❌' : '✓'} ${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
