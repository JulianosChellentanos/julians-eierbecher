// formsam — Prüfung von Eingaben, Auslieferung und Schutz-Kopfzeilen (lib/eingaben.js + server.js):
//   A) ohne Server: E-Mail-/Namens-/Adress-/Konfigurationsprüfung, ReDoS-Schlimmstfälle (je < 5 ms), Abgleich der Tabellen mit
//      public/js/geometry.js und den Reglern in public/index.html
//   B) eigene Server-Instanz (Port 4506–4509, Daten unter tmp-tests/test-eingaben-<pid>, Mail aus, wird danach gelöscht):
//      400/404/405/413 statt 500 oder Verbindungsabbruch, Schutz-Kopfzeilen, 404-Seite, Pfadprüfung, Konto-, Design- und
//      Kassenprüfung, Vorschaubilder, Dateirechte, eine vollständige Vorkasse-Bestellung
// Aufruf: node tools/test-eingaben.mjs   → Exit 0 = alles bestanden, 1 = Fehler
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isEmail, ohneFinish, kontoName, kontoAdresse, pruefeKonfig, pruefePositionen, KONFIG, ZAHLEN, isHex6,
} from '../lib/eingaben.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); }
};
/** Laufzeit in ms (Median aus 5 Läufen) */
const ms = (fn) => { const t = []; for (let i = 0; i < 5; i++) { const a = performance.now(); fn(); t.push(performance.now() - a); } return t.sort((a, b) => a - b)[2]; };

// ---------------------------------------------------------------------------
console.log('A1 E-Mail (wie der Mailversand, linear, ≤ 254)');
for (const e of ['a@b.de', 'Erika.Mustermann+shop@mail.example.com', '  x@y.org  ']) check(isEmail(e), `gültig: ${e.trim()}`);
for (const e of ['komma,test@x.de', 'semi;kolon@x.de', 'klammer(x)@x.de', '<b>fett</b>@x.de', 'a@b', 'a@.de', 'a@de.', '@x.de', 'a@@x.de',
  'a b@x.de', 'a@x.de@y.de', `${'a'.repeat(250)}@x.de`, '', null]) check(!isEmail(e), `ungültig: ${String(e).slice(0, 30)}`);

console.log('A2 Farbname ohne Finish (gleiche Wirkung wie der alte Ausdruck)');
const ALT = (raw) => String(raw).trim().replace(/\s*(?:·\s*[^·()]*|\([^()]*\))\s*$/, '').trim();
check(ohneFinish('Gold · metallic') === 'Gold' && ohneFinish('Gold (metallic)') === 'Gold' && ohneFinish('Gold') === 'Gold', '„Gold · metallic“, „Gold (metallic)“, „Gold“ → Gold');
{
  const Z = ['a', ' ', '·', '(', ')', 'x'];
  let abweichung = null;
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 20000 && !abweichung; i++) {
    let w = ''; const n = Math.floor(rnd() * 12); for (let j = 0; j < n; j++) w += Z[Math.floor(rnd() * Z.length)];
    if (ALT(w) !== ohneFinish(w)) abweichung = { w, alt: ALT(w), neu: ohneFinish(w) };
  }
  check(!abweichung, '20 000 Zufallsnamen: Ergebnis identisch mit dem alten Ausdruck', abweichung);
}

console.log('A3 ReDoS-Schlimmstfälle (Median aus 5 Läufen, je < 5 ms)');
const N = 100000;   // größer als jede Eingabe, die bis zur Prüfung kommt (Bodies 16–64 KB, Kasse 4 MB → vorher Längenprüfung)
const schlimm = {
  'ohneFinish x·␠…(': () => ohneFinish('x·' + ' '.repeat(N) + '('),
  'ohneFinish (((…)': () => ohneFinish('('.repeat(N) + ')'),
  'isEmail a@.…@': () => isEmail('a@' + '.'.repeat(N) + '@'),
  'isEmail a@.…! (254)': () => isEmail('a@' + '.'.repeat(250) + '!'),
  'kontoName ␠…': () => kontoName(' '.repeat(N)),
  'kontoAdresse ␠…': () => kontoAdresse({ street: ' \t'.repeat(N), zip: '1', city: 'x' }),
  'pruefeKonfig Text': () => pruefeKonfig({ product: 'vase', preset: 'flasche', height: 150, pattern: 'rippen', text: ' '.repeat(N) }),
  'pruefeKonfig Punkte': () => pruefeKonfig({ product: 'vase', preset: 'eigene', height: 150, pattern: 'rippen', customPoints: Array(5000).fill([0.5, 0.5]) }),
  'pruefePositionen 20×': () => pruefePositionen(Array(20).fill({ product: 'vase', config: { product: 'vase', preset: 'flasche', height: 150, pattern: 'rippen' }, colorName: 'x·' + ' '.repeat(N) + '(' }), { farbe: () => ({}), schriftfarbe: () => ({}) }),
};
for (const [k, fn] of Object.entries(schlimm)) { const t = ms(fn); check(t < 5, `${k}: ${t.toFixed(2)} ms`); }

console.log('A4 Kontodaten');
check(kontoName('Erika Mustermann').name === 'Erika Mustermann' && kontoName('  Jo  ').name === 'Jo', 'Name 2–80 Zeichen, Leerraum zusammengefasst');
for (const n of ['A', 'x'.repeat(81), '<img src=x onerror=alert(1)>', 'a>b', 42, null]) check(!!kontoName(n).error, `Name abgelehnt: ${String(n).slice(0, 20)}`);
check(JSON.stringify(kontoAdresse({ street: ' Weg 1 ', zip: '12345', city: 'Ort' }).address) === '{"street":"Weg 1","zip":"12345","city":"Ort"}', 'Adresse: Text getrimmt');
check(JSON.stringify(kontoAdresse({}).address) === '{"street":"","zip":"","city":""}', 'Adresse: fehlende Felder → leer');
for (const a of [{ street: { a: 1 } }, { zip: 12345 }, { city: ['x'] }, { street: 'x'.repeat(121) }, { zip: '12345678901' }, { city: 'x'.repeat(81) }]) {
  check(!!kontoAdresse(a).error, `Adresse abgelehnt: ${JSON.stringify(a).slice(0, 30)}`);
}

console.log('A5 Konfiguration');
const VASE = { product: 'vase', preset: 'flasche', height: 150, width: 1, pattern: 'rippen', ribs: 48, depth: 0.9, twist: 0, flow: 'spirale',
  flowWaves: 3, text: 'Anna & Tom', textSize: 7, textPos: 0.55, textStyle: 'gepraegt', font: 'helvetiker', customPoints: null, saucer: false,
  colorFinish: 'matt', color: 'elfenbein', rim: 'glatt', textColor: 'tiefschwarz' };
check(pruefeKonfig(VASE) === null, 'Konfigurator-Stand gültig');
const { STUDIO_DESIGNS, designConfig } = await import('../public/js/studio-designs.js');
check(STUDIO_DESIGNS.every((d) => pruefeKonfig(designConfig(d)) === null), `alle ${STUDIO_DESIGNS.length} Studio-Entwürfe gültig`,
  STUDIO_DESIGNS.map((d) => [d.id, pruefeKonfig(designConfig(d))]).filter(([, k]) => k));
check(pruefeKonfig({ ...VASE, preset: 'eigene', customPoints: [[0, 0.7], [0.5, 0.9], { t: 1, r: 0.8 }] }) === null, 'eigene Form mit 3 Punkten ([t,r] und {t,r})');
check(pruefeKonfig({ ...VASE, product: 'eierbecher', preset: 'kelch', height: 58 }) === null, 'Eierbecher-Konfiguration (Werte) gültig');
check(pruefeKonfig({ ...VASE, height: '150', textSize: '4.5', flowWaves: 8 }) === null, 'Zahlen als Text, frühere Reglergrenzen (Schrift 4 mm, 8 Wechsel)');
const UNGUELTIG = [
  [{ ...VASE, height: 1e308 }, 'height'], [{ ...VASE, height: 5000 }, 'height'], [{ ...VASE, height: 89 }, 'height'], [{ ...VASE, ribs: -5 }, 'ribs'],
  [{ ...VASE, depth: 'abc' }, 'depth'], [{ ...VASE, width: 3 }, 'width'], [{ ...VASE, pattern: '<img src=x onerror=alert(1)>' }, 'pattern'],
  [{ ...VASE, pattern: 'gibtsnicht' }, 'pattern'], [{ ...VASE, preset: 'constructor' }, 'preset'], [{ ...VASE, textStyle: 'toString' }, 'textStyle'],
  [{ ...VASE, rim: 'valueOf' }, 'rim'], [{ ...VASE, font: '__proto__' }, 'font'], [{ ...VASE, flow: 'x' }, 'flow'], [{ ...VASE, text: 'G'.repeat(41) }, 'text'],
  [{ ...VASE, text: 'a\u0000b' }, 'text'], [{ ...VASE, colorHex: 'red;background-image:url(/x)' }, 'colorHex'], [{ ...VASE, colorHex: '#fff' }, 'colorHex'],
  [{ ...VASE, saucer: 'ja' }, 'saucer'], [{ product: 'vase' }, 'preset'], [{ ...VASE, preset: 'eigene', customPoints: [null] }, 'customPoints'],
  [{ ...VASE, preset: 'eigene', customPoints: [['a', 'b'], [0.5, 0.5], [1, 1]] }, 'customPoints'], [{ ...VASE, preset: 'kelch' }, 'preset'],
  [{ ...VASE, product: 'tasse' }, 'product'], [{ ...VASE, pad: 'x'.repeat(20000) }, 'config'], [[], 'config'], [null, 'config'],
];
for (const [cfg, k] of UNGUELTIG) { const r = pruefeKonfig(cfg); check(r === k, `abgelehnt (${k}): ${JSON.stringify(cfg)?.slice(0, 60)}`, r); }
check(pruefeKonfig(VASE, { farbeBekannt: () => false }) === 'color', 'unbekannte Farbe (Design) → color');
check(isHex6('#a1B2c3') && !isHex6('#abc') && !isHex6('#a1b2c3;') && !isHex6(null), 'isHex6 nur #rrggbb');

console.log('A6 Abgleich mit geometry.js / textrelief.js / index.html');
const G = await import('../public/js/geometry.js');
const gleich = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
check(gleich(Object.keys(G.PRODUCTS), Object.keys(KONFIG.produkte)), 'Produkte');
for (const [id, pr] of Object.entries(G.PRODUCTS)) {
  check(gleich(Object.keys(pr.presets), KONFIG.produkte[id]?.presets || []), `Formen ${id}`);
  check(JSON.stringify(pr.heightRange) === JSON.stringify(KONFIG.produkte[id]?.hoehe), `Höhenbereich ${id}`);
}
check(gleich(Object.keys(G.PATTERNS), KONFIG.muster), 'Muster');
check(gleich(Object.keys(G.FLOWS), KONFIG.verlauf), 'Verläufe');
check(gleich(Object.keys(G.RIMS), KONFIG.rand), 'Ränder');
check(gleich(Object.keys(G.FONTS), KONFIG.schrift), 'Schriften');
check(gleich(Object.keys(G.TEXT_STYLES), KONFIG.stil), 'Gravur-Stile');
{
  const html = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const regler = { 's-width': 'width', 's-ribs': 'ribs', 's-depth': 'depth', 's-twist': 'twist', 's-flowwaves': 'flowWaves', 's-textsize': 'textSize', 's-textpos': 'textPos' };
  for (const [id, k] of Object.entries(regler)) {
    const m = html.match(new RegExp(`id="${id}" min="([-\\d.]+)" max="([-\\d.]+)"`));
    check(m && +m[1] >= ZAHLEN[k][0] && +m[2] <= ZAHLEN[k][1], `Regler ${id} (${m?.[1]}–${m?.[2]}) im Bereich ${ZAHLEN[k].join('–')}`);
  }
  const app = readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const dr = [...app.matchAll(/min: ([\d.]+), max: ([\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  check(dr.length >= 5 && dr.every(([lo, hi]) => lo >= ZAHLEN.depth[0] && hi <= ZAHLEN.depth[1]), 'Tiefen-Bereiche je Muster (app.js) im Bereich');
}

// ---------------------------------------------------------------------------
// B) Server
// ---------------------------------------------------------------------------
const frei = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
let PORT = 0;
for (const p of [4506, 4507, 4508, 4509]) if (await frei(p)) { PORT = p; break; }
if (!PORT) { console.log('✗ kein freier Port 4506–4509'); process.exit(1); }
const DIR = path.join(ROOT, 'tmp-tests', `test-eingaben-${process.pid}`);
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const DATA = path.join(DIR, 'data'), ORDERS = path.join(DIR, 'orders');   // legt der Server selbst an (Rechte aus seiner umask)
const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, ORDERS_DIR: ORDERS }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', (c) => { log += c; }); srv.stderr.on('data', (c) => { log += c; });
const BASE = `http://127.0.0.1:${PORT}`;
const ende = (code) => { srv.kill(); setTimeout(() => { rmSync(DIR, { recursive: true, force: true }); process.exit(code); }, 300); };
process.on('uncaughtException', (e) => { console.log('✗ Abbruch:', e); ende(1); });

async function req(method, pfad, body, headers = {}) {
  const h = { ...headers };
  let data;
  if (Buffer.isBuffer(body)) data = body;
  else if (body !== undefined && body !== null) { data = typeof body === 'string' ? body : JSON.stringify(body); h['content-type'] ||= 'application/json'; }
  const t = performance.now();
  const r = await fetch(BASE + pfad, { method, headers: h, body: data, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: r.status, h: Object.fromEntries(r.headers), json, text, ms: performance.now() - t };
}
const ADMIN = { 'x-admin-key': 'formsam-admin' };
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/pricing`)).ok) break; } catch { /* startet noch */ } await new Promise((r) => setTimeout(r, 200)); }

console.log(`B1 Schutz-Kopfzeilen (Instanz auf Port ${PORT})`);
for (const p of ['/', '/api/pricing', '/admin', '/js/app.js', '/gibtsnicht', '/api/gibtsnicht']) {
  const r = await req('GET', p, null, { accept: 'text/html' });
  check(r.h['x-content-type-options'] === 'nosniff' && r.h['x-frame-options'] === 'SAMEORIGIN' && r.h['referrer-policy'] === 'strict-origin-when-cross-origin'
    && r.h['content-security-policy'] === "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" && !/script-src/.test(r.h['content-security-policy'] || ''), `${p}: nosniff, SAMEORIGIN, Referrer-Policy, CSP (ohne script-src)`, r.h);
}
check((await req('GET', '/api/pricing')).h['cache-control'] === 'no-store', '/api/* → Cache-Control: no-store');
{
  const r = await req('GET', '/admin', null, { 'accept-encoding': 'gzip' });
  check(r.status === 200 && r.h['content-encoding'] === 'gzip' && !!r.h.etag && /<title>/.test(r.text), '/admin wie /admin.html (gzip, ETag)');
}

console.log('B2 Kaputte Eingaben → 400/413 statt 500');
const reg = await req('POST', '/api/auth/register', { name: 'Erika Test', email: 'erika@test.example', password: 'geheim123' });
check(reg.status === 200 && reg.json?.token, 'Registrierung gültig → 200');
const AUTH = { 'x-auth': reg.json?.token || '' };
for (const p of ['/api/auth/register', '/api/auth/login', '/api/auth/address', '/api/quote', '/api/design', '/api/list', '/api/checkout']) {
  const st = [];
  for (const b of ['{kaputt', 'null', '[]', '']) st.push((await req('POST', p, b === '' ? undefined : b, { 'content-type': 'application/json', ...AUTH })).status);
  check(st.every((s) => s === 400), `${p}: kaputt/null/[]/leer → 400`, st);
}
for (const p of ['/api/admin/settings', '/api/admin/order-update', '/api/admin/line-print', '/api/admin/order-status']) {
  const r = await req('POST', p, '{kaputt', { 'content-type': 'application/json', ...ADMIN });
  check(r.status === 400 && r.json?.error === 'Ungültige Anfrage', `${p}: kaputt → 400 „Ungültige Anfrage“`, r.status);
}
check(Object.keys((await req('GET', '/api/admin/data', null, ADMIN)).json?.settings || {}).length > 0, 'Admin-Daten nach kaputten Anfragen unverändert lesbar');
for (const mb of [5, 30]) {
  const r = await req('POST', '/api/quote', JSON.stringify({ items: [], pad: 'x'.repeat(mb * 1024 * 1024) }));
  check(r.status === 413 && r.json?.error === 'Anfrage zu groß', `${mb} MB an /api/quote → 413 mit Antwort`, r.status);
}
{
  const r = await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: '/api/checkout', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, t }));
    });
    rq.on('error', (e) => resolve({ status: 'ERR ' + e.code }));
    rq.end(Buffer.alloc(6 * 1024 * 1024, 0x61));
  });
  check(r.status === 413, '6 MB an /api/checkout (Route mit eigenem try/catch) → 413', r);
}
check((await req('GET', '/api/pricing')).status === 200, 'Server läuft danach weiter');

console.log('B3 Methoden, 404, Pfade');
for (const [m, p] of [['DELETE', '/index.html'], ['PROPFIND', '/index.html'], ['POST', '/'], ['POST', '/admin'], ['PUT', '/js/app.js']]) {
  const r = await req(m, p);
  check(r.status === 405 && r.h.allow === 'GET, HEAD', `${m} ${p} → 405 + Allow`, r.status);
}
{
  const r = await req('DELETE', '/api/auth/me', null, AUTH);
  check(r.status === 405 && r.json && r.h.allow === 'GET, HEAD', 'DELETE /api/auth/me → 405 (JSON)', r.status);
  check((await req('GET', '/api/auth/me', null, AUTH)).status === 200, 'GET /api/auth/me → 200');
  const hd = await req('HEAD', '/');
  check(hd.status === 200 && hd.text === '', 'HEAD / → 200 ohne Inhalt');
}
{
  const r = await req('GET', '/gibtsnicht', null, { accept: 'text/html' });
  check(r.status === 404 && /text\/html/.test(r.h['content-type']) && /Diese Seite gibt es nicht/.test(r.text) && /href="\/impressum"/.test(r.text)
    && /href="\/datenschutz"/.test(r.text) && /#f4efe7/.test(r.text) && /<svg class="logo"|wortmarke/.test(r.text), '404-Seite im formsam-Look (Logo, Shop-Link, Impressum/Datenschutz)');
  const n = await req('GET', '/gibts/nicht', null, { accept: 'text/html' });
  check(n.status === 404 && /Diese Seite gibt es nicht/.test(n.text) && !/href="(?!\/|#)[^"]*\.css/.test(n.text), 'verschachtelter Pfad: dieselbe Seite, ohne relative Verweise');
  const a = await req('GET', '/api/gibtsnicht');
  check(a.status === 404 && a.json?.ok === false, '/api/gibtsnicht → 404 JSON');
  const i = await req('GET', '/img/gibtsnicht.png', null, { accept: 'image/*' });
  check(i.status === 404 && /text\/plain/.test(i.h['content-type']) && i.text.length < 40, 'fehlendes Bild → kurzer Text-404');
  for (const p of ['/Impressum', '/impressum.html', '/DATENSCHUTZ/']) {
    const l = await req('GET', p, null, { accept: 'text/html' });
    check(l.status === 301 && /^\/(impressum|datenschutz)$/.test(l.h.location), `${p} → 301 ${l.h.location}`);
  }
}
for (const p of ['/..%2fpackage.json', '/js/..%2f..%2fserver.js', '/..%5cserver.js', '/x%00.js', '/%2e%2e/server.js']) {
  const r = await req('GET', p);
  // %2e%2e als ganzes Segment löst schon der URL-Parser auf (→ /server.js in public/ → 404)
  check((r.status === 400 || (p.startsWith('/%2e') && r.status === 404)) && !/"name": "formsam"|import http/.test(r.text), `${p} → ${r.status}`);
}
{
  const js = await req('GET', '/js/app.js', null, { 'accept-encoding': 'gzip' });
  const roh = await req('GET', '/js/app.js', null, { 'accept-encoding': 'identity' });
  check(js.h.etag && roh.h.etag && js.h.etag !== roh.h.etag && js.h.vary === 'Accept-Encoding', 'gzip- und Rohfassung mit eigenem ETag, Vary');
  for (const inm of [js.h.etag, `W/${js.h.etag}`, `"x", ${js.h.etag}`, '*']) {
    check((await req('GET', '/js/app.js', null, { 'accept-encoding': 'gzip', 'if-none-match': inm })).status === 304, `If-None-Match ${inm.slice(0, 20)} → 304`);
  }
  check((await req('GET', '/js/app.js', null, { 'accept-encoding': 'gzip', 'if-none-match': '"anders"' })).status === 200, 'fremder ETag → 200');
}

console.log('B4 ReDoS über HTTP (Antwort < 50 ms, Server nicht blockiert)');
{
  const boese = [{ product: 'vase', qty: 1, color: 'gibtsnicht', colorName: 'x·' + ' '.repeat(1500) + '(', config: { ...VASE, color: 'gibtsnicht' } }];
  const r = await req('POST', '/api/quote', { items: boese });
  check(r.status === 400 && r.ms < 50, `/api/quote colorName 1503 Zeichen → ${r.status} in ${r.ms.toFixed(0)} ms`);
  const lang = [{ ...boese[0], colorName: 'x·' + ' '.repeat(60) + '(' }];
  const r2 = await req('POST', '/api/quote', { items: lang });
  check(r2.status === 400 && r2.ms < 50, `/api/quote colorName 63 Zeichen (unbekannt) → ${r2.status} in ${r2.ms.toFixed(0)} ms`);
  const r3 = await req('POST', '/api/auth/register', { name: 'Rudi R', email: 'a@' + '.'.repeat(15000) + '@', password: 'geheim123' });
  check(r3.status === 400 && r3.ms < 50, `Registrierung E-Mail 15 KB → ${r3.status} in ${r3.ms.toFixed(0)} ms`);
}

console.log('B5 Kontodaten');
for (const [lbl, b] of [['Name <img>', { name: '<img\tsrc=x\tonerror=alert(1)>' }], ['Name 1 Zeichen', { name: 'A' }], ['Name 81', { name: 'N'.repeat(81) }],
  ['E-Mail komma', { email: 'komma,test@x.example' }], ['E-Mail klammer', { email: 'klammer(x)@x.example' }], ['E-Mail 255', { email: 'a'.repeat(245) + '@x.example' }]]) {
  const r = await req('POST', '/api/auth/register', { name: 'Gültig Name', email: `neu${Math.random().toString(36).slice(2)}@test.example`, password: 'geheim123', ...b });
  check(r.status === 400 && /Namen|E-Mail/.test(r.json?.error || ''), `Registrierung ${lbl} → 400`, r.json);
}
for (const [lbl, b, ok] of [['Typen', { street: { a: 1 }, zip: 12345, city: ['x'] }, false], ['Straße 121', { street: 'S'.repeat(121) }, false],
  ['PLZ 11', { zip: '12345678901' }, false], ['gültig', { street: 'Weg 1', zip: '12345', city: 'Ort' }, true]]) {
  const r = await req('POST', '/api/auth/address', b, AUTH);
  check(ok ? r.status === 200 : r.status === 400, `Adresse ${lbl} → ${r.status}`, r.json);
}
{
  const me = await req('GET', '/api/auth/me', null, AUTH);
  check(JSON.stringify(me.json?.user?.address) === '{"street":"Weg 1","zip":"12345","city":"Ort"}', 'gespeicherte Adresse als Text');
}

console.log('B6 Design-Codes und Vorschaubilder');
for (const [cfg, k] of UNGUELTIG.filter(([c]) => c && !Array.isArray(c) && c.product === 'vase').slice(0, 12)) {
  const r = await req('POST', '/api/design', { config: cfg });
  check(r.status === 400, `neues Design ungültig (${k}) → 400`, r.json);
}
{
  const eb = await req('POST', '/api/design', { config: { ...VASE, product: 'eierbecher', preset: 'kelch', height: 58 } });
  check(eb.status === 400 && /Eierbecher/.test(eb.json?.error || ''), 'neues Eierbecher-Design bei abgeschaltetem Produkt → 400');
  const fa = await req('POST', '/api/design', { config: { ...VASE, color: 'gibtsnicht' } });
  check(fa.status === 400, 'neues Design mit unbekannter Farbe → 400');
  const pt = await req('POST', '/api/design', { config: { ...VASE, preset: 'eigene', customPoints: [null] } });
  check(pt.status === 400, 'customPoints [null] → 400 (nicht 500)');
  const ok = await req('POST', '/api/design', { config: VASE });
  check(ok.status === 200 && /^[A-Z0-9]{6,}$/.test(ok.json?.code || ''), 'gültiges Design → Code');
  const code = ok.json?.code;
  check((await req('POST', '/api/design', { config: VASE })).json?.code === code, 'gleiches Design → gleicher Code');
  check((await req('GET', `/api/design/${code}`)).json?.config?.pattern === 'rippen', 'Code lädt');
  const jpeg = (b) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, b)]).toString('base64');
  const html = 'data:image/jpeg;base64,' + Buffer.from('<html><script>alert(1)</script>kein JPEG').toString('base64');
  check((await req('PUT', `/api/design/${code}/thumb`, html, { 'content-type': 'text/plain' })).status === 400, 'HTML als „JPEG“ → 400');
  check((await req('PUT', `/api/design/${code}/thumb`, jpeg(1), { 'content-type': 'text/plain' })).status === 200, 'erstes Vorschaubild → 200');
  const zwei = await req('PUT', `/api/design/${code}/thumb`, jpeg(2), { 'content-type': 'text/plain' });
  const bild = readFileSync(path.join(DATA, 'thumbs', `${code}.jpg`));
  check(zwei.status === 200 && bild[10] === 1, 'zweites Vorschaubild ersetzt das erste nicht');
  const g = await fetch(`${BASE}/api/design/${code}/thumb`);
  check(g.status === 200 && g.headers.get('content-type') === 'image/jpeg' && g.headers.get('x-content-type-options') === 'nosniff', 'Vorschaubild mit nosniff');
  check((await req('PUT', '/api/design/ZZZZZZ/thumb', jpeg(3), { 'content-type': 'text/plain' })).status === 404, 'unbekannter Code → 404');
  const l = await req('POST', '/api/list', { name: 'Hochzeit\u0000 Anna', note: { x: 1 }, items: [{ code, qty: 2 }] });
  check(l.status === 200 && /^Hochzeit +Anna$/.test(l.json?.list?.name || '') && l.json?.list?.note === '', 'Liste: Steuerzeichen raus, Notiz nur Text', l.json?.list);
}

console.log('B7 Kasse');
const KUNDE = { name: 'Erika Mustermann', email: 'kunde@test.example', street: 'Teststraße 12', zip: '12345', city: 'Teststadt', note: '' };
const pos = (it = {}) => ({ product: 'vase', qty: 1, saucer: false, color: 'elfenbein', colorName: 'Elfenbein', code: null, ...it, config: { ...VASE, ...(it.config || {}) } });
for (const [lbl, it] of [['Höhe 5000', { config: { height: 5000 } }], ['Muster unbekannt', { config: { pattern: 'gibtsnicht' } }],
  ['constructor/toString/valueOf', { config: { preset: 'constructor', textStyle: 'toString', rim: 'valueOf' } }],
  ['colorHex url()', { config: { colorHex: 'red;background-image:url(/css-leak)' } }], ['Farbname 3000', { colorName: 'E'.repeat(3000) }],
  ['Gravur 3000', { config: { text: 'G'.repeat(3000) } }], ['Farbe unbekannt', { color: 'gibtsnicht', colorName: 'Gibtsnicht', config: { color: 'gibtsnicht' } }],
  ['Produkt unbekannt', { product: 'tasse' }], ['Position null', null]]) {
  const items = [it === null ? null : pos(it)];
  const q = await req('POST', '/api/quote', { items });
  const c = await req('POST', '/api/checkout', { customer: KUNDE, items, payment: 'vorkasse', beschaffenheit: true, mitSchluessel: true, expectedTotal: 1 });
  check(q.status === 400 && c.status === 400 && c.json?.error, `${lbl} → Quote ${q.status}, Kasse ${c.status}`, c.json?.error);
}
{
  const items = [pos({ qty: 2 }), pos({ color: null, colorName: 'Gold (metallic)', config: { pattern: 'gehaemmert', depth: 1.2, text: 'Anna & Tom', textStyle: 'farbe', textColor: 'tiefschwarz', color: 'gold' } })];
  const q = await req('POST', '/api/quote', { items });
  check(q.status === 200 && q.json?.total > 0, `Angebot → ${q.json?.total} €`, q.json);
  const c = await req('POST', '/api/checkout', { customer: KUNDE, items, payment: 'vorkasse', beschaffenheit: true, mitSchluessel: true, expectedTotal: q.json?.total });
  check(c.status === 200 && c.json?.orderId, `Kasse → ${c.json?.orderId}`, c.json);
  const { orderId, accessKey, itemCount } = c.json || {};
  const stl = Buffer.alloc(134); stl.writeUInt32LE(1, 80);
  for (let i = 0; i < (itemCount || 0); i++) check((await req('PUT', `/api/order/${orderId}/stl/${i}`, stl, { 'x-order-key': accessKey, 'content-type': 'application/octet-stream' })).status === 200, `Modell ${i + 1} hochgeladen`);
  const done = await req('POST', `/api/order/${orderId}/complete`, {}, { 'x-order-key': accessKey });
  check(done.status === 200 && /^RE-/.test(done.json?.invoiceNo || ''), `Abschluss → ${done.json?.invoiceNo}`);
  const beleg = await req('GET', done.json?.invoiceUrl || '/x');
  check(beleg.status === 200 && beleg.h['referrer-policy'] === 'no-referrer' && beleg.h['x-content-type-options'] === 'nosniff', 'Rechnung: Referrer-Policy no-referrer bleibt, nosniff dazu');
  check((await req('GET', `/orders/${orderId}/rechnung.html`, null, { accept: 'text/html' })).status === 404, 'Rechnung ohne Schlüssel weiter 404');

  console.log('B8 Dateirechte (umask 077)');
  const modus = (p) => (statSync(p).mode & 0o777).toString(8);
  const dateien = [DATA, path.join(DATA, 'settings.json'), path.join(DATA, 'users.json'), path.join(DATA, 'sessions.json'), path.join(DATA, 'designs.json'),
    path.join(DATA, 'thumbs'), path.join(DATA, 'thumbs', readdirSync(path.join(DATA, 'thumbs'))[0]), ORDERS, path.join(ORDERS, orderId),
    path.join(ORDERS, orderId, 'order.json'), path.join(ORDERS, orderId, 'rechnung.html')];
  for (const f of dateien) {
    const m = existsSync(f) ? modus(f) : '-';
    check(m === (statSync(f).isDirectory() ? '700' : '600'), `${path.relative(DIR, f)}: ${m}`);
  }
}
check(!/Serverfehler|TypeError|SyntaxError/.test(log), 'kein Serverfehler im Protokoll', log.split('\n').filter((l) => /Error/.test(l)).slice(0, 3));

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
ende(fail ? 1 : 0);
