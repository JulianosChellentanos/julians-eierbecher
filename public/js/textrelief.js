// OVJU — Gravur-Engine: Schrift als exaktes Distanzfeld → Höhenfeld mit richtungsabhängiger Fase.
// Reines JS (Browser & Node). Ergebnis ist ein Höhenraster in mm, das buildModel() in die
// Wand einrechnet (ein manifold Körper, keine aufgesetzte Schrift).
//
// Pipeline:  Glyphen (Font.generateShapes) → Binärraster (16 px/mm, even-odd je Glyph, Union)
//            → Euklidische Distanztransformation (Felzenszwalb, exakt, separabel)
//            → Gradient → lokale Strichbreite (Max-Filter) → Hairline-Verdickung
//            → Höhenfeld h(x,y): Fase 0,25 mm an Seiten/Oberkanten, bis H/tan(55°) an Unterseiten.

export const TEXT_STYLES = {
  gestanzt: { label: 'Gestanzt', hint: 'in die Wand gedrückt — schärfste Kanten', icon: '🪙' },
  gepraegt: { label: 'Geprägt', hint: 'erhaben mit feiner Fase', icon: '🔤' },
  gehaemmert: { label: 'Gehämmert', hint: 'glatte Schrift auf gehämmertem Schild', icon: '🔨' },
  kissen: { label: 'Kissen', hint: 'weich gewölbt, wie ein Siegel', icon: '🫧' },
  farbe: { label: 'Farbschrift', hint: 'bündig eingelegt in zweiter Filamentfarbe (Mehrfarbdruck, 3MF)', icon: '🎨' },
};

// Schrift-Regeln: capFactor = Großbuchstabenhöhe / Schriftgrad; minCap = kleinste druckbare Höhe;
// styles = erlaubte Stile (dünne Schriften vertragen kein Kissen-Profil).
export const FONT_RULES = {
  droid_sans: { capFactor: 0.99, minCap: 5, tracking: 0.015, bold: true },
  helvetiker: { capFactor: 1.02, minCap: 5, tracking: 0.015, bold: true },
  optimer: { capFactor: 0.94, minCap: 6, tracking: 0.02, bold: true },
  droid_serif: { capFactor: 0.99, minCap: 6, tracking: 0.06, bold: true, styles: ['gestanzt', 'gepraegt', 'gehaemmert'] },
  gentilis: { capFactor: 0.86, minCap: 7, tracking: 0.06, styles: ['gestanzt', 'gepraegt', 'gehaemmert'] },
  marcellus: { capFactor: 0.70, minCap: 7, tracking: 0.06, styles: ['gestanzt', 'gepraegt', 'gehaemmert'] },
  greatvibes: { capFactor: 0.98, minCap: 9, tracking: 0, styles: ['gestanzt', 'gepraegt', 'gehaemmert'] },
};
export const fontAllowsStyle = (fontKey, style) => {
  if (style === 'farbe') return true; // Farbschrift ist eine bündige Einlage — geht mit jeder Schrift
  const r = FONT_RULES[fontKey]; if (!r) return true;
  return !r.styles || r.styles.includes(style);
};

export const TEXT_FLANK_DEG = 55;          // steilste Unterseite (FDM ohne Stützen)
// Bogenmaße des Textes auf dem Umfang (Bogenlänge / Radius an der Textzeile):
//  FRONT_TEXT_ARC — bis hierhin ist der Text von vorn in einem Blick lesbar; längere Texte werden
//                   zuerst bis zur kleinsten druckbaren Größe (minCap) verkleinert …
//  MAX_TEXT_ARC   — … und dürfen erst dann um die Seiten laufen (Hinweis „zum Lesen drehen“).
//                   Über 200° bleibt kein Platz mehr für Kartusche/Rampe vor der Naht bei θ = ±180°.
export const FRONT_TEXT_ARC = (130 * Math.PI) / 180;
export const MAX_TEXT_ARC = (200 * Math.PI) / 180;

const PX = 20;      // Raster-Auflösung (px/mm)
const PAD = 2.0;    // Rand (mm)
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------
// 1D-Distanztransformation (Felzenszwalb & Huttenlocher), quadrierte Distanzen
function edt1d(f, n, out, v, z) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const d = q - v[k]; out[q] = d * d + f[v[k]]; }
}
// 2D-EDT: quadrierte Distanz jedes Pixels zum nächsten Pixel mit mask==target
function edt2d(mask, W, H, target) {
  const INF = 1e12;
  const g = new Float64Array(W * H);
  const f = new Float64Array(Math.max(W, H)), out = new Float64Array(Math.max(W, H));
  const v = new Int32Array(Math.max(W, H)), z = new Float64Array(Math.max(W, H) + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = mask[y * W + x] === target ? 0 : INF;
    edt1d(f, H, out, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = out[y];
  }
  const res = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    edt1d(f, W, out, v, z);
    for (let x = 0; x < W; x++) res[y * W + x] = out[x];
  }
  return res;
}

// Separabler Max-Filter (Fenster ±r Pixel)
function maxFilter(src, W, H, r) {
  const tmp = new Float32Array(W * H), dst = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let m = -Infinity; for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) { const v = src[y * W + k]; if (v > m) m = v; }
    tmp[y * W + x] = m;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let m = -Infinity; for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) { const v = tmp[k * W + x]; if (v > m) m = v; }
    dst[y * W + x] = m;
  }
  return dst;
}

// Separabler Box-Blur (Fenster ±r Pixel) — glättet stufige Felder (Max-Filter, Kantenrichtung)
function boxBlur(src, W, H, r) {
  const tmp = new Float32Array(W * H), dst = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    let acc = 0, cnt = 0;
    for (let x = -r; x < W; x++) {
      if (x + r < W) { acc += src[y * W + x + r]; cnt++; }
      if (x - r - 1 >= 0) { acc -= src[y * W + x - r - 1]; cnt--; }
      if (x >= 0) tmp[y * W + x] = acc / cnt;
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0, cnt = 0;
    for (let y = -r; y < H; y++) {
      if (y + r < H) { acc += tmp[(y + r) * W + x]; cnt++; }
      if (y - r - 1 >= 0) { acc -= tmp[(y - r - 1) * W + x]; cnt--; }
      if (y >= 0) dst[y * W + x] = acc / cnt;
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
/** Glyphen eines Textes als Punkt-Loops (mm), mit Laufweite und Fallback-Font für fehlende Zeichen */
function layoutGlyphs(font, fallbackFont, text, cap, fontKey) {
  const rule = FONT_RULES[fontKey] || { capFactor: 1, tracking: 0.04 };
  const size = cap / rule.capFactor;
  const glyphs = [];
  let x = 0, missing = '';
  for (const ch of text) {
    let f = font;
    if (!font.data.glyphs[ch]) { if (fallbackFont && fallbackFont.data.glyphs[ch]) f = fallbackFont; else { missing += ch; continue; } }
    const scale = size / f.data.resolution;
    const g = f.data.glyphs[ch];
    if (ch !== ' ') {
      const shapes = f.generateShapes(ch, size);
      const loops = [];
      for (const shape of shapes) {
        const pts = shape.extractPoints(8);
        for (const loop of [pts.shape, ...pts.holes]) if (loop.length >= 3) loops.push(loop.map((p) => [p.x + x, p.y]));
      }
      if (loops.length) glyphs.push(loops);
    }
    x += (g.ha || 0) * scale + rule.tracking * cap;
  }
  return { glyphs, missing };
}

/**
 * Textmaße (mm) ohne Rasterung — für die Größenwahl, bevor das Höhenfeld gebaut wird.
 * Breite und Höhe skalieren exakt linear mit `cap` (Vorschub, Laufweite und Konturen ∝ Schriftgrad),
 * eine Messung genügt also für alle Größen.
 * @returns {{width:number,height:number,missing:string}} width 0 = kein darstellbares Zeichen
 */
export function measureText({ font, fallbackFont, fontKey, text, cap }) {
  const { glyphs, missing } = layoutGlyphs(font, fallbackFont, text, cap, fontKey);
  if (!glyphs.length) return { width: 0, height: 0, missing };
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const loops of glyphs) for (const loop of loops) for (const q of loop) {
    if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0]; if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1];
  }
  return { width: maxx - minx, height: maxy - miny, missing };
}

const fieldCache = new Map();
/**
 * Höhenfeld einer Gravur.
 * @returns {null|{width,height,cx,cy,sample(u,v)->h(mm),strokeP10,missing}}
 */
export function buildGlyphField({ font, fallbackFont, fontKey, text, cap, style, product }) {
  const key = `${fontKey}|${font.data?.familyName || ''}|${text}|${cap.toFixed(2)}|${style}|${product}`;
  if (fieldCache.has(key)) return fieldCache.get(key);
  const { glyphs, missing } = layoutGlyphs(font, fallbackFont, text, cap, fontKey);
  if (!glyphs.length) return null;
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const loops of glyphs) for (const loop of loops) for (const q of loop) {
    if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0]; if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1];
  }
  const ox = minx - PAD, oy = miny - PAD;
  const W = Math.ceil((maxx - minx + 2 * PAD) * PX), H = Math.ceil((maxy - miny + 2 * PAD) * PX);
  // --- Binärraster: even-odd je Glyph (Löcher korrekt), Union über Glyphen
  const mask = new Uint8Array(W * H);
  const xs = [];
  for (const loops of glyphs) {
    const edges = [];
    for (const loop of loops) for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]); }
    let ly0 = Infinity, ly1 = -Infinity; for (const e of edges) { ly0 = Math.min(ly0, e[1], e[3]); ly1 = Math.max(ly1, e[1], e[3]); }
    const r0 = Math.max(0, Math.floor((ly0 - oy) * PX)), r1 = Math.min(H - 1, Math.ceil((ly1 - oy) * PX));
    for (let r = r0; r <= r1; r++) {
      const y = oy + (r + 0.5) / PX;
      xs.length = 0;
      for (const [x0, y0, x1, y1] of edges) if ((y >= y0) !== (y >= y1)) xs.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0));
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - ox) * PX - 0.5)), c1 = Math.min(W - 1, Math.floor((xs[k + 1] - ox) * PX - 0.5));
        for (let c = c0; c <= c1; c++) mask[r * W + c] = 1;
      }
    }
  }
  // --- Signed Distance (mm): außen +, innen −
  const dOut = edt2d(mask, W, H, 1), dIn = edt2d(mask, W, H, 0);
  const sdf = new Float32Array(W * H);
  for (let i = 0; i < sdf.length; i++) sdf[i] = (mask[i] ? -Math.sqrt(dIn[i]) + 0.5 : Math.sqrt(dOut[i]) - 0.5) / PX;
  // --- lokale Strichbreite → Hairline-Verdickung
  const negSdf = new Float32Array(W * H); for (let i = 0; i < negSdf.length; i++) negSdf[i] = -sdf[i];
  // Max-Filter ergibt Plateaus mit Sprüngen → glätten, sonst „Fransen“ an den Kanten
  const wloc = boxBlur(maxFilter(negSdf, W, H, Math.round(0.6 * PX)), W, H, Math.round(0.45 * PX)); // Fenster ±0,6 mm
  const inlay = style === 'farbe';           // Farbschrift: Tasche in der Wand, wird vom zweiten Filament bündig gefüllt
  const raised = style !== 'gestanzt' && !inlay;
  const WMIN = raised ? 0.9 : 0.8; // Nut ≥ 0,8 mm (2 Düsenbreiten) — sonst nur ein Kratzer im Druck
  const boldExtra = style === 'gestanzt' ? 0.10 : 0;
  const dEff = new Float32Array(W * H);
  for (let i = 0; i < dEff.length; i++) {
    const w = 2 * Math.max(0, wloc[i]);
    const delta = Math.min(0.35, Math.max(0, (WMIN - w) / 2));
    dEff[i] = sdf[i] - delta - boldExtra;
  }
  // --- Strichbreiten-Statistik (10. Perzentil der Medialachsen-Breite nach Verdickung)
  const widths = [];
  for (let r = 1; r < H - 1; r++) for (let c = 1; c < W - 1; c++) {
    const i = r * W + c, v = -dEff[i]; if (v <= 0) continue;
    if (v >= -dEff[i - 1] && v >= -dEff[i + 1] && v >= -dEff[i - W] && v >= -dEff[i + W]) widths.push(2 * v);
  }
  widths.sort((a, b) => a - b);
  const strokeP10 = widths.length ? widths[Math.floor(0.1 * (widths.length - 1))] : 0;
  // --- Höhenfeld mit richtungsabhängiger Fase
  const isEgg = product === 'eierbecher';
  const Hgt = (style === 'gestanzt' || inlay) ? (isEgg ? 0.5 : 0.6) : style === 'kissen' ? (isEgg ? 0.85 : 1.0) : (isEgg ? 0.55 : 0.65);
  const B_CRISP = style === 'kissen' ? 0.6 : inlay ? 0.12 : 0.3;
  // Inlay: fast senkrechte Taschenwände (die Einlage stützt beim Druck die Decke — keine Rampe nötig)
  const B_OVER = inlay ? B_CRISP : Math.max(B_CRISP, Hgt / Math.tan((TEXT_FLANK_DEG * Math.PI) / 180));
  const sign = raised ? 1 : -1;
  // Kantenrichtung: Gradient des (ungeglätteten) Distanzfelds mit 2-px-Stencil, dann leicht geglättet
  const kField = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c;
    const gx = sdf[Math.min(W - 1, c + 2) + r * W] - sdf[Math.max(0, c - 2) + r * W];
    const gy = sdf[c + Math.min(H - 1, r + 2) * W] - sdf[c + Math.max(0, r - 2) * W];
    const gl = Math.hypot(gx, gy) || 1;
    const ny = gy / gl;
    // erhaben: Unterseite = Normale zeigt nach unten (−ny); gestanzt: Höhlendecke = Normale nach oben (+ny)
    kField[i] = Math.min(1, Math.max(0, raised ? -ny : ny));
  }
  const kSmooth = boxBlur(kField, W, H, 2);
  const h = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c;
    const de = dEff[i];
    if (de >= 0) continue;
    const k = kSmooth[i];
    const b = B_CRISP + (B_OVER - B_CRISP) * smoothstep(0.35, 0.85, k);
    // Schmale Striche: Fase über fast die halbe Strichbreite mit rundem Grund (U-Profil wie eine
    // V-Bit-Gravur) — ein flacher 0,1-mm-Boden würde vom Wandraster nur alle zwei Samples getroffen (Perlenkette)
    const w = 2 * Math.max(0, wloc[i]);
    // Kissen: Wölbung über die ganze Strichbreite (echte Kuppel), sonst nur schmale Striche runden
    const bEff = style === 'kissen' ? Math.max(b, 0.6 * w) : inlay ? b : Math.max(b, Math.min(0.6, 0.45 * w));
    const s = Math.min(1, -de / bEff);
    const prof = style === 'kissen' ? Math.sqrt(1 - (1 - s) * (1 - s)) : bEff > b + 1e-6 ? s * (2 - s) : s;
    h[i] = sign * Hgt * prof;
  }
  // Ein Pixel Glättung: bilineare Abtastung + Normalen aus Differenzen bleiben glatt (kein „Sand“ auf den Flanken)
  const hS = boxBlur(h, W, H, 2);
  const field = {
    width: maxx - minx, height: maxy - miny, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2,
    depth: sign * Hgt, strokeP10, missing, style,
    /** Höhe (mm) an (u, v) relativ zur Textmitte; u nach rechts, v nach oben */
    sample(u, v) {
      const fx = (u + this.cx - ox) * PX - 0.5, fy = (v + this.cy - oy) * PX - 0.5;
      if (fx < 0 || fy < 0 || fx >= W - 1 || fy >= H - 1) return 0;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const i = y0 * W + x0;
      return (hS[i] * (1 - tx) + hS[i + 1] * tx) * (1 - ty) + (hS[i + W] * (1 - tx) + hS[i + W + 1] * tx) * ty;
    },
    /** Signed Distance (mm) — für Halo/Plattentextur */
    dist(u, v) {
      const fx = (u + this.cx - ox) * PX - 0.5, fy = (v + this.cy - oy) * PX - 0.5;
      if (fx < 0 || fy < 0 || fx >= W - 1 || fy >= H - 1) return PAD;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const i = y0 * W + x0;
      return (dEff[i] * (1 - tx) + dEff[i + 1] * tx) * (1 - ty) + (dEff[i + W] * (1 - tx) + dEff[i + W + 1] * tx) * ty;
    },
  };
  if (fieldCache.size > 24) fieldCache.delete(fieldCache.keys().next().value);
  fieldCache.set(key, field);
  return field;
}

/** Abgerundetes Rechteck als Signed Distance (mm), negativ innen */
export function roundedRectSDF(u, v, halfW, halfH, radius) {
  const qx = Math.abs(u) - (halfW - radius), qy = Math.abs(v) - (halfH - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}
