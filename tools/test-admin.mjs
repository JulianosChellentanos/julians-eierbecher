#!/usr/bin/env node
// test-admin.mjs — Admin-Abläufe und Auslieferung gegen eine eigene, frische Shop-Instanz
//
//   node tools/test-admin.mjs            startet server.js mit eigenem DATA_DIR/ORDERS_DIR unter tmp-tests/ (freier Port, Mail und
//                                        PayPal aus — es geht nichts hinaus) und räumt danach auf
//
// Geprüft: Reihenfolge der Bestellliste (createdAt, auch mit Altbestand „OV-…“), veraltete Tabs (Stand bei order-update/order-status,
// Druckstatus „vorher“, Einstellungen mit baseRev → 409; ohne Angabe wie bisher, aber nie ein Status-Rückschritt), Kompression
// (gzip 9 / Brotli 11 aus dem Speicher, q-Werte, Vary, ETag je Fassung, If-None-Match mit W/ und Listen, HEAD), JSON-LD der
// Startseite (Organization, WebSite, FAQPage; kein Product/Offer; Anschrift nur ohne Platzhalter). Exit 0 = alles bestanden.
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import zlib from 'node:zlib';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'tmp-tests', `test-admin-${process.pid}`);
const DATA = path.join(TMP, 'data'), ORDERS = path.join(TMP, 'orders');
const ADMIN = 'test-admin-passwort';
let pass = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.unref(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const VASE = { product: 'vase', preset: 'flasche', height: 150, width: 1, pattern: 'rippen', ribs: 48, depth: 0.9, twist: 0, flow: 'spirale', flowWaves: 3,
  text: '', textSize: 7, textPos: 0.55, textStyle: 'gepraegt', font: 'helvetiker', customPoints: null, saucer: false, colorFinish: 'matt', color: 'elfenbein' };
const KUNDE = { name: 'Erika Mustermann', email: 'kunde@example.test', street: 'Teststraße 12', zip: '12345', city: 'Teststadt', note: '' };
const V = (qty = 1) => ({ product: 'vase', qty, saucer: false, color: 'elfenbein', colorName: 'Elfenbein', code: null, config: { ...VASE } });
const stl = () => { const b = Buffer.alloc(134); b.writeUInt32LE(1, 80); return b; };

let base = '', port = 0, child = null, ipNr = 0;
// Jede Anfrage aus einem eigenen Netz (TRUST_PROXY=1) — die Bremsen (z. B. 20 Kassen je IP und Stunde) prüft test-daten
async function req(method, pfad, body, headers = {}) {
  ipNr++;
  const h = { 'x-forwarded-for': `10.${(ipNr >> 8) & 255}.${ipNr & 255}.1`, ...headers };
  let data;
  if (Buffer.isBuffer(body)) { data = body; h['content-type'] = 'application/octet-stream'; } else if (body !== undefined) { data = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(base + pfad, { method, headers: h, body: data });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: r.status, json, text };
}
const admin = (method, pfad, body) => req(method, pfad, body, { 'x-admin-key': ADMIN });
const upd = (body) => admin('POST', '/api/admin/order-update', { notify: false, ...body });
const bestellung = async (id) => (await admin('GET', `/api/admin/order/${id}`)).json.order;
const standVon = (o) => ({ status: o.status || 'neu', paymentStatus: o.paymentStatus || 'offen', trackingNo: o.trackingNo || '', carrier: o.carrier || '', adminNote: o.adminNote || '' });
async function bestelle(qty = 1, { abschliessen = true } = {}) {
  const items = [V(qty)];
  const q = (await req('POST', '/api/quote', { items })).json;
  const co = await req('POST', '/api/checkout', { customer: KUNDE, items, payment: 'vorkasse', beschaffenheit: true, mitSchluessel: true, kasseStand: 2, expectedTotal: q.total });
  if (!co.json?.ok) throw new Error('Kasse: ' + co.text.slice(0, 200));
  const { orderId, accessKey } = co.json;
  if (abschliessen) {
    await req('PUT', `/api/order/${orderId}/stl/0`, stl(), { 'x-order-key': accessKey });
    await req('POST', `/api/order/${orderId}/complete`, {}, { 'x-order-key': accessKey });
  }
  return orderId;
}
/** Rohe HTTP-Antwort (ohne automatisches Entpacken) */
const roh = (pfad, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: pfad, method, headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, h: res.headers, body: Buffer.concat(chunks) }));
  });
  r.on('error', reject); r.end();
});
const entpackt = (r) => (r.h['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.h['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body);

async function start() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true }); mkdirSync(ORDERS, { recursive: true });
  writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ adminKey: ADMIN }));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, ORDERS_DIR: ORDERS, TRUST_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/pricing`)).ok) return () => log; } catch { /* startet noch */ }
    await sleep(150);
  }
  throw new Error(`Server startet nicht:\n${log}`);
}

let serverLog = () => '';
try {
  serverLog = await start();
  // Altbestand „OV-…“ (älteres Nummernformat, März 2025) — sortiert nach Ordnernamen stünde er oben, richtig ist ganz unten
  mkdirSync(path.join(ORDERS, 'OV-250310-ABC123'), { recursive: true });
  writeFileSync(path.join(ORDERS, 'OV-250310-ABC123', 'order.json'), JSON.stringify({ orderId: 'OV-250310-ABC123', createdAt: '2025-03-10T09:00:00.000Z', status: 'abgeschlossen',
    paymentStatus: 'bezahlt', customer: { ...KUNDE, name: 'Alt Bestand' }, lines: [{ ...V(1), unit: 24.9, line: 24.9 }], total: 29.8, history: [] }));

  console.log('1) Bestellliste chronologisch (createdAt, neueste oben)');
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await bestelle());
  const liste = (await admin('GET', '/api/admin/data')).json.orders;
  const zeiten = liste.map((o) => Date.parse(o.createdAt));
  check(zeiten.every((t, i) => i === 0 || zeiten[i - 1] >= t), 'Liste nach createdAt absteigend', liste.map((o) => o.orderId));
  check(liste[0].orderId === ids.at(-1), 'neueste Bestellung steht oben', { erste: liste[0].orderId, neueste: ids.at(-1) });
  check(liste.at(-1).orderId === 'OV-250310-ABC123', 'Altbestand „OV-…“ steht unten');

  console.log('2) Veralteter Tab: Bestellung');
  const a = ids[0];
  check((await upd({ orderId: a, paymentStatus: 'bezahlt', status: 'bezahlt', stand: standVon(await bestellung(a)) })).status === 200, 'Zahlung mit aktuellem Stand → 200');
  const alt = standVon(await bestellung(a));   // Stand von Tab 2
  check((await admin('POST', '/api/admin/line-print', { orderId: a, idx: 0, status: 'fertig', vorher: 'offen' })).status === 200, 'Druck fertig (vorher offen) → 200');
  const t1 = await upd({ orderId: a, status: 'versendet', trackingNo: 'TAB1-1', carrier: 'dhl', stand: standVon(await bestellung(a)) });
  check(t1.status === 200 && t1.json.order.status === 'versendet', 'Tab 1 versendet → 200');
  let r = await upd({ orderId: a, status: 'im-druck', stand: alt });
  check(r.status === 409 && r.json.code === 'stand' && r.json.error === 'Inzwischen geändert – bitte neu laden' && r.json.order?.status === 'versendet', 'Tab 2 mit altem Stand „Im Druck“ → 409 „Inzwischen geändert – bitte neu laden“ samt aktuellem Stand', r.json);
  r = await upd({ orderId: a, status: 'im-druck' });
  check(r.status === 409 && r.json.code === 'status' && /Versendet/.test(r.json.error), 'alter Tab ohne Stand: Rückschritt versendet → im-druck abgelehnt (409)', r.json);
  r = await admin('POST', '/api/admin/order-status', { orderId: a, status: 'gedruckt' });
  check(r.status === 409 && r.json.code === 'status', 'alter Kurz-Endpoint order-status: Rückschritt → 409', r.json);
  check((await bestellung(a)).status === 'versendet', 'Status bleibt „versendet“');
  r = await upd({ orderId: a, adminNote: 'Notiz aus Tab 2', stand: alt });
  check(r.status === 409 && (await bestellung(a)).adminNote === '', 'Notiz mit altem Stand → 409, nichts überschrieben', r.json);
  r = await upd({ orderId: a, adminNote: 'Notiz aktuell', stand: standVon(await bestellung(a)) });
  check(r.status === 200 && r.json.order.adminNote === 'Notiz aktuell', 'Notiz mit aktuellem Stand → 200');
  r = await upd({ orderId: a, adminNote: 'Notiz alter Tab' });
  check(r.status === 200 && r.json.order.adminNote === 'Notiz alter Tab', 'Notiz ohne Stand (Tab von vor dem Update) → 200 wie bisher');
  r = await upd({ orderId: a, status: 'abgeschlossen' });
  check(r.status === 200 && r.json.order.status === 'abgeschlossen', 'alter Tab ohne Stand: vorwärts (→ abgeschlossen) geht weiter');
  r = await upd({ orderId: a, status: 'neu', stand: { status: 'abgeschlossen' } });
  check(r.status === 409 && r.json.code === 'status', 'auch mit passendem Stand kein Rückschritt (abgeschlossen → neu)', r.json);
  check((await upd({ orderId: a, stand: 'kaputt' })).status === 400, 'Stand kein Objekt → 400');
  // Druckstatus aus veraltetem Tab
  const b = ids[1];
  await upd({ orderId: b, paymentStatus: 'bezahlt', status: 'bezahlt' });
  await admin('POST', '/api/admin/line-print', { orderId: b, idx: 0, status: 'fertig' });
  r = await admin('POST', '/api/admin/line-print', { orderId: b, idx: 0, status: 'druckt', vorher: 'offen' });
  check(r.status === 409 && r.json.code === 'stand' && (await bestellung(b)).lines[0].print.status === 'fertig', 'Druck „Start“ aus veraltetem Tab (vorher offen, ist fertig) → 409, Position bleibt fertig', r.json);
  check((await admin('POST', '/api/admin/line-print', { orderId: b, idx: 0, status: 'fertig', vorher: 'fertig' })).status === 200, 'Druckstatus mit passendem „vorher“ → 200');
  // Fehlklick „bezahlt“ zurücknehmen (auch alter Tab): nur aus „Bezahlt“, mit Zahlung offen, ohne laufenden Druck
  const c = ids[2];
  await upd({ orderId: c, paymentStatus: 'bezahlt', status: 'bezahlt' });
  r = await upd({ orderId: c, paymentStatus: 'offen', status: 'neu' });
  check(r.status === 200 && r.json.order.status === 'neu' && r.json.order.paymentStatus === 'offen', 'Bezahlt → Neu mit Zahlung offen (Fehlklick zurücknehmen) → 200', r.json);
  await upd({ orderId: c, paymentStatus: 'bezahlt', status: 'bezahlt' });
  await admin('POST', '/api/admin/line-print', { orderId: c, idx: 0, status: 'druckt' });
  r = await upd({ orderId: c, paymentStatus: 'offen', status: 'neu' });
  check(r.status === 409 && (await bestellung(c)).status === 'im-druck', 'Zurück auf Neu, während gedruckt wird → 409', r.json);
  // Storno: nur „Storno aufheben“ (→ Neu), nicht direkt zurück auf „Bezahlt“
  const d = await bestelle(1, { abschliessen: false });   // nie abgeschlossene Kasse: ohne Rechnung, Aufheben erlaubt
  check((await upd({ orderId: d, status: 'storniert' })).status === 200, 'Kasse ohne Abschluss storniert');
  r = await upd({ orderId: d, status: 'bezahlt', paymentStatus: 'bezahlt' });
  check(r.status === 409 && (await bestellung(d)).status === 'storniert', 'storniert → bezahlt (alter Tab „Zahlung eingegangen“) → 409', r.json);
  check((await upd({ orderId: d, status: 'neu' })).status === 200, 'Storno aufheben → Neu weiter möglich');

  console.log('3) Veralteter Tab: Einstellungen (rev/baseRev)');
  const s0 = (await admin('GET', '/api/admin/data')).json.settings;
  check(Number.isInteger(s0.rev), 'settings.rev im Admin', s0.rev);
  const p1 = structuredClone(s0.pricing); p1.vase.single = 27.5;
  r = await admin('POST', '/api/admin/settings', { pricing: p1, baseRev: s0.rev });
  check(r.status === 200 && r.json.rev === s0.rev + 1 && r.json.settings?.pricing?.vase?.single === 27.5, 'Tab 1 speichert mit aktuellem Stand → 200, rev +1, gespeicherter Stand in der Antwort', { status: r.status, rev: r.json?.rev });
  const vorher = readFileSync(path.join(DATA, 'settings.json'), 'utf8');
  const p2 = structuredClone(s0.pricing); p2.shipping.flat = 5.5;
  r = await admin('POST', '/api/admin/settings', { pricing: p2, baseRev: s0.rev });
  check(r.status === 409 && r.json.code === 'stand' && r.json.error === 'Inzwischen geändert – bitte neu laden', 'Tab 2 mit altem Stand → 409 „Inzwischen geändert – bitte neu laden“', r.json);
  check(readFileSync(path.join(DATA, 'settings.json'), 'utf8') === vorher, 'settings.json unverändert (Vasenpreis 27,50 bleibt)');
  check((await admin('POST', '/api/admin/settings', { pricing: p1, baseRev: 'x' })).status === 400, 'baseRev keine Zahl → 400');
  const rev1 = (await admin('GET', '/api/admin/data')).json.settings.rev;
  await bestelle();   // Rechnungsnummer zählt hoch — das ist keine Admin-Änderung
  check((await admin('GET', '/api/admin/data')).json.settings.rev === rev1, 'eine neue Bestellung (Rechnungsnummer) ändert den Stand nicht');
  r = await admin('POST', '/api/admin/settings', { pricing: s0.pricing });
  check(r.status === 200 && r.json.rev === rev1 + 1, 'ohne baseRev (Tab von vor dem Update) → 200 wie bisher');
  const muster = structuredClone(s0.pricing); muster.muster = { ...muster.muster, wellen: 2 };
  r = await admin('POST', '/api/admin/settings', { pricing: muster, baseRev: rev1 + 1 });
  check(r.status === 200 && r.json.settings.pricing.muster.wellen === 2 && r.json.settings.rev === r.json.rev && !('adminKeyHash' in r.json.settings) && r.json.settings.mail.pass === '',
    'Antwort enthält den gespeicherten Stand (ohne Geheimnisse) — der Admin füllt die Felder daraus neu', r.json?.settings?.pricing?.muster);

  console.log('4) Kompression und ETag');
  const three = readFileSync(path.join(ROOT, 'public', 'vendor', 'three.module.js'));
  let g = await roh('/vendor/three.module.js', { 'accept-encoding': 'gzip' });
  check(g.h['content-encoding'] === 'gzip' && /-gz"$/.test(g.h.etag) && g.h.vary === 'Accept-Encoding' && Number(g.h['content-length']) === g.body.length, 'gzip: Content-Encoding, ETag …-gz, Vary, Content-Length', g.h);
  check(entpackt(g).equals(three) && g.body.length <= zlib.gzipSync(three, { level: 9 }).length + 64, `gzip Stufe 9 (${g.body.length} B statt ${zlib.gzipSync(three, { level: 1 }).length} B mit Stufe 1), Inhalt gleich`);
  let br = await roh('/vendor/three.module.js', { 'accept-encoding': 'br' });
  check(br.h['content-encoding'] === 'br' && /-br"$/.test(br.h.etag) && entpackt(br).equals(three), 'nur „br“ → Brotli (wartet auf das Packen), Inhalt gleich', br.h);
  for (let i = 0; i < 50; i++) { const x = await roh('/vendor/three.module.js', { 'accept-encoding': 'gzip, deflate, br' }); if (x.h['content-encoding'] === 'br') { br = x; break; } await sleep(100); }
  check(br.h['content-encoding'] === 'br' && br.body.length < g.body.length && br.body.length <= zlib.brotliCompressSync(three, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length + 64,
    `Browser („gzip, deflate, br“) bekommt Brotli 11 aus dem Speicher (${br.body.length} B)`);
  const ohne = await roh('/vendor/three.module.js');
  check(!ohne.h['content-encoding'] && ohne.h.vary === 'Accept-Encoding' && ohne.body.length === three.length && !/-(gz|br)"$/.test(ohne.h.etag), 'ohne Accept-Encoding: ungepackt, trotzdem Vary', ohne.h);
  const q0 = await roh('/vendor/three.module.js', { 'accept-encoding': 'gzip;q=0' });
  check(!q0.h['content-encoding'], '„gzip;q=0“ → ungepackt', q0.h);
  const qg = await roh('/vendor/three.module.js', { 'accept-encoding': 'br;q=0.5, gzip;q=1' });
  check(qg.h['content-encoding'] === 'gzip', 'höheres q für gzip → gzip', qg.h);
  check((await roh('/vendor/three.module.js', { 'accept-encoding': 'gzip', 'if-none-match': `W/${g.h.etag}` })).status === 304, 'If-None-Match schwach (W/…) → 304');
  check((await roh('/vendor/three.module.js', { 'accept-encoding': 'gzip', 'if-none-match': `"x", ${g.h.etag}` })).status === 304, 'If-None-Match als Liste → 304');
  const brNurGzip = await roh('/vendor/three.module.js', { 'accept-encoding': 'gzip', 'if-none-match': br.h.etag });
  check(brNurGzip.status === 200 && brNurGzip.h['content-encoding'] === 'gzip', 'Brotli-ETag, aber Browser nimmt nur gzip → 200 gzip', brNurGzip.h);
  const kopf = await roh('/vendor/three.module.js', { 'accept-encoding': 'gzip' }, 'HEAD');
  check(kopf.status === 200 && kopf.body.length === 0 && Number(kopf.h['content-length']) === g.body.length, 'HEAD: Länge der gzip-Fassung, kein Inhalt');
  const klein = await roh('/manifest.webmanifest', { 'accept-encoding': 'gzip' });
  check(klein.status === 200 && klein.h.vary === 'Accept-Encoding', 'Manifest: Vary gesetzt', klein.h);
  // Startseite und Rechtsseite
  const sGz = await roh('/', { 'accept-encoding': 'gzip, deflate, br' });
  check(['gzip', 'br'].includes(sGz.h['content-encoding']) && sGz.h.vary === 'Accept-Encoding', 'Startseite gepackt', sGz.h);
  check((await roh('/', { 'accept-encoding': 'gzip, deflate, br', 'if-none-match': `W/${sGz.h.etag}` })).status === 304, 'Startseite: If-None-Match mit W/ → 304');
  const imp = await roh('/impressum', { 'accept-encoding': 'br' });
  check(imp.status === 200 && imp.h['content-encoding'] === 'br' && /Impressum/.test(entpackt(imp).toString()), 'Rechtsseite mit Brotli', imp.h);
  check(!(await roh('/impressum', { 'accept-encoding': 'gzip;q=0' })).h['content-encoding'], 'Rechtsseite: „gzip;q=0“ → ungepackt');

  console.log('5) Strukturierte Daten der Startseite');
  const ldAus = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  let html = entpackt(sGz).toString();
  let ld = ldAus(html);
  const typen = (ld[0]?.['@graph'] || []).map((x) => x['@type']);
  check(ld.length === 1 && typen.includes('Organization') && typen.includes('WebSite'), 'JSON-LD mit Organization und WebSite', typen);
  check(!/"(Product|Offer|AggregateOffer)"/.test(JSON.stringify(ld)), 'kein Product/Offer');
  const faq = ld[0]['@graph'].find((x) => x['@type'] === 'FAQPage');
  const content = JSON.parse(readFileSync(path.join(ROOT, 'public', 'content.json'), 'utf8'));
  check(faq && faq.mainEntity.length === content.faq.length && faq.mainEntity.every((q) => !/[<>]/.test(q.acceptedAnswer.text)), 'FAQPage aus content.json (FAQ-Bereich sichtbar), Antworten als Text', faq?.mainEntity?.length);
  check(/5–8 Werktage/.test(JSON.stringify(faq)), 'Lieferzeit aus den Einstellungen eingesetzt');
  let org = ld[0]['@graph'].find((x) => x['@type'] === 'Organization');
  check(org.name === 'formsam' && !org.address && /^https?:\/\/[^/]+\/$/.test(org.url), 'Organization ohne Platzhalter-Anschrift (Musterstraße)', org);
  r = await admin('POST', '/api/admin/settings', { company: { street: 'Lindenweg 7', zip: '80331', city: 'München', phone: '+49 89 1234567' } });
  check(r.status === 200, 'echte Anschrift gespeichert');
  const sNeu = await roh('/', { 'accept-encoding': 'gzip' });
  html = entpackt(sNeu).toString();
  org = ldAus(html)[0]['@graph'].find((x) => x['@type'] === 'Organization');
  check(org.address?.streetAddress === 'Lindenweg 7' && org.address.addressCountry === 'DE' && org.telephone === '+49 89 1234567', 'Anschrift und Telefon nach dem Eintragen', org);
  check(sNeu.h.etag !== sGz.h.etag, 'ETag der Startseite ändert sich mit den Firmendaten');
  check(/<link rel="canonical" href="https:\/\/www\.formsam\.com\/">/.test(html), 'Canonical weiter gesetzt');
} catch (err) {
  fail++;
  console.log('  ✗ Abbruch:', err?.stack || err);
} finally {
  if (child) child.kill();
  if (fail) console.log('\n--- Server-Protokoll (Ende) ---\n' + serverLog().split('\n').slice(-25).join('\n'));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
