// formsam — PDF-Kern: eigener kleiner PDF-Schreiber mit eingebetteten Teilmengen-Schriften (nur Node-Built-ins)
//
//   import { PdfDocument, measureText, fontMetrics } from './lib/pdf.js';
//   const doc = new PdfDocument({ title: 'Rechnung RE-2026-0001', author: 'formsam', createdAt: order.createdAt });
//   const page = doc.addPage();                                            // A4; alle Maße in PDF-Punkten (1/72 Zoll)
//   const font = [{ family: 'Fraunces', weight: 500 }, 'Inter-Regular'];   // Kette: je Zeichen die erste Schrift, die es hat
//   const w = page.text('Größe Ελένη', 40, 60, { font, size: 16.5, color: '#211d18' });   // x, Grundlinie → Breite
//   page.rect(40, 66, w, 1.5, { fill: '#c86f4a' });
//   const pdf = doc.toBuffer();
//
// Exporte: PdfDocument (addPage, toBuffer) · Seite: text, rect, line, path, link, save, restore, clip ·
//   measureText, missingChars, fontMetrics, composeText, isIgnorable · getFont, findFont, registerFont · parseFont, subsetFont,
//   parseSvgPath · A4, mm · PdfError (.code)
// Koordinaten der Schnittstelle: Ursprung OBEN LINKS, y nach unten (wie CSS); umgerechnet wird beim Schreiben.
// Grundsätze: lieber keine PDF als eine falsche (PdfError mit .code — nie ein Kästchen oder Fragezeichen),
// gleiche Eingabe → bytegleiche Datei (kein Date.now, kein Zufall), Schriften nur als Teilmenge der benutzten Zeichen.
// Bewusst NICHT enthalten: Rasterbilder, Transparenz, Ligaturen/Unterschneidung, Schreibrichtung rechts-nach-links.
//
// Aufbau: 1. TrueType-Leser · 2. Teilmengen-Bildner · 3. PDF-Schreiber (Schriften, Text, Grafik, Datei)
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

/** Alle Fehler dieses Moduls. code: GLYPH_MISSING (mit .char, .codePoint) | BAD_NUMBER | BAD_FONT | BAD_COLOR |
 *  BAD_LINK | BAD_PATH | BAD_TEXT | BAD_OPTION | BAD_STATE | NO_PAGES */
export class PdfError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// 1. TrueType-Leser
// ---------------------------------------------------------------------------

/** Liest eine TrueType-Datei (.ttf mit glyf-Umrissen) → Schriftobjekt. info: { name, family, weight, serif }. */
export function parseFont(data, info = {}) {
  const bad = (msg) => new PdfError('BAD_FONT', `Schrift „${info.name || 'ohne Namen'}“: ${msg}`);
  if (!Buffer.isBuffer(data)) {
    if (!(data instanceof Uint8Array)) throw bad('keine Binärdaten');
    data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  try { return readFont(data, info, bad); } catch (e) {
    throw e instanceof PdfError ? e : bad(`Datei beschädigt (${e.message})`);   // z. B. Lesen über das Tabellenende hinaus
  }
}

function readFont(data, info, bad) {
  const version = data.readUInt32BE(0);
  if (version !== 0x00010000 && version !== 0x74727565) throw bad('keine TrueType-Datei mit glyf-Umrissen (OTF/CFF, TTC und WOFF gehen nicht)');
  const tables = new Map();
  for (let i = 0, n = data.readUInt16BE(4); i < n; i++) {
    const o = 12 + i * 16, tag = data.latin1Slice(o, o + 4), offset = data.readUInt32BE(o + 8), length = data.readUInt32BE(o + 12);
    if (offset + length > data.length) throw bad(`Tabelle ${tag.trim()} ragt über das Dateiende`);
    tables.set(tag, data.subarray(offset, offset + length));
  }
  const table = (tag, min) => {
    const t = tables.get(tag);
    if (!t || t.length < min) throw bad(`Tabelle ${tag.trim()} fehlt oder ist zu kurz`);
    return t;
  };
  const head = table('head', 54), hhea = table('hhea', 36), maxp = table('maxp', 6), hmtx = table('hmtx', 4);
  const cmapT = table('cmap', 4), locaT = table('loca', 2), glyf = table('glyf', 0);
  if (tables.has('fvar')) throw bad('variable Schrift – gesetzt würde still nur die Grundinstanz; vorher einen festen Schnitt erzeugen (z. B. fontTools instancer)');
  if (head.readUInt32BE(12) !== 0x5F0F3CF5) throw bad('head-Tabelle ungültig');
  const unitsPerEm = head.readUInt16BE(18), numGlyphs = maxp.readUInt16BE(4), numberOfHMetrics = hhea.readUInt16BE(34);
  if (unitsPerEm < 16 || unitsPerEm > 16384 || !numGlyphs || !numberOfHMetrics || numberOfHMetrics > numGlyphs) throw bad('Kopfdaten unplausibel');

  // loca: Lage jeder Glyphe in glyf (kurzes Format zählt in Zwei-Byte-Schritten)
  const long = head.readInt16BE(50) === 1;
  const loca = new Uint32Array(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i++) {
    loca[i] = long ? locaT.readUInt32BE(i * 4) : locaT.readUInt16BE(i * 2) * 2;
    if (loca[i] > glyf.length || (i && loca[i] < loca[i - 1])) throw bad('loca-Tabelle zeigt ins Leere');
  }

  // hmtx: Vorschub und linker Rand je Glyphe; nach numberOfHMetrics gilt der letzte Vorschub weiter
  const advances = new Uint16Array(numGlyphs), lsbs = new Int16Array(numGlyphs), widths = new Uint16Array(numGlyphs);
  for (let i = 0; i < numGlyphs; i++) {
    const m = Math.min(i, numberOfHMetrics - 1);
    advances[i] = hmtx.readUInt16BE(m * 4);
    lsbs[i] = i < numberOfHMetrics ? hmtx.readInt16BE(i * 4 + 2) : hmtx.readInt16BE(numberOfHMetrics * 4 + (i - numberOfHMetrics) * 2);
    widths[i] = Math.round(advances[i] * 1000 / unitsPerEm);   // ganzzahlig — genau diese Zahl steht später in /W
  }

  // cmap: beste Unicode-Tabelle (Format 12 mit vollem Umfang vor Format 4, Windows vor Unicode-Plattform)
  let best = null;
  for (let i = 0, n = cmapT.readUInt16BE(2); i < n; i++) {
    const p = cmapT.readUInt16BE(4 + i * 8), e = cmapT.readUInt16BE(6 + i * 8), o = cmapT.readUInt32BE(8 + i * 8), f = cmapT.readUInt16BE(o);
    const rank = f === 12 && ((p === 3 && e === 10) || (p === 0 && (e === 4 || e === 6))) ? (p === 3 ? 4 : 3)
      : f === 4 && ((p === 3 && e === 1) || (p === 0 && e <= 4)) ? (p === 3 ? 2 : 1) : 0;
    if (rank > (best ? best.rank : 0)) best = { rank, o, f };
  }
  if (!best) throw bad('keine Unicode-Zeichentabelle (cmap Format 4 oder 12)');
  const cmap = new Map();
  const map = (cp, gid) => { if (gid > 0 && gid < numGlyphs) cmap.set(cp, gid); };
  if (best.f === 4) {
    const segs = cmapT.readUInt16BE(best.o + 6) >> 1;
    const ends = best.o + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ranges = deltas + segs * 2;
    for (let s = 0; s < segs; s++) {
      const end = cmapT.readUInt16BE(ends + s * 2), start = cmapT.readUInt16BE(starts + s * 2);
      const delta = cmapT.readUInt16BE(deltas + s * 2), range = cmapT.readUInt16BE(ranges + s * 2);
      for (let c = start; c <= end && c < 0xFFFF; c++) {
        if (!range) { map(c, (c + delta) & 0xFFFF); continue; }
        const g = cmapT.readUInt16BE(ranges + s * 2 + range + (c - start) * 2);
        if (g) map(c, (g + delta) & 0xFFFF);
      }
    }
  } else {
    for (let g = 0, n = cmapT.readUInt32BE(best.o + 12); g < n; g++) {
      const o = best.o + 16 + g * 12, start = cmapT.readUInt32BE(o), end = cmapT.readUInt32BE(o + 4), first = cmapT.readUInt32BE(o + 8);
      if (end < start || end > 0x10FFFF) throw bad('cmap-Gruppe ungültig');
      for (let c = start; c <= end; c++) map(c, first + (c - start));
    }
  }
  if (!cmap.size) throw bad('Zeichentabelle ist leer');

  // OS/2 (darf bei alten Schriften fehlen — dann gelten die hhea-Werte)
  const os2 = tables.get('OS/2'), o2 = os2 && os2.length >= 78 ? os2 : null;
  const fsType = o2 ? o2.readUInt16BE(8) : 0;
  if ((fsType & 0x000E) === 0x0002 || (fsType & 0x0300)) throw bad('Lizenzangabe der Schrift (OS/2 fsType) verbietet das Einbetten als Teilmenge');
  const ascender = hhea.readInt16BE(4), descender = hhea.readInt16BE(6), lineGap = hhea.readInt16BE(8);
  const glyphTop = (ch) => { const g = cmap.get(ch.charCodeAt(0)); return g && loca[g + 1] - loca[g] >= 10 ? glyf.readInt16BE(loca[g] + 8) : 0; };
  const v2 = o2 && o2.readUInt16BE(0) >= 2 && o2.length >= 90;
  const familyClass = o2 ? o2.readInt16BE(30) >> 8 : 0;
  const post = tables.get('post'), p = post && post.length >= 16 ? post : null;

  // name: PostScript-Name (6) und Familie (1) — Windows/Englisch bevorzugt
  const names = {}, score = {};
  const nameT = tables.get('name');
  for (let i = 0, n = nameT && nameT.length >= 6 ? nameT.readUInt16BE(2) : 0; i < n; i++) {
    const r = 6 + i * 12, platform = nameT.readUInt16BE(r), id = nameT.readUInt16BE(r + 6);
    const s = platform === 3 ? (nameT.readUInt16BE(r + 4) === 0x409 ? 4 : 3) : platform === 0 ? 2 : 1;
    if ((id !== 1 && id !== 6) || s <= (score[id] || 0)) continue;
    const o = nameT.readUInt16BE(4) + nameT.readUInt16BE(r + 10), raw = nameT.subarray(o, o + nameT.readUInt16BE(r + 8));
    names[id] = platform === 1 ? raw.latin1Slice() : Buffer.from(raw.subarray(0, raw.length & ~1)).swap16().toString('utf16le');
    score[id] = s;
  }
  const weightClass = o2 ? o2.readUInt16BE(4) : 400;
  const postScriptName = String(names[6] || info.name || 'Schrift').replace(/[^\x21-\x7e]|[()<>[\]{}/%#]/g, '').slice(0, 63) || 'Schrift';

  return {
    name: info.name || postScriptName,                 // Name in der Registratur
    family: info.family || names[1] || postScriptName,
    weight: info.weight || weightClass,
    serif: info.serif ?? (familyClass >= 1 && familyClass <= 7),
    postScriptName, unitsPerEm, numGlyphs, weightClass,
    bbox: [36, 38, 40, 42].map((o) => head.readInt16BE(o)),          // xMin, yMin, xMax, yMax
    ascender, descender, lineGap,                                    // hhea
    typoAscender: o2 ? o2.readInt16BE(68) : ascender, typoDescender: o2 ? o2.readInt16BE(70) : descender, typoLineGap: o2 ? o2.readInt16BE(72) : lineGap,
    winAscent: o2 ? o2.readUInt16BE(74) : ascender, winDescent: o2 ? o2.readUInt16BE(76) : -descender,
    useTypoMetrics: !!(o2 && o2.readUInt16BE(62) & 0x80),
    capHeight: (v2 && o2.readInt16BE(88)) || glyphTop('H') || Math.round(ascender * 0.7),
    xHeight: (v2 && o2.readInt16BE(86)) || glyphTop('x') || Math.round(ascender * 0.5),
    strikeoutPosition: o2 ? o2.readInt16BE(28) : Math.round(ascender * 0.3), strikeoutSize: o2 ? o2.readInt16BE(26) : Math.round(unitsPerEm / 20),
    underlinePosition: p ? p.readInt16BE(8) : -Math.round(unitsPerEm / 10), underlineThickness: p ? p.readInt16BE(10) : Math.round(unitsPerEm / 20),
    italicAngle: p ? p.readInt32BE(4) / 65536 : 0, fixedPitch: !!(p && p.readUInt32BE(12)),
    cmap, advances, lsbs, widths, loca, tables,
    /** Glyphennummer zum Codepunkt, 0 = fehlt */
    glyph: (cp) => cmap.get(cp) || 0,
    /** Vorschub einer Glyphe in Schrifteinheiten (unitsPerEm) */
    advance: (gid) => advances[gid] || 0,
  };
}

// ---------------------------------------------------------------------------
// 2. Teilmengen-Bildner
// ---------------------------------------------------------------------------
const pad4 = (b) => (b.length & 3 ? Buffer.concat([b, Buffer.alloc(4 - (b.length & 3))]) : b);

/** Tabellen-Prüfsumme: Summe der 32-Bit-Wörter (Länge muss durch 4 teilbar sein) */
function checksum(b) {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) sum = (sum + b.readUInt32BE(i)) >>> 0;
  return sum;
}

/** Kleine gültige TrueType-Datei für /FontFile2. gids: alte Glyphennummer je Platz 1…n (Platz 0 ist immer .notdef);
 *  dieselbe Glyphe darf mehrfach vorkommen und wird dann mehrfach abgelegt (ein Platz je ZEICHEN). Bauteile
 *  zusammengesetzter Glyphen kommen hinten dazu, ihre Verweise werden umnummeriert.
 *  → { data, glyphs } — glyphs[neuer Platz] = alte Glyphennummer */
export function subsetFont(font, gids) {
  const bad = (msg) => new PdfError('BAD_FONT', `Schrift „${font.name}“: ${msg}`);
  try { return buildSubset(font, gids, bad); } catch (e) {
    throw e instanceof PdfError ? e : bad(`Glyphendaten beschädigt (${e.message})`);
  }
}

function buildSubset(font, gids, bad) {
  const { tables, loca, numGlyphs } = font, glyf = tables.get('glyf');
  const glyphs = [0, ...gids], place = new Map();        // place: alte Nummer → erster Platz (für Bauteil-Verweise)
  glyphs.forEach((g, i) => {
    if (!Number.isInteger(g) || g < 0 || g >= numGlyphs) throw bad(`Glyphe ${g} gibt es nicht`);
    if (!place.has(g)) place.set(g, i);
  });
  const parts = [];
  for (let i = 0; i < glyphs.length; i++) {              // glyphs wächst, während Bauteile dazukommen (auch verschachtelt)
    let g = glyf.subarray(loca[glyphs[i]], loca[glyphs[i] + 1]);
    if (g.length && g.length < 10) throw bad('Glyphe abgeschnitten');
    if (g.length && g.readInt16BE(0) < 0) {              // zusammengesetzt: Bauteil-Nummern in einer Kopie umschreiben
      g = Buffer.from(g);
      for (let p = 10, flags = 0x20; flags & 0x20;) {
        flags = g.readUInt16BE(p);
        const part = g.readUInt16BE(p + 2);
        if (part >= numGlyphs) throw bad('Bauteil-Verweis ungültig');
        if (!place.has(part)) { place.set(part, glyphs.length); glyphs.push(part); }
        g.writeUInt16BE(place.get(part), p + 2);
        p += 4 + (flags & 0x01 ? 4 : 2) + (flags & 0x08 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
      }
    }
    parts.push(pad4(g));
  }
  const n = glyphs.length;
  if (n > 0xFFFF) throw bad('zu viele verschiedene Zeichen für eine Teilmenge');
  const newLoca = Buffer.alloc((n + 1) * 4), hmtx = Buffer.alloc(n * 4);
  let offset = 0;
  glyphs.forEach((g, i) => {
    newLoca.writeUInt32BE(offset, i * 4);
    offset += parts[i].length;
    hmtx.writeUInt16BE(font.advances[g], i * 4);
    hmtx.writeInt16BE(font.lsbs[g], i * 4 + 2);
  });
  newLoca.writeUInt32BE(offset, n * 4);
  const head = Buffer.from(tables.get('head')), hhea = Buffer.from(tables.get('hhea')), maxp = Buffer.from(tables.get('maxp'));
  head.writeUInt32BE(0, 8);            // checkSumAdjustment — wird ganz am Ende gesetzt
  head.writeInt16BE(1, 50);            // indexToLocFormat: lang
  hhea.writeUInt16BE(n, 34);           // numberOfHMetrics
  maxp.writeUInt16BE(n, 4);            // numGlyphs
  // Genau die Tabellen, die ein PDF-Betrachter für eine CID-Schrift braucht (wie PDFKit/fontkit); Hinting nur, falls vorhanden
  const out = new Map([['glyf', Buffer.concat(parts)], ['head', head], ['hhea', hhea], ['hmtx', hmtx], ['loca', newLoca], ['maxp', maxp]]);
  for (const tag of ['cvt ', 'fpgm', 'prep']) if (tables.has(tag)) out.set(tag, tables.get(tag));
  return { data: buildSfnt(out), glyphs };
}

/** Tabellen → sfnt-Datei: Verzeichnis nach Namen sortiert, Tabellen auf 4 Byte ausgerichtet, Prüfsummen gesetzt */
function buildSfnt(tables) {
  const tags = [...tables.keys()].sort(), n = tags.length;
  const dir = Buffer.alloc(12 + n * 16), parts = [dir];
  const log = Math.floor(Math.log2(n));
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(n, 4);
  dir.writeUInt16BE(16 << log, 6);               // searchRange
  dir.writeUInt16BE(log, 8);                     // entrySelector
  dir.writeUInt16BE(n * 16 - (16 << log), 10);   // rangeShift
  let offset = dir.length, headAt = 0;
  tags.forEach((tag, i) => {
    const raw = tables.get(tag), padded = pad4(raw), o = 12 + i * 16;
    dir.write(tag, o, 'latin1');
    dir.writeUInt32BE(checksum(padded), o + 4);
    dir.writeUInt32BE(offset, o + 8);
    dir.writeUInt32BE(raw.length, o + 12);
    if (tag === 'head') headAt = offset;
    parts.push(padded);
    offset += padded.length;
  });
  const file = Buffer.concat(parts);
  file.writeUInt32BE((0xB1B0AFBA - checksum(file)) >>> 0, headAt + 8);   // head.checkSumAdjustment über die ganze Datei
  return file;
}

// ---------------------------------------------------------------------------
// 3. PDF-Schreiber — Schriften: Registratur, Auswahl, Kette
// ---------------------------------------------------------------------------
export const A4 = Object.freeze({ width: 595.276, height: 841.89 });   // 210 × 297 mm
/** Millimeter → PDF-Punkte */
export const mm = (v) => finite(v, 'mm') * 72 / 25.4;

const registry = new Map();   // Name → { name, family, weight, serif, source, font } — font wird beim ersten Zugriff gelesen
for (const [name, family, weight, serif] of [
  ['Inter-Regular', 'Inter', 400, false], ['Inter-Medium', 'Inter', 500, false], ['Inter-SemiBold', 'Inter', 600, false],
  ['Inter-Bold', 'Inter', 700, false], ['Fraunces-Medium', 'Fraunces', 500, true], ['Fraunces-SemiBold', 'Fraunces', 600, true],
]) registry.set(name, { name, family, weight, serif, source: new URL(`./pdf-fonts/${name}.ttf`, import.meta.url), font: null });

/** Schrift aus der Registratur, z. B. getFont('Inter-Bold'). Liest die Datei einmal je Prozess. */
export function getFont(name) {
  const e = registry.get(name);
  if (!e) throw new PdfError('BAD_FONT', `Unbekannte Schrift „${String(name)}“`);
  if (!e.font) {
    let data = e.source;
    if (!Buffer.isBuffer(data)) {
      try { data = fs.readFileSync(data); } catch (err) { throw new PdfError('BAD_FONT', `Schrift „${name}“ ist nicht lesbar: ${err.message}`); }
    }
    e.font = parseFont(data, e);
  }
  return e.font;
}

/** Nächstliegender Schnitt einer Familie nach den CSS-Regeln für font-weight; null, wenn es die Familie nicht gibt.
 *  findFont({ family: 'Fraunces', weight: 700 }) → Fraunces-SemiBold */
export function findFont({ family, weight = 400 } = {}) {
  const fam = String(family ?? '').trim().toLowerCase();
  const cuts = [...registry.values()].filter((e) => e.family.toLowerCase() === fam);
  if (!cuts.length) return null;
  const w = weight === 'bold' ? 700 : weight === 'normal' ? 400 : Number(weight);
  if (!(w >= 1 && w <= 1000)) throw new PdfError('BAD_FONT', `Schriftstärke ungültig: ${String(weight)}`);
  const rank = (c) => {
    if (c === w) return 0;
    if (w >= 400 && w <= 500) return c > w && c <= 500 ? c - w : c < w ? 1000 + w - c : 2000 + c - w;   // erst bis 500, dann leichter, dann fetter
    return w < 400 ? (c < w ? w - c : 1000 + c - w) : (c > w ? c - w : 1000 + w - c);                     // erst in die eigene Richtung
  };
  return getFont(cuts.reduce((a, b) => (rank(b.weight) < rank(a.weight) ? b : a)).name);
}

/** Eigene Schrift anmelden: Pfad oder Buffer einer .ttf. Wird sofort gelesen und geprüft; liefert das Schriftobjekt. */
export function registerFont(name, source, { family = name, weight = 400, serif } = {}) {
  if (typeof name !== 'string' || !name) throw new PdfError('BAD_FONT', 'Schrift braucht einen Namen');
  if (!Buffer.isBuffer(source) && typeof source !== 'string' && !(source instanceof URL)) throw new PdfError('BAD_FONT', `Schrift „${name}“: Pfad oder Buffer erwartet`);
  const old = registry.get(name), e = { name, family: String(family), weight: Number(weight) || 400, serif, source, font: null };
  registry.set(name, e);
  try { return getFont(name); } catch (err) {
    if (old) registry.set(name, old); else registry.delete(name);
    throw err;
  }
}

/** Schriftangabe → Schriftobjekt. Erlaubt: Schriftobjekt, Registername ('Inter-Bold'), Familie ('Inter') oder { family, weight }. */
function fontOf(spec) {
  if (spec && spec.cmap instanceof Map) return spec;
  if (spec == null) throw new PdfError('BAD_FONT', 'Schrift fehlt (Angabe font)');
  let font = null;
  if (typeof spec === 'string') font = registry.has(spec) ? getFont(spec) : findFont({ family: spec });
  else if (spec && typeof spec === 'object' && !Array.isArray(spec)) font = findFont(spec);
  if (!font) throw new PdfError('BAD_FONT', `Unbekannte Schrift: ${typeof spec === 'string' ? spec : JSON.stringify(spec) ?? String(spec)}`);
  return font;
}
/** Schriftangabe oder Liste davon → Kette von Schriftobjekten */
function chainOf(spec) {
  const fonts = Array.isArray(spec) ? spec.map(fontOf) : [fontOf(spec)];
  if (!fonts.length) throw new PdfError('BAD_FONT', 'Leere Schriftkette');
  return fonts;
}

// ---------------------------------------------------------------------------
// Text: gemeinsame Zerlegung für Messen und Zeichnen
// ---------------------------------------------------------------------------
// Unsichtbare Formatzeichen (Unicode Default_Ignorable_Code_Point: weiches Trennzeichen, Breitenlos-Zeichen, Wort- und
// Silbenverbinder, Richtungsmarken U+200E/F, U+202A–U+202E, U+2066–U+2069, U+061C, BOM, Variantenwähler, Tags …) werden
// übersprungen — so wie Browser sie ausblenden (HarfBuzz). Ausnahme wie dort: die Hangul-Füllzeichen haben eine echte Glyphe.
const IGNORABLE = /^(?![\u115F\u1160\u3164\uFFA0\u{1BCA0}-\u{1BCA3}])\p{Default_Ignorable_Code_Point}$/u;
/** true für Zeichen, die nie gezeichnet werden (Breite 0, kein Code in der PDF) — auch für die Zeichen-Bilanz des Satzes */
export const isIgnorable = (cp) => cp >= 0xAD && IGNORABLE.test(String.fromCodePoint(cp));
// Kombinationszeichen, die nach composeText noch einzeln stehen: ohne Akzent-Positionierung nicht darstellbar
const MARK = /^\p{M}$/u;
// Tabulator, Zeilenumbrüche & Co. werden zu einem gewöhnlichen Leerzeichen (text() setzt genau EINE Zeile)
const isControlSpace = (cp) => (cp >= 0x09 && cp <= 0x0D) || cp === 0x85 || cp === 0x2028 || cp === 0x2029;
// Leerraum mit eigener Bedeutung: eigene Glyphe, wenn eine Schrift der Kette sie hat, sonst die Leerzeichen-Glyphe
const isSpaceLike = (cp) => cp === 0xA0 || (cp >= 0x2000 && cp <= 0x200A) || cp === 0x202F || cp === 0x205F || cp === 0x3000;
const uPlus = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/** NFC nur dort, wo Kombinationszeichen stehen: „o“ + U+0308 → „ö“ (es gibt keine Akzent-Positionierung, nur fertige
 *  Buchstaben). Einzelzeichen bleiben, wie sie sind — auch die, die NFC gegen ein gleich aussehendes tauschen würde
 *  (Ω U+2126 → U+03A9, K U+212A, Å U+212B, U+2000/U+2001 …), damit Kopieren und Suchen genau den Eingabetext liefern.
 *  Ersetzt wird eine Folge nur, wenn NFC sie wirklich kürzer macht (U+0340 allein bleibt U+0340, nicht U+0300). */
export const composeText = (s) => (/\p{M}/u.test(s) ? s.replace(/\P{M}?\p{M}+/gu, (m) => { const n = m.normalize('NFC'); return n.length < m.length ? n : m; }) : s);

/** Text → Läufe gleicher Schrift. Jedes Zeichen nimmt die erste Schrift der Kette, die es hat.
 *  missing gesetzt: fehlende Zeichen dort sammeln statt abzubrechen.
 *  → { runs: [{ font, cps, gids }], units (Summe der /W-Breiten), count (Glyphen), spaces (Wortzwischenräume) } */
function shape(str, fonts, missing) {
  if (typeof str !== 'string') throw new PdfError('BAD_TEXT', `Text erwartet, bekommen: ${typeof str}`);
  const s = composeText(str), runs = [];
  let run = null, units = 0, count = 0, spaces = 0;
  for (let i = 0; i < s.length; i++) {
    let cp = s.codePointAt(i);
    if (cp > 0xFFFF) i++;
    let mark = false;
    if (cp < 0x20 || cp > 0x7E) {
      if (isIgnorable(cp)) continue;
      if (isControlSpace(cp)) cp = 0x20;
      mark = cp >= 0x300 && MARK.test(String.fromCodePoint(cp));
    }
    let font = null, gid = 0;
    if (!mark) for (const f of fonts) if ((gid = f.cmap.get(cp))) { font = f; break; }
    if (!font && isSpaceLike(cp)) for (const f of fonts) if ((gid = f.cmap.get(0x20))) { font = f; break; }
    if (!font) {
      const char = String.fromCodePoint(cp);
      if (missing) { missing.add(char); continue; }
      throw new PdfError('GLYPH_MISSING', mark ? `Kombinationszeichen ${uPlus(cp)} ohne passenden fertigen Buchstaben – Akzente lassen sich nicht frei setzen`
        : `Zeichen ${JSON.stringify(char)} (${uPlus(cp)}) fehlt in ${fonts.map((f) => f.name).join(', ')}`, { char, codePoint: cp });
    }
    if (!run || run.font !== font) runs.push(run = { font, cps: [], gids: [] });
    run.cps.push(cp);
    run.gids.push(gid);
    units += font.widths[gid];
    count++;
    if (cp === 0x20 || cp === 0xA0) spaces++;
  }
  return { runs, units, count, spaces };
}

const TEXT_KEYS = ['font', 'size', 'color', 'letterSpacing', 'wordSpacing', 'oblique', 'invisible'];
function allow(opts, keys, where) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw new PdfError('BAD_OPTION', `${where}: Angaben als Objekt erwartet`);
  for (const k in opts) if (!keys.includes(k)) throw new PdfError('BAD_OPTION', `${where}: unbekannte Angabe „${k}“ (erlaubt: ${keys.join(', ')})`);
}
const finite = (v, what) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new PdfError('BAD_NUMBER', `${what}: ungültige Zahl ${String(v)}`);
  return v;
};
/** Lage und Maße: nur echte, endliche Zahlen — '12' + 3 oder null ergäben sonst stillschweigend etwas Falsches */
const coords = (where, ...vs) => { for (const v of vs) finite(v, where); };

/** Größe und Abstände genau so gerundet, wie sie in der Datei stehen — damit Messen und Zeichnen dieselbe Breite ergeben.
 *  tc: Zeichenabstand in Punkten (PDF Tc), tj: Wortabstand in 1/1000 der Schriftgröße (TJ-Versatz) */
function spacing({ size, letterSpacing = 0, wordSpacing = 0 }) {
  const s = Math.round(finite(size, 'size') * 1e4) / 1e4;
  if (!(s > 0 && s <= 2000)) throw new PdfError('BAD_NUMBER', `size: Schriftgröße ${size} außerhalb von 0–2000`);
  const tc = Math.round(finite(letterSpacing, 'letterSpacing') * 1e4) / 1e4, tj = Math.round(finite(wordSpacing, 'wordSpacing') * 1e6 / s) / 1e3;
  // Grenzen der Datei (num) schon hier: Messen und Zeichnen scheitern gleich, und text() bricht nie mittendrin ab
  if (!(Math.abs(tc) <= 1e7)) throw new PdfError('BAD_NUMBER', `letterSpacing: ${letterSpacing} außerhalb von ±1e7`);
  if (!(Math.abs(tj) <= 1e7)) throw new PdfError('BAD_NUMBER', `wordSpacing: ${wordSpacing} ist für Schriftgröße ${size} zu groß`);
  return { size: s, tc, tj };
}
const widthOf = (sh, sp) => (sh.units + sh.spaces * sp.tj) * sp.size / 1000 + sh.count * sp.tc;
const flagOf = (v, what) => { if (v != null && typeof v !== 'boolean') throw new PdfError('BAD_OPTION', `${what}: true oder false erwartet, nicht ${String(v)}`); return !!v; };
/** oblique → Scherung der Textmatrix: true = 1:4 (wie Browser ohne kursiven Schnitt), Zahl = Winkel in Grad */
function skewOf(o) {
  if (o == null || o === false) return 0;
  if (o === true) return 0.25;
  if (!(Math.abs(finite(o, 'oblique')) < 90)) throw new PdfError('BAD_NUMBER', `oblique: Winkel ${o} außerhalb von −90 bis 90 Grad`);
  return Math.tan(o * Math.PI / 180);
}

/** Breite einer Zeile in Punkten — exakt der Wert, den page.text() mit denselben Angaben liefert.
 *  { font, size, letterSpacing, wordSpacing }; der Zeichenabstand zählt nach JEDEM Zeichen, auch nach dem letzten
 *  (wie CSS/Chrome). Wirft GLYPH_MISSING wie text(). */
export function measureText(str, opts = {}) {
  allow(opts, TEXT_KEYS, 'measureText');
  const width = widthOf(shape(str, chainOf(opts.font)), spacing(opts));
  skewOf(opts.oblique);                              // gleiche Angaben, gleiche Fehler wie text()
  flagOf(opts.invisible, 'invisible');
  if (opts.color != null) rgb(opts.color);
  return width;
}

/** Vorab-Prüfung: Zeichen, die keine Schrift der Kette darstellen kann (ohne Dopplungen; [] = alles darstellbar) */
export function missingChars(str, font) {
  const missing = new Set();
  shape(str, chainOf(font), missing);
  return [...missing];
}

/** Schriftmetrik in Punkten für die Größe size (bei einer Kette: der ersten Schrift).
 *  ascent/descent/lineGap wie im Browser (OS/2-typo, wenn USE_TYPO_METRICS gesetzt ist, sonst hhea) — beide positiv.
 *  Die übrigen Werte mit dem Vorzeichen der Schrift (hheaDescender, typoDescender, underlinePosition negativ = unter der Grundlinie). */
export function fontMetrics(font, size = 1) {
  const f = chainOf(font)[0], s = finite(size, 'size'), k = (v) => v * s / f.unitsPerEm;
  if (!(s > 0 && s <= 1e5)) throw new PdfError('BAD_NUMBER', `size: Schriftgröße ${size} muss größer als 0 sein`);
  const typo = f.useTypoMetrics || !(f.ascender || f.descender);
  return {
    ascent: k(typo ? f.typoAscender : f.ascender), descent: k(-(typo ? f.typoDescender : f.descender)), lineGap: k(typo ? f.typoLineGap : f.lineGap),
    capHeight: k(f.capHeight), xHeight: k(f.xHeight),
    underlinePosition: k(f.underlinePosition), underlineThickness: k(f.underlineThickness),
    strikeoutPosition: k(f.strikeoutPosition), strikeoutSize: k(f.strikeoutSize),
    hheaAscender: k(f.ascender), hheaDescender: k(f.descender), hheaLineGap: k(f.lineGap),
    typoAscender: k(f.typoAscender), typoDescender: k(f.typoDescender), typoLineGap: k(f.typoLineGap),
    winAscent: k(f.winAscent), winDescent: k(f.winDescent),
    useTypoMetrics: f.useTypoMetrics, unitsPerEm: f.unitsPerEm,
  };
}

// ---------------------------------------------------------------------------
// Bausteine der Datei: Zahlen, Namen, Zeichenketten, Farben
// ---------------------------------------------------------------------------

/** Zahl in fester Schreibweise mit höchstens 3 (scale 1e4: 4) Nachkommastellen — nie „1e-7“, nie NaN */
function num(v, scale = 1000) {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e7) throw new PdfError('BAD_NUMBER', `Ungültige Zahl für die PDF: ${String(v)}`);
  const r = Math.round(v * scale) / scale;
  return r === 0 ? '0' : String(r);   // fängt −0 ab; String() schreibt in diesem Bereich nie mit Exponent
}
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

/** PDF-Name: alles außer gewöhnlichen Zeichen als #xx */
const pdfName = (s) => '/' + [...Buffer.from(s, 'utf8')].map((b) => (b > 0x20 && b < 0x7F && !'()<>[]{}/%#'.includes(String.fromCharCode(b)) ? String.fromCharCode(b) : '#' + b.toString(16).toUpperCase().padStart(2, '0'))).join('');

/** PDF-Textzeichenkette: reines ASCII als ( … ) mit Maskierung, alles andere als UTF-16BE mit BOM in Hex */
function pdfString(s) {
  s = composeText(String(s)).toWellFormed();
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, '\\$&')})`;
  return `<${Buffer.from('\uFEFF' + s, 'utf16le').swap16().toString('hex').toUpperCase()}>`;
}

const colors = new Map();
/** '#rgb' | '#rrggbb' | [r, g, b] (0–1) → 'r g b' für rg/RG */
function rgb(c) {
  if (typeof c === 'string') {
    let s = colors.get(c);
    if (s) return s;
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (!m) throw new PdfError('BAD_COLOR', `Farbe ${JSON.stringify(c)} nicht verstanden (erlaubt: #rgb, #rrggbb, [r, g, b])`);
    const v = parseInt(m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1], 16);
    s = `${num((v >> 16) / 255, 1e4)} ${num(((v >> 8) & 255) / 255, 1e4)} ${num((v & 255) / 255, 1e4)}`;
    if (colors.size >= 256) colors.clear();
    colors.set(c, s);
    return s;
  }
  if (Array.isArray(c) && c.length === 3 && c.some((v) => typeof v === 'number' && !Number.isFinite(v))) throw new PdfError('BAD_NUMBER', `Farbe: ungültige Zahl in [${c.map(String).join(', ')}]`);
  if (!Array.isArray(c) || c.length !== 3 || c.some((v) => typeof v !== 'number' || !(v >= 0 && v <= 1))) throw new PdfError('BAD_COLOR', `Farbe ${JSON.stringify(c) ?? String(c)} nicht verstanden (erlaubt: #rgb, #rrggbb, [r, g, b] mit 0–1)`);
  return c.map((v) => num(v, 1e4)).join(' ');
}

// ---------------------------------------------------------------------------
// SVG-Pfade
// ---------------------------------------------------------------------------
const PATH_NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const PATH_COMMANDS = 'MLHVCSQTAZ';

/** SVG-Pfad (vollständige Syntax: M L H V C S Q T A Z, groß und klein, wiederholte Parameter, Zahlen wie „-.5“,
 *  „1.5.5“, „1e-3“) → absolute Abschnitte ['M', x, y] | ['L', x, y] | ['C', x1, y1, x2, y2, x, y] | ['Z'].
 *  Quadratische Kurven und Bögen werden zu kubischen Bézierkurven. Fehlerhafte Pfade: PdfError 'BAD_PATH'. */
export function parseSvgPath(d) {
  if (typeof d !== 'string') throw new PdfError('BAD_PATH', 'SVG-Pfad: Text erwartet');
  const out = [];
  let i = 0, x = 0, y = 0, startX = 0, startY = 0, ctrlX = 0, ctrlY = 0, last = '', open = false, sep = false;
  const fail = (msg) => { throw new PdfError('BAD_PATH', `SVG-Pfad: ${msg} (Stelle ${i})`); };
  const skip = (comma) => {            // Leerraum; zwischen zwei Parametern (comma) zusätzlich höchstens EIN Komma
    while (i < d.length && ' \t\n\r\f'.includes(d[i])) i++;
    if (comma && d[i] === ',') { i++; skip(false); }
  };
  const number = () => {
    skip(sep);
    sep = true;
    PATH_NUMBER.lastIndex = i;
    const m = PATH_NUMBER.exec(d);
    if (!m || !Number.isFinite(Number(m[0]))) fail('Zahl erwartet');
    i = PATH_NUMBER.lastIndex;
    return Number(m[0]);
  };
  const flag = () => {
    skip(sep);
    sep = true;
    if (d[i] !== '0' && d[i] !== '1') fail('Bogen-Schalter 0 oder 1 erwartet');
    return d[i++] === '1';
  };
  const begin = () => { if (!open) { out.push(['M', startX, startY]); open = true; } };   // nach Z geht es am Anfangspunkt weiter
  const quad = (qx, qy, ex, ey) => {
    out.push(['C', x + (qx - x) * 2 / 3, y + (qy - y) * 2 / 3, ex + (qx - ex) * 2 / 3, ey + (qy - ey) * 2 / 3, ex, ey]);
    ctrlX = qx; ctrlY = qy; x = ex; y = ey;
  };
  skip();
  while (i < d.length) {
    const cmd = d[i++], up = cmd.toUpperCase(), rel = cmd !== up;
    if (up.length !== 1 || !PATH_COMMANDS.includes(up)) fail(`unbekanntes Kommando „${cmd}“`);
    if (!out.length && up !== 'M') fail('Pfad muss mit M beginnen');
    sep = false;
    if (up === 'Z') {
      if (open) out.push(['Z']);
      x = startX; y = startY; open = false; last = 'Z';
      skip();
      continue;
    }
    for (let first = true; ; first = false) {
      const ox = rel ? x : 0, oy = rel ? y : 0;
      if (up === 'M') {
        x = ox + number(); y = oy + number();
        if (first) { startX = x; startY = y; out.push(['M', x, y]); open = true; } else out.push(['L', x, y]);   // weitere Paare sind Linien
      } else {
        begin();
        if (up === 'L') { x = ox + number(); y = oy + number(); out.push(['L', x, y]); }
        else if (up === 'H') { x = ox + number(); out.push(['L', x, y]); }
        else if (up === 'V') { y = oy + number(); out.push(['L', x, y]); }
        else if (up === 'C' || up === 'S') {
          const smooth = up === 'S';
          const x1 = smooth ? (last === 'C' ? 2 * x - ctrlX : x) : ox + number(), y1 = smooth ? (last === 'C' ? 2 * y - ctrlY : y) : oy + number();
          ctrlX = ox + number(); ctrlY = oy + number();
          x = ox + number(); y = oy + number();
          out.push(['C', x1, y1, ctrlX, ctrlY, x, y]);
        } else if (up === 'Q') {
          const qx = ox + number(), qy = oy + number();
          quad(qx, qy, ox + number(), oy + number());
        } else if (up === 'T') {
          const qx = last === 'Q' ? 2 * x - ctrlX : x, qy = last === 'Q' ? 2 * y - ctrlY : y;
          quad(qx, qy, ox + number(), oy + number());
        } else {
          const rx = number(), ry = number(), rot = number(), large = flag(), sweep = flag(), ex = ox + number(), ey = oy + number();
          arcToCurves(out, x, y, rx, ry, rot, large, sweep, ex, ey);
          x = ex; y = ey;
        }
      }
      last = up === 'S' ? 'C' : up === 'T' ? 'Q' : up;
      skip();
      if (i >= d.length || !'0123456789.+-,'.includes(d[i])) break;   // sonst: derselbe Befehl noch einmal
    }
  }
  if (!out.length) throw new PdfError('BAD_PATH', 'SVG-Pfad ist leer');
  return out;
}

/** SVG-Bogen (Endpunkt-Form) → Bézierkurven von höchstens 90°, nach SVG 1.1 Anhang F.6 */
function arcToCurves(out, x1, y1, rx, ry, rot, large, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return;                       // laut SVG: Bogen entfällt
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry) { out.push(['L', x2, y2]); return; }       // laut SVG: gerade Linie
  const phi = rot * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, xp = cos * dx + sin * dy, yp = cos * dy - sin * dx;
  // Gerechnet ohne Quadrate der Radien (sonst Über-/Unterlauf schon ab 1e155 bzw. 1e-155 → NaN → Bogen still weg):
  // d = halbe Sehne im Einheitskreis der Ellipse (√λ aus SVG F.6.6)
  const d = Math.hypot(xp / rx, yp / ry);
  let co = 0;
  if (d >= 1) { const r = rx / ry; rx = Math.hypot(xp, yp * r); ry = Math.hypot(xp / r, yp); }   // Radien zu klein für die Strecke → vergrößern
  else if (d < 1e-9 && large === false) { out.push(['L', x2, y2]); return; }   // Radius ≥ 1e9 × Sehne: Abweichung von der Geraden < 1e-9
  else co = (large === sweep ? -1 : 1) * Math.sqrt((1 - d) * (1 + d)) / d;
  const cxp = co * (rx * (yp / ry)), cyp = -co * (ry * (xp / rx));
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const t1 = Math.atan2((yp - cyp) / ry, (xp - cxp) / rx);
  let dt = Math.atan2((-yp - cyp) / ry, (-xp - cxp) / rx) - t1;
  if (sweep && dt < 0) dt += 2 * Math.PI; else if (!sweep && dt > 0) dt -= 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)), step = dt / n, k = 4 / 3 * Math.tan(step / 4);
  const pt = (a, b) => [cx + rx * cos * a - ry * sin * b, cy + rx * sin * a + ry * cos * b];   // Einheitskreis → Ellipse
  // NaN/∞ oder Rechengenauigkeit erschöpft (großer Bogen muss mindestens 180° überstreichen, kleiner höchstens 180°)
  if (!(n < 8) || (large ? Math.abs(dt) < Math.PI - 1e-6 : Math.abs(dt) > Math.PI + 1e-6)) throw new PdfError('BAD_PATH', 'SVG-Pfad: Bogen lässt sich nicht berechnen (Radien außerhalb jedes Maßes)');
  for (let j = 0; j < n; j++) {
    const a = t1 + j * step, b = a + step, ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    const seg = ['C', ...pt(ca - k * sa, sa + k * ca), ...pt(cb + k * sb, sb - k * cb), ...(j === n - 1 ? [x2, y2] : pt(cb, sb))];
    if (!seg.every((v, i) => !i || Number.isFinite(v))) throw new PdfError('BAD_PATH', 'SVG-Pfad: Bogen lässt sich nicht berechnen (Radien außerhalb jedes Maßes)');
    out.push(seg);
  }
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------
const KAPPA = 0.5522847498;            // Kontrollpunkt-Abstand für einen Viertelkreis aus einer Bézierkurve
const CAPS = ['butt', 'round', 'square'], JOINS = ['miter', 'round', 'bevel'];
const PAINT_KEYS = ['fill', 'stroke', 'lineWidth', 'dash', 'lineCap', 'lineJoin', 'fillRule'];
const LINK_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];

class PdfPage {
  constructor(doc, width, height) {
    this.doc = doc;
    this.width = width;
    this.height = height;
    this.ops = [];              // Inhaltsstrom, ein Eintrag je Zeile
    this.fonts = new Set();     // auf dieser Seite benutzte Schriften (für /Resources)
    this.links = [];
    this.stack = [];            // save()/restore()
    // Spiegel des Grafikzustands — geschrieben wird nur, was sich ändert (null = noch nicht gesetzt)
    this.gs = { fill: null, stroke: null, lineWidth: null, dash: '[] 0', cap: 0, join: 0, font: null, tc: 0, tr: 0 };
  }

  /** EINE Zeile Text; x = linker Rand, y = Grundlinie. { font, size, color, letterSpacing, wordSpacing, oblique, invisible }
   *  font: Schrift oder Kette (siehe fontOf); size in Punkten; oblique: true (Schrägstellung 1:4 wie im Browser) oder Winkel in Grad.
   *  wordSpacing wirkt nach jedem Leerzeichen und geschützten Leerzeichen. invisible: true = unsichtbar, aber kopier- und
   *  durchsuchbar (Darstellungsmodus 3, wie Chromes Druck von color: transparent). Liefert die Breite (= measureText). */
  text(str, x, y, opts = {}) {
    allow(opts, TEXT_KEYS, 'text');
    const sh = shape(str, chainOf(opts.font)), sp = spacing(opts), width = widthOf(sh, sp);   // wirft, bevor etwas geschrieben ist
    const fill = rgb(opts.color ?? '#000'), X = num(finite(x, 'x')), Y = num(this.height - finite(y, 'y'));
    const skew = skewOf(opts.oblique);
    flagOf(opts.invisible, 'invisible');
    const at = skew ? `1 0 ${num(skew, 1e4)} 1 ${X} ${Y} Tm` : `${X} ${Y} Td`;
    if (!sh.count) return 0;
    // Alles, was scheitern kann, vor der ersten Änderung an Seite und Grafikzustand: Zahlen, Schriften, freie Codes
    const tc = num(sp.tc, 1e4), size = num(sp.size, 1e4), tj = sp.tj ? num(-sp.tj) : '';
    const dfs = sh.runs.map((run) => this.doc.useFont(run.font));
    for (const df of new Set(dfs)) {
      const fresh = new Set();
      sh.runs.forEach((run, k) => { if (dfs[k] === df) for (const cp of run.cps) if (!df.has(cp)) fresh.add(cp); });
      if (df.cps.length + fresh.size > 0x10000) throw new PdfError('BAD_FONT', `Schrift „${df.font.name}“: zu viele verschiedene Zeichen in einem Dokument`);
    }
    this.#fill(fill);
    let s = 'BT';
    if (this.gs.tc !== sp.tc) { s += ` ${tc} Tc`; this.gs.tc = sp.tc; }
    const tr = opts.invisible ? 3 : 0;
    if (this.gs.tr !== tr) { s += ` ${tr} Tr`; this.gs.tr = tr; }
    s += ` ${at}`;
    sh.runs.forEach((run, k) => {
      const df = dfs[k], tf = `/${df.id} ${size} Tf`;
      this.fonts.add(df);
      if (this.gs.font !== tf) { s += ` ${tf}`; this.gs.font = tf; }
      const parts = [];          // Hex-Stücke aus Zwei-Byte-Codes, bei Wortabstand mit TJ-Versatz dazwischen
      let hex = '';
      for (let i = 0; i < run.cps.length; i++) {
        const cp = run.cps[i];
        hex += df.code(cp, run.gids[i]);
        if (tj && (cp === 0x20 || cp === 0xA0)) { parts.push(`<${hex}>`, tj); hex = ''; }
        else if (hex.length >= 16000) { parts.push(`<${hex}>`); hex = ''; }
      }
      if (hex) parts.push(`<${hex}>`);
      s += parts.length === 1 ? ` ${parts[0]} Tj` : ` [${parts.join(' ')}] TJ`;
    });
    this.ops.push(`${s} ET`);
    return width;
  }

  /** Rechteck. { fill, stroke, lineWidth, radius, dash, lineJoin } — radius: Zahl oder [obenLinks, obenRechts, untenRechts, untenLinks].
   *  Der Strich liegt mittig auf der Kante (für einen CSS-Rahmen also um die halbe Strichbreite einrücken). */
  rect(x, y, w, h, opts = {}) {
    allow(opts, [...PAINT_KEYS, 'radius'], 'rect');
    return this.#paint(this.#rectPath(x, y, w, h, opts.radius), opts);
  }

  /** Linie. { color, width, dash, lineCap } */
  line(x1, y1, x2, y2, opts = {}) {
    allow(opts, ['color', 'width', 'dash', 'lineCap'], 'line');
    coords('line', x1, y1, x2, y2);
    const H = this.height;
    return this.#paint(`${num(x1)} ${num(H - y1)} m ${num(x2)} ${num(H - y2)} l`, { stroke: opts.color ?? '#000', lineWidth: opts.width, dash: opts.dash, lineCap: opts.lineCap });
  }

  /** SVG-Pfad (Inhalt des d-Attributs). Lage: { x, y, scale } (scale: Zahl oder [sx, sy]) ODER transform: [a, b, c, d, e, f]
   *  wie die SVG-matrix(). Dazu { fill, stroke, lineWidth, fillRule: 'nonzero' | 'evenodd', dash, lineCap, lineJoin }.
   *  lineWidth bleibt in Punkten (wird nicht mitskaliert). */
  path(d, opts = {}) {
    allow(opts, [...PAINT_KEYS, 'x', 'y', 'scale', 'transform'], 'path');
    let m = opts.transform;
    if (m != null) {
      if (opts.x != null || opts.y != null || opts.scale != null) throw new PdfError('BAD_OPTION', 'path: entweder transform oder x/y/scale');
      if (!Array.isArray(m) || m.length !== 6) throw new PdfError('BAD_OPTION', 'path: transform braucht sechs Zahlen [a, b, c, d, e, f]');
    } else {
      const s = opts.scale ?? 1, [sx, sy] = Array.isArray(s) ? s : [s, s];
      m = [sx, 0, 0, sy, opts.x ?? 0, opts.y ?? 0];
    }
    coords('path', ...m);
    const [a, b, c, e, tx, ty] = m, H = this.height;
    const pt = (px, py) => `${num(a * px + c * py + tx)} ${num(H - (b * px + e * py + ty))}`;
    const ops = parseSvgPath(d).map((seg) => (seg[0] === 'Z' ? 'h'
      : seg[0] === 'C' ? `${pt(seg[1], seg[2])} ${pt(seg[3], seg[4])} ${pt(seg[5], seg[6])} c`
        : `${pt(seg[1], seg[2])} ${seg[0] === 'M' ? 'm' : 'l'}`));
    return this.#paint(ops.join('\n'), opts);
  }

  /** Klickbarer Bereich mit Verweis nach außen (ohne Rahmen). Nur http:, https:, mailto: und tel:. */
  link(x, y, w, h, url) {
    coords('link', x, y, w, h);
    let u = null, href = '';
    try {
      u = typeof url === 'string' ? new URL(url) : null;
      href = u ? u.href.replace(/ /g, '%20') : '';     // nur bei mailto:/tel: bleiben Leerzeichen stehen — eine URI kennt keine
    } catch { /* unten gemeldet */ }
    if (!u || !LINK_SCHEMES.includes(u.protocol) || !/^[\x21-\x7e]+$/.test(href)) throw new PdfError('BAD_LINK', `Verweis ${JSON.stringify(url) ?? String(url)} nicht erlaubt (nur vollständige Adressen mit http:, https:, mailto:, tel:)`);
    const H = this.height, x2 = x + w, y2 = y + h;
    const box = [Math.min(x, x2), H - Math.max(y, y2), Math.max(x, x2), H - Math.min(y, y2)].map((v) => num(v)).join(' ');
    // href ist reines ASCII (Umlaut-Domains als Punycode, alles andere prozentkodiert) — oben geprüft
    this.links.push(`<< /Type /Annot /Subtype /Link /Rect [${box}] /Border [0 0 0] /F 4 /A << /Type /Action /S /URI /URI ${pdfString(href)} >> >>`);
    return this;
  }

  /** Grafikzustand merken (Farben, Strich, Beschnitt) … */
  save() {
    this.stack.push({ ...this.gs });
    this.ops.push('q');
    return this;
  }

  /** … und wiederherstellen */
  restore() {
    if (!this.stack.length) throw new PdfError('BAD_STATE', 'restore() ohne save()');
    this.gs = this.stack.pop();
    this.ops.push('Q');
    return this;
  }

  /** Alles Folgende auf ein Rechteck beschneiden ({ radius } wie bei rect) — gilt bis zum zugehörigen restore() */
  clip(x, y, w, h, opts = {}) {
    allow(opts, ['radius'], 'clip');
    this.ops.push(`${this.#rectPath(x, y, w, h, opts.radius)} W n`);
    return this;
  }

  #fill(color) {
    if (this.gs.fill !== color) { this.ops.push(`${color} rg`); this.gs.fill = color; }
  }

  /** Pfad füllen und/oder umranden; ohne fill und ohne stroke geschieht nichts */
  #paint(path, o) {
    if (o.fillRule != null && o.fillRule !== 'nonzero' && o.fillRule !== 'evenodd') throw new PdfError('BAD_OPTION', `fillRule: nonzero oder evenodd erwartet, nicht ${String(o.fillRule)}`);
    const fill = o.fill != null, stroke = o.stroke != null, even = o.fillRule === 'evenodd' ? '*' : '';
    if (!fill && !stroke) return this;
    const set = [], gs = this.gs, next = {};
    if (fill) next.fill = rgb(o.fill);
    if (stroke) {
      next.stroke = rgb(o.stroke);
      const width = finite(o.lineWidth ?? 1, 'lineWidth');
      if (!(width >= 0.001)) throw new PdfError('BAD_NUMBER', `lineWidth: Strichbreite ${width} muss größer als 0 sein`);   // „0 w“ wäre ein Haarstrich je nach Gerät
      next.lineWidth = num(width);
      const dash = o.dash ?? [];
      if (!Array.isArray(dash) || dash.length > 8 || dash.some((v) => typeof v !== 'number' || !(v >= 0)) || (dash.length && !dash.some(Boolean))) throw new PdfError('BAD_OPTION', 'dash: Liste aus Strich- und Lückenlängen erwartet, z. B. [3, 2]');
      next.dash = `[${dash.map((v) => num(v)).join(' ')}] 0`;
      next.cap = CAPS.indexOf(o.lineCap ?? 'butt');
      next.join = JOINS.indexOf(o.lineJoin ?? 'miter');
      if (next.cap < 0 || next.join < 0) throw new PdfError('BAD_OPTION', `lineCap (${CAPS.join(', ')}) oder lineJoin (${JOINS.join(', ')}) nicht verstanden`);
    }
    const OPS = { fill: 'rg', stroke: 'RG', lineWidth: 'w', dash: 'd', cap: 'J', join: 'j' };
    for (const k in next) if (gs[k] !== next[k]) { set.push(`${next[k]} ${OPS[k]}`); gs[k] = next[k]; }
    this.ops.push(...set, `${path} ${fill && stroke ? `B${even}` : fill ? `f${even}` : 'S'}`);
    return this;
  }

  /** Rechteck als Pfad; mit Radien als Bézier-Ecken. Zu große Radien werden wie in CSS gemeinsam verkleinert. */
  #rectPath(x, y, w, h, radius = 0) {
    coords('Rechteck', x, y, w, h);
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    const H = this.height, r = Array.isArray(radius) ? radius : [radius, radius, radius, radius];
    if (r.length !== 4 || r.some((v) => typeof v !== 'number' || !(v >= 0) || !Number.isFinite(v))) throw new PdfError('BAD_NUMBER', 'radius: Zahl ≥ 0 oder vier Zahlen [obenLinks, obenRechts, untenRechts, untenLinks] erwartet');
    if (!r.some(Boolean)) return `${num(x)} ${num(H - y - h)} ${num(w)} ${num(h)} re`;
    const fit = (len, sum) => (sum > len ? len / sum : 1);
    const f = Math.min(fit(w, r[0] + r[1]), fit(w, r[3] + r[2]), fit(h, r[0] + r[3]), fit(h, r[1] + r[2]));
    const [tl, tr, br, bl] = r.map((v) => v * f), k = 1 - KAPPA;
    const p = (px, py) => `${num(px)} ${num(H - py)}`;
    const start = p(x + tl, y);
    let last = start, s = `${start} m`;
    // Strecken der Länge 0 (Radien füllen die ganze Seite) und Ecken ohne Radius entfallen; zurück zum Anfang zieht „h“
    const to = (px, py) => { const q = p(px, py); if (q !== last && q !== start) s += ` ${last = q} l`; };
    const arc = (rad, ax, ay, bx, by, ex, ey) => { if (rad >= 0.0005) s += ` ${p(ax, ay)} ${p(bx, by)} ${last = p(ex, ey)} c`; };
    to(x + w - tr, y);
    arc(tr, x + w - tr * k, y, x + w, y + tr * k, x + w, y + tr);
    to(x + w, y + h - br);
    arc(br, x + w, y + h - br * k, x + w - br * k, y + h, x + w - br, y + h);
    to(x + bl, y + h);
    arc(bl, x + bl * k, y + h, x, y + h - bl * k, x, y + h - bl);
    to(x, y + tl);
    arc(tl, x, y + tl * k, x + tl * k, y, x + tl, y);
    return `${s} h`;
  }
}

// ---------------------------------------------------------------------------
// Dokument und Dateiformat
// ---------------------------------------------------------------------------
const META_KEYS = ['title', 'author', 'subject', 'keywords', 'creator', 'lang', 'createdAt', 'compress'];
const wrap = (items, per) => items.map((v, i) => (i && i % per === 0 ? `\n${v}` : v)).join(' ');   // lange Listen umbrechen

/** ToUnicode-Tabelle: jeder Code genau auf seinen Codepunkt (bfchar-Blöcke zu höchstens 100 Einträgen) */
function toUnicode(cps) {
  const utf16 = (cp) => (cp > 0xFFFF ? hex4(0xD800 + ((cp - 0x10000) >> 10)) + hex4(0xDC00 + ((cp - 0x10000) & 0x3FF)) : hex4(cp));
  let s = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
    + '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  for (let i = 1; i < cps.length; i += 100) {
    const end = Math.min(cps.length, i + 100);
    s += `${end - i} beginbfchar\n`;
    for (let c = i; c < end; c++) s += `<${hex4(c)}> <${utf16(cps[c])}>\n`;
    s += 'endbfchar\n';
  }
  return `${s}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
}

export class PdfDocument {
  /** { title, author, subject, keywords (Text oder Liste), creator, lang = 'de-DE', createdAt (Date | ms | ISO-Text mit Z oder ±hh:mm bzw. reines Datum), compress = true }
   *  Ohne createdAt stehen keine Zeitangaben in der Datei — die Uhr wird nie gelesen. */
  constructor(meta = {}) {
    allow(meta, META_KEYS, 'PdfDocument');
    const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
    this.info = {};
    for (const [key, k] of [['Title', 'title'], ['Author', 'author'], ['Subject', 'subject'], ['Keywords', 'keywords'], ['Creator', 'creator']]) {
      const v = meta[k] == null ? '' : clean(Array.isArray(meta[k]) ? meta[k].join(', ') : meta[k]);
      if (v) this.info[key] = v;
    }
    this.info.Producer = 'formsam';
    this.lang = meta.lang ?? 'de-DE';
    if (typeof this.lang !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(this.lang)) throw new PdfError('BAD_OPTION', `lang: Sprachkennung wie „de-DE“ erwartet, nicht ${String(meta.lang)}`);
    this.date = '';
    if (meta.createdAt != null) {
      // nur eindeutige Zeitpunkte: Date, Millisekunden oder ISO-Text mit Zone (Z/±hh:mm) bzw. reines Datum (gilt als UTC) —
      // nie Text, den Date nach der Zeitzone des Servers auslegt („2026-03-01T10:00“, „March 1, 2026“), nie true oder '5'
      const c = meta.createdAt, ok = c instanceof Date || (typeof c === 'number' && Number.isFinite(c))
        || (typeof c === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/i.test(c.trim()));
      const d = new Date(typeof c === 'string' ? c.trim() : c), iso = !ok || Number.isNaN(d.getTime()) ? '' : d.toISOString();
      if (!/^\d{4}-/.test(iso)) throw new PdfError('BAD_OPTION', `createdAt: kein eindeutiges Datum (${String(meta.createdAt)}) – erlaubt: Date, Millisekunden, ISO-Text mit Z oder ±hh:mm`);
      this.date = `D:${iso.slice(0, 19).replace(/[-:T]/g, '')}Z`;          // Weltzeit, unabhängig von der Zeitzone des Servers
    }
    this.compress = meta.compress !== false;
    this.pages = [];
    this.fonts = new Map();     // Schriftobjekt → { font, id, cps, gids, code() } in der Reihenfolge der ersten Benutzung
  }

  /** Neue Seite; Maße in Punkten, ohne Angabe A4 hoch */
  addPage(size = {}) {
    allow(size, ['width', 'height'], 'addPage');
    const width = finite(size.width ?? A4.width, 'width'), height = finite(size.height ?? A4.height, 'height');
    if (!(width >= 3 && width <= 14400 && height >= 3 && height <= 14400)) throw new PdfError('BAD_NUMBER', `Seitenmaß ${width} × ${height} außerhalb von 3–14400 Punkten`);
    const page = new PdfPage(this, width, height);
    this.pages.push(page);
    return page;
  }

  /** Schrift im Dokument anmelden (geschieht beim ersten Zeichen von selbst). Jedes ZEICHEN bekommt in der Reihenfolge
   *  seines ersten Auftretens einen eigenen Code — auch wenn zwei Zeichen dieselbe Glyphe benutzen. */
  useFont(font) {
    font = fontOf(font);
    let df = this.fonts.get(font);
    if (!df) {
      const codes = new Map();
      df = {
        font, id: `F${this.fonts.size + 1}`, cps: [0], gids: [0],     // Code 0 = .notdef, wird nie benutzt
        has: (cp) => codes.has(cp),
        code(cp, gid) {
          let c = codes.get(cp);
          if (c === undefined) {
            if (df.cps.length > 0xFFFF) throw new PdfError('BAD_FONT', `Schrift „${font.name}“: zu viele verschiedene Zeichen in einem Dokument`);
            codes.set(cp, c = hex4(df.cps.length));
            df.cps.push(cp);
            df.gids.push(gid);
          }
          return c;
        },
      };
      this.fonts.set(font, df);
    }
    return df;
  }

  /** Fertige Datei. Darf mehrfach aufgerufen werden und liefert für denselben Inhalt dieselben Bytes. */
  toBuffer() {
    if (!this.pages.length) throw new PdfError('NO_PAGES', 'Eine PDF braucht mindestens eine Seite');
    if (this.pages.some((p) => p.stack.length)) throw new PdfError('BAD_STATE', 'save() ohne restore()');
    const fonts = [...this.fonts.values()].filter((df) => df.cps.length > 1);   // angemeldet, aber nie benutzt: bleibt draußen
    // Objektnummern: 1 Katalog, 2 Seitenbaum, 3 Info, je Seite (Seite, Inhalt, Verweise …), je Schrift fünf Objekte
    let count = 3;
    const pageNo = this.pages.map((p) => { const no = count + 1; count += 2 + p.links.length; return no; });
    const fontNo = new Map(fonts.map((df) => { const no = count + 1; count += 5; return [df, no]; }));
    const objs = new Array(count + 1);
    const stream = (data, extra = '') => {
      const body = this.compress ? zlib.deflateSync(data, { level: 9 }) : data;
      return Buffer.concat([Buffer.from(`<< /Length ${body.length}${this.compress ? ' /Filter /FlateDecode' : ''}${extra} >>\nstream\n`, 'latin1'), body, Buffer.from('\nendstream', 'latin1')]);
    };

    objs[1] = `<< /Type /Catalog /Pages 2 0 R /Lang ${pdfString(this.lang)} /ViewerPreferences << /DisplayDocTitle true >> >>`;
    objs[2] = `<< /Type /Pages /Count ${this.pages.length} /Kids [${wrap(pageNo.map((no) => `${no} 0 R`), 12)}] >>`;
    const info = Object.entries(this.info).map(([k, v]) => `/${k} ${pdfString(v)}`);
    if (this.date) info.push(`/CreationDate (${this.date})`, `/ModDate (${this.date})`);
    objs[3] = `<< ${info.join(' ')} >>`;

    this.pages.forEach((p, i) => {
      const no = pageNo[i];
      const res = [...p.fonts].map((df) => `/${df.id} ${fontNo.get(df)} 0 R`).join(' ');
      const annots = p.links.map((_, j) => `${no + 2 + j} 0 R`);
      objs[no] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}] /Resources << ${res ? `/Font << ${res} >> ` : ''}>>`
        + ` /Contents ${no + 1} 0 R${annots.length ? ` /Annots [${wrap(annots, 12)}]` : ''} >>`;
      objs[no + 1] = stream(Buffer.from(p.ops.length ? `${p.ops.join('\n')}\n` : '', 'latin1'));
      p.links.forEach((link, j) => { objs[no + 2 + j] = link; });
    });

    for (const df of fonts) {
      const f = df.font, no = fontNo.get(df), k = 1000 / f.unitsPerEm;
      const sub = subsetFont(f, df.gids.slice(1));
      // Teilmengen-Kennung: sechs Großbuchstaben, bestimmt allein durch Schrift und benutzte Zeichen
      const hash = crypto.createHash('sha256').update(`${f.name}\n${f.postScriptName}\n${df.cps.join(' ')}`).digest();
      const name = pdfName(`${[...hash.subarray(0, 6)].map((b) => String.fromCharCode(65 + b % 26)).join('')}+${f.postScriptName}`);
      const bbox = [Math.floor(f.bbox[0] * k), Math.floor(f.bbox[1] * k), Math.ceil(f.bbox[2] * k), Math.ceil(f.bbox[3] * k)].join(' ');
      const flags = 4 | (f.fixedPitch ? 1 : 0) | (f.serif ? 2 : 0) | (f.italicAngle ? 64 : 0);   // 4 = „symbolisch“: eigene Kodierung, wie bei CID-Schriften üblich
      objs[no] = `<< /Type /Font /Subtype /Type0 /BaseFont ${name} /Encoding /Identity-H /DescendantFonts [${no + 1} 0 R] /ToUnicode ${no + 4} 0 R >>`;
      objs[no + 1] = `<< /Type /Font /Subtype /CIDFontType2 /BaseFont ${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>`
        + ` /FontDescriptor ${no + 2} 0 R /CIDToGIDMap /Identity /DW 1000 /W [0 [${wrap(sub.glyphs.map((g) => f.widths[g]), 20)}]] >>`;
      objs[no + 2] = `<< /Type /FontDescriptor /FontName ${name} /Flags ${flags} /FontBBox [${bbox}] /ItalicAngle ${num(f.italicAngle)}`
        + ` /Ascent ${Math.round(f.ascender * k)} /Descent ${Math.round(f.descender * k)} /CapHeight ${Math.round(f.capHeight * k)}`
        + ` /StemV ${Math.round(50 + (f.weight / 65) ** 2)} /FontFile2 ${no + 3} 0 R >>`;
      objs[no + 3] = stream(sub.data, ` /Length1 ${sub.data.length}`);
      objs[no + 4] = stream(Buffer.from(toUnicode(df.cps), 'latin1'));
    }

    // Datei: Kopf, Objekte, klassische Querverweistabelle (genau 20 Byte je Eintrag), Anhang
    const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')], offsets = [0];
    let pos = chunks[0].length;
    const put = (b) => { chunks.push(b); pos += b.length; };
    for (let no = 1; no <= count; no++) {
      offsets[no] = pos;
      put(Buffer.from(`${no} 0 obj\n`, 'latin1'));
      put(Buffer.isBuffer(objs[no]) ? objs[no] : Buffer.from(objs[no], 'latin1'));
      put(Buffer.from('\nendobj\n', 'latin1'));
    }
    const hash = crypto.createHash('sha256');
    for (const c of chunks) hash.update(c);
    const id = hash.digest('hex').slice(0, 32).toUpperCase();   // Kennung allein aus dem Inhalt
    let tail = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
    for (let no = 1; no <= count; no++) tail += `${String(offsets[no]).padStart(10, '0')} 00000 n \n`;
    tail += `trailer\n<< /Size ${count + 1} /Root 1 0 R /Info 3 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${pos}\n%%EOF\n`;
    chunks.push(Buffer.from(tail, 'latin1'));
    return Buffer.concat(chunks);
  }
}
