#!/usr/bin/env node
// formsam — Prüfung PayPal-Einzug (/api/paypal/create, /api/paypal/capture/<id>) gegen eine PayPal-Attrappe — ohne Netz.
//   node tools/test-paypal.mjs   → Exit 0 = alles in Ordnung, 1 = Abweichung
// Startet server.js mit eigenem DATA_DIR/ORDERS_DIR unter tmp-tests/test-paypal/ (freier Port, Mail aus) und lädt vorher
// (node --import) eine Attrappe, die fetch für *.paypal.com ersetzt: Token, Anlegen, Einzug, Nachfrage. Meldet sich die Attrappe
// nicht, bricht der Test vor der ersten Anfrage ab — es geht nie eine Anfrage an PayPal.
// Geprüft: PayPal aus → 400 ohne Aufruf; unbekannte/ungültige ID → 404 ohne Aufruf; gleichzeitige Einzüge derselben ID → ein
// Aufruf; schon eingezogen → 200 ohne Aufruf; Zugriffstoken wird wiederverwendet; jeder Aufruf mit Zeitlimit; Einzug ohne Antwort
// → nach dem Zeitlimit Nachfrage bei PayPal (COMPLETED → 200); Kasse mit eingezogener Zahlung legt die Bestellung an.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'tmp-tests', 'test-paypal');
const LOG = path.join(DIR, 'paypal-aufrufe.log');
const STUB = path.join(DIR, 'paypal-attrappe.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freierPort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
let pass = 0, fail = 0;
const check = (ok, l, d) => { if (ok) pass++; else fail++; console.log(`${ok ? '  ✓' : '❌'} ${l}${!ok && d !== undefined ? ` — ${JSON.stringify(d).slice(0, 500)}` : ''}`); };
const aufrufe = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : []);

// Attrappe: ersetzt fetch für PayPal-Hosts (kein Netz), andere Ziele unverändert; je Aufruf eine Zeile in PP_LOG
const ATTRAPPE = `import { appendFileSync } from 'node:fs';
const echt = globalThis.fetch, LOG = process.env.PP_LOG, haengt = process.env.PP_MODUS === 'haengt';
const eingezogen = new Set();
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!/^https:\\/\\/[^/]*paypal\\.com\\//.test(u)) return echt(url, opts);
  appendFileSync(LOG, (opts.method || 'GET') + ' ' + u.replace(/^https:\\/\\/[^/]+/, '') + ' signal=' + !!opts.signal + '\\n');
  if (/\\/v1\\/oauth2\\/token$/.test(u)) return json(200, { access_token: 'TOKEN-' + Date.now(), expires_in: 32400 });
  if (/\\/v2\\/checkout\\/orders$/.test(u)) return json(201, { id: 'PPTEST' + Math.random().toString(36).slice(2, 10).toUpperCase(), status: 'CREATED' });
  let m = u.match(/\\/v2\\/checkout\\/orders\\/([A-Z0-9]+)\\/capture$/);
  if (m) {
    if (haengt) await new Promise((_, nein) => opts.signal?.addEventListener('abort', () => nein(new Error('Zeitlimit'))));
    if (eingezogen.has(m[1])) return json(422, { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
    eingezogen.add(m[1]);
    await new Promise((r) => setTimeout(r, 300));
    return json(201, { id: m[1], status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP' + m[1], amount: { value: process.env.PP_BETRAG, currency_code: 'EUR' } }] } }] });
  }
  m = u.match(/\\/v2\\/checkout\\/orders\\/([A-Z0-9]+)$/);
  if (m) return json(200, { id: m[1], status: eingezogen.has(m[1]) || haengt ? 'COMPLETED' : 'APPROVED', purchase_units: [{ amount: { value: process.env.PP_BETRAG, currency_code: 'EUR' }, payments: { captures: [{ id: 'CAP' + m[1], amount: { value: process.env.PP_BETRAG, currency_code: 'EUR' } }] } }] });
  return json(404, {});
};
console.log('PAYPAL-ATTRAPPE AKTIV');
`;
const VASE = { product: 'vase', preset: 'flasche', height: 150, width: 1, pattern: 'rippen', ribs: 48, depth: 0.9, twist: 0, flow: 'spirale', flowWaves: 3, text: '', textSize: 7,
  textPos: 0.55, textStyle: 'gepraegt', font: 'helvetiker', customPoints: null, saucer: false, colorFinish: 'matt', color: 'elfenbein' };
const KUNDE = { name: 'Paula PayPal', email: 'paula@example.invalid', street: 'Teststraße 1', zip: '12345', city: 'Teststadt', note: '' };
const items = [{ product: 'vase', qty: 1, saucer: false, config: VASE, color: VASE.color, colorName: 'Elfenbein', code: null }];

let srv = null;
async function starte({ modus = 'ok', paypal = true, betrag = '29.80' } = {}) {
  if (srv) { const weg = new Promise((r) => srv.once('exit', r)); srv.kill('SIGTERM'); await weg; }
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(path.join(DIR, 'data'), { recursive: true }); mkdirSync(path.join(DIR, 'orders'), { recursive: true });
  writeFileSync(STUB, ATTRAPPE);
  writeFileSync(LOG, '');
  writeFileSync(path.join(DIR, 'data', 'settings.json'), JSON.stringify({ adminKey: 'test-paypal-admin', mail: { enabled: false },
    paypal: { enabled: paypal, sandbox: true, clientId: 'ATTRAPPE-CLIENT', secret: 'ATTRAPPE-SECRET' } }));
  const port = await freierPort();
  let out = '';
  srv = spawn(process.execPath, ['--import', STUB, 'server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(DIR, 'data'), ORDERS_DIR: path.join(DIR, 'orders'), PP_LOG: LOG, PP_MODUS: modus, PP_BETRAG: betrag, PAYPAL_TIMEOUT_MS: '2000' } });
  srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !/PAYPAL-ATTRAPPE AKTIV/.test(out); i++) await sleep(50);
  if (!/PAYPAL-ATTRAPPE AKTIV/.test(out)) { srv.kill('SIGKILL'); throw new Error('PayPal-Attrappe nicht geladen – Abbruch vor der ersten Anfrage'); }
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/pricing`)).ok) break; } catch { /* startet noch */ } await sleep(100); }
  const req = async (method, pfad, body) => {
    const r = await fetch(base + pfad, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { /* kein JSON */ }
    return { status: r.status, json };
  };
  return { req, log: () => out };
}
async function anlegen(s) {
  const q = await s.req('POST', '/api/quote', { items });
  return s.req('POST', '/api/paypal/create', { customer: KUNDE, items, payment: 'paypal', paypalOrderId: null, couponCode: null, beschaffenheit: true, mitSchluessel: true, expectedTotal: q.json?.total });
}

try {
  let s = await starte({ paypal: false });
  let r = await s.req('POST', '/api/paypal/capture/ABCDEFGHIJ123456');
  check(r.status === 400 && aufrufe().length === 0, 'PayPal aus: Einzug → 400 ohne Aufruf bei PayPal', [r.status, aufrufe()]);

  const betrag = (await (await starte()).req('POST', '/api/quote', { items })).json?.total;
  s = await starte({ betrag: Number(betrag).toFixed(2) });
  r = await s.req('POST', '/api/paypal/capture/ABCDEFGHIJ123456');
  check(r.status === 404 && /nichts abgebucht/.test(r.json?.error || '') && aufrufe().length === 0, 'unbekannte ID → 404 ohne Aufruf bei PayPal', [r.status, r.json, aufrufe()]);
  r = await s.req('POST', '/api/paypal/capture/kurz');
  check(r.status === 404 && aufrufe().length === 0, 'ungültige ID → 404 ohne Aufruf', r.status);
  const c1 = await anlegen(s);
  check(c1.status === 200 && /^PPTEST/.test(c1.json?.id || ''), '/api/paypal/create legt die Zahlung an', c1.json);
  const id = c1.json?.id;
  const par = await Promise.all([1, 2, 3].map(() => s.req('POST', `/api/paypal/capture/${id}`)));
  const cap = aufrufe().filter((l) => /\/capture /.test(l));
  check(par.every((x) => x.status === 200) && cap.length === 1, '3 gleichzeitige Einzüge derselben ID → alle 200, ein Aufruf bei PayPal', { st: par.map((x) => x.status), cap });
  const vorher = aufrufe().length;
  r = await s.req('POST', `/api/paypal/capture/${id}`);
  check(r.status === 200 && aufrufe().length === vorher, 'schon eingezogen → 200 ohne neuen Aufruf', aufrufe().slice(vorher));
  const c2 = await anlegen(s);
  await s.req('POST', `/api/paypal/capture/${c2.json?.id}`);
  check(aufrufe().filter((l) => /oauth2\/token/.test(l)).length === 1, 'Zugriffstoken wiederverwendet (ein Abruf für 2 Anlagen und 2 Einzüge)', aufrufe());
  check(aufrufe().length > 0 && aufrufe().every((l) => /signal=true/.test(l)), 'jeder PayPal-Aufruf mit Zeitlimit', aufrufe());
  const q = await s.req('POST', '/api/quote', { items });
  const co = await s.req('POST', '/api/checkout', { customer: KUNDE, items, payment: 'paypal', paypalOrderId: id, couponCode: null, beschaffenheit: true, mitSchluessel: true, expectedTotal: q.json?.total });
  check(co.status === 200 && !!co.json?.orderId, 'Kasse mit eingezogener Zahlung legt die Bestellung an', co.json);

  s = await starte({ modus: 'haengt', betrag: Number(betrag).toFixed(2) });
  const c3 = await anlegen(s);
  const t0 = Date.now();
  r = await s.req('POST', `/api/paypal/capture/${c3.json?.id}`);
  const ms = Date.now() - t0;
  check(r.status === 200 && ms >= 1900 && ms < 10000 && aufrufe().some((l) => /^GET \/v2\/checkout\/orders\/PPTEST/.test(l)) && /Einzug .* ohne Antwort/.test(s.log()),
    'Einzug ohne Antwort: nach dem Zeitlimit Nachfrage bei PayPal (COMPLETED → 200), Meldung im Protokoll', { st: r.status, ms, a: aufrufe() });
} catch (err) {
  fail++;
  console.log('❌ Abbruch:', err?.stack || err);
} finally {
  if (srv) { const weg = new Promise((r) => srv.once('exit', r)); srv.kill('SIGTERM'); await Promise.race([weg, sleep(3000)]); }
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
