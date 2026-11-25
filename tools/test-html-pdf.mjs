// formsam — Selbsttest für lib/html-pdf.js, Teil 1: HTML einlesen, CSS-Kaskade für den Druck, sichtbarer Text (ohne Fremdpakete)
//
//   node tools/test-html-pdf.mjs        → eine Zeile je Prüfung; Exit 0 = alles gut, 1 = Fehler
//
// Testbelege: tools/fixtures/pdf/*.html — im Testshop erzeugt, nur erfundene Daten (Erika/Max Mustermann, Teststraße …).
// Die Sollwerte unter „Chrome-Sollwerte“ stammen aus getComputedStyle in Chrome (Druckansicht, Fensterbreite = Seiteninhalt).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseHtml, parseCss, computeStyles, styleTree, visibleText, decodeEntities, parseColor, matches, mediaMatches, applyTransform, IGNORED_PROPS,
} from '../lib/html-pdf.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pdf');

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
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (!same(got, want)) throw new Error(`${msg}: ${g} statt ${w}`);
};
function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.011;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') return Object.keys(b).every((k) => same(a[k], b[k])) && Object.keys(a).length === Object.keys(b).length;
  return a === b;
}
const elements = (root) => { const out = []; (function w(n) { for (const c of n.children) if (c.type === 'element') { out.push(c); w(c); } })(root); return out; };
/** erstes Element zum Selektor */
const $ = (root, sel) => elements(root).find((e) => matches(e, sel));
/** Stile eines kleinen Dokuments: CSS + Körper → Baum */
const doc = (css, body, opts) => styleTree(`<!DOCTYPE html><html><head><style>${css}</style></head><body>${body}</body></html>`, opts);
const st = (tree, sel) => { const e = $(tree.root, sel); if (!e) throw new Error(`kein Element zu ${sel}`); return e.style; };
const hasWarn = (tree, re) => tree.warnings.some((w) => re.test(w));

// ---------------------------------------------------------------------------
// 1. Zerlegung
// ---------------------------------------------------------------------------
check('Grundgerüst: DOCTYPE, html/head/body, Titel, Kommentare', () => {
  const w = [];
  const r = parseHtml('<!DOCTYPE html><html lang=de><head><meta charset="utf-8"><title>A &amp; B</title><!-- weg --></head><body><p>x<!-- y -->z</p></body></html>', w);
  eq(r.quirks, false, 'quirks');
  const [html] = r.children;
  eq(html.tag, 'html', 'Wurzel'); eq(html.attrs.lang, 'de', 'lang');
  eq(html.children.map((c) => c.tag), ['head', 'body'], 'Kinder von html');
  eq(html.children[0].children.map((c) => c.tag), ['meta', 'title'], 'head');
  eq(html.children[0].children[1].children[0].text, 'A & B', 'Titel mit Verweis');
  const p = html.children[1].children[0];
  eq(p.children.length, 1, 'Texte um den Kommentar zusammengefasst'); eq(p.children[0].text, 'xz', 'Text');
  eq(w, [], 'keine Warnungen');
  ok(JSON.stringify(r).length > 10, 'Baum lässt sich als JSON schreiben (parent nicht aufzählbar)');
});
check('fehlende html/head/body werden ergänzt, Quirks gemeldet', () => {
  const w = [];
  const r = parseHtml('<title>T</title><style>p{}</style><p>Hallo', w);
  const [html] = r.children;
  eq(html.children.map((c) => c.tag), ['head', 'body'], 'Gerüst');
  eq(html.children[0].children.map((c) => c.tag), ['title', 'style'], 'head');
  eq(html.children[1].children[0].tag, 'p', 'body');
  ok(r.quirks && w.some((x) => /DOCTYPE/.test(x)), 'Warnung ohne DOCTYPE');
});
check('Attribute: mit/ohne Anführungszeichen, ohne Wert, doppelt, Zeichenverweise, Großschreibung', () => {
  const r = parseHtml(`<!DOCTYPE html><p ID=a1 class='x  y' data-v="&quot;1&quot; &lt;2&gt;" hidden title=a&amp;b DATA-V="zweit" checked>t</p>`);
  const p = $(r, 'p');
  eq(p.attrs, { id: 'a1', class: 'x  y', 'data-v': '"1" <2>', hidden: '', title: 'a&b', checked: '' }, 'Attribute');
});
check('leere Elemente, Rohtext (style/script), pre-Zeilenumbruch, textarea', () => {
  const r = parseHtml('<!DOCTYPE html><body><p>a<br>b<br/>c<hr><img src=x><input value=1></p><style>a>b{c:"</p>"}</style><script>if(a<b&&c)x="&amp;"</script><pre>\nzeile</pre>');
  const body = r.children[0].children[1];
  eq(body.children.map((c) => c.tag), ['p', 'hr', 'img', 'input', 'p', 'style', 'script', 'pre'], 'body-Kinder (hr schließt p, </p> ohne p → leerer Absatz wie im Browser)');
  eq(body.children[0].children.map((c) => c.tag || c.text), ['a', 'br', 'b', 'br', 'c'], 'br leer');
  eq(body.children[5].children[0].text, 'a>b{c:"</p>"}', 'style roh');
  eq(body.children[6].children[0].text, 'if(a<b&&c)x="&amp;"', 'script roh, keine Verweise aufgelöst');
  eq(body.children[7].children[0].text, 'zeile', 'erster Zeilenumbruch in pre entfällt');
});
check('fehlende Schluss-Tags: p, li, dt/dd, Überschriften', () => {
  const r = parseHtml('<!DOCTYPE html><body><p>1<p>2<div>3</div><ul><li>a<li>b<ul><li>c</ul><li>d</ul><dl><dt>x<dd>y<dt>z</dl><h1>A<h2>B</h2>');
  const b = r.children[0].children[1];
  eq(b.children.map((c) => c.tag), ['p', 'p', 'div', 'ul', 'dl', 'h1', 'h2'], 'Geschwister');
  eq(b.children[3].children.map((c) => c.tag), ['li', 'li', 'li'], 'li schließt li');
  eq(b.children[3].children[1].children.map((c) => c.tag || c.text), ['b', 'ul'], 'verschachtelte Liste im zweiten li');
  eq(b.children[4].children.map((c) => c.tag), ['dt', 'dd', 'dt'], 'dl');
});
check('Tabellen: implizites tbody/tr, td/th/tr/thead ohne Schluss-Tag, verschachtelt', () => {
  const w = [];
  const r = parseHtml('<!DOCTYPE html><table><thead><tr><th>a</th></tr><tbody><tr><td>b<td>c<tr><td>d<table><tr><td>e</table></td></table><table><td>f</table>', w);
  const [t1, t2] = elements(r).filter((e) => e.tag === 'table' && e.parent.tag === 'body');
  eq(t1.children.map((c) => c.tag), ['thead', 'tbody'], 'tbody schließt thead');
  const tb = t1.children[1];
  eq(tb.children.map((c) => c.tag), ['tr', 'tr'], 'tr schließt tr');
  eq(tb.children[0].children.map((c) => c.tag), ['td', 'td'], 'td schließt td');
  const inner = tb.children[1].children[0].children[1];
  eq([inner.tag, inner.children[0].tag, inner.children[0].children[0].tag], ['table', 'tbody', 'tr'], 'innere Tabelle mit implizitem tbody');
  eq([t2.children[0].tag, t2.children[0].children[0].tag], ['tbody', 'tr'], 'td direkt in table → tbody + tr');
  eq(w, [], 'keine Warnungen');
});
check('Unstimmiges wird gemeldet: Text direkt in table, überzähliges End-Tag, offenes span', () => {
  const w = [];
  parseHtml('<!DOCTYPE html><table>lose<tr><td>a</td></tr></table></span><div><span>x</div>', w);
  ok(w.some((x) => /direkt in <table>/.test(x)), 'Text in table');
  ok(w.some((x) => /<\/span> passt/.test(x)), 'überzähliges </span>');
  ok(w.some((x) => /<span> ohne Schluss-Tag/.test(x)), 'offenes span');
});
check('Inline-SVG (Logo): viewBox in richtiger Schreibung, path mit d/fill/fill-rule/transform', () => {
  const r = parseHtml('<!DOCTYPE html><svg class="logo" VIEWBOX="0 0 377.6 100" width="128.4" height="34"><title>formsam</title><g transform="translate(1 2)"><path fill-rule="evenodd" fill="#c86f4a" d="M0 0L1 1Z"/></g><path d="M2 2"/></svg><p>nach</p>');
  const svg = $(r, 'svg');
  eq([svg.ns, svg.attrs.viewBox, svg.attrs.width, svg.attrs.height], ['svg', '0 0 377.6 100', '128.4', '34'], 'svg');
  eq(svg.children.map((c) => c.tag), ['title', 'g', 'path'], 'Kinder');
  const p = svg.children[1].children[0];
  eq([p.ns, p.attrs['fill-rule'], p.attrs.fill, p.attrs.d, svg.children[1].attrs.transform], ['svg', 'evenodd', '#c86f4a', 'M0 0L1 1Z', 'translate(1 2)'], 'path');
  eq(svg.parent.children[1].tag, 'p', 'selbstschließende path-Elemente beenden das svg nicht');
});

// ---------------------------------------------------------------------------
// 2. Zeichenverweise
// ---------------------------------------------------------------------------
check('Zeichenverweise: benannt (HTML 4), numerisch, Windows-1252, ungültig', () => {
  const cases = [['&amp;&lt;&gt;&quot;&apos;', '&<>"\''], ['&#8364;&#x20AC;&#X20ac;&euro;', '€€€€'], ['&nbsp;|&shy;|&thinsp;', '\u00a0|­| '],
    ['&ndash;&mdash;&bdquo;&ldquo;&rdquo;&sbquo;&lsquo;&rsquo;&laquo;&raquo;', '–—„“”‚‘’«»'], ['&hellip;&middot;&bull;&times;&minus;&deg;&sect;&copy;&reg;&trade;', '…·•×−°§©®™'],
    ['&auml;&ouml;&uuml;&Auml;&Ouml;&Uuml;&szlig;&eacute;', 'äöüÄÖÜßé'], ['&alpha;&Omega;&larr;&le;&ne;&hearts;&lang;&rang;', 'αΩ←≤≠♥⟨⟩'],
    ['&#128;&#150;&#151;', '€–—'], ['&#0;&#xD800;&#x110000;', '���'], ['&#65;&#x41g&#8364 5', 'AAg€ 5'],
    ['&copy 2026 &amp 1 &lt 4 &ampere; &notit;', '© 2026 & 1 < 4 &ere; ¬it;'], ['AT&T &; &# &#x; a&b &euro 5', 'AT&T &; &# &#x; a&b &euro 5']];
  for (const [i, o] of cases) eq(decodeEntities(i), o, i);
  eq(decodeEntities('&amp=x &ampx; &copy;2026 &copy 1', true), '&amp=x &ampx; ©2026 © 1', 'in Attributen: ohne Semikolon vor = oder Buchstabe nicht aufgelöst');
  const w = [];
  eq(decodeEntities('&check; &unbekannt;', false, (m) => w.push(m)), '&check; &unbekannt;', 'unbekannt bleibt stehen');
  eq(w.length, 2, 'unbekannte Verweise gewarnt');
});

// ---------------------------------------------------------------------------
// 3. Selektoren, Spezifität, Reihenfolge, !important
// ---------------------------------------------------------------------------
check('Selektoren: Typ, *, Klasse, id, zusammengesetzt, Nachfahre, Kind, Gruppe, Attribute, Pseudoklassen', () => {
  const t = doc('', '<div id="d" class="a b"><p class="x" title="Hallo Welt" lang="de-AT">1</p><span>2</span><p>3</p><section><p>4</p></section></div><ul><li>a</li><li>b</li><li>c</li><li>d</li><li>e</li></ul>');
  const el = (s) => $(t.root, s);
  const all = (s) => elements(t.root).filter((e) => matches(e, s)).map((e) => e.children[0]?.text ?? e.tag);
  eq(all('div p'), ['1', '3', '4'], 'Nachfahre'); eq(all('div > p'), ['1', '3'], 'Kind'); eq(all('#d.a.b > p.x'), ['1'], 'zusammengesetzt');
  eq(all('p, span'), ['1', '2', '3', '4'], 'Gruppe'); eq(all('[title]'), ['1'], '[attr]'); eq(all('[title="Hallo Welt"]'), ['1'], '[attr=wert]');
  eq(all('[title="hallo welt" i]'), ['1'], '[… i]'); eq(all('[lang|=de]'), ['1'], '|='); eq(all('[class~=b]'), ['div'], '~=');
  eq(all('[title^=Hal]'), ['1'], '^='); eq(all('[title$=elt]'), ['1'], '$='); eq(all('[title*="o W"]'), ['1'], '*=');
  eq(all('li:first-child'), ['a'], ':first-child'); eq(all('li:last-child'), ['e'], ':last-child');
  eq(all('li:nth-child(2n+1)'), ['a', 'c', 'e'], 'nth-child(2n+1)'); eq(all('li:nth-child(even)'), ['b', 'd'], 'even');
  eq(all('li:nth-child(-n+2)'), ['a', 'b'], '-n+2'); eq(all('li:nth-child( 3 )'), ['c'], 'Zahl'); eq(all('li:nth-last-child(2)'), ['d'], 'nth-last-child');
  eq(all('li:not(:first-child):not(:last-child)'), ['b', 'c', 'd'], ':not'); eq(all('div > :not(p)'), ['2', 'section'], ':not(Typ)');
  eq(all('p:first-of-type'), ['1', '4'], ':first-of-type'); eq(all('p + span'), ['2'], '+'); eq(all('span ~ p'), ['3'], '~');
  eq(all('section p:only-child'), ['4'], ':only-child'); ok(matches(el('html'), ':root'), ':root'); eq(all('p:hover'), [], ':hover trifft im Druck nie');
  eq(all('*').length, elements(t.root).length, '*');
});
check('nicht unterstützte Selektoren: Regel übersprungen + Warnung; Bildschirm-Pseudo-Elemente still', () => {
  const t = doc('p::before{color:red} p:has(b){color:red} a:lang(de){color:red} p:is(.x){color:red} ::selection{color:red} input::placeholder{color:red} p > {color:red} p{color:#00f}', '<p class="x">a</p>');
  eq(st(t, 'p').color, [0, 0, 255], 'gültige Regel gilt');
  for (const re of [/::before/, /:has/, /:lang/, /:is/, /„p >“/]) ok(hasWarn(t, re), `Warnung ${re}`);
  ok(!hasWarn(t, /selection|placeholder/), 'keine Warnung für ::selection/::placeholder');
});
check('Kaskade: Spezifität, Reihenfolge, !important, style-Attribut, :not-Spezifität', () => {
  const t = doc(`.r1 p{padding-left:1px} .r1 .x{padding-left:2px} .r1 #r1a{padding-left:3px} .r1 p.x{padding-left:4px}
    .r2 p{padding-left:5px} .r2 p{padding-left:6px}
    .r3 p{padding-left:7px !important} .r3 #r3a{padding-left:8px}
    .r4 p{padding-left:9px!important} .r4 #r4a{padding-left:10px ! important}
    .r6 p{padding-left:12px!important} .r7 #r7a{padding-left:13px!important}
    .r9 p:not(#nix){padding-left:17px} .r9 .x.y{padding-left:18px}
    .r10 p{padding-left:19px;padding-left:quatsch;padding-left:20;padding-left:-3px}
    .r12 p{padding:5px;padding-left:21px} .r13 p{padding-left:21px;padding:5px}`,
  `<div class="r1"><p>a</p><p class="x">b</p><p class="x" id="r1a">c</p></div><div class="r2"><p>a</p></div><div class="r3"><p id="r3a">a</p></div>
   <div class="r4"><p id="r4a">a</p></div><div class="r5"><p style="padding-left:22px">a</p><p style="PADDING-LEFT: 23px ; ">b</p></div>
   <div class="r6"><p style="padding-left:25px">a</p><p style="padding-left:26px!important">b</p></div><div class="r7"><p id="r7a" style="padding-left:27px">a</p></div>
   <div class="r9"><p class="x y">a</p></div><div class="r10"><p>a</p></div><div class="r12"><p>a</p></div><div class="r13"><p>a</p></div>`);
  const pl = (s) => st(t, s).paddingLeft;
  eq([pl('.r1 p'), pl('.r1 p.x'), pl('#r1a')], [1, 4, 3], 'r1'); eq(pl('.r2 p'), 6, 'spätere Regel'); eq(pl('#r3a'), 7, '!important vor id');
  eq(pl('#r4a'), 10, 'beide !important → id'); eq(pl('.r5 p'), 22, 'style-Attribut'); eq(pl('.r5 p:last-child'), 23, 'style-Attribut in Großschreibung');
  eq(pl('.r6 p'), 12, '!important vor style-Attribut'); eq(pl('.r6 p:last-child'), 26, 'style-Attribut !important'); eq(pl('#r7a'), 13, 'id !important vor style');
  eq(pl('.r9 p'), 17, ':not(#id) zählt wie id'); eq(pl('.r10 p'), 19, 'ungültige Werte überschreiben nicht'); eq(pl('.r12 p'), 21, 'Langform nach Kurzform');
  eq(pl('.r13 p'), 5, 'Kurzform nach Langform');
  ok(hasWarn(t, /padding-left: quatsch/) && hasWarn(t, /padding-left: 20 /) && hasWarn(t, /padding-left: -3px/), 'ungültige Werte gewarnt');
});

// ---------------------------------------------------------------------------
// 4. Kurzschreibweisen, Einheiten, Farben
// ---------------------------------------------------------------------------
check('Kurzschreibweisen: margin/padding 1–4 Werte, auto, %, logische Seiten', () => {
  const t = doc('.a{margin:1px}.b{margin:1px 2px}.c{margin:1px 2px 3px}.d{margin:1px 2px 3px 4px}.e{margin:0 auto}.f{margin:-5px 10%}.g{padding:5%}'
    + '.h{margin-inline:auto;margin-block:3px 4px;padding-inline:5px 6px;padding-block:7px}.i{margin-block-start:1px;margin-inline-end:4px}', '<div class="a"></div><div class="b"></div><div class="c"></div><div class="d"></div><div class="e"></div><div class="f"></div><div class="g"></div><div class="h"></div><div class="i"></div>');
  const m = (s) => { const x = st(t, s); return [x.marginTop, x.marginRight, x.marginBottom, x.marginLeft]; };
  eq(m('.a'), [1, 1, 1, 1], '1'); eq(m('.b'), [1, 2, 1, 2], '2'); eq(m('.c'), [1, 2, 3, 2], '3'); eq(m('.d'), [1, 2, 3, 4], '4');
  eq(m('.e'), [0, 'auto', 0, 'auto'], 'auto'); eq(m('.f'), [-5, { pct: 10 }, -5, { pct: 10 }], 'negativ/%'); eq(st(t, '.g').paddingTop, { pct: 5 }, 'padding %');
  const h = st(t, '.h'); eq([h.marginLeft, h.marginRight, h.marginTop, h.marginBottom, h.paddingLeft, h.paddingRight, h.paddingTop, h.paddingBottom], ['auto', 'auto', 3, 4, 5, 6, 7, 7], 'inline/block');
  eq([st(t, '.i').marginTop, st(t, '.i').marginRight], [1, 4], '-start/-end');
});
check('Kurzschreibweisen: border, border-<seite>, -width/-style/-color, border-radius, Rundung der Rahmenbreite wie Chrome', () => {
  const t = doc(`.a{border:1px solid #e6ddd0}.b{border:solid}.c{border:2px dashed;color:teal}.d{border:1px solid red;border-bottom:none}.e{border-left:3px solid #c86f4a}
    .f{border:5px solid red;border-width:1px 2px;border-style:solid dashed dotted;border-color:red green blue black}.g{border:thin dotted red}.h{border:thick double}
    .i{border-width:0.5px 1.5px 2.4px 0.2px;border-style:solid}.j{border-radius:0 8px 8px 0}.k{border-radius:4px}.l{border-radius:1px 2px 3px}.m{border-radius:50%}
    .n{border:1px solid;border-style:none}.o{border:0}.p{border-top:2.6px solid}`,
  '<p class="a">a</p><p class="b">b</p><p class="c">c</p><p class="d">d</p><p class="e">e</p><p class="f">f</p><p class="g">g</p><p class="h">h</p><p class="i">i</p><p class="j">j</p><p class="k">k</p><p class="l">l</p><p class="m">m</p><p class="n">n</p><p class="o">o</p><p class="p">p</p>');
  const b = (s) => { const x = st(t, s); return ['Top', 'Right', 'Bottom', 'Left'].map((k) => [x[`border${k}Width`], x[`border${k}Style`], x[`border${k}Color`]]); };
  eq(b('.a')[0], [1, 'solid', [230, 221, 208]], 'border'); eq(b('.b')[2], [3, 'solid', [0, 0, 0]], 'nur Stil → medium, currentColor');
  eq(b('.c')[1], [2, 'dashed', [0, 128, 128]], 'currentColor = color'); eq(b('.d').map((x) => x[0]), [1, 1, 0, 1], 'border-bottom:none');
  eq(b('.e')[3], [3, 'solid', [200, 111, 74]], 'border-left');
  eq(b('.f'), [[1, 'solid', [255, 0, 0]], [2, 'dashed', [0, 128, 0]], [1, 'dotted', [0, 0, 255]], [2, 'dashed', [0, 0, 0]]], '-width/-style/-color');
  eq(b('.g')[0], [1, 'dotted', [255, 0, 0]], 'thin'); eq(b('.h')[0][0], 5, 'thick');
  eq(b('.i').map((x) => x[0]), [1, 1, 2, 1], '0,5 → 1, 1,5 → 1, 2,4 → 2, 0,2 → 1 (Chrome)');
  const r = (s) => { const x = st(t, s); return [x.borderTopLeftRadius, x.borderTopRightRadius, x.borderBottomRightRadius, x.borderBottomLeftRadius]; };
  eq(r('.j'), [0, 8, 8, 0], 'radius 4'); eq(r('.k'), [4, 4, 4, 4], 'radius 1'); eq(r('.l'), [1, 2, 3, 2], 'radius 3'); eq(r('.m')[0], { pct: 50 }, 'radius %');
  eq(b('.n')[0][0], 0, 'Stil none → Breite 0'); eq(b('.o')[0][0], 0, 'border:0'); eq(b('.p')[0][0], 2, '2,6 → 2');
});
check('Kurzschreibweisen: background, font, list-style, text-decoration, flex, flex-flow, gap', () => {
  const t = doc(`.a{background:#f4efe7}.b{background:#f4efe7;background:none}.c{background:rgba(200,111,74,.2) none no-repeat}
    .d{font:italic bold 12px/1.5 Georgia,serif}.e{font:14px Inter}.f{font:700 1.2em/20px "Segoe UI",sans-serif}.g{font:bold x-large serif}.h{font:12px/1 Inter}.h span{font:inherit}
    .i{list-style:none}.j{list-style:square inside}.k{text-decoration:underline dotted red}.l{text-decoration:none}
    .m{flex:1}.n{flex:none}.o{flex:auto}.p{flex:0 0 200px}.q{flex:2 3}.r{flex:1 30px}.s{flex-flow:column wrap;gap:4px 8px}.t{gap:6px}`,
  '<p class="a">a</p><p class="b">b</p><p class="c">c</p><p class="d">d</p><p class="e">e</p><p class="f">f</p><p class="g">g</p><p class="h"><span>h</span></p><ul class="i"></ul><ul class="j"></ul><p class="k">k</p><p class="l">l</p><p class="m">m</p><p class="n">n</p><p class="o">o</p><p class="p">p</p><p class="q">q</p><p class="r">r</p><p class="s">s</p><p class="t">t</p>');
  eq(st(t, '.a').backgroundColor, [244, 239, 231], 'background-Farbe'); eq(st(t, '.b').backgroundColor, [0, 0, 0, 0], 'background:none');
  eq(st(t, '.c').backgroundColor, [200, 111, 74, 0.2], 'background mit Zusätzen');
  const f = (s) => { const x = st(t, s); return [x.fontStyle, x.fontWeight, x.fontSize, x.lineHeight, x.fontFamily]; };
  eq(f('.d'), ['italic', 700, 12, 18, ['Georgia', 'serif']], 'font 1'); eq(f('.e'), ['normal', 400, 14, 'normal', ['Inter']], 'font 2 (setzt line-height zurück)');
  eq(f('.f'), ['normal', 700, 19.2, 20, ['Segoe UI', 'sans-serif']], 'font 3'); eq(f('.g'), ['normal', 700, 24, 'normal', ['serif']], 'font 4');
  eq(f('.h span'), ['normal', 400, 12, 12, ['Inter']], 'font:inherit');
  eq(st(t, '.i').listStyleType, 'none', 'list-style:none'); eq([st(t, '.j').listStyleType, st(t, '.j').listStylePosition], ['square', 'inside'], 'list-style');
  eq([st(t, '.k').textDecorationLine, st(t, '.k').textDecorationStyle, st(t, '.k').textDecorationColor], [['underline'], 'dotted', [255, 0, 0]], 'text-decoration');
  eq(st(t, '.l').textDecorationLine, [], 'text-decoration:none');
  const fl = (s) => { const x = st(t, s); return [x.flexGrow, x.flexShrink, x.flexBasis]; };
  eq(fl('.m'), [1, 1, { pct: 0 }], 'flex:1'); eq(fl('.n'), [0, 0, 'auto'], 'flex:none'); eq(fl('.o'), [1, 1, 'auto'], 'flex:auto'); eq(fl('.p'), [0, 0, 200], 'flex:0 0 200px');
  eq(fl('.q'), [2, 3, { pct: 0 }], 'flex:2 3'); eq(fl('.r'), [1, 1, 30], 'flex:1 30px');
  eq([st(t, '.s').flexDirection, st(t, '.s').flexWrap, st(t, '.s').rowGap, st(t, '.s').columnGap], ['column', 'wrap', 4, 8], 'flex-flow/gap');
  eq([st(t, '.t').rowGap, st(t, '.t').columnGap, st(t, '.a').rowGap], [6, 6, 0], 'gap 1 Wert / normal → 0');
});
check('Einheiten: px pt pc mm cm in q em rem %, Schriftgrößen-Schlüsselwörter, line-height', () => {
  const t = doc(`html{font-size:10px} body{font-size:1.6rem}
    .u1{width:100px}.u2{width:72pt}.u3{width:6pc}.u4{width:25.4mm}.u5{width:2.54cm}.u6{width:1in}.u7{width:2em}.u8{width:2rem}.u9{width:50%}.u10{width:101.6q}.u11{width:1.5e2px}
    .u13{font-size:20px;width:2em;padding-left:.5em;margin-left:1.5em;border:.1em solid}.u14{font-size:2em}.u15{font-size:150%}
    .k1{font-size:xx-small}.k3{font-size:small}.k4{font-size:medium}.k7{font-size:xx-large}.k9{font-size:smaller}.k10{font-size:larger}
    .z1{line-height:1.5}.z2{line-height:20px}.z3{line-height:150%}.z4{line-height:2em}.z5{line-height:normal}.z6{line-height:12pt}
    .z1 span,.z2 span,.z3 span,.z4 span,.z5 span,.z6 span{font-size:30px}`,
  '<div class="u1"></div><div class="u2"></div><div class="u3"></div><div class="u4"></div><div class="u5"></div><div class="u6"></div><div class="u7"></div><div class="u8"></div><div class="u9"></div><div class="u10"></div><div class="u11"></div>'
  + '<div class="u13"></div><div class="u14"><div class="u14"></div></div><div class="u15"></div><p class="k1"></p><p class="k3"></p><p class="k4"></p><p class="k7"></p><p class="k9"><span class="k9"></span></p><p class="k10"></p>'
  + '<p class="z1"><span></span></p><p class="z2"><span></span></p><p class="z3"><span></span></p><p class="z4"><span></span></p><p class="z5"><span></span></p><p class="z6"><span></span></p>');
  for (const k of [2, 3, 4, 5, 6, 10]) eq(st(t, `.u${k}`).width, 96, `u${k} = 1 Zoll`);
  eq([st(t, '.u1').width, st(t, '.u7').width, st(t, '.u8').width, st(t, '.u9').width, st(t, '.u11').width], [100, 32, 20, { pct: 50 }, 150], 'px/em/rem/%/e-Schreibweise');
  const u13 = st(t, '.u13'); eq([u13.width, u13.paddingLeft, u13.marginLeft, u13.borderTopWidth], [40, 10, 30, 2], 'em am Element selbst');
  eq([st(t, '.u14').fontSize, st(t, '.u14 .u14').fontSize, st(t, '.u15').fontSize], [32, 64, 24], 'font-size em/% vom Elternteil');
  eq([st(t, '.k1').fontSize, st(t, '.k3').fontSize, st(t, '.k4').fontSize, st(t, '.k7').fontSize], [9, 13, 16, 32], 'Schlüsselwörter (wie Chrome)');
  eq([st(t, '.k9').fontSize, st(t, '.k9 span').fontSize, st(t, '.k10').fontSize], [16 / 1.2, 16 / 1.44, 19.2], 'smaller/larger');
  const lh = (s) => [st(t, s).lineHeight, st(t, s).lineHeightFactor];
  eq(lh('.z1'), [24, 1.5], 'Faktor'); eq(lh('.z1 span'), [45, 1.5], 'Faktor wird als Faktor vererbt'); eq(lh('.z2 span'), [20, null], 'px vererbt als px');
  eq(lh('.z3 span'), [24, null], '% wird zu px'); eq(lh('.z4 span'), [32, null], 'em wird zu px'); eq(lh('.z5 span'), ['normal', null], 'normal'); eq(lh('.z6'), [16, null], 'pt');
});
check('Farben: Hex 3/4/6/8, rgb()/rgba() in beiden Schreibweisen, hsl(), Namen, transparent, currentColor', () => {
  const c = (v) => parseColor(v);
  eq(c('#abc'), [170, 187, 204, 1], '#abc'); eq(c('#a1b2c380'), [161, 178, 195, 128 / 255], '#8'); eq(c('#abcd'), [170, 187, 204, 221 / 255], '#4');
  eq(c('rgb(1,2,3)'), [1, 2, 3, 1], 'rgb'); eq(c('rgb(1 2 3 / 50%)'), [1, 2, 3, 0.5], 'rgb Leerzeichen'); eq(c('rgba(1,2,3,.5)'), [1, 2, 3, 0.5], 'rgba');
  eq(c('rgb(10%,20%,30%)'), [26, 51, 77, 1], 'rgb %'); eq(c('rgb(300,-5,128)'), [255, 0, 128, 1], 'begrenzt'); eq(c('rgb(1.6,2.4,3.5)'), [2, 2, 4, 1], 'gerundet');
  eq(c('hsl(120,100%,25%)'), [0, 128, 0, 1], 'hsl'); eq(c('hsl(30deg 80% 50% / .25)'), [230, 128, 26, 0.25], 'hsl wie Chrome gerundet');
  eq(c('RED'), [255, 0, 0, 1], 'Name'); eq(c('rebeccapurple'), [102, 51, 153, 1], 'rebeccapurple'); eq(c('transparent'), [0, 0, 0, 0], 'transparent');
  eq(c('currentColor'), 'currentcolor', 'currentColor'); eq([c('keinefarbe'), c('#abcde'), c('rgb(1,2)')], [undefined, undefined, undefined], 'ungültig');
  const t = doc('.a{color:navy}.a span{border:1px solid;background-color:currentColor;color:inherit}', '<p class="a"><span>x</span></p>');
  eq([st(t, '.a span').borderTopColor, st(t, '.a span').backgroundColor], [[0, 0, 128], [0, 0, 128]], 'currentColor in Rahmen/Hintergrund');
});

// ---------------------------------------------------------------------------
// 5. Vererbung, Grundstil, Anzeigeart
// ---------------------------------------------------------------------------
check('Vererbung, inherit/initial/unset', () => {
  const t = doc(`.e1{color:#9e4f2c;font-size:20px;font-weight:600;font-style:italic;line-height:1.2;text-align:right;white-space:nowrap;text-transform:uppercase;letter-spacing:.06em;
    list-style-type:square;border-collapse:collapse;visibility:hidden;border:2px solid red;padding:3px;background-color:#eee;width:300px}
    .e2{border:inherit;padding:inherit;background-color:inherit;width:inherit}.e3{color:initial;font-size:initial;font-weight:initial;text-align:initial;visibility:initial}
    .e4{color:unset;padding:unset}.e6{font-size:10px;letter-spacing:.1em}.e6 span{font-size:30px}`,
  '<div class="e1"><div class="kind">b</div><div class="e2">d</div><div class="e3">e</div><div class="e4">f</div><table><tr><td>h</td></tr></table></div><div class="e6"><span>x</span></div>');
  const k = st(t, '.kind');
  eq([k.color, k.fontSize, k.fontWeight, k.fontStyle, k.lineHeight, k.textAlign, k.whiteSpace, k.textTransform, k.letterSpacing, k.listStyleType, k.borderCollapse, k.visibility],
    [[158, 79, 44], 20, 600, 'italic', 24, 'right', 'nowrap', 'uppercase', 1.2, 'square', 'collapse', 'hidden'], 'vererbte Eigenschaften');
  eq([k.borderTopWidth, k.paddingTop, k.backgroundColor, k.width], [0, 0, [0, 0, 0, 0], 'auto'], 'nicht vererbte bleiben beim Anfangswert');
  const e2 = st(t, '.e2'); eq([e2.borderTopWidth, e2.borderTopStyle, e2.paddingTop, e2.backgroundColor, e2.width], [2, 'solid', 3, [238, 238, 238], 300], 'inherit');
  const e3 = st(t, '.e3'); eq([e3.color, e3.fontSize, e3.fontWeight, e3.textAlign, e3.visibility], [[0, 0, 0], 16, 400, 'left', 'visible'], 'initial');
  eq([st(t, '.e4').color, st(t, '.e4').paddingTop], [[158, 79, 44], 0], 'unset');
  eq([st(t, '.e1 table').borderCollapse, st(t, '.e1 td').borderCollapse], ['separate', 'separate'], 'Grundstil von table setzt border-collapse zurück (wie Chrome)');
  const c = doc('table{border-collapse:collapse}', '<table><tr><td>x</td></tr></table>');
  eq(st(c, 'td').borderCollapse, 'collapse', 'border-collapse erbt in die Zelle');
  eq(st(t, '.e6 span').letterSpacing, 1, 'letter-spacing erbt als px (nicht als em)');
});
check('Browser-Grundstil wie Chrome: body, p, h1–h6, Listen, Tabellen, b/small/a/th, hr, blockquote', () => {
  const t = doc('', '<h1>a<b>b</b><small>c</small></h1><h2>x</h2><h3>x</h3><h4>x</h4><h5>x</h5><h6>x</h6><p>p <strong>s</strong> <em>e</em> <a href="#">l</a> <a>n</a> <u>u</u> <s>s</s> <sub>2</sub></p>'
    + '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul><ol><li>1<ol><li>2</li></ol></li></ol><table><tr><th>k</th><td>z</td></tr></table><hr><blockquote>q</blockquote><address>adr</address><dl><dd>d</dd></dl>');
  const b = st(t, 'body'); eq([b.marginTop, b.marginLeft, b.fontSize, b.fontFamily, b.color, b.display], [8, 8, 16, ['serif'], [0, 0, 0], 'block'], 'body');
  eq([st(t, 'p').marginTop, st(t, 'p').marginBottom], [16, 16], 'p 1em');
  const h = (s) => [st(t, s).fontSize, st(t, s).marginTop, st(t, s).fontWeight];
  eq(h('h1'), [32, 21.44, 700], 'h1'); eq(h('h2'), [24, 19.92, 700], 'h2'); eq(h('h3'), [18.72, 18.72, 700], 'h3'); eq(h('h4'), [16, 21.28, 700], 'h4');
  eq(h('h5'), [13.28, 22.1776, 700], 'h5'); eq(h('h6'), [10.72, 24.9776, 700], 'h6');
  eq([st(t, 'h1 b').fontWeight, st(t, 'h1 small').fontSize], [900, 32 / 1.2], 'b in h1 = bolder, small = smaller');
  eq([st(t, 'strong').fontWeight, st(t, 'em').fontStyle, st(t, 'u').textDecorationLine, st(t, 's').textDecorationLine, st(t, 'sub').verticalAlign], [700, 'italic', ['underline'], ['line-through'], 'sub'], 'Textauszeichnung');
  const a = st(t, 'a[href]'); eq([a.color, a.textDecorationLine], [[0, 0, 238], ['underline']], 'a mit href'); eq(st(t, 'a:not([href])').textDecorationLine, [], 'a ohne href');
  eq([st(t, 'ul').paddingLeft, st(t, 'ul').marginTop, st(t, 'ul').listStyleType, st(t, 'ul ul').listStyleType, st(t, 'ul ul ul').listStyleType, st(t, 'ul ul').marginTop], [40, 16, 'disc', 'circle', 'square', 0], 'ul');
  eq([st(t, 'li').display, st(t, 'ol').listStyleType, st(t, 'ol ol').marginTop], ['list-item', 'decimal', 0], 'ol/li');
  eq([st(t, 'table').display, st(t, 'table').borderSpacing, st(t, 'table').boxSizing, st(t, 'tbody').verticalAlign, st(t, 'td').verticalAlign, st(t, 'td').paddingTop], ['table', [2, 2], 'border-box', 'middle', 'middle', 1], 'table');
  eq([st(t, 'th').fontWeight, st(t, 'th').textAlign, st(t, 'td').textAlign, st(t, 'table').borderTopColor], [700, 'center', 'left', [128, 128, 128]], 'th/td');
  const hr = st(t, 'hr'); eq([hr.borderTopStyle, hr.borderTopWidth, hr.borderTopColor, hr.marginTop, hr.marginLeft], ['inset', 1, [128, 128, 128], 8, 'auto'], 'hr');
  eq([st(t, 'blockquote').marginLeft, st(t, 'address').fontStyle, st(t, 'dd').marginLeft], [40, 'italic', 40], 'blockquote/address/dd');
  eq([st(t, 'head').display, st(t, 'style').display], ['none', 'none'], 'unsichtbare Elemente');
});
check('font-weight: Zahlen, bold/normal, bolder/lighter relativ (CSS Fonts 4)', () => {
  const t = doc('.w1{font-weight:100}.w3{font-weight:300}.w5{font-weight:500}.w6{font-weight:600}.w9{font-weight:900}.b{font-weight:bolder}.l{font-weight:lighter}',
    '<p class="w1"><span class="b"></span><span class="l"></span></p><p class="w3"><span class="b"></span></p><p class="w5"><span class="b"></span><span class="l"></span></p><p class="w6"><span class="b"></span><span class="l"></span></p><p class="w9"><span class="b"></span><span class="l"></span></p>');
  const w = (s) => st(t, s).fontWeight;
  eq([w('.w1 .b'), w('.w1 .l'), w('.w3 .b'), w('.w5 .b'), w('.w5 .l'), w('.w6 .b'), w('.w6 .l'), w('.w9 .b'), w('.w9 .l')], [400, 100, 400, 700, 100, 900, 400, 900, 700], 'bolder/lighter');
});
check('Anzeigeart: Flex-Kinder werden blockartig, display:none, Flex-Eigenschaften', () => {
  const t = doc('.f{display:flex;flex-direction:column;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px}.ib{display:inline-block}.n{display:none}.x{align-self:center}',
    '<div class="f"><span>a</span><b class="ib">b</b><span class="n">c</span><span class="x">d</span></div><span class="ib">e</span>');
  eq([st(t, '.f > span').display, st(t, '.f .ib').display, st(t, '.f .n').display, st(t, 'body > .ib').display], ['block', 'block', 'none', 'inline-block'], 'blockartig');
  const f = st(t, '.f'); eq([f.flexDirection, f.justifyContent, f.alignItems, f.flexWrap, f.rowGap], ['column', 'space-between', 'flex-start', 'wrap', 6], 'Flex');
  eq(st(t, '.x').alignSelf, 'center', 'align-self');
});
check('Umbruch-Angaben: break-before/-after/-inside und page-break-*', () => {
  const t = doc('.a{break-before:page}.b{page-break-before:always}.c{break-after:avoid}.d{page-break-after:avoid}.e{break-inside:avoid}.f{page-break-inside:avoid}.g{break-after:page}.h{page-break-before:left}',
    '<p class="a"></p><p class="b"></p><p class="c"></p><p class="d"></p><p class="e"></p><p class="f"></p><p class="g"></p><p class="h"></p><table><thead><tr><th>k</th></tr></thead></table>');
  eq(['.a', '.b', '.h'].map((s) => st(t, s).breakBefore), ['page', 'page', 'page'], 'vorher Seite');
  eq(['.c', '.d', '.g'].map((s) => st(t, s).breakAfter), ['avoid', 'avoid', 'page'], 'nachher');
  eq(['.e', '.f', 'thead'].map((s) => st(t, s).breakInside), ['avoid', 'avoid', 'avoid'], 'innen (thead wie Chrome)');
});
check('Textlinien werden an Nachfahren weitergereicht (nicht in inline-block)', () => {
  const t = doc('a{color:#00f;text-decoration:underline} a b{color:red} .ib{display:inline-block} .ohne{text-decoration:none}', '<p><a href="#">x <b>y</b> <span class="ib">z</span> <span class="ohne">w</span></a></p>');
  eq(st(t, 'a b').textDecorations, [{ line: 'underline', style: 'solid', color: [0, 0, 255] }], 'b unter a: Linie in der Farbe von a');
  eq(st(t, 'a b').textDecorationLine, [], 'eigene Angabe bleibt leer (wie getComputedStyle)');
  eq(st(t, '.ib').textDecorations, [], 'nicht in inline-block');
  eq(st(t, '.ohne').textDecorations.length, 1, 'text-decoration:none am Kind hebt die Linie des Vorfahren nicht auf');
});

// ---------------------------------------------------------------------------
// 6. @media und @page
// ---------------------------------------------------------------------------
check('@media: print gilt, screen nicht; Breite = Seiteninhalt; Listen, not/only, Verschachtelung, Farbschema', () => {
  const css = `@page{size:A4;margin:14mm}
    .m1{padding-top:1px} @media print{.m1{padding-top:2px}} @media screen{.m1{padding-top:3px}}
    @media (max-width:640px){.m2{padding-top:4px}} @media (min-width:640px){.m3{padding-top:5px}} @media not screen{.m4{padding-top:7px}}
    @media screen, print{.m5{padding-top:8px}} @media only print{.m6{padding-top:13px}} @media print and (max-width:500px), (min-width:600px){.m7{padding-top:17px}}
    @media print{@media (min-width:600px){.m8{padding-top:21px}}} @media (prefers-color-scheme: dark){.m9{padding-top:9px}} @media (prefers-color-scheme: light){.m10{padding-top:10px}}
    @media (width >= 600px){.m11{padding-top:24px}} @media (400px <= width <= 700px){.m12{padding-top:25px}} @media (orientation: portrait){.m13{padding-top:12px}}
    @media (min-width: 30em){.m14{padding-top:15px}} @media PRINT{.m15{padding-top:26px}} @media (hover: hover){.m16{padding-top:30px}}`;
  const body = Array.from({ length: 16 }, (_, i) => `<p class="m${i + 1}"></p>`).join('');
  const t = doc(css, body);
  const pt = (k) => st(t, `.m${k}`).paddingTop;
  eq(Array.from({ length: 16 }, (_, i) => pt(i + 1)), [2, 0, 5, 7, 8, 13, 17, 21, 0, 10, 24, 25, 12, 15, 26, 0], 'print, Breite 687,87 px');
  ok(hasWarn(t, /hover/), 'Gerätemerkmal gewarnt');
  const s = doc(css, body, { media: 'screen', width: 500 });
  eq([1, 2, 3, 4, 5, 6].map((k) => st(s, `.m${k}`).paddingTop), [3, 4, 0, 0, 8, 0], 'screen, Breite 500');
  eq(mediaMatches([{ not: false, type: 'print', conds: [] }], { type: 'print', width: 1, height: 1 }), true, 'mediaMatches');
});
check('@page: size (A4/A5/Letter, landscape, Längen), margin 1–4 Werte, Standard ohne @page', () => {
  const pg = (css) => doc(css, '').page;
  const a4 = pg('@page{size:A4;margin:14mm}');
  eq([a4.width, a4.height, a4.margin[0], a4.contentWidth, a4.size, a4.landscape], [793.7, 1122.52, 52.91, 687.87, 'A4', false], 'A4 14 mm');
  const a5 = pg('@page{size:A5 landscape;margin:10mm 15mm 20mm 25mm}');
  eq([a5.width, a5.height, a5.margin, a5.contentWidth, a5.size, a5.landscape], [793.7, 559.37, [37.8, 56.69, 75.59, 94.49], 642.52, 'A5', true], 'A5 quer, 4 Ränder');
  eq([pg('@page{size:letter}').width, pg('@page{size:letter}').height], [816, 1056], 'Letter');
  eq([pg('@page{size:100mm 150mm;margin:1in 2cm}').width, pg('@page{size:100mm 150mm;margin:1in 2cm}').margin], [377.95, [96, 75.59, 96, 75.59]], 'Längen');
  eq([pg('@page{size:landscape}').width, pg('').margin], [1122.52, [38.4, 38.4, 38.4, 38.4]], 'nur Ausrichtung; Standardrand 0,4 Zoll');
  eq(pg('@page{margin:20mm 18mm 22mm}').margin, [75.59, 68.03, 83.15, 68.03], '3 Werte');
  eq(pg('@media print{@page{size:A5}}').size, 'A5', '@page in @media print');
  const w = doc('@page :first{margin:0} @page{margin:5%;marks:crop}', '');
  ok(hasWarn(w, /@page :first/) && hasWarn(w, /margin: 5%/) && hasWarn(w, /@page marks/), '@page-Warnungen');
});

// ---------------------------------------------------------------------------
// 7. Warnungen, bewusst ohne Wirkung
// ---------------------------------------------------------------------------
check('nicht unterstützt → Warnung, Deklaration/Regel übersprungen', () => {
  const t = doc(`@import url(x.css); @supports (display:flex){p{color:red}} @font-face{font-family:X;src:url(x.woff2)} @keyframes k{from{opacity:0}}
    p{position:absolute;float:left;width:calc(100% - 2px);color:var(--x);--x:red;display:grid;border-radius:10px / 20px;text-indent:2em;font:small-caps 12px serif;
      background:url(x.png) #fff;opacity:.5;overflow:hidden;quatsch:1;display:contents} .p{position:static;float:none;opacity:1;overflow:visible;text-indent:0}`,
  '<p class="p">x</p><img src="x.png"><link rel="stylesheet" href="y.css">');
  for (const re of [/@import/, /@supports/, /@keyframes/, /position: absolute/, /float: left/, /calc\(\)/, /var\(\)|CSS-Variablen/, /display: grid/, /elliptische/, /text-indent: 2em/,
    /small-caps/, /quatsch/, /opacity: \.5/, /overflow: hidden/, /display: contents/, /<img> ist sichtbar/, /externes Stylesheet/]) ok(hasWarn(t, re), `Warnung ${re}`);
  ok(!hasWarn(t, /font-face/), '@font-face still übersprungen');
  ok(!hasWarn(t, /position: static|float: none|opacity: 1|overflow: visible|text-indent: 0/), 'wirkungslose Werte ohne Warnung');
  eq([st(t, 'p').backgroundColor, st(t, 'p').fontSize, st(t, 'p').display], [[255, 255, 255], 12, 'block'], 'Rest der Deklarationen gilt');
});
check('bewusst ohne Wirkung: keine Warnung (box-shadow, cursor, transition …)', () => {
  const css = `p{${IGNORED_PROPS.map((p) => `${p}:none`).join(';')};-webkit-print-color-adjust:exact;print-color-adjust:exact} ::selection{color:red}`;
  const t = doc(css, '<p>x</p>');
  eq(t.warnings, [], 'keine Warnungen');
  eq(st(t, 'p').printColorAdjust, 'exact', 'print-color-adjust wird ausgewertet');
  ok(IGNORED_PROPS.includes('box-shadow') && IGNORED_PROPS.includes('cursor'), 'Liste enthält box-shadow und cursor');
});
check('parseCss: Kommentare, Zeichenketten mit Klammern, !important, Kurzformen zerlegt', () => {
  const w = [];
  const r = parseCss('/* a{color:red} */ p{font-family:"A;B}",x /* mitten */; margin:1px 2px!important} @media print{.x{color:red}}', w);
  eq(r.rules.length, 2, 'Regeln'); eq(r.rules[0].decls.map((d) => [d.prop, d.important]).slice(0, 3), [['font-family', false], ['margin-top', true], ['margin-right', true]], 'Deklarationen');
  eq(r.rules[0].decls[0].value, ['A;B}', 'x'], 'Schriftliste'); eq(r.rules[1].media.length, 1, '@media bleibt als Bedingung'); eq(w, [], 'keine Warnungen');
});

// ---------------------------------------------------------------------------
// 8. Sichtbarer Text
// ---------------------------------------------------------------------------
check('visibleText: ohne display:none/head/style/svg/visibility:hidden, br und Blöcke als Zeilen, Leerraum zusammengefasst', () => {
  const t = doc('.n{display:none}.h{visibility:hidden}.h .v{visibility:visible}.up{text-transform:uppercase}.pl{white-space:pre-line}',
    '<div class="n">weg</div><p>Ein   <b>fetter</b>\n Satz<br>Zeile&nbsp;2</p><svg><title>Logo</title></svg><span class="h">versteckt <i class="v">doch</i></span><p class="up">groß ß</p><p class="pl">a\n  b</p><script>x</script>');
  eq(visibleText(t.root), 'Ein fetter Satz\nZeile\u00a02\ndoch\ngroß ß\na\nb', 'Text');
  eq(visibleText(t.root, { transform: true }).split('\n')[3], 'GROSS SS', 'text-transform angewandt (ß → SS)');
  eq(applyTransform('über „alles“ (neu)', 'capitalize'), 'Über „Alles“ (Neu)', 'capitalize');
});

// ---------------------------------------------------------------------------
// 9. Testbelege aus dem Testshop (erfundene Daten) gegen Chrome-Sollwerte
// ---------------------------------------------------------------------------
// Chrome-Sollwerte für rechnung-ust.html (getComputedStyle, Druckansicht, Fenster 688 px); fontFamily = erster Eintrag (fehlt = Inter),
// textAlign fehlt = left, html: Chrome nennt „Times New Roman“, hier generisch serif
const GOLD = {html:{display:"block",fontFamily:"serif",fontSize:16,fontWeight:400,lineHeight:"normal",color:[0,0,0]},body:{display:"block",fontSize:12,fontWeight:400,lineHeight:17.4,color:[33,29,24]},"main.blatt":{display:"block",fontSize:12,fontWeight:400,lineHeight:17.4,color:[33,29,24],backgroundColor:[255,255,255],marginRight:"auto",marginLeft:"auto"},"header.kopf":{display:"flex",fontSize:12,fontWeight:400,lineHeight:17.4,color:[33,29,24],paddingBottom:12,borderBottomWidth:1,borderBottomColor:[230,221,208],justifyContent:"space-between",alignItems:"flex-start",columnGap:24},"svg.logo":{display:"block",fontSize:12,fontWeight:400,lineHeight:17.4,color:[33,29,24],marginTop:2,height:34},".absender":{display:"flex",fontSize:11,fontWeight:400,lineHeight:16.5,color:[74,67,59],columnGap:22},".absender b":{display:"inline",fontFamily:"Fraunces",fontSize:12.5,fontWeight:600,lineHeight:18.75,color:[33,29,24]},".absender .kontakt":{display:"block",fontSize:11,fontWeight:400,lineHeight:16.5,color:[74,67,59],paddingTop:1},"section.anschrift":{display:"flex",fontSize:12,fontWeight:400,lineHeight:17.4,color:[33,29,24],marginTop:18,marginBottom:14,justifyContent:"space-between",alignItems:"flex-start",columnGap:28},".empfaenger":{display:"block",fontSize:12.5,fontWeight:400,lineHeight:18.125,color:[33,29,24],minWidth:0},".ruecksende":{display:"block",fontSize:9,fontWeight:400,lineHeight:13.05,color:[107,98,87],marginBottom:7,paddingBottom:2,borderBottomWidth:1,borderBottomColor:[230,221,208],whiteSpace:"nowrap"},"table.meta":{display:"table",fontSize:12,fontWeight:400,lineHeight:17.4,color:[33,29,24]},".meta th":{display:"table-cell",fontSize:12,fontWeight:400,lineHeight:17.4,color:[107,98,87],paddingTop:1,paddingRight:16,paddingBottom:1,verticalAlign:"top",whiteSpace:"nowrap"},".meta td":{display:"table-cell",fontSize:12,fontWeight:600,lineHeight:17.4,color:[33,29,24],paddingTop:1,paddingBottom:1,textAlign:"right",verticalAlign:"middle",whiteSpace:"nowrap"},".meta td small":{display:"block",fontSize:10,fontWeight:400,lineHeight:14.5,color:[107,98,87],textAlign:"right",whiteSpace:"nowrap"},"h1":{display:"block",fontFamily:"Fraunces",fontSize:22,fontWeight:500,lineHeight:25.3,color:[33,29,24],letterSpacing:-0.22},"table.pos":{display:"table",fontSize:12,fontWeight:400,lineHeight:17.4,color:[33,29,24],marginTop:10,marginBottom:4,width:{pct:100}},".pos th":{display:"table-cell",fontSize:9.5,fontWeight:600,lineHeight:13.11,color:[107,98,87],paddingTop:4,paddingRight:7,paddingBottom:4,borderBottomWidth:1,borderBottomColor:[33,29,24],paddingLeft:7,verticalAlign:"top",textTransform:"uppercase",letterSpacing:0.57},".pos th.r":{display:"table-cell",fontSize:9.5,fontWeight:600,lineHeight:13.11,color:[107,98,87],paddingTop:4,paddingRight:7,paddingBottom:4,borderBottomWidth:1,borderBottomColor:[33,29,24],paddingLeft:7,verticalAlign:"top",whiteSpace:"nowrap",textTransform:"uppercase",letterSpacing:0.57},".pos td":{display:"table-cell",fontSize:11.5,fontWeight:400,lineHeight:15.87,color:[107,98,87],paddingTop:4,paddingRight:7,paddingBottom:4,borderBottomWidth:1,borderBottomColor:[230,221,208],paddingLeft:7,verticalAlign:"top"},".pos td.r":{display:"table-cell",fontSize:11.5,fontWeight:400,lineHeight:15.87,color:[33,29,24],paddingTop:4,paddingRight:7,paddingBottom:4,borderBottomWidth:1,borderBottomColor:[230,221,208],paddingLeft:7,verticalAlign:"top",whiteSpace:"nowrap"},".pos td small":{display:"inline",fontSize:10,fontWeight:400,lineHeight:13.8,color:[107,98,87]},"table.summen":{display:"table",fontSize:12,fontWeight:400,lineHeight:17.4,color:[33,29,24],marginLeft:"auto",width:{pct:100},maxWidth:470},".summen td":{display:"table-cell",fontSize:12,fontWeight:400,lineHeight:17.4,color:[33,29,24],paddingTop:2,paddingRight:7,paddingBottom:2,paddingLeft:7,verticalAlign:"middle"},".summen .grand td":{display:"table-cell",fontSize:14,fontWeight:700,lineHeight:20.3,color:[33,29,24],paddingTop:6,borderTopWidth:1,borderTopColor:[33,29,24],paddingRight:7,paddingBottom:2,paddingLeft:7,verticalAlign:"middle"},".summen .fein td":{display:"table-cell",fontSize:11,fontWeight:400,lineHeight:15.95,color:[107,98,87],paddingTop:1,paddingRight:7,paddingBottom:1,paddingLeft:7,verticalAlign:"middle"},".steuer":{display:"block",fontSize:11.5,fontWeight:400,lineHeight:16.675,color:[74,67,59],marginTop:10},".zahlung":{display:"block",fontSize:12,fontWeight:400,lineHeight:17.4,color:[33,29,24],backgroundColor:[244,239,231],marginTop:10,paddingTop:9,paddingRight:14,paddingBottom:9,paddingLeft:14,borderLeftWidth:3,borderLeftColor:[200,111,74],borderTopRightRadius:8},".zahlung th":{display:"table-cell",fontSize:12,fontWeight:400,lineHeight:17.4,color:[107,98,87],paddingRight:12,verticalAlign:"middle",whiteSpace:"nowrap"},".zahlung td":{display:"table-cell",fontSize:12,fontWeight:600,lineHeight:17.4,color:[33,29,24],paddingRight:28,verticalAlign:"middle"},".dank":{display:"block",fontSize:12,fontWeight:400,lineHeight:17.4,color:[33,29,24],marginTop:12},".akzent":{display:"inline",fontSize:12,fontWeight:400,lineHeight:17.4,color:[158,79,44]},".klein":{display:"block",fontSize:10,fontWeight:400,lineHeight:14,color:[107,98,87],marginTop:6},"footer.fuss":{display:"block",fontSize:9.5,fontWeight:400,lineHeight:13.775,color:[107,98,87],marginTop:14,paddingTop:6,borderTopWidth:1,borderTopColor:[230,221,208],textAlign:"center"}};
// Sollwerte gelten für alle Eigenschaften der Liste: was fehlt, hat den Anfangswert
const GOLD_DEFAULTS = { fontFamily: 'Inter', textAlign: 'left', backgroundColor: [0, 0, 0, 0], verticalAlign: 'baseline', whiteSpace: 'normal', textTransform: 'none', letterSpacing: 0,
  borderTopRightRadius: 0, width: 'auto', maxWidth: 'none', height: 'auto', justifyContent: 'normal', alignItems: 'normal', columnGap: 0,
  ...Object.fromEntries(['Top', 'Right', 'Bottom', 'Left'].flatMap((s) => [[`margin${s}`, 0], [`padding${s}`, 0], [`border${s}Width`, 0]])) };
const fixtures = fs.existsSync(FIX) ? fs.readdirSync(FIX).filter((f) => f.endsWith('.html')).sort() : [];
check('Testbelege vorhanden', () => { ok(fixtures.length >= 3, `nur ${fixtures.length} Belege in ${FIX}`); return fixtures.join(', '); });
for (const f of fixtures) {
  check(`Beleg ${f}: ohne Warnungen, A4 mit 14 mm Rand, Titel, Leiste unsichtbar`, () => {
    const t = styleTree(fs.readFileSync(path.join(FIX, f), 'utf8'));
    eq(t.warnings, [], 'Warnungen'); eq([t.page.size, t.page.margin[0], t.page.contentWidth], ['A4', 52.91, 687.87], 'Seite');
    ok(/^(Rechnung|Gutschrift|Stornorechnung) \S+ · formsam$/.test(t.title), `Titel „${t.title}“`);
    eq(st(t, '.leiste').display, 'none', '.leiste im Druck'); eq(st(t, 'body').paddingTop, 0, 'body im Druck ohne Innenabstand');
    const text = visibleText(t.root);
    ok(!/Drucken/.test(text) && /formsam · Max Mustermann/.test(text) && /Erika Mustermann/.test(text), 'Text');
    ok(!/<|&amp;|&lt;/.test(text.replace(/<3/, '')), 'keine rohen Verweise im Text');
  });
}
check('rechnung-ust.html: berechnete Stile = Chrome (getComputedStyle)', () => {
  const t = styleTree(fs.readFileSync(path.join(FIX, 'rechnung-ust.html'), 'utf8'));
  let n = 0;
  for (const [sel, want] of Object.entries(GOLD)) {
    const s = st(t, sel);
    for (const k of Object.keys(GOLD_DEFAULTS).concat(Object.keys(want))) {
      const w = k in want ? want[k] : GOLD_DEFAULTS[k];
      const got = k === 'fontFamily' ? s.fontFamily[0] : s[k];
      if (!same(got, w)) throw new Error(`${sel} ${k}: ${JSON.stringify(got)} statt ${JSON.stringify(w)} (Chrome)`);
      n++;
    }
  }
  return `${n} Werte`;
});
check('rechnung-ust.html: Logo-SVG, Text inhaltsgleich, gleiche Eingabe → gleiche Stile, Tempo', () => {
  const html = fs.readFileSync(path.join(FIX, 'rechnung-ust.html'), 'utf8');
  const a = styleTree(html), b = styleTree(html);
  const svg = $(a.root, 'svg.logo');
  eq([svg.attrs.viewBox, svg.style.width, svg.style.height, svg.children.filter((c) => c.tag === 'path').length], ['0 0 377.6 100', 'auto', 34, 2], 'Logo');
  const dump = (t) => JSON.stringify(elements(t.root).map((e) => e.style));
  ok(dump(a) === dump(b), 'Stile bytegleich');
  const text = visibleText(a.root);
  for (const s of ['Rechnung', 'RE-2026-', 'Gravur „Anna & Tom <3“', 'Zwischensumme', 'Gesamtbetrag', 'darin Umsatzsteuer 19 %', 'IBAN', 'Lieferzeit:\u00a05–8 Werktage', 'formsam.example']) ok(text.includes(s), `Text „${s}“`);
  const big = fs.readFileSync(path.join(FIX, 'rechnung-lang.html'), 'utf8');
  for (let i = 0; i < 5; i++) styleTree(big);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) styleTree(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  ok(ms < 50, `${ms.toFixed(1)} ms je Beleg`);
  return `lange Rechnung: ${ms.toFixed(1)} ms je Durchlauf`;
});
check('ältere Aufmachung (ohne @page, style-Attribute, @media print): Standardrand, Druckregeln', () => {
  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Rechnung RE-2026-0001</title><style>
    body{font-family:system-ui;color:#1d1a16;max-width:800px;margin:40px auto;padding:0 24px;font-size:14px;line-height:1.5}
    h1{font-size:1.5rem;margin:0 0 4px} .muted{color:#6b6257} th{font-size:11px;text-transform:uppercase;letter-spacing:.05em}
    .grand td{font-weight:700;font-size:1.05rem;border-top:2px solid #1d1a16} @media print{body{margin:10mm auto}.noprint{display:none}}
    .noprint button{border-radius:999px;cursor:pointer}</style></head><body><h1>Rechnung</h1><table style="max-width:340px;margin-left:auto"><tr class="grand"><td>Gesamt</td></tr></table>
    <p class="muted" style="margin-top:26px">Danke</p><div class="noprint"><button onclick="print()">Drucken</button></div></body></html>`;
  const t = styleTree(html);
  eq([t.page.size, t.page.margin, t.page.contentWidth, t.warnings], ['A4', [38.4, 38.4, 38.4, 38.4], 716.9, []], 'Seite');
  const b = st(t, 'body'); eq([b.marginTop, b.marginLeft, b.maxWidth, b.paddingLeft, b.fontFamily], [37.8, 'auto', 800, 24, ['system-ui']], 'body im Druck');
  eq([st(t, 'h1').fontSize, st(t, 'table').maxWidth, st(t, 'table').marginLeft, st(t, '.grand td').fontSize, st(t, '.grand td').borderTopWidth], [24, 340, 'auto', 16.8, 2], 'rem und style-Attribut');
  eq([st(t, 'p.muted').marginTop, st(t, '.noprint').display], [26, 'none'], 'style-Attribut, noprint');
  eq(visibleText(t.root), 'Rechnung\nGesamt\nDanke', 'Text ohne Knopf');
});

console.log(`\n${total - failed}/${total} Prüfungen bestanden`);
process.exit(failed ? 1 : 0);
