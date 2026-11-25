// formsam — Prüfung Datenhaltung, Admin-Passwort, Bremsen, Uploads, Aufräumen und Konto-Funktionen (Paket „daten“).
// Startet eigene Shop-Instanzen (DATA_DIR/ORDERS_DIR unter tmp-tests/test-daten, freier Port, TRUST_PROXY=1, Mail aus) — der echte
// Shop und seine Daten bleiben unberührt. Aufruf: node tools/test-daten.mjs   → Exit 0 = alles in Ordnung, 1 = Abweichung
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = path.resolve(process.env.TEST_DIR || path.join(ROOT, 'tmp-tests', 'test-daten'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fehler = 0;
const pruefe = (name, ok, detail = '') => { if (!ok) fehler++; console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 500) : ''}`); };
const freierPort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

// --- Instanz: frische Ordner, optional vorbereitete Dateien
function ordner(name, dateien = {}) {
  const dir = path.join(BASE, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  for (const [f, inhalt] of Object.entries(dateien)) {
    const ziel = path.join(dir, f);
    mkdirSync(path.dirname(ziel), { recursive: true });
    writeFileSync(ziel, typeof inhalt === 'string' ? inhalt : JSON.stringify(inhalt, null, 2));
  }
  return dir;
}
const SETTINGS = (extra = {}) => ({ adminKey: 'test-admin-123', company: { name: 'formsam', email: 'shop@example.invalid', owner: 'Test' }, mail: { enabled: false, adminTo: 'admin@example.invalid', adminCopy: true }, ...extra });
async function starte(dir) {
  const port = Number(process.env.PORT) || await freierPort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'data'), ORDERS_DIR: path.join(dir, 'orders'), TRUST_PROXY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '', exit = null;
  proc.stdout.on('data', (c) => { log += c; });
  proc.stderr.on('data', (c) => { log += c; });
  proc.on('exit', (code) => { exit = code ?? -1; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150 && exit === null; i++) {
    try { if ((await fetch(`${base}/api/pricing`)).ok) break; } catch { /* startet noch */ }
    await sleep(100);
  }
  const inst = {
    base, proc, get log() { return log; }, get exit() { return exit; },
    async req(method, pfad, body, headers = {}) {
      const h = { ...headers };
      let data;
      if (Buffer.isBuffer(body)) { data = body; h['content-type'] ||= 'application/octet-stream'; } else if (body !== undefined && body !== null) { data = JSON.stringify(body); h['content-type'] = 'application/json'; }
      const r = await fetch(base + pfad, { method, headers: h, body: data });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* kein JSON */ }
      return { status: r.status, json, text };
    },
    async stop() { if (exit === null) { proc.kill('SIGTERM'); for (let i = 0; i < 50 && exit === null; i++) await sleep(50); } },
  };
  return inst;
}
const von = (ip) => ({ 'x-forwarded-for': ip });
const admin = (key, ip = '192.0.2.1') => ({ 'x-admin-key': key, ...von(ip) });
const VASE = { product: 'vase', preset: 'flasche', height: 150, width: 1, pattern: 'rippen', ribs: 48, depth: 0.9, twist: 0, flow: 'spirale', flowWaves: 3, text: '', textSize: 7, textPos: 0.55, textStyle: 'gepraegt', font: 'helvetiker', customPoints: null, saucer: false, color: 'elfenbein' };
const KUNDE = { name: 'Erika Test', email: 'kunde@example.invalid', street: 'Teststraße 1', zip: '12345', city: 'Teststadt', note: '' };
function stl(n = 1) { const b = Buffer.alloc(84 + 50 * n); b.write('formsam test', 0, 'ascii'); b.writeUInt32LE(n, 80); return b; }
async function kasse(s, ip, extra = {}, headers = {}) {
  const items = [{ product: 'vase', qty: 1, saucer: false, config: VASE, color: VASE.color, colorName: 'Elfenbein', code: null }];
  const q = await s.req('POST', '/api/quote', { items }, von(ip));
  return s.req('POST', '/api/checkout', { customer: { ...KUNDE, ...extra }, items, payment: 'vorkasse', beschaffenheit: true, mitSchluessel: true, expectedTotal: q.json?.total }, { ...von(ip), ...headers });
}
const mails = async (s, key) => (await s.req('GET', '/api/admin/mail-log?limit=500', null, admin(key, '192.0.2.250'))).json?.entries || [];
const zaehle = (l) => l.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
/** adminKey in settings.json ist der Platzhalter (kein Passwort; eine ältere Fassung sperrt damit, statt „formsam-admin“ zu nehmen) */
const platzhalter = (st) => typeof st.adminKey === 'string' && st.adminKey.length >= 24 && st.adminKeyPlatzhalter === crypto.createHash('sha256').update(st.adminKey).digest('hex');
/** viele Anfragen wirklich gleichzeitig (eigene Verbindungen) → Statuscodes in Reihenfolge */
const agent = new http.Agent({ keepAlive: false, maxSockets: 1000 });
function parallel(s, n, f) {
  return Promise.all(Array.from({ length: n }, (_, i) => new Promise((ok) => {
    const { method = 'GET', pfad, headers = {}, body } = f(i);
    const data = body ? JSON.stringify(body) : null;
    const t0 = Date.now();
    const q = http.request(`${s.base}${pfad}`, { method, agent, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => { res.resume(); res.on('end', () => ok({ st: res.statusCode, ms: Date.now() - t0 })); });
    q.on('error', () => ok({ st: 'ERR', ms: Date.now() - t0 }));
    q.end(data);
  })));
}

try {
  // 1. Neuinstallation: zufälliges Admin-Passwort einmal im Protokoll, kein bekanntes Standard-Passwort
  {
    const dir = ordner('neu');
    const s = await starte(dir);
    const pw = (s.log.match(/neues Admin-Passwort[^:]*: (\S+)/) || [])[1];
    const st = JSON.parse(readFileSync(path.join(dir, 'data/settings.json'), 'utf8'));
    pruefe('Neuinstallation: zufälliges Passwort im Protokoll, nur Hash (+ Platzhalter) in settings.json', !!pw && /^scrypt\$/.test(st.adminKeyHash) && platzhalter(st) && st.adminKey !== pw, s.log.slice(-400));
    pruefe('Neuinstallation: „formsam-admin“ gilt nicht', (await s.req('GET', '/api/admin/data', null, admin('formsam-admin'))).status === 401);
    pruefe('Neuinstallation: das ausgegebene Passwort gilt', (await s.req('GET', '/api/admin/data', null, admin(pw))).status === 200);
    await s.stop();
  }

  // 2. Kaputte Datendateien: Start bricht ab, Datei bleibt unverändert; sessions.json wird beiseitegelegt
  for (const f of ['settings.json', 'users.json', 'designs.json', 'lists.json', 'paypal-captures.json']) {
    const kaputt = '{"users": [{"id": "abgeschnitten';
    const dir = ordner(`kaputt-${f}`, { 'data/settings.json': SETTINGS(), [`data/${f}`]: kaputt });
    const s = await starte(dir);
    for (let i = 0; i < 40 && s.exit === null; i++) await sleep(100);
    pruefe(`kaputte ${f}: Start abgebrochen mit Meldung, Datei unverändert`, s.exit === 1 && /Start abgebrochen/.test(s.log) && s.log.includes(f) && readFileSync(path.join(dir, 'data', f), 'utf8') === kaputt, `exit ${s.exit} ${s.log.slice(-300)}`);
    await s.stop();
  }
  {
    const dir = ordner('kaputt-sessions', { 'data/settings.json': SETTINGS(), 'data/sessions.json': '{"abc": {"userId"' });
    const s = await starte(dir);
    const beiseite = readdirSync(path.join(dir, 'data')).filter((x) => x.startsWith('sessions.json.defekt-'));
    pruefe('kaputte sessions.json: Shop startet, Datei als .defekt-… gesichert, Warnung', s.exit === null && beiseite.length === 1 && /sessions\.json beschädigt/.test(s.log), s.log.slice(-300));
    await s.stop();
  }

  // 3. Hauptinstanz: Klartext-Passwort wird umgestellt; Bremsen; Konto; Uploads; Aufräumen
  const tage = (n) => new Date(Date.now() - n * 864e5).toISOString();
  const alt = (id, extra = {}) => ({ orderId: id, createdAt: tage(15), status: 'neu', payment: 'vorkasse', paymentStatus: 'offen', paidAt: null, customer: KUNDE, lines: [], invoiceNo: null, filesComplete: false, trackingNo: '', adminNote: '', accessKey: 'x', ...extra });
  const dir = ordner('haupt', {
    'data/settings.json': SETTINGS(),
    'orders/FS-261101-AAAA01/order.json': alt('FS-261101-AAAA01'),                                              // abgebrochen → weg
    'orders/FS-261101-AAAA01/modell-1-vase.stl': stl(),
    'orders/FS-261101-AAAA02/order.json': alt('FS-261101-AAAA02', { invoiceNo: 'RE-2026-0001', completedAt: tage(15) }), // Rechnung
    'orders/FS-261101-AAAA03/order.json': alt('FS-261101-AAAA03', { paymentStatus: 'bezahlt', paidAt: tage(14) }),       // bezahlt
    'orders/FS-261101-AAAA04/order.json': alt('FS-261101-AAAA04', { payment: 'paypal', paypalOrderId: 'PAYPAL123456' }), // PayPal
    'orders/FS-261101-AAAA05/order.json': alt('FS-261101-AAAA05', { createdAt: tage(3) }),                               // jung
    'orders/FS-261101-AAAA06/order.json': alt('FS-261101-AAAA06', { adminNote: 'Kundin ruft an' }),                     // Notiz
    'orders/FS-261101-AAAA07/order.json': alt('FS-261101-AAAA07', { status: 'storniert' }),                             // Status
    'orders/FS-261101-AAAA08/order.json': (({ invoiceNo, ...o }) => o)(alt('FS-261101-AAAA08')),                        // Altbestand
    'orders/FS-261101-AAAA09/order.json': '{"orderId": "FS-261101-AAAA09", "createdAt": "2026-',                       // kaputt
    'orders/FS-261101-AAAA02/modell-1-vase.stl': stl(),                                                                 // mit Rechnung → bleibt
    'orders/FS-261101-AAAA10/order.json': alt('FS-261101-AAAA10', { createdAt: tage(3) }),                               // 3 Tage → Dateien weg
    'orders/FS-261101-AAAA10/modell-1-vase.stl': stl(),
    'orders/FS-261101-AAAA10/modell-2-vase.stl.upload-1-a.tmp': stl(),
    'orders/FS-261101-AAAA11/order.json': alt('FS-261101-AAAA11', { createdAt: tage(1 / 24) }),                          // 1 Stunde → bleibt
    'orders/FS-261101-AAAA11/modell-1-vase.stl': stl(),
  });
  utimesSync(path.join(dir, 'orders/FS-261101-AAAA10/modell-2-vase.stl.upload-1-a.tmp'), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  const s = await starte(dir);
  const st = JSON.parse(readFileSync(path.join(dir, 'data/settings.json'), 'utf8'));
  pruefe('Klartext-adminKey beim Start in Hash umgestellt (adminKey nur noch Platzhalter), Passwort gilt weiter', platzhalter(st) && !JSON.stringify(st).includes('test-admin-123') && /^scrypt\$/.test(st.adminKeyHash) && (await s.req('GET', '/api/admin/data', null, admin('test-admin-123'))).status === 200);
  const d = (await s.req('GET', '/api/admin/data', null, admin('test-admin-123'))).json;
  pruefe('Admin-Daten ohne adminKey/adminKeyHash/adminKeyPlatzhalter', d && !/adminKey/.test(JSON.stringify(d.settings)));
  pruefe('beschädigte order.json als Hinweis im Admin', (d?.hinweise || []).some((h) => h.includes('FS-261101-AAAA09')), d?.hinweise);
  pruefe('Druckzettel nicht mehr mit ?k=<Admin-Passwort>', (await s.req('GET', '/admin/druckzettel/FS-261101-AAAA02?k=test-admin-123')).status === 401);

  // Aufräumen läuft 5 s nach dem Start
  for (let i = 0; i < 80 && !/Abgebrochene Kasse FS-261101-AAAA01/.test(s.log); i++) await sleep(100);
  await sleep(300);
  const da = (id) => existsSync(path.join(dir, 'orders', id));
  pruefe('abgebrochene Kasse nach 14 Tagen samt Ordner gelöscht, Protokollzeile', !da('FS-261101-AAAA01') && /Abgebrochene Kasse FS-261101-AAAA01/.test(s.log), s.log.slice(-400));
  pruefe('Rechnung, Zahlung, PayPal, jung, Notiz, Status, Altbestand, kaputt: bleiben', ['02', '03', '04', '05', '06', '07', '08', '09'].every((n) => da(`FS-261101-AAAA${n}`)));
  const inOrdner = (id) => (da(id) ? readdirSync(path.join(dir, 'orders', id)).sort().join() : '–');
  pruefe('nie abgeschlossene Kasse nach 48 h: Druck- und Temp-Dateien weg, order.json bleibt, Protokollzeile', inOrdner('FS-261101-AAAA10') === 'order.json' && /Druckdateien der nie abgeschlossenen Kasse FS-261101-AAAA10/.test(s.log), inOrdner('FS-261101-AAAA10'));
  pruefe('Druckdateien einer jungen Kasse und einer Bestellung mit Rechnung bleiben', inOrdner('FS-261101-AAAA11') === 'modell-1-vase.stl,order.json' && inOrdner('FS-261101-AAAA02') === 'modell-1-vase.stl,order.json', [inOrdner('FS-261101-AAAA11'), inOrdner('FS-261101-AAAA02')]);

  // Admin-Bremse: IPv6 /64 teilt sich einen Zähler, andere Netze kommen durch; IPv4-mapped = IPv4
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await s.req('GET', '/api/admin/data', null, admin(`falsch-${i}`, `2001:db8:1:2::${i + 1}`))).status);
  pruefe('Admin: 10 Fehlversuche aus einem /64 → 401', codes.every((c) => c === 401), codes);
  pruefe('Admin: 11. Versuch aus demselben /64 (andere Adresse) → 429', (await s.req('GET', '/api/admin/data', null, admin('falsch-x', '2001:db8:1:2:ffff::7'))).status === 429);
  pruefe('Admin: richtiges Passwort aus dem gesperrten /64 → 429', (await s.req('GET', '/api/admin/data', null, admin('test-admin-123', '2001:0db8:0001:0002::99'))).status === 429);
  pruefe('Admin: richtiges Passwort aus anderem Netz → 200', (await s.req('GET', '/api/admin/data', null, admin('test-admin-123', '2001:db8:9:9::1'))).status === 200);
  for (let i = 0; i < 10; i++) await s.req('GET', '/api/admin/data', null, admin(`falsch-${i}`, '::ffff:198.51.100.7'));
  pruefe('Admin: ::ffff:198.51.100.7 und 198.51.100.7 teilen den Zähler', (await s.req('GET', '/api/admin/data', null, admin('falsch', '198.51.100.7'))).status === 429);
  // Parallel: Fehlversuche zählen schon beim Start der Prüfung — aus einer IP höchstens 10 Prüfungen, das richtige Passwort im Schub → 429;
  // eine einzelne IP kann die Gesamtbremse nicht einschalten
  let par = (await parallel(s, 60, (i) => ({ pfad: '/api/admin/data', headers: admin(i === 59 ? 'test-admin-123' : `schub-${i}`, '198.51.100.60') }))).map((x) => x.st);
  pruefe('Admin parallel: 60 Versuche aus einer IP → höchstens 10× 401, Rest 429, richtiges Passwort am Ende → 429', (zaehle(par)[401] || 0) <= 10 && par.every((c) => c === 401 || c === 429) && par[59] === 429, zaehle(par));
  par = (await parallel(s, 150, (i) => ({ pfad: '/api/admin/data', headers: admin(`schub-${i}`, '198.51.100.61') }))).map((x) => x.st);
  const tipp = await s.req('GET', '/api/admin/data', null, admin('vertippt', '198.51.100.62'));
  pruefe('Admin parallel: 150 Fehlversuche aus einer IP schalten die Gesamtbremse nicht ein (Tippfehler, dann richtig → 200)', tipp.status === 401 && (await s.req('GET', '/api/admin/data', null, admin('test-admin-123', '198.51.100.62'))).status === 200, zaehle(par));
  // Gesamtbremse: insgesamt 100 Fehlversuche → jede IP nur noch ein Fehlversuch; wer das Passwort kennt, kommt durch
  for (let i = 0; i < 90; i++) await s.req('GET', '/api/admin/data', null, admin('falsch', `203.0.113.${i + 1}`));
  await s.req('GET', '/api/admin/data', null, admin('falsch', '198.18.0.1'));
  pruefe('Admin-Gesamtbremse: zweiter Versuch derselben IP → 429', (await s.req('GET', '/api/admin/data', null, admin('test-admin-123', '198.18.0.1'))).status === 429);
  pruefe('Admin-Gesamtbremse: neue IP mit richtigem Passwort → 200', (await s.req('GET', '/api/admin/data', null, admin('test-admin-123', '198.18.0.2'))).status === 200);
  const K = (ip = '192.0.2.200') => admin('test-admin-123', ip);

  // Admin-Passwort ändern: nur Hash, altes gilt sofort nicht mehr
  let r = await s.req('POST', '/api/admin/settings', { adminKey: 'kurz' }, K());
  pruefe('Admin-Passwort unter 8 Zeichen → 400', r.status === 400);
  r = await s.req('POST', '/api/admin/settings', { adminKey: 'neues-admin-456' }, K());
  const st2 = JSON.parse(readFileSync(path.join(dir, 'data/settings.json'), 'utf8'));
  pruefe('Admin-Passwort geändert: altes 401, neues 200, kein Klartext', r.status === 200 && (await s.req('GET', '/api/admin/data', null, K('192.0.2.201'))).status === 401
    && (await s.req('GET', '/api/admin/data', null, admin('neues-admin-456', '192.0.2.202'))).status === 200 && !JSON.stringify(st2).includes('neues-admin-456') && platzhalter(st2));
  const KEY = 'neues-admin-456';
  const A = (ip = '192.0.2.210') => admin(KEY, ip);

  // Registrierung: je Empfänger 3 Konten am Tag, auch über wechselnde IPs
  r = await s.req('POST', '/api/auth/register', { name: 'Kurt Kurz', email: 'kurz@example.invalid', password: '1234567' }, von('10.1.0.1'));
  pruefe('Registrierung: Passwort unter 8 Zeichen → 400', r.status === 400);
  const regCodes = [];
  for (let i = 0; i < 4; i++) {
    r = await s.req('POST', '/api/auth/register', { name: 'Rita Mehrfach', email: 'rita@example.invalid', password: 'rita-passwort' }, von(`10.2.0.${i + 1}`));
    regCodes.push(r.status);
    if (r.json?.token) await s.req('POST', '/api/auth/delete', { passwort: 'rita-passwort' }, { 'x-auth': r.json.token, ...von(`10.2.0.${i + 1}`) });
  }
  pruefe('Registrierung: 4. Konto für dieselbe Adresse am Tag → 429', regCodes.join() === '200,200,200,429', regCodes);
  const ipCodes = [];
  for (let i = 0; i < 6; i++) ipCodes.push((await s.req('POST', '/api/auth/register', { name: 'Ina IP', email: `ip${i}@example.invalid`, password: 'ina-passwort' }, von('2001:db8:5:5::1'))).status);
  pruefe('Registrierung: 6. Versuch je IP und Stunde → 429', ipCodes.slice(0, 5).every((c) => c === 200) && ipCodes[5] === 429, ipCodes);

  // Anmeldung: je IP + Konto 10 Fehlversuche, das Konto selbst bleibt von anderer IP erreichbar
  const lc = [];
  for (let i = 0; i < 11; i++) lc.push((await s.req('POST', '/api/auth/login', { email: 'ip0@example.invalid', password: `falsch${i}` }, von('10.3.0.1'))).status);
  pruefe('Anmeldung: 11. Fehlversuch je IP + Konto → 429', lc.slice(0, 10).every((c) => c === 401) && lc[10] === 429, lc);
  r = await s.req('POST', '/api/auth/login', { email: 'ip0@example.invalid', password: 'ina-passwort' }, von('10.3.0.2'));
  pruefe('Anmeldung: Inhaberin von anderer IP → 200 (kein Aussperren)', r.status === 200);
  const tok = r.json?.token;
  const lc2 = [];
  for (let i = 0; i < 31; i++) lc2.push((await s.req('POST', '/api/auth/login', { email: `x${i}@example.invalid`, password: 'egal-egal' }, von('10.3.0.9'))).status);
  pruefe('Anmeldung: 31. Fehlversuch je IP (verschiedene Konten) → 429', lc2[29] === 401 && lc2[30] === 429, lc2.slice(-3));
  par = (await parallel(s, 60, (i) => ({ method: 'POST', pfad: '/api/auth/login', headers: von('10.3.1.1'), body: { email: 'ip1@example.invalid', password: i === 59 ? 'ina-passwort' : `schub-${i}` } }))).map((x) => x.st);
  pruefe('Anmeldung parallel: 60 Versuche aus einer IP → höchstens 10× 401, richtiges Passwort am Ende → 429', (zaehle(par)[401] || 0) <= 10 && par[59] === 429, zaehle(par));
  pruefe('Anmeldung parallel: Inhaberin von anderer IP → 200', (await s.req('POST', '/api/auth/login', { email: 'ip1@example.invalid', password: 'ina-passwort' }, von('10.3.1.2'))).status === 200);

  // Konto: Passwort ändern (andere Sitzungen enden, Mail), überall abmelden, Datenexport, löschen (Bestellungen bleiben ohne Kontobezug)
  const tok2 = (await s.req('POST', '/api/auth/login', { email: 'ip0@example.invalid', password: 'ina-passwort' }, von('10.4.0.1'))).json?.token;
  const co = await kasse(s, '10.4.0.1', { email: 'ip0@example.invalid' }, { 'x-auth': tok2 });
  r = await s.req('POST', '/api/auth/password', { altesPasswort: 'falsch-falsch', neuesPasswort: 'ina-neu-12345' }, { 'x-auth': tok2, ...von('10.4.0.1') });
  pruefe('Passwort ändern mit falschem altem Passwort → 400', r.status === 400);
  r = await s.req('POST', '/api/auth/password', { altesPasswort: 'ina-passwort', neuesPasswort: 'ina-neu-12345' }, { 'x-auth': tok2, ...von('10.4.0.1') });
  pruefe('Passwort ändern → 200, andere Sitzung beendet, eigene bleibt', r.status === 200 && (await s.req('GET', '/api/auth/me', null, { 'x-auth': tok })).status === 401 && (await s.req('GET', '/api/auth/me', null, { 'x-auth': tok2 })).status === 200);
  await sleep(200);
  pruefe('Mail „Passwort geändert“ im Protokoll', (await mails(s, KEY)).some((m) => m.kind === 'passwort-geaendert' && m.to === 'ip0@example.invalid'));
  const users = (await s.req('GET', '/api/admin/users', null, A())).json?.users || [];
  const ina = users.find((u) => u.email === 'ip0@example.invalid');
  r = await s.req('GET', `/api/admin/user-export?id=${ina?.id}`, null, A());
  pruefe('Admin: Datenexport ohne Passwort-Hash, mit Bestellung', r.status === 200 && r.json?.konto?.email === 'ip0@example.invalid' && r.json.bestellungen?.some((o) => o.orderId === co.json?.orderId) && !/"(hash|salt|accessKey)"/.test(r.text), r.text.slice(0, 300));
  const gast = await kasse(s, '10.4.6.1', { email: 'olga@example.invalid', street: 'Geheimweg 7' });
  await s.req('POST', '/api/auth/register', { name: 'Mallory Fremd', email: 'olga@example.invalid', password: 'mallory-pw-1' }, von('10.4.6.2'));
  const mallory = ((await s.req('GET', '/api/admin/users', null, A())).json?.users || []).find((u) => u.email === 'olga@example.invalid');
  r = await s.req('GET', `/api/admin/user-export?id=${mallory?.id}`, null, A());
  pruefe('Admin: Datenexport eines Kontos mit unbestätigter Adresse ohne fremde Gastbestellung', r.status === 200 && !!gast.json?.orderId && !r.text.includes(gast.json.orderId) && !r.text.includes('Geheimweg'), r.text.slice(0, 300));
  const tok3 = (await s.req('POST', '/api/auth/login', { email: 'ip0@example.invalid', password: 'ina-neu-12345' }, von('10.4.0.2'))).json?.token;
  r = await s.req('POST', '/api/auth/logout-all', null, { 'x-auth': tok3 });
  pruefe('Auf allen Geräten abmelden → alle Sitzungen weg', r.status === 200 && (await s.req('GET', '/api/auth/me', null, { 'x-auth': tok2 })).status === 401 && (await s.req('GET', '/api/auth/me', null, { 'x-auth': tok3 })).status === 401);
  r = await s.req('POST', '/api/admin/user-delete', { id: ina?.id }, A());
  const order = JSON.parse(readFileSync(path.join(dir, 'orders', co.json?.orderId || 'x', 'order.json'), 'utf8'));
  pruefe('Admin: Konto löschen → Anmeldung 401, Bestellung bleibt ohne Kontobezug', r.status === 200 && (await s.req('POST', '/api/auth/login', { email: 'ip0@example.invalid', password: 'ina-neu-12345' }, von('10.4.0.3'))).status === 401
    && order.userId === null && order.history.some((h) => /Kundenkonto gelöscht/.test(h.note || '')));

  // Passwortwechsel: je Konto 5 je Stunde; Hinweis-Mail an eine unbestätigte Adresse höchstens 1 am Tag; Name nur, wenn er wie ein Name aussieht
  r = await s.req('POST', '/api/auth/register', { name: 'Gewinn⠀abholen:⠀https://phish.example/preis Nachname', email: 'pw-flut@example.invalid', password: 'flut-0-passwort' }, von('10.4.5.1'));
  const pwc = [];
  for (let i = 0, n = 0; i < 6; i++) {
    const x = await s.req('POST', '/api/auth/password', { altesPasswort: `flut-${n}-passwort`, neuesPasswort: `flut-${n + 1}-passwort` }, { 'x-auth': r.json?.token, ...von('10.4.5.1') });
    pwc.push(x.status); if (x.status === 200) n++;
  }
  await sleep(200);
  pruefe('Passwort ändern: 6. Wechsel je Konto und Stunde → 429', pwc.join() === '200,200,200,200,200,429', pwc);
  pruefe('„Passwort geändert“ an eine unbestätigte Adresse höchstens 1 am Tag', (await mails(s, KEY)).filter((m) => m.kind === 'passwort-geaendert' && m.to === 'pw-flut@example.invalid').length === 1);
  const outbox = readFileSync(path.join(dir, 'data/mail-outbox.json'), 'utf8');
  pruefe('Mails an die Kontoadresse ohne fremden Text aus dem Kontonamen (Willkommen, Passwort geändert)', outbox.includes('pw-flut@example.invalid') && !/phish\.example/.test(outbox));

  // Passwortwechsel-Bremse zählt gelungene Wechsel, nicht Versuche: Tippfehler und zu kurze neue Passwörter sperren nicht
  r = await s.req('POST', '/api/auth/register', { name: 'Tina Tipp', email: 'tipp@example.invalid', password: 'tipp-0-passwort' }, von('10.4.7.1'));
  const tpc = [];
  for (let i = 0; i < 3; i++) tpc.push((await s.req('POST', '/api/auth/password', { altesPasswort: `vertippt-${i}`, neuesPasswort: 'tipp-1-passwort' }, { 'x-auth': r.json?.token, ...von('10.4.7.1') })).status);
  for (let i = 0; i < 2; i++) tpc.push((await s.req('POST', '/api/auth/password', { altesPasswort: 'tipp-0-passwort', neuesPasswort: 'kurz' }, { 'x-auth': r.json?.token, ...von('10.4.7.1') })).status);
  tpc.push((await s.req('POST', '/api/auth/password', { altesPasswort: 'tipp-0-passwort', neuesPasswort: 'tipp-1-passwort' }, { 'x-auth': r.json?.token, ...von('10.4.7.1') })).status);
  pruefe('Passwort ändern: 3 falsche alte + 2 zu kurze neue, danach der erste echte Wechsel → 200', tpc.join() === '400,400,400,400,400,200', tpc);


  // Schlüsselflut aus einer IP verdrängt keine fremden Zähler: IP X ist nach 10 falschen Admin-Passwörtern gesperrt, IP Y meldet sich
  // 11000-mal mit immer neuer Adresse an (früher: LRU mit 5000 Schlüsseln → alle Sperren weg) — X bleibt gesperrt, Y ist nach 30 gebremst
  for (let i = 0; i < 12; i++) await s.req('GET', '/api/admin/data', null, admin(`flut-${i}`, '192.0.2.88'));
  pruefe('Flut: IP X nach 12 falschen Admin-Passwörtern gesperrt (richtiges → 429)', (await s.req('GET', '/api/admin/data', null, admin(KEY, '192.0.2.88'))).status === 429);
  const flut = {};
  for (let runde = 0; runde < 22; runde++) {
    const st = await parallel(s, 500, (i) => ({ method: 'POST', pfad: '/api/auth/login', headers: von('198.51.100.99'), body: { email: `flut-${runde}-${i}@example.invalid`, password: 'egal-egal' } }));
    for (const x of st) flut[x.st] = (flut[x.st] || 0) + 1;
  }
  pruefe('Flut: 11000 Anmeldungen mit neuer Adresse aus IP Y → höchstens 30× 401, sonst 429', (flut[401] || 0) <= 30 && (flut[429] || 0) >= 10970, flut);
  pruefe('Flut: IP X bleibt gesperrt (richtiges Admin-Passwort → 429)', (await s.req('GET', '/api/admin/data', null, admin(KEY, '192.0.2.88'))).status === 429);
  pruefe('Flut: Konto-Bremse anderer IPs bleibt (11. Fehlversuch 10.3.0.1 / ip0 → 429)', (await s.req('POST', '/api/auth/login', { email: 'ip0@example.invalid', password: 'falsch-11' }, von('10.3.0.1'))).status === 429);
  pruefe('Flut: Admin von anderer IP weiter erreichbar → 200', (await s.req('GET', '/api/admin/data', null, admin(KEY, '192.0.2.89'))).status === 200);

  // Passwort vergessen: 4. Anforderung → 200 ohne Mail; die bisherigen Links bleiben gültig
  await s.req('POST', '/api/auth/register', { name: 'Vera V', email: 'vera@example.invalid', password: 'vera-passwort' }, von('10.5.0.1'));
  const fc = [];
  for (let i = 0; i < 4; i++) fc.push((await s.req('POST', '/api/auth/forgot', { email: 'vera@example.invalid' }, von(`10.5.1.${i}`))).status);
  await sleep(200);
  pruefe('Passwort vergessen: 4. Anforderung → 200, nur 3 Mails', fc.every((c) => c === 200) && (await mails(s, KEY)).filter((m) => m.kind === 'passwort-reset' && m.to === 'vera@example.invalid').length === 3, fc);

  // Widerruf: über der Gesamtgrenze gespeichert, Shop informiert, aber keine Kundenmail
  for (let i = 0; i < 31; i++) await s.req('POST', '/api/widerruf', { name: 'Willi Widerruf', email: `w${i}@example.invalid`, nachricht: 'Test' }, von(`10.6.0.${i + 1}`));
  await sleep(300);
  const ml = await mails(s, KEY);
  const wr = (await s.req('GET', '/api/admin/widerrufe', null, A())).json?.widerrufe || [];
  pruefe('Widerruf: 31. Eingang gespeichert und gemeldet, Eingangsbestätigung entfällt', wr.length === 31 && wr.filter((w) => w.bestaetigungGebremst).length === 1
    && ml.filter((m) => m.kind === 'widerruf').length === 30 && ml.filter((m) => m.kind === 'admin-widerruf').length === 31);
  r = await s.req('POST', '/api/widerruf', { name: 'Ina IP', email: 'ip0@example.invalid', orderId: co.json?.orderId, nachricht: 'Ich widerrufe.' }, von('10.6.1.1'));
  await sleep(300);
  pruefe('Widerruf mit passender Bestellnummer und Adresse: Eingangsbestätigung trotz Gesamtbremse', r.status === 200 && (await mails(s, KEY)).some((m) => m.kind === 'widerruf' && m.to === 'ip0@example.invalid'));

  // Designs: neue Codes je IP gebremst, bekannte nicht; Abrufzähler schreibt nicht bei jedem Abruf
  let d429 = 0;
  for (let i = 0; i < 305; i++) if ((await s.req('POST', '/api/design', { config: { ...VASE, height: 100 + i * 0.2 } }, von('10.7.0.1'))).status === 429) d429++;
  r = await s.req('POST', '/api/design', { config: VASE }, von('10.7.0.1'));
  pruefe('Design-Codes: 301. neuer Code je IP und Stunde → 429, bekannter weiter 200', d429 === 5 && r.status === 200, `${d429} × 429`);

  // Kasse: 21. Kasse je IP und Stunde → 429
  const kc = [];
  for (let i = 0; i < 21; i++) kc.push((await kasse(s, '10.8.0.1')).status);
  pruefe('Kasse: 21. Kasse je IP und Stunde → 429', kc.slice(0, 20).every((c) => c === 200) && kc[20] === 429, kc.slice(-3));

  // Uploads: Inhalt geprüft, Abschluss nur vollständig, danach unveränderlich
  const b = (await kasse(s, '10.9.0.1')).json;
  const OK = { 'x-order-key': b.accessKey, ...von('10.9.0.1') };
  pruefe('Abschluss ohne Druckdatei → 409', (await s.req('POST', `/api/order/${b.orderId}/complete`, {}, OK)).status === 409);
  pruefe('leere Druckdatei → 400', (await s.req('PUT', `/api/order/${b.orderId}/stl/0`, Buffer.alloc(0), OK)).status === 400);
  pruefe('HTML statt STL → 400', (await s.req('PUT', `/api/order/${b.orderId}/stl/0`, Buffer.from('<html>'.padEnd(300, 'x')), OK)).status === 400);
  pruefe('abgeschnittene Binär-STL → 400', (await s.req('PUT', `/api/order/${b.orderId}/stl/0`, stl(3).subarray(0, 150), OK)).status === 400);
  const gross = await new Promise((ok) => {   // Kopf kündigt 200 MB an, gesendet wird nur der Anfang — der Server lehnt vorher ab
    const q = http.request(`${s.base}/api/order/${b.orderId}/stl/0`, { method: 'PUT', headers: { ...OK, 'content-type': 'model/stl', 'content-length': 200_000_000 } }, (res) => { res.resume(); ok(res.statusCode); });
    q.on('error', () => ok('abgebrochen'));
    q.write(Buffer.alloc(64 * 1024));
  });
  pruefe('angekündigte Größe über der Grenze → 413', gross === 413, gross);
  pruefe('gültige Binär-STL → 200', (await s.req('PUT', `/api/order/${b.orderId}/stl/0`, stl(5), OK)).status === 200);
  pruefe('keine Temp-Dateien im Bestellordner', !readdirSync(path.join(dir, 'orders', b.orderId)).some((f) => f.endsWith('.tmp')));
  r = await s.req('POST', `/api/order/${b.orderId}/complete`, {}, OK);
  pruefe('Abschluss mit gültiger Datei → 200 mit Rechnung', r.status === 200 && !!r.json?.invoiceNo);
  pruefe('Upload nach dem Abschluss → 409', (await s.req('PUT', `/api/order/${b.orderId}/stl/0`, stl(5), OK)).status === 409);
  await sleep(200);
  const om = (await mails(s, KEY)).filter((m) => m.ref === b.orderId).map((m) => m.kind).sort().join();
  pruefe('Abschluss: Bestätigung und Admin-Kopie im Mail-Protokoll', om === 'admin-neu,bestaetigung', om);

  // Upload-Bremse (4 GB je IP und Stunde): die angekündigte Größe zählt ab dem Start — 23 gleichzeitige Uploads à 180 MB → der 23. sofort 429;
  // abgebrochene geben ihren Anteil wieder frei, keine Temp-Dateien
  const zwoelf = async (ip) => {
    const items = Array.from({ length: 12 }, (_, i) => ({ product: 'vase', qty: 1, saucer: false, config: { ...VASE, height: 120 + i * 5 }, color: VASE.color, colorName: 'Elfenbein', code: null }));
    const q = await s.req('POST', '/api/quote', { items }, von(ip));
    return (await s.req('POST', '/api/checkout', { customer: KUNDE, items, payment: 'vorkasse', beschaffenheit: true, mitSchluessel: true, expectedTotal: q.json?.total }, von(ip))).json;
  };
  const kassen = [await zwoelf('10.9.1.1'), await zwoelf('10.9.1.1')];
  const offen = [], antwort = [];
  for (let j = 0; j < 23; j++) {
    const k = kassen[j < 12 ? 0 : 1];
    const q = http.request(`${s.base}/api/order/${k.orderId}/stl/${j % 12}`, { method: 'PUT', agent, headers: { ...von('10.9.1.1'), 'x-order-key': k.accessKey, 'content-type': 'model/stl', 'content-length': 84 + 50 * 3_600_000 } }, (res) => { res.resume(); antwort[j] = res.statusCode; });
    q.on('error', () => { antwort[j] ??= 'abgebrochen'; });
    q.write(stl(1).subarray(0, 84));
    offen.push(q);
    await sleep(20);
  }
  await sleep(700);
  pruefe('Upload-Bremse: 23. gleichzeitiger Upload à 180 MB → sofort 429, die anderen laufen', antwort[22] === 429 && antwort.slice(0, 22).every((x) => x === undefined), antwort);
  for (const q of offen) q.destroy();
  await sleep(500);
  pruefe('Upload-Bremse: abgebrochene Uploads geben ihren Anteil frei, keine Temp-Dateien', (await s.req('PUT', `/api/order/${kassen[0].orderId}/stl/0`, stl(5), { 'x-order-key': kassen[0].accessKey, ...von('10.9.1.1') })).status === 200
    && !kassen.some((k) => readdirSync(path.join(dir, 'orders', k.orderId)).some((f) => f.endsWith('.tmp'))));

  // Last: 400 falsche Admin-Passwörter gleichzeitig aus 400 Netzen — scrypt belegt höchstens 2 Threads, Dateien kommen weiter schnell
  const schub = parallel(s, 400, (i) => ({ pfad: '/api/admin/data', headers: admin(`last-${i}`, `10.${100 + Math.floor(i / 200)}.${i % 200}.1`) }));
  await sleep(100);
  const t0 = Date.now();
  const app = await s.req('GET', '/js/app.js');
  const appMs = Date.now() - t0;
  const sz = zaehle((await schub).map((x) => x.st));
  pruefe('Last: /js/app.js während 400 gleichzeitiger Admin-Rateversuche schnell (< 1 s), Überzahl → 429', app.status === 200 && appMs < 1000 && (sz[429] || 0) > 0, { appMs, ...sz });
  await s.stop();
  // Neustart: Hash bleibt (Platzhalter erkannt, keine neue Umstellung), geänderte Daten sind lesbar
  const s2 = await starte(dir);
  pruefe('Neustart: Daten lesbar, neues Admin-Passwort gilt, Platzhalter nicht umgestellt', s2.exit === null && (await s2.req('GET', '/api/admin/data', null, A('192.0.2.220'))).status === 200 && !/Klartext/.test(s2.log));
  await s2.stop();
  // Ältere Fassung (nach Rückkehr per git) setzt adminKey im Klartext → die neue übernimmt es beim nächsten Start als Passwort
  const st3 = JSON.parse(readFileSync(path.join(dir, 'data/settings.json'), 'utf8'));
  writeFileSync(path.join(dir, 'data/settings.json'), JSON.stringify({ ...st3, adminKey: 'aus-alter-fassung-1' }));
  const s3 = await starte(dir);
  pruefe('adminKey von einer älteren Fassung geändert → wird übernommen und wieder zum Platzhalter', (await s3.req('GET', '/api/admin/data', null, admin('aus-alter-fassung-1', '192.0.2.221'))).status === 200
    && (await s3.req('GET', '/api/admin/data', null, A('192.0.2.222'))).status === 401 && platzhalter(JSON.parse(readFileSync(path.join(dir, 'data/settings.json'), 'utf8'))));
  await s3.stop();

  // Gleichzeitige Anfragen mit dem richtigen Admin-Passwort teilen sich die laufende Prüfung (frische Instanz, ohne Gesamtbremse):
  // nach 9 eigenen Tippfehlern und bei aktiver Gesamtbremse ohne Tippfehler → 200 + 200 (früher 200 + 429)
  {
    const dir = ordner('admin-parallel', { 'data/settings.json': SETTINGS() });
    const s = await starte(dir);
    for (let i = 0; i < 9; i++) await s.req('GET', '/api/admin/data', null, admin(`tipp-${i}`, '192.0.2.77'));
    let par = (await parallel(s, 2, () => ({ pfad: '/api/admin/data', headers: admin('test-admin-123', '192.0.2.77') }))).map((x) => x.st);
    pruefe('Admin: nach 9 Tippfehlern zwei gleichzeitige Anfragen mit richtigem Passwort → 200 + 200', par.join() === '200,200', par);
    for (let i = 0; i < 100; i++) await s.req('GET', '/api/admin/data', null, admin('falsch', `203.0.${113 + (i % 10)}.${i + 1}`));
    par = (await parallel(s, 2, () => ({ pfad: '/api/admin/data', headers: admin('test-admin-123', '198.18.5.5') }))).map((x) => x.st);
    pruefe('Admin: Gesamtbremse aktiv, Inhaber ohne Tippfehler, zwei gleichzeitige Anfragen → 200 + 200', par.join() === '200,200', par);
    await s.stop();
  }
} catch (err) {
  fehler++;
  console.error('❌ Abbruch:', err);
}
if (!process.env.TEST_BEHALTEN) rmSync(BASE, { recursive: true, force: true });
console.log(fehler ? `\n${fehler} Abweichung(en)` : '\nAlles in Ordnung.');
process.exit(fehler ? 1 : 0);
