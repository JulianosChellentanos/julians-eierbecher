// formsam — Selbsttest für die Druckfassung der Rechtstexte: renderLegalPage(slug, { forPdf: true }) aus lib/legal.js (ohne Fremdpakete)
//
//   node tools/test-legal-pdf.mjs [--ref=<git-ref> | --alt=<pfad/zu/legal.js>] [--settings=<einstellungen.json>] [--out=<ordner>]
//
// 1. Bestehende Ausgaben bytegleich: alle Seiten mit forMail true/false für viele Einstellungen gegen einen Vergleichsstand —
//    --alt: ein anderes legal.js (z. B. im unveränderten Hauptordner), --ref: lib/legal.js samt lokalen Importen aus git,
//    Standard: HEAD (= „ändert die laufende Arbeit etwas an den bestehenden Seiten?“).
// 2. Druckfassung jeder Seite und Einstellung: nur erlaubte Elemente, Attribute, Klassen und CSS-Mittel (was der PDF-Satz
//    lib/html-pdf.js beherrscht), Links absolut, dieselben Überschriften in derselben Reihenfolge und Wort für Wort derselbe Text
//    wie der Hauptinhalt der Mail-Fassung. Begründete Unterschiede: Inhaltsverzeichnis entfällt (Bedienung), Absatznummern „(1)“
//    und Spiegelstriche des Formulars stehen als Text in td.nr (Website: CSS ::before), Kopf und Fußzeile sind neu.
// 3. Falls vorhanden: lib/html-pdf.js liest die Druckfassung ohne Warnung, lib/pdf.js hat für jedes Zeichen eine Glyphe.
// Einstellungen: erfundene Grunddaten (Erika Mustermann, Teststraße …) und mit --settings zusätzlich eine Datei (z. B. eine Kopie
// von data/settings.json) — daraus Varianten: Kleinunternehmer an/aus, PayPal an/aus, mit/ohne Telefon, Sonderfälle.
// --out: schreibt die Druckfassungen der erfundenen Grunddaten dorthin (zum Ansehen oder Drucken).
// Exit 0 = alles gut, 1 = Fehler, 2 = Aufruf falsch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEGAL_SLUGS, renderLegalPage } from '../lib/legal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--(ref|alt|settings|out)=(.+)$/.exec(a);
  if (!m) { console.error(`Unbekanntes Argument: ${a}\nAufruf: node tools/test-legal-pdf.mjs [--ref=<git-ref> | --alt=<legal.js>] [--settings=<datei>] [--out=<ordner>]`); process.exit(2); }
  args[m[1]] = m[2];
}

// ---------------------------------------------------------------------------
// Prüfgerüst
// ---------------------------------------------------------------------------
let failed = 0, total = 0;
function check(name, fn) {
  total++;
  try {
    const note = fn();
    console.log(`ok      ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`FEHLER  ${name} — ${e.message}`);
  }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
/** Fehler je Fall sammeln, höchstens fünf zeigen */
function each(cases, fn) {
  const errs = [];
  for (const k of cases) { try { fn(k); } catch (e) { errs.push(`${k.name}: ${e.message}`); } }
  if (errs.length) throw new Error(`${errs.length} von ${cases.length} Fällen\n          ${errs.slice(0, 5).join('\n          ')}`);
  return `${cases.length} Fälle`;
}

// ---------------------------------------------------------------------------
// Einstellungen und Fälle
// ---------------------------------------------------------------------------
const ERFUNDEN = {
  company: { name: 'formsam', owner: 'Erika Mustermann', street: 'Teststraße 1', zip: '12345', city: 'Musterstadt', email: 'erika@example.org', phone: '', ustId: '', kleinunternehmer: true, country: 'Deutschland' },
  shop: { lieferzeit: '5–8 Werktage', liefergebiet: 'Deutschland' },
  legal: { hoster: 'IONOS SE, Elgendorfer Str. 57, 56410 Montabaur', serverOrt: 'Berlin (Deutschland)' },
  pricing: { currency: 'EUR', shipping: { flat: 4.9, freeFrom: 39 } },
  paypal: { enabled: false, clientId: '' },
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const bases = [['erfunden', ERFUNDEN]];
if (args.settings) bases.push(['datei', JSON.parse(fs.readFileSync(args.settings, 'utf8'))]);
const variants = [];
for (const [bn, base] of bases) {
  for (const klein of [true, false]) for (const pp of [false, true]) for (const tel of ['', '+49 30 1234567']) {
    const s = clone(base);
    s.company = { ...s.company, kleinunternehmer: klein, phone: tel, ...(klein ? {} : { ustId: 'DE123456789' }) };
    s.paypal = pp ? { enabled: true, clientId: 'test-client' } : { enabled: false, clientId: '' };
    variants.push({ vname: `${bn}/klein${+klein}-paypal${+pp}-tel${tel ? 1 : 0}`, s, klein, pp, tel: !!tel });
  }
}
const sonder = (name, f) => { const s = clone(ERFUNDEN); f(s); variants.push({ vname: `sonder/${name}`, s }); };
sonder('ohne-mail', (s) => { s.company.email = ''; });
sonder('alte-marke', (s) => { s.company.name = 'OVJU Eierbecher'; s.company.owner = ''; });
sonder('versandfrei', (s) => { s.pricing.shipping = { flat: 0 }; });
sonder('ohne-freigrenze', (s) => { s.pricing.shipping = { flat: 4.9 }; });
sonder('w-idnr', (s) => { s.company.ustId = 'DE123456789-00001'; s.company.kleinunternehmer = false; });
sonder('leer', (s) => { s.shop = {}; s.legal = {}; s.company.country = 'Österreich'; });
sonder('ohne-einstellungen', (s) => { for (const k of Object.keys(s)) delete s[k]; });
const BASE_URLS = ['https://shop.example', 'http://localhost:4488', ''];
const cases = [];
for (const v of variants) for (const baseUrl of BASE_URLS) for (const slug of LEGAL_SLUGS) cases.push({ ...v, baseUrl, slug, name: `${slug} ${v.vname} ${baseUrl || '(ohne baseUrl)'}` });

// ---------------------------------------------------------------------------
// 1. Bestehende Ausgaben bytegleich
// ---------------------------------------------------------------------------
async function loadReference() {
  if (args.alt) return { mod: await import(pathToFileURL(path.resolve(args.alt)).href), name: args.alt };
  const ref = args.ref || 'HEAD';
  const show = (p) => execFileSync('git', ['-C', ROOT, 'show', `${ref}:${p}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let src;
  try { src = show('lib/legal.js'); } catch (e) { return { skip: `git show ${ref}:lib/legal.js geht nicht (${String(e.message).split('\n')[0]})` }; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formsam-legal-ref-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(dir, 'legal.js'), src);
    for (const [, dep] of src.matchAll(/from '\.\/([\w.-]+\.js)'/g)) fs.writeFileSync(path.join(dir, dep), show(`lib/${dep}`));
    return { mod: await import(pathToFileURL(path.join(dir, 'legal.js')).href), name: `${ref}:lib/legal.js` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const reference = await loadReference();
check(`bestehende Ausgaben bytegleich mit ${reference.name || 'Vergleichsstand'} (forMail true/false)`, () => {
  if (reference.skip) {
    ok(!args.ref, reference.skip);   // ausdrücklich verlangter Stand fehlt → Fehler; ohne git (Standard HEAD) → übersprungen
    return `übersprungen: ${reference.skip}`;
  }
  let n = 0;
  const diff = [];
  for (const k of cases) for (const forMail of [false, true]) {
    const a = renderLegalPage(k.slug, { settings: k.s, baseUrl: k.baseUrl, forMail });
    const b = reference.mod.renderLegalPage(k.slug, { settings: k.s, baseUrl: k.baseUrl, forMail });
    n++;
    if (a !== b) {
      let i = 0; while (i < a.length && a[i] === b[i]) i++;
      diff.push(`${k.name} forMail=${forMail} ab Zeichen ${i}: ${JSON.stringify(b.slice(Math.max(0, i - 30), i + 40))} → ${JSON.stringify(a.slice(Math.max(0, i - 30), i + 40))}`);
    }
  }
  ok(!diff.length, `${diff.length} von ${n} Ausgaben weichen ab\n          ${diff.slice(0, 3).join('\n          ')}`);
  return `${n} Ausgaben`;
});

// ---------------------------------------------------------------------------
// 2. Druckfassung: Aufbau, CSS, Links, Text
// ---------------------------------------------------------------------------
const pdfOf = new Map(), mailOf = new Map();
check('Druckfassung entsteht für alle Fälle und ist bei gleicher Eingabe gleich', () => each(cases, (k) => {
  const a = renderLegalPage(k.slug, { settings: k.s, baseUrl: k.baseUrl, forPdf: true });
  ok(typeof a === 'string' && a.startsWith('<!DOCTYPE html>'), 'kein HTML-Dokument');
  ok(a === renderLegalPage(k.slug, { settings: k.s, baseUrl: k.baseUrl, forPdf: true }), 'zweiter Aufruf liefert etwas anderes');
  pdfOf.set(k, a);
  mailOf.set(k, renderLegalPage(k.slug, { settings: k.s, baseUrl: k.baseUrl, forMail: true }));
}));
check('unbekannte Seite → null, auch mit forPdf', () => { ok(renderLegalPage('gibtsnicht', { forPdf: true }) === null, 'nicht null'); });

// Erlaubte Mittel — dieselbe Liste steht im Bericht für den PDF-Satz
const HTML_TAGS = new Set('html head meta title style body header main footer section div h1 h2 h3 h4 p ul ol li strong b em i small span a br hr address blockquote table thead tbody tr th td'.split(' '));
const SVG_TAGS = new Set(['svg', 'path', 'title', 'g']);
const ATTRS = new Set(['class', 'id', 'href', 'lang', 'charset', 'aria-labelledby', 'aria-label', 'aria-hidden', 'role']);
const SVG_ATTRS = new Set(['class', 'xmlns', 'viewbox', 'width', 'height', 'role', 'aria-label', 'aria-hidden', 'focusable', 'd', 'fill', 'fill-rule']);
const CLASSES = new Set('kopf logo wortmarke doc eyebrow stand lead note addr box box-h box-strong plain wr muster end formular abs dash nr linie facts fuss'.split(' '));
const PROPS = new Set(('font-family font-size font-weight font-style line-height color background-color margin margin-top margin-right margin-bottom margin-left ' +
  'padding padding-top padding-right padding-bottom padding-left border border-top border-right border-bottom border-left border-radius border-collapse ' +
  'text-align vertical-align white-space text-transform letter-spacing text-decoration list-style-type width max-width display gap justify-content align-items ' +
  'break-inside break-after break-before').split(' '));
const VALUES = {
  display: /^(block|inline|inline-block|none|flex)$/, 'break-inside': /^avoid$/, 'break-after': /^avoid$/, 'break-before': /^page$/,
  'font-weight': /^(normal|bold|400|500|600|700)$/, 'font-style': /^normal$/, 'border-collapse': /^collapse$/,
};
const SELECTOR = /^(?:[a-z][a-z0-9]*)?(?:\.[a-z][a-z0-9-]*)*(?:\s+(?:[a-z][a-z0-9]*)?(?:\.[a-z][a-z0-9-]*)*)*$/;
const FONT_FACE = /^@font-face\{font-family:'(Inter|Fraunces)';src:url\(\/fonts\/[a-z-]+\.woff2\) format\('woff2'\);font-weight:\d+ \d+;font-display:swap\}$/;

/** CSS der Druckfassung prüfen → Liste der Verstöße */
function cssProblems(css) {
  const out = [];
  let rest = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const decls = (body, where) => {
    for (const d of body.split(';').map((x) => x.trim()).filter(Boolean)) {
      const m = /^([a-z-]+)\s*:\s*(.+)$/.exec(d);
      if (!m) { out.push(`${where}: unlesbar „${d}“`); continue; }
      const [, p, v] = m;
      if (!PROPS.has(p)) out.push(`${where}: Eigenschaft ${p} nicht erlaubt`);
      if (/var\(|calc\(|url\(|!important|attr\(|counter\(/i.test(v)) out.push(`${where}: Wert „${v}“ nicht erlaubt`);
      if (VALUES[p] && !VALUES[p].test(v)) out.push(`${where}: ${p}:${v} nicht erlaubt`);
      if (/^border(-(top|right|bottom|left))?$/.test(p) && !/^(none|0|[\d.]+(px|pt|mm) solid #[0-9a-f]{3,6})$/i.test(v)) out.push(`${where}: Rahmen „${v}“ (nur „Breite solid Farbe“)`);
    }
  };
  while (rest) {
    let m;
    if ((m = /^@font-face\{[^}]*\}/.exec(rest))) { if (!FONT_FACE.test(m[0])) out.push(`@font-face anders als in BELEG_CSS: ${m[0]}`); }
    else if ((m = /^@page\{([^}]*)\}/.exec(rest))) { if (!/^size:A4;margin:[\d.]+mm( [\d.]+mm){0,3}$/.test(m[1])) out.push(`@page: ${m[1]}`); }
    else if ((m = /^@media print\{((?:[^{}]*\{[^}]*\})*)\s*\}/.exec(rest))) { out.push(...cssProblems(m[1]).map((x) => `@media print: ${x}`)); }
    else if ((m = /^([^@{}][^{}]*)\{([^}]*)\}/.exec(rest))) {
      for (const sel of m[1].split(',').map((x) => x.trim())) if (!sel || !SELECTOR.test(sel)) out.push(`Selektor „${sel}“ nicht erlaubt`);
      decls(m[2], m[1].trim());
    } else { out.push(`nicht verstanden: ${rest.slice(0, 60)}`); break; }
    rest = rest.slice(m[0].length).trim();
  }
  return out;
}

check('Druckfassung: nur erlaubte Elemente, Attribute und Klassen; SVG nur im Kopf; kein Skript, kein Formular', () => each(cases, (k) => {
  const html = pdfOf.get(k);
  const stack = [];
  let svgDepth = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|<!--/g)) {
    if (m[0] === '<!--') throw new Error('Kommentar im Dokument');
    const [, close, tagRaw, attrs] = m, tag = tagRaw.toLowerCase();
    if (close) {
      if (tag === 'svg') svgDepth--;
      else if (!svgDepth && !['br', 'meta', 'hr'].includes(tag)) ok(stack.pop()?.split('.')[0] === tag, `</${tag}> passt nicht`);
      continue;
    }
    const inSvg = svgDepth > 0 || tag === 'svg';
    if (inSvg ? !SVG_TAGS.has(tag) : !HTML_TAGS.has(tag)) throw new Error(`Element <${tag}> nicht erlaubt`);
    if (tag === 'svg' && stack.join(' ') !== 'html body header.kopf') throw new Error('SVG außerhalb des Kopfs');
    for (const a of attrs.replace(/\/\s*$/, '').matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
      const n = a[1].toLowerCase();
      if (!(inSvg ? SVG_ATTRS : ATTRS).has(n)) throw new Error(`Attribut ${n} an <${tag}> nicht erlaubt`);
      if (n === 'class' && !inSvg) for (const c of a[2].split(/\s+/)) if (!CLASSES.has(c)) throw new Error(`Klasse „${c}“ nicht in der Liste`);
      if (n === 'href' && tag !== 'a') throw new Error(`href an <${tag}>`);
    }
    if (tag === 'svg') { if (!/\/\s*$/.test(attrs)) svgDepth++; }
    else if (!svgDepth && !['br', 'meta', 'hr'].includes(tag)) { const cl = /class="([^"]*)"/.exec(attrs); stack.push(cl ? `${tag}.${cl[1]}` : tag); }
  }
  ok(!stack.length && !svgDepth, `nicht geschlossen: ${stack.join(' ')}`);
  ok((html.match(/<style>/g) || []).length === 1 && /<head>[\s\S]*<style>[\s\S]*<\/style>[\s\S]*<\/head>/.test(html), 'genau ein <style> im Kopf');
}));

check('Druckfassung: CSS nur mit erlaubten Mitteln (Selektoren, Eigenschaften, Werte, @page/@font-face)', () => {
  const styles = new Set([...pdfOf.values()].map((h) => /<style>([\s\S]*?)<\/style>/.exec(h)[1]));
  ok(styles.size === 1, `${styles.size} verschiedene Stilblöcke`);
  const p = cssProblems([...styles][0]);
  ok(!p.length, p.slice(0, 8).join('; '));
  return `${[...styles][0].split('}').length - 1} Regeln`;
});

check('Druckfassung: Links absolut (Shop-Links mit baseUrl, ohne baseUrl nur Text)', () => each(cases, (k) => {
  const base = /^https?:\/\//.test(k.baseUrl) ? k.baseUrl : '';
  for (const [, href] of pdfOf.get(k).matchAll(/<a href="([^"]*)">/g)) {
    ok(/^(https?:|mailto:|tel:)/.test(href), `Link „${href}“ nicht absolut`);
    if (/^https?:/.test(href) && !href.startsWith('https://www.paypal.com/')) ok(base && href.startsWith(base), `Link „${href}“ zeigt nicht auf ${base || '(keine Adresse)'}`);
  }
  const mail = mailOf.get(k).match(/<main[\s\S]*<\/main>/)[0].replace(/<details class="toc"[^>]*>[\s\S]*?<\/details>/, '');
  const relativ = (mail.match(/<a [^>]*href="\//g) || []).length;
  const absolut = base ? (pdfOf.get(k).match(new RegExp(`<a href="${base.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`, 'g')) || []).length : 0;
  if (base) ok(absolut >= relativ, `${relativ} Shop-Links in der Mail-Fassung, aber nur ${absolut} absolute in der Druckfassung`);
}));

// Sichtbarer Text: Blockgrenzen → Leerraum, Inline-Elemente verschwinden ohne Leerraum (wie im Browser)
const INLINE = new Set(['a', 'strong', 'b', 'em', 'i', 'small', 'span', 'time']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: '\u00a0', '#39': "'" };
function words(html) {
  return html
    .replace(/<(script|style|svg|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g, (m, t) => (INLINE.has(t.toLowerCase()) ? '' : ' '))
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (m, e) => ENT[e])
    .split(/\s+/).filter(Boolean);
}
const mainOf = (html) => { const m = /<main\b[^>]*>([\s\S]*)<\/main>/.exec(html); if (!m) throw new Error('kein <main>'); return m[1]; };
const headings = (html) => [...html.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => `h${m[1]} ${words(m[2]).join(' ')}`);
/** Hauptinhalt der Mail-Fassung ohne Inhaltsverzeichnis / Druckfassung ohne die Nummern- und Strich-Spalte */
const mailMain = (k) => mainOf(mailOf.get(k)).replace(/<details class="toc"[^>]*>[\s\S]*?<\/details>/g, '');
const pdfMain = (k) => mainOf(pdfOf.get(k)).replace(/<td class="nr">[^<]*<\/td>/g, '');

check('Druckfassung: dieselben Überschriften in derselben Reihenfolge wie die Mail-Fassung', () => each(cases, (k) => {
  const a = headings(mailMain(k)), b = headings(pdfMain(k));
  ok(a.length > 1 && JSON.stringify(a) === JSON.stringify(b), `Mail ${JSON.stringify(a)} ≠ Druck ${JSON.stringify(b)}`);
}));
check('Druckfassung: Wort für Wort derselbe Text wie der Hauptinhalt der Mail-Fassung (ohne Inhaltsverzeichnis)', () => each(cases, (k) => {
  const a = words(mailMain(k)), b = words(pdfMain(k));
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  ok(i === a.length && a.length === b.length, `ab Wort ${i}: Mail „${a.slice(i, i + 8).join(' ')}“ ≠ Druck „${b.slice(i, i + 8).join(' ')}“`);
}));
check('Druckfassung: Zeichen-Bilanz des Fließtexts ausgeglichen', () => each(cases, (k) => {
  const count = (ws) => { const m = new Map(); for (const ch of ws.join('').toLowerCase()) m.set(ch, (m.get(ch) || 0) + 1); return m; };
  const a = count(words(mailMain(k))), b = count(words(pdfMain(k)));
  const d = [...new Set([...a.keys(), ...b.keys()])].filter((ch) => a.get(ch) !== b.get(ch)).map((ch) => `${JSON.stringify(ch)} ${a.get(ch) || 0}→${b.get(ch) || 0}`);
  ok(!d.length, d.slice(0, 6).join(', '));
}));
check('Druckfassung: begründete Zusätze — Absatznummern fortlaufend, sieben Spiegelstriche im Formular, Kopf und Fuß', () => each(cases, (k) => {
  const html = pdfOf.get(k);
  for (const t of html.matchAll(/<table class="abs"><tbody>([\s\S]*?)<\/tbody><\/table>/g)) {
    const nr = [...t[1].matchAll(/<td class="nr">\((\d+)\)<\/td>/g)].map((m) => +m[1]);
    ok(nr.length > 0 && nr.every((n, i) => n === i + 1), `Absatznummern ${nr.join(',')}`);
  }
  if (k.slug === 'agb') ok((html.match(/<table class="abs">/g) || []).length >= 8, 'AGB ohne nummerierte Absätze');
  if (k.slug === 'widerruf') ok((html.match(/<td class="nr">–<\/td>/g) || []).length === 7 && html.includes('<section id="formular" class="formular"'), 'Formular nicht mit sieben Zeilen');
  ok(/<header class="kopf"><span class="wortmarke">formsam<\/span><\/header>/.test(html), 'Kopf ohne Wortmarke');
  ok(/<footer class="fuss">[^<]*(<a href="[^"]+">[^<]+<\/a>)?<\/footer>/.test(html), 'Fußzeile fehlt');
}));
check('Textzweige der Einstellungen kommen in der Druckfassung vor (PayPal, Telefon, Kleinunternehmer, USt-IdNr.)', () => {
  const seen = { pp1: 0, pp0: 0, tel1: 0, tel0: 0, k1: 0, k0: 0 };
  for (const k of cases) {
    const t = words(pdfMain(k)).join(' ');
    if (k.slug === 'agb' && k.pp !== undefined) { ok(t.includes('mit PayPal bezahlen') === k.pp, `${k.name}: PayPal-Zweig falsch`); seen[`pp${+k.pp}`]++; }
    if (k.slug === 'impressum' && k.tel !== undefined) { ok(t.includes('Telefon:') === k.tel, `${k.name}: Telefon-Zweig falsch`); seen[`tel${+k.tel}`]++; }
    if (k.slug === 'impressum' && k.klein !== undefined) {
      ok(t.includes('Kleinunternehmer nach § 19 UStG.') === k.klein && t.includes('Umsatzsteuer-Identifikationsnummer') === !k.klein, `${k.name}: Steuer-Zweig falsch`);
      seen[`k${+k.klein}`]++;
    }
  }
  ok(Object.values(seen).every((n) => n > 0), `nicht alle Zweige geprüft: ${JSON.stringify(seen)}`);
  return JSON.stringify(seen);
});
check('Druckfassung: logoHtml (Inline-SVG) ersetzt die Wortmarke, anderes wird ignoriert', () => {
  const svg = '<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="28" height="28" role="img" aria-label="formsam"><title>formsam</title><path d="M0 0h10v10z"/></svg>';
  const a = renderLegalPage('agb', { settings: ERFUNDEN, forPdf: true, logoHtml: svg });
  ok(a.includes(`<header class="kopf">${svg}</header>`), 'SVG nicht im Kopf');
  const b = renderLegalPage('agb', { settings: ERFUNDEN, forPdf: true, logoHtml: '<img src="x.png">' });
  ok(b.includes('<span class="wortmarke">formsam</span>') && !b.includes('<img'), 'kein SVG → Wortmarke erwartet');
});

// ---------------------------------------------------------------------------
// 3. Gegenprobe mit dem PDF-Satz und dem PDF-Kern (nur, wenn es sie in dieser Fassung gibt)
// ---------------------------------------------------------------------------
const optional = async (p) => { try { return await import(p); } catch { return null; } };
const satz = await optional('../lib/html-pdf.js');
const kern = await optional('../lib/pdf.js');
const probe = cases.filter((k) => k.baseUrl === BASE_URLS[0]);
check('lib/html-pdf.js liest die Druckfassung ohne Warnung', () => {
  if (typeof satz?.styleTree !== 'function') return 'übersprungen: lib/html-pdf.js (styleTree) fehlt';
  return each(probe, (k) => { const w = satz.styleTree(pdfOf.get(k), { media: 'print' }).warnings; ok(!w.length, w.slice(0, 3).join('; ')); });
});
check('lib/html-pdf.js setzt jede Druckfassung als PDF (streng: ohne Warnung, Selbstprüfung Zeichen-Bilanz und Ränder)', () => {
  if (typeof satz?.htmlToPdf !== 'function') return 'übersprungen: lib/html-pdf.js (htmlToPdf) fehlt';
  const pages = {};
  const n = each(probe, (k) => { const r = satz.htmlToPdf(pdfOf.get(k), { strict: true }); (pages[k.slug] ||= new Set()).add(r.pages); });
  return `${n}, Seiten ${Object.entries(pages).map(([s, v]) => `${s} ${[...v].sort().join('/')}`).join(', ')}`;
});
check('lib/pdf.js: jedes Zeichen hat eine Glyphe (Inter für den Text, Fraunces für h1/h2 und Wortmarke)', () => {
  if (typeof kern?.missingChars !== 'function') return 'übersprungen: lib/pdf.js (missingChars) fehlt';
  return each(probe, (k) => {
    const html = pdfOf.get(k);
    const serif = [...html.matchAll(/<(h1|h2|span class="wortmarke")\b[^>]*>([\s\S]*?)<\/(h1|h2|span)>/g)].map((m) => words(m[2]).join(' ')).join(' ');
    const text = words(html.slice(html.indexOf('<body>'))).join(' ');
    const fehlt = [...kern.missingChars(text, 'Inter').map((c) => `Inter ${c}`), ...kern.missingChars(serif, 'Fraunces').map((c) => `Fraunces ${c}`)];
    ok(!fehlt.length, `fehlende Zeichen: ${fehlt.join(', ')}`);
  });
});

if (args.out) {
  fs.mkdirSync(args.out, { recursive: true });
  for (const slug of LEGAL_SLUGS) fs.writeFileSync(path.join(args.out, `${slug}.html`), renderLegalPage(slug, { settings: ERFUNDEN, baseUrl: BASE_URLS[0], forPdf: true }));
  console.log(`        Druckfassungen → ${args.out}`);
}
console.log(`\n${total - failed} von ${total} Prüfungen bestanden${failed ? ` — ${failed} FEHLER` : ''}`);
process.exit(failed ? 1 : 0);
