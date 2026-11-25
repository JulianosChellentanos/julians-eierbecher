// formsam — PDF-Satz für Belege und Rechtstexte: das fertige HTML+CSS (eingeschränkter Umfang) auswerten, umbrechen,
// auf A4-Seiten verteilen und mit lib/pdf.js zeichnen (nur Node-Built-ins).
//
//   import { styleTree, visibleText } from './lib/html-pdf.js';
//   const { root, body, page, title, warnings } = styleTree(html, { media: 'print' });
//   // jedes Element trägt .style mit aufgelösten Werten (Längen in CSS-px, Farben als [r, g, b(, a)] …)
//
// Teil 1 (dieser Abschnitt): HTML einlesen (parseHtml), CSS einlesen (parseCss), Kaskade für den DRUCK wie Chrome
//   (Browser-Grundstil, Spezifität, !important, Vererbung, @media/@page) → computeStyles / styleTree, visibleText.
// Teil 2 (Satz: Zeilen, Tabellen, Flex, Seiten, Zeichnen) baut darauf auf.
// Grundsatz: nie raten — nicht verstandene Selektoren, Werte, Eigenschaften und @-Regeln werden übersprungen und in
// warnings festgehalten; der Aufrufer entscheidet, ob dann lieber keine PDF entsteht. Was bewusst ohne Wirkung bleibt
// (Schatten, Cursor, Übergänge …), steht in IGNORED_PROPS und erzeugt keine Warnung.
//
// Aufbau: 1. Zeichenverweise · 2. HTML-Leser · 3. CSS-Leser (Regeln, @media, @page, Selektoren) · 4. Eigenschaften
//   (Werte prüfen, Kurzschreibweisen) · 5. Kaskade und berechnete Werte · 6. sichtbarer Text

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
// Teil 2: Satz (Zeilen, Tabellen, Flex, Seiten, Zeichnen mit lib/pdf.js) — folgt
// ---------------------------------------------------------------------------
