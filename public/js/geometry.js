// OVJU — parametrische Geometrie für Eierbecher & Vasen
// Erzeugt wasserdichte (manifold) Meshes in Millimetern, bereit für den 3D-Druck.
import * as THREE from 'three';
import { buildVoronoiShell, cellDistance, cellCount } from './voronoi-shell.js';

// ---------------------------------------------------------------------------
// Produkte & Form-Presets: Silhouetten als (t, r)-Kontrollpunkte.
// t = 0..1 (Höhe von unten nach oben), r relativ zum Maximalradius.
// ---------------------------------------------------------------------------
export const PRODUCTS = {
  vase: {
    label: 'Vase',
    icon: '🏺',
    heightRange: [90, 220],
    defaultHeight: 150,
    maxRadius: 45,
    presets: {
      flasche: {
        label: 'Flasche',
        points: [
          [0.00, 0.80], [0.08, 0.94], [0.30, 1.00], [0.52, 0.96],
          [0.66, 0.74], [0.78, 0.44], [0.88, 0.38], [1.00, 0.40],
        ],
      },
      kugel: {
        label: 'Kugel',
        points: [
          [0.00, 0.52], [0.12, 0.84], [0.34, 1.00], [0.58, 0.92],
          [0.74, 0.62], [0.85, 0.44], [0.94, 0.42], [1.00, 0.48],
        ],
      },
      tropfen: {
        label: 'Tropfen',
        points: [
          [0.00, 0.46], [0.14, 0.78], [0.38, 1.00], [0.62, 0.88],
          [0.82, 0.60], [0.94, 0.42], [1.00, 0.36],
        ],
      },
      zylinder: {
        label: 'Zylinder',
        points: [
          [0.00, 0.94], [0.25, 1.00], [0.75, 1.00], [1.00, 0.97],
        ],
      },
      kurve: {
        label: 'Kurve',
        points: [
          [0.00, 0.74], [0.14, 0.90], [0.30, 0.70], [0.50, 0.55],
          [0.68, 0.72], [0.86, 0.98], [1.00, 0.94],
        ],
      },
    },
  },
  eierbecher: {
    label: 'Eierbecher',
    icon: '🥚',
    heightRange: [35, 75],
    defaultHeight: 58,
    maxRadius: 24,
    presets: {
      kelch: {
        label: 'Kelch',
        points: [
          [0.00, 0.62], [0.07, 0.68], [0.16, 0.58], [0.28, 0.52],
          [0.42, 0.66], [0.60, 0.85], [0.80, 0.96], [0.93, 1.00], [1.00, 0.98],
        ],
      },
      schale: {
        label: 'Schale',
        points: [
          [0.00, 0.55], [0.06, 0.63], [0.22, 0.78], [0.45, 0.90],
          [0.70, 0.97], [0.90, 1.00], [1.00, 1.00],
        ],
      },
      tulpe: {
        label: 'Tulpe',
        points: [
          [0.00, 0.72], [0.08, 0.74], [0.20, 0.62], [0.35, 0.58],
          [0.55, 0.76], [0.75, 0.93], [0.90, 1.00], [1.00, 0.95],
        ],
      },
    },
  },

};

// Schriften für die Gravur (typeface.json im fonts/-Ordner)
export const FONTS = {
  helvetiker: { label: 'Modern', file: 'helvetiker_bold.typeface.json' },
  optimer: { label: 'Soft', file: 'optimer_bold.typeface.json' },
  gentilis: { label: 'Fein', file: 'gentilis_bold.typeface.json' },
  droid_sans: { label: 'Kräftig', file: 'droid_sans_bold.typeface.json' },
  droid_serif: { label: 'Klassisch', file: 'droid_serif_bold.typeface.json' },
  marcellus: { label: 'Edel', file: 'marcellus.typeface.json' },
  greatvibes: { label: 'Kalligrafie', file: 'greatvibes.typeface.json' },
};

export const PATTERNS = {
  glatt: 'Glatt',
  rippen: 'Rippen',
  wellen: 'Wellen',
  lamellen: 'Lamellen',
  zickzack: 'Zickzack',
  querwellen: 'Querwellen',
  gehaemmert: 'Gehämmert',
  skelett: 'Voronoi',
  koralle: 'Fjordwelle',
};

// Verlauf: wie das Muster über die Höhe „fließt“ (Phasenverschiebung φ(t))
export const FLOWS = {
  spirale: 'Spirale',
  gegen: 'Gegenläufig',
  fluss: 'Wellenfluss',
  zick: 'Zickzack',
};

// Gravur-Stile: „geprägt“ = aufgesetzte Buchstaben (TextGeometry), die beiden
// anderen werden als Relief direkt in die Wand gerechnet (siehe rasterizeText/surface).
export const TEXT_STYLES = {
  gepraegt: { label: 'Geprägt', hint: 'scharfe, aufgesetzte Buchstaben' },
  gehaemmert: { label: 'Gehämmert', hint: 'erhabene Buchstaben mit Hammerschlag-Facetten' },
  gestanzt: { label: 'Gestanzt', hint: 'in die Wand gedrückt, wie ein Metallstempel' },
};
export const isIntegratedTextStyle = (st) => st === 'gehaemmert' || st === 'gestanzt';

export const DEFAULTS = {
  product: 'vase',
  preset: 'flasche',
  height: 150,       // mm
  width: 1.0,        // Faktor 0.85..1.15 auf den Maximalradius
  pattern: 'rippen',
  ribs: 64,          // Anzahl Rippen/Wellen
  depth: 0.9,        // Amplitude in mm (0..1.6)
  twist: 0,          // -2..2 — Stärke des Verlaufs (0 = gerade)
  flow: 'spirale',   // 'spirale' | 'gegen' | 'fluss' | 'zick'
  flowWaves: 3,      // Richtungswechsel bei fluss/zick (2..8)
  text: '',
  textSize: 7,       // mm
  textPos: 0.55,
  textStyle: 'gepraegt',     // Gravur-Höhe als Anteil der Gesamthöhe (0.15..0.8)
  font: 'helvetiker',
  customPoints: null, // eigene Silhouette [[t,r],...] wenn preset === 'eigene'
  quality: 1,        // 0.5..1 — Mesh-Auflösung (Mobile-Vorschau niedriger)
};

const CHAMFER = 0.8;        // Boden-Fase
const RIM_MIN_WALL = 2.6;   // minimale Randbreite Eierbecher
const CAVITY_R_MAX = 21.0;  // Ei-Mulde Öffnungsradius (Ei ≈ 44 mm breit)
const VASE_WALL = 2.2;      // Vasen-Wandstärke (zusätzlich zur Rippen-Tiefe)
const VASE_FLOOR = 3.0;     // Vasen-Bodendicke

// ---------------------------------------------------------------------------
// Kubische Hermite-Interpolation (Catmull-Rom für nicht-uniforme Knoten)
// ---------------------------------------------------------------------------
function makeCurve(points) {
  const ts = points.map((p) => p[0]);
  const rs = points.map((p) => p[1]);
  const n = points.length;
  const tangents = rs.map((_, i) => {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    return (rs[i1] - rs[i0]) / (ts[i1] - ts[i0]);
  });
  return (t) => {
    t = Math.min(1, Math.max(0, t));
    let i = 0;
    while (i < n - 2 && t > ts[i + 1]) i++;
    const h = ts[i + 1] - ts[i];
    const u = (t - ts[i]) / h;
    const u2 = u * u, u3 = u2 * u;
    return (
      (2 * u3 - 3 * u2 + 1) * rs[i] +
      (u3 - 2 * u2 + u) * h * tangents[i] +
      (-2 * u3 + 3 * u2) * rs[i + 1] +
      (u3 - u2) * h * tangents[i + 1]
    );
  };
}

/** Silhouette als [t, r]-Polyline sampeln (für Preset-Icons & Formen-Editor). */
export function sampleProfile(points, n = 40) {
  const curve = makeCurve(points);
  const out = [];
  for (let i = 0; i <= n; i++) out.push([i / n, curve(i / n)]);
  return out;
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// θ-basierte Muster: -1..1 über den Phasenwinkel
function waveTheta(pattern, phase) {
  const c = (Math.cos(phase) + 1) / 2; // 0..1
  if (pattern === 'rippen') return Math.pow(c, 2.2) * 2 - 1;              // schmale Grate
  if (pattern === 'zickzack') return (2 / Math.PI) * Math.asin(Math.sin(phase)); // Facetten
  if (pattern === 'lamellen') return Math.pow(c, 0.42) * 2 - 1;           // breite Stege, tiefe schmale Schlitze
  return c * 2 - 1;                                                        // weiche Wellen
}

// Gehämmert: echte Hammerschlag-Dellen — deterministisch gejittertes Gitter
// runder Kugelkalotten; wo sich Dellen treffen, entstehen scharfe Facettenkanten
// (max-Verknüpfung). Gitter läuft in θ über n Zellen → Naht bleibt geschlossen.
const fract = (x) => x - Math.floor(x);
const hash2 = (i, j, s) => fract(Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453);
function hammerField(theta, w, n, lambda) {
  const u = (theta / (2 * Math.PI)) * n; // Zellkoordinaten: u ∈ [0, n)
  const v = w / lambda;
  const iu = Math.floor(u), iv = Math.floor(v);
  let best = 0;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const gi = iu + di, gj = iv + dj;
      const ci = ((gi % n) + n) % n; // θ-Wrap für den Hash (nahtlos)
      const jx = hash2(ci, gj, 1), jy = hash2(ci, gj, 2);
      const cx = gi + 0.5 + (jx - 0.5) * 0.75; // Schlagzentrum, gejittert
      const cy = gj + 0.5 + (jy - 0.5) * 0.75;
      const R = 0.82 + jx * 0.38;              // Schlaggröße variiert
      const d2 = ((u - cx) ** 2 + (v - cy) ** 2) / (R * R);
      if (d2 < 1) best = Math.max(best, Math.sqrt(1 - d2)); // Kugelkalotte
    }
  }
  return 0.9 - 1.9 * best; // Dellen nach innen, schmale Grate zwischen den Schlägen
}

// ---------------------------------------------------------------------------
// Schrift-Maske: Umrisse der Buchstaben (Font.generateShapes) werden per
// Scanline (even-odd → Löcher automatisch richtig) mit Antialiasing in ein
// Raster gerastert. Reine JS-Implementierung → läuft im Browser UND in Node.
// ---------------------------------------------------------------------------
const maskCache = new Map();
function rasterizeText(font, text, size, chamfer) {
  const key = `${font.data?.familyName || ''}|${text}|${size}|${chamfer}`;
  if (maskCache.has(key)) return maskCache.get(key);
  const PX = 8;          // Pixel pro mm (0,125 mm) — feiner als jede Düse
  const PAD = 1.2;       // Rand in mm (Platz für die Fase)
  const SUB = 4;         // Sub-Scanlines pro Pixelzeile (vertikales AA)
  const glyphs = []; // je Form: [Außenkontur, ...Löcher]
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const shape of font.generateShapes(text, size)) {
    const pts = shape.extractPoints(6);
    const loops = [pts.shape, ...pts.holes].filter((l) => l.length >= 3);
    if (!loops.length) continue;
    glyphs.push(loops);
    for (const loop of loops) for (const q of loop) {
      if (q.x < minx) minx = q.x; if (q.x > maxx) maxx = q.x;
      if (q.y < miny) miny = q.y; if (q.y > maxy) maxy = q.y;
    }
  }
  if (!glyphs.length) return null;
  const ox = minx - PAD, oy = miny - PAD;
  const W = Math.ceil((maxx - minx + 2 * PAD) * PX), H = Math.ceil((maxy - miny + 2 * PAD) * PX);
  const m = new Float32Array(W * H);
  const tmp = new Float32Array(W * H);
  const xs = [];
  // Jede Glyph-Form einzeln (Außenkontur + Löcher, even-odd), dann Vereinigung per max —
  // sonst löschen sich überlappende Konturen benachbarter Buchstaben gegenseitig aus.
  for (const glyph of glyphs) {
    tmp.fill(0);
    const edges = [];
    for (const loop of glyph) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        if (a.y !== b.y) edges.push([a.x, a.y, b.x, b.y]);
      }
    }
    for (let r = 0; r < H; r++) {
      for (let sr = 0; sr < SUB; sr++) {
        const y = oy + (r + (sr + 0.5) / SUB) / PX;
        xs.length = 0;
        for (const [x0, y0, x1, y1] of edges) {
          if ((y >= y0) !== (y >= y1)) xs.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0));
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const pa = (xs[k] - ox) * PX, pb = (xs[k + 1] - ox) * PX; // Pixelkoordinaten des Spans
          const c0 = Math.max(0, Math.floor(pa)), c1 = Math.min(W - 1, Math.floor(pb));
          for (let c = c0; c <= c1; c++) {
            const cov = Math.min(pb, c + 1) - Math.max(pa, c); // horizontale Abdeckung 0..1
            if (cov > 0) tmp[r * W + c] += cov / SUB;
          }
        }
      }
    }
    for (let i = 0; i < m.length; i++) if (tmp[i] > m[i]) m[i] = Math.min(1, tmp[i]);
  }
  // Druck-Fase (Zeile 0 = unten): erhabene Buchstaben brauchen UNTER sich eine ~45°-Rampe
  // (Schmierung nach unten), gestanzte Buchstaben ÜBER sich (Decke der Vertiefung →
  // Schmierung nach oben). acc = max(m, acc − Δ/w) — die übrigen Kanten bleiben scharf.
  if (chamfer) {
    const step = (1 / PX) / Math.abs(chamfer);
    for (let c = 0; c < W; c++) {
      let acc = 0;
      if (chamfer > 0) for (let r = H - 1; r >= 0; r--) { acc = Math.max(m[r * W + c], acc - step); m[r * W + c] = acc; }
      else for (let r = 0; r < H; r++) { acc = Math.max(m[r * W + c], acc - step); m[r * W + c] = acc; }
    }
  }
  const mask = {
    width: maxx - minx, height: maxy - miny,
    cx: (minx + maxx) / 2, cy: (miny + maxy) / 2,
    /** Abdeckung 0..1 an (u, v) in mm relativ zur Textmitte (u nach rechts, v nach oben) */
    sample(u, v) {
      const fx = (u + this.cx - ox) * PX - 0.5, fy = (v + this.cy - oy) * PX - 0.5;
      if (fx < 0 || fy < 0 || fx >= W - 1 || fy >= H - 1) return 0;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const i = y0 * W + x0;
      return (m[i] * (1 - tx) + m[i + 1] * tx) * (1 - ty) + (m[i + W] * (1 - tx) + m[i + W + 1] * tx) * ty;
    },
  };
  if (maskCache.size > 24) maskCache.delete(maskCache.keys().next().value);
  maskCache.set(key, mask);
  return mask;
}

// ---------------------------------------------------------------------------
/**
 * Baut die Becher-/Vasen-Geometrie (ohne aufgesetzten Text; Relief-Gravuren
 * „gehämmert“/„gestanzt“ sind Teil der Wand, wenn params.textFont gesetzt ist).
 * Rückgabe: { geometry, info } — indexed BufferGeometry in mm,
 * y-Achse = Höhe, Ursprung in der Bodenmitte.
 */
export function buildModel(params) {
  const p = { ...DEFAULTS, ...params };
  const product = PRODUCTS[p.product] || PRODUCTS.eierbecher;
  const isVase = p.product === 'vase';
  const points =
    (p.preset === 'eigene' && Array.isArray(p.customPoints) && p.customPoints.length >= 4)
      ? p.customPoints
      : (product.presets[p.preset] || Object.values(product.presets)[0]).points;
  const curve = makeCurve(points);

  const [hMin, hMax] = product.heightRange;
  const H = Math.min(hMax, Math.max(hMin, p.height));
  const rMax = product.maxRadius * p.width;
  const R = (t) => Math.max(0.08, curve(t)) * rMax; // glatter Außenradius, gegen 0 geklemmt

  // Ästhetik-Klemmen (aus dem Design-Judge-Panel abgeleitet):
  // (a) Zickzack-Muster braucht ≥ 24 Facetten, sonst liest jede einzeln als Treppe.
  const ribs = p.pattern === 'zickzack' ? Math.max(24, p.ribs) : p.ribs;
  // (b) Tiefe an Muster & Rippenzahl koppeln: zu tief bei groben Rippen = klobig,
  //     zu tief bei feinen Rippen = Moiré. Lamellen dürfen bewusst tief sein
  //     (senkrechte Schlitze = 0° Überhang), Gehämmert bleibt Mikro-Textur.
  let depthCap;
  if (p.pattern === 'lamellen') depthCap = isVase ? 6 : 3;
  else if (p.pattern === 'gehaemmert') depthCap = 1.2;
  else if (p.pattern === 'skelett') depthCap = isVase ? 1.8 : 1.0;
  else if (p.pattern === 'koralle') depthCap = isVase ? 6 : 1.0;
  else depthCap = ribs < 24 ? 1.1 : ribs > 56 ? 1.0 : 1.6;
  const amp = p.pattern === 'glatt' ? 0 : Math.min(p.depth, depthCap);
  const twistAngle = p.twist * Math.PI;
  // Verlauf des Musters über die Höhe: Phasenverschiebung φ(t).
  // Wichtig: φ hängt nur von t ab (nicht von θ) → Naht bei θ=2π bleibt geschlossen.
  // (c) Richtungswechsel begrenzen: Wellenfluss flirrt auf dichten Rippen
  //     (waves ≤ 160/ribs), Zickzack-Bänder brauchen genug Höhe (≥ ~22 mm/Band).
  const wavesCapRibs = p.flow === 'fluss' ? Math.max(2, Math.floor(160 / Math.max(1, ribs))) : 6;
  const wavesCapH = p.flow === 'zick' ? Math.max(2, Math.floor(H / 22)) : 6;
  const waves = Math.min(6, wavesCapRibs, wavesCapH, Math.max(2, Math.round(p.flowWaves ?? 3)));
  // (d) Rippenlinien-Neigung β = atan(R·dφ/dy) klemmen: Spirale/Wellenfluss ≤ 62°,
  //     Umkehr-Verläufe ≤ 55° (die Umkehrzonen vertragen weniger Steilheit).
  const ZK = 1.35; // Trapez-Faktor: sanft verrundetes Zickzack (kein „Reifenprofil“)
  const dphiMax = {
    spirale: Math.abs(twistAngle),
    gegen: Math.abs(twistAngle) * Math.PI,
    fluss: Math.abs(twistAngle) * Math.PI * waves,
    zick: Math.abs(twistAngle) * Math.PI * waves * ZK,
  }[p.flow] ?? Math.abs(twistAngle);
  let tanLimit = (p.flow === 'gegen' || p.flow === 'zick') ? 1.43 : 1.88; // tan55° / tan62°
  if (p.flow === 'zick' && H < 100) tanLimit = 1.0; // kleine Objekte: subtileres Fischgrät (≤45°)
  // Tiefe Lamellen sind KEINE Mikro-Textur mehr — ihre Flanken müssen fast
  // senkrecht bleiben, sonst entstehen echte 5-mm-Überhänge (≤ ~30°).
  if (p.pattern === 'lamellen' && amp > 2) tanLimit = 0.58;
  const slopeLimit = tanLimit * H / rMax;
  const A = twistAngle * (dphiMax > 1e-9 ? Math.min(1, slopeLimit / dphiMax) : 1);
  const flowPhase = (t) => {
    switch (p.flow) {
      case 'gegen': // sanft hoch- und zurückdrehen (Sinus-Halbwelle, kein Knick)
        return A * Math.sin(Math.PI * t);
      case 'fluss': // Rippen schlängeln sich sinusförmig („Wavy Vase“)
        return (A / 2) * Math.sin(2 * Math.PI * waves * t);
      case 'zick': // Fischgrät: diagonale Bänder mit verrundeten Umkehrzonen
        return (A / 2) * Math.max(-1, Math.min(1, ZK * Math.sin(2 * Math.PI * waves * t)));
      default: // 'spirale' — klassischer linearer Drall
        return A * t;
    }
  };
  const flowOsc = (p.flow === 'fluss' || p.flow === 'zick') ? waves : 1;
  const isQuer = p.pattern === 'querwellen';
  // Querwellen: vertikale Wellenanzahl aus dem Rippen-Regler, aber druckbar gehalten:
  // Wellenlänge ≥ ~10 mm und Amplitude so geklemmt, dass der Überhang ≤ ~50° bleibt
  // (Steigung dr/dy = amp·2π·n/H → amp_max = tan(50°)·H/(2π·n)).
  const quersV = Math.min(Math.max(2, Math.round(p.ribs / 5)), Math.max(2, Math.floor(p.height / 10)));
  const querK = Math.round(p.twist * 2);
  const querAmpMax = 1.19 * p.height / (2 * Math.PI * quersV);

  const q = Math.min(1, Math.max(0.4, p.quality));
  // Radiale Auflösung: ≥ 12 Segmente pro Rippenperiode (Zickzack 16), sonst
  // zittern die Gratlinien körnig über die Ringe („zackig“ statt samtig).
  const fineExport = !!p.exportRes; // STL-Export: feinstes Raster; Vorschau bleibt flüssig
  const rsFactor = { zickzack: 16, lamellen: 14, gehaemmert: fineExport ? 18 : 14 }[p.pattern] || 12; // Gehämmert: Facettenkanten brauchen ≤ 0,3 mm Abtastung
  // Segmente pro Rippe (ganzzahlig!) → Gratspitzen liegen auf jedem Ring exakt auf einem Vertex
  const perRib = Math.max(6, Math.round(Math.min(Math.max(rsFactor, Math.ceil(240 / ribs)), Math.floor(1080 / ribs)) * q));
  const RS = ribs * perRib;
  const wallBase = isVase ? Math.max(160, H * 1.4) : 130;
  const querExtra = isQuer ? quersV * 14 : 0;
  const isHammer = p.pattern === 'gehaemmert';
  // Gehämmert: Ringabstand ≈ Umfangsschritt (≈ 0,3 mm), sonst treppige Dellenränder im Druck
  const hammerRows = isHammer ? (fineExport ? 1.7 : 1.35) : 1;
  const WALL_STEPS = Math.round(Math.min(isHammer ? 720 : 430, wallBase * hammerRows + Math.abs(twistAngle) * 36 * Math.min(3, flowOsc) + querExtra) * q);
  const CAVITY_STEPS = Math.round(36 * q);
  const INNER_STEPS = Math.round(44 * q);

  // Rippen-Fade: unten glatt (Druckbett), oben sanft auslaufend — ausgefranste
  // Ränder waren der meistgenannte Kritikpunkt im Design-Panel.
  const fade = (t) => {
    let f = p.pattern === 'koralle' ? smoothstep(0.06, 0.22, t) : smoothstep(0.02, 0.12, t);
    f *= smoothstep(1.0, isQuer ? 0.93 : p.pattern === 'koralle' ? 0.92 : 0.96, t);
    return f;
  };
  const ampAt = (t) => amp * fade(t);

  // Oberflächen-Versatz an Position (θ, t)
  const offset = (theta, t) => {
    let a = ampAt(t);
    if (a < 1e-4) return 0;
    if (isQuer) {
      a = Math.min(a, querAmpMax);
      return a * Math.sin(2 * Math.PI * quersV * t + querK * theta);
    }
    if (p.pattern === 'koralle') {
      // Broad travelling waves modulate fine, continuous ribs. The long axial
      // wavelength keeps the sculptural folds printable at small heights too.
      const bend = 0.16 * Math.sin(2 * Math.PI * t - 0.8);
      const angle = theta + flowPhase(t) * 0.22 + bend;
      const swell = Math.sin(3 * angle + 2 * Math.PI * t);
      const fin = Math.pow((1 + Math.cos(ribs * angle)) / 2, 2.2);
      return a * (0.65 * swell + 0.35 * (2 * fin - 1));
    }
    if (p.pattern === 'skelett') {
      const n = cellCount(ribs, rMax); // Zellteilung in mm begrenzt (≤ ~25 mm → keine langen Brücken)
      const d = cellDistance(theta + flowPhase(t) * 0.18, t * H, n, Math.max(18, H / 8));
      // Egg cups keep their solid cavity. Vases use this relief on a cut shell below.
      return a * (2 * Math.exp(-80 * d * d) - 1);
    }
    if (p.pattern === 'gehaemmert') {
      const n = Math.max(6, Math.round(ribs / 3));       // Dellen-Dichte aus dem Anzahl-Regler
      const lambda = (2 * Math.PI * rMax) / n;           // ≈ runde Dellen (λ_vertikal ≈ λ_horizontal)
      return a * hammerField(theta + flowPhase(t), t * H, n, lambda);
    }
    return a * waveTheta(p.pattern, ribs * (theta + flowPhase(t)));
  };

  // --- Relief-Gravur („gehämmert“ / „gestanzt“): Schrift als Höhenfeld in der Wand.
  // Vorne (θ = 0) zentriert, Bogenlänge u = rMid·Δθ wie bei der aufgesetzten Schrift.
  const txt = String(p.text || '').trim();
  let relief = null; // { yText, y0, y1, rMid, mask, depth, style, size }
  const textInfo = { style: p.textStyle, size: p.textSize, warn: '' };
  if (txt && p.textFont && isIntegratedTextStyle(p.textStyle)) {
    const style = p.textStyle;
    const depth = style === 'gestanzt' ? -0.75 : 0.85;  // − = Vertiefung
    const tC = Math.min(0.97, Math.max(0.03, p.textPos ?? 0.55));
    const rMid = R(tC);
    let size = p.textSize ?? 7, mask = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      mask = rasterizeText(p.textFont, txt, size, depth * 1.3); // Fase ≈ 37° statt 45° (Silhouetten-Check + sauberer Druck)
      if (!mask || mask.width / rMid <= maxTextArc()) break;
      size *= 0.88;
    }
    if (mask && mask.width / rMid <= maxTextArc()) {
      const yText = tC * H;
      // Kartusche: glatte Platte um den Text (Muster darunter ausgeblendet), bündig
      // mit den Gratspitzen → Schrift liest sich wie auf einem Metallschild.
      const plateHalfW = mask.width / 2 + 1.7, plateHalfH = mask.height / 2 + 1.3;
      const plateRamp = 2.0;
      relief = { yText, rMid, mask, depth, style, size, plateHalfW, plateHalfH, plateRamp,
        plateR: Math.min(2.6, plateHalfH * 0.8),
        y0: Math.max(CHAMFER + 0.6, yText - plateHalfH - plateRamp - 0.2),
        y1: Math.min(H - 0.6, yText + plateHalfH + plateRamp + 0.2) };
      textInfo.size = size;
      if (size < (p.textSize ?? 7) - 0.01) textInfo.warn = `Text automatisch auf ${size.toFixed(1)} mm verkleinert.`;
    } else if (mask) textInfo.warn = 'Text zu lang — bitte kürzen.';
  }
  // Hammerschlag-Facetten auf den Buchstaben (feiner als das Wand-Muster)
  const letterDent = relief && relief.style === 'gehaemmert' ? (() => {
    const lam = 1.2, n = Math.max(8, Math.round((2 * Math.PI * relief.rMid) / lam));
    return (theta, y) => (0.9 - hammerField(theta, y, n, lam)) / 1.9; // 0 = Grat, 1 = tiefste Delle
  })() : null;
  const reliefAt = (theta, y) => {
    const d = ((theta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; // −π..π
    const u = relief.rMid * d, v = y - relief.yText;
    // Platte: abgerundetes Rechteck (SDF), weicher Rand über plateRamp (≤ ~45° am Druck)
    const qx = Math.abs(u) - (relief.plateHalfW - relief.plateR), qy = Math.abs(v) - (relief.plateHalfH - relief.plateR);
    const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - relief.plateR;
    const plate = 1 - smoothstep(-relief.plateRamp, 0, sd);
    if (plate <= 0) return { plate: 0, m: 0, h: 0 };
    const m = relief.mask.sample(u, v);
    let h = relief.depth;
    if (m > 0 && letterDent) h -= 0.4 * letterDent(theta, y);
    return { plate, m, h: m * h };
  };
  // Gesamtversatz: Muster unter der Platte ausblenden, Platte auf Grathöhe legen, Relief drauf
  const surface = (theta, t, y) => {
    const base = offset(theta, t);
    if (!relief || y < relief.y0 || y > relief.y1) return base;
    const { plate, h } = reliefAt(theta, y);
    if (plate <= 0) return base;
    const level = Math.min(1.5, 0.8 * ampAt(t)); // Plattenhöhe ≈ Gratspitzen (bei tiefen Lamellen begrenzt)
    return base * (1 - plate) + level * plate + h;
  };
  // Feinraster nur im Textband: Ringe alle ~0,2 mm, Umfang in ~0,2-mm-Schritten
  // (Vielfaches der Rippenzahl → Grate bleiben auf Vertices). Übergang zu den
  // gröberen Ringen per Reißverschluss-Vernähung in revolve().
  const fineStep = q >= 0.9 ? 0.2 : 0.3;
  const RS_T = relief
    ? Math.min(2600, ribs * Math.max(perRib, Math.ceil((2 * Math.PI * relief.rMid) / fineStep / ribs)))
    : RS;

  // --- Stationen: Kontur von Bodenmitte → außen hoch → Rand → innen → Achse
  const stations = [];
  const rBase = R(CHAMFER / H) - CHAMFER * 0.6;
  stations.push({ y: 0, r: 0 });
  stations.push({ y: 0, r: rBase * 0.55 });
  stations.push({ y: 0, r: rBase });
  const wallYs = [];
  for (let i = 0; i <= WALL_STEPS; i++) wallYs.push(CHAMFER + (i / WALL_STEPS) * (H - CHAMFER));
  if (relief) {
    const kept = wallYs.filter((y) => y < relief.y0 - 1e-6 || y > relief.y1 + 1e-6);
    const nFine = Math.max(2, Math.ceil((relief.y1 - relief.y0) / fineStep));
    for (let i = 0; i <= nFine; i++) kept.push(relief.y0 + (i / nFine) * (relief.y1 - relief.y0));
    kept.sort((a, b) => a - b);
    wallYs.length = 0; wallYs.push(...kept);
  }
  for (const y of wallYs) {
    const t = y / H;
    const inBand = relief && y >= relief.y0 - 1e-6 && y <= relief.y1 + 1e-6;
    stations.push(
      (ampAt(t) > 1e-4 || inBand)
        ? { y, rFn: (theta) => R(t) + surface(theta, t, y), rot: isQuer ? 0 : p.pattern === 'koralle' ? -(flowPhase(t) * 0.22 + 0.16 * Math.sin(2 * Math.PI * t - 0.8)) : -flowPhase(t), rs: inBand ? RS_T : RS }
        : { y, r: R(t) }
    );
  }

  let cavityDia = 0, cavityDepth = 0, openingDia = 0;
  if (!isVase) {
    // --- Eierbecher: Ei-Mulde als Kugelkappe
    const rTop = R(1);
    const rCav = Math.min(CAVITY_R_MAX, rTop - RIM_MIN_WALL - amp);
    const D = Math.min(20, H - 9);
    const Rs = (rCav * rCav + D * D) / (2 * D);
    const yc = H - D + Rs;
    const phiRim = Math.asin(Math.min(1, rCav / Rs));
    stations.push({ y: H, r: rCav });
    for (let i = 1; i < CAVITY_STEPS; i++) {
      const phi = phiRim * (1 - i / CAVITY_STEPS);
      stations.push({ y: yc - Rs * Math.cos(phi), r: Rs * Math.sin(phi) });
    }
    stations.push({ y: H - D, r: 0 });
    cavityDia = rCav * 2; cavityDepth = D;
  } else {
    // --- Vase: Innenwand folgt der Silhouette (Wandstärke konstant), Boden dicht
    const wallEff = VASE_WALL + amp;
    const rIn = (t) => Math.max(1.4, R(t) - wallEff);
    const tFloor = VASE_FLOOR / H;
    stations.push({ y: H, r: rIn(1) });
    for (let i = 1; i <= INNER_STEPS; i++) {
      const t = 1 - (1 - tFloor) * (i / INNER_STEPS);
      stations.push({ y: t * H, r: rIn(t) });
    }
    stations.push({ y: VASE_FLOOR, r: 0 });
    openingDia = rIn(1) * 2;
  }

  const openCells = isVase && p.pattern === 'skelett';
  let geometry = openCells
    ? buildVoronoiShell({H,R,rBase,rMax,ribs,amp,flowPhase,quality:q,exportRes:!!p.exportRes,surface,
        text:txt,textSize:textInfo.size,textPos:p.textPos ?? .55})
    : revolve(stations, RS);
  // Facettierte/durchbrochene Muster: Kanten scharf schattieren (Grate zwischen Dellen/Facetten, Lochränder),
  // Flächen dazwischen glatt. Weiche Vertex-Normalen würden die Kanten verschmieren — das sieht „unscharf“ aus.
  // (p.rawIndexed: Topologie-Tools brauchen die indizierte Geometrie.)
  if (!p.rawIndexed && (p.pattern === 'gehaemmert' || p.pattern === 'zickzack' || openCells)) {
    geometry = creaseNormals(geometry, p.pattern === 'gehaemmert' ? 26 : openCells ? 30 : 22);
  }

  return {
    geometry,
    info: {
      openCells,
      product: p.product,
      height: H,
      maxRadius: rMax,
      topDiameter: (R(1) + amp) * 2,
      baseDiameter: rBase * 2,
      cavityDiameter: cavityDia,
      cavityDepth,
      openingDiameter: openingDia,
      radialSegments: RS,
      text: textInfo, // Relief-Gravur: gewählter Stil, ggf. verkleinerte Größe, Warnung
      // Für die Text-Prägung: glatter Radius & Muster-Amplitude an Höhe t
      radiusAt: R,
      ampAt,
    },
  };
}

// Alias für bestehende Aufrufer/Tools
export const buildEggcup = buildModel;

// ---------------------------------------------------------------------------
// Rotationskörper aus Stationen (geschlossene Kontur → manifold Mesh).
// Stationen: { y, r } | { y, rFn(θ) }; r === 0 → degenerierter Punkt (Fächer).
// ---------------------------------------------------------------------------
// Kantenerhaltende Normalen: pro Dreiecksecke werden nur Nachbarflächen gemittelt, deren
// Normale um weniger als `creaseDeg` abweicht. Ergebnis ist eine nicht-indizierte Geometrie
// (gleiche Dreiecke, gleiche STL) mit scharfen Graten und glatten Flächen dazwischen.
export function creaseNormals(geometry, creaseDeg = 26) {
  const pos = geometry.getAttribute('position').array;
  const idx = geometry.index ? geometry.index.array : null;
  const triCount = idx ? idx.length / 3 : pos.length / 9;
  const vCount = pos.length / 3;
  const fN = new Float32Array(triCount * 3);
  const cosLimit = Math.cos((creaseDeg * Math.PI) / 180);
  // Flächen-Normalen (flächengewichtet: Länge des Kreuzprodukts)
  const vOf = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k);
  for (let t = 0; t < triCount; t++) {
    const a = vOf(t, 0) * 3, b = vOf(t, 1) * 3, c = vOf(t, 2) * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    fN[t * 3] = uy * wz - uz * wy; fN[t * 3 + 1] = uz * wx - ux * wz; fN[t * 3 + 2] = ux * wy - uy * wx;
  }
  // Vertex → Flächen (CSR)
  const deg = new Uint32Array(vCount + 1);
  for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) deg[vOf(t, k) + 1]++;
  for (let v = 0; v < vCount; v++) deg[v + 1] += deg[v];
  const fill = deg.slice(0, vCount);
  const adj = new Uint32Array(deg[vCount]);
  for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) adj[fill[vOf(t, k)]++] = t;
  const outPos = new Float32Array(triCount * 9), outNor = new Float32Array(triCount * 9);
  for (let t = 0; t < triCount; t++) {
    const nx = fN[t * 3], ny = fN[t * 3 + 1], nz = fN[t * 3 + 2];
    const nl = Math.hypot(nx, ny, nz) || 1;
    for (let k = 0; k < 3; k++) {
      const v = vOf(t, k);
      let sx = 0, sy = 0, sz = 0;
      for (let j = deg[v]; j < deg[v + 1]; j++) {
        const g = adj[j];
        const gx = fN[g * 3], gy = fN[g * 3 + 1], gz = fN[g * 3 + 2];
        const gl = Math.hypot(gx, gy, gz) || 1;
        if ((nx * gx + ny * gy + nz * gz) / (nl * gl) >= cosLimit) { sx += gx; sy += gy; sz += gz; }
      }
      const sl = Math.hypot(sx, sy, sz) || 1;
      const o = t * 9 + k * 3;
      outPos[o] = pos[v * 3]; outPos[o + 1] = pos[v * 3 + 1]; outPos[o + 2] = pos[v * 3 + 2];
      outNor[o] = sx / sl; outNor[o + 1] = sy / sl; outNor[o + 2] = sz / sl;
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(outNor, 3));
  geometry.dispose();
  return out;
}

// Reißverschluss zwischen zwei geschlossenen Ringen unterschiedlicher Auflösung:
// beide Ringe nach Winkel durchlaufen, immer die Seite mit dem kleineren nächsten
// Winkel vorrücken → jede Kante liegt in genau zwei Dreiecken (manifold),
// Orientierung wie bei den regulären Bändern (unten → oben).
function stitchRings(indices, aStart, na, aRot, bStart, nb, bRot) {
  const TAU = Math.PI * 2;
  const norm = (x) => ((x % TAU) + TAU) % TAU;
  const first = (rot, n) => { const k = Math.ceil(norm(-rot) / (TAU / n) - 1e-9) % n; return [k, norm(rot + (TAU * k) / n)]; };
  const [ka, angA0] = first(aRot, na), [kb, angB0] = first(bRot, nb);
  let i = 0, j = 0;
  while (i < na || j < nb) {
    const nextA = i < na ? angA0 + (TAU * (i + 1)) / na : Infinity;
    const nextB = j < nb ? angB0 + (TAU * (j + 1)) / nb : Infinity;
    const ai = aStart + (ka + i) % na, bj = bStart + (kb + j) % nb;
    if (nextA <= nextB) { indices.push(ai, aStart + (ka + i + 1) % na, bj); i++; }
    else { indices.push(ai, bStart + (kb + j + 1) % nb, bj); j++; }
  }
}

function revolve(stations, RS) {
  // Muster-Rotation der gemusterten Ringe auf die glatten Nachbarn (Rand, Innenwand, Boden, Mulde)
  // übertragen: sonst verbinden die Bänder dazwischen verdrehte Punkte → Sliver-Dreiecke, die
  // als feine Radialstreifen auf dem Rand sichtbar werden. Ein kreisrunder Ring ändert sich
  // durch die Rotation nicht.
  let rot = stations.find((st) => st.rot !== undefined)?.rot ?? 0;
  for (const st of stations) { if (st.rot === undefined) st.rot = rot; else rot = st.rot; }
  const positions = [];
  const ringStart = [];
  const ringN = [];   // Segmente je Ring (Textband feiner)
  const pointIdx = [];
  for (const st of stations) {
    if (st.r === 0 && !st.rFn) {
      pointIdx.push(positions.length / 3);
      ringStart.push(-1); ringN.push(0);
      positions.push(0, st.y, 0);
    } else {
      const n = st.rs || RS;
      ringStart.push(positions.length / 3); ringN.push(n);
      pointIdx.push(-1);
      for (let j = 0; j < n; j++) {
        const theta = (j / n) * Math.PI * 2 + (st.rot || 0); // Ring folgt dem Muster-Verlauf
        const r = st.rFn ? st.rFn(theta) : st.r;
        positions.push(Math.sin(theta) * r, st.y, Math.cos(theta) * r);
      }
    }
  }
  const indices = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = ringStart[i], b = ringStart[i + 1];
    const na = ringN[i], nb = ringN[i + 1];
    if (a === -1 && b === -1) continue;
    if (a === -1) {
      const c = pointIdx[i];
      for (let j = 0; j < nb; j++) indices.push(c, b + (j + 1) % nb, b + j);
    } else if (b === -1) {
      const c = pointIdx[i + 1];
      for (let j = 0; j < na; j++) indices.push(a + j, a + (j + 1) % na, c);
    } else if (na === nb) {
      for (let j = 0; j < na; j++) {
        const j1 = (j + 1) % na;
        indices.push(a + j, b + j1, b + j);
        indices.push(a + j, a + j1, b + j1);
      }
    } else {
      stitchRings(indices, a, na, stations[i].rot || 0, b, nb, stations[i + 1].rot || 0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// ---------------------------------------------------------------------------
/**
 * Untersetzer zum Eierbecher: flache Schale mit Sitz-Mulde für den Becherfuß
 * und Rand zum Auffangen der Eierschalen. Übernimmt Muster & Breite des
 * Bechers, damit beide zusammen wie ein Set wirken.
 * Rückgabe: { geometry, info: { outerRadius, seatHeight, height } }
 */
export function buildSaucer(params) {
  const p = { ...DEFAULTS, ...params };
  const product = PRODUCTS.eierbecher;
  const points =
    (p.preset === 'eigene' && Array.isArray(p.customPoints) && p.customPoints.length >= 4)
      ? p.customPoints
      : (product.presets[p.preset] || product.presets.kelch).points;
  const curve = makeCurve(points);
  const [hMin, hMax] = product.heightRange;
  const H = Math.min(hMax, Math.max(hMin, p.height));
  const rMax = product.maxRadius * p.width;
  const rBaseCup = Math.max(0.08, curve(CHAMFER / H)) * rMax - CHAMFER * 0.6;

  const rSeat = rBaseCup + 0.8;              // Sitz-Mulde: Becherfuß + Spiel
  const rOut = Math.max(rMax * 1.85, rSeat + 15);
  const hRim = 9;
  const seatFloor = 2.6;

  const amp = p.pattern === 'glatt' ? 0 : Math.min(1.6, p.depth); // Untersetzer-Rand bleibt moderat
  const q = Math.min(1, Math.max(0.4, p.quality));
  const RS = Math.round(Math.min(640, Math.max(200, p.ribs * 9)) * q);
  // Querwellen sind höhenbasiert — auf dem flachen Rand als normale Wellen zeigen
  const patt = (p.pattern === 'querwellen' || p.pattern === 'gehaemmert' || p.pattern === 'skelett' || p.pattern === 'koralle') ? 'wellen' : p.pattern;

  const stations = [];
  stations.push({ y: 0, r: 0 });
  stations.push({ y: 0, r: rOut * 0.5 });
  stations.push({ y: 0, r: rOut - 1 });
  stations.push({ y: 0.8, r: rOut });
  // Außenwand mit Muster (an beiden Enden ausblenden)
  const BAND = Math.max(8, Math.round(22 * q));
  for (let i = 1; i <= BAND; i++) {
    const s = i / BAND;
    const y = 0.8 + s * (hRim - 0.8 - 0.6);
    const a = amp * smoothstep(0, 0.3, s) * smoothstep(1, 0.7, s);
    stations.push(
      a > 1e-4
        ? { y, rFn: (theta) => rOut + a * waveTheta(patt, p.ribs * theta) }
        : { y, r: rOut }
    );
  }
  stations.push({ y: hRim, r: rOut - 0.9 });
  // Innenfläche: sanfte Schale hinab zur Sitz-Mulde
  const DISH = Math.max(8, Math.round(16 * q));
  const rInStart = rOut - 1.8, yInStart = hRim - 0.5;
  for (let i = 1; i <= DISH; i++) {
    const s = i / DISH;
    const ease = 1 - Math.pow(1 - s, 1.7);
    stations.push({
      y: yInStart - (yInStart - 3.4) * ease,
      r: rInStart - (rInStart - (rSeat + 1.2)) * s,
    });
  }
  stations.push({ y: 3.4, r: rSeat });
  stations.push({ y: seatFloor, r: rSeat });
  stations.push({ y: seatFloor, r: rSeat * 0.5 });
  stations.push({ y: seatFloor, r: 0 });

  return {
    geometry: revolve(stations, RS),
    info: { outerRadius: rOut, seatHeight: seatFloor, height: hRim },
  };
}

// ---------------------------------------------------------------------------
/**
 * Biegt eine extrudierte Text-Geometrie um die Wand und lässt sie der
 * Silhouette folgen (auch bei Taille/Bauch sitzt jeder Buchstabe auf der
 * lokalen Oberfläche). textPos = Höhe der Textmitte als Anteil von H.
 * Rückgabe-Overlap ~1.5 mm in der Wand → Slicer verschmilzt beide Körper.
 */
export function bendTextOntoCup(textGeo, info, textPos = 0.55) {
  textGeo.computeBoundingBox();
  const bb = textGeo.boundingBox;
  const wdt = bb.max.x - bb.min.x;
  const depth = bb.max.z - bb.min.z;
  const yCenter = textPos * info.height;
  const tC = Math.min(0.97, Math.max(0.03, textPos));
  const rMid = info.radiusAt(tC);

  const pos = textGeo.getAttribute('position');
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) - cx;
    const y = pos.getY(i) - cy;
    const z = pos.getZ(i) - bb.min.z;
    const yWorld = yCenter + y;
    const t = Math.min(0.99, Math.max(0.01, yWorld / info.height));
    // lokale Oberfläche an dieser Höhe: glatter Radius + Musterberge
    const rFace = info.radiusAt(t) + info.ampAt(t) + 0.55;                 // vor den Gratspitzen
    const rBack = Math.max(0.6, info.radiusAt(t) - info.ampAt(t) - 1.45);  // 1,45 mm unter dem tiefsten Mustertal (Voronoi/Fjordwelle!), noch vor der Innenwand
    const r = rBack + (rFace - rBack) * (z / depth);                       // Prisma linear zwischen Rückseite und Vorderseite
    const alpha = x / rMid;
    pos.setXYZ(i, Math.sin(alpha) * r, yWorld, Math.cos(alpha) * r);
  }
  pos.needsUpdate = true;
  textGeo.computeVertexNormals();
  return { arc: wdt / rMid, depth };
}

/** Maximale Textbreite (Bogen ≤ 55 % des Umfangs) — für UI-Feedback. */
export function maxTextArc() {
  return Math.PI * 1.1;
}
