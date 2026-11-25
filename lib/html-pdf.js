// formsam — PDF-Satz für Belege und Rechtstexte: das fertige HTML+CSS (eingeschränkter Umfang) auswerten, umbrechen,
// auf A4-Seiten verteilen und mit lib/pdf.js zeichnen (nur Node-Built-ins).
//
//   import { htmlToPdf } from './lib/html-pdf.js';
//   const { buffer, pages, warnings } = htmlToPdf(html, { createdAt: order.completedAt, author: 'formsam' });   // wirft PdfError
//
//   import { styleTree, visibleText } from './lib/html-pdf.js';
//   const { root, body, page, title, warnings } = styleTree(html, { media: 'print' });
//   // jedes Element trägt .style mit aufgelösten Werten (Längen in CSS-px, Farben als [r, g, b(, a)] …)
//
// Teil 1: HTML einlesen (parseHtml), CSS einlesen (parseCss), Kaskade für den DRUCK wie Chrome (Browser-Grundstil,
//   Spezifität, !important, Vererbung, @media/@page) → computeStyles / styleTree, visibleText.
// Teil 2 (Abschnitt 7): Satz — Blöcke, Zeilen, Tabellen, Flex, SVG, Seitenumbruch, Zeichnen, Selbstprüfung → htmlToPdf,
//   layoutDocument (Satz ohne Zeichnen, für Tests).
// Grundsatz: nie raten — nicht verstandene Selektoren, Werte, Eigenschaften und @-Regeln werden übersprungen und in
// warnings festgehalten (htmlToPdf mit strict: true bricht dann ab); was der Satz nicht kann (Bilder, rowspan …), wirft
// PdfError. Was bewusst ohne Wirkung bleibt (Schatten, Cursor, Übergänge …), steht in IGNORED_PROPS und erzeugt keine Warnung.
//
// Aufbau: 1. Zeichenverweise · 2. HTML-Leser · 3. CSS-Leser (Regeln, @media, @page, Selektoren) · 4. Eigenschaften
//   (Werte prüfen, Kurzschreibweisen) · 5. Kaskade und berechnete Werte · 6. sichtbarer Text · 7. Satz (htmlToPdf)
import { PdfDocument, PdfError, measureText, missingChars, fontMetrics, findFont, composeText } from './pdf.js';

// ---------------------------------------------------------------------------
// 1. Zeichenverweise: alle benannten aus HTML 4 (Latin-1, Symbole, Sonderzeichen; &lang;/&rang; wie HTML5 als ⟨⟩) + &apos;,
//    numerische wie HTML5
// ---------------------------------------------------------------------------
const ENT = Object.create(null);
{
  const t = ('quot 22 amp 26 lt 3c gt 3e apos 27 nbsp a0 iexcl a1 cent a2 pound a3 curren a4 yen a5 brvbar a6 sect a7 uml a8 copy a9 ordf aa ' +
    'laquo ab not ac shy ad reg ae macr af deg b0 plusmn b1 sup2 b2 sup3 b3 acute b4 micro b5 para b6 middot b7 cedil b8 sup1 b9 ordm ba ' +
    'raquo bb frac14 bc frac12 bd frac34 be iquest bf Agrave c0 Aacute c1 Acirc c2 Atilde c3 Auml c4 Aring c5 AElig c6 Ccedil c7 Egrave c8 ' +
    'Eacute c9 Ecirc ca Euml cb Igrave cc Iacute cd Icirc ce Iuml cf ETH d0 Ntilde d1 Ograve d2 Oacute d3 Ocirc d4 Otilde d5 Ouml d6 ' +
    'times d7 Oslash d8 Ugrave d9 Uacute da Ucirc db Uuml dc Yacute dd THORN de szlig df agrave e0 aacute e1 acirc e2 atilde e3 auml e4 ' +
    'aring e5 aelig e6 ccedil e7 egrave e8 eacute e9 ecirc ea euml eb igrave ec iacute ed icirc ee iuml ef eth f0 ntilde f1 ograve f2 ' +
    'oacute f3 ocirc f4 otilde f5 ouml f6 divide f7 oslash f8 ugrave f9 uacute fa ucirc fb uuml fc yacute fd thorn fe yuml ff OElig 152 ' +
    'oelig 153 Scaron 160 scaron 161 Yuml 178 fnof 192 circ 2c6 tilde 2dc Alpha 391 Beta 392 Gamma 393 Delta 394 Epsilon 395 Zeta 396 ' +
    'Eta 397 Theta 398 Iota 399 Kappa 39a Lambda 39b Mu 39c Nu 39d Xi 39e Omicron 39f Pi 3a0 Rho 3a1 Sigma 3a3 Tau 3a4 Upsilon 3a5 Phi 3a6 ' +
    'Chi 3a7 Psi 3a8 Omega 3a9 alpha 3b1 beta 3b2 gamma 3b3 delta 3b4 epsilon 3b5 zeta 3b6 eta 3b7 theta 3b8 iota 3b9 kappa 3ba lambda 3bb ' +
    'mu 3bc nu 3bd xi 3be omicron 3bf pi 3c0 rho 3c1 sigmaf 3c2 sigma 3c3 tau 3c4 upsilon 3c5 phi 3c6 chi 3c7 psi 3c8 omega 3c9 ' +
    'thetasym 3d1 upsih 3d2 piv 3d6 ensp 2002 emsp 2003 thinsp 2009 zwnj 200c zwj 200d lrm 200e rlm 200f ndash 2013 mdash 2014 lsquo 2018 ' +
    'rsquo 2019 sbquo 201a ldquo 201c rdquo 201d bdquo 201e dagger 2020 Dagger 2021 bull 2022 hellip 2026 permil 2030 prime 2032 ' +
    'Prime 2033 lsaquo 2039 rsaquo 203a oline 203e frasl 2044 euro 20ac image 2111 weierp 2118 real 211c trade 2122 alefsym 2135 larr 2190 ' +
    'uarr 2191 rarr 2192 darr 2193 harr 2194 crarr 21b5 lArr 21d0 uArr 21d1 rArr 21d2 dArr 21d3 hArr 21d4 forall 2200 part 2202 ' +
    'exist 2203 empty 2205 nabla 2207 isin 2208 notin 2209 ni 220b prod 220f sum 2211 minus 2212 lowast 2217 radic 221a prop 221d ' +
    'infin 221e ang 2220 and 2227 or 2228 cap 2229 cup 222a int 222b there4 2234 sim 223c cong 2245 asymp 2248 ne 2260 equiv 2261 le 2264 ' +
    'ge 2265 sub 2282 sup 2283 nsub 2284 sube 2286 supe 2287 oplus 2295 otimes 2297 perp 22a5 sdot 22c5 lceil 2308 rceil 2309 lfloor 230a ' +
    'rfloor 230b lang 27e8 rang 27e9 loz 25ca spades 2660 clubs 2663 hearts 2665 diams 2666 AMP 26 LT 3c GT 3e QUOT 22 COPY a9 REG ae').split(' ');
  for (let i = 0; i < t.length; i += 2) ENT[t[i]] = String.fromCodePoint(parseInt(t[i + 1], 16));
}
// HTML5-Altlast: diese Namen wirken auch ohne Semikolon („&copy 2026“ → „© 2026“) — Latin-1 sowie amp/lt/gt/quot, COPY, REG
const LEGACY = new Set(Object.keys(ENT).filter((n) => n !== 'apos' && (/^(amp|lt|gt|quot)$/i.test(n) || ENT[n].codePointAt(0) >= 0xa0) && ENT[n].codePointAt(0) <= 0xff));
// &#128; … &#159; meinen wie im Browser Windows-1252
const CP1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

/** Zeichenverweise auflösen wie der HTML5-Leser; attr = Attributwert („&amp=x“ bleibt dort stehen). Unbekannte Namen
 *  mit Semikolon bleiben als Text stehen (Warnung) — so wie im Browser, solange der Name nicht aus HTML5 stammt. */
export function decodeEntities(s, attr = false, warn = () => {}) {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g, (m, hex, dec, name, semi, off, all) => {
    if (name === undefined) {
      let c = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      if (!(c > 0) || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) c = 0xfffd;
      else if (c >= 0x80 && c <= 0x9f) c = CP1252[c - 0x80];
      return String.fromCodePoint(c);
    }
    if (semi && name in ENT) return ENT[name];
    for (let k = Math.min(name.length, 6); k >= 2; k--) {
      const p = name.slice(0, k);
      if (!LEGACY.has(p)) continue;
      const next = k < name.length ? name[k] : (semi || all[off + m.length] || '');
      if (attr && /[=A-Za-z0-9]/.test(next)) break;
      if (semi) warn(`Zeichenverweis &${name}; unbekannt – wie im Browser als „&${p}“ + „${name.slice(k)};“ gelesen`);
      return ENT[p] + name.slice(k) + semi;
    }
    if (semi) warn(`unbekannter Zeichenverweis &${name}; – bleibt als Text stehen`);
    return m;
  });
}

// ---------------------------------------------------------------------------
// 2. HTML-Leser (vereinfachter HTML5-Baumbau: implizite html/head/body/tbody/tr, fehlende Schluss-Tags, Rohtext)
//    Knoten: { type: 'document', children, doctype, quirks }
//            { type: 'element', tag, ns: 'html'|'svg', attrs: { name: wert }, children, parent, style }
//            { type: 'text', text, parent }       — Kommentare entfallen, benachbarte Texte sind zusammengefasst
//    parent ist nicht aufzählbar (JSON.stringify des Baums geht also).
// ---------------------------------------------------------------------------
const set = (s) => new Set(s.split(' '));
const VOID = set('area base br col embed hr img input keygen link meta param source track wbr');
const RAWTEXT = set('style script xmp iframe noembed noframes noscript template textarea title');   // title/textarea mit Zeichenverweisen
const HEAD_TAGS = set('base link meta title style script noscript template');
const CLOSES_P = set('address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul li dd dt listing search summary');
const SCOPE = set('html table td th caption button template object marquee applet svg');
const SPECIAL = set('address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp');
const OPTIONAL_END = set('p li dt dd td th tr thead tbody tfoot option optgroup colgroup caption rb rt rp head body html');
const TABLE_CTX = set('table tbody thead tfoot tr');
const S = { p: set('p'), li: set('li'), dd: set('dd dt'), table: set('table'), html: set('html'), sect: set('tbody thead tfoot table'), row: set('tr tbody thead tfoot table'),
  liStop: set('ul ol menu html table td th caption button template object marquee applet svg'), ddStop: set('dl html table td th caption button template object marquee applet svg') };
const SVG_ATTR = { viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', gradienttransform: 'gradientTransform', gradientunits: 'gradientUnits',
  patterntransform: 'patternTransform', patternunits: 'patternUnits', clippathunits: 'clipPathUnits', maskunits: 'maskUnits' };
const SVG_TAG = { lineargradient: 'linearGradient', radialgradient: 'radialGradient', clippath: 'clipPath', foreignobject: 'foreignObject', textpath: 'textPath' };

function mkNode(o, parent) { Object.defineProperty(o, 'parent', { value: parent, writable: true, enumerable: false, configurable: true }); return o; }
const dedupe = (warnings) => (m) => { if (!warnings.includes(m)) warnings.push(m); };

/** HTML → Dokumentknoten (siehe oben). warnings: Array, in das Auffälligkeiten geschrieben werden. */
export function parseHtml(html, warnings = []) {
  const warn = dedupe(warnings);
  const src = String(html ?? '').replace(/\r\n?/g, '\n');
  const doc = mkNode({ type: 'document', children: [], doctype: null, quirks: true }, null);
  const stack = [doc];
  let htmlEl = null, head = null, body = null;
  const top = () => stack[stack.length - 1];
  const el = (tag, attrs, ns = 'html') => mkNode({ type: 'element', tag, ns, attrs, children: [] }, null);
  const append = (p, n, before) => {
    n.parent = p;
    if (n.type === 'text') {
      const i = before ? p.children.indexOf(before) : p.children.length;
      const prev = p.children[i - 1];
      if (prev && prev.type === 'text') { prev.text += n.text; return prev; }
    }
    if (before) p.children.splice(p.children.indexOf(before), 0, n); else p.children.push(n);
    return n;
  };
  const ensureHtml = () => { if (!htmlEl) { htmlEl = append(doc, el('html', {})); stack.push(htmlEl); } };
  const ensureHead = () => { ensureHtml(); if (!head) { head = append(htmlEl, el('head', {})); if (!body) stack.push(head); } };
  const ensureBody = () => {
    if (body) return;
    ensureHead();
    stack.length = stack.indexOf(htmlEl) + 1;
    body = append(htmlEl, el('body', {}));
    stack.push(body);
  };
  const find = (tags, stop) => {   // nächstes offenes Element aus tags, Suche endet an einem Element aus stop
    for (let i = stack.length - 1; i > 0; i--) { const t = stack[i].tag; if (tags.has(t)) return i; if (stop.has(t)) return -1; }
    return -1;
  };
  const closeP = () => { const i = find(S.p, SCOPE); if (i > 0) stack.length = i; };
  const fosterParent = (n) => {   // Inhalt direkt in einer Tabelle: der Browser setzt ihn vor die Tabelle
    const t = stack[find(S.table, S.html)];
    warn(`<${n.tag || 'Text'}> direkt in <table> (außerhalb einer Zelle) – wie im Browser vor die Tabelle gesetzt`);
    return append(t.parent, n, t);
  };
  const text = (raw) => {
    if (!raw) return;
    const t = decodeEntities(raw, false, warn);
    if (!body && !/[^ \t\n\f\r]/.test(t)) { if (head && top() === head) append(head, mkNode({ type: 'text', text: t }, null)); return; }
    if (!body) ensureBody();
    const cur = top();
    if (cur.ns === 'html' && TABLE_CTX.has(cur.tag) && /[^ \t\n\f\r]/.test(t)) fosterParent(mkNode({ type: 'text', text: t }, null));
    else append(cur, mkNode({ type: 'text', text: t }, null));
  };
  // Start-Tag; gibt das neue Element zurück, wenn danach Rohtext folgt
  const startTag = (tag, attrs, selfClose) => {
    const cur = top();
    if ((cur.ns === 'svg' && cur.tag !== 'foreignObject') || tag === 'svg') {
      if (!body) ensureBody();
      const a = {};
      for (const k in attrs) a[SVG_ATTR[k] || k] = attrs[k];
      const e = append(top(), el(SVG_TAG[tag] || tag, a, 'svg'));
      if (!selfClose) stack.push(e);
      return null;
    }
    if (tag === 'html') { if (!htmlEl) { ensureHtml(); htmlEl.attrs = attrs; } return null; }
    if (tag === 'head') { if (!head && !body) { ensureHead(); head.attrs = attrs; } return null; }
    if (tag === 'body') { if (!body) { ensureBody(); body.attrs = attrs; } return null; }
    if (tag === 'math') warn('<math> (MathML) wird nicht unterstützt');
    if (!body && HEAD_TAGS.has(tag)) {
      ensureHead();
      const e = append(head, el(tag, attrs));
      return RAWTEXT.has(tag) ? e : null;
    }
    ensureBody();
    if (CLOSES_P.has(tag)) closeP();
    if (tag === 'li') { const i = find(S.li, S.liStop); if (i > 0) stack.length = i; }
    if (tag === 'dd' || tag === 'dt') { const i = find(S.dd, S.ddStop); if (i > 0) stack.length = i; }
    if (/^h[1-6]$/.test(tag) && /^h[1-6]$/.test(top().tag)) stack.pop();
    if (/^(caption|colgroup|col|thead|tbody|tfoot|tr|td|th)$/.test(tag)) {
      const ti = find(S.table, S.html);
      if (ti < 0) { warn(`<${tag}> außerhalb einer Tabelle – Tag ignoriert (wie im Browser)`); return null; }
      const open = (t) => { const e = append(top(), el(t, t === tag ? attrs : {})); stack.push(e); return e; };
      if (tag === 'tr') {
        const i = find(S.sect, S.html);
        stack.length = i + 1;
        if (stack[i].tag === 'table') open('tbody');
        open('tr');
      } else if (tag === 'td' || tag === 'th') {
        const i = find(S.row, S.html);
        stack.length = i + 1;
        if (stack[i].tag === 'table') open('tbody');
        if (top().tag !== 'tr') open('tr');
        open(tag);
      } else {
        stack.length = ti + 1;
        if (tag === 'col') { append(top(), el('col', attrs)); return null; }
        open(tag);
      }
      return null;
    }
    const e = el(tag, attrs);
    if (TABLE_CTX.has(top().tag) && !/^(style|script|template|form)$/.test(tag)) fosterParent(e); else append(top(), e);
    if (VOID.has(tag)) return null;
    if (RAWTEXT.has(tag)) return e;
    stack.push(e);
    return null;
  };
  const endTag = (tag) => {
    const cur = top();
    if (cur.ns === 'svg') {
      for (let i = stack.length - 1; i > 0 && stack[i].ns === 'svg'; i--) if (stack[i].tag.toLowerCase() === tag) { stack.length = i; return; }
      warn(`überzähliges </${tag}> in <svg> ignoriert`);
      return;
    }
    if (tag === 'html' || tag === 'body') return;   // Inhalt danach landet wie im Browser im body
    if (tag === 'head') { if (head && stack.includes(head)) stack.length = stack.indexOf(head); return; }
    if (tag === 'br') { ensureBody(); append(top(), el('br', {})); return; }
    if (tag === 'p' && find(S.p, SCOPE) < 0) { ensureBody(); append(top(), el('p', {})); warn('</p> ohne <p> – leerer Absatz eingefügt (wie im Browser)'); return; }
    const table = /^(table|tbody|thead|tfoot|tr|td|th|caption|colgroup)$/.test(tag);
    for (let i = stack.length - 1; i > 0; i--) {
      const e = stack[i];
      if (e.tag === tag && e.ns === 'html') {
        for (let k = i + 1; k < stack.length; k++) if (!OPTIONAL_END.has(stack[k].tag)) warn(`<${stack[k].tag}> ohne Schluss-Tag – von </${tag}> mitgeschlossen`);
        stack.length = i;
        return;
      }
      if (table ? e.tag === 'table' : (SPECIAL.has(tag) ? SCOPE.has(e.tag) : SPECIAL.has(e.tag))) break;
    }
    warn(`</${tag}> passt zu keinem offenen Element – ignoriert`);
  };

  const n = src.length;
  const NAME = /[^\s/>]+/y, ATTR = /[^\s/>=][^\s/>=]*/y, UNQ = /[^\s>]+/y;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { text(src.slice(i)); break; }
    if (lt > i) text(src.slice(i, lt));
    i = lt;
    const c = src[i + 1] || '';
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); i = e < 0 ? n : e + 3; continue; }
    if (c === '!' || c === '?') {
      const e = src.indexOf('>', i);
      const inner = src.slice(i + 2, e < 0 ? n : e);
      if (c === '!' && /^doctype\b/i.test(inner)) {
        doc.doctype = inner.replace(/^doctype\s*/i, '').trim();
        doc.quirks = !/^html$/i.test(doc.doctype);
        if (doc.quirks) warn(`DOCTYPE „${doc.doctype}“ – erwartet wird <!DOCTYPE html> (sonst rechnet der Browser teils anders)`);
      }
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '/' && /[A-Za-z]/.test(src[i + 2] || '')) {
      NAME.lastIndex = i + 2;
      const name = NAME.exec(src)[0].toLowerCase();
      const e = src.indexOf('>', i);
      i = e < 0 ? n : e + 1;
      endTag(name);
      continue;
    }
    if (!/[A-Za-z]/.test(c)) { text('<'); i++; continue; }
    NAME.lastIndex = i + 1;
    const tag = NAME.exec(src)[0].toLowerCase();
    let j = NAME.lastIndex, selfClose = false;
    const attrs = {};
    while (j < n) {
      const ch = src[j];
      if (ch === '>') { j++; break; }
      if (ch === '/') { if (src[j + 1] === '>') { selfClose = true; j += 2; break; } j++; continue; }
      if (/\s/.test(ch)) { j++; continue; }
      ATTR.lastIndex = j;
      const m = ATTR.exec(src);
      if (!m) { j++; continue; }
      const name = m[0].toLowerCase();
      j = ATTR.lastIndex;
      while (/\s/.test(src[j] || '')) j++;
      let val = '';
      if (src[j] === '=') {
        j++;
        while (/\s/.test(src[j] || '')) j++;
        const q = src[j];
        if (q === '"' || q === "'") { const e = src.indexOf(q, j + 1); val = src.slice(j + 1, e < 0 ? n : e); j = e < 0 ? n : e + 1; }
        else { UNQ.lastIndex = j; const u = UNQ.exec(src); val = u ? u[0] : ''; j = u ? UNQ.lastIndex : j; }
        val = decodeEntities(val, true, warn);
      }
      if (!(name in attrs)) attrs[name] = val;
    }
    i = j;
    const raw = startTag(tag, attrs, selfClose);
    if (raw) {   // Rohtext bis zum passenden Schluss-Tag
      const re = new RegExp(`</${tag}(?=[\\s/>])`, 'ig');
      re.lastIndex = i;
      const m = re.exec(src);
      let t = src.slice(i, m ? m.index : n);
      if (tag === 'textarea' && t[0] === '\n') t = t.slice(1);
      if (t) append(raw, mkNode({ type: 'text', text: tag === 'title' || tag === 'textarea' ? decodeEntities(t, false, warn) : t }, null));
      if (m) { const e = src.indexOf('>', m.index); i = e < 0 ? n : e + 1; } else i = n;
    } else if ((tag === 'pre' || tag === 'listing') && src[i] === '\n') i++;
  }
  ensureBody();
  if (doc.doctype === null) warn('kein <!DOCTYPE html> – der Browser rechnet dann im Quirks-Modus (hier wird wie im Standardmodus gerechnet)');
  return doc;
}

// ---------------------------------------------------------------------------
// 3. CSS-Leser: Regeln, @media (Bedingung bleibt bis zur Auswertung stehen), @page; Selektoren
// ---------------------------------------------------------------------------
/** Kommentare entfernen (Zeichenketten bleiben unberührt) */
function stripComments(css) {
  let out = '', i = 0, from = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") i = endOfString(css, i);
    else if (c === '/' && css[i + 1] === '*') {
      out += css.slice(from, i) + ' ';
      const e = css.indexOf('*/', i + 2);
      i = from = e < 0 ? css.length : e + 2;
    } else i++;
  }
  return out + css.slice(from);
}
function endOfString(s, i) {
  const q = s[i];
  for (let k = i + 1; k < s.length; k++) { if (s[k] === '\\') k++; else if (s[k] === q || s[k] === '\n') return k + 1; }
  return s.length;
}
/** Nächstes Zeichen aus chars auf oberster Ebene (außerhalb von Zeichenketten, (), []); -1 wenn keins */
function findTop(s, i, chars) {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '"' || c === "'") { k = endOfString(s, k) - 1; continue; }
    if (c === '\\') { k++; continue; }
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (depth === 0 && chars.includes(c)) return k;
  }
  return -1;
}
/** Index der schließenden Klammer zu s[i] === '{' */
function matchBrace(s, i) {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '"' || c === "'") { k = endOfString(s, k) - 1; continue; }
    if (c === '\\') { k++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k;
  }
  return s.length;
}
/** Wert in Teile an Leerraum (oder sep) auf oberster Ebene zerlegen */
function split(v, sep = null) {
  const out = [];
  let depth = 0, cur = '';
  for (let k = 0; k < v.length; k++) {
    const c = v[k];
    if (c === '"' || c === "'") { const e = endOfString(v, k); cur += v.slice(k, e); k = e - 1; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    if (depth === 0 && (sep ? c === sep : /\s/.test(c))) { if (sep || cur) out.push(sep ? cur.trim() : cur); cur = ''; continue; }
    cur += c;
  }
  if (sep || cur) out.push(sep ? cur.trim() : cur);
  return out;
}

let ruleOrder = 0;
/**
 * CSS-Text → { rules: [{ selectors: [{ parts, spec }], decls: [{ prop, value, important }], media: [Abfrageliste …] }],
 *              pages: [{ decls: [{ prop, value }], media }] }
 * Kurzschreibweisen sind schon in Langformen zerlegt, ungültige Deklarationen/Regeln verworfen (→ warnings).
 * media: alle umgebenden @media-Bedingungen (müssen alle zutreffen, siehe mediaMatches).
 */
export function parseCss(css, warnings = [], { where = 'CSS', media = [] } = {}) {
  const warn = dedupe(warnings);
  const out = { rules: [], pages: [] };
  parseRuleList(stripComments(String(css ?? '')), media, out, warn, where);
  return out;
}
function parseRuleList(s, media, out, warn, where) {
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s;}]/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '@') {
      const name = /^@([-\w]+)/.exec(s.slice(i, i + 64))?.[1]?.toLowerCase() || '';
      const k = findTop(s, i, '{;');
      const prelude = s.slice(i + 1 + name.length, k < 0 ? s.length : k).trim();
      if (k < 0 || s[k] === ';') {
        if (name !== 'charset') warn(`${where}: @${name} wird nicht unterstützt – übersprungen`);
        i = k < 0 ? s.length : k + 1;
        continue;
      }
      const e = matchBrace(s, k);
      const inner = s.slice(k + 1, e);
      i = e + 1;
      if (name === 'media') parseRuleList(inner, [...media, parseMediaList(prelude)], out, warn, where);
      else if (name === 'page') {
        if (prelude) { warn(`${where}: @page ${prelude} (Seitenauswahl) wird nicht unterstützt – übersprungen`); continue; }
        if (inner.includes('{')) warn(`${where}: Randfelder in @page (@top-center …) werden nicht unterstützt – übersprungen`);
        const decls = [];
        for (const d of split(inner.replace(/@[-\w]+[^{]*\{[^}]*\}/g, ''), ';')) {
          const c = d.indexOf(':');
          if (c > 0) decls.push({ prop: d.slice(0, c).trim().toLowerCase(), value: d.slice(c + 1).replace(/!\s*important\s*$/i, '').trim() });
          else if (d) warn(`${where}: @page-Angabe „${d}“ nicht verstanden – übersprungen`);
        }
        out.pages.push({ decls, media });
      } else if (name !== 'font-face') warn(`${where}: @${name} wird nicht unterstützt – übersprungen`);
      continue;
    }
    const k = findTop(s, i, '{');
    if (k < 0) { warn(`${where}: Rest ohne Regelblock „${s.slice(i, i + 40).trim()}“ – übersprungen`); break; }
    const prelude = s.slice(i, k).trim();
    const e = matchBrace(s, k);
    const block = s.slice(k + 1, e);
    i = e + 1;
    if (block.includes('{')) { warn(`${where}: verschachtelte Regeln in „${prelude}“ werden nicht unterstützt – Regel übersprungen`); continue; }
    const selectors = [];
    try {   // reine Bildschirm-Selektoren (::selection …) fallen still aus der Gruppe, der Rest der Gruppe gilt weiter
      for (const x of split(prelude, ',')) { try { selectors.push(parseSelector(x)); } catch (err) { if (!err.still) throw err; } }
    } catch (err) {
      warn(`${where}: Selektor „${prelude}“: ${err.message} – Regel übersprungen`);
      continue;
    }
    if (!selectors.length) continue;
    const decls = parseDecls(block, warn, `${where} „${prelude}“`);
    if (decls.length) out.rules.push({ selectors, decls, media });
  }
}

// ---- @media ----
// Abfrageliste → [{ not, type, conds: [{ name, op, value } | { unknown }] }]; ausgewertet erst in mediaMatches (Breite steht dann fest)
function parseMediaList(text) {
  return split(text, ',').map((q) => {
    const m = /^(?:(not|only)\s+)?([a-z-]+)?\s*(?:and\s+)?(.*)$/i.exec(q.trim());
    let [, mod, type, rest] = m;
    if (type && /^(and|or|not)$/i.test(type)) return { unknown: q };
    const conds = [];
    rest = (rest || '').trim();
    while (rest) {
      const f = /^\(([^()]*)\)\s*(?:and\s+|$)/i.exec(rest);
      if (!f) { conds.push({ unknown: rest }); break; }
      conds.push(parseMediaFeature(f[1].trim()));
      rest = rest.slice(f[0].length).trim();
    }
    return { not: (mod || '').toLowerCase() === 'not', type: (type || 'all').toLowerCase(), conds };
  });
}
function parseMediaFeature(f) {
  let m = /^([a-z-]+)\s*(?::\s*(.+))?$/i.exec(f);
  if (m) {
    const name = m[1].toLowerCase(), v = (m[2] || '').trim().toLowerCase();
    const mm = /^(min|max)-(width|height)$/.exec(name);
    if (mm) return { name: mm[2], op: mm[1] === 'min' ? '>=' : '<=', value: v };
    return { name, op: m[2] === undefined ? 'bool' : '=', value: v };
  }
  m = /^([^<>=]+?)\s*(<=|>=|<|>|=)\s*([a-z-]+)(?:\s*(<=|>=|<|>|=)\s*(.+))?$/i.exec(f);   // 600px <= width (<= 900px)
  if (m) {
    const flip = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=' };
    const r = [{ name: m[3].toLowerCase(), op: flip[m[2]], value: m[1].trim().toLowerCase() }];
    if (m[4]) r.push({ name: m[3].toLowerCase(), op: m[4], value: m[5].trim().toLowerCase() });
    return r.length === 1 ? r[0] : { all: r };
  }
  m = /^([a-z-]+)\s*(<=|>=|<|>|=)\s*(.+)$/i.exec(f);   // width >= 600px
  if (m) return { name: m[1].toLowerCase(), op: m[2], value: m[3].trim().toLowerCase() };
  return { unknown: f };
}
/** Trifft eine @media-Abfrageliste zu? env = { type: 'print'|'screen', width, height } (CSS-px des Seiteninhalts) */
export function mediaMatches(list, env, warn = () => {}) {
  return list.some((q) => {
    if (q.unknown) { warn(`@media „${q.unknown}“ nicht verstanden – gilt als nicht zutreffend`); return false; }
    const typeOk = q.type === 'all' || q.type === env.type;
    const ok = typeOk && q.conds.every((c) => featureMatches(c, env, warn));
    return q.not ? !ok : ok;
  });
}
function featureMatches(c, env, warn) {
  if (c.all) return c.all.every((x) => featureMatches(x, env, warn));
  if (c.unknown) { warn(`@media-Bedingung „(${c.unknown})“ nicht verstanden – gilt als nicht zutreffend`); return false; }
  if (c.name === 'width' || c.name === 'height') {
    const l = len(c.value, { pct: false });
    if (!l) { warn(`@media-Wert „${c.value}“ nicht verstanden – gilt als nicht zutreffend`); return false; }
    const v = l.u === 'em' || l.u === 'rem' ? l.n * 16 : l.n * UNIT[l.u];   // em in @media: Ausgangsgröße 16px
    const have = env[c.name];
    return { '<=': have <= v + 1e-9, '>=': have >= v - 1e-9, '<': have < v, '>': have > v, '=': Math.abs(have - v) < 1e-9 }[c.op] ?? false;
  }
  if (c.name === 'orientation' && c.op === '=') return c.value === (env.height >= env.width ? 'portrait' : 'landscape');
  if (c.name === 'prefers-color-scheme' && c.op === '=') return c.value === 'light';   // Papier ist hell
  warn(`@media (${c.name}${c.op === 'bool' ? '' : ': ' + c.value}) hängt vom Gerät ab bzw. wird nicht unterstützt – gilt als nicht zutreffend`);
  return false;
}

// ---- Selektoren ----
// Komplexer Selektor → { parts: [{ comb: null|' '|'>'|'+'|'~', tag, ids, classes, attrs, pseudos }], spec }
// spec = ids·1e6 + Klassen/Attribute/Pseudoklassen·1e3 + Typen
class SelError extends Error {}
const NEVER = set('hover active focus focus-visible focus-within visited target target-within');   // Zustände, die es im Druck nicht gibt
const SCREEN_ONLY = /::(selection|placeholder|-webkit-|-moz-|backdrop|file-selector-button)|:-moz-|:-webkit-(?!any-link)/i;   // nur Bildschirm → still übergehen
const STRUCT = set('first-child last-child only-child first-of-type last-of-type only-of-type root empty link any-link -webkit-any-link');
function parseSelector(text) {
  const s = text.trim();
  if (!s) throw new SelError('leer');
  if (SCREEN_ONLY.test(s)) { const e = new SelError('nur Bildschirm'); e.still = true; throw e; }
  const parts = [];
  let i = 0, comb = null, spec = 0;
  for (;;) {
    const r = parseCompound(s, i);
    parts.push({ comb, ...r.c });
    spec += r.spec;
    i = r.i;
    const ws = /^\s*/.exec(s.slice(i))[0].length;
    i += ws;
    if (i >= s.length) break;
    if ('>+~'.includes(s[i])) {
      comb = s[i];
      i += 1 + /^\s*/.exec(s.slice(i + 1))[0].length;
      if (i >= s.length) throw new SelError('endet mit einer Verknüpfung');
    } else if (ws) comb = ' ';
    else throw new SelError(`„${s[i]}“ nicht verstanden`);
  }
  return { parts, spec };
}
const IDENT = /-?(?:[_a-zA-Z\u00a0-\uffff]|-)[-\w\u00a0-\uffff]*/y;
function ident(s, i) {
  if (s[i] === '\\') throw new SelError('Escape-Folgen in Selektoren werden nicht unterstützt');
  IDENT.lastIndex = i;
  const m = IDENT.exec(s);
  if (!m) throw new SelError(`Name erwartet bei „${s.slice(i, i + 10)}“`);
  if (s[IDENT.lastIndex] === '\\') throw new SelError('Escape-Folgen in Selektoren werden nicht unterstützt');
  return [m[0], IDENT.lastIndex];
}
function parseCompound(s, i, inNot = false) {
  const c = { tag: null, ids: [], classes: [], attrs: [], pseudos: [] };
  let spec = 0, any = false;
  if (s[i] === '*') { i++; any = true; }
  else if (/^-?[A-Za-z_\u00a0-\uffff]/.test(s.slice(i, i + 2))) { [c.tag, i] = ident(s, i); c.tag = c.tag.toLowerCase(); spec += 1; any = true; }
  if (s[i] === '|') throw new SelError('Namensräume werden nicht unterstützt');
  for (;;) {
    const ch = s[i];
    if (ch === '#') { let id; [id, i] = ident(s, i + 1); c.ids.push(id); spec += 1e6; }
    else if (ch === '.') { let cl; [cl, i] = ident(s, i + 1); c.classes.push(cl); spec += 1e3; }
    else if (ch === '[') {
      const e = findTop(s, i + 1, ']');
      if (e < 0) throw new SelError('] fehlt');
      const m = /^\s*([-\w]+)\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[-\w\u00a0-\uffff]+)\s*([is])?)?\s*$/i.exec(s.slice(i + 1, e));
      if (!m) throw new SelError(`Attributselektor „${s.slice(i, e + 1)}“ nicht verstanden`);
      let v = m[3];
      if (v && /^["']/.test(v)) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
      c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value: v ?? null, i: (m[4] || '').toLowerCase() === 'i' });
      spec += 1e3;
      i = e + 1;
    } else if (ch === ':') {
      if (s[i + 1] === ':') throw new SelError('Pseudo-Elemente (::before …) werden nicht unterstützt');
      let name;
      [name, i] = ident(s, i + 1);
      name = name.toLowerCase();
      let arg = null;
      if (s[i] === '(') { const e = findTop(s, i + 1, ')'); if (e < 0) throw new SelError(') fehlt'); arg = s.slice(i + 1, e).trim(); i = e + 1; }
      if (/^(before|after|first-line|first-letter|marker)$/.test(name)) throw new SelError(`Pseudo-Element :${name} wird nicht unterstützt`);
      if (arg === null && (STRUCT.has(name) || NEVER.has(name))) { c.pseudos.push({ name }); spec += 1e3; }
      else if (arg !== null && /^nth-(last-)?(child|of-type)$/.test(name)) { c.pseudos.push({ name, nth: parseNth(arg) }); spec += 1e3; }
      else if (arg !== null && name === 'not' && !inNot) {
        const list = split(arg, ',').map((a) => {
          const r = parseCompound(a.trim(), 0, true);
          if (r.i !== a.trim().length) throw new SelError(':not() nur mit einfachen Selektoren');
          return r;
        });
        c.pseudos.push({ name: 'not', list: list.map((r) => r.c) });
        spec += Math.max(...list.map((r) => r.spec));
      } else throw new SelError(`:${name}${arg !== null ? '(…)' : ''} wird nicht unterstützt`);
    } else break;
    any = true;
  }
  if (!any) throw new SelError(`„${s.slice(i, i + 10) || 'Ende'}“ nicht verstanden`);
  return { c, spec, i };
}
function parseNth(arg) {
  const a = arg.replace(/\s+/g, '').toLowerCase();
  if (a === 'odd') return [2, 1];
  if (a === 'even') return [2, 0];
  if (/^[+-]?\d+$/.test(a)) return [0, +a];
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(a);
  if (!m) throw new SelError(`:nth-…(${arg}) nicht verstanden`);
  return [m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : +m[1], m[2] ? +m[2] : 0];
}
const nthOk = ([a, b], i) => (a === 0 ? i === b : (i - b) / a >= 0 && Number.isInteger((i - b) / a));

const KIDS = new WeakMap(), CLASSES = new WeakMap();
const kids = (p) => { let k = KIDS.get(p); if (!k) KIDS.set(p, k = p.children.filter((c) => c.type === 'element')); return k; };
const classes = (el) => { let c = CLASSES.get(el); if (!c) CLASSES.set(el, c = new Set((el.attrs.class || '').split(/[ \t\n\f\r]+/).filter(Boolean))); return c; };
const parentEl = (el) => (el.parent && el.parent.type === 'element' ? el.parent : null);
const prevEl = (el) => { const k = kids(el.parent); const i = k.indexOf(el); return i > 0 ? k[i - 1] : null; };

function matchCompound(c, el) {
  if (c.tag && c.tag !== el.tag.toLowerCase()) return false;
  for (const id of c.ids) if (el.attrs.id !== id) return false;
  if (c.classes.length) { const cl = classes(el); for (const x of c.classes) if (!cl.has(x)) return false; }
  for (const a of c.attrs) {
    let v = el.ns === 'html' ? el.attrs[a.name] : el.attrs[Object.keys(el.attrs).find((k) => k.toLowerCase() === a.name)];
    if (v === undefined) return false;
    if (!a.op) continue;
    let w = a.value;
    if (a.i) { v = v.toLowerCase(); w = w.toLowerCase(); }
    const ok = a.op === '=' ? v === w : a.op === '~=' ? v.split(/[ \t\n\f\r]+/).includes(w) : a.op === '|=' ? v === w || v.startsWith(w + '-')
      : !w ? false : a.op === '^=' ? v.startsWith(w) : a.op === '$=' ? v.endsWith(w) : v.includes(w);
    if (!ok) return false;
  }
  for (const p of c.pseudos) if (!matchPseudo(p, el)) return false;
  return true;
}
function matchPseudo(p, el) {
  const n = p.name;
  if (NEVER.has(n)) return false;
  if (n === 'not') return !p.list.some((c) => matchCompound(c, el));
  if (n === 'root') return el.parent?.type === 'document';
  if (n === 'empty') return !el.children.length;
  if (n === 'link' || n === 'any-link' || n === '-webkit-any-link') return /^(a|area)$/.test(el.tag) && 'href' in el.attrs;
  if (!el.parent || el.parent.type !== 'element') return false;   // Struktur-Pseudoklassen am Wurzelelement: Chrome zählt sie dort, hier nicht nötig
  const sib = kids(el.parent);
  const ofType = /of-type/.test(n) ? sib.filter((s) => s.tag === el.tag) : sib;
  const i = ofType.indexOf(el) + 1, cnt = ofType.length;
  if (p.nth) return nthOk(p.nth, /-last-/.test(n) ? cnt - i + 1 : i);
  if (n.startsWith('first')) return i === 1;
  if (n.startsWith('last')) return i === cnt;
  if (n.startsWith('only')) return cnt === 1;
  return false;
}
function matchParts(parts, k, el) {
  if (!matchCompound(parts[k], el)) return false;
  if (k === 0) return true;
  const comb = parts[k].comb;
  if (comb === '>') { const p = parentEl(el); return !!p && matchParts(parts, k - 1, p); }
  if (comb === ' ') { for (let p = parentEl(el); p; p = parentEl(p)) if (matchParts(parts, k - 1, p)) return true; return false; }
  if (comb === '+') { const s = prevEl(el); return !!s && matchParts(parts, k - 1, s); }
  for (let s = prevEl(el); s; s = prevEl(s)) if (matchParts(parts, k - 1, s)) return true;   // ~
  return false;
}
/** Passt der Selektor (Text) auf das Element? (für Tests und den Satz) */
export function matches(el, selector) {
  return split(selector, ',').some((s) => { const x = parseSelector(s); return matchParts(x.parts, x.parts.length - 1, el); });
}

// ---------------------------------------------------------------------------
// 4. Eigenschaften: Werte prüfen (→ „angegebener Wert“), Kurzschreibweisen in Langformen zerlegen
//    Länge = { n, u } (u: px pt pc mm cm in q em rem %), Farbe = [r, g, b, a] | 'currentcolor', sonst Schlüsselwörter/Zahlen
// ---------------------------------------------------------------------------
const UNIT = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
const LEN = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|pt|pc|mm|cm|in|q|em|rem|%)?$/i;
const ZERO = Object.freeze({ n: 0, u: 'px' });
/** Länge lesen; neg: negative erlaubt, pct: Prozent erlaubt. Einheitenlos nur 0. */
function len(v, { neg = false, pct = true } = {}) {
  const m = LEN.exec(v);
  if (!m) return undefined;
  const n = +m[1], u = (m[2] || '').toLowerCase();
  if (!Number.isFinite(n) || (!neg && n < 0)) return undefined;
  if (!u) return n === 0 ? ZERO : undefined;
  if (u === '%' && !pct) return undefined;
  return { n, u };
}
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const num = (v, min = 0) => (NUMBER.test(v) && +v >= min ? +v : undefined);

// Farben: Hex 3/4/6/8, rgb()/rgba() (Komma- und Leerzeichenform), hsl()/hsla(), alle CSS-Farbnamen, transparent, currentColor
const NAMED = Object.create(null);
('aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd ' +
  'blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 ' +
  'cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 ' +
  'darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc ' +
  'darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 ' +
  'darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 ' +
  'forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 ' +
  'greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa ' +
  'lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 ' +
  'lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa ' +
  'lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 ' +
  'magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 ' +
  'mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa ' +
  'mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 ' +
  'orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 ' +
  'peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f ' +
  'royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 ' +
  'skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c ' +
  'teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32')
  .split(' ').forEach((x, k, a) => { if (k % 2 === 0) NAMED[x] = a[k + 1]; });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Farbe lesen → [r, g, b, a] (r/g/b ganzzahlig 0–255, a 0–1) | 'currentcolor' | undefined */
export function parseColor(v) {
  const s = String(v).trim().toLowerCase();
  if (s === 'currentcolor') return 'currentcolor';
  if (s === 'transparent') return [0, 0, 0, 0];
  let h = s[0] === '#' ? s.slice(1) : NAMED[s];
  if (h !== undefined) {
    if (!/^[0-9a-f]+$/.test(h) || ![3, 4, 6, 8].includes(h.length)) return undefined;
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  const m = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
  if (!m) return undefined;
  let args = m[2].trim(), alpha = '1';
  if (args.includes(',')) { args = split(args, ','); if (args.length === 4) alpha = args.pop(); }
  else { const sl = args.split('/'); if (sl.length > 2) return undefined; if (sl.length === 2) alpha = sl[1].trim(); args = split(sl[0].trim()); }
  if (args.length !== 3) return undefined;
  const a = /%$/.test(alpha) ? num(alpha.slice(0, -1), -Infinity) / 100 : num(alpha, -Infinity);
  if (a === undefined || Number.isNaN(a)) return undefined;
  if (m[1].startsWith('rgb')) {
    const c = args.map((x) => (/%$/.test(x) ? num(x.slice(0, -1), -Infinity) * 2.55 : num(x, -Infinity)));
    if (c.some((x) => x === undefined || Number.isNaN(x))) return undefined;
    return [...c.map((x) => Math.round(clamp(x, 0, 255))), clamp(a, 0, 1)];
  }
  const hm = /^([+-]?[\d.]+(?:e[+-]?\d+)?)(deg|turn|rad|grad)?$/.exec(args[0]);
  const sat = /%$/.test(args[1]) ? num(args[1].slice(0, -1), -Infinity) : undefined, lig = /%$/.test(args[2]) ? num(args[2].slice(0, -1), -Infinity) : undefined;
  if (!hm || sat === undefined || lig === undefined) return undefined;
  const hue = ((+hm[1] * ({ turn: 360, rad: 180 / Math.PI, grad: 0.9 }[hm[2]] || 1)) % 360 + 360) % 360;
  const S = clamp(sat, 0, 100) / 100, L = clamp(lig, 0, 100) / 100;
  const f = (k) => { const kk = (k + hue / 30) % 12; return L - S * Math.min(L, 1 - L) * Math.max(-1, Math.min(kk - 3, 9 - kk, 1)); };
  const ch = (x) => Math.round(Math.round(x * 255e6) / 1e6);   // 25.4999999 → 25.5 → 26 wie Chrome
  return [ch(f(0)), ch(f(8)), ch(f(4)), clamp(a, 0, 1)];
}

/** Schriftliste lesen → ['Inter', 'Segoe UI', 'sans-serif'] | undefined */
const GENERIC = set('serif sans-serif monospace cursive fantasy system-ui ui-serif ui-sans-serif ui-monospace ui-rounded math emoji fangsong -apple-system blinkmacsystemfont');
function parseFamily(v) {
  const out = [];
  for (const p of split(v, ',')) {
    if (/^(["']).*\1$/.test(p)) { out.push(p.slice(1, -1).replace(/\\(.)/g, '$1')); continue; }
    const words = p.split(/\s+/);
    if (!p || words.some((w) => !/^-?[_a-zA-Z\u00a0-\uffff][-\w\u00a0-\uffff]*$/.test(w))) return undefined;
    if (words.length === 1 && /^(inherit|initial|unset|default|revert)$/i.test(p)) return undefined;
    out.push(words.length === 1 && GENERIC.has(p.toLowerCase()) ? p.toLowerCase() : words.join(' '));
  }
  return out.length ? out : undefined;
}

const lc = (v) => v.toLowerCase();
const kw = (words) => { const s = set(words); return (v) => (s.has(lc(v)) ? lc(v) : undefined); };
const lenP = (o) => (v) => len(lc(v), o);
const autoOr = (p, word = 'auto') => (v) => (lc(v) === word ? word : p(v));
const BW = set('thin medium thick');
const DISPLAYS = 'block inline inline-block none flex inline-flex list-item table inline-table table-row-group table-header-group table-footer-group table-row table-cell table-caption table-column table-column-group flow-root';
const LIST_TYPES = 'disc circle square decimal decimal-leading-zero lower-alpha lower-latin upper-alpha upper-latin lower-roman upper-roman lower-greek none';
const VALIGN = set('baseline sub super text-top text-bottom middle top bottom');
const FONT_SIZE_KW = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };

// Langformen: name → { inh: vererbt?, init: Anfangswert (angegeben), parse }
const LH = Object.create(null);
const def = (names, inh, init, parse) => { for (const n of names.split(' ')) LH[n] = { inh, init, parse }; };
const SIDES = ['top', 'right', 'bottom', 'left'];
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const each = (pat, list = SIDES) => list.map((s) => pat.replace('*', s)).join(' ');
def('display', false, 'inline', kw(DISPLAYS));
def('visibility', true, 'visible', kw('visible hidden collapse'));
def('box-sizing', false, 'content-box', kw('content-box border-box'));
def(each('margin-*'), false, ZERO, autoOr(lenP({ neg: true })));
def(each('padding-*'), false, ZERO, lenP({}));
def(each('border-*-width'), false, 'medium', (v) => (BW.has(lc(v)) ? lc(v) : len(lc(v), { pct: false })));
def(each('border-*-style'), false, 'none', kw('none hidden solid dashed dotted double groove ridge inset outset'));
def(each('border-*-color'), false, 'currentcolor', parseColor);
def(each('border-*-radius', CORNERS), false, ZERO, (v) => { const p = split(v).map(lenP({})); return p.length === 1 || (p.length === 2 && same(p[0], p[1])) ? p[0] : p.length === 2 && p[0] && p[1] ? 'elliptic' : undefined; });
def('width height', false, 'auto', autoOr(lenP({})));
def('min-width min-height', false, 'auto', autoOr(lenP({})));
def('max-width max-height', false, 'none', autoOr(lenP({}), 'none'));
def('color', true, [0, 0, 0, 1], (v) => parseColor(v));
def('background-color', false, [0, 0, 0, 0], parseColor);
def('font-family', true, ['serif'], parseFamily);
def('font-size', true, 'medium', (v) => (lc(v) in FONT_SIZE_KW || /^(smaller|larger)$/.test(lc(v)) ? lc(v) : len(lc(v))));
def('font-weight', true, 400, (v) => { const w = lc(v); return /^(normal|bold|bolder|lighter)$/.test(w) ? w : (num(w, 1) <= 1000 ? +w : undefined); });
def('font-style', true, 'normal', (v) => { const s = lc(v); return /^(normal|italic)$/.test(s) ? s : /^oblique(\s+[+-]?[\d.]+deg)?$/.test(s) ? 'italic' : undefined; });   // oblique rechnet Chrome als italic
def('line-height', true, 'normal', (v) => (lc(v) === 'normal' ? 'normal' : num(v) !== undefined ? { f: +v } : len(lc(v))));
def('text-align', true, 'start', kw('left right center justify start end match-parent -webkit-center -webkit-left -webkit-right -internal-center'));
def('vertical-align', false, 'baseline', (v) => (VALIGN.has(lc(v)) ? lc(v) : len(lc(v), { neg: true })));
def('white-space', true, 'normal', kw('normal nowrap pre pre-wrap pre-line'));
def('text-transform', true, 'none', kw('none uppercase lowercase capitalize'));
def('letter-spacing', true, 'normal', autoOr(lenP({ neg: true, pct: false }), 'normal'));
def('text-decoration-line', false, 'none', (v) => { const p = split(lc(v)); return p.length === 1 && p[0] === 'none' ? 'none' : p.every((x) => /^(underline|overline|line-through)$/.test(x)) && new Set(p).size === p.length ? p.join(' ') : undefined; });
def('text-decoration-style', false, 'solid', kw('solid double dotted dashed wavy'));
def('text-decoration-color', false, 'currentcolor', parseColor);
def('list-style-type', true, 'disc', kw(LIST_TYPES));
def('list-style-position', true, 'outside', kw('outside inside'));
def('border-collapse', true, 'separate', kw('separate collapse'));
def('border-spacing', true, [ZERO, ZERO], (v) => { const p = split(v).map(lenP({ pct: false })); return p.length && p.length <= 2 && p.every(Boolean) ? [p[0], p[1] || p[0]] : undefined; });
def('flex-direction', false, 'row', kw('row row-reverse column column-reverse'));
def('flex-wrap', false, 'nowrap', kw('nowrap wrap wrap-reverse'));
def('justify-content', false, 'normal', kw('normal flex-start flex-end center space-between space-around space-evenly start end left right stretch'));
def('align-items', false, 'normal', kw('normal stretch flex-start flex-end center baseline start end self-start self-end'));
def('align-self', false, 'auto', kw('auto normal stretch flex-start flex-end center baseline start end self-start self-end'));
def('align-content', false, 'normal', kw('normal stretch flex-start flex-end center space-between space-around space-evenly start end'));
def('flex-grow', false, 0, (v) => num(v));
def('flex-shrink', false, 1, (v) => num(v));
def('flex-basis', false, 'auto', (v) => (/^(auto|content)$/.test(lc(v)) ? lc(v) : len(lc(v))));
def('row-gap column-gap', false, 'normal', autoOr(lenP({}), 'normal'));
def('break-before break-after', false, 'auto', (v) => ({ auto: 'auto', avoid: 'avoid', 'avoid-page': 'avoid', page: 'page', left: 'page', right: 'page', recto: 'page', verso: 'page', always: 'page' })[lc(v)]);
def('break-inside', false, 'auto', (v) => ({ auto: 'auto', avoid: 'avoid', 'avoid-page': 'avoid' })[lc(v)]);
def('orphans widows', true, 2, (v) => (/^\d+$/.test(v) && +v >= 1 ? +v : undefined));
def('print-color-adjust', true, 'economy', kw('economy exact'));
const same = (a, b) => a && b && a.n === b.n && a.u === b.u;

/** Bewusst ohne Wirkung (keine Warnung): Bildschirm-Effekte, Schatten, Bedienung, Schriftglättung, Schriften aus @font-face */
export const IGNORED_PROPS = Object.freeze([...set('box-shadow text-shadow cursor pointer-events user-select -webkit-user-select -moz-user-select ' +
  '-webkit-tap-highlight-color -webkit-touch-callout -webkit-font-smoothing -moz-osx-font-smoothing text-rendering font-display src unicode-range ' +
  'caret-color accent-color color-scheme -webkit-text-size-adjust -moz-text-size-adjust text-size-adjust scroll-behavior will-change touch-action ' +
  'resize appearance -webkit-appearance -moz-appearance z-index content quotes font-kerning font-optical-sizing font-synthesis isolation ' +
  'overscroll-behavior contain content-visibility backface-visibility outline-offset tab-size text-overflow transition animation')]);
const IGNORED_PREFIX = /^(transition|animation|scroll-margin|scroll-padding|scroll-snap|overscroll-behavior|font-synthesis)-/;
// Ohne Unterstützung, aber mit diesen Werten wirkungslos → still übergehen; jeder andere Wert → Warnung
const HARMLESS = {
  position: /^static$/, float: /^none$/, clear: /^none$/, overflow: /^visible$/, 'overflow-x': /^visible$/, 'overflow-y': /^visible$/,
  opacity: /^(1(\.0*)?|100%)$/, transform: /^none$/, 'text-indent': /^0(\.0*)?([a-z]+)?$/, 'word-spacing': /^(normal|0(\.0*)?([a-z]+)?)$/,
  'table-layout': /^auto$/, 'caption-side': /^top$/, 'empty-cells': /^show$/, direction: /^ltr$/, 'unicode-bidi': /^normal$/,
  'writing-mode': /^horizontal-tb$/, 'font-variant': /^normal$/, 'font-variant-caps': /^normal$/, 'font-variant-numeric': /^normal$/,
  'font-variant-ligatures': /^normal$/, 'font-feature-settings': /^normal$/, 'font-variation-settings': /^normal$/, 'font-stretch': /^(normal|100%)$/,
  'word-break': /^normal$/, 'overflow-wrap': /^normal$/, 'word-wrap': /^normal$/, hyphens: /^(manual|none)$/, 'line-break': /^auto$/,
  'background-image': /^none$/, 'background-clip': /^border-box$/, 'background-origin': /^padding-box$/, 'background-repeat': /./,
  'background-position': /./, 'background-size': /./, 'background-attachment': /./, 'list-style-image': /^none$/,
  outline: /^(none|0)$/, 'outline-style': /^none$/, 'outline-width': /./, 'outline-color': /./, 'text-decoration-thickness': /^auto$/,
  'text-underline-offset': /^auto$/, 'text-underline-position': /^auto$/, 'clip-path': /^none$/, filter: /^none$/, 'backdrop-filter': /^none$/,
  'mix-blend-mode': /^normal$/, top: /^auto$/, right: /^auto$/, bottom: /^auto$/, left: /^auto$/, inset: /^auto$/, columns: /^auto$/,
  'column-count': /^auto$/, 'column-width': /^auto$/, 'aspect-ratio': /^auto$/, 'object-fit': /./, 'object-position': /./,
  'text-align-last': /^auto$/, 'text-justify': /^auto$/, 'white-space-collapse': /^collapse$/, 'text-wrap': /^wrap$/, 'text-wrap-mode': /^wrap$/,
  'font-variant-east-asian': /^normal$/, 'font-variant-position': /^normal$/, 'font-size-adjust': /^none$/,
  'clip': /^auto$/, 'max-lines': /^none$/, 'counter-reset': /^none$/, 'counter-increment': /^none$/,
};

// Kurzschreibweisen: name → [Langformen], Zerleger(wert) → [[langform, wert] …] | undefined
const SH = Object.create(null);
const box4 = (props, parse) => (v) => {
  const p = split(v);
  if (!p.length || p.length > 4) return undefined;
  const w = p.map(parse);
  if (w.some((x) => x === undefined)) return undefined;
  const [t, r = t, b = t, l = r] = w;
  return props.map((n, k) => [n, [t, r, b, l][k]]);
};
const sh = (name, longs, fn) => { SH[name] = { longs, fn }; };
for (const k of ['margin', 'padding']) {
  const L = SIDES.map((s) => `${k}-${s}`);
  sh(k, L, box4(L, LH[L[0]].parse));
  sh(`${k}-inline`, [L[3], L[1]], (v) => { const p = split(v).map(LH[L[0]].parse); return p.length <= 2 && p.every((x) => x !== undefined) ? [[L[3], p[0]], [L[1], p[1] ?? p[0]]] : undefined; });
  sh(`${k}-block`, [L[0], L[2]], (v) => { const p = split(v).map(LH[L[0]].parse); return p.length <= 2 && p.every((x) => x !== undefined) ? [[L[0], p[0]], [L[2], p[1] ?? p[0]]] : undefined; });
  for (const [lg, ph] of [['inline-start', 3], ['inline-end', 1], ['block-start', 0], ['block-end', 2]]) sh(`${k}-${lg}`, [L[ph]], (v) => { const x = LH[L[ph]].parse(v); return x === undefined ? undefined : [[L[ph], x]]; });
}
for (const part of ['width', 'style', 'color']) { const L = SIDES.map((s) => `border-${s}-${part}`); sh(`border-${part}`, L, box4(L, LH[L[0]].parse)); }
const borderSide = (v) => {
  const p = split(v);
  if (!p.length || p.length > 3) return undefined;
  let w, s, c;
  for (const x of p) {
    const W = LH['border-top-width'].parse(x), S = LH['border-top-style'].parse(x), C = parseColor(x);
    if (W !== undefined && w === undefined) w = W; else if (S !== undefined && s === undefined) s = S; else if (C !== undefined && c === undefined) c = C; else return undefined;
  }
  return [w ?? 'medium', s ?? 'none', c ?? 'currentcolor'];
};
for (const side of SIDES) {
  const L = ['width', 'style', 'color'].map((x) => `border-${side}-${x}`);
  sh(`border-${side}`, L, (v) => { const r = borderSide(v); return r && L.map((n, k) => [n, r[k]]); });
}
{
  const L = SIDES.flatMap((s) => ['width', 'style', 'color'].map((x) => `border-${s}-${x}`));
  sh('border', L, (v) => { const r = borderSide(v); return r && L.map((n, k) => [n, r[k % 3]]); });
}
{
  const L = CORNERS.map((c) => `border-${c}-radius`);
  sh('border-radius', L, (v) => {
    const [h, vv] = split(v, '/');
    const H = box4(L, lenP({}))(h);
    if (!H) return undefined;
    if (vv !== undefined) { const V = box4(L, lenP({}))(vv); if (!V) return undefined; if (V.some(([, x], k) => !same(x, H[k][1]))) return L.map((n) => [n, 'elliptic']); }
    return H;
  });
}
sh('background', ['background-color'], (v) => {
  let color, warn;
  for (const p of split(v.replace(/\//g, ' / '))) {
    const c = parseColor(p);
    if (c !== undefined) { if (color !== undefined) return undefined; color = c; continue; }
    if (/^(none|repeat|repeat-x|repeat-y|no-repeat|space|round|scroll|fixed|local|left|right|top|bottom|center|cover|contain|auto|border-box|\/)$/i.test(p) || len(lc(p))) continue;
    if (/^(padding-box|content-box|text)$/i.test(p)) return { warn: `Hintergrund „${p}“ wird nicht unterstützt` };
    if (/^(url|(repeating-)?(linear|radial|conic)-gradient|image-set)\(/i.test(p)) { warn = 'background: Hintergrundbilder/Verläufe werden nicht unterstützt (nur die Farbe gilt)'; continue; }
    return undefined;
  }
  const r = [['background-color', color ?? [0, 0, 0, 0]]];
  if (warn) r.warn = warn;
  return r;
});
sh('font', ['font-style', 'font-weight', 'font-size', 'line-height', 'font-family'], (v) => {
  if (/^(caption|icon|menu|message-box|small-caption|status-bar)$/i.test(v.trim())) return { warn: `Systemschrift „${v.trim()}“ wird nicht unterstützt` };
  const m = /^((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|\d+|(?:ultra-|extra-|semi-)?(?:condensed|expanded))\s+)*)([^\s/]+)(?:\s*\/\s*([^\s]+))?\s+(\S.*)$/i.exec(v.trim());
  if (!m) return undefined;
  let style = 'normal', weight = 400, warn;
  for (const w of m[1].trim().split(/\s+/).filter(Boolean)) {
    const x = lc(w);
    if (x === 'normal') continue;
    if (x === 'italic' || x === 'oblique') style = 'italic';
    else if (x === 'small-caps') warn = 'font: small-caps wird nicht unterstützt (ignoriert)';
    else if (/condensed|expanded/.test(x)) warn = `font: ${x} wird nicht unterstützt (ignoriert)`;
    else { const fw = LH['font-weight'].parse(x); if (fw === undefined) return undefined; weight = fw; }
  }
  const size = LH['font-size'].parse(m[2]), lh = m[3] ? LH['line-height'].parse(m[3]) : 'normal', fam = parseFamily(m[4]);
  if (size === undefined || lh === undefined || !fam) return undefined;
  const r = [['font-style', style], ['font-weight', weight], ['font-size', size], ['line-height', lh], ['font-family', fam]];
  if (warn) r.warn = warn;
  return r;
});
sh('text-decoration', ['text-decoration-line', 'text-decoration-style', 'text-decoration-color'], (v) => {
  const lines = []; let style, color, warn;
  for (const p of split(v)) {
    const x = lc(p);
    if (/^(underline|overline|line-through|none)$/.test(x)) lines.push(x);
    else if (/^(solid|double|dotted|dashed|wavy)$/.test(x) && !style) style = x;
    else if (parseColor(p) !== undefined && !color) color = parseColor(p);
    else if (x === 'auto' || x === 'from-font') continue;
    else if (len(x)) warn = 'text-decoration: Linienstärke wird nicht unterstützt (ignoriert)';
    else return undefined;
  }
  const line = lines.length ? LH['text-decoration-line'].parse(lines.join(' ')) : 'none';
  if (line === undefined || (lines.includes('none') && lines.length > 1)) return undefined;
  const r = [['text-decoration-line', line], ['text-decoration-style', style || 'solid'], ['text-decoration-color', color || 'currentcolor']];
  if (warn) r.warn = warn;
  return r;
});
sh('list-style', ['list-style-type', 'list-style-position'], (v) => {
  let type, pos, none = 0, warn;
  for (const p of split(v)) {
    const x = lc(p);
    if (x === 'none') none++;
    else if (/^(inside|outside)$/.test(x) && !pos) pos = x;
    else if (LH['list-style-type'].parse(x) && !type) type = x;
    else if (/^url\(/.test(x)) warn = 'list-style: Bilder als Aufzählungszeichen werden nicht unterstützt (ignoriert)';
    else return undefined;
  }
  if (none && type) return undefined;
  const r = [['list-style-type', none ? 'none' : (type || 'disc')], ['list-style-position', pos || 'outside']];
  if (warn) r.warn = warn;
  return r;
});
sh('flex', ['flex-grow', 'flex-shrink', 'flex-basis'], (v) => {
  const x = lc(v.trim());
  if (x === 'none') return [['flex-grow', 0], ['flex-shrink', 0], ['flex-basis', 'auto']];
  if (x === 'auto') return [['flex-grow', 1], ['flex-shrink', 1], ['flex-basis', 'auto']];
  const p = split(x);
  // Muster aus Zahl (n) und Basis (b); eine einheitenlose 0 an dritter Stelle ist die Basis
  let types = p.map((t) => (num(t) !== undefined ? 'n' : LH['flex-basis'].parse(t) !== undefined ? 'b' : 'x')).join('');
  if (types === 'nnn' && +p[2] === 0) types = 'nnb';
  const at = { n: 'g', b: 'B', nn: 'gs', nb: 'gB', bn: 'Bg', nnb: 'gsB', bnn: 'Bgs' }[types];
  if (!at) return undefined;
  const r = { g: 1, s: 1, B: { n: 0, u: '%' } };
  [...at].forEach((k, j) => { r[k] = k === 'B' ? LH['flex-basis'].parse(p[j]) : +p[j]; });
  return [['flex-grow', r.g], ['flex-shrink', r.s], ['flex-basis', r.B]];
});
sh('flex-flow', ['flex-direction', 'flex-wrap'], (v) => {
  let d, w;
  for (const p of split(v)) { const D = LH['flex-direction'].parse(p), W = LH['flex-wrap'].parse(p); if (D && !d) d = D; else if (W && !w) w = W; else return undefined; }
  return [['flex-direction', d || 'row'], ['flex-wrap', w || 'nowrap']];
});
sh('gap', ['row-gap', 'column-gap'], (v) => { const p = split(v).map(LH['row-gap'].parse); return p.length && p.length <= 2 && p.every((x) => x !== undefined) ? [['row-gap', p[0]], ['column-gap', p[1] ?? p[0]]] : undefined; });
sh('grid-gap', ['row-gap', 'column-gap'], SH.gap.fn);
for (const k of ['before', 'after', 'inside']) {
  sh(`page-break-${k}`, [`break-${k}`], (v) => { const x = LH[`break-${k}`].parse(v); return x === undefined ? undefined : [[`break-${k}`, x]]; });
}
sh('-webkit-print-color-adjust', ['print-color-adjust'], (v) => { const x = LH['print-color-adjust'].parse(v); return x && [['print-color-adjust', x]]; });
sh('color-adjust', ['print-color-adjust'], SH['-webkit-print-color-adjust'].fn);

const GLOBAL = set('inherit initial unset');
/** Deklarationsblock → [{ prop (Langform), value (angegeben), important }]; Ungültiges → warn, übersprungen */
function parseDecls(text, warn, where) {
  const out = [];
  for (const d of split(text, ';')) {
    if (!d) continue;
    const c = d.indexOf(':');
    if (c < 0) { warn(`${where}: „${d.slice(0, 60)}“ ist keine Deklaration – übersprungen`); continue; }
    const prop = d.slice(0, c).trim().toLowerCase();
    let value = d.slice(c + 1).trim();
    let important = false;
    const im = /!\s*important\s*$/i.exec(value);
    if (im) { important = true; value = value.slice(0, im.index).trim(); }
    const add = (p, v) => out.push({ prop: p, value: v, important, order: ruleOrder++ });
    if (prop.startsWith('--')) { warn(`${where}: CSS-Variablen (${prop}) werden nicht unterstützt – übersprungen`); continue; }
    if (IGNORED_PROPS.includes(prop) || IGNORED_PREFIX.test(prop)) continue;
    if (!value) { warn(`${where}: ${prop} ohne Wert – übersprungen`); continue; }
    if (/\b(var|calc|env|attr|min|max|clamp)\(/i.test(value)) { warn(`${where}: ${prop}: ${value} – Funktionen wie var()/calc() werden nicht unterstützt, übersprungen`); continue; }
    const g = lc(value);
    const target = LH[prop] ? [prop] : SH[prop]?.longs;
    if (target && GLOBAL.has(g)) { for (const p of target) add(p, g); continue; }
    if (target && /^revert(-layer)?$/.test(g)) { warn(`${where}: ${prop}: ${value} wird nicht unterstützt – übersprungen`); continue; }
    if (LH[prop]) {
      const v = LH[prop].parse(value);
      if (v === 'elliptic') { warn(`${where}: ${prop}: ${value} – elliptische Ecken werden nicht unterstützt, übersprungen`); continue; }
      if (v === undefined) { warn(`${where}: ${prop}: ${value} – Wert nicht verstanden, übersprungen`); continue; }
      add(prop, v);
      continue;
    }
    if (SH[prop]) {
      const r = SH[prop].fn(value);
      if (!r || r.warn && !Array.isArray(r)) { warn(`${where}: ${prop}: ${value} – ${r?.warn || 'Wert nicht verstanden'}, übersprungen`); continue; }
      if (r.some(([, v]) => v === 'elliptic')) { warn(`${where}: ${prop}: ${value} – elliptische Ecken werden nicht unterstützt, übersprungen`); continue; }
      if (r.warn) warn(`${where}: ${r.warn}`);
      for (const [p, v] of r) add(p, v);
      continue;
    }
    if (prop in HARMLESS) {
      if (!GLOBAL.has(g) && !HARMLESS[prop].test(g)) warn(`${where}: ${prop}: ${value} wird nicht unterstützt – übersprungen`);
      continue;
    }
    warn(`${where}: unbekannte Eigenschaft ${prop} – übersprungen`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Kaskade und berechnete Werte
// ---------------------------------------------------------------------------
// Browser-Grundstil (Auszug aus Chromes html.css für die vorkommenden Elemente, Standardmodus)
const UA_CSS = `
html,address,blockquote,body,center,dialog,div,figure,figcaption,footer,form,header,hr,legend,listing,main,p,plaintext,pre,search,xmp,
article,aside,h1,h2,h3,h4,h5,h6,hgroup,nav,section,dl,dt,dd,ul,ol,menu,dir,details,summary,fieldset,optgroup{display:block}
head,link,meta,script,style,title,template,area,base,basefont,datalist,noembed,noframes,param,rp,[hidden]{display:none}
body{margin:8px}
p{margin-top:1em;margin-bottom:1em}
blockquote,figure{margin:1em 40px}
address,cite,dfn,em,i,var{font-style:italic}
center{text-align:-webkit-center}
hr{color:gray;margin:.5em auto;border-style:inset;border-width:1px}
h1{font-size:2em;margin-top:.67em;margin-bottom:.67em;font-weight:bold}
h2{font-size:1.5em;margin-top:.83em;margin-bottom:.83em;font-weight:bold}
h3{font-size:1.17em;margin-top:1em;margin-bottom:1em;font-weight:bold}
h4{margin-top:1.33em;margin-bottom:1.33em;font-weight:bold}
h5{font-size:.83em;margin-top:1.67em;margin-bottom:1.67em;font-weight:bold}
h6{font-size:.67em;margin-top:2.33em;margin-bottom:2.33em;font-weight:bold}
ul,menu,dir{list-style-type:disc;margin-top:1em;margin-bottom:1em;padding-left:40px}
ol{list-style-type:decimal;margin-top:1em;margin-bottom:1em;padding-left:40px}
li{display:list-item}
ul ul,ol ul,menu ul,dir ul,ul menu,ol menu,ul dir,ol dir{list-style-type:circle}
ol ol ul,ol ul ul,ul ol ul,ul ul ul,ol ol menu,ol ul menu,ul ol menu,ul ul menu{list-style-type:square}
ul ul,ul ol,ol ul,ol ol,ul dl,ol dl,dl ul,dl ol,dl dl,ul menu,ol menu,menu ul,menu ol,menu menu,dir ul,ul dir,dir dir{margin-top:0;margin-bottom:0}
dl{margin-top:1em;margin-bottom:1em}
dd{margin-left:40px}
table{display:table;border-collapse:separate;border-spacing:2px;border-color:gray;box-sizing:border-box}
caption{display:table-caption;text-align:-webkit-center}
thead{display:table-header-group;vertical-align:middle;border-color:inherit}
tbody{display:table-row-group;vertical-align:middle;border-color:inherit}
tfoot{display:table-footer-group;vertical-align:middle;border-color:inherit}
thead,tfoot{break-inside:avoid}
table>tr{vertical-align:middle}
col{display:table-column}
colgroup{display:table-column-group}
tr{display:table-row;vertical-align:inherit;border-color:inherit}
td,th{display:table-cell;vertical-align:inherit;padding:1px}
th{font-weight:bold;text-align:-internal-center}
b,strong{font-weight:bolder}
small{font-size:smaller}
big{font-size:larger}
sub{vertical-align:sub;font-size:smaller}
sup{vertical-align:super;font-size:smaller}
u,ins{text-decoration:underline}
s,strike,del{text-decoration:line-through}
a:any-link{color:#0000ee;text-decoration:underline}
abbr[title],acronym[title]{text-decoration:underline dotted}
mark{background-color:yellow;color:black}
code,kbd,samp,pre,tt,xmp,listing,plaintext{font-family:monospace}
pre,xmp,plaintext,listing{white-space:pre;margin-top:1em;margin-bottom:1em}
nobr{white-space:nowrap}
input,select,button,textarea,meter,progress{display:inline-block}
`;
let UA = null;
const uaRules = () => {
  if (!UA) { const w = []; UA = parseCss(UA_CSS, w).rules; if (w.length) throw new Error('Grundstil: ' + w.join('; ')); for (const r of UA) r.ua = true; }
  return UA;
};

const camel = (p) => p.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
const PROPS = Object.keys(LH);
const KEYS = Object.fromEntries(PROPS.map((p) => [p, camel(p)]));
const BLOCKIFY = { inline: 'block', 'inline-block': 'block', 'inline-table': 'table', 'inline-flex': 'flex', 'table-row-group': 'block', 'table-header-group': 'block',
  'table-footer-group': 'block', 'table-row': 'block', 'table-cell': 'block', 'table-caption': 'block', 'table-column': 'block', 'table-column-group': 'block' };
const ATOMIC = set('inline-block inline-table inline-flex');
const UNSUPPORTED_EL = set('img picture video audio canvas iframe object embed math input select textarea button meter progress');
const LEGACY_ATTRS = set('align valign bgcolor background cellpadding cellspacing border nowrap color face size hspace vspace');
const colorOut = (c) => (c[3] === 1 ? c.slice(0, 3) : c);
const weightRel = (p, w) => (w === 'bolder' ? (p < 350 ? 400 : p < 550 ? 700 : 900) : p < 100 ? p : p < 550 ? 100 : p < 750 ? 400 : 700);
const TEXT_ALIGN = { start: 'left', left: 'left', '-webkit-left': 'left', end: 'right', right: 'right', '-webkit-right': 'right', center: 'center', '-webkit-center': 'center', '-internal-center': 'center', justify: 'justify' };

/** Seitengröße/-ränder aus @page (Kaskade in Dokumentreihenfolge) → { width, height, margin: [o, r, u, l], contentWidth, contentHeight, size, landscape } in CSS-px */
const PAGE_MM = { a3: [297, 420], a4: [210, 297], a5: [148, 210], b4: [250, 353], b5: [176, 250], letter: [215.9, 279.4], legal: [215.9, 355.6], ledger: [279.4, 431.8] };
function pageBox(pages, env, warn, defaultMargin) {
  let size = null, landscape = false, wh = null;
  const margin = Array(4).fill(null);
  const plen = (v) => {
    const l = len(lc(v), { pct: false });
    if (!l) return undefined;
    return l.u === 'em' || l.u === 'rem' ? l.n * 16 : l.n * UNIT[l.u];
  };
  for (const pg of pages) {
    if (!pg.media.every((l) => mediaMatches(l, env, warn))) continue;
    for (const { prop, value } of pg.decls) {
      const v = lc(value);
      if (prop === 'size') {
        const p = split(v);
        const orient = p.filter((x) => x === 'landscape' || x === 'portrait');
        const named = p.filter((x) => x in PAGE_MM);
        const lens = p.map(plen).filter((x) => x !== undefined);
        if (v === 'auto') { size = null; wh = null; landscape = false; }
        else if (orient.length + named.length === p.length && orient.length <= 1 && named.length <= 1) { size = named[0] || size; landscape = orient[0] === 'landscape'; wh = null; }
        else if (lens.length === p.length && p.length <= 2) { wh = [lens[0], lens[1] ?? lens[0]]; size = null; landscape = false; }
        else warn(`@page size: ${value} nicht verstanden – übersprungen`);
      } else if (prop === 'margin' || /^margin-(top|right|bottom|left)$/.test(prop)) {
        const p = split(v).map(plen);
        if (!p.length || p.length > (prop === 'margin' ? 4 : 1) || p.some((x) => x === undefined)) { warn(`@page ${prop}: ${value} nicht verstanden (nur feste Längen) – übersprungen`); continue; }
        if (prop === 'margin') { const [t, r = t, b = t, l = r] = p; margin.splice(0, 4, t, r, b, l); } else margin[SIDES.indexOf(prop.slice(7))] = p[0];
      } else warn(`@page ${prop} wird nicht unterstützt – übersprungen`);
    }
  }
  let [w, h] = wh || PAGE_MM[size || 'a4'].map((x) => x * UNIT.mm);
  if (!wh && landscape) [w, h] = [h, w];
  const m = margin.map((x) => x ?? defaultMargin);
  return { width: w, height: h, margin: m, contentWidth: w - m[1] - m[3], contentHeight: h - m[0] - m[2], size: wh ? null : (size || 'a4').toUpperCase().replace('LETTER', 'Letter').replace('LEGAL', 'Legal').replace('LEDGER', 'Ledger'), landscape: w > h };
}

/**
 * Stile berechnen. root = Ergebnis von parseHtml. Optionen:
 *   media: 'print' (Standard) | 'screen'
 *   width/height: Breite/Höhe für @media (CSS-px; Standard: Seiteninhalt aus @page)
 *   defaultMargin: Seitenrand ohne @page-Angabe in CSS-px (Standard 0,4 Zoll = 38,4 px wie Chromes Druckvorgabe)
 * → { root, html, body, page, title, warnings, quirks }; jedes Element bekommt .style (siehe Kopf von Teil 1 / Bericht).
 */
export function computeStyles(root, { media = 'print', width, height, defaultMargin = 38.4, warnings = [] } = {}) {
  const warn = dedupe(warnings);
  const all = [];
  (function walk(n) { for (const c of n.children) if (c.type === 'element') { all.push(c); walk(c); } })(root);
  // Stilquellen: <style> in Dokumentreihenfolge (media-Attribut beachtet); externe Stylesheets gibt es nicht
  const sheets = [];
  for (const el of all) {
    if (el.ns !== 'html') continue;
    if (el.tag === 'style') {
      if (el.attrs.type && !/^\s*text\/css\s*$/i.test(el.attrs.type)) continue;
      const mq = el.attrs.media ? [parseMediaList(el.attrs.media)] : [];
      sheets.push(parseCss(el.children.map((t) => t.text || '').join(''), warnings, { where: '<style>', media: mq }));
    } else if (el.tag === 'link' && /stylesheet/i.test(el.attrs.rel || '')) warn(`externes Stylesheet ${el.attrs.href || ''} wird nicht geladen`);
  }
  const pages = sheets.flatMap((s) => s.pages);
  const page = pageBox(pages, { type: media, width: 210 * UNIT.mm - 2 * defaultMargin, height: 297 * UNIT.mm - 2 * defaultMargin }, warn, defaultMargin);
  const env = { type: media, width: width ?? page.contentWidth, height: height ?? page.contentHeight };
  // Regeln mit zutreffendem @media → Eimer nach dem rechten Teil des Selektors (id > Klasse > Typ > *)
  const index = new Map();
  const put = (k, x) => { const a = index.get(k); if (a) a.push(x); else index.set(k, [x]); };
  for (const rule of [...uaRules(), ...sheets.flatMap((s) => s.rules)]) {
    if (!rule.media.every((l) => mediaMatches(l, env, warn))) continue;
    for (const sel of rule.selectors) {
      const last = sel.parts[sel.parts.length - 1];
      put(last.ids.length ? '#' + last.ids[0] : last.classes.length ? '.' + last.classes[0] : last.tag ? last.tag : '*', { sel, rule });
    }
  }
  let rootFs = 16;
  for (const el of all) {
    // Kaskade: Rang (Grundstil < Darstellungsattribut < Autor < Autor !important), dann Spezifität, dann Reihenfolge
    const win = Object.create(null);
    const offer = (d, rank, spec) => {
      const w = win[d.prop];
      if (!w || rank > w.rank || (rank === w.rank && (spec > w.spec || (spec === w.spec && d.order > w.order)))) win[d.prop] = { v: d.value, rank, spec, order: d.order };
    };
    const cands = [index.get('*'), index.get(el.tag.toLowerCase()), el.attrs.id !== undefined && index.get('#' + el.attrs.id), ...[...classes(el)].map((c) => index.get('.' + c))];
    for (const list of cands) {
      if (!list) continue;
      for (const { sel, rule } of list) {
        if (!matchParts(sel.parts, sel.parts.length - 1, el)) continue;
        for (const d of rule.decls) offer(d, rule.ua ? (d.important ? 4 : 0) : (d.important ? 3 : 2), sel.spec);
      }
    }
    if ((el.tag === 'svg' || el.tag === 'img') && el.parent) {   // width/height-Attribute als Darstellungshinweis
      for (const k of ['width', 'height']) {
        const a = el.attrs[k];
        if (a === undefined) continue;
        const v = /^[\d.]+$/.test(a.trim()) ? { n: +a, u: 'px' } : len(lc(a.trim()));
        if (v) offer({ prop: k, value: v, order: -1 }, 1, 0); else warn(`<${el.tag} ${k}="${a}"> nicht verstanden`);
      }
    }
    if (el.ns === 'html') for (const a in el.attrs) if (LEGACY_ATTRS.has(a) && !(a === 'border' && el.tag === 'svg')) warn(`Attribut ${a}="${el.attrs[a]}" an <${el.tag}> (veraltete Gestaltung) wird nicht ausgewertet`);
    if (el.attrs.style !== undefined) for (const d of parseDecls(el.attrs.style, warn, `style-Attribut an <${el.tag}>`)) offer(d, d.important ? 3 : 2, 1e9);
    const ps = parentEl(el)?.style || null;
    el.style = computeOne(el, win, ps, rootFs);
    if (!ps) rootFs = el.style.fontSize;
  }
  for (const el of all) {   // was der Satz nicht kann, nur melden, wenn es wirklich sichtbar wäre
    if (el.ns !== 'html' || !shown(el)) continue;
    if (UNSUPPORTED_EL.has(el.tag)) warn(`<${el.tag}> ist sichtbar, wird im PDF aber nicht unterstützt`);
    const s = el.style, half = (c) => c.length === 4 && c[3] > 0;   // halbtransparent (ganz durchsichtig ist unproblematisch)
    if (half(s.color) && el.children.some((c) => c.type === 'text' && /\S/.test(c.text)) || half(s.backgroundColor)
      || BSIDES.some(([w], k) => s[w] > 0 && half(s[`border${['Top', 'Right', 'Bottom', 'Left'][k]}Color`]))) warn(`<${el.tag}>: halbtransparente Farbe – Transparenz wird im PDF nicht unterstützt`);
  }
  const htmlEl = root.children.find((c) => c.type === 'element' && c.tag === 'html') || null;
  const head = htmlEl?.children.find((c) => c.type === 'element' && c.tag === 'head');
  const titleEl = head?.children.find((c) => c.type === 'element' && c.tag === 'title');
  const title = titleEl ? titleEl.children.map((t) => t.text).join('').replace(/[ \t\n\f\r]+/g, ' ').trim() : '';
  return { root, html: htmlEl, body: htmlEl?.children.find((c) => c.type === 'element' && c.tag === 'body') || null, page, title, warnings, quirks: !!root.quirks };
}
const shown = (el) => { for (let e = el; e && e.type === 'element'; e = e.parent) if (e.style.display === 'none') return false; return el.style.visibility === 'visible'; };

// je Langform vorab: Schlüssel, vererbt?, Anfangswert, Sonderfall (k) für computeOne
const SPECIAL_K = { 'font-weight': 1, 'line-height': 2, 'text-align': 3, 'letter-spacing': 4, 'vertical-align': 5, 'text-decoration-line': 6,
  'list-style-type': 7, 'border-spacing': 8, 'row-gap': 9, 'column-gap': 9 };
const META = PROPS.filter((p) => p !== 'font-size' && p !== 'color')
  .map((p) => ({ p, key: KEYS[p], inh: LH[p].inh, init: LH[p].init, k: SPECIAL_K[p] || (/^border-.*-width$/.test(p) ? 10 : 0) }));
const BWIDTH = { thin: 1, medium: 3, thick: 5 };
const BSIDES = SIDES.map((x) => [`border${x[0].toUpperCase()}${x.slice(1)}Width`, `border${x[0].toUpperCase()}${x.slice(1)}Style`]);
const value = (win, p, inh, init, ps) => {
  let v = win[p]?.v;
  if (v === undefined || v === 'unset') v = inh ? 'inherit' : 'initial';
  if (v === 'inherit' && !ps) v = 'initial';
  return v === 'initial' ? init : v;
};

/** Berechnete Werte eines Elements aus den gewonnenen Deklarationen (win) und dem Elternstil (ps) */
function computeOne(el, win, ps, rootFs) {
  const s = {};
  // Schriftgröße zuerst (em-Bezug für alles Weitere)
  const pfs = ps ? ps.fontSize : 16, rfs = ps ? rootFs : 16;
  let v = value(win, 'font-size', true, 'medium', ps);
  const fs = v === 'inherit' ? pfs : typeof v === 'string' ? (v === 'smaller' ? pfs / 1.2 : v === 'larger' ? pfs * 1.2 : FONT_SIZE_KW[v])
    : v.u === '%' ? v.n / 100 * pfs : v.u === 'em' ? v.n * pfs : v.u === 'rem' ? v.n * rfs : v.n * UNIT[v.u];
  s.fontSize = fs;
  const px = (l) => (l.u === 'em' ? l.n * fs : l.u === 'rem' ? l.n * rfs : l.n * UNIT[l.u]);
  const lp = (l) => (l.u === '%' ? { pct: l.n } : px(l));
  v = value(win, 'color', true, LH.color.init, ps);
  s.color = v === 'inherit' || v === 'currentcolor' ? (ps ? ps.color : [0, 0, 0]) : colorOut(v);
  for (const { p, key, inh, init, k } of META) {
    v = value(win, p, inh, init, ps);
    if (v === 'inherit') {
      if (k === 2) { s.lineHeightFactor = ps.lineHeightFactor; s.lineHeight = ps.lineHeightFactor != null ? ps.lineHeightFactor * fs : ps.lineHeight; }
      else s[key] = ps[key];
      continue;
    }
    switch (k) {
      case 1: s[key] = v === 'normal' ? 400 : v === 'bold' ? 700 : v === 'bolder' || v === 'lighter' ? weightRel(ps ? ps.fontWeight : 400, v) : v; break;
      case 2:
        s.lineHeightFactor = v !== 'normal' && v.f !== undefined ? v.f : null;
        s.lineHeight = v === 'normal' ? 'normal' : v.f !== undefined ? v.f * fs : v.u === '%' ? v.n / 100 * fs : px(v);
        break;
      case 3: s[key] = v === 'match-parent' ? (ps ? ps.textAlign : 'left') : TEXT_ALIGN[v]; break;
      case 4: s[key] = v === 'normal' ? 0 : px(v); break;
      case 5: s[key] = typeof v === 'string' ? v : lp(v); break;
      case 6: s[key] = v === 'none' ? [] : v.split(' '); break;
      case 7: s[key] = v === 'lower-latin' ? 'lower-alpha' : v === 'upper-latin' ? 'upper-alpha' : v; break;
      case 8: s[key] = [px(v[0]), px(v[1])]; break;
      case 9: s[key] = v === 'normal' ? 0 : lp(v); break;
      case 10: s[key] = typeof v === 'string' ? BWIDTH[v] : px(v); break;
      default:
        if (v === 'currentcolor') s[key] = s.color;
        else if (typeof v !== 'object') s[key] = v;
        else if (v.u !== undefined) s[key] = lp(v);
        else if (typeof v[0] === 'number') s[key] = colorOut(v);   // Farbe
        else s[key] = v;                                           // Schriftliste
    }
  }
  // Rahmenbreite: ohne Linienstil 0; sonst wie Chrome auf ganze px abgerundet (0 < b < 1 → 1)
  for (const [w, st] of BSIDES) {
    const b = s[w];
    s[w] = s[st] === 'none' || s[st] === 'hidden' ? 0 : b > 0 && b < 1 ? 1 : Math.floor(b + 1e-6);
  }
  // Anzeigeart: Kinder von Flex-Containern und das Wurzelelement werden blockartig (wie Chrome)
  if (s.display !== 'none' && (!ps || ps.display === 'flex' || ps.display === 'inline-flex')) s.display = BLOCKIFY[s.display] || s.display;
  // Textlinien, die an diesem Element sichtbar sind: von Vorfahren weitergereicht (nicht in inline-block/inline-table/inline-flex hinein) + eigene
  const inherited = ps && !ATOMIC.has(s.display) ? ps.textDecorations : [];
  const own = s.textDecorationLine.map((line) => ({ line, style: s.textDecorationStyle, color: s.textDecorationColor }));
  s.textDecorations = own.length ? [...inherited, ...own] : inherited;
  return s;
}

/**
 * HTML-Text → fertiger Stilbaum für den Druck (parseHtml + computeStyles). Optionen wie computeStyles.
 * → { root, html, body, page: { width, height, margin: [oben, rechts, unten, links], contentWidth, contentHeight, size, landscape },
 *     title, warnings: [Text …], quirks }
 */
export function styleTree(html, opts = {}) {
  const warnings = opts.warnings || [];
  const root = parseHtml(html, warnings);
  return computeStyles(root, { ...opts, warnings });
}

// ---------------------------------------------------------------------------
// 6. Sichtbarer Text (für die Prüfung „kein Zeichen verloren“): Dokumentreihenfolge, ohne display:none, ohne
//    head/style/script/title/svg, ohne visibility:hidden; Leerraum wie im Browser zusammengefasst, Blockgrenzen/br als \n.
//    transform: true wendet text-transform an (so wie innerText im Browser).
// ---------------------------------------------------------------------------
const NO_TEXT = set('head style script title template noscript textarea select');
export function visibleText(node, { transform = false } = {}) {
  let out = '';
  const walk = (n) => {
    for (const c of n.children) {
      if (c.type === 'text') {
        const st = n.style;
        if (!st || st.visibility !== 'visible') continue;
        let t = c.text;
        if (st.whiteSpace === 'normal' || st.whiteSpace === 'nowrap') t = t.replace(/[ \t\n\f\r]+/g, ' ');
        else if (st.whiteSpace === 'pre-line') t = t.replace(/[ \t\f\r]+/g, ' ');
        if (transform) t = applyTransform(t, st.textTransform);
        out += t;
        continue;
      }
      if (c.type !== 'element' || c.ns !== 'html' || NO_TEXT.has(c.tag) || !c.style || c.style.display === 'none') continue;
      if (c.tag === 'br') { if (c.style.visibility === 'visible') out += '\n'; continue; }
      const block = !c.style.display.startsWith('inline');
      if (block) out += '\n';
      walk(c);
      if (block) out += '\n';
    }
  };
  walk(node.type === 'document' ? node : { children: [node], style: node.parent?.style });
  return out.replace(/[ \t]*\n[ \t\n]*/g, '\n').replace(/ {2,}/g, ' ').trim();
}
/** text-transform anwenden (uppercase: ß → SS wie im Browser) */
export function applyTransform(t, tt) {
  if (tt === 'uppercase') return t.toUpperCase();
  if (tt === 'lowercase') return t.toLowerCase();
  if (tt === 'capitalize') return t.replace(/(^|[\s\-–—„“"'(\[/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  return t;
}

// ---------------------------------------------------------------------------
// 7. Satz: HTML-Beleg → A4-PDF (Teil 2)
//
//   const { buffer, pages, warnings, text } = htmlToPdf(html, { createdAt: order.completedAt, author: 'formsam' });
//
// Ablauf: styleTree → Kästen auf einer endlosen Bahn setzen (CSS-px, jeder Kasten relativ zu seinem Elternkasten) →
//   Umbrucheinheiten sammeln (Textzeile, Tabellenzeile, Flex-Zeile, SVG, Kasten ohne Text) → Seitenumbruch als
//   „ab hier alles nach unten schieben“ → zeichnen (1 CSS-px = 0,75 pt) → Selbstprüfung → PDF.
// Fehler (PdfError.code): UNSUPPORTED (Bild ohne Vektordaten, rowspan, Formularfeld …), LAYOUT (Einheit höher als eine
//   Seite), TOO_LARGE (Grenzen für Größe/Knoten/Tiefe/Seiten/Zeit), SELF_CHECK (Zeichen-Bilanz oder Ränder verletzt),
//   dazu die Codes aus lib/pdf.js (GLYPH_MISSING …). Grundsatz: lieber keine PDF als eine falsche.
// ---------------------------------------------------------------------------
const PT = 0.75;                                   // 1 CSS-px = 0,75 pt
const LIMIT = Object.freeze({ bytes: 4e6, elements: 30000, depth: 256, pages: 60, steps: 5e6, ms: 20000 });
const fail = (code, msg) => new PdfError(code, msg);
/** Länge aus dem Stil → px; { pct } nur mit Bezugsgröße, 'auto'/'none' → null */
const lenOf = (v, ref) => (typeof v === 'number' ? v : v && typeof v === 'object' && v.pct !== undefined && ref != null ? v.pct / 100 * ref : null);
const auto0 = (v) => (typeof v === 'number' ? v : 0);
const sum = (a) => a.reduce((s, v) => s + v, 0);
// Außenabstände als Menge { p: größter positiver, n: kleinster negativer } — zusammenfallen = Maximum/Minimum
const M0 = Object.freeze({ p: 0, n: 0 });
const mOf = (v) => (v >= 0 ? { p: v, n: 0 } : { p: 0, n: v });
const mMerge = (a, b) => ({ p: Math.max(a.p, b.p), n: Math.min(a.n, b.n) });
const mVal = (m) => m.p + m.n;
const INLINE_LEVEL = set('inline inline-block inline-table inline-flex');
const isSvg = (el) => el.ns === 'svg' && el.tag === 'svg';
const isFlex = (d) => d === 'flex' || d === 'inline-flex';
const isTable = (d) => d === 'table' || d === 'inline-table';
const collapsible = (ws) => ws === 'normal' || ws === 'nowrap' || ws === 'pre-line';
const KNOWN_TAGS = set('html head body div span p a b i u s em strong small big sub sup br wbr hr h1 h2 h3 h4 h5 h6 ul ol li dl dt dd menu dir ' +
  'table thead tbody tfoot tr td th caption col colgroup header footer main section article aside nav address blockquote figure figcaption ' +
  'pre code kbd samp var tt mark abbr acronym cite dfn time data del ins strike center font nobr label form fieldset legend search hgroup output bdi');
const HIDDEN_TAGS = set('head style script title template noscript meta link base');   // nie sichtbar (wie visibleText)
const SVG_SHAPES = set('path rect circle ellipse line polyline polygon');
const SVG_QUIET = set('title desc metadata');

// ---- Schriften: font-family → Inter oder Fraunces (mit Inter als Ersatz) im nächstliegenden Schnitt ----
const FAM = new Map();
for (const n of ['fraunces', 'serif', 'ui-serif', 'georgia', 'times', 'times new roman', 'cambria', 'garamond', 'palatino', 'palatino linotype',
  'book antiqua', 'baskerville', 'didot', 'constantia', 'charter', 'noto serif', 'dejavu serif', 'liberation serif']) FAM.set(n, 'Fraunces');
for (const n of ['inter', 'sans-serif', 'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica', 'helvetica neue', 'arial',
  'ui-sans-serif', 'ui-rounded', 'verdana', 'tahoma', 'noto sans', 'ubuntu', 'cantarell', 'open sans', 'liberation sans', 'dejavu sans', 'arimo', 'lato']) FAM.set(n, 'Inter');
for (const n of ['monospace', 'ui-monospace', 'courier', 'courier new', 'consolas', 'menlo', 'monaco', 'sfmono-regular', 'sf mono', 'liberation mono',
  'dejavu sans mono']) FAM.set(n, 'mono');
const FONTS = new Map();
/** Stil → { chain (Schriftkette für lib/pdf.js), key, mono, Metrik je 1 px Schriftgröße } */
function fontFor(st) {
  const key = `${st.fontFamily.join(',')}|${st.fontWeight}`;
  let fc = FONTS.get(key);
  if (fc) return fc;
  let fam = 'Inter';
  for (const f of st.fontFamily) { const k = FAM.get(f.toLowerCase()); if (k) { fam = k; break; } }   // unbekannte Namen: weiter zum nächsten
  const w = Math.min(1000, Math.max(1, st.fontWeight));
  const chain = fam === 'Fraunces' ? [findFont({ family: 'Fraunces', weight: w }), findFont({ family: 'Inter', weight: w })] : [findFont({ family: 'Inter', weight: w })];
  const m = fontMetrics(chain[0], 1);
  fc = { chain, key: chain.map((f) => f.name).join('+'), mono: fam === 'mono', asc: m.ascent, desc: m.descent, gap: m.lineGap, xh: m.xHeight,
    ul: -m.underlinePosition, ulw: m.underlineThickness, so: m.strikeoutPosition, sow: m.strikeoutSize };
  FONTS.set(key, fc);
  return fc;
}
const textOpts = (st, fc) => {
  const o = { font: fc.chain, size: st.fontSize * PT, letterSpacing: st.letterSpacing * PT };
  if (st.fontStyle === 'italic') o.oblique = true;   // es gibt keine Kursivschnitte: Schrägstellung wie Chrome
  return o;
};
/** Breite in px — exakt die Zahl, die page.text() beim Zeichnen ergibt (gleiche Angaben) */
function measure(s, st, L) {
  const fc = fontFor(st), key = `${fc.key}|${st.fontSize}|${st.letterSpacing}`;
  let c = L.mc.get(key);
  if (!c) L.mc.set(key, c = new Map());
  let w = c.get(s);
  if (w === undefined) {
    if (fc.mono) L.warn('Festbreitenschrift (monospace) gibt es im PDF nicht – gesetzt in Inter');
    try { w = measureText(s, textOpts(st, fc)) / PT; } catch (e) { throw withText(e, s); }
    c.set(s, w);
  }
  return w;
}
function withText(e, s) {
  if (e instanceof PdfError && e.code === 'GLYPH_MISSING') e.message += ` – im Text „${s.length > 60 ? s.slice(0, 57) + '…' : s}“`;
  return e;
}
/** Höhen eines Inline-Kastens wie Chrome: Ober-/Unterlänge auf ganze px gerundet, der obere halbe Durchschuss abgerundet */
function vmetrics(st, L) {
  let m = L.vm.get(st);
  if (m) return m;
  const fc = fontFor(st), fs = st.fontSize;
  const A = Math.round(fc.asc * fs), D = Math.round(fc.desc * fs);
  const lh = st.lineHeight === 'normal' ? A + D + Math.round(fc.gap * fs) : st.lineHeight;
  const a = A + Math.floor((lh - A - D) / 2);
  L.vm.set(st, m = { A, D, a, d: lh - a, lh, fc });
  return m;
}

// ---- Kastenmaße ----
/** Innen-/Außenabstände und Rahmen in px; Prozent bezogen auf die Breite des umgebenden Blocks (ohne Bezug → 0) */
function frame(st, cbW, borders) {
  const p = (v) => lenOf(v, cbW) ?? 0, m = (v) => (v === 'auto' ? 'auto' : p(v));
  const b = borders || [st.borderTopWidth, st.borderRightWidth, st.borderBottomWidth, st.borderLeftWidth];
  return { pt: p(st.paddingTop), pr: p(st.paddingRight), pb: p(st.paddingBottom), pl: p(st.paddingLeft), bt: b[0], br: b[1], bb: b[2], bl: b[3],
    mt: m(st.marginTop), mr: m(st.marginRight), mb: m(st.marginBottom), ml: m(st.marginLeft) };
}
/** Breite eines Blocks im Fluss (CSS 2.1 §10.3.3) → { w (Rahmenkasten), ml, mr }; shrink(avail) für schrumpfende Kästen */
function blockWidth(st, fr, cbW, shrink) {
  const hz = fr.pl + fr.pr + fr.bl + fr.br, cb = st.boxSizing === 'content-box' ? hz : 0;
  let ml = fr.ml, mr = fr.mr, w = lenOf(st.width, cbW);
  if (w != null) w += cb;
  else { const avail = cbW - auto0(ml) - auto0(mr); w = shrink ? shrink(avail) : avail; }
  const mx = lenOf(st.maxWidth, cbW), mn = lenOf(st.minWidth, cbW);
  if (mx != null && w > mx + cb) w = mx + cb;
  if (mn != null && w < mn + cb) w = mn + cb;
  w = Math.max(w, hz);
  const free = cbW - w - auto0(ml) - auto0(mr);
  if (ml === 'auto' && mr === 'auto') { ml = Math.max(0, free) / 2; mr = free - ml; }
  else if (ml === 'auto') { ml = free; mr = auto0(mr); }
  else mr = auto0(mr) + free;
  return { w, ml, mr };
}
function heightOf(st, fr, contentH) {
  const vz = fr.pt + fr.pb + fr.bt + fr.bb, cb = st.boxSizing === 'content-box' ? vz : 0;
  let h = lenOf(st.height, null);
  h = h == null ? vz + contentH : h + cb;
  const mx = lenOf(st.maxHeight, null), mn = lenOf(st.minHeight, null);
  if (mx != null && h > mx + cb) h = mx + cb;
  if (mn != null && h < mn + cb) h = mn + cb;
  return Math.max(h, vz);
}

// ---- Inhalt eines Blockcontainers ----
/** → [{ el } Block-Kind | { nodes } Folge von Inline-Inhalt (wird ein anonymer Block)] */
function flowEntries(el, L) {
  let r = L.fe.get(el);
  if (r) return r;
  r = [];
  let run = null;
  const close = () => { if (run && run.some(hasInline)) r.push({ nodes: run }); run = null; };
  const visit = (p) => {
    for (const c of p.children) {
      if (c.type === 'text') { (run ||= []).push(c); continue; }
      if (c.type !== 'element' || c.style.display === 'none' || (c.ns === 'html' && HIDDEN_TAGS.has(c.tag))) continue;
      if (INLINE_LEVEL.has(c.style.display)) {
        if (c.style.display === 'inline' && c.ns === 'html' && blockInside(c)) visit(c);   // Block in Inline: das Inline-Element löst sich auf
        else (run ||= []).push(c);
      } else { close(); r.push({ el: c }); }
    }
  };
  visit(el);
  close();
  L.fe.set(el, r);
  return r;
}
function hasInline(n) {
  if (n.type === 'text') return collapsible(n.parent.style.whiteSpace) ? /[^ \t\n\f\r]/.test(n.text) : n.text.length > 0;
  if (n.type !== 'element' || n.style.display === 'none' || (n.ns === 'html' && HIDDEN_TAGS.has(n.tag))) return false;
  if (n.ns !== 'html' || n.style.display !== 'inline' || n.tag === 'br') return true;
  return n.children.some(hasInline);
}
const blockInside = (el) => el.children.some((c) => c.type === 'element' && c.ns === 'html' && c.style.display !== 'none' && !HIDDEN_TAGS.has(c.tag)
  && (!INLINE_LEVEL.has(c.style.display) || (c.style.display === 'inline' && blockInside(c))));
function inlineChain(n, box) { const ch = []; for (let p = n.parent; p && p !== box; p = p.parent) ch.unshift(p); return ch; }

/** Bruchstellen in einem Wort: nach Bindestrich (zwischen Buchstaben, nicht vor Ziffern), nach ‐ – —, nach Schrägstrich vor
 *  Buchstaben, an U+200B — so wie die Zeilenumbruch-Regeln des Browsers (UAX 14) für die vorkommenden Fälle */
function wordParts(w) {
  if (!/[-\u2010\u2013\u2014\u200b/]/.test(w)) return [w];
  const out = [];
  let s = 0;
  for (let i = 0; i < w.length - 1; i++) {
    const c = w[i], prev = i ? w[i - 1] : '', next = w[i + 1];
    let br = false;
    if (c === '-') br = /\p{L}/u.test(prev) && !/[\d-]/.test(next);
    else if (c === '\u2010' || c === '\u2013' || c === '\u2014') br = i > 0;
    else if (c === '\u200b') br = true;
    else if (c === '/') br = prev !== '' && !/[\d/]/.test(prev) && /\p{L}/u.test(next);
    if (br) { out.push(w.slice(s, i + 1)); s = i + 1; }
  }
  out.push(w.slice(s));
  return out;
}
/** Inline-Inhalt → Elemente: text (s, w, sp = zusammenfassbarer Leerraum, brk = Umbruch danach erlaubt, soft = nur im Notfall),
 *  br, mark (Innenabstand/Rahmen eines Inline-Elements), atom (inline-block, SVG). intr: Messmodus für Mindest-/Höchstbreite. */
function inlineItems(nodes, box, cw, L, intr) {
  const items = [];
  let sp = true;   // vorher zusammenfassbarer Leerraum oder Zeilenanfang
  const text = (node, chain) => {
    const st = node.parent.style, ws = st.whiteSpace, wrap = ws !== 'nowrap' && ws !== 'pre';
    let t = node.text;
    if (ws === 'normal' || ws === 'nowrap') t = t.replace(/[ \t\n\f\r]+/g, ' ');
    else if (ws === 'pre-line') t = t.replace(/[ \t\f\r]+/g, ' ').replace(/ ?\n ?/g, '\n');
    else t = t.replace(/\r/g, '').replace(/[\t\f]/g, ' ');   // pre/pre-wrap: Tabulator als ein Leerzeichen (vereinfacht)
    t = applyTransform(t, st.textTransform);
    const re = /\n| +|[^ \n]+/g;
    let m;
    while ((m = re.exec(t))) {
      const s = m[0];
      if (s === '\n') { items.push({ t: 'br', st, chain }); sp = true; continue; }
      if (s[0] === ' ') {
        if (collapsible(ws)) {
          if (!sp) items.push({ t: 'text', s: ' ', st, chain, w: measure(' ', st, L), sp: true, brk: wrap, soft: !wrap });
        } else items.push({ t: 'text', s, st, chain, w: measure(s, st, L), sp: ws === 'pre-wrap', brk: ws === 'pre-wrap' });
        sp = true;
        continue;
      }
      const parts = wrap ? wordParts(s) : [s];
      parts.forEach((p, k) => items.push({ t: 'text', s: p, st, chain, w: measure(p, st, L), brk: k < parts.length - 1 }));
      sp = false;
    }
  };
  const elem = (el, chain) => {
    const st = el.style;
    if (st.display === 'none' || (el.ns === 'html' && HIDDEN_TAGS.has(el.tag))) return;
    if (el.ns === 'html' && el.tag === 'br') { items.push({ t: 'br', st, chain: [...chain, el] }); sp = true; return; }
    if (el.ns === 'html' && el.tag === 'wbr') { items.push({ t: 'text', s: '', st, chain, w: 0, brk: true }); return; }
    if (el.ns !== 'html' || st.display !== 'inline') {   // Atom: inline-block, inline-table, inline-flex, SVG
      if (items.length) items[items.length - 1].brk = true;
      if (intr) { const I = intrinsic(el, L); items.push({ t: 'atom', el, st, chain, w: I.max + I.mh, wmin: I.min + I.mh, brk: true }); }
      else { const f = layoutBox(el, cw, L, { shrink: true }); items.push({ t: 'atom', el, f, st, chain, w: f.w + auto0(f.fr.ml) + auto0(f.fr.mr), brk: true }); }
      sp = false;
      return;
    }
    const ch = [...chain, el], fr = frame(st, cw);
    const l = auto0(fr.ml) + fr.bl + fr.pl, r = auto0(fr.mr) + fr.br + fr.pr;
    if (fr.bt || fr.br || fr.bb || fr.bl) L.warn(`Rahmen an Inline-Element <${el.tag}> wird nicht gezeichnet`);
    if (l) items.push({ t: 'mark', st, chain: ch, w: l });
    for (const c of el.children) if (c.type === 'text') text(c, ch); else if (c.type === 'element') elem(c, ch);
    if (r) items.push({ t: 'mark', st, chain: ch, w: r });
  };
  for (const n of nodes) { const ch = inlineChain(n, box); if (n.type === 'text') text(n, ch); else elem(n, ch); }
  return items;
}
/** Mindest- (längstes unteilbares Stück) und Höchstbreite (längste Zeile ohne Umbruch) von Inline-Inhalt */
function inlineMinMax(items) {
  let min = 0, max = 0, line = 0, lt = 0, seg = 0, st = 0;
  for (const it of items) {
    if (it.t === 'br') { max = Math.max(max, line - lt); min = Math.max(min, seg - st); line = lt = seg = st = 0; continue; }
    if (it.t === 'atom') { min = Math.max(min, seg - st, it.wmin); seg = st = 0; line += it.w; lt = 0; continue; }
    line += it.w; lt = it.sp ? lt + it.w : it.t === 'mark' ? lt : 0;
    seg += it.w; st = it.sp ? st + it.w : it.t === 'mark' ? st : 0;
    if (it.brk) { min = Math.max(min, seg - st); seg = st = 0; }
  }
  return { min: Math.max(min, seg - st), max: Math.max(max, line - lt) };
}
const clusterEnds = (s) => { const b = [0], re = /\P{M}\p{M}*/gu; let m; while ((m = re.exec(s))) b.push(m.index + m[0].length); return b; };
/** Notumbruch: längster Anfang (ganze Zeichen) von it.s, der in room passt → Länge in UTF-16-Einheiten.
 *  Breiten sind additiv (keine Unterschneidung) — Zeichen für Zeichen aufsummieren, auch riesige Wörter in linearer Zeit. */
function fitPrefix(it, room, L) {
  const re = /\P{M}\p{M}*/gu;
  let w = 0, end = 0, m;
  while ((m = re.exec(it.s))) {
    L.step();
    w += measure(m[0], it.st, L);
    if (w > room + 0.01) break;
    end = m.index + m[0].length;
  }
  return end;
}
function splitItem(items, j, k, L) {
  const it = items[j], a = it.s.slice(0, k), wa = measure(a, it.st, L);
  items.splice(j, 1, { ...it, s: a, w: wa, brk: true }, { ...it, s: it.s.slice(k), w: Math.max(0, it.w - wa) });
}

/** Zeilenumbruch (gierig wie der Browser) → Zeilen-Kästen { kind: 'line', w, h, base, runs (Textläufe), kids (Atome), keepPrev } */
function buildLines(items, cw, st, L) {
  const raw = [];
  let i = 0;
  while (i < items.length) {
    while (i < items.length && items[i].sp) i++;
    if (i >= items.length) break;
    let w = 0, trail = 0, last = -1, soft = -1, end = -1, forced = false;
    for (let j = i; j < items.length; j++) {
      L.step();
      const it = items[j];
      if (it.t === 'br') { end = j + 1; forced = true; break; }
      w += it.w;
      trail = it.sp ? trail + it.w : it.t === 'mark' ? trail : 0;
      if (w - trail > cw + 0.01) {
        if (last >= i) { end = last + 1; break; }
        if (soft >= i) { end = soft + 1; break; }   // nowrap passt nicht: lieber an Leerraum umbrechen als über den Rand
        if (it.t === 'text' && !it.sp && it.s) {
          const k = fitPrefix(it, cw - (w - it.w), L);
          if (k > 0 && k < it.s.length) { splitItem(items, j, k, L); end = j + 1; break; }
          if (k >= it.s.length) { end = j + 1; break; }
          if (j > i) { end = j; break; }
          const one = /^\P{M}\p{M}*/u.exec(it.s)[0].length;
          if (one < it.s.length) splitItem(items, j, one, L);
          end = j + 1;
          break;
        }
        end = j > i ? j : j + 1;
        break;
      }
      if (it.brk) last = j; else if (it.soft) soft = j;
    }
    if (end < 0) end = items.length;
    const parts = items.slice(i, forced ? end - 1 : end);
    for (let k = parts.length - 1; k >= 0; k--) { if (parts[k].sp) parts.splice(k, 1); else if (parts[k].t !== 'mark') break; }
    if (forced || parts.some((p) => p.t === 'atom' || (p.t === 'text' && p.s))) raw.push({ parts, forced, br: forced ? items[end - 1] : null });
    i = end;
  }
  const n = raw.length;
  return raw.map((r, k) => {
    const ln = finishLine(r, cw, st, L, k === n - 1);
    if (k > 0) ln.keepPrev = !(k >= st.orphans && n - k >= st.widows);   // Schusterjunge/Hurenkind
    return ln;
  });
}
const SPACES = /[ \u00a0]/g;
/** Grundlinienversatz eines Inline-Kastens gegenüber dem Elternkasten (nach oben positiv) */
function vaShift(s, ps, L) {
  const va = s.verticalAlign;
  if (va === 'baseline') return 0;
  if (typeof va === 'number') return va;
  if (va && va.pct !== undefined) return va.pct / 100 * vmetrics(s, L).lh;
  if (va === 'sub') return -(ps.fontSize / 5 + 1);
  if (va === 'super') return ps.fontSize / 3 + 1;
  const m = vmetrics(s, L), pm = vmetrics(ps, L);
  if (va === 'middle') return pm.fc.xh * ps.fontSize / 2 - (m.a - m.d) / 2;
  if (va === 'text-top' || va === 'top') return pm.A - m.a;       // top/bottom vereinfacht wie text-top/text-bottom
  if (va === 'text-bottom' || va === 'bottom') return m.d - pm.D;
  return 0;
}
function finishLine({ parts, forced, br }, cw, st, L, isLast) {
  let x = 0;
  const out = parts.map((p) => { const q = { ...p, x }; x += p.w; return q; });
  const lw = x, ta = st.textAlign;
  let off = 0, extra = 0;
  if (ta === 'right') off = cw - lw; else if (ta === 'center') off = (cw - lw) / 2;
  else if (ta === 'justify' && !forced && !isLast && lw < cw) {
    const n = sum(out.map((p) => (p.t === 'text' ? (p.s.match(SPACES) || []).length : 0)));
    if (n) extra = (cw - lw) / n;
  }
  off = Math.max(0, off);
  x = off;
  for (const p of out) {
    p.x = x;
    if (extra && p.t === 'text') { const n = (p.s.match(SPACES) || []).length; p.w += n * extra; p.ws = extra; }
    x += p.w;
  }
  // Höhe: Strebe des Blocks + jeder Inline-Kasten auf der Zeile, alle auf gemeinsamer Grundlinie (vertical-align)
  const strut = vmetrics(st, L), shifts = new Map();
  let up = strut.a, down = strut.d;
  const shift = (chain) => {
    let s = 0, ps = st;
    for (const el of chain) {
      let v = shifts.get(el);
      if (v === undefined) {
        v = s + vaShift(el.style, ps, L);
        shifts.set(el, v);
        const m = vmetrics(el.style, L);
        up = Math.max(up, m.a + v); down = Math.max(down, m.d - v);
      }
      s = v; ps = el.style;
    }
    return s;
  };
  for (const p of out) {
    p.dy = shift(p.chain);
    if (p.t === 'atom') {
      const f = p.f, mt = auto0(f.fr.mt), mb = auto0(f.fr.mb);
      const ps = p.chain.length ? p.chain[p.chain.length - 1].style : st;
      p.dy += vaShift(p.el.style, ps, L);
      const asc = mt + (f.kind === 'svg' || f.base1 == null ? f.h : f.base1), desc = f.h + mt + mb - asc;
      up = Math.max(up, asc + p.dy); down = Math.max(down, desc - p.dy);
      p.asc = asc;
    }
  }
  if (br) shift(br.chain);
  const base = up, kids = [];
  for (const p of out) if (p.t === 'atom') { p.f.x = p.x + auto0(p.f.fr.ml); p.f.y = base - p.dy - p.asc + auto0(p.f.fr.mt); kids.push(p.f); }
  // gleichartige Textstücke zu einem Lauf zusammenfassen (weniger Operatoren, gleiche Breite — die Breiten sind additiv)
  const runs = [];
  for (const p of out) {
    if (p.t !== 'text' || !p.s) continue;
    const r = runs[runs.length - 1];
    if (r && r.st === p.st && r.dy === p.dy && (r.ws || 0) === (p.ws || 0) && r.chain.length === p.chain.length
      && r.chain.every((e, k) => e === p.chain[k]) && Math.abs(r.x + r.w - p.x) < 1e-6) { r.s += p.s; r.w += p.w; }
    else runs.push({ s: p.s, x: p.x, w: p.w, st: p.st, dy: p.dy, ws: p.ws || 0, chain: p.chain });
  }
  return { kind: 'line', x: 0, y: 0, w: cw, h: up + down, base, runs, kids, st, keepPrev: false };
}
function anonBlock(nodes, box, cw, L) {
  const lines = buildLines(inlineItems(nodes, box, cw, L, false), cw, box.style, L);
  let y = 0;
  for (const ln of lines) { ln.y = y; y += ln.h; }
  const last = lines[lines.length - 1];
  return { kind: 'anon', el: null, st: box.style, x: 0, y: 0, w: cw, h: y, ml: 0, mr: 0, mt: M0, mb: M0, through: !lines.length, kids: lines,
    base0: lines.length ? lines[0].base : null, base1: last ? last.y + last.base : null };
}

// ---- Eigenbreiten (Mindest-/Höchstbreite, Rahmenkasten ohne Außenabstand; mh = waagrechte Außenabstände) ----
function intrinsic(el, L) {
  let r = L.intr.get(el);
  if (r) return r;
  L.step();
  const st = el.style, fr = frame(st, null);
  const hz = fr.pl + fr.pr + fr.bl + fr.br, cb = st.boxSizing === 'content-box' ? hz : 0;
  const mh = auto0(fr.ml) + auto0(fr.mr);
  let min, max;
  if (isSvg(el)) min = max = svgBox(el, null).w + hz;
  else if (isTable(st.display)) ({ min, max } = tableIntrinsic(el, L));
  else {
    const w = lenOf(st.width, null);
    if (w != null) min = max = w + cb;
    else { const c = isFlex(st.display) ? flexIntrinsic(el, L) : flowIntrinsic(el, L); min = c.min + hz; max = c.max + hz; }
    const mx = lenOf(st.maxWidth, null), mn = lenOf(st.minWidth, null);
    if (mx != null) { min = Math.min(min, mx + cb); max = Math.min(max, mx + cb); }
    if (mn != null) { min = Math.max(min, mn + cb); max = Math.max(max, mn + cb); }
  }
  L.intr.set(el, r = { min, max, mh });
  return r;
}
function flowIntrinsic(el, L) {
  let min = 0, max = 0;
  for (const e of flowEntries(el, L)) {
    const I = e.el ? intrinsic(e.el, L) : { ...inlineMinMax(inlineItems(e.nodes, el, 0, L, true)), mh: 0 };
    min = Math.max(min, I.min + I.mh); max = Math.max(max, I.max + I.mh);
  }
  return { min, max };
}
const fitContent = (el, avail, L) => { const I = intrinsic(el, L); return Math.min(Math.max(I.min, avail), I.max); };

// ---- Block ----
function layoutBox(el, cbW, L, o = {}) {
  L.step();
  if (isSvg(el)) return layoutSvg(el, cbW, L, o);
  if (isTable(el.style.display)) return layoutTable(el, cbW, L, o);
  return layoutBlock(el, cbW, L, o);
}
/** o: { width (Rahmenkasten vorgegeben: Flex-Element, Zelle), shrink (inline-block), bfc, cell ([o, r, u, l] halbe Rahmen bei collapse) } */
function layoutBlock(el, cbW, L, o = {}) {
  const st = el.style, fr = frame(st, cbW, o.cell);
  let w, ml, mr;
  if (o.width != null) { w = o.width; ml = auto0(fr.ml); mr = auto0(fr.mr); }
  else ({ w, ml, mr } = blockWidth(st, fr, cbW, o.shrink || st.display === 'inline-block' || st.display === 'inline-flex' ? (a) => fitContent(el, a, L) : null));
  const cw = Math.max(0, w - fr.pl - fr.pr - fr.bl - fr.br);
  const flex = isFlex(st.display);
  const bfc = !!(o.bfc || o.cell || o.width != null || flex || st.display === 'flow-root' || INLINE_LEVEL.has(st.display) || !el.parent || el.parent.type !== 'element');
  const hSpec = lenOf(st.height, null) != null || (lenOf(st.minHeight, null) ?? 0) > 0;
  const ctop = !bfc && fr.bt === 0 && fr.pt === 0, cbot = !bfc && fr.bb === 0 && fr.pb === 0 && !hSpec;
  const c = flex ? layoutFlex(el, st, cw, L) : layoutFlow(el, cw, L, ctop, cbot);
  for (const k of c.kids) { k.x += fr.bl + fr.pl; k.y += fr.bt + fr.pt; }
  const h = heightOf(st, fr, c.h);
  const off = fr.bt + fr.pt;
  const f = { kind: 'block', el, st, fr, x: 0, y: 0, w, h, ml, mr, kids: c.kids,
    mt: ctop ? mMerge(mOf(auto0(fr.mt)), c.mtEsc) : mOf(auto0(fr.mt)), mb: cbot ? mMerge(mOf(auto0(fr.mb)), c.mbEsc) : mOf(auto0(fr.mb)),
    through: ctop && cbot && c.through && h === 0, base0: c.base0 != null ? c.base0 + off : null, base1: c.base1 != null ? c.base1 + off : null };
  if (flex && st.flexDirection.startsWith('row')) f.isUnit = true;   // Flex-Zeile: wird nie geteilt
  if (st.display === 'list-item') listMarker(f, el, L);
  return f;
}
/** Blöcke untereinander mit zusammenfallenden Außenabständen (Geschwister, Eltern/erstes und letztes Kind, leere Blöcke) */
function layoutFlow(el, cw, L, ctop, cbot) {
  const kids = [];
  let y = 0, pend = M0, escaping = ctop, mtEsc = M0, base0 = null, base1 = null;
  for (const e of flowEntries(el, L)) {
    const f = e.el ? layoutBox(e.el, cw, L) : anonBlock(e.nodes, el, cw, L);
    pend = mMerge(pend, f.mt);
    f.x = auto0(f.ml);
    kids.push(f);
    if (f.through) { pend = mMerge(pend, f.mb); f.y = y; continue; }
    if (escaping) { mtEsc = pend; f.y = y; escaping = false; } else f.y = y + mVal(pend);
    y = f.y + f.h;
    pend = f.mb;
    if (base0 == null && f.base0 != null) base0 = f.y + f.base0;
    if (f.base1 != null) base1 = f.y + f.base1;
  }
  if (escaping) return { kids, h: 0, mtEsc: pend, mbEsc: pend, through: true, base0, base1 };
  return cbot ? { kids, h: y, mtEsc, mbEsc: pend, through: false, base0, base1 } : { kids, h: y + mVal(pend), mtEsc, mbEsc: M0, through: false, base0, base1 };
}

// ---- Listen-Marken (außen, links neben der ersten Zeile) ----
function listMarker(f, el, L) {
  const st = el.style, type = st.listStyleType;
  if (type === 'none') return;
  if (st.listStylePosition === 'inside') L.warn('list-style-position: inside wird wie outside gesetzt');
  const text = type === 'disc' || type === 'circle' || type === 'square' ? null : `${markerText(type, ordinal(el))}. `;
  const firstLine = (g) => { if (g.kind === 'line') return g; for (const k of g.kids) { const r = firstLine(k); if (r) return r; } return null; };
  f.marker = { type, text, line: firstLine(f), st };
}
function ordinal(li) {
  const p = li.parent;
  const start = p && p.tag === 'ol' && /^\s*-?\d+\s*$/.test(p.attrs.start ?? '') ? parseInt(p.attrs.start, 10) : 1;
  let k = start - 1;
  for (const c of p.children) {
    if (c.type !== 'element' || c.style.display !== 'list-item') continue;
    k = /^\s*-?\d+\s*$/.test(c.attrs.value ?? '') ? parseInt(c.attrs.value, 10) : k + 1;
    if (c === li) break;
  }
  return k;
}
function markerText(type, n) {
  const seq = (abc) => { let s = ''; for (let k = n; k > 0; k = Math.floor((k - 1) / abc.length)) s = abc[(k - 1) % abc.length] + s; return s; };
  if (type === 'decimal-leading-zero') return (n >= 0 && n < 10 ? '0' : '') + n;
  if (n < 1) return String(n);
  if (type === 'lower-alpha') return seq('abcdefghijklmnopqrstuvwxyz');
  if (type === 'upper-alpha') return seq('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  if (type === 'lower-greek') return seq('αβγδεζηθικλμνξοπρστυφχψω');
  if ((type === 'lower-roman' || type === 'upper-roman') && n < 4000) {
    let s = '', k = n;
    for (const [v, r] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]) while (k >= v) { s += r; k -= v; }
    return type === 'upper-roman' ? s.toUpperCase() : s;
  }
  return String(n);
}

// ---- Tabelle (automatisches Spaltenlayout wie Chrome/CSS Tables 3, colspan, border-collapse) ----
const BRANK = { hidden: 9, double: 8, solid: 7, dashed: 6, dotted: 5, ridge: 4, outset: 3, groove: 2, inset: 1, none: 0 };
const SIDE = { top: 'Top', right: 'Right', bottom: 'Bottom', left: 'Left' };
const edgeOf = (s, side, o) => { const S = SIDE[side], sty = s[`border${S}Style`]; return { w: s[`border${S}Width`], s: sty, c: s[`border${S}Color`], o }; };
// Gewinner zweier Kanten (CSS 2.1 §17.6.2.1): hidden > breiter > Stilrang > Zelle/Zeile/Gruppe/Tabelle > oben/links
const winEdge = (a, b) => (!a ? b : !b ? a : a.s === 'hidden' ? a : b.s === 'hidden' ? b : a.w !== b.w ? (a.w > b.w ? a : b)
  : BRANK[a.s] !== BRANK[b.s] ? (BRANK[a.s] > BRANK[b.s] ? a : b) : b.o > a.o ? b : a);
const realEdge = (e) => (e && e.s !== 'hidden' && e.w > 0 ? e : null);
function tableModel(el, L) {
  let T = L.tm.get(el);
  if (T) return T;
  const st = el.style, collapse = st.borderCollapse === 'collapse';
  const heads = [], bodies = [], feet = [], caps = [];
  const junk = (c, where) => {
    if (c.type === 'text') { if (/[^ \t\n\f\r]/.test(c.text)) throw fail('UNSUPPORTED', `Text direkt in ${where} wird nicht unterstützt`); return true; }
    return c.type !== 'element' || c.style.display === 'none' || (c.ns === 'html' && HIDDEN_TAGS.has(c.tag));
  };
  const rowsOf = (g) => g.children.filter((c) => {
    if (junk(c, `<${g.tag}>`)) return false;
    if (c.style.display !== 'table-row') throw fail('UNSUPPORTED', `<${c.tag}> (display:${c.style.display}) in <${g.tag}> wird nicht unterstützt`);
    return true;
  });
  let loose = null;
  for (const c of el.children) {
    if (junk(c, '<table>')) continue;
    const d = c.style.display;
    if (d === 'table-column' || d === 'table-column-group') { if (lenOf(c.style.width, 1) != null || c.attrs.width) L.warn('Spaltenbreiten aus <col>/<colgroup> werden nicht ausgewertet'); continue; }
    if (d === 'table-row') { if (!loose) bodies.push(loose = { el: null, rows: [] }); loose.rows.push(c); continue; }
    loose = null;
    if (d === 'table-header-group') heads.push({ el: c, rows: rowsOf(c) });
    else if (d === 'table-row-group') bodies.push({ el: c, rows: rowsOf(c) });
    else if (d === 'table-footer-group') feet.push({ el: c, rows: rowsOf(c) });
    else if (d === 'table-caption') caps.push(c);
    else throw fail('UNSUPPORTED', `<${c.tag}> (display:${d}) direkt in <table> wird nicht unterstützt`);
  }
  const rows = [];
  for (const g of [...heads, ...bodies, ...feet]) for (const tr of g.rows) {
    const cells = [];
    let col = 0;
    for (const c of tr.children) {
      if (junk(c, '<tr>')) continue;
      if (c.style.display !== 'table-cell') throw fail('UNSUPPORTED', `<${c.tag}> (display:${c.style.display}) in <tr> wird nicht unterstützt`);
      if (parseInt(c.attrs.rowspan, 10) > 1) throw fail('UNSUPPORTED', 'rowspan (Zelle über mehrere Zeilen) wird nicht unterstützt');
      const span = Math.min(1000, Math.max(1, parseInt(c.attrs.colspan, 10) || 1));
      cells.push({ el: c, col, span });
      col += span;
    }
    rows.push({ el: tr, g, cells, n: col, head: heads.includes(g) });
  }
  const C = Math.max(0, ...rows.map((r) => r.n)), R = rows.length;
  const at = rows.map((r) => { const a = Array(C).fill(null); for (const c of r.cells) for (let k = 0; k < c.span; k++) a[c.col + k] = c; return a; });
  let hE = null, vE = null, tb, half = null;
  if (collapse) {
    hE = Array.from({ length: R + 1 }, () => Array(C).fill(null));
    vE = Array.from({ length: R }, () => Array(C + 1).fill(null));
    for (let r = 0; r <= R; r++) for (let c = 0; c < C; c++) {
      let e = null;
      if (r > 0) {
        const up = rows[r - 1], cu = at[r - 1][c];
        if (cu) e = winEdge(e, edgeOf(cu.el.style, 'bottom', 4));
        e = winEdge(e, edgeOf(up.el.style, 'bottom', 3));
        if (up.g.el && (r === R || rows[r].g !== up.g)) e = winEdge(e, edgeOf(up.g.el.style, 'bottom', 2));
      }
      if (r < R) {
        const dn = rows[r], cd = at[r][c];
        if (cd) e = winEdge(e, edgeOf(cd.el.style, 'top', 4));
        e = winEdge(e, edgeOf(dn.el.style, 'top', 3));
        if (dn.g.el && (r === 0 || rows[r - 1].g !== dn.g)) e = winEdge(e, edgeOf(dn.g.el.style, 'top', 2));
      }
      if (r === 0) e = winEdge(e, edgeOf(st, 'top', 1));
      if (r === R) e = winEdge(e, edgeOf(st, 'bottom', 1));
      hE[r][c] = realEdge(e);
    }
    for (let r = 0; r < R; r++) for (let c = 0; c <= C; c++) {
      const lc = c > 0 ? at[r][c - 1] : null, rc = c < C ? at[r][c] : null;
      if (lc && lc === rc) continue;
      let e = null;
      if (lc) e = winEdge(e, edgeOf(lc.el.style, 'right', 4));
      if (rc) e = winEdge(e, edgeOf(rc.el.style, 'left', 4));
      if (c === 0 || c === C) {
        const side = c === 0 ? 'left' : 'right';
        e = winEdge(e, edgeOf(rows[r].el.style, side, 3));
        if (rows[r].g.el) e = winEdge(e, edgeOf(rows[r].g.el.style, side, 2));
        e = winEdge(e, edgeOf(st, side, 1));
      }
      vE[r][c] = realEdge(e);
    }
    const w2 = (e) => (e ? e.w / 2 : 0);
    half = new Map();
    rows.forEach((row, r) => row.cells.forEach((c) => {
      let t = 0, b = 0;
      for (let k = c.col; k < c.col + c.span; k++) { t = Math.max(t, w2(hE[r][k])); b = Math.max(b, w2(hE[r + 1][k])); }
      half.set(c, [t, w2(vE[r][c.col + c.span]), b, w2(vE[r][c.col])]);
    }));
    tb = [Math.max(0, ...(hE[0] || []).map(w2)), Math.max(0, ...vE.map((v) => w2(v[C]))), Math.max(0, ...(hE[R] || []).map(w2)), Math.max(0, ...vE.map((v) => w2(v[0])))];
  } else tb = [st.borderTopWidth, st.borderRightWidth, st.borderBottomWidth, st.borderLeftWidth];
  // Spalten: Mindest-/Höchstbreite aus den Zellen (Rahmenkasten), feste Breiten, Prozentbreiten
  const colMin = Array(C).fill(0), colMax = Array(C).fill(0), colFix = Array(C).fill(null), colPct = Array(C).fill(null);
  const cellI = (c) => {
    const s = c.el.style, fr = frame(s, null, half ? half.get(c) : null), hz = fr.pl + fr.pr + fr.bl + fr.br;
    const I = flowIntrinsic(c.el, L), w = lenOf(s.width, null);
    return { min: I.min + hz, max: I.max + hz, fix: w != null ? w + (s.boxSizing === 'content-box' ? hz : 0) : null, pct: s.width && s.width.pct !== undefined ? s.width.pct : null };
  };
  const spanned = [];
  for (const row of rows) for (const c of row.cells) {
    const I = cellI(c);
    if (c.span > 1) { spanned.push([c, I]); continue; }
    colMin[c.col] = Math.max(colMin[c.col], I.min); colMax[c.col] = Math.max(colMax[c.col], I.max);
    if (I.fix != null) colFix[c.col] = Math.max(colFix[c.col] ?? 0, I.fix);
    if (I.pct != null) colPct[c.col] = Math.max(colPct[c.col] ?? 0, I.pct);
  }
  if (spanned.some(([, I]) => I.pct != null)) L.warn('Prozentbreite an einer Zelle über mehrere Spalten wird nicht ausgewertet');
  for (let c = 0; c < C; c++) if (colFix[c] != null) { colMin[c] = Math.max(colMin[c], Math.min(colFix[c], colMax[c])); colMax[c] = Math.max(colMin[c], colFix[c]); }
  const hs = collapse ? 0 : st.borderSpacing[0], vs = collapse ? 0 : st.borderSpacing[1];
  spanned.sort((a, b) => a[0].span - b[0].span);
  for (const [c, I] of spanned) {
    const idx = Array.from({ length: c.span }, (_, k) => c.col + k);
    for (const [arr, need] of [[colMin, I.min], [colMax, Math.max(I.max, I.min)]]) {
      const have = sum(idx.map((k) => arr[k])) + (c.span - 1) * hs;
      if (need <= have) continue;
      const weights = idx.map((k) => colMax[k]), tw = sum(weights);
      idx.forEach((k, n) => { arr[k] += (need - have) * (tw > 0 ? weights[n] / tw : 1 / c.span); });
    }
    for (const k of idx) colMax[k] = Math.max(colMax[k], colMin[k]);
  }
  L.tm.set(el, T = { rows, C, collapse, hE, vE, half, tb, colMin, colMax, colFix, colPct, hs, vs, caps });
  return T;
}
/** Waagrechte Zugaben der Tabelle (Rahmen, Innenabstand, Zellabstände) bei Prozent-Bezug cbW */
function tableExtras(T, st, cbW) {
  if (T.collapse) return { ex: T.tb[1] + T.tb[3], pad: [0, 0, 0, 0] };
  const p = (v) => lenOf(v, cbW) ?? 0, pad = [p(st.paddingTop), p(st.paddingRight), p(st.paddingBottom), p(st.paddingLeft)];
  return { ex: T.tb[1] + T.tb[3] + pad[1] + pad[3] + (T.C ? (T.C + 1) * T.hs : 0), pad };
}
function tableIntrinsic(el, L) {
  const T = tableModel(el, L), st = el.style, { ex } = tableExtras(T, st, null);
  let min = sum(T.colMin) + ex, max = sum(T.colMax) + ex;
  const w = lenOf(st.width, null);
  if (w != null) min = max = Math.max(min, w + (st.boxSizing === 'content-box' ? ex : 0));
  return { min, max };
}
/** Breite auf die Spalten verteilen (CSS Tables 3 wie Chrome): Prozentspalten bekommen ihren Anteil (mindestens ihre
 *  Mindestbreite), der Rest geht an die übrigen — zwischen Mindest- und Höchstbreite linear, darüber im Verhältnis der
 *  Höchstbreiten (nur Spalten ohne feste Breite, wenn es welche gibt) */
function distribute(min, max, fix, pct, avail) {
  const n = min.length, P = [...Array(n).keys()].filter((c) => pct[c] != null);
  if (P.length) {
    const rest = [...Array(n).keys()].filter((c) => pct[c] == null), out = Array(n).fill(0);
    let want = P.map((c) => Math.max(min[c], pct[c] / 100 * avail)), sw = sum(want);
    const pMin = sum(P.map((c) => min[c])), room = Math.max(pMin, avail - sum(rest.map((c) => min[c])));
    if (sw > room) { const f = sw > pMin ? (room - pMin) / (sw - pMin) : 0; want = P.map((c, k) => min[c] + (want[k] - min[c]) * f); sw = sum(want); }
    P.forEach((c, k) => { out[c] = want[k]; });
    if (rest.length) { const sub = distribute(rest.map((c) => min[c]), rest.map((c) => max[c]), rest.map((c) => fix[c]), rest.map(() => null), avail - sw); rest.forEach((c, k) => { out[c] = sub[k]; }); }
    else if (avail > sw) P.forEach((c, k) => { out[c] += (avail - sw) * (sw > 0 ? want[k] / sw : 1 / P.length); });
    return out;
  }
  const sMin = sum(min), sMax = sum(max);
  if (avail >= sMax) {
    const autos = [...Array(n).keys()].filter((c) => fix[c] == null), pool = autos.length ? autos : [...Array(n).keys()];
    const tot = sum(pool.map((c) => max[c])), out = max.slice();
    for (const c of pool) out[c] += (avail - sMax) * (tot > 0 ? max[c] / tot : 1 / pool.length);
    return out;
  }
  if (sMax - sMin < 1e-9) return min.slice();
  const t = Math.max(0, (avail - sMin) / (sMax - sMin));
  return min.map((m, c) => m + (max[c] - m) * t);
}
function layoutTable(el, cbW, L, o = {}) {
  const T = tableModel(el, L), st = el.style, fr = frame(st, cbW, T.tb), { ex, pad } = tableExtras(T, st, cbW);
  const sMin = sum(T.colMin) + ex, sMax = sum(T.colMax) + ex;
  let w, ml, mr;
  if (o.width != null) { w = Math.max(o.width, sMin); ml = auto0(fr.ml); mr = auto0(fr.mr); }
  else {
    const fr2 = { ...fr, pl: 0, pr: 0, bl: 0, br: 0 };   // Tabellen: Breite immer als Rahmenkasten (UA: box-sizing border-box)
    let tw = lenOf(st.width, cbW);
    if (tw != null && st.boxSizing === 'content-box') tw += ex - (T.C ? (T.C + 1) * T.hs : 0);
    ({ w, ml, mr } = blockWidth({ ...st, width: tw ?? 'auto', boxSizing: 'border-box' }, fr2, cbW, (a) => Math.min(a, sMax)));
    if (w < sMin) { w = sMin; ({ ml, mr } = blockWidth({ ...st, width: w, minWidth: 'auto', maxWidth: 'none', boxSizing: 'border-box' }, fr2, cbW, null)); }
  }
  const cols = distribute(T.colMin, T.colMax, T.colFix, T.colPct, w - ex);
  const colX = [];
  let x = T.tb[3] + pad[3] + T.hs;
  for (let c = 0; c < T.C; c++) { colX.push(x); x += cols[c] + T.hs; }
  const colEnd = (c) => colX[c] + cols[c];
  let y = T.tb[0] + pad[0] + (T.rows.length ? T.vs : 0);
  const rowFrags = [];
  T.rows.forEach((row, r) => {
    let rh = lenOf(row.el.style.height, null) ?? 0, rb = 0;
    const cells = row.cells.map((c) => {
      const cw = colEnd(c.col + c.span - 1) - colX[c.col];
      const f = layoutBlock(c.el, cw, L, { width: cw, bfc: true, cell: T.collapse ? T.half.get(c) : null });
      f.kind = 'cell'; f.noBorders = T.collapse;
      const va = c.el.style.verticalAlign;
      f.va = va === 'top' || va === 'middle' || va === 'bottom' ? va : 'baseline';
      f.cb = f.base0 ?? f.h - f.fr.pb - f.fr.bb;   // Grundlinie der Zelle (ohne Zeile: Unterkante des Inhalts)
      if (f.va === 'baseline') rb = Math.max(rb, f.cb);
      rh = Math.max(rh, f.h, lenOf(c.el.style.height, null) ?? 0);
      return [c, f];
    });
    for (const [, f] of cells) if (f.va === 'baseline') rh = Math.max(rh, rb - f.cb + f.h);
    for (const [c, f] of cells) {
      const free = rh - f.h, off = f.va === 'middle' ? free / 2 : f.va === 'bottom' ? free : f.va === 'top' ? 0 : rb - f.cb;
      for (const k of f.kids) k.y += off;
      if (f.base0 != null) f.base0 += off;
      f.h = rh; f.x = colX[c.col]; f.y = 0;
    }
    const x0 = T.C ? colX[0] : 0;
    for (const [, f] of cells) f.x -= x0;
    const rf = { kind: 'row', el: row.el, st: row.el.style, x: x0, y, w: T.C ? colEnd(T.C - 1) - x0 : 0, h: rh, kids: cells.map(([, f]) => f), isUnit: true, segs: [], noBorders: true,
      thOnly: cells.length > 0 && cells.every(([c]) => c.el.tag === 'th'), head: row.head, base0: null };
    for (const [, f] of cells) if (f.va === 'baseline' && f.base0 != null) { rf.base0 = f.base0; break; }
    if (T.collapse) {   // Rahmen der Zellkanten: jede Zeile zeichnet ihre Unterkante (die erste auch die Oberkante) und ihre senkrechten Kanten
      const hx = (c, k) => (T.vE[r][k] ? T.vE[r][k].w / 2 : 0);
      const horiz = (rr, ly) => { for (let c = 0; c < T.C; c++) { const e = T.hE[rr][c]; if (!e) continue; const x0a = colX[c] - (c === 0 ? hx(r, 0) : 0), x1 = colEnd(c) + (c === T.C - 1 ? hx(r, T.C) : 0); rf.segs.push({ x: x0a - x0, y: ly - e.w / 2, w: x1 - x0a, h: e.w, e }); } };
      if (r === 0) horiz(0, 0);
      horiz(r + 1, rh);
      for (let c = 0; c <= T.C; c++) { const e = T.vE[r][c]; if (!e) continue; const gx = c < T.C ? colX[c] : colEnd(T.C - 1); rf.segs.push({ x: gx - e.w / 2 - x0, y: 0, w: e.w, h: rh, e }); }
    }
    rowFrags.push(rf);
    y += rh + T.vs;
  });
  const h = Math.max(y + pad[2] + T.tb[2], lenOf(st.height, null) ?? 0);
  const head = rowFrags.filter((r) => r.head);
  const t = { kind: 'table', el, st, fr, x: 0, y: 0, w, h, ml, mr, kids: rowFrags, noBorders: T.collapse, mt: mOf(auto0(fr.mt)), mb: mOf(auto0(fr.mb)),
    through: false, base0: rowFrags.length && rowFrags[0].base0 != null ? rowFrags[0].y + rowFrags[0].base0 : null, base1: null,
    head, headH: head.length ? head[head.length - 1].y + head[head.length - 1].h - head[0].y : 0 };
  if (!T.caps.length) return t;
  // Tabellenüberschrift (<caption>, oben) über dem Tabellenkasten: Hülle ohne eigenes Aussehen
  let cy = 0;
  const kids = T.caps.map((c) => { const f = layoutBox(c, w, L); f.x = auto0(f.ml); f.y = cy + Math.max(0, mVal(f.mt)); cy = f.y + f.h + Math.max(0, mVal(f.mb)); return f; });
  t.y = cy; t.x = 0;
  kids.push(t);
  const wrap = { kind: 'block', el: null, st, fr: frame({ ...st, marginTop: 0, marginBottom: 0 }, cbW, [0, 0, 0, 0]), x: 0, y: 0, w, h: cy + t.h, ml, mr, kids, mt: t.mt, mb: t.mb,
    through: false, base0: t.base0 != null ? t.base0 + cy : null, base1: null };
  t.ml = t.mr = 0; t.mt = t.mb = M0;
  return wrap;
}

// ---- Flex (eine oder mehrere Zeilen, Spalten) ----
function flexItems(el) {
  const out = [];
  let run = null;
  const close = () => { if (run && run.some(hasInline)) out.push({ nodes: run }); run = null; };
  for (const c of el.children) {
    if (c.type === 'text') { (run ||= []).push(c); continue; }
    if (c.type !== 'element' || c.style.display === 'none' || (c.ns === 'html' && HIDDEN_TAGS.has(c.tag))) continue;
    close();
    out.push({ el: c });
  }
  close();
  return out;
}
const itemIntr = (x, box, L) => (x.el ? intrinsic(x.el, L) : { ...inlineMinMax(inlineItems(x.nodes, box, 0, L, true)), mh: 0 });
function flexIntrinsic(el, L) {
  const st = el.style, row = st.flexDirection.startsWith('row'), items = flexItems(el);
  let min = 0, max = 0;
  for (const x of items) {
    const I = itemIntr(x, el, L), omin = I.min + I.mh, omax = I.max + I.mh;
    if (row) { max += omax; min = st.flexWrap === 'nowrap' ? min + omin : Math.max(min, omin); }
    else { max = Math.max(max, omax); min = Math.max(min, omin); }
  }
  const gap = row && items.length > 1 ? (lenOf(st.columnGap, null) ?? 0) * (items.length - 1) : 0;
  return { min: min + (st.flexWrap === 'nowrap' ? gap : 0), max: max + gap };
}
/** Flexible Längen auflösen (CSS Flexbox §9.7) */
function resolveFlex(line, avail) {
  const grow = sum(line.map((it) => it.hyp)) < avail;
  for (const it of line) { it.target = it.hyp; it.frozen = (grow ? it.grow : it.shrink) === 0 || (grow ? it.basis > it.hyp : it.basis < it.hyp); }
  const initFree = avail - sum(line.map((it) => (it.frozen ? it.target : it.basis)));
  for (let guard = 0; guard <= line.length; guard++) {
    const open = line.filter((it) => !it.frozen);
    if (!open.length) break;
    let free = avail - sum(line.map((it) => (it.frozen ? it.target : it.basis)));
    const sf = sum(open.map((it) => (grow ? it.grow : it.shrink)));
    if (sf < 1 && Math.abs(initFree * sf) < Math.abs(free)) free = initFree * sf;
    const sc = sum(open.map((it) => it.shrink * it.basis));
    for (const it of open) it.target = it.basis + (grow ? (sf > 0 ? free * it.grow / sf : 0) : (sc > 0 ? free * it.shrink * it.basis / sc : 0));
    let viol = 0;
    for (const it of open) { const c = Math.max(it.mn, Math.min(it.mx, it.target)); it.v = c - it.target; viol += it.v; it.target = c; }
    if (Math.abs(viol) < 1e-9) break;
    for (const it of open) if (viol > 0 ? it.v > 0 : it.v < 0) it.frozen = true;
  }
}
function layoutFlex(el, st, cw, L) {
  const row = st.flexDirection.startsWith('row'), rev = st.flexDirection.endsWith('reverse');
  let items = flexItems(el).map((x) => {
    const s = x.el ? x.el.style : st, fr = x.el ? frame(s, cw) : frame({ ...st, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0 }, cw, [0, 0, 0, 0]);
    return { x, s, fr, as: !x.el || s.alignSelf === 'auto' ? st.alignItems : s.alignSelf };
  });
  if (rev) items = items.reverse();
  const kids = [];
  if (!row) {   // Spalte: untereinander, Breite gestreckt oder passend zum Inhalt
    const gap = lenOf(st.rowGap, cw) ?? 0;
    let y = 0;
    items.forEach((it, k) => {
      const { x, s, fr } = it, mh = auto0(fr.ml) + auto0(fr.mr);
      let f;
      if (x.el && lenOf(s.width, cw) != null) f = layoutBox(x.el, cw, L);
      else {
        const W = it.as === 'stretch' || it.as === 'normal' ? cw - mh : (() => { const I = itemIntr(x, el, L); return Math.min(Math.max(I.min, cw - mh), I.max); })();
        f = x.el ? layoutBox(x.el, cw, L, { width: W }) : anonBlock(x.nodes, el, W, L);
      }
      const free = cw - f.w - mh;
      f.x = it.as === 'flex-end' || it.as === 'end' || it.as === 'self-end' ? auto0(fr.ml) + free : it.as === 'center' ? auto0(fr.ml) + free / 2 : auto0(fr.ml);
      if (fr.ml === 'auto' && fr.mr === 'auto') f.x = Math.max(0, (cw - f.w) / 2); else if (fr.ml === 'auto') f.x = cw - f.w - auto0(fr.mr);
      y += (k ? gap : 0) + auto0(fr.mt);
      f.y = y;
      y += f.h + auto0(fr.mb);
      kids.push(f);
    });
    const b0 = kids.find((f) => f.base0 != null);
    return { kids, h: y, mtEsc: M0, mbEsc: M0, through: false, base0: b0 ? b0.y + b0.base0 : null, base1: null };
  }
  const gap = lenOf(st.columnGap, cw) ?? 0, rgap = lenOf(st.rowGap, cw) ?? 0;
  for (const it of items) {
    const { x, s, fr } = it, I = itemIntr(x, el, L);
    const hz = fr.pl + fr.pr + fr.bl + fr.br, cb = s.boxSizing === 'content-box' ? hz : 0, wv = x.el ? lenOf(s.width, cw) : null;
    const fb = x.el ? s.flexBasis : 'auto';
    it.basis = fb === 'auto' ? (wv != null ? wv + cb : I.max) : fb === 'content' ? I.max : (lenOf(fb, cw) ?? I.max - cb) + cb;
    it.mn = !x.el || s.minWidth === 'auto' ? (wv != null ? Math.min(wv + cb, I.min) : I.min) : (lenOf(s.minWidth, cw) ?? 0) + cb;
    const mx = x.el ? lenOf(s.maxWidth, cw) : null;
    it.mx = mx != null ? mx + cb : Infinity;
    it.mn = Math.max(it.mn, hz);
    it.hyp = Math.max(it.mn, Math.min(it.mx, it.basis));
    it.mh = auto0(fr.ml) + auto0(fr.mr);
    it.grow = x.el ? s.flexGrow : 0; it.shrink = x.el ? s.flexShrink : 1;
  }
  const lines = [];
  if (st.flexWrap === 'nowrap') lines.push(items);
  else {
    let cur = [], used = 0;
    for (const it of items) {
      const o = it.hyp + it.mh;
      if (cur.length && used + gap + o > cw + 0.01) { lines.push(cur); cur = []; used = 0; }
      used += (cur.length ? gap : 0) + o;
      cur.push(it);
    }
    if (cur.length) lines.push(cur);
  }
  let ly = 0, base0 = null;
  lines.forEach((line, li) => {
    resolveFlex(line, cw - gap * (line.length - 1) - sum(line.map((it) => it.mh)));
    for (const it of line) it.f = it.x.el ? layoutBox(it.x.el, cw, L, { width: it.target }) : anonBlock(it.x.nodes, el, it.target, L);
    // Hauptachse: automatische Außenabstände, dann justify-content (nur bei freiem Platz)
    let free = cw - sum(line.map((it) => it.f.w + it.mh)) - gap * (line.length - 1);
    const autos = sum(line.map((it) => (it.fr.ml === 'auto') + (it.fr.mr === 'auto')));
    let start = 0, between = gap, autoEach = 0;
    if (free > 0 && autos) { autoEach = free / autos; free = 0; }
    if (free > 0) {
      const jc = st.justifyContent, n = line.length;
      if (jc === 'flex-end' || jc === 'end' || jc === 'right') start = free;
      else if (jc === 'center') start = free / 2;
      else if (jc === 'space-between') { if (n > 1) between += free / (n - 1); }
      else if (jc === 'space-around') { start = free / (2 * n); between += free / n; }
      else if (jc === 'space-evenly') { start = free / (n + 1); between += free / (n + 1); }
    }
    let x = start;
    for (const it of line) {
      x += it.fr.ml === 'auto' ? autoEach : it.fr.ml;
      it.f.x = rev ? cw - x - it.f.w : x;
      x += it.f.w + (it.fr.mr === 'auto' ? autoEach : it.fr.mr) + between;
    }
    // Querachse: Zeilenhöhe, align-items/align-self
    const outer = (it) => it.f.h + auto0(it.fr.mt) + auto0(it.fr.mb);
    const cross = Math.max(0, ...line.map(outer));
    const bl = line.filter((it) => it.as === 'baseline' && it.f.base0 != null);
    const maxB = Math.max(0, ...bl.map((it) => auto0(it.fr.mt) + it.f.base0));
    for (const it of line) {
      const { f, fr, as } = it, mt = auto0(fr.mt), mb = auto0(fr.mb);
      let yy = mt;
      if ((as === 'stretch' || as === 'normal') && it.x.el && it.s.height === 'auto' && fr.mt !== 'auto' && fr.mb !== 'auto') f.h = Math.max(f.h, heightOf(it.s, f.fr, cross - mt - mb - (f.fr.pt + f.fr.pb + f.fr.bt + f.fr.bb)));
      else if (as === 'flex-end' || as === 'end' || as === 'self-end') yy = cross - f.h - mb;
      else if (as === 'center') yy = mt + (cross - mt - mb - f.h) / 2;
      else if (as === 'baseline' && f.base0 != null) yy = maxB - f.base0;
      f.y = ly + yy;
      if (base0 == null && f.base0 != null) base0 = f.y + f.base0;
      kids.push(f);
    }
    ly += cross + (li < lines.length - 1 ? rgap : 0);
  });
  return { kids, h: ly, mtEsc: M0, mbEsc: M0, through: false, base0, base1: null };
}

// ---- Inline-SVG (Pfade als Vektor) ----
function svgBox(el, cbW) {
  const st = el.style, fr = frame(st, cbW);
  const vb = String(el.attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
  const ok = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  const hz = fr.pl + fr.pr + fr.bl + fr.br, vz = fr.pt + fr.pb + fr.bt + fr.bb, bb = st.boxSizing === 'border-box';
  let w = lenOf(st.width, cbW), h = lenOf(st.height, null);
  if (w != null && bb) w -= hz;
  if (h != null && bb) h -= vz;
  const ratio = ok ? vb[2] / vb[3] : null;
  if (w == null && h == null) { w = 300; h = ratio ? w / ratio : 150; }
  else if (w == null) w = ratio ? h * ratio : 300;
  else if (h == null) h = ratio ? w / ratio : 150;
  return { w: Math.max(0, w), h: Math.max(0, h), vb: ok ? vb : null, fr };
}
function layoutSvg(el, cbW, L) {
  const b = svgBox(el, cbW), fr = b.fr, st = el.style;
  const w = b.w + fr.pl + fr.pr + fr.bl + fr.br, h = b.h + fr.pt + fr.pb + fr.bt + fr.bb;
  let ml = auto0(fr.ml), mr = auto0(fr.mr);
  if (!INLINE_LEVEL.has(st.display)) {
    const free = cbW - w - ml - mr;
    if (fr.ml === 'auto' && fr.mr === 'auto') ml = Math.max(0, free) / 2; else if (fr.ml === 'auto') ml = free;
  }
  svgShapes(el, [1, 0, 0, 1, 0, 0], null, [], L);   // vorab prüfen (wirft bei nicht unterstützten Elementen)
  return { kind: 'svg', el, st, fr, x: 0, y: 0, w, h, ml, mr, mt: mOf(auto0(fr.mt)), mb: mOf(auto0(fr.mb)), through: false, kids: [], isUnit: true, box: b, base0: null, base1: null };
}
const mmul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
function svgTransform(t) {
  let m = [1, 0, 0, 1, 0, 0];
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let k, rest = t;
  while ((k = re.exec(t))) {
    const a = k[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (a.some((v) => !Number.isFinite(v))) throw fail('UNSUPPORTED', `SVG-transform „${t}“ nicht verstanden`);
    const r = (deg) => deg * Math.PI / 180;
    const n = { matrix: () => a.length === 6 && a, translate: () => [1, 0, 0, 1, a[0], a[1] ?? 0], scale: () => [a[0], 0, 0, a[1] ?? a[0], 0, 0],
      rotate: () => { const c = Math.cos(r(a[0])), s = Math.sin(r(a[0])), [cx = 0, cy = 0] = a.slice(1); return mmul(mmul([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]); },
      skewX: () => [1, 0, Math.tan(r(a[0])), 1, 0, 0], skewY: () => [1, Math.tan(r(a[0])), 0, 1, 0, 0] }[k[1]]();
    if (!n) throw fail('UNSUPPORTED', `SVG-transform „${t}“ nicht verstanden`);
    m = mmul(m, n);
    rest = rest.replace(k[0], '');
  }
  if (/[^\s,]/.test(rest)) throw fail('UNSUPPORTED', `SVG-transform „${t}“ nicht verstanden`);
  return m;
}
/** SVG-Kinder → [{ d, m (Matrix in Nutzerkoordinaten), fill, stroke, sw, rule }] */
function svgShapes(node, m, inh, out, L) {
  inh ||= { fill: '#000', stroke: 'none', sw: '1', rule: 'nonzero', color: node.style.color };
  for (const c of node.children) {
    if (c.type === 'text') { if (/\S/.test(c.text)) throw fail('UNSUPPORTED', 'Text in SVG wird nicht unterstützt'); continue; }
    if (c.type !== 'element' || SVG_QUIET.has(c.tag)) continue;
    const a = c.attrs;
    if (a.display === 'none' || a.visibility === 'hidden') continue;
    for (const k of ['opacity', 'fill-opacity', 'stroke-opacity']) if (a[k] !== undefined && Number(a[k]) < 1) L.warn(`SVG: ${k} wird nicht unterstützt (deckend gezeichnet)`);
    if (a.style !== undefined) L.warn('SVG: style-Attribute werden nicht ausgewertet');
    const mm = a.transform ? mmul(m, svgTransform(a.transform)) : m;
    const s = { fill: a.fill ?? inh.fill, stroke: a.stroke ?? inh.stroke, sw: a['stroke-width'] ?? inh.sw, rule: a['fill-rule'] ?? inh.rule, color: inh.color };
    if (c.tag === 'g' || c.tag === 'a') { svgShapes(c, mm, s, out, L); continue; }
    if (!SVG_SHAPES.has(c.tag)) throw fail('UNSUPPORTED', `SVG-Element <${c.tag}> wird nicht unterstützt`);
    const n = (k, d = 0) => { const v = a[k] === undefined ? d : Number(String(a[k]).replace(/px$/, '')); if (!Number.isFinite(v)) throw fail('UNSUPPORTED', `SVG <${c.tag} ${k}="${a[k]}"> nicht verstanden`); return v; };
    let d;
    if (c.tag === 'path') d = a.d || '';
    else if (c.tag === 'rect') {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      let rx = a.rx !== undefined ? n('rx') : a.ry !== undefined ? n('ry') : 0, ry = a.ry !== undefined ? n('ry') : rx;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      d = rx > 0 && ry > 0 ? `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
        : `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
    } else if (c.tag === 'circle' || c.tag === 'ellipse') {
      const cx = n('cx'), cy = n('cy'), rx = c.tag === 'circle' ? n('r') : n('rx'), ry = c.tag === 'circle' ? rx : n('ry');
      d = `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    } else if (c.tag === 'line') d = `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    else { const p = String(a.points || '').trim(); d = p ? `M${p}${c.tag === 'polygon' ? 'Z' : ''}` : ''; }
    out.push({ d, m: mm, ...s });
  }
  return out;
}
function svgPaint(f, page, X, Y, P) {
  const b = f.box, [vx, vy, vw, vh] = b.vb || [0, 0, b.w, b.h];
  if (!(b.w > 0 && b.h > 0 && vw > 0 && vh > 0)) return;
  const par = String(f.el.attrs.preserveAspectRatio || 'xMidYMid meet').trim();
  let sx = b.w / vw, sy = b.h / vh, tx = 0, ty = 0;
  if (par !== 'none') {
    const s = /slice/.test(par) ? Math.max(sx, sy) : Math.min(sx, sy), al = /^x(Min|Mid|Max)Y(Min|Mid|Max)/.exec(par) || [0, 'Mid', 'Mid'];
    const k = { Min: 0, Mid: 0.5, Max: 1 };
    tx = (b.w - vw * s) * k[al[1]]; ty = (b.h - vh * s) * k[al[2]]; sx = sy = s;
  }
  const base = [sx * PT, 0, 0, sy * PT, (X + tx - vx * sx) * PT, (Y + ty - vy * sy) * PT];
  const color = (v, what) => {
    if (v == null || v === 'none') return null;
    const c = String(v).trim().toLowerCase() === 'currentcolor' ? f.st.color : parseColor(v);
    if (!Array.isArray(c)) throw fail('UNSUPPORTED', `SVG: ${what}="${v}" wird nicht unterstützt`);
    return c[3] === 0 ? null : pdfColor(c);
  };
  page.save();
  page.clip(X * PT, Y * PT, b.w * PT, b.h * PT);
  for (const s of svgShapes(f.el, [1, 0, 0, 1, 0, 0], null, [], P.L)) {
    if (!s.d.trim()) continue;
    const m = mmul(base, s.m), fill = color(s.fill, 'fill'), stroke = color(s.stroke, 'stroke');
    const o = { transform: m };
    if (fill) { o.fill = fill; o.fillRule = s.rule === 'evenodd' ? 'evenodd' : 'nonzero'; }
    if (stroke) { const sw = Number(String(s.sw).replace(/px$/, '')); if (sw > 0) { o.stroke = stroke; o.lineWidth = sw * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])); } }
    if (o.fill || o.stroke) page.path(s.d, o);
  }
  page.restore();
}

// ---- Umbrucheinheiten und Seitenumbruch ----
const visible = (c) => Array.isArray(c) && (c.length === 3 || c[3] > 0);
const pdfColor = (c) => (c.length === 3 || c[3] >= 1 ? [c[0] / 255, c[1] / 255, c[2] / 255] : [0, 1, 2].map((k) => (c[k] * c[3] + 255 * (1 - c[3])) / 255));   // halbtransparent: auf Weiß gemischt
function hasDeco(f) {
  const s = f.st;
  if (!f.el || !s || f.kind === 'line' || f.kind === 'anon') return false;
  return visible(s.backgroundColor) || (!f.noBorders && (s.borderTopWidth > 0 || s.borderRightWidth > 0 || s.borderBottomWidth > 0 || s.borderLeftWidth > 0));
}
/** Lage festlegen (ax/ay) und Umbrucheinheiten in Dokumentreihenfolge sammeln (E = null: nur Lage) */
function place(f, ox, oy, E) {
  f.ax = ox + f.x; f.ay = oy + f.y;
  if (!E) { for (const k of f.kids) place(k, f.ax, f.ay, null); return; }
  const el = f.el, st = f.st;
  if (el && st.breakBefore === 'page') E.force = Math.min(E.force ?? Infinity, f.ay - Math.max(0, mVal(f.mt)));   // nach erzwungenem Umbruch bleibt der Außenabstand
  else if (el && st.breakBefore === 'avoid') E.keep = true;
  let chunk = false;
  if (!E.chunk && el && f.h <= E.H && f.kind !== 'row' && (st.breakInside === 'avoid' || (f.kind === 'table' && f.h <= E.H / 3) || (hasDeco(f) && f.h <= E.H / 3))) {
    E.chunk = f; E.first = true; chunk = true;   // kleine Tabellen und umrahmte/hinterlegte Kästen bleiben zusammen
  }
  if (f.kind === 'table' && f.head.length) E.tabs.push(f);
  if (f.isUnit || f.kind === 'line') {
    if (f.h > E.H + 0.5) throw fail('LAYOUT', `${label(f)} ist höher als eine Seite (${Math.round(f.h)} px) und lässt sich nicht teilen`);
    emit(E, f);
    for (const k of f.kids) place(k, f.ax, f.ay, null);
  } else {
    const n = E.units.length;
    for (const k of f.kids) place(k, f.ax, f.ay, E);
    if (E.units.length === n && f.h > 0 && hasDeco(f)) {
      if (f.h > E.H + 0.5) throw fail('LAYOUT', `${label(f)} ist höher als eine Seite`);
      f.isUnit = true; emit(E, f);
    }
  }
  if (chunk) E.chunk = null;
  if (f.kind === 'table' && f.head.length) E.tabs.pop();
  if (el && (/^h[1-6]$/.test(el.tag) || st.breakAfter === 'avoid' || (f.kind === 'row' && (f.thOnly || f.head)))) E.keep = true;   // Überschrift/Kopfzeile nie allein am Seitenende
  if (el && st.breakAfter === 'page') E.force = f.ay + f.h;
}
const label = (f) => (f.kind === 'line' ? 'eine Textzeile' : f.el ? `<${f.el.tag}${f.el.attrs.class ? '.' + f.el.attrs.class.trim().split(/\s+/).join('.') : ''}>` : 'ein Kasten');
function emit(E, f) {
  const u = { top: f.ay, bottom: f.ay + f.h, breakY: f.ay, keepPrev: !!f.keepPrev, forced: false, f };
  const tab = E.tabs[E.tabs.length - 1];
  if (f.kind === 'row' && !f.head && tab && tab.kids.includes(f)) u.tab = tab;   // Zeile einer Tabelle mit <thead>
  if (E.chunk) { if (E.first) { u.breakY = Math.min(u.top, E.chunk.ay); E.first = false; } else u.keepPrev = true; }
  if (E.keep) { u.keepPrev = true; E.keep = false; }
  if (E.force != null) { u.forced = true; u.breakY = Math.min(u.top, E.force); E.force = null; }
  E.units.push(u);
}
/** Seitenumbruch: läuft eine Einheit über das Seitenende, wird sie (oder die erste Einheit ihrer Kette aus „nicht davor
 *  trennen“) samt allem Folgenden an den Anfang der nächsten Seite geschoben → [{ y (Bahn), d (Verschiebung) }] */
function paginate(U, H, L, maxPages, repeats) {
  const breaks = [];
  let shift = 0, page = 0, first = 0;
  const brk = (j) => {
    const by = Math.max(U[j].breakY + shift, page * H), pb = Math.floor((by + 0.01) / H), tab = U[j].tab;
    const rep = tab && tab.headH < H / 3 && U[j].bottom - U[j].top + tab.headH <= H ? tab.headH : 0;   // <thead> oben auf der neuen Seite wiederholen
    const d = (pb + 1) * H - by + rep;
    if (rep) repeats.push({ tab, p: pb + 1 });
    breaks.push({ y: by - shift, d });
    shift += d; page = pb + 1; first = j;
    if (page >= maxPages) throw fail('TOO_LARGE', `Das Dokument hätte mehr als ${maxPages} Seiten`);
  };
  for (let i = 0; i < U.length; i++) {
    L.step();
    const u = U[i], p = Math.floor((u.top + shift + 0.01) / H);
    if (p > page) { page = p; first = i; if (page >= maxPages) throw fail('TOO_LARGE', `Das Dokument hätte mehr als ${maxPages} Seiten`); }
    const atTop = (k) => U[k].breakY + shift <= page * H + 0.5;
    if (u.forced && i > 0 && !atTop(i)) { brk(i); i--; continue; }
    if (u.bottom + shift > (page + 1) * H + 0.01) {
      let j = i;
      while (j > first && U[j].keepPrev && !U[j].forced) j--;
      if (atTop(j)) j = i;                       // die ganze Seite hängt zusammen: dann doch hier trennen
      if (atTop(j)) throw fail('LAYOUT', `${label(u.f)} passt auf keine Seite`);
      brk(j);
      i = j - 1;
    }
  }
  return breaks;
}

// ---- Zeichnen ----
function shiftAt(P, y, strict) { let s = 0; for (const b of P.breaks) if (strict ? b.y < y - 1e-6 : b.y <= y + 1e-6) s += b.d; return s; }
const pageOf = (P, y) => Math.max(0, Math.floor((y + 0.01) / P.H));
function pageAt(P, p) {
  if (p >= P.maxPages) throw fail('TOO_LARGE', `Das Dokument hätte mehr als ${P.maxPages} Seiten`);
  while (P.pages.length <= p) {
    const pg = P.doc.addPage({ width: P.pg.width * PT, height: P.pg.height * PT });
    if (P.canvas) pg.rect(0, 0, pg.width, pg.height, { fill: P.canvas });   // Hintergrund von html/body füllt das ganze Blatt
    P.pages.push(pg);
  }
  return P.pages[p];
}
/** Lage eines Punktes der Bahn (mit Verschiebung) → { page, X, Y } in px auf dem Blatt */
function onPage(P, x, y, anchor = y) { const p = pageOf(P, anchor); return { page: pageAt(P, p), p, X: P.pg.margin[3] + x, Y: P.pg.margin[0] + y - p * P.H }; }
function checkBox(P, what, X, Y, w, h) {
  const t = 0.5;
  if (X < -t || Y < -t || X + w > P.pg.width + t || Y + h > P.pg.height + t) P.errs.push(`${what} ragt über die Seite (${X.toFixed(1)}, ${Y.toFixed(1)}, ${w.toFixed(1)} × ${h.toFixed(1)} px)`);
}
function radii(st, w, h) {
  const r = (v) => (typeof v === 'number' ? v : v && v.pct !== undefined ? v.pct / 100 * Math.min(w, h) : 0);
  return [r(st.borderTopLeftRadius), r(st.borderTopRightRadius), r(st.borderBottomRightRadius), r(st.borderBottomLeftRadius)];
}
/** Rahmenseite als Fläche (durchgezogen), Linie (gestrichelt/gepunktet) oder zwei Flächen (doppelt) */
function edge(page, x, y, w, h, e) {
  const col = pdfColor(e.c), horiz = w >= h, t = horiz ? h : w;
  if (e.s === 'dashed' || e.s === 'dotted') {
    const d = e.s === 'dashed' ? [3 * t * PT, 3 * t * PT] : [t * PT, t * PT];
    if (horiz) page.line(x * PT, (y + h / 2) * PT, (x + w) * PT, (y + h / 2) * PT, { color: col, width: t * PT, dash: d });
    else page.line((x + w / 2) * PT, y * PT, (x + w / 2) * PT, (y + h) * PT, { color: col, width: t * PT, dash: d });
  } else if (e.s === 'double' && t >= 3) {
    const k = t / 3;
    if (horiz) { page.rect(x * PT, y * PT, w * PT, k * PT, { fill: col }); page.rect(x * PT, (y + h - k) * PT, w * PT, k * PT, { fill: col }); }
    else { page.rect(x * PT, y * PT, k * PT, h * PT, { fill: col }); page.rect((x + w - k) * PT, y * PT, k * PT, h * PT, { fill: col }); }
  } else page.rect(x * PT, y * PT, w * PT, h * PT, { fill: col });
}
/** Hintergrund und Rahmen eines Kastens (ein Stück je Seite: Oberkante nur auf der ersten, Unterkante nur auf der letzten) */
function decorate(f, sh, P) {
  if (!hasDeco(f) || f.st.visibility !== 'visible') return;
  const pieces = [];
  if (sh != null) { const a = f.ay + sh, p = pageOf(P, a); pieces.push([p, a - p * P.H, a - p * P.H + f.h, true, true]); }
  else {
    const a = f.ay + shiftAt(P, f.ay, false), b = f.ay + f.h + shiftAt(P, f.ay + f.h, true);
    const p0 = pageOf(P, a), p1 = Math.max(p0, Math.floor((b - 0.01) / P.H));
    for (let p = p0; p <= p1; p++) pieces.push([p, p === p0 ? a - p * P.H : 0, p === p1 ? b - p * P.H : P.H, p === p0, p === p1]);
  }
  const st = f.st;
  for (const [p, y0, y1, first, last] of pieces) {
    if (y1 - y0 < 0.01 && !(first && last)) continue;
    const page = pageAt(P, p), X = P.pg.margin[3] + f.ax, Y = P.pg.margin[0] + y0, w = f.w, h = y1 - y0;
    checkBox(P, label(f), X, Y, w, h);
    const rad = radii(st, f.w, f.h);
    if (!first) rad[0] = rad[1] = 0;
    if (!last) rad[2] = rad[3] = 0;
    const round = rad.some((r) => r > 0.01), R = rad.map((r) => r * PT);
    if (visible(st.backgroundColor)) page.rect(X * PT, Y * PT, w * PT, h * PT, round ? { fill: pdfColor(st.backgroundColor), radius: R } : { fill: pdfColor(st.backgroundColor) });
    if (f.noBorders) continue;
    const b = ['Top', 'Right', 'Bottom', 'Left'].map((S) => ({ w: st[`border${S}Width`], s: st[`border${S}Style`], c: st[`border${S}Color`] }));
    if (!first) b[0] = null;
    if (!last) b[2] = null;
    const on = (e) => e && e.w > 0 && visible(e.c);
    const same = b.every((e) => on(e) && e.w === b[0].w && e.s === b[0].s && e.c.join() === b[0].c.join());
    if (round && same && (b[0].s === 'solid' || b[0].s === 'dashed' || b[0].s === 'dotted')) {
      const bw = b[0].w, o = { stroke: pdfColor(b[0].c), lineWidth: bw * PT, radius: rad.map((r) => Math.max(0, r - bw / 2) * PT) };
      if (b[0].s !== 'solid') o.dash = b[0].s === 'dashed' ? [3 * bw * PT, 3 * bw * PT] : [bw * PT, bw * PT];
      page.rect((X + bw / 2) * PT, (Y + bw / 2) * PT, (w - bw) * PT, (h - bw) * PT, o);
      continue;
    }
    if (round && b.some((e, k) => on(e) && (rad[k] > 0.01 || rad[(k + 1) % 4] > 0.01))) P.L.warn(`${label(f)}: Rahmen an runden Ecken vereinfacht (eckig gezeichnet)`);
    if (on(b[0])) edge(page, X, Y, w, b[0].w, b[0]);
    if (on(b[2])) edge(page, X, Y + h - b[2].w, w, b[2].w, b[2]);
    if (on(b[3])) edge(page, X, Y, b[3].w, h, b[3]);
    if (on(b[1])) edge(page, X + w - b[1].w, Y, b[1].w, h, b[1]);
  }
}
function resolveHref(href, base, L) {
  const h = String(href || '').trim();
  if (!h || h.startsWith('#') || /^javascript:/i.test(h)) return null;
  try { return new URL(h, base || undefined).href; } catch { L.warn(`Verweis „${h}“ ist relativ – ohne baseUrl nicht anklickbar`); return null; }
}
function paintLine(f, sh, P) {
  const { page, X, Y } = onPage(P, f.ax, f.ay + sh), L = P.L, links = new Map();
  const cl = P.pg.margin[3], cr = P.pg.width - P.pg.margin[1];
  for (const r of f.runs) {
    if (r.st.visibility !== 'visible') continue;
    const st = r.st, fc = fontFor(st), base = Y + f.base - r.dy, x = X + r.x;
    for (const el of r.chain) if (visible(el.style.backgroundColor)) {   // Hintergrund eines Inline-Elements (z. B. <mark>)
      const m = vmetrics(el.style, L);
      page.rect(x * PT, (base - m.A) * PT, r.w * PT, (m.A + m.D) * PT, { fill: pdfColor(el.style.backgroundColor) });
    }
    try { page.text(r.s, x * PT, base * PT, { ...textOpts(st, fc), color: pdfColor(st.color), wordSpacing: r.ws * PT }); } catch (e) { throw withText(e, r.s); }
    if (!P.copy) P.drawn.push(r.s);
    if (r.x < -0.5 || r.x + r.w > f.w + 0.5) P.errs.push(`Text „${r.s.slice(0, 40)}“ ragt aus seinem Kasten (${r.x.toFixed(1)}…${(r.x + r.w).toFixed(1)} von ${f.w.toFixed(1)} px)`);
    if (x < cl - 0.5 || x + r.w > cr + 0.5) P.errs.push(`Text „${r.s.slice(0, 40)}“ ragt über den Seitenrand`);
    checkBox(P, `Text „${r.s.slice(0, 40)}“`, x, Y, r.w, f.h);
    for (const d of st.textDecorations) {   // Unterstreichung, Durchstreichung, Überstreichung
      if (!visible(d.color)) continue;
      const fs = st.fontSize, t = Math.max(1, (d.line === 'line-through' ? fc.sow : fc.ulw) * fs);
      const y = d.line === 'underline' ? base + fc.ul * fs : d.line === 'line-through' ? base - fc.so * fs - t / 2 : base - vmetrics(st, L).A;
      edge(page, x, y, r.w, t, { s: d.style === 'dashed' || d.style === 'dotted' || d.style === 'double' ? d.style : 'solid', c: d.color });
      if (d.style === 'wavy') L.warn('Wellenlinie (text-decoration-style: wavy) wird als gerade Linie gezeichnet');
    }
    const a = r.chain.findLast((e) => e.tag === 'a' && e.ns === 'html' && e.attrs.href !== undefined);
    if (a) { const g = links.get(a) || [x, x + r.w]; g[0] = Math.min(g[0], x); g[1] = Math.max(g[1], x + r.w); links.set(a, g); }
  }
  for (const [a, [x0, x1]] of links) {
    const url = resolveHref(a.attrs.href, P.baseUrl, L);
    if (!url) continue;
    try { page.link(x0 * PT, Y * PT, (x1 - x0) * PT, f.h * PT, url); } catch (e) { if (e.code === 'BAD_LINK') L.warn(`Verweis „${a.attrs.href}“ ist im PDF nicht anklickbar (nur http/https/mailto/tel)`); else throw e; }
  }
}
function paintMarker(f, P) {
  const m = f.marker, st = m.st, ln = m.line, L = P.L;
  if (st.visibility !== 'visible') return;
  const xr = f.ax + f.fr.bl + f.fr.pl;
  const y0 = ln ? ln.ay : f.ay + f.fr.bt + f.fr.pt, sh = shiftAt(P, y0, false);
  const { page, Y, X } = onPage(P, xr, y0 + sh), base = Y + (ln ? ln.base : vmetrics(st, L).a), col = pdfColor(st.color), fs = st.fontSize;
  if (m.text) {
    const w = measure(m.text, st, L);
    page.text(m.text, (X - w) * PT, base * PT, { ...textOpts(st, fontFor(st)), color: col });
    checkBox(P, 'Listen-Marke', X - w, base - fs, w, fs);
    return;
  }
  // Punkt/Kreis/Quadrat wie Chrome: Größe und Lage aus der (gerundeten) Oberlänge der Schrift
  const A = vmetrics(st, L).A, o = Math.floor(A * 2 / 3), bw = Math.floor((o + 1) / 2), x0 = X - o - 7, y0b = base - A + Math.floor(3 * (A - o) / 2);
  if (m.type === 'square') page.rect(x0 * PT, y0b * PT, bw * PT, bw * PT, { fill: col });
  else if (m.type === 'circle') page.rect((x0 + 0.5) * PT, (y0b + 0.5) * PT, (bw - 1) * PT, (bw - 1) * PT, { stroke: col, lineWidth: PT, radius: (bw - 1) / 2 * PT });
  else page.rect(x0 * PT, y0b * PT, bw * PT, bw * PT, { fill: col, radius: bw / 2 * PT });
  checkBox(P, 'Listen-Marke', x0, y0b, bw, bw);
}
function paint(f, sh, P) {
  if ((f.isUnit || f.kind === 'line') && sh == null) sh = shiftAt(P, f.ay, false);
  decorate(f, sh, P);
  if (f.kind === 'line') paintLine(f, sh, P);
  else if (f.kind === 'svg' && f.st.visibility === 'visible') {
    const { page, X, Y } = onPage(P, f.ax + f.fr.bl + f.fr.pl, f.ay + f.fr.bt + f.fr.pt + sh, f.ay + sh);
    checkBox(P, label(f), X, Y, f.box.w, f.box.h);
    svgPaint(f, page, X, Y, P);
  }
  if (f.segs && f.st.visibility === 'visible') for (const s of f.segs) {   // Rahmen bei border-collapse
    const { page, X, Y } = onPage(P, f.ax + s.x, f.ay + s.y + sh, f.ay + sh);
    edge(page, X, Y, s.w, s.h, s.e);
  }
  for (const k of f.kids) paint(k, sh, P);
  if (f.marker) paintMarker(f, P);
}

// ---- Hauptaufruf ----
const PDF_OPTS = ['createdAt', 'author', 'subject', 'keywords', 'creator', 'pageFooter', 'baseUrl', 'strict', 'maxPages'];
/**
 * Satz ohne Zeichnen (für htmlToPdf, Tests und Fehlersuche): HTML → { tree (styleTree), top (Kasten von <html>, Lage in CSS-px
 * auf der endlosen Bahn: ax/ay, w, h, kids …), units (Umbrucheinheiten), breaks ([{ y, d }] Verschiebungen), repeats, page,
 * pages (Seitenzahl), warnings }. opts: { maxPages = 60 }. Wirft PdfError wie htmlToPdf.
 */
export function layoutDocument(html, opts = {}) {
  if (typeof html !== 'string') throw fail('BAD_TEXT', 'htmlToPdf: HTML als Text erwartet');
  if (html.length > LIMIT.bytes) throw fail('TOO_LARGE', `HTML zu groß (${html.length} Zeichen, höchstens ${LIMIT.bytes})`);
  const maxPages = opts.maxPages ?? LIMIT.pages;
  if (!(Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= 1000)) throw fail('BAD_OPTION', 'maxPages: ganze Zahl 1–1000');
  const warnings = [];
  const root = parseHtml(html, warnings);
  // harte Grenzen vor allem Weiteren (rekursive Schritte, Laufzeit)
  let count = 0;
  for (const stack = [[root, 0]]; stack.length;) {
    const [n, d] = stack.pop();
    if (d > LIMIT.depth) throw fail('TOO_LARGE', `HTML zu tief verschachtelt (mehr als ${LIMIT.depth} Ebenen)`);
    for (const c of n.children || []) if (c.type === 'element') { if (++count > LIMIT.elements) throw fail('TOO_LARGE', `HTML hat zu viele Elemente (mehr als ${LIMIT.elements})`); stack.push([c, d + 1]); }
  }
  const t = computeStyles(root, { media: 'print', warnings });
  const L = { warn: dedupe(warnings), mc: new Map(), vm: new WeakMap(), intr: new WeakMap(), fe: new WeakMap(), tm: new WeakMap(), steps: 0, t0: performance.now() };
  L.step = () => {
    if (++L.steps > LIMIT.steps) throw fail('TOO_LARGE', 'Satz zu aufwendig (Schrittgrenze erreicht)');
    if ((L.steps & 1023) === 0 && performance.now() - L.t0 > LIMIT.ms) throw fail('TOO_LARGE', 'Satz dauert zu lange (Zeitgrenze erreicht)');
  };
  // sichtbare Elemente prüfen: Bilder/Formularfelder → Fehler, unbekannte Tags → Warnung (werden mit ihrem Text gesetzt)
  (function check(el) {
    for (const c of el.children) {
      if (c.type !== 'element' || c.style.display === 'none' || c.ns !== 'html' || HIDDEN_TAGS.has(c.tag)) continue;
      if (UNSUPPORTED_EL.has(c.tag)) throw fail('UNSUPPORTED', `<${c.tag}> ist im Druck sichtbar, kann im PDF aber nicht gesetzt werden (${/^(img|picture|video|canvas|object|embed|iframe)$/.test(c.tag) ? 'Bild/Einbettung ohne Vektordaten' : 'Formularfeld'})`);
      if (c.tag === 'q' || c.tag === 'details' || c.tag === 'summary' || c.tag === 'ruby') L.warn(`<${c.tag}> wird ohne seine Sonderdarstellung (Anführungszeichen, Aufklappen, Lautschrift) gesetzt`);
      else if (!KNOWN_TAGS.has(c.tag)) L.warn(`unbekanntes Element <${c.tag}> – als ${INLINE_LEVEL.has(c.style.display) ? 'Inline' : 'Block'}-Element mit seinem Text gesetzt`);
      if (c.attrs.dir === 'rtl') L.warn('Schreibrichtung rechts-nach-links wird nicht unterstützt');
      check(c);
    }
  })(t.root);
  if (!t.html || !t.body) throw fail('UNSUPPORTED', 'Dokument ohne <html>/<body>');
  const pg = t.page, H = pg.contentHeight;
  const top = layoutBox(t.html, pg.contentWidth, L, { bfc: true });
  top.x = auto0(top.ml); top.y = mVal(top.mt);
  const E = { units: [], H, chunk: null, first: false, keep: false, force: null, tabs: [] }, repeats = [];
  place(top, 0, 0, E);
  const breaks = paginate(E.units, H, L, maxPages, repeats);
  const shiftOf = (y) => sum(breaks.filter((b) => b.y <= y + 1e-6).map((b) => b.d));
  const pages = Math.max(1, ...E.units.map((u) => Math.floor((u.bottom + shiftOf(u.top) - 0.01) / H) + 1));
  return { tree: t, top, units: E.units, breaks, repeats, page: pg, pages, warnings, L, maxPages };
}
/**
 * Fertiges HTML (Beleg, Rechtstext) → PDF wie Chromes „Drucken / als PDF speichern“ (Druck-Stile, @page-Format und -Ränder).
 * opts: createdAt (Date | ms | ISO; ohne Angabe kein Datum in der Datei), author, subject, keywords, creator,
 *   pageFooter = true („Seite n von m“ + Titel im unteren Rand, nur bei mehr als einer Seite), baseUrl (für relative Links),
 *   strict = false (true: jede Warnung bricht mit PdfError UNSUPPORTED ab), maxPages = 60.
 * → { buffer, pages, warnings, text (sichtbarer Text), title }. Wirft PdfError (siehe Kopf von Teil 2) statt einer falschen PDF.
 */
export function htmlToPdf(html, opts = {}) {
  if (opts === null || typeof opts !== 'object') throw fail('BAD_OPTION', 'htmlToPdf: Angaben als Objekt erwartet');
  for (const k in opts) if (!PDF_OPTS.includes(k)) throw fail('BAD_OPTION', `htmlToPdf: unbekannte Angabe „${k}“ (erlaubt: ${PDF_OPTS.join(', ')})`);
  const { tree: t, top, breaks, repeats, page: pg, warnings, L, maxPages } = layoutDocument(html, { maxPages: opts.maxPages });
  const H = pg.contentHeight;
  const lang = String(t.html.attrs.lang || '').trim();
  const doc = new PdfDocument({ title: t.title || undefined, author: opts.author, subject: opts.subject, keywords: opts.keywords, creator: opts.creator,
    lang: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : 'de-DE', createdAt: opts.createdAt });
  const body = t.body?.style, hs = t.html.style;
  const P = { doc, pages: [], pg, H, breaks, drawn: [], errs: [], L, maxPages, baseUrl: opts.baseUrl,
    canvas: visible(hs.backgroundColor) ? pdfColor(hs.backgroundColor) : body && visible(body.backgroundColor) ? pdfColor(body.backgroundColor) : null };
  paint(top, null, P);
  pageAt(P, 0);
  P.copy = true;   // wiederholte Tabellenköpfe: gezeichnet, aber nicht in der Zeichen-Bilanz
  for (const { tab, p } of repeats) for (const r of tab.head) paint(r, p * H - tab.head[0].ay, P);
  P.copy = false;
  // Fußzeile „Seite n von m“ (rechts) und Titel (links) im unteren Seitenrand — nur bei mehr als einer Seite
  if (opts.pageFooter !== false && P.pages.length > 1) {
    const fo = { font: 'Inter-Regular', size: 8, color: '#6b6257' }, mb = pg.margin[2] * PT;
    if (mb < 18) L.warn('Seitenrand unten zu klein für die Fußzeile – ohne Fußzeile gesetzt');
    else P.pages.forEach((page, i) => {
      const lab = `Seite ${i + 1} von ${P.pages.length}`, lw = measureText(lab, fo), base = page.height - mb / 2 + 2.8;
      const xl = pg.margin[3] * PT, xr = page.width - pg.margin[1] * PT;
      page.text(lab, xr - lw, base, fo);
      let title = (t.title || '').trim();
      if (!title || missingChars(title, fo.font).length) return;
      const room = xr - xl - lw - 24;
      if (measureText(title, fo) > room) {
        const cl = clusterEnds(title);
        let k = cl.length - 1;
        while (k > 0 && measureText(title.slice(0, cl[k]).trimEnd() + '…', fo) > room) k--;
        title = k > 0 ? title.slice(0, cl[k]).trimEnd() + '…' : '';
      }
      if (title) page.text(title, xl, base, fo);
    });
  }
  // Selbstprüfung 1: jedes sichtbare Nicht-Leerzeichen des HTML genau so oft gezeichnet
  const text = visibleText(t.root, { transform: true });
  const bal = new Map();
  const count1 = (s, k) => { for (const ch of composeText(s)) if (!/[\s\u00ad\u200b-\u200d\u2060\ufe0e\ufe0f\ufeff]/u.test(ch)) bal.set(ch, (bal.get(ch) || 0) + k); };
  count1(text, 1);
  for (const s of P.drawn) count1(s, -1);
  const off = [...bal].filter(([, n]) => n !== 0);
  if (off.length) throw fail('SELF_CHECK', `Zeichen-Bilanz stimmt nicht: ${off.slice(0, 8).map(([c, n]) => `„${c}“ ${n > 0 ? `${n}× fehlt` : `${-n}× zu viel`}`).join(', ')}`);
  // Selbstprüfung 2: nichts über die Seite, kein Text aus seinem Kasten
  if (P.errs.length) throw fail('SELF_CHECK', `Satz verlässt seinen Rahmen: ${P.errs.slice(0, 3).join('; ')}${P.errs.length > 3 ? ` (+${P.errs.length - 3})` : ''}`);
  if (opts.strict && warnings.length) throw fail('UNSUPPORTED', `Nicht unterstützter Aufbau: ${warnings.join(' · ')}`);
  return { buffer: doc.toBuffer(), pages: P.pages.length, warnings, text, title: t.title };
}
