// formsam — Prüfung Rechtstexte, Wartungsmodus und öffentliche Adresse (eigene Shop-Instanz, eigene Daten unter tmp-tests/)
//   node tools/test-recht.mjs            → Exit 0 = alles ok, 1 = Fehler
// Startet server.js auf einem freien Port mit DATA_DIR/ORDERS_DIR unter tmp-tests/test-recht-<pid>/ (Mail aus, TRUST_PROXY=1)
// und räumt danach auf. Geprüft: Widerrufsbelehrung nach Muster (Gestaltungshinweis 3, Ausschluss getrennt), Datenschutz je
// Einstellung (Hoster/AV-Vertrag, Mailversand, Zugangs-Cookie, Sicherungen), Migration älterer Einstellungen (auch vom früheren
// stillen IONOS-Standard, mit Neustart), absolute Links im Mail-Anhang, Canonical/og-Adressen der Startseite,
// robots.txt/sitemap.xml, Produkthinweise aus einer Quelle (Kasse, Häkchen, Rechnung, order.json) und das Wartungstor
// (freie Rechtsseiten/Belege/Widerruf, ..%2f, Weiterleitungsziel auch mit Punktsegmenten, Cookie mit Ablauf, wachsende
// Bremse, Secure hinter dem Proxy, API-503 ohne Retry-After, robots.txt nur kurz gültig).
// Die Instanz läuft mit WARTUNG_BREMSE_S=1 (Grundpause der Bremse 1 s statt 30 s), damit die wachsende Pause prüfbar ist.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderLegalPage } from '../lib/legal.js';
import { HINWEIS, BESCHAFFENHEIT_TEXTE, BESCHAFFENHEIT_FASSUNG, produktHinweise } from '../lib/produkthinweise.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'tmp-tests', `test-recht-${process.pid}`);
const DATA = path.join(DIR, 'data'), ORDERS = path.join(DIR, 'orders');
const KEY = 'test-recht-admin';
const BREMSE_S = 1;   // Grundpause der Wartungs-Bremse in dieser Instanz (Server-Standard 30 s)
let pass = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
};
const norm = (t) => String(t).replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const text = (html) => norm(String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' '));

const freierPort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const PORT = await freierPort();
const BASE = `http://127.0.0.1:${PORT}`;

async function req(method, pfad, body, headers = {}) {
  const h = { ...headers };
  let data;
  if (Buffer.isBuffer(body)) { data = body; h['content-type'] ||= 'application/octet-stream'; }
  else if (typeof body === 'string') { data = body; }
  else if (body !== undefined && body !== null) { data = JSON.stringify(body); h['content-type'] ||= 'application/json'; }
  const r = await fetch(BASE + pfad, { method, headers: h, body: data, redirect: 'manual' });
  const t = await r.text();
  let json = null; try { json = JSON.parse(t); } catch { /* kein JSON */ }
  return { status: r.status, headers: Object.fromEntries(r.headers), setCookie: r.headers.getSetCookie?.() || [], json, text: t };
}
const admin = (method, pfad, body, headers = {}) => req(method, pfad, body, { 'x-admin-key': KEY, ...headers });
/** Rohe Anfrage: Pfad geht unverändert (mit %2f, Tab …) an den Server */
function roh(pfad, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve) => {
    const c = net.connect(PORT, '127.0.0.1');
    let d = '';
    const h = Object.entries({ Host: `127.0.0.1:${PORT}`, Connection: 'close', ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    c.write(`${method} ${pfad} HTTP/1.1\r\n${h}\r\n\r\n${body}`);
    c.on('data', (x) => { d += x; });
    c.on('end', () => {
      const i = d.indexOf('\r\n\r\n'), kopf = d.slice(0, i);
      const hd = (n) => (kopf.match(new RegExp(`^${n}: (.*)$`, 'mi')) || [])[1] ?? null;
      resolve({ status: Number(kopf.split(' ')[1]), kopf, hd, text: d.slice(i + 4) });
    });
    c.on('error', () => resolve({ status: 0, kopf: '', hd: () => null, text: '' }));
  });
}
const form = (o) => new URLSearchParams(o).toString();
const login = (kennwort, ziel = '/', headers = {}) => roh('/__wartung', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: form({ kennwort, ziel }) });

// kleinste gültige Binär-STL (ein Dreieck)
function miniStl() {
  const b = Buffer.alloc(84 + 50);
  b.write('test-stl', 0, 'ascii'); b.writeUInt32LE(1, 80);
  [0, 0, 1, 0, 0, 0, 10, 0, 0, 0, 10, 0].forEach((v, i) => b.writeFloatLE(v, 84 + i * 4));
  return b;
}
const VASE = { product: 'vase', preset: 'flasche', height: 150, width: 1, pattern: 'rippen', ribs: 48, depth: 0.9, twist: 0, flow: 'spirale', flowWaves: 3,
  text: '', textSize: 7, textPos: 0.55, textStyle: 'gepraegt', font: 'helvetiker', customPoints: null, saucer: false, colorFinish: 'matt', color: 'elfenbein' };
async function bestellung(configs) {
  const items = configs.map((c) => ({ product: 'vase', qty: 1, saucer: false, config: { ...VASE, ...c }, color: 'elfenbein', colorName: 'Elfenbein', code: null }));
  const quote = await req('POST', '/api/quote', { items });
  const co = await req('POST', '/api/checkout', { customer: { name: 'Erika Test', email: 'erika@example.test', street: 'Teststraße 1', zip: '12345', city: 'Teststadt', note: '' },
    items, payment: 'vorkasse', paypalOrderId: null, couponCode: null, beschaffenheit: true, mitSchluessel: true, expectedTotal: quote.json?.total });
  if (!co.json?.ok) return { fehler: co.json?.error || co.status };
  const { orderId, accessKey, itemCount } = co.json;
  for (let i = 0; i < itemCount; i++) await req('PUT', `/api/order/${orderId}/stl/${i}`, miniStl(), { 'x-order-key': accessKey });
  const fertig = await req('POST', `/api/order/${orderId}/complete`, {}, { 'x-order-key': accessKey });
  return { orderId, accessKey, fertig: fertig.status };
}

// --- Instanz mit „Bestandseinstellungen“ (legal ohne avVertrag/mailVersand → Migration)
mkdirSync(DATA, { recursive: true }); mkdirSync(ORDERS, { recursive: true });
writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
  adminKey: KEY,
  company: { name: 'formsam', owner: 'Test Inhaber', street: 'Teststraße 9', zip: '12345', city: 'Teststadt', country: 'Deutschland', email: 'hallo@example.test', phone: '+49 30 123456', kleinunternehmer: true, iban: 'DE89 3704 0044 0532 0130 00' },
  legal: { hoster: 'Alt-Hoster GmbH, Weg 1, 10115 Berlin', serverOrt: 'Berlin (Deutschland)' },
  mail: { enabled: false, publicUrl: 'https://shop.example.test' },
}, null, 2));
let srv = null, log = '';
const ende = (code) => { try { srv?.kill(); } catch { /* schon weg */ } try { rmSync(DIR, { recursive: true, force: true }); } catch { /* egal */ } process.exit(code); };
process.on('uncaughtException', (e) => { console.error('Abbruch:', e); console.error(log.slice(-2000)); ende(1); });
/** Server (neu) starten und warten, bis er antwortet */
async function starten() {
  if (srv) { const weg = new Promise((r) => srv.once('exit', r)); srv.kill(); await weg; }
  srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, ORDERS_DIR: ORDERS, TRUST_PROXY: '1', WARTUNG_BREMSE_S: String(BREMSE_S) }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  let bereit = false;
  for (let i = 0; i < 100 && !bereit; i++) { try { bereit = (await fetch(`${BASE}/api/pricing`)).ok; } catch { await new Promise((r) => setTimeout(r, 150)); } }
  if (!bereit) { console.error('Server startet nicht:\n' + log); ende(1); }
}
await starten();

console.log('Migration älterer Einstellungen');
let d = await admin('GET', '/api/admin/data');
check(d.json?.settings?.legal?.avVertrag === true && d.json?.settings?.legal?.mailVersand === 'anbieter', 'eingetragener Hoster gilt als bestätigt, Mailversand wie bisher „anbieter“', d.json?.settings?.legal);
let ds = await req('GET', '/datenschutz');
check(/Alt-Hoster GmbH/.test(ds.text) && /Vertrag zur Auftragsverarbeitung/.test(ds.text) && /E-Mail-Anbieters/.test(ds.text), 'Datenschutz nach dem Update unverändert: Hoster, AV-Satz, E-Mail-Anbieter');

console.log('Startseite, robots.txt, sitemap.xml');
let r = await req('GET', '/', null, { 'accept-encoding': 'gzip' });
const meta = (h, re) => (h.match(re) || [])[1];
check(meta(r.text, /<link rel="canonical" href="([^"]*)"/) === 'https://shop.example.test/', 'Canonical aus der öffentlichen Adresse', meta(r.text, /<link rel="canonical" href="([^"]*)"/));
check(meta(r.text, /property="og:url" content="([^"]*)"/) === 'https://shop.example.test/' && meta(r.text, /property="og:image" content="([^"]*)"/) === 'https://shop.example.test/img/brand/og.jpg'
  && meta(r.text, /name="twitter:image" content="([^"]*)"/) === 'https://shop.example.test/img/brand/og.jpg', 'og:url, og:image, twitter:image aus der öffentlichen Adresse');
check(!/formsam\.de/.test(r.text), 'Startseite ohne formsam.de');
check(r.headers['content-encoding'] === 'gzip' && /^"s-/.test(r.headers.etag || ''), 'gzip und ETag aus dem Inhalt', r.headers);
const etag1 = r.headers.etag;
check((await req('GET', '/', null, { 'if-none-match': etag1 })).status === 304, 'If-None-Match → 304');
check(meta((await req('GET', '/index.html')).text, /<link rel="canonical" href="([^"]*)"/) === 'https://shop.example.test/', '/index.html genauso');
await admin('POST', '/api/admin/settings', { mail: { publicUrl: 'http://localhost:4488' } });
r = await req('GET', '/');
check(meta(r.text, /<link rel="canonical" href="([^"]*)"/) === 'https://www.formsam.com/' && r.headers.etag !== etag1, 'lokale Adresse → Rückfall www.formsam.com, neues ETag', r.headers.etag);
await admin('POST', '/api/admin/settings', { mail: { publicUrl: 'https://shop.example.test' } });
r = await req('GET', '/robots.txt');
check(r.status === 200 && /^text\/plain/.test(r.headers['content-type']), 'robots.txt 200 text/plain', r.status);
check(['/admin', '/orders/', '/api/admin/', '/api/auth/'].every((p) => r.text.includes(`Disallow: ${p}\n`)) && r.text.includes('Sitemap: https://shop.example.test/sitemap.xml'), 'robots.txt sperrt Admin/Belege/Admin-/Konto-API, nennt die Sitemap', r.text);
check(!/Disallow: (\/\n|\/api\/pricing|\/api\/colors|\/content\.json|\/js\/|\/css\/)/.test(r.text), 'robots.txt lässt Preise, Farben, Texte, JS und CSS frei');
r = await req('GET', '/sitemap.xml');
const locs = [...r.text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
check(r.status === 200 && /^application\/xml/.test(r.headers['content-type']) && locs.join() === ['/', '/impressum', '/datenschutz', '/agb', '/widerruf', '/versand'].map((p) => 'https://shop.example.test' + p).join(), 'sitemap.xml mit Startseite und fünf Rechtsseiten', locs);
const stlKopf = (readFileSync(path.join(ROOT, 'public/js/exporter.js'), 'utf8').match(/const header = '([^']*)'/) || [])[1] || '';
check(stlKopf.includes('https://www.formsam.com') && Buffer.byteLength(stlKopf, 'ascii') <= 80 && /^[\x20-\x7e]+$/.test(stlKopf), 'STL-Kopf nennt www.formsam.com (ASCII, ≤ 80 Byte)', stlKopf);

console.log('Widerrufsbelehrung (Muster, Gestaltungshinweis 3)');
const wr = await req('GET', '/widerruf');
const muster = text((wr.text.match(/<section id="belehrung"[\s\S]*?<div class="muster">([\s\S]*?)<\/div>/) || [])[1] || '');
check(muster.includes('Sie können Ihr Widerrufsrecht auch online unter shop.example.test/widerruf#widerrufen ausüben. Wenn Sie diese Online-Funktion nutzen, übermitteln wir Ihnen auf einem dauerhaften Datenträger (z. B. durch eine E-Mail) unverzüglich eine Eingangsbestätigung mit Informationen zum Inhalt der Widerrufserklärung sowie dem Datum und der Uhrzeit ihres Eingangs.'), 'Pflicht-Variante „online unter … ausüben“ mit Eingangsbestätigung', muster.slice(0, 200));
check(wr.text.includes('href="https://shop.example.test/widerruf#widerrufen"'), 'Internetadresse der Widerrufsfunktion verlinkt');
check(!muster.includes('elektronisch ausfüllen und übermitteln') && muster.includes('Brief oder eine E-Mail'), 'kein Baustein für das freiwillige Formular, „oder eine E-Mail“ wie im Muster');
check(!muster.includes('Ausschluss') && /Ende der Widerrufsbelehrung<\/p>\s*<\/div>\s*<h3 id="ausschluss">Ausschluss des Widerrufsrechts<\/h3>/.test(wr.text), 'Ausschluss getrennt unter dem Musterkasten');
check(!/gesetzlichen Wortlaut/.test(wr.text), 'kein „gesetzlicher Wortlaut“ mehr');
const settingsJetzt = JSON.parse(readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
const agbMail = renderLegalPage('agb', { settings: settingsJetzt, baseUrl: 'https://shop.example.test', forMail: true });
const wrMail = renderLegalPage('widerruf', { settings: settingsJetzt, baseUrl: 'https://shop.example.test', forMail: true });
check(!/href="\/(?!\/)/.test(agbMail) && agbMail.includes('href="https://shop.example.test/widerruf#widerrufen"'), 'Mail-Anhang AGB: alle Links absolut', (agbMail.match(/href="\/[^"]*"/g) || []));
check(!/href="\/(?!\/)/.test(wrMail) && /online unter <a[^>]*href="https:\/\/shop\.example\.test\/widerruf#widerrufen"/.test(wrMail), 'Mail-Anhang Widerrufsbelehrung: absolute Links, Online-Adresse');
const agbSeite = (await req('GET', '/agb')).text;
check(agbSeite.includes('<a href="/widerruf#widerrufen">'), 'AGB im Shop behalten relative Links');
const wrLokal = renderLegalPage('widerruf', { settings: settingsJetzt, baseUrl: 'http://localhost:4488', forMail: true });
check(text(wrLokal).includes('online unter dem Punkt „Vertrag widerrufen“ auf der Seite „Widerruf“ unseres Online-Shops ausüben'), 'ohne öffentliche Adresse: geeigneter Hinweis, wo die Funktion ist');

console.log('Datenschutz je Einstellung');
ds = await req('GET', '/datenschutz');
check(/fs_zugang/.test(ds.text) && !/Der Shop setzt keine Cookies\./.test(ds.text), 'Zugangs-Cookie fs_zugang erwähnt');
check(/Sicherungen:<\/strong>[^<]*14 Tagen/.test(ds.text), 'Sicherungen mit 14 Tagen');
await admin('POST', '/api/admin/settings', { legal: { mailVersand: 'eigen' } });
ds = await req('GET', '/datenschutz');
check(/eigener Mailserver/.test(ds.text) && /Protokolle des Mailservers/.test(ds.text) && !/E-Mail-Anbieters|mein E-Mail-Anbieter/.test(ds.text) && /Postfächer meines Mailservers/.test(ds.text), 'Mailversand „eigen“: eigener Mailserver, Postfächer, Protokolle, Sicherung — kein Anbieter');
await admin('POST', '/api/admin/settings', { legal: { mailVersand: 'anbieter', mailAnbieter: 'Beispiel Mail AG' } });
ds = await req('GET', '/datenschutz');
check(/E-Mail-Anbieters \(Beispiel Mail AG\)/.test(ds.text) && /mein E-Mail-Anbieter \(Beispiel Mail AG\) \(Versand der Mails\)/.test(ds.text), 'Mailversand „anbieter“ mit Namen');
await admin('POST', '/api/admin/settings', { legal: { avVertrag: false } });
ds = await req('GET', '/datenschutz'); d = await admin('GET', '/api/admin/data');
const HINWEIS_DOPPELT = /inhaber|anschrift|e-mail|telefon|steuernummer|ust-idnr/i;   // wie public/js/admin/admin.js
check(!/Vertrag zur Auftragsverarbeitung/.test(ds.text) && /Alt-Hoster/.test(ds.text) && (d.json?.hinweise || []).some((h) => /^AV-Vertrag/.test(h) && !HINWEIS_DOPPELT.test(h)), 'AV nicht bestätigt: kein AV-Satz, Admin-Hinweis', d.json?.hinweise);
await admin('POST', '/api/admin/settings', { legal: { hoster: '', serverOrt: '', avVertrag: true } });
ds = await req('GET', '/datenschutz'); d = await admin('GET', '/api/admin/data');
check(/bei einem Hosting-Anbieter miete/.test(ds.text) && !/Alt-Hoster|IONOS|Vertrag zur Auftragsverarbeitung|Der Server steht in/.test(ds.text) && /mein Hosting-Anbieter \(Hosting\)/.test(ds.text), 'ohne Hoster: neutraler Text, kein stiller Standard, kein AV-Satz');
check(d.json?.settings?.legal?.hoster === '' && d.json?.settings?.legal?.avVertrag === false, 'leerer Hoster bleibt leer, Bestätigung entfällt', d.json?.settings?.legal);
const hw = d.json?.hinweise || [];
check(hw.some((h) => /^Hoster fehlt/.test(h)) && hw.some((h) => /^Serverstandort fehlt/.test(h)) && hw.filter((h) => /^(Hoster|Serverstandort|AV-Vertrag|Öffentliche Shop-Adresse)/.test(h)).every((h) => !HINWEIS_DOPPELT.test(h)), 'Admin-Hinweise für Hoster und Standort (werden in der Übersicht nicht ausgefiltert)', hw);
await admin('POST', '/api/admin/settings', { legal: { hoster: 'Neu-Hoster AG, Allee 2, 60311 Frankfurt am Main', serverOrt: 'Frankfurt am Main (Deutschland)', avVertrag: true } });
ds = await req('GET', '/datenschutz');
check(/Neu-Hoster AG verarbeitet diese Daten nur in meinem Auftrag/.test(ds.text) && /Der Server steht in Frankfurt am Main/.test(ds.text), 'Hoster mit bestätigtem AV-Vertrag');

console.log('Versandfreigrenze, Mengenrabatt, Gutscheine (AGB § 6/§ 14, Versandseite — wie computeTotals)');
const agbT = norm(text((await req('GET', '/agb')).text)), versT = norm(text((await req('GET', '/versand')).text));
const FREI = 'Maßgeblich ist der Preis deiner Vasen nach Aktions- und Mengenrabatten, vor Abzug von Gutscheinen und Guthaben.';
const MENGE = 'Mengenrabatte gelten je Design, also für mehrere Stück derselben Gestaltung in einer Bestellung.';
check(agbT.includes(FREI) && versT.includes(FREI) && !/nach allen Rabatten und Gutscheinen/.test(agbT + versT), 'AGB § 6 und Versandseite: Freigrenze am Warenwert vor Gutschein und Guthaben');
check(agbT.includes(MENGE) && versT.includes(MENGE) && agbT.includes('zahlst du nie mehr als ohne Aktion'), 'AGB § 6 und Versandseite: Mengenrabatt je Design, Aktion nie teurer');
check(agbT.includes('ein Ablaufdatum oder eine begrenzte Zahl an Einlösungen') && agbT.includes('oder die Aktion deine Bestellung nicht günstiger macht') && agbT.includes('Es deckt auch die Versandkosten und lässt die Versandkostenfreiheit unberührt'), 'AGB § 14: Bedingungen, Kombination mit Aktion, Guthaben als Zahlungsmittel');
check(/innerhalb von 14 Tagen nach Vertragsschluss/.test(agbT) && /innerhalb von 14 Tagen nach Vertragsschluss/.test(versT), 'Zahlungsfrist 14 Tage nach Vertragsschluss (lib/lieferfrist.js) in AGB § 8 und Versandseite');
const dsT = norm(text((await req('GET', '/datenschutz')).text));
check(dsT.includes('spätestens nach 90 Tagen') && dsT.includes('nach 48 Stunden') && dsT.includes('nach 14 Tagen') && /\/64/.test(dsT) && dsT.includes('Konto unter „Mein Konto“ jederzeit selbst löschen'), 'Datenschutz: 90 Tage Mail-Inhalte, abgebrochene Kasse, /64-Bremsen, Konto selbst löschen');

console.log('Produkthinweise aus einer Quelle, Bestellung');
const content = JSON.parse(readFileSync(path.join(ROOT, 'public/content.json'), 'utf8'));
check(Object.values(HINWEIS).every((s) => norm(content.hinweise.checkout).includes(norm(s))), 'Kassenhinweis (content.json) enthält alle Produkthinweise wörtlich');
const idx = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const haekchen = norm(((idx.match(/<input type="checkbox" id="co-beschaffenheit"[^>]*>([\s\S]*?)<\/label>/) || [])[1] || '').replace(/<[^>]+>/g, ''));
check(haekchen === norm(BESCHAFFENHEIT_TEXTE[BESCHAFFENHEIT_FASSUNG]), `Häkchen in der Kasse = Fassung ${BESCHAFFENHEIT_FASSUNG} (sonst neue Fassung in lib/produkthinweise.js anlegen)`, haekchen);
check(!produktHinweise([{ config: { pattern: 'rippen', preset: 'flasche' } }]).join(' ').includes('Voronoi'), 'ohne offenes Muster kein Voronoi-Satz');
const b = await bestellung([{ pattern: 'skelett' }, { preset: 'eigene', customPoints: [[0, 0.6], [0.3, 0.8], [0.7, 0.7], [1, 0.5]] }, {}]);
check(b.fertig === 200, 'Vorkasse-Bestellung abgeschlossen', b);
if (b.orderId) {
  const o = JSON.parse(readFileSync(path.join(ORDERS, b.orderId, 'order.json'), 'utf8'));
  check(o.beschaffenheitFassung === BESCHAFFENHEIT_FASSUNG && !!o.beschaffenheitBestaetigt, 'order.json: Zeitpunkt und Fassung der Vereinbarung', { f: o.beschaffenheitFassung });
  const re = norm(readFileSync(path.join(ORDERS, b.orderId, 'rechnung.html'), 'utf8'));
  check(re.includes('Offene Muster (Voronoi, Pos. 1) halten kein Wasser') && re.includes('Für frei gestaltete Formen (Pos. 2) sage ich keine Standfestigkeit zu') && re.includes(norm(HINWEIS.wasser)), 'Rechnung: Produkthinweise je Position', (re.match(/Produkthinweise:[^<]*/) || [])[0]);
}

console.log('Wartungsmodus');
r = await admin('POST', '/api/admin/settings', { wartung: { kennwort: 'pruef-kennwort-1', aktiv: true } });
const cookie = (r.setCookie[0] || '').split(';')[0];
check(r.status === 200 && /^fs_zugang=\d{10}\.[A-Za-z0-9_-]{43}$/.test(cookie) && /Max-Age=2592000/.test(r.setCookie[0] || ''), 'Cookie „Ablauf.Signatur“, 30 Tage', r.setCookie[0]);
for (const p of ['/impressum', '/impressum/', '/datenschutz', '/agb', '/widerruf', '/versand']) {
  const x = await req('GET', p, null, { accept: 'text/html' });
  check(x.status === 200 && !x.headers['x-formsam-wartung'], `${p} ohne Kennwort erreichbar`, x.status);
}
let x = await req('GET', '/robots.txt');
check(x.status === 200 && x.text === 'User-agent: *\nDisallow: /\n', 'robots.txt in der Wartung: Disallow: /', x.text);
check(x.headers['cache-control'] === 'max-age=300', 'robots.txt in der Wartung nur kurz zwischenspeichern (max-age=300)', x.headers['cache-control']);
x = await req('POST', '/api/widerruf', { name: 'Hans Wartung', email: 'hans@example.test', orderId: b.orderId });
check(x.status === 200 && x.json?.ok && /^WR-/.test(x.json?.ref || ''), 'Widerrufsfunktion (POST /api/widerruf) in der Wartung', x.json);
x = await req('GET', `/orders/${b.orderId}/rechnung.html?k=${b.accessKey}`, null, { accept: 'text/html' });
check(x.status === 200 && /Rechnung/.test(x.text), 'Rechnung mit Schlüssel in der Wartung', x.status);
x = await req('GET', `/orders/${b.orderId}/rechnung.html`, null, { accept: 'text/html' });
check(x.status === 404, 'Rechnung ohne Schlüssel: 404 aus dem Handler (Schlüsselprüfung bleibt)', x.status);
x = await req('GET', `/orders/${b.orderId}/modell-1-vase.stl?k=${b.accessKey}`);
check(x.status === 503, 'Modelldateien bleiben hinter dem Tor', x.status);
x = await req('GET', '/api/pricing');
// API-503 bewusst ohne Retry-After (wie vor dem Paket): curl --retry & Co. halten sich daran und warteten sonst eine Stunde
check(x.status === 503 && x.headers['retry-after'] === undefined && x.headers['x-formsam-wartung'] === '1', 'API: 503 ohne Retry-After (Werkzeuge mit Wiederholung hängen nicht)', x.headers);
x = await req('GET', '/', null, { accept: 'text/html' });
check(x.status === 503 && x.headers['retry-after'] === '3600', 'Wartungsseite: 503 mit Retry-After 3600', x.headers['retry-after']);
for (const p of ['/sitemap.xml', '/content.json', '/admin']) { x = await req('GET', p); check(x.status === 503, `${p} gesperrt`, x.status); }
x = await req('GET', '/', null, { accept: 'text/html' });
check(x.status === 503 && /href="\/impressum"/.test(x.text) && /href="\/datenschutz"/.test(x.text), 'Wartungsseite verlinkt Impressum und Datenschutz');
for (const p of ['/fonts/..%2fjs/app.js', '/img/brand/..%2f..%2findex.html', '/img/icons/..%2f..%2fadmin.html', '/fonts/a%5c..%5c..%5cindex.html', '/fonts/..%2F..%2Fadmin.html']) {
  x = await roh(p);
  check(x.status === 400, `${p} → 400`, x.status);
}
// %2e%2e und // löst schon der URL-Parser auf — dann gilt das Tor für den aufgelösten Pfad (kein Umweg)
for (const p of ['/img/brand/%2e%2e/%2e%2e/content.json', '/fonts//../index.html', '/fonts/./../admin.html']) {
  x = await roh(p);
  check(x.status !== 200, `${p} kein Umweg (${x.status})`, x.status);
}
x = await roh('/fonts/inter-latin.woff2');
check(x.status === 200, 'normale Schrift unter /fonts weiter frei', x.status);
x = await roh('/%09/evil.example/pfad', { headers: { Accept: 'text/html' } });
check(!/value="[^"]*\t/.test(x.text), 'verstecktes Ziel ohne Tabulator', (x.text.match(/name="ziel" value="([^"]*)"/) || [])[1]);
for (const [ziel, soll] of [['/\t/evil.example/pfad', '/'], ['/foo\n/bar', '/'], ['//evil.example', '/'], ['/\\evil.example', '/'], ['https://evil.example/', '/'], ['/agb?x=1', '/agb?x=1'], ['/__wartung', '/'],
  ['/.//evil.example/x', '/'], ['/..//evil.example', '/'], ['/a/..//evil.example', '/'], ['/./\\evil.example', '/'], ['/x/../\\evil.example', '/'], ['/a/../agb', '/agb']]) {
  x = await login('pruef-kennwort-1', ziel);
  check(x.status === 303 && x.hd('Location') === soll, `Ziel ${JSON.stringify(ziel)} → ${soll}`, { s: x.status, l: x.hd('Location') });
}
x = await login('pruef-kennwort-1', '/', { 'X-Forwarded-Proto': 'HTTPS' });
check(/;\s*Secure/i.test(x.hd('Set-Cookie') || ''), 'X-Forwarded-Proto „HTTPS“ → Secure', x.hd('Set-Cookie'));
check((await req('GET', '/', null, { cookie, accept: 'text/html' })).status === 200, 'mit Freigabe-Cookie: Shop sichtbar');
const w = JSON.parse(readFileSync(path.join(DATA, 'settings.json'), 'utf8')).wartung;
const sig = (exp) => crypto.createHmac('sha256', w.secret).update(`zugang|${w.hash}|${exp}`).digest('base64url');
const alt = crypto.createHmac('sha256', w.secret).update(`zugang|${w.hash}`).digest('base64url');
const vorbei = Math.floor(Date.now() / 1000) - 60, spaeter = Math.floor(Date.now() / 1000) + 3600;
check((await req('GET', '/', null, { cookie: `fs_zugang=${alt}`, accept: 'text/html' })).status === 503, 'altes Cookie-Format (ohne Ablauf) gilt nicht mehr');
check((await req('GET', '/', null, { cookie: `fs_zugang=${vorbei}.${sig(vorbei)}`, accept: 'text/html' })).status === 503, 'abgelaufenes Cookie gilt nicht');
check((await req('GET', '/', null, { cookie: `fs_zugang=${spaeter}.${sig(vorbei)}`, accept: 'text/html' })).status === 503, 'verlängertes Ablaufdatum (Signatur passt nicht) gilt nicht');
check((await req('GET', '/', null, { cookie: `fs_zugang=${spaeter}.${sig(spaeter)}`, accept: 'text/html' })).status === 200, 'gültiges Cookie mit Ablauf in der Zukunft');
// Bremse: 10 Fehlversuche, dann geht das richtige Kennwort trotzdem; weitere Fehlversuche → wachsende Pause (30 s, 60 s …)
for (let i = 0; i < 10; i++) await login('falsch');
x = await login('pruef-kennwort-1');
check(x.status === 303, 'richtiges Kennwort trotz Sperre (nur verzögert)', x.status);
x = await login('falsch');
check(x.status === 429 && Number(x.hd('Retry-After')) === BREMSE_S && /erst in \d+ Sekunden?\b/.test(x.text), `erster Fehlversuch während der Sperre → 429, Retry-After ${BREMSE_S}`, { s: x.status, ra: x.hd('Retry-After') });
x = await login('pruef-kennwort-1');
check(x.status === 429 && Number(x.hd('Retry-After')) > 0 && /warte \d+ (Sekunden?|Minuten) und/.test(x.text), 'innerhalb der Pause wird nicht geprüft (429 mit Wartezeit)', { s: x.status, ra: x.hd('Retry-After') });
// wachsende Pause: die Instanz läuft mit WARTUNG_BREMSE_S=1 (Grundpause 1 s statt 30 s) → 1 s, 2 s, 4 s …
await new Promise((r) => setTimeout(r, Number(x.hd('Retry-After')) * 1000 + 150));
x = await login('falsch');
check(x.status === 429 && Number(x.hd('Retry-After')) === 2 * BREMSE_S, `zweite Prüfung in der Sperre → Pause verdoppelt (${2 * BREMSE_S} s)`, { s: x.status, ra: x.hd('Retry-After') });
await new Promise((r) => setTimeout(r, 2 * BREMSE_S * 1000 + 150));
x = await login('pruef-kennwort-1');
check(x.status === 303, 'nach der Pause kommt das richtige Kennwort durch', x.status);
x = await login('falsch');
check(x.status === 429 && Number(x.hd('Retry-After')) === BREMSE_S, 'nach Erfolg beginnt die Pause wieder bei der Grundpause', { s: x.status, ra: x.hd('Retry-After') });
r = await admin('POST', '/api/admin/settings', { wartung: { aktiv: false } }, { cookie });
check(r.status === 200 && (await req('GET', '/', null, { accept: 'text/html' })).status === 200, 'Wartung aus → Shop für alle');
x = await req('GET', '/robots.txt');
check(/Disallow: \/admin\n/.test(x.text), 'robots.txt nach der Wartung wieder normal');

// --- Migration vom früheren stillen Standard: der alte Code hat IONOS bei jedem Start in settings.json geschrieben → kein
// Beleg für einen Eintrag; nach dem Update ohne AV-Satz und mit Hinweis, bis es je Server bestätigt ist
console.log('Migration: früherer Standard-Hoster (IONOS)');
const IONOS_ALT = 'IONOS SE, Elgendorfer Str. 57, 56410 Montabaur';
const st = JSON.parse(readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
st.legal = { hoster: IONOS_ALT, serverOrt: 'Berlin (Deutschland)' };
delete st.rechtsangaben;   // Bestand der älteren Fassung (ohne Spiegel) — der Rückweg mit Spiegel folgt unten
writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify(st, null, 2));
await starten();
d = await admin('GET', '/api/admin/data'); ds = await req('GET', '/datenschutz');
check(d.json?.settings?.legal?.hoster === IONOS_ALT && d.json?.settings?.legal?.avVertrag === false, 'früherer Standard gilt nicht als bestätigt (avVertrag false)', d.json?.settings?.legal);
check(/IONOS SE/.test(ds.text) && !/Vertrag zur Auftragsverarbeitung/.test(ds.text), 'Datenschutz: Hoster bleibt genannt, aber kein AV-Satz');
const hwAlt = (d.json?.hinweise || []).filter((h) => /früheren Standardwert/.test(h));
check(hwAlt.length === 1 && !HINWEIS_DOPPELT.test(hwAlt[0]) && !(d.json?.hinweise || []).some((h) => /^AV-Vertrag/.test(h)), 'Admin-Hinweis „früherer Standardwert … prüfen“ (wird in der Übersicht nicht ausgefiltert)', d.json?.hinweise);
check(/früheren Standardwert/.test(log), 'Hinweis auch im Startprotokoll');
await admin('POST', '/api/admin/settings', { legal: { avVertrag: true } });
d = await admin('GET', '/api/admin/data'); ds = await req('GET', '/datenschutz');
check(/IONOS SE verarbeitet diese Daten nur in meinem Auftrag/.test(ds.text) && !(d.json?.hinweise || []).some((h) => /früheren Standardwert|^AV-Vertrag/.test(h)), 'nach Bestätigung im Admin: AV-Satz, kein Hinweis mehr');

// --- Rückweg auf die ältere Fassung und erneutes Update: die ältere Fassung schreibt settings.legal nur mit hoster/serverOrt (leer →
// ihre Standardwerte) und lässt unbekannte Wurzelschlüssel stehen → Rechtsangaben kommen aus settings.rechtsangaben zurück
console.log('Rückweg auf die ältere Fassung und erneutes Update');
const SETF = path.join(DATA, 'settings.json');
const alteFassung = (legal) => { const x = JSON.parse(readFileSync(SETF, 'utf8')); x.legal = legal(x.legal); writeFileSync(SETF, JSON.stringify(x, null, 2)); };
const NEU_HOSTER = 'Neu-Hoster AG, Allee 2, 60311 Frankfurt am Main';
await admin('POST', '/api/admin/settings', { legal: { hoster: NEU_HOSTER, serverOrt: 'Frankfurt am Main (Deutschland)', avVertrag: false, mailVersand: 'eigen', mailAnbieter: '' } });
const spiegel = JSON.parse(readFileSync(SETF, 'utf8')).rechtsangaben;
check(spiegel?.mailVersand === 'eigen' && spiegel.avVertrag === false && spiegel.hoster === NEU_HOSTER && d.json?.settings?.rechtsangaben === undefined, 'Spiegel settings.rechtsangaben gespeichert (nicht im Admin-JSON)', spiegel);
alteFassung((l) => ({ hoster: l.hoster, serverOrt: l.serverOrt }));
await starten();
d = await admin('GET', '/api/admin/data'); ds = await req('GET', '/datenschutz');
check(d.json?.settings?.legal?.mailVersand === 'eigen' && d.json?.settings?.legal?.avVertrag === false && !/Vertrag zur Auftragsverarbeitung/.test(ds.text) && (d.json?.hinweise || []).some((h) => /AV-Vertrag/.test(h)),
  'Rückweg mit offenem AV-Vertrag: bleibt offen (kein AV-Satz, Hinweis), Mail-Versand bleibt „eigen“', d.json?.settings?.legal);
await admin('POST', '/api/admin/settings', { legal: { avVertrag: true } });
alteFassung((l) => ({ hoster: l.hoster, serverOrt: l.serverOrt }));
await starten();
d = await admin('GET', '/api/admin/data'); ds = await req('GET', '/datenschutz');
check(d.json?.settings?.legal?.avVertrag === true && d.json?.settings?.legal?.mailVersand === 'eigen' && /Vertrag zur Auftragsverarbeitung/.test(ds.text), 'Rückweg mit bestätigtem AV-Vertrag: bleibt bestätigt', d.json?.settings?.legal);
alteFassung((l) => ({ hoster: 'Anderer Hoster GmbH, Weg 5, 20095 Hamburg', serverOrt: l.serverOrt }));
await starten();
d = await admin('GET', '/api/admin/data');
check(d.json?.settings?.legal?.hoster === 'Anderer Hoster GmbH, Weg 5, 20095 Hamburg' && d.json?.settings?.legal?.avVertrag === false, 'in der älteren Fassung anderen Hoster eingetragen → AV-Vertrag neu bestätigen', d.json?.settings?.legal);
await admin('POST', '/api/admin/settings', { legal: { hoster: '', serverOrt: '', mailVersand: 'anbieter', mailAnbieter: 'Muster-Mail GmbH' } });
alteFassung(() => ({ hoster: IONOS_ALT, serverOrt: 'Berlin (Deutschland)' }));
await starten();
d = await admin('GET', '/api/admin/data');
check(d.json?.settings?.legal?.hoster === '' && d.json?.settings?.legal?.serverOrt === '' && d.json?.settings?.legal?.mailAnbieter === 'Muster-Mail GmbH' && d.json?.settings?.legal?.avVertrag === false,
  'leerer Hoster: Standardwerte der älteren Fassung werden wieder leer, Mail-Anbieter bleibt', d.json?.settings?.legal);

console.log(`\n${pass} ok, ${fail} Fehler`);
if (fail) console.log('Server-Log (Ende):\n' + log.slice(-1500));
ende(fail ? 1 : 0);
