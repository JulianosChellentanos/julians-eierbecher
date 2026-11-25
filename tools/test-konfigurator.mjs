// formsam — Prüfung Konfigurator/Startseite/Service Worker ohne Browser (Prüfung 11/2026):
//   A) Maßangabe: „Ø“ = größte Breite (geometry.js maxDiameter) gegen die Bounding-Box der Druckdatei, nicht mehr der obere Rand
//   B) Entwürfe der Formenwelt und Muster-Vorgaben liegen in den Reglerbereichen des Konfigurators (sonst sprang z. B. „Flow“ auf 4 mm)
//   C) Service Worker (public/sw.js in einer nachgebauten Umgebung): Startseite offline → Offline-Seite statt gespeicherter Hülle,
//      /img/studio|brand|icons stale-while-revalidate (Treffer sofort, im Hintergrund erneuert), /vendor cache-first, VERSION ≠ v2
//   D) Startseite und Styles: endgültige Texte im HTML (keine Layout-Verschiebung), Gravurfeld ohne Versalien, Schriftfarben-Kugeln im
//      Knopf, mobile-home.js nur über studio.js (Handy), Formenkarten mit 700-px-srcset, Auswahlknöpfe mit aria-pressed, eigene Dialoge mit
//      Namen, Kontraste ≥ 4,5:1, Desktop-Preisleiste kompakt
//   E) Entwurf (Ablauf, Code-Herkunft, nach Bestellung) und Link-Codes: nur „gibt es nicht“ nimmt den Code aus der Adresse, sonst deutscher
//      Satz statt technischer Meldung (designcode.js in einer kleinen Browser-Attrappe)
// Aufruf: node tools/test-konfigurator.mjs   → Exit 0 = alles bestanden, 1 = Fehler
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildModel, DEFAULTS } from '../public/js/geometry.js';
import { STUDIO_DESIGNS } from '../public/js/studio-designs.js';
import { MOBILE_PATTERNS } from '../public/js/mobile-patterns.js';
import { SURFACE_DESIGNS } from '../public/js/surface-designs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lies = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); }
};

// ---------------------------------------------------------------------------
console.log('A Maßangabe Ø = größte Breite inkl. Muster');
for (const [preset, width, pattern, height, depth] of [['flasche', 1, 'rippen', 150, 0.9], ['kugel', 1.1, 'rippen', 180, 0.9], ['tropfen', 1, 'rippen', 150, 0.9],
  ['zylinder', 1, 'rippen', 150, 0.9], ['flasche', 0.85, 'gehaemmert', 150, 0.8], ['kurve', 1.15, 'lamellen', 220, 4], ['zylinder', 1, 'koralle', 200, 5]]) {
  const p = { ...DEFAULTS, product: 'vase', preset, width, pattern, height, depth };
  const vorschau = buildModel({ ...p, quality: 0.55 }).info;
  const { geometry, info } = buildModel({ ...p, quality: 1, exportRes: true });
  geometry.computeBoundingBox(); const b = geometry.boundingBox;
  const box = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
  const ok = info.maxDiameter >= box - 0.05 && info.maxDiameter <= box * 1.03 + 0.5 && Math.abs(vorschau.maxDiameter - info.maxDiameter) < 1;
  check(ok, `${preset} ${Math.round(width * 100)} % ${pattern}: Anzeige Ø ${vorschau.maxDiameter.toFixed(0)} mm, Druckdatei ${box.toFixed(1)} mm (oberer Rand ${info.topDiameter.toFixed(0)} mm)`, { max: info.maxDiameter, box });
  geometry.dispose();
}
const app = lies('public/js/app.js');
check(/const dia = \(info\.maxDiameter \|\| info\.topDiameter\)/.test(app) && !/Ø \$\{info\.topDiameter/.test(app), 'app.js zeigt maxDiameter als „Ø“ (Rückfall nur ohne das Feld)');

// ---------------------------------------------------------------------------
console.log('B Entwürfe in den Reglerbereichen');
const m = app.match(/const DEPTH_RANGES = (\{[\s\S]*?\n\});/);
const RANGES = m ? Function(`return ${m[1]}`)() : null;
check(!!RANGES, 'DEPTH_RANGES in app.js gefunden');
const html = lies('public/index.html');
const regler = (id) => { const t = html.match(new RegExp(`<input type="range" id="${id}"[^>]*>`))?.[0] || ''; return { min: +t.match(/min="([^"]+)"/)?.[1], max: +t.match(/max="([^"]+)"/)?.[1] }; };
const ribsR = regler('s-ribs'), twistR = regler('s-twist');
const imBereich = (name, c) => {
  const r = RANGES?.[c.pattern] || RANGES?.default;
  if (c.depth !== undefined) check(c.depth >= r.min - 1e-9 && c.depth <= r.max + 1e-9, `${name}: Tiefe ${c.depth} mm in ${r.min}…${r.max} (${c.pattern})`);
  if (c.ribs !== undefined) check(c.ribs >= ribsR.min && c.ribs <= ribsR.max, `${name}: Anzahl ${c.ribs} in ${ribsR.min}…${ribsR.max}`);
  if (c.twist !== undefined) check(c.twist >= twistR.min && c.twist <= twistR.max, `${name}: Stärke ${c.twist} in ${twistR.min}…${twistR.max}`);
};
for (const d of STUDIO_DESIGNS) imBereich(`Formenwelt „${d.name}“`, d.config);
for (const d of Object.values(SURFACE_DESIGNS)) imBereich(`Oberfläche „${d.name}“`, d.config);
for (const p of MOBILE_PATTERNS) if (p.config) imBereich(`Handy-Muster „${p.key}“`, p.config);

// ---------------------------------------------------------------------------
console.log('C Service Worker');
const swSrc = lies('public/sw.js');
const VERSION = swSrc.match(/const VERSION = '([^']+)'/)?.[1];
check(VERSION && VERSION !== 'formsam-v2', `VERSION erhöht (${VERSION})`);
function swUmgebung({ online }) {
  const stores = new Map(); // Cache-Name → Map(url → Response)
  const key = (r) => (typeof r === 'string' ? new URL(r, 'https://shop.test').href : r.url);
  const cacheApi = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const s = stores.get(name);
    return { match: async (r) => s.get(key(r))?.clone(), put: async (r, res) => { s.set(key(r), res); }, addAll: async (list) => { for (const u of list) s.set(key(u), new Response('cached ' + u)); } };
  };
  const listeners = {};
  const netzAufrufe = [];
  const ctx = {
    self: { addEventListener: (t, f) => { listeners[t] = f; }, location: { origin: 'https://shop.test' }, skipWaiting: () => {}, clients: { claim: async () => {} } },
    caches: { open: async (n) => cacheApi(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n), match: async () => undefined },
    fetch: async (req) => { netzAufrufe.push(typeof req === 'string' ? req : req.url); if (!online.an) throw new TypeError('Failed to fetch'); return new Response(`netz ${typeof req === 'string' ? req : req.url}`, { status: 200, headers: { 'content-type': 'text/plain' } }); },
    // im Browser lösen relative Adressen gegen den Ort des Service Workers auf
    Request: class extends Request { constructor(u, o) { super(typeof u === 'string' ? new URL(u, 'https://shop.test').href : u, o); } },
    Response, URL, AbortController, setTimeout, clearTimeout, console, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(swSrc, ctx);
  const anfrage = async (url, mode = 'no-cors') => {
    let antwort = null; const warten = [];
    const req = new Request(url); Object.defineProperty(req, 'mode', { value: mode });
    const ev = { request: req, respondWith: (p) => { antwort = p; }, waitUntil: (p) => warten.push(p) };
    listeners.fetch(ev);
    const res = antwort ? await antwort : null;
    await Promise.all(warten.map((p) => p.catch(() => {})));
    return res;
  };
  return { anfrage, cacheApi, stores, netzAufrufe, version: VERSION, listeners };
}
{
  const online = { an: true };
  const sw = swUmgebung({ online });
  // Installation legt die Startseite NICHT mehr als Hülle ab
  const inst = []; sw.listeners.install({ waitUntil: (p) => inst.push(p) }); await Promise.all(inst);
  const dyn = sw.stores.get(`${VERSION}-dynamic`);
  check(dyn && !dyn.has('https://shop.test/'), 'Installation speichert keine App-Hülle „/“ mehr');
  // Startseite online: aus dem Netz
  let r = await sw.anfrage('https://shop.test/?d=ABC123', 'navigate');
  check(r && r.status === 200 && (await r.text()).startsWith('netz'), 'Startseite online: Netz');
  // Startseite offline: Offline-Seite (503), auch wenn früher besucht
  online.an = false;
  r = await sw.anfrage('https://shop.test/', 'navigate');
  const t = r ? await r.text() : '';
  check(r && r.status === 503 && /Du bist offline/.test(t), 'Startseite offline: Offline-Seite statt Hülle', r?.status);
  check(/geht’s weiter/.test(t), 'Offline-Seite mit typografischem Apostroph');
  r = await sw.anfrage('https://shop.test/index.html', 'navigate');
  check(r && r.status === 503, '/index.html offline: Offline-Seite');
  // Bilder /img/studio: stale-while-revalidate
  online.an = true;
  sw.netzAufrufe.length = 0;
  r = await sw.anfrage('https://shop.test/img/studio/fdm-card-flow.webp');
  check(r && (await r.text()).startsWith('netz') && sw.netzAufrufe.length === 1, '/img/studio ohne Kopie: aus dem Netz und abgelegt');
  // Inhalt im Netz „getauscht“: nächster Aufruf liefert sofort die Kopie, erneuert aber im Hintergrund
  sw.stores.get(`${VERSION}-dynamic`).set('https://shop.test/img/studio/fdm-card-flow.webp', new Response('alt'));
  sw.netzAufrufe.length = 0;
  r = await sw.anfrage('https://shop.test/img/studio/fdm-card-flow.webp');
  check(r && (await r.text()) === 'alt' && sw.netzAufrufe.length === 1, '/img/studio mit Kopie: sofort Kopie, Nachfrage im Hintergrund');
  r = await sw.anfrage('https://shop.test/img/studio/fdm-card-flow.webp');
  check(r && (await r.text()).startsWith('netz'), 'danach liefert der Cache das neue Bild (kein Dauer-Cache mehr)');
  for (const p of ['/img/brand/favicon.svg', '/img/icons/icon-192.png']) {
    sw.netzAufrufe.length = 0; await sw.anfrage('https://shop.test' + p); await sw.anfrage('https://shop.test' + p);
    check(sw.netzAufrufe.length === 2, `${p}: jede Anfrage fragt im Hintergrund nach`);
  }
  // offline: vorhandene Kopie bleibt nutzbar
  online.an = false;
  r = await sw.anfrage('https://shop.test/img/studio/fdm-card-flow.webp');
  check(r && r.status === 200, '/img/studio offline: Kopie aus dem Cache');
  // /vendor bleibt cache-first
  online.an = true; sw.netzAufrufe.length = 0;
  await sw.anfrage('https://shop.test/vendor/three.module.js'); await sw.anfrage('https://shop.test/vendor/three.module.js');
  check(sw.netzAufrufe.length === 1, '/vendor: cache-first (einmal geladen)');
  // Rechtsseite offline ohne Kopie: Offline-Seite (unverändert)
  online.an = false;
  r = await sw.anfrage('https://shop.test/agb', 'navigate');
  check(r && r.status === 503, '/agb offline ohne Kopie: Offline-Seite');
}

// ---------------------------------------------------------------------------
console.log('D Startseite, Styles, Bedienhilfen');
const content = JSON.parse(lies('public/content.json'));
const h1 = html.match(/<h1 id="hero-headline">([^<]*)<\/h1>/)?.[1];
check(h1 === content.hero.headline, `Überschrift im HTML = content.json („${h1}“) — kein Umbruch-Sprung beim Laden`);
const trustHTML = html.match(/<div class="trust-row" id="trust-row">([\s\S]*?)<\/div>/)?.[1] || '';
const erwartet = content.hinweise.trust.map((t, i) => { const k = content.hinweise.trustKurz?.[i]; return `<span>${k ? `<span class="tr-long">${t}</span><span class="tr-short">${k}</span>` : t}</span>`; }).join('');
check(trustHTML === erwartet, 'Vertrauenszeile im HTML vorbefüllt, identisch zu dem, was app.js aus content.json setzt');
check(/#hero-hint:empty \{ min-height: 3\.1em; \}/.test(lies('public/css/style.css')), 'Platz für den Preis-Hinweis reserviert');
const style = lies('public/css/style.css');
const iText = style.match(/#i-text \{[^}]*\}/)?.[0] || '';
check(iText && !/text-transform/.test(iText) && !/letter-spacing/.test(iText), 'Gravurfeld ohne Versalien/Sperrung (zeigt, was graviert wird)');
check(/\.panel \.swatches-sm \.swatch span \{ width: 100%; height: 100%;/.test(style), 'Schriftfarben-Kugeln füllen ihren Knopf (keine 37-px-Kugel im 26-px-Knopf)');
const cs = lies('public/css/configurator-studio.css');
// Desktop: kompakte Leiste statt des ganzen haftenden Preisbereichs (der nahm auf Laptops bis zur Hälfte des Panels ein)
check(!/\.panel-cta\{position:sticky/.test(cs) && /\.cta-mini\{display:block;position:sticky;bottom:-24px;height:0/.test(cs), 'Desktop: Preisbereich im Fluss, kompakte Leiste #cta-mini haftet unten (0 px hoch, bündig)');
check(/<div class="cta-mini" id="cta-mini" aria-hidden="true" inert>[\s\S]*id="cta-mini-price"[\s\S]*id="cta-mini-ship"[\s\S]*id="cta-mini-order"[\s\S]*<\/div>\s*<\/aside>/.test(html), 'Leiste mit Preis, Versand-Hinweis und Kaufknopf als letztes Kind des Panels, ausgeblendet inert');
check(/new IntersectionObserver\([\s\S]*\{ root: panel, threshold/.test(app) && /animateMoney\(\$\('#cta-mini-price'\)/.test(app) && /\$\('#cta-mini-ship'\)/.test(app), 'app.js: Leiste folgt der Sichtbarkeit von Preis/Kaufknopf und spiegelt Preis und Versand');
// Leiste und Preisbereich nie übereinander: liegt sie an, ist der Preisbereich ausgeblendet; steht der Preis ganz und der Kaufknopf
// mindestens zur Hälfte im Panel, bleibt sie weg (kein halber oder doppelter Preis, Abnahme-Optik bei 1440×900)
const panelCta = app.slice(app.indexOf('function initPanelCta'), app.indexOf('function zeigeOhne3D'));
check(/!\(kaufGanz \|\| \(preisGanz && kaufHalb\)\)/.test(panelCta) && /panel\.classList\.toggle\('cta-mini-an', an\)/.test(panelCta) && /threshold: \[0, 0\.5, 0\.98, 1\]/.test(panelCta)
  && /\.panel\.cta-mini-an \.panel-cta\{opacity:0;pointer-events:none\}\.panel\.cta-mini-an \.panel-cta:focus-within\{opacity:1/.test(cs),
'Leiste nur ohne sichtbaren Kaufknopf (Preis ganz + Knopf ≥ ½ → keine Leiste); liegt sie an, ist der Preisbereich ausgeblendet (fokussiert sichtbar)');
check(/\.panel-head-btns\{display:grid;grid-template-columns:auto auto;[^}]*\}\.panel-head-btns #btn-random\{grid-column:1\/-1\}/.test(cs), 'Panel-Kopf zweizeilig: „Zurücksetzen“ neben „Design-Code“ (schiebt den Preisbereich nicht nach unten)');
check(!/<script[^>]+mobile-home\.js/.test(html) && /await import\('\.\/mobile-home\.js'\)/.test(lies('public/js/studio.js')), 'mobile-home.js nur auf dem Handy (über studio.js)');
check(!/loadFont\('helvetiker'\)\.catch/.test(lies('public/js/model-worker.js')), 'Gravurschriften nicht mehr beim Start im Worker');
// Formenkarten: 700-px-Fassungen für srcset (Anzeige ≈ 400 CSS-px), jede deutlich kleiner als das Original
for (const d of STUDIO_DESIGNS) {
  const bild = d.image || `/img/studio/fdm-card-${d.id}.webp`, klein = bild.replace(/\.webp$/, '-700.webp');
  const ok = existsSync(path.join(ROOT, 'public', klein)) && statSync(path.join(ROOT, 'public', klein)).size < statSync(path.join(ROOT, 'public', bild)).size / 2;
  check(ok, `Formenkarte ${d.name}: ${klein.split('/').pop()} vorhanden und < ½ des Originals`);
}
check(/srcset/.test(lies('public/js/studio.js')) && /dataset\.srcset/.test(lies('public/js/mobile-home.js')), 'Formenkarten mit srcset (Handy: data-srcset beim Heranscrollen)');
const knoepfe = [...html.matchAll(/<button class="(?:pattern-btn|flow-btn|rim-btn)[^"]*" data-(?:pattern|flow|rim)="[^"]*"[^>]*>/g)].map((x) => x[0]);
check(knoepfe.length >= 16 && knoepfe.every((k) => /aria-pressed="(true|false)"/.test(k)), `Muster/Verlauf/Rand mit aria-pressed (${knoepfe.length})`);
check(knoepfe.filter((k) => /aria-pressed="true"/.test(k)).length === 3, 'je Gruppe genau ein Knopf gedrückt (Start)');
for (const id of ['lists-modal', 'code-modal', 'foto-modal']) check(new RegExp(`<dialog id="${id}" aria-labelledby="[^"]+"`).test(html), `Dialog #${id} hat einen Namen`);
check(/id="dc-err" role="alert"/.test(html) && /id="text-warn" aria-live="polite"/.test(html), 'Fehler Design-Code/Gravur als Live-Region');
check(/id="viewer" role="img" aria-label=/.test(html) && /id="i-text"[^>]*aria-label=/.test(html), '3D-Fläche und Gravurfeld benannt');
check(/\.dark #text-warn\.err, \.dark \.err-msg/.test(style), 'Dunkelmodus: eigenes helles Fehlerrot');
// Kontraste der Tokens (hell/dunkel)
const lum = (h) => { const c = [0, 2, 4].map((i) => parseInt(h.slice(1).slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const kontrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const studio = lies('public/css/studio.css');
const tok = (block, name) => block.match(new RegExp(`--${name}:(#[0-9a-f]{6})`))?.[1];
const hell = studio.match(/:root\{[^}]*\}/)?.[0] || '', dunkel = studio.match(/\.dark\{[^}]*\}/)?.[0] || '';
for (const [blk, n] of [[hell, 'hell'], [dunkel, 'dunkel']]) {
  for (const grund of ['bg', 'bg-soft', 'card']) {
    const k = kontrast(tok(blk, 'ink-soft'), tok(blk, grund));
    check(k >= 4.5, `Nebentext --ink-soft auf --${grund} (${n}): ${k.toFixed(2)}:1`);
  }
}
check(kontrast('#ffb4ad', tok(dunkel, 'card')) >= 4.5, 'Dunkelmodus-Fehlertext ≥ 4,5:1');

// ---------------------------------------------------------------------------
console.log('E Entwurf und Link-Codes');
check(/ENTWURF_TAGE = 30/.test(app) && /entwurfLoeschen\(\); return null;/.test(app), 'Entwurf: abgelaufener/unlesbarer Stand wird gelöscht (30 Tage)');
check(/sig === entwurfSig\(startConfig\)\) \{ if \(entwurfHier\) entwurfLoeschen\(\); return; \}/.test(app), 'Entwurf: Grundzustand wird nicht gesichert und löscht nur einen Entwurf aus diesem Tab (nie einen von früher beim Start)');
check(/entwurfLoeschen\(\);\s+\/\/ „Zurücksetzen“/.test(app), 'Entwurf: „Zurücksetzen“/„Neu beginnen“ löscht ihn ausdrücklich');
check(/if \(!linkWartet\) entwurfAn = true;/.test(app) && /if \(linkWartet\) \{\s+entwurfAn = true;\s+if \(!linkGeladen\) entwurfAnbieten\(\);/.test(app),
  'Entwurf: solange ein Link-Code lädt, wird nichts gesichert/gelöscht; lädt er nicht, wird der Entwurf angeboten');
check(/entwurfSig\(alt\.cfg\) === sig && \(alt\.von \|\| null\) === \(entwurfVon \|\| null\)\) \{ entwurfHier = true; return; \}/.test(app), 'Entwurf: unveränderter Stand wird nicht neu geschrieben (30 Tage ab der letzten Änderung, nicht ab dem letzten Besuch)');
check(/codeStand = \{ code: normalizeCode\(code\), sig: entwurfSig\(entwurfDaten\(\)\) \}/.test(app), 'Entwurf: Referenzstand eines Codes entsteht beim Laden (Änderung gleich danach wird gesichert)');
check(/if \(sig === codeStand\.sig\) return;/.test(app) && /stripURLParam\('d'\);\s+\/\/ weitergestaltet/.test(app), 'Entwurf: Code-Design unverändert → nichts gesichert; weitergestaltet → Code raus aus der Adresse');
check(/code && e\.von !== code/.test(app) && /'Original-Design laden'/.test(app), 'Entwurf aus demselben Link-Code: Entwurf statt Code, mit „Original-Design laden“');
check(/\$\('#confirm-id'\)/.test(app) && /bestelltSig = entwurfSig/.test(app), 'Entwurf nach abgeschlossener Bestellung gelöscht');
check(/30 Tagen ohne Änderung/.test(lies('lib/legal.js')), 'Datenschutzerklärung nennt Löschung nach Bestellung bzw. 30 Tagen');
{
  // designcode.js in einer kleinen Attrappe von Browser-Umgebung: welche Antwort nimmt den Code aus der Adresse, welcher Text erscheint?
  const toast = { textContent: '', classList: { add() {}, remove() {} } };
  const attrappe = () => ({ addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, value: '', textContent: '', hidden: false });
  let adresse = '/';
  const alt = { window: globalThis.window, document: globalThis.document, location: globalThis.location, history: globalThis.history, fetch: globalThis.fetch, navigator: globalThis.navigator };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.document = { querySelector: (q) => (q === '#toast' ? toast : attrappe()), querySelectorAll: () => [] };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { get href() { return `https://shop.test${adresse}`; }, get search() { return new URL(this.href).search; }, get hash() { return new URL(this.href).hash; }, get pathname() { return new URL(this.href).pathname; }, origin: 'https://shop.test' } });
  globalThis.history = { state: null, replaceState: (_s, _t, u) => { adresse = u; } };
  if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  let antwort = null;
  globalThis.fetch = async () => { if (antwort === 'netz') throw new TypeError('Failed to fetch'); return antwort(); };
  const dc = await import('../public/js/designcode.js');
  let geladen = null;
  dc.initDesignCodes({ getConfig: () => ({}), applyConfig: async (cfg, code) => { geladen = code; } });
  const fall = async (name, a, erwartet) => {
    adresse = '/?d=QWERTZ#konfigurator'; toast.textContent = ''; geladen = null; antwort = a;
    const r = await dc.loadFromURL();
    const ok = erwartet(r, toast.textContent, adresse);
    check(ok, `${name}: Meldung „${toast.textContent}“, Adresse ${adresse}`);
  };
  const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  await fall('Link-Code vorhanden', json(200, { ok: true, code: 'QWERTZ', config: { product: 'vase' } }), (r, t, a) => r === 'QWERTZ' && geladen === 'QWERTZ' && !t && a.includes('d=QWERTZ'));
  await fall('Link-Code gibt es nicht (404)', json(404, { ok: false, error: 'Diesen Design-Code gibt es nicht – bitte prüfen (z. B. B statt 8).' }), (r, t, a) => r === false && /gibt es nicht/.test(t) && a === '/#konfigurator');
  await fall('502-Fehlerseite von nginx', () => new Response('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }), (r, t, a) => r === false && /ließ sich gerade nicht laden – bitte versuch es gleich noch einmal/.test(t) && !/Unexpected|JSON|token/i.test(t) && a.includes('d=QWERTZ'));
  await fall('Netz weg', 'netz', (r, t, a) => r === false && /ließ sich gerade nicht laden/.test(t) && a.includes('d=QWERTZ'));
  await fall('503 Wartung (JSON)', json(503, { ok: false, error: 'Wartung' }), (r, t, a) => r === false && /ließ sich gerade nicht laden/.test(t) && a.includes('d=QWERTZ'));
  // Code-Dialog und „Original-Design laden“ nutzen loadDesign: Netz weg → deutscher Satz (status 0), kein „Failed to fetch“
  antwort = 'netz';
  const netzFehler = await dc.loadDesign('QWERTZ').then(() => null, (e) => e);
  check(netzFehler?.status === 0 && /ließ sich gerade nicht laden/.test(netzFehler.message) && !/fetch/i.test(netzFehler.message), `loadDesign ohne Netz: „${netzFehler?.message}“`);
  check(/try \{ await onListCode\(raw\); \} catch/.test(lies('public/js/designcode.js')) && /throw apiFehler\(0, 'Keine Verbindung zum Shop/.test(lies('public/js/lists.js')),
    'Listen-Code im Code-Dialog: Dialog schließt erst nach dem Laden, Netzfehler deutsch');
  check(dc.linkUnbrauchbar({ status: 404 }) && dc.linkUnbrauchbar({ endgueltig: true }) && !dc.linkUnbrauchbar(new TypeError('x')) && !dc.linkUnbrauchbar({ status: 502 }), 'linkUnbrauchbar: nur 400/404 bzw. endgültig');
  const listen = lies('public/js/lists.js');
  check(/if \(linkUnbrauchbar\(e\)\) stripURLParam\('l'\)/.test(listen) && /throw apiFehler\(r\.status/.test(listen), 'Listen-Link: Code nur bei endgültigem Fehler aus der Adresse, Status wird mitgegeben');
  Object.assign(globalThis, { window: alt.window, document: alt.document, history: alt.history, fetch: alt.fetch });
}

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
