// formsam — Selbsttest für den PDF-Kern lib/pdf.js (ohne Fremdpakete)
//
//   node tools/test-pdf.mjs                  → eine Zeile je Prüfung; Exit 0 = alles gut, 1 = Fehler
//   node tools/test-pdf.mjs --out <ordner>   → legt die erzeugten Probe-PDFs zusätzlich in <ordner> ab
//
// Die erzeugten Dateien werden mit EIGENEN kleinen Lesern nachgelesen (TrueType-Datei, PDF-Objekte, Inhaltsstrom),
// nicht mit den Funktionen aus lib/pdf.js. pdftotext, pdffonts und pdfinfo (poppler) werden zusätzlich benutzt,
// wenn sie installiert sind — ohne sie entfallen nur diese Prüfungen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import {
  PdfDocument, PdfError, measureText, fontMetrics, missingChars, getFont, findFont, registerFont, parseFont, subsetFont, parseSvgPath, A4, mm,
} from '../lib/pdf.js';

const args = process.argv.slice(2), outAt = args.indexOf('--out'), outDir = outAt >= 0 ? args[outAt + 1] : '';
if (outAt >= 0 && !outDir) { console.error('Aufruf: node tools/test-pdf.mjs [--out <ordner>]'); process.exit(2); }

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
    console.log(`FEHLER  ${name} — ${e instanceof PdfError ? `${e.code}: ` : ''}${e.message}`);
  }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const same = (got, want, msg) => { if (got !== want) throw new Error(`${msg}: ${JSON.stringify(got)} statt ${JSON.stringify(want)}`); };
const near = (got, want, msg, eps = 1e-9) => { if (!(Math.abs(got - want) <= eps)) throw new Error(`${msg}: ${got} statt ${want}`); };
/** fn muss einen PdfError mit genau diesem code werfen; liefert den Fehler */
function fails(code, fn, msg) {
  try { fn(); } catch (e) {
    if (e instanceof PdfError && e.code === code) return e;
    throw new Error(`${msg}: ${e.code || e.name} („${e.message}“) statt ${code}`);
  }
  throw new Error(`${msg}: kein Fehler statt ${code}`);
}
const kb = (n) => `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
const ms = (n) => `${n.toFixed(n < 10 ? 1 : 0).replace('.', ',')} ms`;
const cpsOf = (s) => [...s].map((c) => c.codePointAt(0));

const STAMP = '2026-01-15T09:30:00Z';      // festes Datum — die Uhr kommt in keiner Datei vor
const FONTS = ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold', 'Inter-Bold', 'Fraunces-Medium', 'Fraunces-SemiBold'];
const fontFile = (name) => fs.readFileSync(new URL(`../lib/pdf-fonts/${name}.ttf`, import.meta.url));

// ---------------------------------------------------------------------------
// Eigene Leser: TrueType
// ---------------------------------------------------------------------------
function wordSum(b) {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) sum = (sum + ((b[i] << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))) >>> 0;
  return sum;
}

/** sfnt-Datei zerlegen. strict: zusätzlich alles prüfen, was die eigene Teilmenge einhalten muss */
function readSfnt(buf, strict) {
  ok(buf.readUInt32BE(0) === 0x00010000, 'kein TrueType-Kopf');
  const n = buf.readUInt16BE(4), t = {}, tags = [];
  let end = 12 + n * 16;
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16, tag = buf.latin1Slice(o, o + 4), sum = buf.readUInt32BE(o + 4), at = buf.readUInt32BE(o + 8), len = buf.readUInt32BE(o + 12);
    ok(at + len <= buf.length, `Tabelle ${tag} ragt über das Dateiende`);
    t[tag] = buf.subarray(at, at + len);
    tags.push(tag);
    if (!strict) continue;
    same(at, end, `Tabelle ${tag} liegt nicht lückenlos und auf 4 Byte ausgerichtet`);
    end = at + ((len + 3) & ~3);
    const data = Buffer.from(buf.subarray(at, end));
    if (tag === 'head') data.writeUInt32BE(0, 8);
    same(wordSum(data), sum, `Prüfsumme der Tabelle ${tag}`);
  }
  if (strict) {
    const log = Math.floor(Math.log2(n));
    same(tags.join(','), [...tags].sort().join(','), 'Tabellenverzeichnis nicht sortiert');
    same([buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)].join(','), [16 << log, log, n * 16 - (16 << log)].join(','), 'Suchfelder im Kopf');
    same(end, buf.length, 'Dateilänge');
    same(wordSum(buf), 0xB1B0AFBA, 'Prüfsumme der ganzen Datei (head.checkSumAdjustment)');
    for (const tag of ['glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp']) ok(t[tag], `Tabelle ${tag} fehlt`);
  }
  const num = t.maxp.readUInt16BE(4), long = t.head.readInt16BE(50) === 1, nh = t.hhea.readUInt16BE(34);
  const loca = [];
  for (let i = 0; i <= num; i++) loca.push(long ? t.loca.readUInt32BE(i * 4) : t.loca.readUInt16BE(i * 2) * 2);
  if (strict) {
    ok(long && t.loca.length === (num + 1) * 4, 'loca nicht im langen Format oder falsche Länge');
    ok(nh === num && t.hmtx.length === num * 4, 'hmtx: nicht für jede Glyphe ein voller Eintrag');
    ok(loca.every((v, i) => v % 4 === 0 && (!i || v >= loca[i - 1])) && loca[num] === t.glyf.length, 'loca nicht aufsteigend, nicht ausgerichtet oder nicht bis zum Ende von glyf');
  }
  return {
    tables: t, num, upm: t.head.readUInt16BE(18),
    glyph: (i) => t.glyf.subarray(loca[i], loca[i + 1]),
    advance: (i) => t.hmtx.readUInt16BE(Math.min(i, nh - 1) * 4),
    lsb: (i) => (i < nh ? t.hmtx.readInt16BE(i * 4 + 2) : t.hmtx.readInt16BE(nh * 4 + (i - nh) * 2)),
  };
}

/** Bauteile einer zusammengesetzten Glyphe: [{ at (Stelle der Nummer), gid }] */
function components(g) {
  const list = [];
  if (g.length < 10 || g.readInt16BE(0) >= 0) return list;
  for (let p = 10; ;) {
    const flags = g.readUInt16BE(p);
    list.push({ at: p + 2, gid: g.readUInt16BE(p + 2) });
    p += flags & 1 ? 8 : 6;
    if (flags & 0x08) p += 2; else if (flags & 0x40) p += 4; else if (flags & 0x80) p += 8;
    if (!(flags & 0x20)) return list;
  }
}

/** Windows-Unicode-Tabelle (3,1) im Format 4 → Map Codepunkt → Glyphe; bewusst unabhängig von lib/pdf.js geschrieben */
function cmap4(cmap) {
  let at = -1;
  for (let i = 0; i < cmap.readUInt16BE(2); i++) if (cmap.readUInt16BE(4 + i * 8) === 3 && cmap.readUInt16BE(6 + i * 8) === 1) at = cmap.readUInt32BE(8 + i * 8);
  ok(at >= 0 && cmap.readUInt16BE(at) === 4, 'keine (3,1)-Tabelle im Format 4');
  const x2 = cmap.readUInt16BE(at + 6), map = new Map();
  for (let s = 0; s < x2; s += 2) {
    const end = cmap.readUInt16BE(at + 14 + s), start = cmap.readUInt16BE(at + 16 + x2 + s);
    const delta = cmap.readInt16BE(at + 16 + 2 * x2 + s), roAt = at + 16 + 3 * x2 + s, ro = cmap.readUInt16BE(roAt);
    for (let c = start; c <= end && c !== 0xFFFF; c++) {
      let g = ro ? cmap.readUInt16BE(roAt + ro + 2 * (c - start)) : c;
      if (ro && !g) continue;
      g = (g + delta) & 0xFFFF;
      if (g) map.set(c, g);
    }
  }
  return map;
}

/** Stimmt die Teilmenge Glyphe für Glyphe mit dem Original überein? glyphs[neu] = alte Nummer */
function compareSubset(sub, orig, glyphs) {
  same(sub.num, glyphs.length, 'Glyphenzahl');
  for (let i = 0; i < sub.num; i++) {
    const g = glyphs[i], a = Buffer.from(sub.glyph(i)), b = orig.glyph(g);
    same(sub.advance(i), orig.advance(g), `Vorschub Glyphe ${i}`);
    same(sub.lsb(i), orig.lsb(g), `linker Rand Glyphe ${i}`);
    const parts = components(a), want = components(b);
    same(parts.length, want.length, `Bauteile Glyphe ${i}`);
    parts.forEach((part, j) => {
      ok(part.gid < sub.num, `Bauteil-Verweis ${part.gid} in Glyphe ${i} zeigt ins Leere`);
      same(glyphs[part.gid], want[j].gid, `Bauteil ${j} von Glyphe ${i}`);
      a.writeUInt16BE(want[j].gid, part.at);                         // zurücknummerieren → muss dem Original gleichen
    });
    ok(a.length % 4 === 0 && a.length - b.length < 4 && a.subarray(0, b.length).equals(b) && a.subarray(b.length).every((v) => v === 0), `Umriss Glyphe ${i} weicht vom Original ab`);
  }
}

// ---------------------------------------------------------------------------
// Eigene Leser: PDF
// ---------------------------------------------------------------------------
/** PDF zerlegen und dabei den Dateiaufbau Byte für Byte prüfen → { objs[nr] = { dict, data }, size, id, pages } */
function readPdf(buf) {
  const txt = buf.latin1Slice();
  ok(txt.startsWith('%PDF-1.7\n%') && buf[14] === 10 && [10, 11, 12, 13].every((i) => buf[i] > 127), 'Kopf: %PDF-1.7 und Binärkommentar');
  const tail = /\nstartxref\n(\d+)\n%%EOF\n$/.exec(txt.slice(-48));
  ok(tail, 'Ende: startxref … %%EOF');
  const xref = Number(tail[1]), head = /^xref\n0 (\d+)\n/.exec(txt.slice(xref, xref + 32));
  ok(head, 'startxref zeigt nicht auf „xref“');
  const size = Number(head[1]), first = xref + head[0].length, objs = [null];
  same(txt.slice(first, first + 20), '0000000000 65535 f \n', 'Eintrag 0 der Querverweistabelle');
  let next = 15;
  for (let no = 1; no < size; no++) {
    const m = /^(\d{10}) 00000 n \n$/.exec(txt.slice(first + no * 20, first + no * 20 + 20));
    ok(m, `Eintrag ${no} der Querverweistabelle hat nicht genau 20 Byte in fester Form`);
    const at = Number(m[1]), intro = `${no} 0 obj\n`;
    ok(txt.startsWith(intro, at), `Eintrag ${no} zeigt nicht auf „${no} 0 obj“`);
    same(at, next, `Objekt ${no} beginnt nicht direkt hinter dem vorigen`);
    const p = at + intro.length, plain = txt.indexOf('\nendobj\n', p), st = txt.indexOf('>>\nstream\n', p);
    if (st >= 0 && st < plain) {
      const dict = txt.slice(p, st + 2), len = Number(/\/Length (\d+)/.exec(dict)[1]), from = st + 10;
      same(txt.slice(from + len, from + len + 18), '\nendstream\nendobj\n', `Objekt ${no}: /Length stimmt nicht`);
      const raw = buf.subarray(from, from + len);
      objs.push({ dict, data: dict.includes('/FlateDecode') ? zlib.inflateSync(raw) : raw });
      next = from + len + 18;
    } else {
      ok(plain > 0, `Objekt ${no} ohne endobj`);
      objs.push({ dict: txt.slice(p, plain), data: null });
      next = plain + 8;
    }
  }
  same(next, xref, 'Querverweistabelle folgt nicht direkt auf das letzte Objekt');
  const trailer = /^trailer\n<< \/Size (\d+) \/Root 1 0 R \/Info 3 0 R \/ID \[<([0-9A-F]{32})> <([0-9A-F]{32})>\] >>\nstartxref\n/.exec(txt.slice(first + size * 20));
  ok(trailer && Number(trailer[1]) === size && trailer[2] === trailer[3], 'Anhang (trailer) unvollständig');
  for (let no = 1; no < size; no++) for (const m of objs[no].dict.matchAll(/(\d+) 0 R/g)) ok(m[1] >= 1 && m[1] < size, `Objekt ${no} verweist auf ${m[1]}, das es nicht gibt`);
  ok(/^<< \/Type \/Catalog \/Pages 2 0 R /.test(objs[1].dict), 'Katalog');
  const pages = [...objs[2].dict.matchAll(/(\d+) 0 R/g)].map((m) => {
    const d = objs[m[1]].dict, box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(d);
    ok(/\/Type \/Page /.test(d) && box, `Seite ${m[1]}`);
    return {
      width: Number(box[1]), height: Number(box[2]), dict: d,
      content: objs[/\/Contents (\d+) 0 R/.exec(d)[1]].data.latin1Slice(),
      fonts: Object.fromEntries([...(/\/Font << (.*?) >>/.exec(d)?.[1] ?? '').matchAll(/\/(F\d+) (\d+) 0 R/g)].map((f) => [f[1], Number(f[2])])),
      annots: [...(/\/Annots \[([^\]]*)\]/.exec(d)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((a) => objs[a[1]].dict),
    };
  });
  same(pages.length, Number(/\/Count (\d+)/.exec(objs[2].dict)[1]), 'Seitenzahl im Seitenbaum');
  return { objs, size, id: trailer[2], pages, text: txt };
}

/** Schrift-Objekt (Type0) samt Nachfahren → { name, widths[], unicode: Map Code → Text, file, descriptor } */
function readFont(pdf, no) {
  const top = pdf.objs[no].dict, cid = pdf.objs[/\/DescendantFonts \[(\d+) 0 R\]/.exec(top)[1]].dict;
  const desc = pdf.objs[/\/FontDescriptor (\d+) 0 R/.exec(cid)[1]].dict, fileObj = pdf.objs[/\/FontFile2 (\d+) 0 R/.exec(desc)[1]];
  ok(/\/Subtype \/Type0 /.test(top) && /\/Encoding \/Identity-H /.test(top) && /\/Subtype \/CIDFontType2 /.test(cid) && /\/CIDToGIDMap \/Identity /.test(cid), 'Schrift ist nicht Type0/CIDFontType2/Identity-H');
  const name = /\/BaseFont \/(\S+)/.exec(top)[1];
  ok(/^[A-Z]{6}\+\S+$/.test(name) && cid.includes(`/BaseFont /${name} `) && desc.includes(`/FontName /${name} `), `Schriftname ${name} ohne Teilmengen-Kennung oder uneinheitlich`);
  same(Number(/\/Length1 (\d+)/.exec(fileObj.dict)[1]), fileObj.data.length, '/Length1 der Schriftdatei');
  for (const key of ['Flags', 'FontBBox', 'ItalicAngle', 'Ascent', 'Descent', 'CapHeight', 'StemV']) ok(desc.includes(`/${key} `), `FontDescriptor ohne /${key}`);
  const unicode = new Map(), cmap = pdf.objs[/\/ToUnicode (\d+) 0 R/.exec(top)[1]].data.latin1Slice();
  for (const block of cmap.matchAll(/(\d+) beginbfchar\n([\s\S]*?)endbfchar\n/g)) {
    const rows = [...block[2].matchAll(/^<([0-9A-F]{4})> <((?:[0-9A-F]{4})+)>$/gm)];
    ok(rows.length === Number(block[1]) && rows.length <= 100 && rows.length === block[2].trim().split('\n').length, 'ToUnicode: Blocklänge falsch oder über 100');
    for (const r of rows) {
      ok(!unicode.has(parseInt(r[1], 16)), 'ToUnicode: Code doppelt');
      unicode.set(parseInt(r[1], 16), Buffer.from(r[2], 'hex').swap16().toString('utf16le'));
    }
  }
  return { name, unicode, file: fileObj.data, descriptor: desc, widths: /\/W \[0 \[([\d\s]+)\]\]/.exec(cid)[1].trim().split(/\s+/).map(Number) };
}

/** Inhaltsstrom einer Seite nach den Regeln der PDF-Norm auswerten → je BT…ET { x, y, skew, text, width, fonts, size, tc } */
function readTexts(pdf, page) {
  const fonts = {}, out = [], stack = [];
  for (const [id, no] of Object.entries(page.fonts)) fonts[id] = readFont(pdf, no);
  let st = { font: null, size: 0, tc: 0 }, cur = null, operands = [];
  const show = (hex) => {
    const f = fonts[st.font];
    ok(f, `Schrift ${st.font} steht nicht in den /Resources der Seite`);
    if (!cur.fonts.includes(f.name)) cur.fonts.push(f.name);
    for (let i = 1; i < hex.length - 1; i += 4) {
      const code = parseInt(hex.slice(i, i + 4), 16);
      ok(code > 0 && f.unicode.has(code) && code < f.widths.length, `Code ${code} ohne ToUnicode-Eintrag oder Breite`);
      cur.text += f.unicode.get(code);
      cur.width += f.widths[code] / 1000 * st.size + st.tc;
      cur.codes.push(`${f.name}:${code}`);
    }
  };
  for (const tok of page.content.match(/<[0-9A-F]*>|\[|\]|\/[A-Za-z0-9]+|-?\d*\.?\d+|[A-Za-z*]+/g) ?? []) {
    if (/^[<[\]/\d.-]/.test(tok)) { operands.push(tok); continue; }
    if (tok === 'q') stack.push({ ...st });
    else if (tok === 'Q') st = stack.pop();
    else if (tok === 'BT') cur = { x: 0, y: 0, skew: 0, text: '', width: 0, fonts: [], codes: [] };
    else if (tok === 'ET') { out.push({ ...cur, size: st.size, tc: st.tc }); cur = null; }
    else if (tok === 'Tf') { st.font = operands[0].slice(1); st.size = Number(operands[1]); }
    else if (tok === 'Tc') st.tc = Number(operands[0]);
    else if (tok === 'Td') { cur.x = Number(operands[0]); cur.y = Number(operands[1]); }
    else if (tok === 'Tm') { same(operands.slice(0, 2).join(' ') + operands[3], '1 01', 'Textmatrix'); cur.skew = Number(operands[2]); cur.x = Number(operands[4]); cur.y = Number(operands[5]); }
    else if (tok === 'Tj') show(operands[0]);
    else if (tok === 'TJ') for (const o of operands.slice(1, -1)) { if (o[0] === '<') show(o); else cur.width -= Number(o) / 1000 * st.size; }
    operands = [];
  }
  return out;
}

/** So muss der Text aus der Datei zurückkommen: Buchstabe + Kombinationszeichen nach NFC zusammengesetzt (Einzelzeichen
 *  unverändert), unsichtbare Formatzeichen weg, Tabulator/Umbruch als Leerzeichen */
const expected = (s) => s.replace(/\P{M}?\p{M}+/gu, (m) => m.normalize('NFC')).replace(/[\u00AD\u200B-\u200D\u2060\uFEFF\uFE0E\uFE0F]/g, '').replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ');

// ---------------------------------------------------------------------------
// Probe-Dokumente (mit --out bleiben sie liegen)
// ---------------------------------------------------------------------------
const built = new Map();     // Dateiname → Buffer
const keep = (name, pdf) => { built.set(name, pdf); return pdf; };

/** Alle Zeichen einer Schrift: 20 je Zeile, durch Leerzeichen getrennt (rund 40 Zeichen je Zeile) */
function allCharsDoc(name) {
  const font = getFont(name), cps = [...font.cmap.keys()].sort((a, b) => a - b), lines = [];
  const doc = new PdfDocument({ title: `Alle Zeichen – ${name}`, author: 'formsam', createdAt: STAMP });
  for (let i = 0; i < cps.length; i += 20) lines.push(cps.slice(i, i + 20).map((c) => String.fromCodePoint(c)).join(' '));
  let page = null, y = 0, widest = 0;
  for (const line of lines) {
    if (!page || y > A4.height - 50) { page = doc.addPage(); y = 56; }
    widest = Math.max(widest, page.text(line, 40, y, { font, size: 11 }));
    y += 19;
  }
  return { pdf: doc.toBuffer(), lines, cps, widest, pages: doc.pages.length };
}

function logo() {
  const svg = fs.readFileSync(new URL('../public/img/brand/formsam-logo.svg', import.meta.url), 'utf8');
  const box = /viewBox="([^"]+)"/.exec(svg)[1].trim().split(/[\s,]+/).map(Number);
  const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map(([tag]) => ({ d: /\sd="([^"]+)"/.exec(tag)[1], fill: /\sfill="([^"]+)"/.exec(tag)[1], fillRule: /fill-rule="evenodd"/.test(tag) ? 'evenodd' : 'nonzero' }));
  return { width: box[2], height: box[3], paths };
}
/** Logo mit der Breite width an (x, y) → Höhe */
function drawLogo(page, x, y, width) {
  const l = logo(), scale = width / l.width;
  for (const p of l.paths) page.path(p.d, { x, y, scale, fill: p.fill, fillRule: p.fillRule });
  return l.height * scale;
}

const INK = '#211d18', CLAY = '#c86f4a', GREY = '#6b6257', SAND = '#f4efe8', RULE = '#e6ddd0';
const SAMPLE = 'Größe, Füße, Äpfel – „Zitat“ für 1.234,56 €';

/** Gemischte Seite: alle Schnitte, Größen, Farben, Sperrung, Schrägstellung, Kette, Flächen, Linien, Logo, Verweis */
function mixedDoc() {
  const doc = new PdfDocument({ title: 'Gemischte Seite', author: 'formsam', subject: 'Probe für den PDF-Kern', keywords: ['Probe', 'Schriften', 'Grafik'], creator: 'tools/test-pdf.mjs', createdAt: STAMP });
  const page = doc.addPage(), left = 40, right = A4.width - 40, small = { font: 'Inter-Regular', size: 7.5, color: GREY };
  const widths = [];           // [Text, Angaben, gelieferte Breite] für „Messen = Zeichnen“
  const text = (str, x, y, opts) => { const w = page.text(str, x, y, opts); widths.push([str, opts, w]); return w; };

  // Logo in zwei Größen, rechts bündig über die bekannte Breite
  drawLogo(page, left, 36, 190);
  drawLogo(page, right - 76, 44, 76);
  text('Gemischte Seite', left, 124, { font: 'Fraunces-SemiBold', size: 26, color: INK });
  page.line(left, 136, right, 136, { color: RULE, width: 1 });

  // Alle sechs Schnitte in sechs Größen
  let y = 160;
  FONTS.forEach((name, i) => {
    const size = [8, 9, 10, 11.5, 13, 14.5][i];
    text(`${name} ${String(size).replace('.', ',')} pt: ${SAMPLE}`, left, y, { font: name, size, color: INK });
    y += size * 1.2 + 7;
  });

  // Farben, lückenlos hintereinander gesetzt über die gelieferte Breite
  let x = left;
  y += 6;
  for (const [word, color] of [['Terrakotta ', CLAY], ['Tinte ', INK], ['Grau ', GREY], ['Blau ', [0.1, 0.3, 0.7]], ['Kurzform #c40', '#c40']]) x += text(word, x, y, { font: 'Inter-Medium', size: 12, color });
  text('← je Wort ein Aufruf, angesetzt mit der gelieferten Breite', x + 8, y, small);

  // Eine Grundlinie, vier Größen, vier Schnitte
  y += 44;
  page.line(left, y, right, y, { color: CLAY, width: 0.25 });
  x = left;
  for (const [name, size] of [['Inter-Regular', 8], ['Fraunces-Medium', 13], ['Inter-Bold', 19], ['Fraunces-SemiBold', 30], ['Inter-Medium', 10]]) x += text('Grundlinie ', x, y, { font: name, size, color: INK });

  // Sperrung: Rahmen aus measureText und fontMetrics muss den Text genau einschließen
  y += 30;
  const boxed = (str, bx, by, opts) => {
    const m = fontMetrics(opts.font, opts.size), w = measureText(str, opts);
    page.rect(bx, by - m.ascent, w, m.ascent + m.descent, { stroke: CLAY, lineWidth: 0.25 });
    text(str, bx, by, opts);
    return w;
  };
  x = left + boxed('POS. BEZEICHNUNG MENGE EINZELPREIS', left, y, { font: 'Inter-SemiBold', size: 9.5, color: GREY, letterSpacing: 0.57 }) + 14;
  x += boxed('ohne Sperrung', x, y, { font: 'Inter-SemiBold', size: 9.5, color: GREY }) + 14;
  boxed('eng gesetzt', x, y, { font: 'Inter-SemiBold', size: 9.5, color: GREY, letterSpacing: -0.3 });
  y += 22;
  x = left + boxed('Wortabstand weit gesetzt', left, y, { font: 'Inter-Regular', size: 10, color: INK, wordSpacing: 6 }) + 14;
  boxed('und beides zusammen', x, y, { font: 'Fraunces-Medium', size: 11, color: INK, wordSpacing: 3, letterSpacing: 1 });

  // Schrägstellung
  y += 26;
  x = left + text('Schräg gestellt (wie im Browser) ', left, y, { font: 'Inter-Regular', size: 12, color: INK, oblique: true });
  x += text('Fraunces schräg ', x, y, { font: 'Fraunces-Medium', size: 13, color: CLAY, oblique: true });
  text('20° und gesperrt', x, y, { font: 'Inter-Bold', size: 11, color: INK, oblique: 20, letterSpacing: 0.4 });

  // Schriftkette: Fraunces zuerst, Griechisch/Kyrillisch/Pfeile kommen aus Inter
  y += 34;
  x = left + boxed('Größe Ελένη Олена', left, y, { font: ['Fraunces-Medium', 'Inter-Regular'], size: 20, color: INK }) + 16;
  boxed('Größe Ελένη Олена → 12,50 € ✓', x, y, { font: [{ family: 'Fraunces', weight: 700 }, { family: 'Inter', weight: 600 }], size: 12, color: INK });

  // Rechtecke
  y += 22;
  page.rect(left, y, 90, 46, { stroke: INK, lineWidth: 1 });
  page.rect(left + 105, y, 90, 46, { fill: SAND });
  page.rect(left + 210, y, 90, 46, { fill: SAND, stroke: CLAY, lineWidth: 2, radius: 8 });
  page.rect(left + 315, y, 90, 46, { fill: CLAY, radius: [0, 16, 4, 23] });
  page.rect(left + 420, y, 95, 46, { stroke: INK, lineWidth: 1.5, radius: 999, dash: [4, 2] });
  ['Rahmen 1 pt', 'Fläche', 'beides, Radius 8', 'Radien 0/16/4/23', 'Radius gekappt, gestrichelt'].forEach((label, i) => text(label, left + i * 105, y + 57, small));

  // Linien
  y += 76;
  [0.25, 0.5, 1, 1.5, 2, 4].forEach((width, i) => page.line(left, y + i * 7, left + 150, y + i * 7, { color: INK, width }));
  page.line(left + 170, y, left + 320, y, { color: CLAY, width: 1, dash: [6, 3] });
  page.line(left + 170, y + 12, left + 320, y + 12, { color: CLAY, width: 5, lineCap: 'round' });
  page.line(left + 170, y + 35, left + 320, y + 22, { color: GREY, width: 0.75 });
  // Beschnitt mit runden Ecken, danach geht es unbeschnitten weiter
  page.save().clip(left + 345, y - 4, 170, 42, { radius: 12 });
  page.rect(left + 345, y - 4, 170, 42, { fill: SAND });
  for (let i = -3; i < 12; i++) page.line(left + 345 + i * 16, y + 38, left + 385 + i * 16, y - 4, { color: CLAY, width: 5 });
  page.restore();
  text('Strichbreiten 0,25–4 pt', left, y + 50, small);
  text('gestrichelt, runde Enden, schräg', left + 170, y + 50, small);
  text('Beschnitt mit Radius 12', left + 345, y + 50, small);

  // SVG-Pfade: Ring aus Bögen (evenodd), gedrehter Ellipsenbogen, Welle aus Q/T, Herz aus relativen Kurven
  y += 70;
  page.path('M0 20a20 20 0 1 0 40 0a20 20 0 1 0-40 0zM10 20a10 10 0 1 1 20 0a10 10 0 1 1-20 0z', { x: left, y, fill: CLAY, fillRule: 'evenodd' });
  page.path('M0 30A30 15 -30 0 1 52 10L52 30Z', { x: left + 60, y, fill: SAND, stroke: INK, lineWidth: 0.75 });
  page.path('M0 20q10-30 20 0t20 0t20 0 20 0', { x: left + 135, y, stroke: CLAY, lineWidth: 1.5, lineCap: 'round' });
  page.path('M20 35c-25-15-20-35 0-22c20-13 25 7 0 22z', { x: left + 232, y: y + 2, scale: [1.3, 1], fill: CLAY });
  page.path('M0 0H10V10H0Z', { transform: [2.4, 1.2, -1.2, 2.4, left + 320, y + 6], fill: INK });
  text('Bögen (Ring), Ellipsenbogen, Q/T-Welle, Kurven mit Maßstab [1,3; 1], Quadrat mit Matrix gedreht', left, y + 54, small);

  // Verweis: Text, Unterstreichung aus der Schriftmetrik, anklickbare Fläche
  y += 84;
  const link = { font: 'Inter-Medium', size: 11, color: CLAY }, lm = fontMetrics(link.font, link.size);
  const lw = text('www.formsam.com', left, y, link);
  page.line(left, y - lm.underlinePosition, left + lw, y - lm.underlinePosition, { color: CLAY, width: lm.underlineThickness });
  page.link(left, y - lm.ascent, lw, lm.ascent + lm.descent, 'https://www.formsam.com/');
  text('← Verweis (ganze Zeilenhöhe anklickbar)', left + lw + 8, y, small);
  text('formsam · Probe für den PDF-Kern · Seite 1', left, A4.height - 36, small);
  return { doc, pdf: doc.toBuffer(), widths };
}

/** Drei Seiten in drei Formaten, jede mit Rahmen 10 pt innerhalb des Randes und ihrem Maß als Text */
function threePagesDoc() {
  const doc = new PdfDocument({ title: 'Drei Seiten, drei Formate', author: 'formsam', createdAt: STAMP });
  for (const [label, width, height] of [['A4 hoch', A4.width, A4.height], ['A5 quer', mm(210), mm(148)], ['Bon 80 mm', mm(80), mm(200)]]) {
    const page = doc.addPage({ width, height });
    page.rect(10, 10, width - 20, height - 20, { stroke: CLAY, lineWidth: 1, radius: 6 });
    page.text(label, 24, 44, { font: 'Fraunces-SemiBold', size: 18, color: INK });
    page.text(`${Math.round(width / mm(1))} × ${Math.round(height / mm(1))} mm`, 24, 62, { font: 'Inter-Regular', size: 10, color: GREY });
    page.text('unten rechts', width - 24 - measureText('unten rechts', { font: 'Inter-Regular', size: 10 }), height - 24, { font: 'Inter-Regular', size: 10, color: GREY });
  }
  return doc.toBuffer();
}

function noTextDoc() {
  const doc = new PdfDocument({ title: 'Ohne Text', createdAt: STAMP }), page = doc.addPage();
  drawLogo(page, 60, 80, A4.width - 120);
  page.rect(60, 240, A4.width - 120, 120, { fill: SAND, stroke: CLAY, lineWidth: 1.5, radius: 14 });
  page.line(60, 400, A4.width - 60, 400, { color: INK, width: 0.75 });
  return doc.toBuffer();
}

const WORDS = 'Vase Form Druck Schicht Glasur Ton Farbe Größe Höhe Maß Linie Kurve Fläche Kante Rand Öffnung Boden Hals Bauch Welle Düne Muster Licht Schatten für und mit aus'.split(' ');
function longDoc(pages = 300) {
  const doc = new PdfDocument({ title: `${pages} Seiten`, author: 'formsam', createdAt: STAMP });
  const body = getFont('Inter-Regular'), head = getFont('Fraunces-SemiBold'), lines = [];
  let n = 1;
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage();
    lines.push(`Abschnitt ${p}`);
    page.text(lines.at(-1), 50, 60, { font: head, size: 18, color: INK });
    for (let l = 0; l < 44; l++) {
      let line = '';
      while (line.length < 76) line += `${WORDS[(n = (n * 31 + 7) % 1009) % WORDS.length]} `;   // festes Muster statt Zufall
      lines.push(line.trim());
      page.text(lines.at(-1), 50, 92 + l * 16, { font: body, size: 10, color: INK });
    }
    lines.push(`Seite ${p} von ${pages}`);
    page.text(lines.at(-1), 50, 812, { font: body, size: 8, color: GREY });
  }
  return { pdf: doc.toBuffer(), lines };
}

// Eine typische Belegseite: rund 1200 Zeichen in drei Schnitten (alle Angaben erfunden)
const H = 'Fraunces-SemiBold', B = 'Inter-Regular', S = 'Inter-SemiBold';
const TYPICAL = [
  [H, 22, 'Rechnung RE-2026-0042', 0],
  [B, 8.5, 'formsam · Erika Mustermann · Teststraße 12 · 12345 Musterstadt', 0],
  [S, 9.5, 'RECHNUNG AN', 0.57],
  [B, 10.5, 'Max Beispiel', 0], [B, 10.5, 'Probeweg 7', 0], [B, 10.5, '54321 Beispielhausen', 0], [B, 10.5, 'Deutschland', 0],
  [B, 9.5, 'Rechnungsdatum: 15.01.2026 · Leistungsdatum: 14.01.2026 · Bestellung FS-2026-0042', 0],
  [S, 9.5, 'POS. BEZEICHNUNG MENGE EINZELPREIS GESAMT', 0.57],
  [B, 10, '1 Vase „Welle“, 18 cm, Terrakotta, individuell für dich gedruckt 1 × 49,00 € 49,00 €', 0],
  [B, 10, '2 Vase „Düne“, 24 cm, Sandweiß, mit Gravur „Für Oma“ 2 × 64,50 € 129,00 €', 0],
  [B, 10, '3 Versand als versichertes Paket 1 × 5,90 € 5,90 €', 0],
  [B, 10, 'Zwischensumme 183,90 €', 0],
  [B, 10, 'Gutschein WILLKOMMEN10 −10,00 €', 0],
  [H, 14, 'Gesamtbetrag 173,90 €', 0],
  [B, 9.5, 'Im Gesamtbetrag enthaltene Umsatzsteuer (19 %): 27,77 €', 0],
  [S, 9.5, 'Zahlung', 0],
  [B, 9.5, 'Bezahlt per Überweisung am 15.01.2026 – vielen Dank für deine Bestellung!', 0],
  [S, 9.5, 'Lieferung', 0],
  [B, 9.5, 'Jede Vase wird eigens für dich gedruckt; die Lieferzeit beträgt in der Regel 5–8 Werktage.', 0],
  [B, 9.5, 'Du bekommst eine E-Mail mit der Sendungsnummer, sobald dein Paket unterwegs ist.', 0],
  [S, 9.5, 'Fragen?', 0],
  [B, 9.5, 'Schreib einfach an hallo@example.com oder schau auf www.example.com/hilfe vorbei.', 0],
  [B, 9.5, 'Bitte heb diese Rechnung auf – sie ist zugleich dein Garantiebeleg (§ 14 UStG).', 0],
  [B, 8, 'formsam · Inhaberin Erika Mustermann · Teststraße 12 · 12345 Musterstadt · USt-IdNr. DE000000000', 0],
  [B, 8, 'Musterbank · IBAN DE00 0000 0000 0000 0000 00 · BIC MUSTDEFFXXX · Seite 1 von 1', 0],
];
function typicalDoc() {
  const doc = new PdfDocument({ title: 'Rechnung RE-2026-0042', author: 'formsam', subject: 'Rechnung', createdAt: STAMP });
  const page = doc.addPage();
  drawLogo(page, 50, 40, 120);
  let y = 110;
  for (const [font, size, str, letterSpacing] of TYPICAL) {
    y += size * 1.2 + 9;
    const w = page.text(str, 50, y, { font, size, color: INK, letterSpacing });
    if (font === S) page.line(50, y + 4, 50 + w, y + 4, { color: RULE, width: 1 });
  }
  page.rect(50, y + 16, A4.width - 100, 28, { fill: SAND, radius: 4 });
  page.link(50, y + 16, A4.width - 100, 28, 'https://www.example.com/hilfe');
  return doc.toBuffer();
}

// ---------------------------------------------------------------------------
// Prüfungen: Schriften
// ---------------------------------------------------------------------------
check('Schriften: sechs Schnitte lesbar, Zeichentabelle und Breiten stimmen mit eigenem Leser überein', () => {
  let chars = 0;
  for (const name of FONTS) {
    const f = getFont(name), raw = readSfnt(fontFile(name), false), map = cmap4(raw.tables.cmap), inter = name.startsWith('Inter');
    same(f.postScriptName, name, 'PostScript-Name');
    same(f.unitsPerEm, inter ? 2048 : 2000, `${name}: unitsPerEm`);
    same(f.family, inter ? 'Inter' : 'Fraunces', `${name}: Familie`);
    same(f.weightClass, f.weight, `${name}: Stärke aus OS/2 und Registratur`);
    ok(f.useTypoMetrics && f.italicAngle === 0 && !f.fixedPitch && f.serif === !inter, `${name}: Kenndaten`);
    same(f.cmap.size, map.size, `${name}: Größe der Zeichentabelle`);
    for (const [cp, gid] of map) {
      same(f.glyph(cp), gid, `${name}: Glyphe zu U+${cp.toString(16)}`);
      same(f.advance(gid), raw.advance(gid), `${name}: Vorschub zu U+${cp.toString(16)}`);
    }
    same(f.glyph(0x4E2D), 0, `${name}: fehlendes Zeichen muss 0 liefern`);
    for (const ch of 'AZaz09ÄÖÜäöüßé§°·–—„“”‚‘’€×−… \u00A0') ok(f.glyph(ch.codePointAt(0)), `${name}: Zeichen „${ch}“ fehlt`);
    if (inter) for (const ch of 'ΑΩαω' + 'АЯаяЄї' + '→✓') ok(f.glyph(ch.codePointAt(0)), `${name}: Zeichen „${ch}“ fehlt`);
    chars += f.cmap.size;
  }
  same(getFont('Inter-Regular'), getFont('Inter-Regular'), 'Schrift wird nicht nur einmal je Prozess gelesen');
  return `${chars} Zeichen in 6 Schnitten`;
});

check('Schriftmetrik in Punkten', () => {
  const m = fontMetrics('Inter-Regular', 2048), f = fontMetrics('Fraunces-Medium', 20);
  same([m.ascent, m.descent, m.lineGap, m.capHeight, m.xHeight].join(' '), '1984 494 0 1490 1118', 'Inter bei Größe = unitsPerEm');
  same([m.hheaAscender, m.hheaDescender, m.typoAscender, m.typoDescender, m.winAscent, m.winDescent].join(' '), '1984 -494 1984 -494 2269 660', 'Inter: Rohwerte mit Vorzeichen der Schrift');
  same([f.ascent, f.descent, f.capHeight, f.xHeight, f.underlinePosition, f.underlineThickness].join(' '), '19.56 5.1 14 9.64 -3 0.5', 'Fraunces bei 20 pt');
  ok(m.useTypoMetrics && m.unitsPerEm === 2048 && m.underlinePosition < 0 && m.strikeoutPosition > 0, 'Kenndaten');
  same(fontMetrics(['Fraunces-Medium', 'Inter-Regular'], 20).ascent, f.ascent, 'Kette nimmt die erste Schrift');
  fails('BAD_NUMBER', () => fontMetrics('Inter', NaN), 'Größe NaN');
});

check('Schriftauswahl nach Familie und Stärke', () => {
  const pick = (family, weight) => findFont({ family, weight })?.name;
  const got = [100, 300, 400, 450, 500, 550, 600, 700, 800, 900].map((w) => pick('Inter', w).replace('Inter-', '')).join(' ');
  same(got, 'Regular Regular Regular Medium Medium SemiBold SemiBold Bold Bold Bold', 'Inter 100–900');
  same([100, 400, 500, 600, 700, 900].map((w) => pick('Fraunces', w).replace('Fraunces-', '')).join(' '), 'Medium Medium Medium SemiBold SemiBold SemiBold', 'Fraunces 100–900');
  same(pick('inter', 'bold'), 'Inter-Bold', 'Familie ohne Groß-/Kleinschreibung, „bold“');
  same(findFont({ family: 'Inter' }).name, 'Inter-Regular', 'ohne Stärke = 400');
  same(findFont({ family: 'Helvetica', weight: 400 }), null, 'unbekannte Familie');
  fails('BAD_FONT', () => getFont('Inter-Black'), 'unbekannter Name');
  fails('BAD_FONT', () => measureText('a', { font: 'Helvetica', size: 10 }), 'unbekannte Familie beim Messen');
  fails('BAD_FONT', () => measureText('a', { size: 10 }), 'ohne Schrift');
  fails('BAD_FONT', () => measureText('a', { font: [], size: 10 }), 'leere Kette');
  same(measureText('Maß', { font: 'Inter', size: 10 }), measureText('Maß', { font: getFont('Inter-Regular'), size: 10 }), 'Familienname = Schnitt 400');
});

check('Eigene Schrift anmelden; kaputte Dateien werden abgelehnt', () => {
  const data = fontFile('Inter-Medium');
  const f = registerFont('Probe-Schrift', data, { family: 'Probe', weight: 500 });
  same(findFont({ family: 'Probe', weight: 900 }), f, 'Auswahl über die Familie');
  same(measureText('Größe', { font: 'Probe-Schrift', size: 12 }), measureText('Größe', { font: 'Inter-Medium', size: 12 }), 'gleiche Breiten wie das Original');
  fails('BAD_FONT', () => registerFont('Kaputt', Buffer.from('keine Schrift')), 'Unsinn');
  fails('BAD_FONT', () => registerFont('Kaputt', data.subarray(0, 5000)), 'abgeschnittene Datei');
  fails('BAD_FONT', () => registerFont('Kaputt', Buffer.concat([Buffer.from('OTTO'), data.subarray(4)])), 'OpenType mit CFF-Umrissen');
  fails('BAD_FONT', () => registerFont('Kaputt', '/gibt/es/nicht.ttf'), 'fehlende Datei');
  fails('BAD_FONT', () => parseFont('text'), 'kein Buffer');
  fails('BAD_FONT', () => getFont('Kaputt'), 'abgelehnte Schrift bleibt nicht in der Registratur');
  const locked = Buffer.from(data), os2 = 12 + 16 * [...Array(locked.readUInt16BE(4)).keys()].find((i) => locked.latin1Slice(12 + i * 16, 16 + i * 16) === 'OS/2');
  locked.writeUInt16BE(0x0002, locked.readUInt32BE(os2 + 8) + 8);
  fails('BAD_FONT', () => parseFont(locked, { name: 'Gesperrt' }), 'fsType „Einbetten verboten“');
});

// ---------------------------------------------------------------------------
// Prüfungen: Teilmenge
// ---------------------------------------------------------------------------
check('Teilmenge: alle Glyphen jeder Schrift — Aufbau, Prüfsummen, Umrisse, Bauteile', () => {
  let glyphs = 0, bytes = 0;
  for (const name of FONTS) {
    const f = getFont(name), orig = readSfnt(fontFile(name), false);
    const sub = subsetFont(f, [...f.cmap.values()]);
    compareSubset(readSfnt(sub.data, true), orig, sub.glyphs);
    same(sub.glyphs.slice(1, f.cmap.size + 1).join(), [...f.cmap.values()].join(), `${name}: Plätze 1…n in der verlangten Reihenfolge`);
    glyphs += sub.glyphs.length;
    bytes += sub.data.length;
  }
  return `${glyphs} Glyphen, ${kb(bytes)}`;
});

check('Teilmenge: klein, mit Bauteilen und doppelt verlangter Glyphe', () => {
  const f = getFont('Fraunces-Medium'), orig = readSfnt(fontFile('Fraunces-Medium'), false);
  const a = f.glyph(0xC4), sub = subsetFont(f, [a, a]);                  // „Ä“ zweimal: zwei Plätze, Bauteile nur einmal
  const parts = components(orig.glyph(a));
  ok(parts.length >= 2, 'Ä ist in Fraunces nicht zusammengesetzt — Probe anpassen');
  same(sub.glyphs.slice(0, 3).join(), [0, a, a].join(), 'Plätze 0–2');
  const read = readSfnt(sub.data, true);
  compareSubset(read, orig, sub.glyphs);
  ok(sub.glyphs.length <= 3 + parts.length + 4 && sub.data.length < 3000, `unerwartet groß: ${sub.glyphs.length} Glyphen, ${sub.data.length} Byte`);
  same(Object.keys(read.tables).join(' '), 'glyf head hhea hmtx loca maxp', 'eingebettete Tabellen');
  const only = readSfnt(subsetFont(f, []).data, true);
  same(only.num, 1, 'leere Teilmenge enthält nur .notdef');
  fails('BAD_FONT', () => subsetFont(f, [99999]), 'Glyphe außerhalb der Schrift');
  return `${sub.glyphs.length} Glyphen, ${sub.data.length} Byte`;
});

// ---------------------------------------------------------------------------
// Prüfungen: Text
// ---------------------------------------------------------------------------
check('Text: Schriftkette — je Zeichen die erste Schrift, die es hat', () => {
  const doc = new PdfDocument({ createdAt: STAMP }), page = doc.addPage(), str = 'Größe Ελένη Олена';
  page.text(str, 40, 60, { font: ['Fraunces-Medium', 'Inter-Regular'], size: 14 });
  const pdf = readPdf(doc.toBuffer()), [t] = readTexts(pdf, pdf.pages[0]);
  same(t.text, str, 'Text aus Inhaltsstrom und ToUnicode');
  same(t.fonts.map((n) => n.slice(7)).join(' '), 'Fraunces-Medium Inter-Regular', 'benutzte Schriften');
  const runs = t.codes.map((c) => c.slice(7).split(':')[0][0]).join('').replace(/(.)\1*/g, '$1');
  same(runs, 'FIFI', 'Läufe: Größe␣ | Ελένη | ␣ | Олена');
  fails('GLYPH_MISSING', () => page.text(str, 40, 80, { font: 'Fraunces-Medium', size: 14 }), 'ohne Kette fehlt Griechisch');
});

check('Text: fehlendes Zeichen bricht ab (GLYPH_MISSING) und hinterlässt nichts', () => {
  const doc = new PdfDocument({ createdAt: STAMP }), page = doc.addPage(), chain = ['Fraunces-Medium', 'Inter-Regular'];
  const e = fails('GLYPH_MISSING', () => page.text('Preis ✔ ok', 40, 60, { font: chain, size: 10 }), 'U+2714');
  same(`${e.char} ${e.codePoint}`, '✔ 10004', 'Zeichen und Codepunkt am Fehler');
  ok(e.message.includes('U+2714') && e.message.includes('Fraunces-Medium, Inter-Regular'), `Meldung nennt Codepunkt und Schriften nicht: ${e.message}`);
  same(fails('GLYPH_MISSING', () => measureText('🖨\uFE0F Drucken', { font: chain, size: 10 }), 'Emoji beim Messen').codePoint, 0x1F5A8, 'Codepunkt jenseits der BMP');
  fails('GLYPH_MISSING', () => page.text('a\u0001b', 40, 60, { font: chain, size: 10 }), 'Steuerzeichen');
  fails('GLYPH_MISSING', () => page.text('x\u0303', 40, 60, { font: chain, size: 10 }), 'Kombinationszeichen ohne fertigen Buchstaben');
  same(page.ops.length + doc.fonts.size, 0, 'nach den Fehlern steht etwas auf der Seite');
  same(missingChars('a✔b🖨c✔中', chain).join(' '), '✔ 🖨 中', 'Vorab-Prüfung');
  same(missingChars('Größe Ελένη → 5 €\u00AD\u200B\t', chain).length, 0, 'Vorab-Prüfung bei darstellbarem Text');
  same(missingChars('Ω', 'Fraunces-Medium').join(), 'Ω', 'Vorab-Prüfung ohne Kette');
  fails('BAD_TEXT', () => page.text(42, 40, 60, { font: chain, size: 10 }), 'Zahl statt Text');
});

check('Text: Messen = Zeichnen (Breite aus Inhaltsstrom und /W nachgerechnet)', () => {
  const doc = new PdfDocument({ createdAt: STAMP }), page = doc.addPage(), chain = ['Fraunces-SemiBold', 'Inter-Bold'];
  const cases = [
    ['Rechnung RE-2026-0042', { font: 'Fraunces-SemiBold', size: 22 }],
    [SAMPLE, { font: 'Inter-Regular', size: 9.5 }],
    [SAMPLE, { font: 'Inter-Medium', size: 10.123456 }],
    ['POS. BEZEICHNUNG MENGE', { font: 'Inter-SemiBold', size: 9.5, letterSpacing: 0.57 }],
    ['eng und krumm', { font: 'Inter-Regular', size: 7.3333333, letterSpacing: -1 / 3 }],
    ['Wörter mit weitem Abstand ', { font: 'Inter-Regular', size: 11, wordSpacing: 2.5 }],
    ['geschützte\u00A0Leerzeichen zählen mit', { font: 'Fraunces-Medium', size: 12, wordSpacing: 1 / 3, letterSpacing: 0.2 }],
    ['Größe Ελένη Олена → ✓', { font: chain, size: 13.5, letterSpacing: 0.25, wordSpacing: 1.5 }],
    ['schräg', { font: 'Inter-Bold', size: 12, oblique: true, color: CLAY }],
    [' ', { font: 'Inter-Regular', size: 10 }],
  ];
  const got = cases.map(([str, opts], i) => page.text(str, 40.25, 50 + i * 30, opts));
  same(page.text('', 40, 400, { font: 'Inter', size: 10 }) + page.text('\u00AD\u200B', 40, 400, { font: 'Inter', size: 10 }), 0, 'leerer Text');
  const pdf = readPdf(doc.toBuffer()), texts = readTexts(pdf, pdf.pages[0]);
  same(texts.length, cases.length, 'Zahl der Textblöcke (leerer Text schreibt nichts)');
  cases.forEach(([str, opts], i) => {
    same(got[i], measureText(str, opts), `„${str}“: text() und measureText()`);
    near(texts[i].width, got[i], `„${str}“: Breite im Inhaltsstrom`);
    same(texts[i].text, expected(str), `„${str}“: Text im Inhaltsstrom`);
    near(texts[i].x, 40.25, 'x', 1e-9);
    near(texts[i].y, A4.height - (50 + i * 30), 'Grundlinie', 0.0005);
  });
  near(got[3], measureText('POS. BEZEICHNUNG MENGE', { font: 'Inter-SemiBold', size: 9.5 }) + 22 * 0.57, 'Sperrung zählt nach jedem Zeichen, auch dem letzten');
  near(got[5], measureText('Wörter mit weitem Abstand ', { font: 'Inter-Regular', size: 11 }) + 4 * 2.5, 'Wortabstand je Leerzeichen', 1e-3);
  same(texts[8].skew, 0.25, 'Schrägstellung 1:4');
  near(got[1], 9.5 * cpsOf(SAMPLE).reduce((sum, cp) => sum + Math.round(getFont('Inter-Regular').advance(getFont('Inter-Regular').glyph(cp)) * 1000 / 2048), 0) / 1000, 'Breite = Summe der gerundeten Tausendstel');
  return `${cases.length} Fälle`;
});

check('Text: Leerraum, unsichtbare Zeichen, Zusammensetzen nach NFC', () => {
  const doc = new PdfDocument({ createdAt: STAMP }), page = doc.addPage(), fr = { font: 'Fraunces-Medium', size: 10 }, it = { font: 'Inter-Regular', size: 10 };
  const cases = [
    ['a\u00ADb\u200Bc\u200C\u200D\u2060\uFEFFd\uFE0E\uFE0F', fr, 'abcd'],            // übersprungen
    ['a\tb\nc\r\nd\u2028e', fr, 'a b c  d e'],                                        // Tabulator und Umbrüche → Leerzeichen
    ['a\u2009b\u202Fc\u3000d', fr, 'a\u2009b\u202Fc\u3000d'],                         // Fraunces hat sie nicht → Leerzeichen-Glyphe, Codepunkt bleibt
    ['a\u2009b\u3000c', it, 'a\u2009b\u3000c'],                                       // Inter hat U+2009 selbst, U+3000 nicht
    ['Gro\u0308ße A\u030A', it, 'Größe Å'],                                       // zerlegte Umlaute → ein Zeichen
    ['\u2126 \u212A \u212B \u2000', it, '\u2126 \u212A \u212B \u2000'],               // Einzelzeichen bleiben (NFC würde sie ersetzen)
    ['\u2126\u0301 \u0415\u0308', it, '\u038F \u0401'],                               // … außer vor einem Kombinationszeichen: Ώ, Ё
  ];
  cases.forEach(([str, opts], i) => page.text(str, 40, 50 + i * 20, opts));
  const pdf = readPdf(doc.toBuffer()), texts = readTexts(pdf, pdf.pages[0]);
  cases.forEach(([str, , want], i) => {
    same(texts[i].text, want, `Fall ${i + 1}`);
    same(want, expected(str), `Fall ${i + 1}: Erwartung der Prüfung selbst`);
  });
  same(measureText(cases[0][0], fr), measureText('abcd', fr), 'übersprungene Zeichen haben keine Breite');
  same(measureText('a\u2009b', fr), measureText('a b', fr), 'Fraunces: U+2009 so breit wie das Leerzeichen');
  ok(measureText('a\u2009b', it) < measureText('a b', it), 'Inter: U+2009 hat seine eigene, schmalere Glyphe');
  same(measureText('a\u3000b', it), measureText('a b', it), 'Inter: U+3000 so breit wie das Leerzeichen');
  same(measureText('a\u2009b', { font: ['Fraunces-Medium', 'Inter-Regular'], size: 10 }), measureText('ab', fr) + measureText('\u2009', it), 'Kette: eigene Glyphe aus Inter geht vor Leerzeichen aus Fraunces');
  same(new Set(texts[2].codes).size, 7, 'jedes Zeichen hat seinen eigenen Code');
});

check('Text: Zeichen mit gemeinsamer Glyphe bekommen eigene Codes', () => {
  const f = getFont('Inter-Regular'), pairs = [[0x3A9, 0x2126], [0x394, 0x2206], [0x2BC, 0x2019], [0x25B6, 0x25BA]];
  for (const [a, b] of pairs) same(f.glyph(a), f.glyph(b), `U+${a.toString(16)}/U+${b.toString(16)} teilen sich in Inter keine Glyphe mehr — Probe anpassen`);
  const doc = new PdfDocument({ createdAt: STAMP }), page = doc.addPage(), str = pairs.flat().map((c) => String.fromCodePoint(c)).join('');
  page.text(str + str, 40, 60, { font: f, size: 12 });
  const pdf = readPdf(doc.toBuffer()), [t] = readTexts(pdf, pdf.pages[0]), font = readFont(pdf, pdf.pages[0].fonts.F1);
  same(t.text, str + str, 'Text kommt Zeichen für Zeichen zurück');
  same(new Set(t.codes).size, 8, 'acht Zeichen = acht Codes');
  same(t.codes.slice(0, 8).join(), t.codes.slice(8).join(), 'Wiederholung benutzt dieselben Codes');
  const sub = readSfnt(font.file, true);
  same(sub.num, 9, 'Glyphen in der eingebetteten Schrift (.notdef + 8)');
  for (let i = 1; i < 9; i += 2) ok(sub.glyph(i).equals(sub.glyph(i + 1)) && (i === 1 || !sub.glyph(i).equals(sub.glyph(1))), `Umrisse des Paares ${i}/${i + 1}`);
  same(font.widths.length, 9, 'Breiten für jeden Platz');
  same([...font.unicode.values()].join(''), str, 'ToUnicode: jeder Code genau sein Codepunkt');
});

// ---------------------------------------------------------------------------
// Prüfungen: Zahlen, Angaben, Grafik
// ---------------------------------------------------------------------------
check('Zahlen: NaN, Unendlich und Unsinn werden abgelehnt (BAD_NUMBER), nichts bleibt halb geschrieben', () => {
  const doc = new PdfDocument({ createdAt: STAMP }), page = doc.addPage(), t = { font: 'Inter', size: 10 };
  const bad = [
    () => page.text('a', NaN, 10, t), () => page.text('a', 10, Infinity, t), () => page.text('a', '10', 10, t), () => page.text('a', 10, undefined, t),
    () => page.text('a', 10, 10, { ...t, size: NaN }), () => page.text('a', 10, 10, { ...t, size: 0 }), () => page.text('a', 10, 10, { ...t, size: -4 }),
    () => page.text('a', 10, 10, { font: 'Inter' }), () => page.text('a', 10, 10, { ...t, letterSpacing: NaN }), () => page.text('a', 10, 10, { ...t, wordSpacing: Infinity }),
    () => page.text('a', 10, 10, { ...t, oblique: NaN }), () => page.text('a', 1e9, 10, t), () => page.text('', NaN, 10, t),
    () => measureText('a', { ...t, size: Infinity }), () => measureText('a', { ...t, letterSpacing: '1' }),
    () => page.rect(NaN, 0, 10, 10, { fill: '#000' }), () => page.rect(0, 0, Infinity, 10, { fill: '#000' }), () => page.rect(0, 0, 10, 10, { fill: '#000', radius: NaN }),
    () => page.rect(0, 0, 10, 10, { fill: '#000', radius: [1, 2, 3] }), () => page.rect(0, 0, 10, 10, { fill: '#000', radius: -1 }),
    () => page.rect(0, 0, 10, 10, { stroke: '#000', lineWidth: NaN }), () => page.rect(0, 0, 10, 10, { stroke: '#000', lineWidth: 0 }),
    () => page.rect(0, 0, 10, 10, { fill: [NaN, 0, 0] }), () => page.rect(0, 0, 10, 10, { fill: [0, Infinity, 0] }),
    () => page.line(0, 0, NaN, 10), () => page.line(0, 0, 10, 10, { width: -1 }),
    () => page.path('M0 0L10 10', { stroke: '#000', scale: NaN }), () => page.path('M0 0L10 10', { stroke: '#000', x: Infinity }),
    () => page.path('M0 0L10 10', { stroke: '#000', transform: [1, 0, 0, NaN, 0, 0] }), () => page.path('M0 0L1e30 10', { stroke: '#000' }),
    () => page.clip(0, NaN, 10, 10), () => page.link(0, 0, NaN, 10, 'https://www.example.com/'),
    // Werte, die JavaScript stillschweigend umrechnen würde ('1' + 3 = '13', null = 0, true = 1, [5] = 5)
    ...['10', null, true, [5], 10n].flatMap((v) => [
      () => page.text('a', 10, v, t), () => page.rect(0, v, 10, 10, { fill: '#000' }), () => page.rect(0, 0, 10, v, { fill: '#000', radius: 2 }),
      () => page.line(v, 0, 10, 10), () => page.line(0, 0, 10, v), () => page.clip(0, 0, v, 10),
      () => page.link(v, 0, 10, 10, 'https://www.example.com/'), () => page.link(0, 0, 10, v, 'https://www.example.com/'),
      () => page.path('M0 0L10 10', { stroke: '#000', transform: [1, 0, 0, 1, v, 0] }), () => page.path('M0 0L10 10', { stroke: '#000', scale: [1, v] }),
      () => mm(v),
    ]),
    () => page.path('M0 0L10 10', { stroke: '#000', scale: '2' }), () => page.path('M0 0L10 10', { stroke: '#000', y: '5' }),
    () => doc.addPage({ width: NaN }), () => doc.addPage({ width: 100, height: Infinity }), () => doc.addPage({ width: 0, height: 100 }), () => doc.addPage({ width: 1e6, height: 100 }),
  ];
  bad.forEach((fn, i) => fails('BAD_NUMBER', fn, `Fall ${i + 1}`));
  same(page.ops.length + page.links.length + doc.fonts.size + (doc.pages.length - 1), 0, 'nach den Fehlern steht etwas im Dokument');
  return `${bad.length} Fälle`;
});

check('Zahlen: feste Schreibweise mit begrenzten Nachkommastellen', () => {
  const doc = new PdfDocument({ createdAt: STAMP, compress: false }), page = doc.addPage({ width: 200, height: 100 });
  page.rect(1e-7, 100, 1 / 3, 2 / 3, { fill: [1 / 3, 1e-9, 1] });
  page.line(-0, 100.00049, 123456.7891, 0.0005, { color: '#000', width: 0.3333333 });
  page.text('a', 1e-9, 50, { font: 'Inter', size: 9.99996, letterSpacing: 1e-7 });
  same(page.ops.slice(0, 5).join(' | '), '0.3333 0 1 rg | 0 -0.667 0.333 0.667 re f | 0 0 0 RG | 0.333 w | 0 0 m 123456.789 100 l S', 'Rundung');
  same(page.ops.slice(5).join(' | ').replace(/<[0-9A-F]+>/, '<…>'), '0 0 0 rg | BT 0 50 Td /F1 10 Tf <…> Tj ET', 'Text: Größe 9,99996 → 10, Abstand 1e-7 → keiner');
  const body = doc.toBuffer().latin1Slice();
  ok(body.includes(`\n${page.ops.join('\n')}\n`), 'unkomprimierter Inhaltsstrom steht nicht wörtlich in der Datei');
  for (const p of [mixedDoc().doc.pages[0], page]) ok(!/[eE][+-]?\d|NaN|Infinity|undefined|\.\d{5}/.test(p.ops.join('\n').replace(/<[0-9A-F]+>/g, '')), 'Exponent, NaN oder mehr als 4 Nachkommastellen im Inhaltsstrom');
});

check('Angaben: Tippfehler und falsche Werte werden gemeldet (BAD_OPTION, BAD_COLOR, BAD_STATE, NO_PAGES)', () => {
  const doc = new PdfDocument(), page = doc.addPage(), t = { font: 'Inter', size: 10 };
  fails('BAD_OPTION', () => page.text('a', 0, 0, { ...t, colour: '#000' }), 'unbekannte Angabe bei text');
  fails('BAD_OPTION', () => page.text('a', 0, 0, 'Inter'), 'Angaben kein Objekt');
  fails('BAD_OPTION', () => page.rect(0, 0, 1, 1, { fill: '#000', width: 2 }), 'unbekannte Angabe bei rect');
  fails('BAD_OPTION', () => page.line(0, 0, 1, 1, { stroke: '#000' }), 'unbekannte Angabe bei line');
  fails('BAD_OPTION', () => page.path('M0 0L1 1', { stroke: '#000', x: 1, transform: [1, 0, 0, 1, 0, 0] }), 'transform und x zugleich');
  fails('BAD_OPTION', () => page.path('M0 0L1 1', { fill: '#000', fillRule: 'odd' }), 'fillRule');
  fails('BAD_OPTION', () => page.line(0, 0, 1, 1, { dash: [0, 0] }), 'dash');
  fails('BAD_OPTION', () => page.line(0, 0, 1, 1, { lineCap: 'flat' }), 'lineCap');
  fails('BAD_OPTION', () => doc.addPage({ breite: 100 }), 'unbekannte Angabe bei addPage');
  fails('BAD_OPTION', () => new PdfDocument({ titel: 'x' }), 'unbekannte Angabe am Dokument');
  fails('BAD_OPTION', () => new PdfDocument({ createdAt: 'gestern' }), 'kein Datum');
  fails('BAD_OPTION', () => new PdfDocument({ lang: 'deutsch (Deutschland)' }), 'Sprache');
  for (const c of ['red', '#12', '#12345', '#ggg', 'rgb(1,2,3)', [1, 2], [0, 0, 2], [0, -0.1, 0], ['1', 0, 0], 0x112233, {}]) fails('BAD_COLOR', () => page.rect(0, 0, 1, 1, { fill: c }), `Farbe ${JSON.stringify(c)}`);
  fails('BAD_STATE', () => page.restore(), 'restore ohne save');
  same(page.ops.length, 0, 'nach den Fehlern steht etwas auf der Seite');
  page.save();
  fails('BAD_STATE', () => doc.toBuffer(), 'save ohne restore');
  page.restore();
  ok(doc.toBuffer().length > 300, 'nach restore lässt sich die Datei schreiben');
  fails('NO_PAGES', () => new PdfDocument().toBuffer(), 'Dokument ohne Seite');
});

check('Grafik: Rechteck, Linie, Farben, sparsamer Zustand', () => {
  const page = new PdfDocument().addPage({ width: 200, height: 100 });
  page.rect(10, 20, 30, 40, { fill: '#ff0000' }).rect(10, 20, 30, 40, { stroke: '#000', lineWidth: 2 }).rect(50, 20, -30, -10, { fill: '#f00', stroke: [0, 0, 0], lineWidth: 2 });
  page.line(0, 0, 200, 100, { color: '#0000ff', width: 0.5 }).line(0, 0, 200, 100, { color: '#00f', width: 0.5, dash: [3, 2], lineCap: 'round' }).line(0, 5, 9, 5);
  page.rect(0, 0, 5, 5, {}).rect(0, 0, 5, 5, { lineWidth: 3 });      // weder Füllung noch Strich: nichts
  same(page.ops.join(' | '), [
    '1 0 0 rg', '10 40 30 40 re f', '0 0 0 RG', '2 w', '10 40 30 40 re S', '20 80 30 10 re B',
    '0 0 1 RG', '0.5 w', '0 100 m 200 0 l S', '[3 2] 0 d', '1 J', '0 100 m 200 0 l S',
    '0 0 0 RG', '1 w', '[] 0 d', '0 J', '0 95 m 9 95 l S',
  ].join(' | '), 'Inhaltsstrom');
});

check('Grafik: runde Ecken als Bézierkurven, zu große Radien werden gekappt', () => {
  const page = new PdfDocument().addPage({ width: 200, height: 100 });
  const nums = (op) => op.match(/-?[\d.]+/g).map(Number);
  const curves = (op) => [...op.matchAll(/(?:^|[mlc] )([-\d. ]+) l (?:([-\d. ]+) c)?/g)];
  page.rect(0, 0, 100, 50, { fill: '#000', radius: 10 });
  same(page.ops[1], '10 100 m 90 100 l 95.523 100 100 95.523 100 90 c 100 60 l 100 54.477 95.523 50 90 50 c 10 50 l 4.477 50 0 54.477 0 60 c 0 90 l 0 95.523 4.477 100 10 100 c h f', 'Radius 10');
  for (const m of curves(page.ops[1])) {                       // Kurvenmitte liegt auf dem Kreis um den Eckmittelpunkt
    const [x0, y0] = nums(m[1]).slice(-2), [x1, y1, x2, y2, x3, y3] = nums(m[2]);
    const mx = (x0 + 3 * x1 + 3 * x2 + x3) / 8, my = (y0 + 3 * y1 + 3 * y2 + y3) / 8, cx = x0 === x1 ? x3 : x0, cy = y0 === y1 ? y3 : y0;
    near(Math.hypot(mx - cx, my - cy), 10, 'Abstand der Kurvenmitte vom Eckmittelpunkt', 0.005);
  }
  page.rect(0, 0, 20, 10, { fill: '#000', radius: 100 });
  same(page.ops[2], '5 100 m 15 100 l 17.761 100 20 97.761 20 95 c 20 92.239 17.761 90 15 90 c 5 90 l 2.239 90 0 92.239 0 95 c 0 97.761 2.239 100 5 100 c h f', 'Radius 100 an 20 × 10 wird zu 5, ohne Strecken der Länge 0');
  page.rect(0, 0, 100, 50, { fill: '#000', radius: [0, 20, 0, 0] });
  same(page.ops[3], '0 100 m 80 100 l 91.046 100 100 91.046 100 80 c 100 50 l 0 50 l h f', 'nur eine Ecke rund');
  page.rect(0, 0, 0.5, 40, { fill: '#000', radius: [0, 0, 0.1, 0] });
  same(page.ops[4], '0 100 m 0.5 100 l 0.5 60.1 l 0.5 60.045 0.455 60 0.4 60 c 0 60 l h f', 'kleiner Radius an schmalem Rechteck bleibt, wie er ist');
  page.save().clip(10, 10, 50, 20).clip(10, 10, 50, 20, { radius: 4 }).restore();
  same(page.ops[6], '10 70 50 20 re W n', 'Beschnitt');
  ok(/ c h W n$/.test(page.ops[7]) && page.ops[5] === 'q' && page.ops[8] === 'Q', 'Beschnitt mit Radius zwischen q und Q');
  page.rect(0, 0, 1, 1, { fill: '#000' });
  same(page.ops.length, 10, 'Farbe nach restore nicht doppelt gesetzt');
  page.save().rect(0, 0, 1, 1, { fill: '#fff' }).restore().rect(0, 0, 1, 1, { fill: '#fff' });
  same(page.ops.slice(-6).join(' | '), 'q | 1 1 1 rg | 0 99 1 1 re f | Q | 1 1 1 rg | 0 99 1 1 re f', 'Farbe nach restore neu gesetzt');
});

check('Grafik: SVG-Pfad — alle Kommandos, Zahlenformen, Wiederholungen', () => {
  const r = (v) => Math.round(v * 1000) / 1000;
  const flat = (d) => parseSvgPath(d).map((s) => s[0] + s.slice(1).map(r).join(',')).join(' ');
  const cases = [
    ['M10 20L30 40', 'M10,20 L30,40'],
    ['m10 20 30 40-5-5', 'M10,20 L40,60 L35,55'],
    ['M10,20 30,40', 'M10,20 L30,40'],
    [' M 0 0 h 10 v 10 H 0 V 0 z ', 'M0,0 L10,0 L10,10 L0,10 L0,0 Z'],
    ['M1.5.5-.5-1e1L+2,3E0 1e-1.5', 'M1.5,0.5 L-0.5,-10 L2,3 L0.1,0.5'],
    ['M0 0C1 2 3 4 5 6S7 8 9 10', 'M0,0 C1,2,3,4,5,6 C7,8,7,8,9,10'],
    ['M0 0c1 2 3 4 5 6s2 2 4 4', 'M0,0 C1,2,3,4,5,6 C7,8,7,8,9,10'],
    ['M0 0S1 2 3 4', 'M0,0 C0,0,1,2,3,4'],
    ['M0 0L5 5S1 2 3 4', 'M0,0 L5,5 C5,5,1,2,3,4'],
    ['M0 0Q9 0 9 9T18 18', 'M0,0 C6,0,9,3,9,9 C9,15,12,18,18,18'],
    ['M0 0q9 0 9 9t9 9 9 9', 'M0,0 C6,0,9,3,9,9 C9,15,12,18,18,18 C24,18,27,21,27,27'],
    ['M0 0T9 9', 'M0,0 C0,0,3,3,9,9'],
    ['M10 0A10 10 0 0 1 0 10', 'M10,0 C10,5.523,5.523,10,0,10'],
    ['M10 0a10 10 0 01-10 10', 'M10,0 C10,5.523,5.523,10,0,10'],
    ['M10 0a10,10,0,0,1,-10,10', 'M10,0 C10,5.523,5.523,10,0,10'],
    ['M10 0A-10 10 0 0 1 0 10', 'M10,0 C10,5.523,5.523,10,0,10'],          // negative Radien zählen als Betrag
    ['M0 0A5 5 0 1 10 0', 'M0,0'],                                         // Schalter sind einzelne Ziffern: „10“ = Schalter 1, x = 0
    ['M10 0A10 10 0 0 0 0 10', 'M10,0 C4.477,0,0,4.477,0,10'],
    ['M0 0A0 5 0 0 1 10 0', 'M0,0 L10,0'],
    ['M3 4A5 5 0 0 1 3 4', 'M3,4'],
    ['M0 0L10 0L10 10ZL-5-5zm1 1l1 0', 'M0,0 L10,0 L10,10 Z M0,0 L-5,-5 Z M1,1 L2,1'],
    ['M5 5zZ', 'M5,5 Z'],
    ['M0 0M5 5L6 6', 'M0,0 M5,5 L6,6'],
  ];
  for (const [d, want] of cases) same(flat(d), want, `„${d}“`);
  for (const d of ['', '  ', 'L10 10', '10 10', 'M10', 'M10 10 X', 'M0 0,,1 1', 'M,0 0', 'M0 0L1 1,', 'M0 0L', 'M0 0 L 1e 2', 'M0 0A5 5 0 2 1 10 0', 'M0 0A5 5 0 1 1 10', 'M0 0A-5 5 0 1 1 10 0 7', 'M0 0C1 2 3 4 5', 'M0 0 L 1 1 #']) fails('BAD_PATH', () => parseSvgPath(d), `„${d}“`);
  fails('BAD_PATH', () => parseSvgPath(null), 'kein Text');
  return `${cases.length} Pfade`;
});

check('Grafik: SVG-Bögen liegen auf Kreis und Ellipse', () => {
  const at = (p0, c, t) => [0, 1].map((k) => (1 - t) ** 3 * p0[k] + 3 * (1 - t) ** 2 * t * c[1 + k] + 3 * (1 - t) * t * t * c[3 + k] + t ** 3 * c[5 + k]);
  /** Punkte entlang aller Kurven eines Pfades (Anfang, je Kurve 8 Zwischenpunkte, Ende) */
  const sample = (d) => {
    const pts = [];
    let cur = null;
    for (const s of parseSvgPath(d)) {
      if (s[0] === 'C') for (let i = 1; i <= 8; i++) pts.push(at(cur, s, i / 8));
      else pts.push(s.slice(1, 3));
      cur = s.slice(-2);
    }
    return pts;
  };
  const circles = [                                  // Pfad, Mittelpunkt, Radius, Zahl der Kurven
    ['M10 0A10 10 0 0 1 0 10', [0, 0], 10, 1], ['M10 0A10 10 0 1 1 -10 0', [0, 0], 10, 2], ['M10 0A10 10 0 1 0 0 10', [0, 0], 10, 3],
    ['M0 0A1 1 0 0 1 10 0', [5, 0], 5, 2],           // Radius zu klein → wird vergrößert
    ['M30 20a8 8 0 1 0 16 0a8 8 0 1 0-16 0', [38, 20], 8, 4], ['M1 0A1 1 0 0 1 0.9999 0.0141', [0, 0], 1, 1],
  ];
  for (const [d, c, radius, n] of circles) {
    same(parseSvgPath(d).filter((s) => s[0] === 'C').length, n, `„${d}“: Zahl der Kurven`);
    for (const p of sample(d)) near(Math.hypot(p[0] - c[0], p[1] - c[1]), radius, `„${d}“: Abstand vom Mittelpunkt`, radius * 3e-4);
  }
  // Gedrehte Ellipse: zurückgedreht und auf den Einheitskreis gestaucht müssen alle Punkte denselben Mittelpunkt haben
  for (const [d, rx, ry, deg] of [['M0 30A30 15 -30 0 1 52 10', 30, 15, -30], ['M5 5a40 12 75 1 0 20 -9', 40, 12, 75], ['M0 0A20 10 30 1 1 30 5', 20, 10, 30]]) {
    const phi = deg * Math.PI / 180, unit = sample(d).map(([x, y]) => [(Math.cos(phi) * x + Math.sin(phi) * y) / rx, (-Math.sin(phi) * x + Math.cos(phi) * y) / ry]);
    const [a, b, c] = [unit[0], unit[unit.length >> 1], unit.at(-1)];
    const dd = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])), sq = (p) => p[0] * p[0] + p[1] * p[1];
    const ux = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / dd, uy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / dd;
    for (const p of unit) near(Math.hypot(p[0] - ux, p[1] - uy), 1, `„${d}“: Abstand vom Mittelpunkt (Einheitskreis)`, 1e-3);
  }
  const end = parseSvgPath('M0 0A20 10 30 1 1 30 5').at(-1);
  same(`${end[5]} ${end[6]}`, '30 5', 'Bogen endet genau im angegebenen Punkt');
});

check('Grafik: Pfad mit Lage, Maßstab und Matrix; Logo in zwei Größen', () => {
  const page = new PdfDocument().addPage({ width: 200, height: 100 });
  page.path('M0 0L10 0L10 10Z', { fill: '#000' }).path('M0 0L10 0L10 10Z', { x: 20, y: 30, scale: 2, stroke: '#000', lineWidth: 0.5 });
  page.path('M0 0L10 0L10 10Z', { scale: [2, 0.5], fill: '#000', fillRule: 'evenodd' }).path('M0 0L10 0', { transform: [0, 1, -1, 0, 50, 50], fill: '#000', stroke: '#000', fillRule: 'evenodd' });
  same(page.ops.filter((o) => /^\d/.test(o) && / [mlc]/.test(o)).join(' | '), '0 100 m\n10 100 l\n10 90 l\nh f | 20 70 m\n40 70 l\n40 50 l\nh S | 0 100 m\n20 100 l\n20 95 l\nh f* | 50 50 m\n50 40 l B*', 'Pfade');
  const l = logo(), big = new PdfDocument().addPage(), tiny = new PdfDocument().addPage();
  same(`${l.width} × ${l.height}, ${l.paths.length} Pfade, ${l.paths.map((p) => p.fill).join(' ')}`, '377.6 × 100, 2 Pfade, #c86f4a #211d18', 'Logo-Datei');
  near(drawLogo(big, 40, 40, 377.6), 100, 'Höhe in Originalgröße');
  drawLogo(tiny, 40, 40, 37.76);
  same(big.ops.join(' ').replace(/[^mlch]/g, '').length, tiny.ops.join(' ').replace(/[^mlch]/g, '').length, 'gleich viele Abschnitte in beiden Größen');
  const xs = (p) => p.ops.join('\n').split('\n').filter((o) => / [mlc]$/.test(o)).map((o) => Number(o.split(' ').at(-3)));     // x der Endpunkte (ohne Kontrollpunkte)
  const [bx, tx] = [xs(big), xs(tiny)];
  near(Math.max(...bx) - 40, (Math.max(...tx) - 40) * 10, 'Breite skaliert genau mit', 0.02);
  ok(Math.min(...bx) >= 39.5 && Math.max(...bx) <= 40 + 377.6 + 0.5, `Logo liegt nicht im erwarteten Bereich: ${Math.min(...bx)}–${Math.max(...bx)}`);
  ok(big.ops.every((o) => !/^\d/.test(o) || o.endsWith('f*') || / r?g$/.test(o)), 'Logo wird nicht mit evenodd gefüllt');
});

check('Verweise: Link-Anmerkung ohne Rahmen; nur http, https, mailto, tel', () => {
  const doc = new PdfDocument({ createdAt: STAMP }), page = doc.addPage({ width: 200, height: 100 });
  page.link(10, 20, 100, 12, 'https://www.example.com/a(b)c?x=ä&y=1#z').link(10, 40, 50, 10, 'mailto:hallo@example.com?subject=Frage zur Bestellung').link(60, 50, -50, -10, 'tel:+49 30 1234567').link(0, 0, 1, 1, 'HTTP://Example.com');
  const pdf = readPdf(doc.toBuffer()), a = pdf.pages[0].annots;
  same(a[0], '<< /Type /Annot /Subtype /Link /Rect [10 68 110 80] /Border [0 0 0] /F 4 /A << /Type /Action /S /URI /URI (https://www.example.com/a\\(b\\)c?x=%C3%A4&y=1#z) >> >>', 'Anmerkung');
  ok(a[1].includes('/URI (mailto:hallo@example.com?subject=Frage%20zur%20Bestellung)') && a[2].includes('/Rect [10 50 60 60]') && a[2].includes('/URI (tel:+49%2030%201234567)') && a[3].includes('/URI (http://example.com/)'), `mailto/tel/http: ${a.slice(1).join(' ')}`);
  const bad = ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://example.com/', '/agb', '#inhalt', 'www.example.com', '', 'https://', null, undefined, 42];
  for (const url of bad) fails('BAD_LINK', () => page.link(0, 0, 10, 10, url), `Verweis ${String(url)}`);
  same(page.links.length, 4, 'abgelehnte Verweise hinterlassen nichts');
});

// ---------------------------------------------------------------------------
// Prüfungen: Datei
// ---------------------------------------------------------------------------
check('Datei: Info und Katalog — Titel als UTF-16, Maskierung, Datum nur aus createdAt', () => {
  const meta = { title: 'Größe (klein) \\ „groß“', author: 'formsam (Test) \\ Co', subject: 'Zeile\n2', keywords: ['Vase', 'Düne'], creator: 'tools/test-pdf.mjs' };
  const info = (m) => readPdf(new PdfDocument(m).addPage().doc.toBuffer()).objs[3].dict;
  const utf16 = (s) => `<${Buffer.from(`\uFEFF${s}`, 'utf16le').swap16().toString('hex').toUpperCase()}>`;
  same(info({ ...meta, createdAt: STAMP }), `<< /Title ${utf16('Größe (klein) \\ „groß“')} /Author (formsam \\(Test\\) \\\\ Co) /Subject (Zeile 2) /Keywords ${utf16('Vase, Düne')} /Creator (tools/test-pdf.mjs) /Producer (formsam) /CreationDate (D:20260115093000Z) /ModDate (D:20260115093000Z) >>`, 'Info mit Datum');
  same(info({}), '<< /Producer (formsam) >>', 'Info ohne Angaben: kein Datum, die Uhr wird nicht gelesen');
  same(info({ createdAt: new Date(STAMP) }), info({ createdAt: Date.parse(STAMP) }), 'Datum als Date und als Millisekunden');
  same(info({ createdAt: '2026-01-15T10:30:00+01:00' }), info({ createdAt: STAMP }), 'Zeitzone wird nach Weltzeit umgerechnet');
  const catalog = (m) => readPdf(new PdfDocument(m).addPage().doc.toBuffer()).objs[1].dict;
  same(catalog({}), '<< /Type /Catalog /Pages 2 0 R /Lang (de-DE) /ViewerPreferences << /DisplayDocTitle true >> >>', 'Katalog');
  ok(catalog({ lang: 'en' }).includes('/Lang (en) '), 'Sprache einstellbar');
});

check('Datei: gleiche Eingabe → bytegleiche Ausgabe', () => {
  const a = mixedDoc(), b = typicalDoc(), c = mixedDoc();
  ok(a.pdf.equals(c.pdf), 'gemischte Seite: zweiter Lauf weicht ab');
  ok(a.pdf.equals(a.doc.toBuffer()) && a.pdf.equals(a.doc.toBuffer()), 'toBuffer() zweimal: Ausgabe weicht ab');
  ok(b.equals(typicalDoc()), 'typische Seite: zweiter Lauf weicht ab');
  const id = (m) => readPdf(new PdfDocument(m).addPage().doc.toBuffer()).id;
  ok(id({ title: 'a' }) === id({ title: 'a' }) && id({ title: 'a' }) !== id({ title: 'b' }) && id({ createdAt: STAMP }) !== id({ createdAt: '2026-01-15T09:30:01Z' }), '/ID folgt nicht allein dem Inhalt');
  const tag = (s) => { const d = new PdfDocument(); d.addPage().text(s, 10, 10, { font: 'Inter', size: 10 }); return /\/BaseFont \/([A-Z]{6})\+Inter-Regular/.exec(d.toBuffer().latin1Slice())[1]; };
  ok(tag('abc') === tag('abc') && tag('abc') === tag('abcabc') && tag('abc') !== tag('abd') && tag('abc') !== tag('acb'), 'Teilmengen-Kennung folgt nicht allein den benutzten Zeichen');
});

const docs = {};        // Ergebnisse der Probe-Dokumente für die späteren Prüfungen
for (const name of FONTS) {
  check(`Alle Zeichen: ${name} — jedes Zeichen kommt genau so oft zurück, wie es hineinging`, () => {
    const t0 = performance.now(), d = allCharsDoc(name), time = performance.now() - t0, pdf = readPdf(keep(`alle-zeichen-${name}.pdf`, d.pdf));
    ok(d.widest <= A4.width - 80, `breiteste Zeile ${d.widest.toFixed(1)} pt passt nicht auf die Seite`);
    const lines = pdf.pages.flatMap((p) => readTexts(pdf, p).map((t) => t.text));
    same(lines.join('\n'), d.lines.map(expected).join('\n'), 'Text aus Inhaltsstrom und ToUnicode');
    const font = readFont(pdf, pdf.pages[0].fonts.F1), orig = readSfnt(fontFile(name), false), f = getFont(name);
    same(Object.keys(pdf.pages[0].fonts).join(), 'F1', 'genau eine Schrift');
    const used = [...new Set(cpsOf(lines.join(' ')))];                 // Reihenfolge der ersten Benutzung = Codes 1…n
    same(font.unicode.size, used.length, 'ToUnicode-Einträge');
    used.forEach((cp, i) => same(font.unicode.get(i + 1), String.fromCodePoint(cp), `ToUnicode für Code ${i + 1}`));
    const sub = readSfnt(font.file, true), gids = [0, ...used.map((cp) => f.glyph(cp) || f.glyph(0x20))];
    ok(sub.num >= gids.length && font.widths.length === sub.num, 'Glyphenzahl und /W');
    const slots = [...gids];
    for (let i = 0; i < sub.num; i++) {                                   // angehängte Bauteile: alte Nummer aus der Mutterglyphe
      const old = components(orig.glyph(slots[i]));
      components(sub.glyph(i)).forEach((part, j) => { slots[part.gid] ??= old[j].gid; });
    }
    compareSubset(sub, orig, slots);
    slots.forEach((g, i) => same(font.widths[i], Math.round(orig.advance(g) * 1000 / orig.upm), `/W für Platz ${i}`));
    docs[name] = d;
    return `${d.cps.length} Zeichen, ${d.pages} Seiten, ${kb(d.pdf.length)}, ${ms(time)}`;
  });
}

check('Gemischte Seite: sechs Schnitte, Logo, Verweis; Messen = Zeichnen für jeden Text', () => {
  const t0 = performance.now(), m = mixedDoc(), time = performance.now() - t0, pdf = readPdf(keep('gemischt.pdf', m.pdf)), page = pdf.pages[0], texts = readTexts(pdf, page);
  same(Object.keys(page.fonts).length, 6, 'Schriften auf der Seite');
  same(texts.length, m.widths.length, 'Zahl der Textblöcke');
  m.widths.forEach(([str, opts, w], i) => {
    same(texts[i].text, expected(str), `Text ${i + 1}`);
    near(texts[i].width, w, `Breite von „${str}“`);
    same(w, measureText(str, opts), `measureText für „${str}“`);
  });
  same(page.annots.length, 1, 'Verweise');
  ok(page.annots[0].includes('/URI (https://www.formsam.com/)'), 'Ziel des Verweises');
  return `${texts.length} Texte, ${kb(m.pdf.length)}, ${ms(time)}`;
});

check('Drei Seiten in drei Formaten', () => {
  const t0 = performance.now(), buf = threePagesDoc(), time = performance.now() - t0, pdf = readPdf(keep('drei-seiten.pdf', buf));
  same(pdf.pages.map((p) => `${p.width}×${p.height}`).join(' '), '595.276×841.89 595.276×419.528 226.772×566.929', 'Seitenmaße');
  same(pdf.pages.map((p) => readTexts(pdf, p)[0].text).join(', '), 'A4 hoch, A5 quer, Bon 80 mm', 'Texte je Seite');
  pdf.pages.forEach((p) => { const t = readTexts(pdf, p)[2]; near(t.x + t.width, p.width - 24, 'rechtsbündig über measureText', 0.001); near(t.y, 24, 'Abstand von unten', 0.001); });
  return `${kb(buf.length)}, ${ms(time)}`;
});

check('Dokument ohne Text: keine Schrift in der Datei', () => {
  const t0 = performance.now(), buf = keep('ohne-text.pdf', noTextDoc()), time = performance.now() - t0, pdf = readPdf(buf);
  same(pdf.size, 6, 'Objekte (Katalog, Seitenbaum, Info, Seite, Inhalt + Eintrag 0)');
  ok(pdf.pages[0].dict.includes('/Resources << >>') && !buf.latin1Slice().includes('/Font'), 'Schrift-Angaben in einer Datei ohne Text');
  const empty = readPdf(new PdfDocument().addPage().doc.toBuffer());
  same(empty.pages[0].content, '', 'leere Seite');
  const unused = new PdfDocument();
  unused.addPage();
  unused.useFont('Inter-Bold');
  ok(!unused.toBuffer().latin1Slice().includes('/Font'), 'angemeldete, aber nie benutzte Schrift steht in der Datei');
  fails('BAD_FONT', () => unused.useFont(null), 'useFont ohne Schrift');
  return `${kb(buf.length)}, ${ms(time)}`;
});

check('300 Seiten Text', () => {
  const t0 = performance.now(), d = longDoc(), time = performance.now() - t0, pdf = readPdf(keep('300-seiten.pdf', d.pdf));
  same(pdf.pages.length, 300, 'Seiten');
  same(pdf.size, 4 + 300 * 2 + 2 * 5, 'Objekte');
  for (const i of [0, 149, 299]) same(readTexts(pdf, pdf.pages[i]).map((t) => t.text).join('\n'), d.lines.slice(i * 46, i * 46 + 46).join('\n'), `Text der Seite ${i + 1}`);
  docs.long = d;
  ok(time < 10000, `dauert ${ms(time)}`);
  return `${d.lines.join('').length} Zeichen, ${ms(time)}, ${kb(d.pdf.length)}`;
});

check('Typische Belegseite: klein und schnell', () => {
  const pdf = keep('typisch.pdf', typicalDoc()), chars = TYPICAL.reduce((n, l) => n + l[2].length, 0), times = [];
  for (let i = 0; i < 40; i++) { const t0 = performance.now(); typicalDoc(); times.push(performance.now() - t0); }
  times.sort((a, b) => a - b);
  const read = readPdf(pdf), texts = readTexts(read, read.pages[0]);
  same(texts.map((t) => t.text).join('\n'), TYPICAL.map((l) => l[2]).join('\n'), 'Text');
  same(Object.keys(read.pages[0].fonts).length, 3, 'Schnitte');
  ok(chars >= 1100 && chars <= 1400, `Probe hat ${chars} statt rund 1200 Zeichen`);
  ok(pdf.length < 60 * 1024, `Datei hat ${kb(pdf.length)} — Grenze 60 KB`);
  ok(times[20] < 200, `Median ${ms(times[20])} je Dokument — Grenze 200 ms`);
  return `${chars} Zeichen, ${kb(pdf.length)}, ${ms(times[20])} je Dokument (Median aus 40 Läufen, schnellster ${ms(times[0])})`;
});

// ---------------------------------------------------------------------------
// Prüfungen mit poppler (nur wenn installiert)
// ---------------------------------------------------------------------------
const has = (cmd) => !spawnSync(cmd, ['-v'], { stdio: 'ignore' }).error;
const poppler = Object.fromEntries(['pdftotext', 'pdffonts', 'pdfinfo'].map((cmd) => [cmd, has(cmd)]));
// Dateien entstehen nur, wenn sie jemand braucht: mit --out oder für poppler (dann in einem Ordner, der am Ende wieder verschwindet)
const dir = outDir ? path.resolve(outDir) : Object.values(poppler).some(Boolean) ? fs.mkdtempSync(path.join(os.tmpdir(), 'formsam-pdf-')) : '';
if (dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, pdf] of built) fs.writeFileSync(path.join(dir, name), pdf);
}
/** poppler-Programm auf eine Probe-Datei loslassen; jede Meldung auf stderr gilt als Fehler */
function run(cmd, name, ...opts) {
  const r = spawnSync(cmd, [...opts, path.join(dir, name), ...(cmd === 'pdftotext' ? ['-'] : [])], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  ok(!r.error && r.status === 0 && !r.stderr.trim(), `${cmd} ${name}: ${r.error?.message || r.stderr.trim() || `Exit ${r.status}`}`);
  return r.stdout;
}
const textLines = (s) => s.split(/[\n\f]/).map((l) => l.trim()).filter(Boolean);

try {
  if (poppler.pdftotext) {
    check('pdftotext: Text der Belegseite und der 300 Seiten kommt exakt zurück', () => {
      same(textLines(run('pdftotext', 'typisch.pdf', '-enc', 'UTF-8')).join('\n'), TYPICAL.map((l) => l[2]).join('\n'), 'typische Belegseite');
      const long = textLines(run('pdftotext', '300-seiten.pdf', '-enc', 'UTF-8'));
      same(long.length, docs.long.lines.length, '300 Seiten: Zeilenzahl');
      long.forEach((l, i) => same(l, docs.long.lines[i], `300 Seiten: Zeile ${i + 1}`));
      ok(run('pdftotext', 'gemischt.pdf', '-enc', 'UTF-8').includes('Größe Ελένη Олена → 12,50 € ✓'), 'gemischte Seite: Zeile mit Schriftkette');
      return `${long.length + TYPICAL.length} Zeilen`;
    });
    check('pdftotext: alle Zeichen aller sechs Schnitte kommen einzeln zurück', () => {
      let n = 0;
      for (const name of FONTS) {
        const want = new Map(), got = new Map();
        // Leerraum zählt nicht mit: Leerzeichen setzt pdftotext selbst aus den Abständen neu
        const count = (map, s) => { for (const ch of s) if (!/\s/u.test(ch)) map.set(ch, (map.get(ch) ?? 0) + 1); };
        count(want, docs[name].lines.map(expected).join(' '));
        count(got, run('pdftotext', `alle-zeichen-${name}.pdf`, '-enc', 'UTF-8'));
        const diff = [...new Set([...want.keys(), ...got.keys()])].filter((ch) => want.get(ch) !== got.get(ch));
        ok(!diff.length, `${name}: ${diff.slice(0, 12).map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} ${got.get(ch) ?? 0}× statt ${want.get(ch) ?? 0}×`).join(', ')}`);
        n += want.size;
      }
      return `${n} verschiedene Zeichen`;
    });
  } else console.log('--      pdftotext nicht installiert — Prüfung entfällt');

  if (poppler.pdffonts) {
    check('pdffonts: alle Schriften eingebettet, als Teilmenge, mit Unicode-Tabelle', () => {
      let n = 0;
      const want = { 'gemischt.pdf': 6, 'drei-seiten.pdf': 2, 'ohne-text.pdf': 0, '300-seiten.pdf': 2, 'typisch.pdf': 3 };
      for (const name of built.keys()) {
        const rows = run('pdffonts', name).split('\n').slice(2).filter(Boolean);
        same(rows.length, want[name] ?? 1, `${name}: Zahl der Schriften`);
        for (const row of rows) ok(/^[A-Z]{6}\+\S+ +CID TrueType +Identity-H +yes yes yes /.test(row), `${name}: ${row}`);
        n += rows.length;
      }
      return `${n} Schriften in ${built.size} Dateien`;
    });
  } else console.log('--      pdffonts nicht installiert — Prüfung entfällt');

  if (poppler.pdfinfo) {
    check('pdfinfo: Titel, Datum, Seitenzahl und Seitenmaße', () => {
      const info = run('pdfinfo', 'drei-seiten.pdf', '-l', '3', '-isodates');
      for (const want of [/^Title: +Drei Seiten, drei Formate$/m, /^Author: +formsam$/m, /^Producer: +formsam$/m, /^CreationDate: +2026-01-15T09:30:00Z$/m, /^Pages: +3$/m, /^PDF version: +1\.7$/m,
        /^Page +1 size: +595\.276 x 841\.89 pts \(A4\)$/m, /^Page +2 size: +595\.276 x 419\.528 pts/m, /^Page +3 size: +226\.772 x 566\.929 pts/m]) ok(want.test(info), `pdfinfo: ${want} fehlt`);
      ok(/^Title: +Gemischte Seite$/m.test(run('pdfinfo', 'gemischt.pdf')) && /^Pages: +300$/m.test(run('pdfinfo', '300-seiten.pdf')), 'Titel oder Seitenzahl der anderen Dateien');
    });
  } else console.log('--      pdfinfo nicht installiert — Prüfung entfällt');
} finally {
  if (dir && !outDir) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} von ${total} Prüfungen fehlgeschlagen` : `\nalle ${total} Prüfungen bestanden${outDir ? ` — PDFs in ${dir}` : ''}`);
process.exit(failed ? 1 : 0);
