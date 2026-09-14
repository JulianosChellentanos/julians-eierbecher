// OVJU — parametrische Geometrie für Eierbecher & Vasen
// Erzeugt wasserdichte (manifold) Meshes in Millimetern, bereit für den 3D-Druck.
import * as THREE from 'three';
import { buildVoronoiShell, cellDistance, cellCount } from './voronoi-shell.js';
import { buildGlyphField, measureText, roundedRectSDF, TEXT_STYLES, FONT_RULES, fontAllowsStyle, MAX_TEXT_ARC, FRONT_TEXT_ARC } from './textrelief.js';
export { TEXT_STYLES, FONT_RULES, fontAllowsStyle, MAX_TEXT_ARC, FRONT_TEXT_ARC };

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

// Oberer Rand: glatt (Muster läuft oben aus) | muster (Muster bis zur Kante, Kante folgt dem Muster) |
// wulst (runde Lippe außen, ohne Stützen druckbar). Bei offenen Voronoi-Vasen immer glatt.
export const RIMS = {
  glatt: 'Glatter Rand',
  muster: 'Musterkante',
  wulst: 'Wulstrand',
};

// Gravur-Stile (siehe textrelief.js): ALLE Stile werden als Relief direkt in die Wand gerechnet —
// ein manifold Körper, keine aufgesetzte Schrift mehr.
export const isIntegratedTextStyle = () => true;

export const DEFAULTS = {
  product: 'vase',
  preset: 'flasche',
  height: 150,       // mm
  width: 1.0,        // Faktor 0.85..1.15 auf den Maximalradius
  rim: 'glatt',      // oberer Rand: 'glatt' | 'muster' | 'wulst' (siehe RIMS)
  pattern: 'rippen',
  ribs: 64,          // Anzahl Rippen/Wellen
  depth: 0.9,        // Amplitude in mm (0..1.6)
  twist: 0,          // -2..2 — Stärke des Verlaufs (0 = gerade)
  flow: 'spirale',   // 'spirale' | 'gegen' | 'fluss' | 'zick'
  flowWaves: 3,      // Richtungswechsel bei fluss/zick (2..8)
  text: '',
  textSize: 7,       // mm
  textPos: 0.55,
  textStyle: 'gestanzt',     // Gravur-Höhe als Anteil der Gesamthöhe (0.15..0.8)
  font: 'helvetiker',
  customPoints: null, // eigene Silhouette [[t,r],...] wenn preset === 'eigene'
  quality: 1,        // 0.5..1 — Mesh-Auflösung (Mobile-Vorschau niedriger)
};

const CHAMFER = 0.8;        // Boden-Fase
const RIM_MIN_WALL = 2.6;   // minimale Randbreite Eierbecher
const CAVITY_R_MAX = 21.0;  // Ei-Mulde Öffnungsradius (Ei ≈ 44 mm breit)
const VASE_WALL = 2.2;      // Vasen-Wandstärke (zusätzlich zur Rippen-Tiefe)
const VASE_FLOOR = 3.0;     // Vasen-Bodendicke
const RIM_LIP_H = 4.5;      // Wulstrand: Höhe der Lippe (oberste mm)
const RIM_LIP_OUT = 1.6;    // Wulstrand: Ausladung nach außen (mm); Viertelrundung mit gleichem Radius
const RIM_LIP_RISE = 2.5;   // Wulstrand: Anstieg als Smoothstep über diese Höhe (max. Steigung 1,5·1,6/2,5 = 0,96 → 44°)
const VASE_OPEN_WARN = 18;  // Vase: unterhalb dieser Öffnung (Ø mm) Hinweis „eng für Blumen“
const VASE_OPEN_TIGHT = 10; // … darunter in Rot

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
// ---------------------------------------------------------------------------
// Tiefenabhängiges Schlagprofil („planierter Schlagnapf“).
// Bis HAM_SOFT (1,2 mm) ist das Feld exakt das klassische: Kugelkalotten gehen
// nach innen, die Schnittgrate dazwischen stehen 0,9·Tiefe NACH AUSSEN.
// Darüber kippt die Optik stufenlos zum handgetriebenen Blech:
//   • der Grat wandert auf die Silhouette zurück (Feldwert 0) — es beult nichts
//     mehr nach außen, alles Material geht nach innen;
//   • die Kalotte bekommt einen Absatz: die oberen HAM_SHELF werden abgeschnitten
//     und der Rest auf die volle Tiefe gestreckt → klar berandete Schlagnäpfe
//     in einem stehenbleibenden Netz aus unberührter Haut;
//   • am Napfrand läuft das Profil über ein schmales Band (HAM_KNEE) tangential
//     ins Land aus — kein harter Knick, der im Druck als Stufenring stehenbleibt;
//   • das Land senkt sich um HAM_LIP ein, nur direkt am Napfrand bleibt es auf
//     der Silhouette → schmaler heller Saum, der im Streiflicht als Netz leuchtet;
//   • jeder Schlag sitzt mit 87…100 % Stärke (HAM_VAR) — die Näpfe unterscheiden
//     sich, aber kein Schlag verkümmert zur Minidelle („Lunker“).
const HAM_SOFT = 1.2;      // mm — bis hierher gilt bitgleich das klassische Feld
const HAM_MAX_V = 2.5;     // mm — Höchsttiefe Vase (= Gravurgrenze, blockiert sie nie)
const HAM_MAX_E = 2.0;     // mm — Höchsttiefe Eierbecher (= Gravurgrenze)
const HAM_CELL = 0.32;     // Tiefe ≤ HAM_CELL·λ → Napfflanke ≈ 45…50° (gemessen, inkl. Grundform)
const HAM_RAMP = 0.7;      // Tempo, mit dem Absatz und Gratabsenkung hochlaufen (deep^HAM_RAMP)
const HAM_SHELF = 0.68;    // Absatz: Anteil der Kalotte, der bei voller Tiefe Land bleibt
const HAM_VAR = 0.13;      // Streuung der Schlagstärke (87…100 %)
const HAM_KNEE = 0.06;     // Einlaufband am Napfrand (in Kalottenmaß)
const HAM_LIP = 0.13;      // Einsenkung des Lands → heller Saum am Napfrand
const HAM_LIP_IN = 0.45;   // Breite dieses Saums (Anteil des Absatzes)
const HAM_BLEND = 0.10;    // weiche Verschneidung zweier Näpfe (statt scharfer Schnittgrat)
// --- Auflösung & Kantenvorfilterung der gehämmerten Wand -------------------
// Die Grate zwischen den Näpfen sind Schnittkanten zweier Kalotten: im Feld eine
// Knicklinie ohne Breite. Sie läuft schräg durch das Ring-/Umfangsnetz, deshalb
// bildet das Mesh sie als Zickzack ab — im Zoom als waagerechte Treppchen sichtbar.
// Zwei Hebel dagegen: (1) der Grat bekommt eine Verrundung, die genau so breit ist wie
// ein paar Rasterweiten DES TATSÄCHLICHEN NETZES — damit ist die Kante bandbegrenzt und
// das Netz kann sie sauber abtasten, ohne dass der Grat mehr aufgeweicht wird als nötig;
// (2) das Ringraster wird feiner, damit die Restzacke unter die Wahrnehmung fällt.
// Eine feste Breite in mm (vorher 1,5 mm) war unabhängig vom Raster gewählt und hat die
// Grate deutlich stärker verschliffen, als das Netz es verlangt.
const HAM_AA_ROWS = 2.5;     // Verrundungsbreite in Rasterweiten (gröbere aus Ring-/Umfangsabstand):
                             //   Desktop-Vorschau 0,95 mm · Export 0,82 mm · Eierbecher 0,52…0,81 mm
                             //   (vorher pauschal 1,50 mm, unabhängig vom Netz)
const HAM_AA_CELL = 0.10;    // Anteil der Zellgröße λ, den die Verrundung höchstens einnimmt
// Die weiche Verschneidung ist eine logarithmische Summe (Soft-Max) mit der Temperatur τ auf
// der Kalottenhöhe. Sie klingt exponentiell ab statt an einem harten Rand zu enden; damit eine
// Verrundungsbreite W dieselbe Kammkrümmung ergibt wie früher die Formel mit Träger ±W/2, gilt
// τ = 0,5·W·0,577/λ. Gemessen reicht etwas weniger: bei 0,45 sind die Treppen im Tiefenmodus
// nicht schlechter als vorher (RMS 0,65 statt 0,70) und der Kamm bleibt spürbar schärfer.
const HAM_LSE = 0.45;        // Verrundungsbreite → Temperatur der logarithmischen Summe
const HAM_LSE_CUT = 8;       // Abstände über 8·τ tragen < 3,4e-4·τ bei (< 0,1 µm) → exp() sparen
const HAM_ROW_VIEW = 0.38;   // mm — Ringabstand Vorschau (Desktop, quality ≥ 0,9); vorher 0,53 mm
const HAM_ROW_EXPORT = 0.30; // mm — Ringabstand STL-Export; vorher 0,42 mm
const HAM_ROW_SMALL = 0.78;  // mm — Ringabstand Handy/Vorschaubilder (quality < 0,9); vorher 0,96 mm
const HAM_ROWS_MAX = 720;    // Deckel für die Ringzahl (hohe Vase + volle Tiefe) — wie vor der Umstellung

const HAM_CAND = new Float64Array(9); // Napfhöhen der 3×3-Umgebung (einmal angelegt, kein GC)
// ampRel = 0 … 1: Anteil der Tiefe oberhalb von HAM_SOFT. Bei 0 und aaMM = 0 ist das
// Ergebnis bitgleich „0.9 − 1.9·best“ wie bisher (Default → plateDent() bleibt unverändert).
// aaMM: Breite, über die die Schnittgrate zwischen zwei Näpfen verrundet werden (mm, 0 = aus).
function hammerField(theta, w, n, lambda, ampRel = 0, aaMM = 0) {
  const u = (theta / (2 * Math.PI)) * n; // Zellkoordinaten: u ∈ [0, n)
  const v = w / lambda;
  const iu = Math.floor(u), iv = Math.floor(v);
  const deep = ampRel > 0 ? (ampRel < 1 ? ampRel : 1) : 0;
  // Absatz und Gratabsenkung laufen im selben Takt (deep^0,7): schon auf halbem
  // Reglerweg sind es Näpfe mit definiertem Rand und kein flaches Land mit Punkt.
  const gf = deep > 0 ? Math.pow(deep, HAM_RAMP) : 0;
  const kf = smoothstep(0, 1, deep);   // weiche Kurve: Streuung & Saum
  const varAmt = HAM_VAR * kf;         // bei deep = 0 exakt 0 → blow = 1 → bitgleich
  const kbDeep = HAM_LSE * HAM_BLEND * gf; // bei deep = 0 exakt 0 → harte max-Verknüpfung (bitgleich)
  // ALLE Näpfe der 3×3-Umgebung werden eingesammelt; die Verschneidung entsteht danach
  // EINMAL und reihenfolgeunabhängig. (Erst lief sie im Schleifendurchlauf mit — dann hing
  // das Ergebnis davon ab, welcher Napf gerade „best“ war. Danach über die beiden höchsten:
  // an Dreipunkten, wo zweit- und dritthöchster Napf tauschen, knickt „der zweithöchste“
  // aber selbst, und die Verrundung sprang zurück — eine feine Kerbe genau im Knotenpunkt.)
  // Temperatur der Verschneidung: Am Grat wachsen die Höhen der beiden Kalotten mit je
  // ≈ 0,577/λ je mm auseinander (zwei Näpfe, die sich auf halbem Radius treffen) — eine
  // Verrundung der Breite aaMM entspricht also der Höhendifferenz 0,577·aaMM/λ, umgerechnet
  // mit HAM_LSE auf die logarithmische Summe. So ist die Gratlinie bei jeder Schlagzahl und
  // jeder Form gleich breit in mm — und immer so breit wie ein paar Rasterweiten des Netzes.
  const kb = Math.max(aaMM > 0 ? (HAM_LSE * 0.577 * aaMM) / lambda : 0, kbDeep);
  let b1 = 0, nc = 0;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const gi = iu + di, gj = iv + dj;
      const ci = ((gi % n) + n) % n; // θ-Wrap für den Hash (nahtlos)
      const jx = hash2(ci, gj, 1), jy = hash2(ci, gj, 2);
      const cx = gi + 0.5 + (jx - 0.5) * 0.75; // Schlagzentrum, gejittert
      const cy = gj + 0.5 + (jy - 0.5) * 0.75;
      const R = 0.82 + jx * 0.38;              // Schlaggröße variiert
      const d2 = ((u - cx) ** 2 + (v - cy) ** 2) / (R * R);
      if (d2 < 1) {
        // Schlagstärke je Napf (kein zusätzlicher Sinus): 87…100 %. Schwächere
        // Schläge werden durch den Absatz auch etwas kleiner im Grundriss.
        const blow = 1 - varAmt * fract(jx + jy * 1.618);
        const cand = blow * Math.sqrt(1 - d2); // Kugelkalotte
        if (cand > b1) b1 = cand;              // harter Höchstwert — bitgleich wie bisher
        if (kb > 0) HAM_CAND[nc++] = cand;     // ohne Verrundung (plateDent) gar nicht erst sammeln
      }
    }
  }
  let best = b1;
  if (kb > 0 && (nc > 1 || b1 < HAM_LSE_CUT * kb)) {
    // Weiche Verschneidung als logarithmische Summe über ALLE Näpfe (kommutatives Soft-Max,
    // Temperatur kb): best = b1 + kb·ln Σ exp((c−b1)/kb). Sie ist symmetrisch in den Näpfen
    // und beliebig oft differenzierbar — an Dreipunkten gibt es deshalb keine Kerbe mehr.
    // Gewicht je Napf: smoothstep(0,1,c/kb). Ein Napf, der gerade erst auftaucht (c → 0),
    // bringt nichts ein — sonst entstünde an seinem Rand eine Stufe von kb·ln2 („Lunker“).
    // Das Land (Höhe 0) zählt immer mit Gewicht 1: es verschwindet nie, also darf es hart rein.
    let s = 0;
    const ik = 1 / kb;
    for (let i = 0; i < nc; i++) {
      const c = HAM_CAND[i], t = (b1 - c) * ik;
      if (t < HAM_LSE_CUT) s += (c < kb ? smoothstep(0, 1, c * ik) : 1) * (t > 0 ? Math.exp(-t) : 1);
    }
    if (b1 * ik < HAM_LSE_CUT) s += Math.exp(-b1 * ik);
    if (s > 0 && s !== 1) best = b1 + kb * Math.log(s); // s === 1 ⇒ nur ein Napf, nichts zu tun
  }
  if (deep <= 0) return 0.9 - 1.9 * best; // Dellen nach innen, schmale Grate dazwischen
  if (best > 1) best = 1;  // die weiche Verschneidung darf den Napf nicht tiefer als die Wandreserve machen
  const shelf = HAM_SHELF * gf;        // ab hier beginnt der Napf
  const ridge = 0.9 * (1 - smoothstep(0, 1, gf)); // Grat 0,9 → 0 (= Silhouette)
  const e = (HAM_KNEE * gf) / (1 - shelf);        // Einlaufband in Napfmaß
  const x = (best - shelf) / (1 - shelf);         // ≤ 0 = Land
  const bowl = x <= 0 ? 0 : (x < e ? (x * x) / (2 * e) : x - e / 2) / (1 - e / 2);
  const rim = smoothstep(HAM_LIP_IN * shelf, shelf, best); // 1 am Napfrand, 0 im Land
  return ridge - (ridge + 1) * bowl - HAM_LIP * kf * (1 - rim);
  // Wertebereich: ampRel = 0 → [−1, +0,9] (heute) … ampRel = 1 → [−1, 0].
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
  // Oberer Rand (RIMS): Voronoi-Vasen sind offene Schalen ohne Randzone → dort immer glatt
  const rim = RIMS[p.rim] ? p.rim : 'glatt';
  const openCells = isVase && p.pattern === 'skelett';
  const rimEff = openCells ? 'glatt' : rim;

  // Ästhetik-Klemmen (aus dem Design-Judge-Panel abgeleitet):
  // (a) Zickzack-Muster braucht ≥ 24 Facetten, sonst liest jede einzeln als Treppe.
  const ribs = p.pattern === 'zickzack' ? Math.max(24, p.ribs) : p.ribs;
  // (b) Tiefe an Muster & Rippenzahl koppeln: zu tief bei groben Rippen = klobig,
  //     zu tief bei feinen Rippen = Moiré. Lamellen dürfen bewusst tief sein
  //     (senkrechte Schlitze = 0° Überhang), Gehämmert bis zur Zellgrößen-Klemme.
  // Gehämmert: Dellenraster aus dem Anzahl-Regler — nHam Zellen über den Umfang,
  // Zellhöhe λ = Zellbreite bei rMax (≈ runde Näpfe).
  const nHam = Math.max(6, Math.round(ribs / 3));
  const lamHam = (2 * Math.PI * rMax) / nHam;
  // (Die Breite der Gratvorfilterung hamAA steht weiter unten — sie hängt am tatsächlichen
  //  Ring-/Umfangsraster, das erst mit Qualität und Export-Flag feststeht.)
  const hamMax = isVase ? HAM_MAX_V : HAM_MAX_E;
  let depthCap;
  if (p.pattern === 'lamellen') depthCap = isVase ? 6 : 3;
  // Gehämmert: tiefe Näpfe sind erlaubt, aber die Flanke hängt an der Zellgröße —
  // viele Schläge = kleine Zellen = flacher (amp ≤ HAM_CELL·λ ⇒ ~48°). Das max(…)
  // stellt sicher, dass keine Einstellung WENIGER Tiefe bekommt als bisher (1,2 mm).
  else if (p.pattern === 'gehaemmert') depthCap = Math.min(hamMax, Math.max(HAM_SOFT, HAM_CELL * lamHam));
  else if (p.pattern === 'skelett') depthCap = isVase ? 1.8 : 1.0;
  else if (p.pattern === 'koralle') depthCap = isVase ? 6 : 1.0;
  else depthCap = ribs < 24 ? 1.1 : ribs > 56 ? 1.0 : 1.6;
  const amp = p.pattern === 'glatt' ? 0 : Math.min(p.depth, depthCap);
  // Anteil der Tiefe oberhalb der klassischen Grenze — normiert auf die EFFEKTIVE
  // Grenze, damit „Regler ganz rechts“ immer die volle Planier-Optik zeigt.
  // Ein Wert fürs ganze Gefäß (nicht aus ampAt(t)) — sonst kippt die Ausblendzone
  // oben/unten in die alte Optik zurück.
  const hamRel = (p.pattern === 'gehaemmert' && depthCap > HAM_SOFT)
    ? Math.min(1, Math.max(0, (amp - HAM_SOFT) / (depthCap - HAM_SOFT))) : 0;
  // Hinweis, wenn die Zellgröße die Wunschtiefe begrenzt (Konfigurator zeigt ihn an)
  const depthNote = (p.pattern === 'gehaemmert' && p.depth > depthCap + 1e-9 && depthCap < hamMax - 1e-9)
    ? `Bei ${ribs} Schlägen sind max. ${depthCap.toFixed(1).replace('.', ',')} mm möglich — sonst drucken die Näpfe nicht mehr ohne Stützen.`
    : '';
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
  // Gehämmert: die Gratlinien laufen schräg durchs Netz — Umfangs- und Ringabstand müssen
  // ähnlich fein sein, sonst treppt die Kante in der feineren Richtung weiter (Desktop 16
  // statt 14 Segmente/Rippe ≈ 0,37 mm bei 45 mm Radius; Handy bleibt bei 14).
  const rsFactor = { zickzack: 16, lamellen: 14, gehaemmert: fineExport ? 18 : q >= 0.9 ? 16 : 14 }[p.pattern] || 12;
  // Segmente pro Rippe (ganzzahlig!) → Gratspitzen liegen auf jedem Ring exakt auf einem Vertex
  const perRib = Math.max(6, Math.round(Math.min(Math.max(rsFactor, Math.ceil(240 / ribs)), Math.floor(1080 / ribs)) * q));
  const RS = ribs * perRib;
  const wallBase = isVase ? Math.max(160, H * 1.4) : 130;
  const querExtra = isQuer ? quersV * 14 : 0;
  const isHammer = p.pattern === 'gehaemmert';
  // Gehämmert: Die Schnittgrate zwischen den Näpfen laufen SCHRÄG durchs Ringnetz. Ein
  // Ringraster, das gröber ist als die Gratverrundung, tastet sie als Treppe ab — genau
  // die waagerechten Stufen an den Dellenrändern. Deshalb wird der Ringabstand hier direkt
  // in mm vorgegeben (bisher: Faktor auf wallBase, also an der Bauhöhe hängend — eine
  // 220er Vase bekam dadurch dieselben 0,53 mm wie eine 100er). Tiefenmodus: steilere
  // Napfränder brauchen engere Ringe (÷ (1 + 0,25·hamRel)). Handy/Vorschaubilder (q < 0,9)
  // bekommen nur ein moderat feineres Raster — dort trägt vor allem die Gratvorfilterung,
  // damit die Rebuild-Zeit kaum steigt. Das max(…) gegen die alte Formel garantiert
  // „nie gröber als vorher“ (kleine Eierbecher behalten ihre feinere Abtastung).
  const hamRowMM = (fineExport ? HAM_ROW_EXPORT : q >= 0.9 ? HAM_ROW_VIEW : HAM_ROW_SMALL) / (1 + 0.25 * hamRel);
  const hamRowsOld = wallBase * (fineExport ? 1.7 : 1.35) * (1 + 0.25 * hamRel) * q; // Raster bis e20fce3
  // Der Deckel hängt wie vor der Umstellung an der QUALITÄT: ohne den Faktor q griff er auf
  // dem Handy gar nicht mehr, und eine hohe Vase mit Drall und Wellenfluss baute dort bis zu
  // 760 Ringe — teurer als in jeder Fassung davor. Mit HAM_ROWS_MAX·q ist die Obergrenze
  // wieder exakt die alte (Handy 396, Desktop/Export 720).
  const hamRowsCap = HAM_ROWS_MAX * (fineExport ? 1 : q);
  const WALL_STEPS = isHammer
    ? Math.round(Math.min(hamRowsCap, Math.max((H - CHAMFER) / hamRowMM, hamRowsOld) + Math.abs(twistAngle) * 36 * Math.min(3, flowOsc) * q))
    : Math.round(Math.min(430, wallBase + Math.abs(twistAngle) * 36 * Math.min(3, flowOsc) + querExtra) * q);
  // Breite der Gratvorfilterung in mm (0 = aus): zwei bis drei Rasterweiten des Netzes, das
  // hier gerade gebaut wird — die GRÖSSERE aus Ringabstand und Umfangsabstand, denn die grobe
  // Richtung bestimmt, wie weit die Kante verschmiert sein muss. hammerField rechnet sie über
  // die Zellgröße λ in eine Temperatur auf der Kalottenhöhe um. Dadurch verschleift die
  // Vorfilterung nur so viel, wie das jeweilige Raster verlangt (Vorschau ≈ 0,95 mm statt
  // pauschal 1,5 mm, Export ≈ 0,82 mm), und ein feineres Netz bekommt automatisch schärfere Grate.
  const hamPitch = Math.max((H - CHAMFER) / WALL_STEPS, (2 * Math.PI * rMax) / RS);
  const hamAA = isHammer ? Math.min(HAM_AA_CELL * lamHam, HAM_AA_ROWS * hamPitch) : 0;
  const CAVITY_STEPS = Math.round(36 * q);
  const INNER_STEPS = Math.round(44 * q);

  // Rippen-Fade: unten glatt (Druckbett), oben sanft auslaufend — ausgefranste
  // Ränder waren der meistgenannte Kritikpunkt im Design-Panel.
  // Rand „muster“: keine Ausblendung oben, das Muster läuft bis zur Kante durch.
  const tFadeTop = isQuer ? 0.93 : p.pattern === 'koralle' ? 0.92 : 0.96; // ab hier blendet das Muster oben aus
  const fadeTop = (t) => (rimEff === 'muster' ? 1 : smoothstep(1.0, tFadeTop, t));
  const fade = (t) => {
    let f = p.pattern === 'koralle' ? smoothstep(0.06, 0.22, t) : smoothstep(0.02, 0.12, t);
    f *= fadeTop(t);
    return f;
  };
  const ampAt = (t) => amp * fade(t);

  // Wulstrand: runde Lippe außen über die obersten RIM_LIP_H mm — Profil b(s) über der Höhe s ab Lippenfuß:
  //   Anstieg  b = OUT·smoothstep(0, rise, s)      (max. Steigung 1,5·OUT/rise ≤ 45° samt Silhouetten-Neigung)
  //   Plateau  b = OUT                             (bis zum Beginn der Rundung)
  //   Rundung  b = OUT − ρ + √(ρ² − (s − s₀)²)      (Viertelkreis ρ = OUT → endet an der Oberkante genau auf R(1))
  // Nur die AUSSEN-Stationen bekommen die Lippe; Innenwand, Ei-Mulde und Textband folgen weiter R(t).
  // Neigt sich die Grundform oben selbst nach außen, wird der Anstieg gestreckt bzw. die Ausladung verringert,
  // damit die Gesamt-Silhouette ≤ 45° bleibt (ohne Stützen druckbar).
  let lipAt = () => 0, lipOut = 0;
  if (rimEff === 'wulst') {
    let slopeTop = 0; // stärkste Aufweitung der Grundform in der Lippenzone (dr/dy > 0)
    for (let s = 0; s < RIM_LIP_H; s += 0.25) {
      const y = H - RIM_LIP_H + s;
      slopeTop = Math.max(slopeTop, (R(Math.min(1, (y + 0.25) / H)) - R(y / H)) / 0.25);
    }
    const riseMax = RIM_LIP_H - RIM_LIP_OUT;                                     // Anstieg darf bis zum Beginn der Rundung reichen
    const rise = Math.min(riseMax, Math.max(RIM_LIP_RISE, 1.5 * RIM_LIP_OUT / Math.max(0.05, 1 - slopeTop)));
    lipOut = Math.min(RIM_LIP_OUT, Math.max(0.6, (1 - slopeTop) * rise / 1.5)); // notfalls flachere Lippe (steil aufweitende Grundform)
    const rho = lipOut, s0 = RIM_LIP_H - rho;
    lipAt = (y) => {
      const s = y - (H - RIM_LIP_H);
      if (s <= 0) return 0;
      if (s <= rise) return lipOut * smoothstep(0, rise, s);
      if (s <= s0) return lipOut;
      const d = Math.min(rho, s - s0);
      return lipOut - rho + Math.sqrt(Math.max(0, rho * rho - d * d));
    };
  }
  const Rout = rimEff === 'wulst' ? (t) => R(t) + lipAt(t * H) : R; // Außensilhouette (mit Lippe)

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
      // Enge Stellen (Flaschenhals, Becherfuß): dort ist eine Zelle nur 2π·R(t)/nHam
      // breit, die Näpfe würden zu schmalen senkrechten Rillen, in die keine 0,4-mm-Düse
      // mehr sauber hineinkommt. Nur der ZUSATZ über 1,2 mm wird dort zurückgenommen.
      if (hamRel > 0) a = Math.min(a, Math.max(HAM_SOFT, (HAM_CELL * 2 * Math.PI * R(t)) / nHam));
      return a * hammerField(theta + flowPhase(t), t * H, nHam, lamHam, hamRel, hamAA);
    }
    return a * waveTheta(p.pattern, ribs * (theta + flowPhase(t)));
  };

  // --- Gravur: Schrift als Höhenfeld (Distanzfeld-Relief, textrelief.js) in der Wand.
  // Vorne (θ = 0) zentriert; u = lokale Bogenlänge R(t)·Δθ (kein Keystone auf Kugeln),
  // v = Meridian-Bogenlänge (Buchstabenhöhe bleibt auf geneigter Wand erhalten).
  const txt = String(p.text || '').trim();
  const textInfo = { style: p.textStyle, size: p.textSize, warn: '', disabled: false, reason: '', arcDeg: 0 };
  let relief = null;
  // Meridian-Bogenlänge s(y) tabellieren
  const ARC_N = 200, arcTab = new Float64Array(ARC_N + 1);
  for (let i = 1; i <= ARC_N; i++) {
    const y0 = ((i - 1) / ARC_N) * H, y1 = (i / ARC_N) * H;
    arcTab[i] = arcTab[i - 1] + Math.hypot(y1 - y0, R(y1 / H) - R(y0 / H));
  }
  const sArc = (y) => { const f = Math.min(ARC_N - 1e-9, Math.max(0, (y / H) * ARC_N)); const i = Math.floor(f); return arcTab[i] + (arcTab[i + 1] - arcTab[i]) * (f - i); };
  const wallSlope = (t) => Math.atan(Math.abs((R(Math.min(1, t + 0.01)) - R(Math.max(0, t - 0.01))) / (0.02 * H))); // rad
  const tan40 = Math.tan((40 * Math.PI) / 180);
  if (txt && p.textFont) {
    const fontKey = FONTS[p.font] ? p.font : 'helvetiker';
    let style = TEXT_STYLES[p.textStyle] ? p.textStyle : 'gestanzt';
    if (!fontAllowsStyle(fontKey, style)) style = 'gepraegt';
    const rule = FONT_RULES[fontKey] || { minCap: 5, capFactor: 1 };
    textInfo.style = style;
    // (1) Position: zu steile Wand → auf flacheren Bereich verschieben
    let tC = Math.min(0.92, Math.max(0.08, p.textPos ?? 0.55));
    const MAX_SLOPE = (35 * Math.PI) / 180;
    if (wallSlope(tC) > MAX_SLOPE) {
      let best = null;
      for (let d = 1; d <= Math.round(0.25 * H); d++) for (const sgn of [1, -1]) {
        const tt = tC + (sgn * d) / H;
        if (tt < 0.1 || tt > 0.9) continue;
        if (wallSlope(tt) <= MAX_SLOPE) { best = tt; break; }
        if (best !== null) break;
      }
      if (best === null) { textInfo.disabled = true; textInfo.reason = 'An dieser Höhe ist die Wand zu stark geneigt — Gravur nicht möglich. Bitte Position oder Form ändern.'; }
      else { tC = best; textInfo.warn = 'Position auf den flacheren Wandbereich verschoben.'; }
    }
    // (2) Offene Zellen / Mustertiefe an der Textstelle
    const a = ampAt(tC);
    if (!textInfo.disabled && isVase && p.pattern === 'skelett') {
      textInfo.disabled = true;
      textInfo.reason = 'Bei offenen Voronoi-Zellen ist keine Gravur möglich — anderes Muster wählen (beim Eierbecher geht es).';
    }
    const maxAmp = isVase ? 2.5 : 2.0; // Eierbecher: kleiner Radius, tiefe Muster schlucken die Schrift
    if (!textInfo.disabled && a > maxAmp) {
      textInfo.disabled = true;
      textInfo.reason = `Gravur bei über ${String(maxAmp).replace('.', ',')} mm Mustertiefe nicht möglich — Tiefe auf ${String(maxAmp).replace('.', ',')} mm setzen oder anderes Muster wählen.`;
    }
    if (!textInfo.disabled) {
      // (3) Schriftgröße — Reihenfolge nach Lesbarkeit (monoton: mehr Zeichen machen den Text nie größer):
      //   a) gewünschte Größe, solange der Bogen ≤ FRONT_TEXT_ARC (130°: von vorn in einem Blick lesbar)
      //   b) darüber verkleinern bis zur kleinsten druckbaren Größe der Schrift (minCap), Bogen bleibt ≤ 130°
      //   c) reicht das nicht, läuft der Text bei minCap um die Seiten (≤ MAX_TEXT_ARC 200°, Hinweis „drehen“)
      //   d) sonst deaktivieren mit der maximalen Zeichenzahl.
      // Dazu die Naht-Grenze: Textbogen + Kartuschenrand + Rampe müssen auf jeder Zeile des Bands diesseits
      // von θ = ±180° bleiben — bei kleinem Radius (Eierbecher-Stiel, eigene Formen) greift sie vor den 200°.
      // Die Breite wird ohne Rasterung gemessen (∝ cap) — so entsteht das Höhenfeld nur einmal.
      const wanted = Math.min(12, Math.max(rule.minCap, p.textSize ?? 7));
      const rMid = R(tC);
      const m = measureText({ font: p.textFont, fallbackFont: p.fallbackFont, fontKey, text: txt, cap: wanted });
      // Kartuschen-Modus (hängt nur von Muster & Stil ab) → Rampenbreite um den Text:
      //  none   = Buchstaben direkt auf der Wand (Muster nur unter den Buchstaben geglättet) — glatte Wände,
      //           feine Texturen und langwellige Muster (Querwellen, Hammerschlag ≤ 1,2 mm)
      //  flush  = Muster wird um den Text über mehrere mm weich auf die mittlere Wandfläche ausgeblendet
      //  shield = Stil „gehämmert“: erhabenes Schild (0,6 mm) mit klarem Rand auf dem geglätteten Feld
      const hammerPlate = style === 'gehaemmert';
      let plateMode = (a <= 0.45 || (p.pattern === 'gehaemmert' && a <= 1.2)) ? 'none' : 'flush';
      if (hammerPlate) plateMode = 'shield';
      const level = plateMode === 'shield' ? 0.6 : 0;
      // Übergänge: das Muster wird über mehrere mm ausgeblendet (kein Gürtel, keine Kante);
      // die Unterkante (Fläche zeigt nach unten) zusätzlich ≤ 40° für den Druck
      const feather = plateMode === 'none' ? 0 : Math.max(6.0, 4.0 * a);   // Muster-Ausblendung außerhalb des Rechtecks
      const rimRamp = 0.8;                                                    // Schildrand (steil, definiert)
      const rampSide = feather;
      const rampBottom = plateMode === 'none' ? 0 : Math.max(feather, (level + a) / tan40);
      const rampTop = feather;
      const arcAt = (c) => (m.width * c / wanted) / rMid;                    // Textbogen (rad) bei Großbuchstabenhöhe c
      const seamArc = (c) => {                                                // größter Bogen, der samt Rand/Rampe vor der Naht bleibt
        const hh = (m.height * c / wanted) / 2 + Math.max(1.5, 0.3 * c);
        const yA = Math.max(CHAMFER, tC * H - hh - rampBottom - 0.4), yB = Math.min(H, tC * H + hh + rampTop + 0.4);
        let rMin = Infinity;
        for (let i = 0; i <= 12; i++) rMin = Math.min(rMin, R((yA + (i / 12) * (yB - yA)) / H));
        return 2 * (Math.PI * rMin - Math.max(2.5, 0.45 * c) - rampSide - 1.0) / rMid;
      };
      let cap = wanted, arcLim = MAX_TEXT_ARC, field = null;
      if (m.width > 0) {
        if (arcAt(cap) > FRONT_TEXT_ARC) cap = Math.max(rule.minCap, cap * FRONT_TEXT_ARC / arcAt(cap));
        arcLim = Math.min(MAX_TEXT_ARC, seamArc(cap));
        if (arcAt(cap) > arcLim) { cap = Math.max(rule.minCap, cap * arcLim / arcAt(cap)); arcLim = Math.min(MAX_TEXT_ARC, seamArc(cap)); }
        if (arcAt(cap) <= arcLim + 1e-9) field = buildGlyphField({ font: p.textFont, fallbackFont: p.fallbackFont, fontKey, text: txt, cap, style, product: p.product });
      }
      textInfo.arcMaxDeg = Math.round((arcLim * 180) / Math.PI);
      if (!(m.width > 0) || (!field && arcAt(cap) <= arcLim + 1e-9)) {
        textInfo.disabled = true; textInfo.reason = 'Diese Zeichen gibt es in der gewählten Schrift nicht — bitte andere Schrift wählen.';
      } else if (!field) {
        const maxChars = Math.max(1, Math.floor(txt.length * arcLim / arcAt(cap)));
        textInfo.disabled = true; textInfo.maxChars = maxChars; // für den Zeichenzähler im Konfigurator
        textInfo.reason = `Text zu lang für diesen Umfang — maximal ca. ${maxChars} Zeichen in dieser Schrift (auch bei kleinster Größe ${String(rule.minCap).replace('.', ',')} mm).`;
      } else {
        textInfo.size = cap;
        textInfo.arcDeg = (field.width / rMid) * 180 / Math.PI;
        const wraps = field.width / rMid > FRONT_TEXT_ARC + 1e-9;
        const warns = [];
        if (textInfo.warn) warns.push(textInfo.warn);
        if (cap < (p.textSize ?? 7) - 0.01 && cap < wanted - 0.01) warns.push(`Text automatisch auf ${cap.toFixed(1)} mm verkleinert, damit er ${wraps ? 'auf den Umfang' : 'auf die Vorderseite'} passt.`);
        if ((p.textSize ?? 7) < rule.minCap - 0.01) warns.push(`Schrift auf ${rule.minCap} mm vergrößert, damit die feinen Striche druckbar sind.`);
        if (wraps) warns.push('Text läuft um die Seite — zum Lesen drehen.');
        if (field.missing) warns.push(`Zeichen „${field.missing}“ gibt es in dieser Schrift nicht.`);
        textInfo.warn = warns.join(' ');
        // (4) Kartusche: Querwellen — Feld folgt dem lokalen Wellenniveau der Textmitte (kein Plaque-Schnitt
        // durch die Welle); gehämmerte Wand: Buchstaben direkt auf den Dellen (darunter geglättet), tiefer geprägt
        const followWave = p.pattern === 'querwellen';
        let yText = tC * H;
        const halfW = field.width / 2 + Math.max(2.5, 0.45 * cap), halfH = field.height / 2 + Math.max(1.5, 0.3 * cap);
        const plateR = 0.6 * halfH;
        // Eierbecher: Band unter dem Rand halten
        if (!isVase) {
          const maxY = H - 3.0 - halfH - rampTop;
          if (yText + halfH + rampTop > H - 3.0) { yText = Math.max(halfH + rampBottom + CHAMFER + 1, maxY); tC = yText / H; textInfo.warn = (textInfo.warn + ' Position unter den Rand verschoben.').trim(); }
        }
        const sText = sArc(yText);
        relief = { yText, tC, sText, field, style, cap, plateMode, level, a, halfW, halfH, plateR, rampSide, rampBottom, rampTop, rimRamp, followWave,
          y0: Math.max(CHAMFER + 0.6, yText - halfH - rampBottom - 0.4),
          y1: Math.min(H - 0.6, yText + halfH + rampTop + 0.4) };
      }
    }
  }
  // Hammerschlag-Textur der Kartusche (Stil „gehämmert“): nur auf der Platte, mit glattem Halo um die Schrift
  const plateDent = relief && relief.style === 'gehaemmert' && p.pattern !== 'gehaemmert' ? (() => {
    const lam = 2.6, n = Math.max(8, Math.round((2 * Math.PI * R(relief.tC)) / lam));
    return (theta, y) => (0.9 - hammerField(theta, y, n, lam)) / 1.9; // 0 = Grat, 1 = tiefste Delle
  })() : null;
  const reliefAt = (theta, y) => {
    const t = y / H;
    const dth = ((theta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; // −π..π
    const u = R(t) * dth, v = sArc(y) - relief.sText;
    let plate = 0, shield = 0;
    if (relief.plateMode !== 'none') {
      // Muster-Ausblendung: Rechteck + weiche Rampe außerhalb (unten länger für ≤ 40° Unterseite)
      const sd = roundedRectSDF(u, v, relief.halfW, relief.halfH, relief.plateR);
      const kb = smoothstep(0.35, 0.85, Math.max(0, -v) / relief.halfH), kt = smoothstep(0.35, 0.85, Math.max(0, v) / relief.halfH);
      const ramp = relief.rampSide + (relief.rampBottom - relief.rampSide) * kb + (relief.rampTop - relief.rampSide) * kt;
      const x = Math.min(1, Math.max(0, 1 - sd / ramp));
      plate = x * x * x * (x * (x * 6 - 15) + 10); // smootherstep
      if (plate <= 0) return { plate: 0, shield: 0, h: 0, tex: 0 };
      if (relief.plateMode === 'shield') {
        // Schild: knapp innerhalb des Rechtecks, steiler definierter Rand
        const xs = Math.min(1, Math.max(0, 1 - (sd + 0.4) / relief.rimRamp));
        shield = xs * xs * (3 - 2 * xs);
      }
    }
    const h = relief.field.sample(u, v);
    let tex = 0;
    if (plateDent && shield > 0) {
      const d = relief.field.dist(u, v);
      tex = -0.32 * plateDent(theta, y) * smoothstep(0.08, 0.3, d) * shield; // nur ein hauchdünner glatter Saum um die Schrift
    }
    return { plate, shield, h, tex };
  };
  // Gesamtversatz: Muster unter der Platte ausblenden, Platte auf Niveau, Relief drauf
  const surface = (theta, t, y, noText = false) => {
    const base = offset(theta, t);
    if (!relief || y < relief.y0 || y > relief.y1) return base;
    let { plate, shield, h, tex } = reliefAt(theta, y);
    if (noText) h = 0;
    if (relief.plateMode === 'none') {
      // Buchstaben direkt auf der Wand: Muster unter (und 0,5 mm um) die Buchstaben glätten, Relief kräftiger
      const t2 = y / H;
      const dth = ((theta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      const dd = relief.field.dist(R(t2) * dth, sArc(y) - relief.sText);
      const s = 1 - smoothstep(0.0, 0.3, dd);          // 1 in den Buchstaben, Saum 0,3 mm (kein sichtbarer Ring)
      const boost = 1 + 0.35 * Math.min(1, relief.a);  // auf strukturierten Wänden kräftiger
      return base * (1 - s) + h * boost;
    }
    if (plate <= 0) return base;
    // Feldniveau: Querwellen folgen dem Wellenniveau der Textmitte, sonst mittlere Wandfläche
    const lvl = relief.followWave ? offset(theta, relief.tC) : 0;
    return base * (1 - plate) + lvl * plate + (relief.level + tex) * shield + h;
  };
  const wallR = (theta, y) => Rout(y / H) + surface(theta, y / H, y);
  // Feinraster nur im Textband: Ringe alle ~0,2 mm, Umfang in ~0,2-mm-Schritten
  // (Vielfaches der Rippenzahl → Grate bleiben auf Vertices). Übergang zu den
  // gröberen Ringen per Reißverschluss-Vernähung in revolve().
  const fineStep = q >= 0.9 ? 0.12 : 0.2;
  const RS_T = relief
    ? Math.min(2600, ribs * Math.max(perRib, Math.ceil((2 * Math.PI * R(relief.tC)) / fineStep / ribs)))
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
    // Feine Zeilen (fineStep) nur im Textkasten ±0,8 mm, Rampenzeilen gröber (0,45 mm)
    const kept = wallYs.filter((y) => y < relief.y0 - 1e-6 || y > relief.y1 + 1e-6);
    const tb0 = Math.max(relief.y0, relief.yText - relief.field.height / 2 - 0.8), tb1 = Math.min(relief.y1, relief.yText + relief.field.height / 2 + 0.8);
    const addRows = (a, b, step) => { const n = Math.max(1, Math.ceil((b - a) / step)); for (let i = 0; i <= n; i++) kept.push(a + (i / n) * (b - a)); };
    if (tb0 > relief.y0 + 1e-6) addRows(relief.y0, tb0, 0.45);
    addRows(tb0, tb1, fineStep);
    if (tb1 < relief.y1 - 1e-6) addRows(tb1, relief.y1, 0.45);
    const uniq = [...new Set(kept.map((y) => +y.toFixed(5)))].sort((a, b) => a - b);
    wallYs.length = 0; wallYs.push(...uniq);
  }
  if (rimEff === 'wulst') {
    // Lippenzone feiner abtasten: Anstieg alle ~0,3 mm, Rundung nach Winkel (sonst wird der Viertelkreis eckig).
    // Zeilen innerhalb des Textbands (feines Raster) bleiben wie sie sind.
    const yLip = H - RIM_LIP_H, rho = lipOut, yRound = yLip + (RIM_LIP_H - rho);
    const add = (y) => { if (!(relief && y >= relief.y0 - 1e-6 && y <= relief.y1 + 1e-6)) wallYs.push(y); };
    const nRise = Math.max(6, Math.round((yRound - yLip) / 0.3 * q));
    for (let i = 0; i <= nRise; i++) add(yLip + (i / nRise) * (yRound - yLip));
    const nArc = Math.max(6, Math.round(12 * q));
    for (let i = 1; i < nArc; i++) add(yRound + rho * Math.sin((i / nArc) * Math.PI / 2));
    const uniq = [...new Set(wallYs.map((y) => +y.toFixed(5)))].sort((a, b) => a - b);
    wallYs.length = 0; wallYs.push(...uniq);
  }
  for (const y of wallYs) {
    const t = y / H;
    const inBand = relief && y >= relief.y0 - 1e-6 && y <= relief.y1 + 1e-6;
    stations.push(
      (ampAt(t) > 1e-4 || inBand)
        ? { y, rFn: (theta) => Rout(t) + surface(theta, t, y), rot: isQuer ? 0 : p.pattern === 'koralle' ? -(flowPhase(t) * 0.22 + 0.16 * Math.sin(2 * Math.PI * t - 0.8)) : -flowPhase(t), rs: inBand ? RS_T : RS, band: !!inBand }
        : { y, r: Rout(t) }
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
    // --- Vase: Innenwand folgt der Silhouette, Boden dicht. Wandstärke = VASE_WALL + ampNeeded(t):
    // die Reserve hinter der Wand ist nur so groß wie das Muster an dieser Höhe noch tief ist — oben, wo es
    // ausblendet (Rand glatt/wulst), wird die Öffnung entsprechend weiter (rIn(1) = R(1) − VASE_WALL).
    //   ampNeeded(t) = max( amp·fadeTop(t),                       Muster-Ausblendung oben inkl. Randoption
    //                       amp im Textband (y0 − 2 … y1 + 2),    Kartusche/Rampen liegen auf voller Musterebene
    //                       Taschentiefe der Gravur im Textband,  gestanzt/Farbschrift schneiden unter die Wand
    //                       −min_θ offset(θ, t) in der Ausblendzone )   numerische Talprüfung (Ring-Vertices)
    // In der Ausblendzone wird die Reserve als Hüllkurve der tiefsten Täler der AUSSENRINGE geführt (zwischen den
    // Ringen linear — genau die Fläche, die das Mesh dort hat), die Innenwand bekommt dort dieselben Ringhöhen:
    // so ist die Wand im Mesh exakt VASE_WALL dick, nicht nur analytisch.
    // Unten bleibt die volle Reserve (Bodenanschluss). Voronoi-Vasen: Schale hat feste Wand VASE_WALL + amp.
    // Steigungsbegrenzung: die Innenwand darf sich nach oben nicht steiler als 45° aufweiten — gemessen relativ
    // zur Silhouette (Δr ≤ Δy + max(0, ΔR)): der Übergang von voller Reserve auf VASE_WALL wird dann nach unten
    // gestreckt (von unten nach oben: r[i] = min(r_roh[i], r[i−1] + Δy + max(0, ΔR))). Die Aufweitung der
    // Grundform selbst (Bauch) bleibt wie bisher der Silhouette überlassen (Druck-Ampel).
    const pocketBoost = relief && relief.plateMode === 'none' ? 1 + 0.35 * Math.min(1, relief.a) : 1;
    const pocket = relief && relief.field.depth < 0 ? -relief.field.depth * pocketBoost : 0;
    const inReserve = (y) => relief && y >= relief.y0 - 2 && y <= relief.y1 + 2;
    const dOut = (H - CHAMFER) / WALL_STEPS;              // Ringabstand der Außenwand
    const yFade = tFadeTop * H - 2 * dOut;                // ab hier (knapp unter der Ausblendung) Hüllkurve statt voller Reserve
    const fading = !openCells && amp > 0 && rimEff !== 'muster';
    // Tal-Hüllkurve: je Außenring in der Ausblendzone das tiefste Tal (analytisch amp·fadeTop, dazu die numerische
    // Talprüfung auf genau den Vertices dieses Rings — θ-Raster samt Verlaufs-Rotation)
    const envY = [], envR = [];
    if (fading) for (const y of wallYs) {
      if (y < yFade) continue;
      const t = y / H;
      let a = amp * fadeTop(t);
      if (a < amp - 1e-6) {
        const rot = isQuer ? 0 : p.pattern === 'koralle' ? -(flowPhase(t) * 0.22 + 0.16 * Math.sin(2 * Math.PI * t - 0.8)) : -flowPhase(t);
        let valley = 0;
        for (let j = 0; j < RS; j++) valley = Math.min(valley, offset((j / RS) * Math.PI * 2 + rot, t));
        a = Math.max(a, -valley);
      }
      envY.push(y); envR.push(R(t) - a);
    }
    const valleyAt = (y) => { // tiefstes Tal der Außenwand auf Höhe y (Hüllkurve, sonst volle Reserve)
      if (!envY.length || y < envY[0] - 1e-9) return R(y / H) - amp;
      let k = 0;
      while (k < envY.length - 2 && envY[k + 1] < y) k++;
      const lam = envY[k + 1] > envY[k] ? Math.min(1, Math.max(0, (y - envY[k]) / (envY[k + 1] - envY[k]))) : 0;
      return envR[k] + (envR[k + 1] - envR[k]) * lam;
    };
    // Höhenraster der Innenwand: reguläres Raster, dazu die Außenring-Höhen der Ausblendzone und die Grenzen der Textband-Reserve
    const ys = new Set([VASE_FLOOR, H]);
    const tFloor = VASE_FLOOR / H;
    for (let i = 1; i < INNER_STEPS; i++) ys.add(+((1 - (1 - tFloor) * (i / INNER_STEPS)) * H).toFixed(4));
    for (const y of envY) if (y > VASE_FLOOR) ys.add(+y.toFixed(4));
    if (relief) for (const y of [relief.y0 - 2, relief.y1 + 2]) if (y > VASE_FLOOR && y < H) ys.add(+y.toFixed(4));
    const innerYs = [...ys].sort((a, b) => a - b);
    const innerR = [];
    for (let i = 0; i < innerYs.length; i++) {
      const y = innerYs[i], t = y / H;
      let r = valleyAt(y) - VASE_WALL;
      if (inReserve(y)) r = Math.min(r, R(t) - VASE_WALL - Math.max(amp + (relief.followWave ? pocket : 0), pocket));
      if (i > 0) r = Math.min(r, innerR[i - 1] + (y - innerYs[i - 1]) + Math.max(0, R(t) - R(innerYs[i - 1] / H))); // ≤ 45° Aufweitung nach oben (relativ zur Silhouette)
      innerR.push(r);
    }
    for (let i = innerYs.length - 1; i >= 0; i--) stations.push({ y: innerYs[i], r: Math.max(1.4, innerR[i]) });
    stations.push({ y: VASE_FLOOR, r: 0 });
    openingDia = Math.max(1.4, innerR[innerR.length - 1]) * 2;
  }

  let geometry = openCells
    ? buildVoronoiShell({H,R,rBase,rMax,ribs,amp,flowPhase,quality:q,exportRes:!!p.exportRes,surface,
        band: relief ? { y0: relief.y0, y1: relief.y1, step: fineStep,
          patch: (theta, y) => { const dth = ((theta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return roundedRectSDF(R(y / H) * dth, sArc(y) - relief.sText, relief.halfW + 1.5, relief.halfH + 1.5, relief.plateR); } } : null })
    : revolve(stations, RS);
  if (relief && !openCells && geometry.userData.bandRanges) bandNormals(geometry, wallR);
  // Farbschrift: Einlage = Volumen zwischen Taschenboden und ungestörter Oberfläche innerhalb der Buchstaben
  const inlay = relief && relief.style === 'farbe' && !openCells ? buildInlay(relief, H, R, surface, sArc, fineStep) : null;
  // Facettierte/durchbrochene Muster: Kanten scharf schattieren (Grate zwischen Dellen/Facetten, Lochränder),
  // Flächen dazwischen glatt. Weiche Vertex-Normalen würden die Kanten verschmieren — das sieht „unscharf“ aus.
  // (p.rawIndexed: Topologie-Tools brauchen die indizierte Geometrie.)
  if (!p.rawIndexed && (p.pattern === 'gehaemmert' || p.pattern === 'zickzack' || openCells)) {
    // Gehämmert: mit der Tiefe werden die Napfflanken flacher — die Schwelle wandert
    // mit (26 → 34°), damit der Napfrand eine saubere Lichtlinie bleibt statt zu flimmern.
    geometry = creaseNormals(geometry, p.pattern === 'gehaemmert' ? 26 + 8 * hamRel : openCells ? 30 : 22, geometry.userData.bandRanges);
  }

  // Öffnungs-Hinweis (Vase): eng für Blumen — weich, nicht blockierend; unter VASE_OPEN_TIGHT zeigt die UI ihn rot
  let openingWarn = '';
  if (isVase && openingDia < VASE_OPEN_WARN) {
    openingWarn = `⚠️ Öffnung nur Ø ${Math.round(openingDia)} mm — bei dieser Form eng für Blumen: breiter stellen oder Form mit weiterer Öffnung wählen`
      + (rimEff === 'muster' ? ', Tiefe verringern oder Rand „Glatt“ wählen' : '') + '.';
  }
  // Außendurchmesser oben: mit Wulst ragt die Lippe über R(1) hinaus
  let rTopOut = R(1);
  if (rimEff === 'wulst') for (let s = 0; s <= RIM_LIP_H; s += 0.25) rTopOut = Math.max(rTopOut, Rout((H - RIM_LIP_H + s) / H));

  return {
    geometry,
    info: {
      openCells,
      product: p.product,
      height: H,
      maxRadius: rMax,
      // Außendurchmesser: gehämmert steht der Grat nur 0,9·(1−…)·amp über der Silhouette
      // und bei voller Tiefe gar nicht mehr — sonst stünde beim Kunden ein zu großes Maß.
      topDiameter: (rTopOut + amp * (p.pattern === 'gehaemmert' ? 0.9 * (1 - smoothstep(0, 1, Math.pow(hamRel, HAM_RAMP))) : 1)) * 2,
      baseDiameter: rBase * 2,
      cavityDiameter: cavityDia,
      cavityDepth,
      openingDiameter: openingDia,
      openingWarn,         // Vase: Hinweistext bei enger Öffnung (< 18 mm), sonst ''
      depthCap,            // wirksame Obergrenze der Mustertiefe (mm)
      depthNote,           // Gehämmert: Hinweis, wenn die Zellgröße die Tiefe begrenzt
      openingTight: isVase && openingDia < VASE_OPEN_TIGHT, // < 10 mm → Hinweis in Rot
      rim,                 // gewählte Randoption (RIMS)
      rimIgnored: rim !== rimEff, // Voronoi-Vase: Rand bleibt glatt
      radialSegments: RS,
      text: textInfo, // Relief-Gravur: gewählter Stil, ggf. verkleinerte Größe, Warnung
      inlay,          // Farbschrift: eigener Körper für das zweite Filament (3MF-Export), sonst null
      // Für die Text-Prägung: glatter Radius & Muster-Amplitude an Höhe t
      radiusAt: R,
      outerRadiusAt: Rout, // Außensilhouette inkl. Wulstlippe
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
export function creaseNormals(geometry, creaseDeg = 26, keepRanges = null) {
  const pos = geometry.getAttribute('position').array;
  const keepNor = keepRanges && geometry.getAttribute('normal') ? geometry.getAttribute('normal').array : null;
  const keep = new Uint8Array(pos.length / 3);
  if (keepRanges) for (const [st, n] of keepRanges) keep.fill(1, st, st + n);
  const idx = geometry.index ? geometry.index.array : null;
  const triCount = idx ? idx.length / 3 : pos.length / 9;
  const vCount = pos.length / 3;
  const fN = new Float32Array(triCount * 3);
  const fL = new Float64Array(triCount); // Länge der Flächennormalen — einmal statt je Nachbarpaar
  const cosLimit = Math.cos((creaseDeg * Math.PI) / 180);
  // Flächen-Normalen (flächengewichtet: Länge des Kreuzprodukts)
  const vOf = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k);
  for (let t = 0; t < triCount; t++) {
    const a = vOf(t, 0) * 3, b = vOf(t, 1) * 3, c = vOf(t, 2) * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    fN[t * 3] = uy * wz - uz * wy; fN[t * 3 + 1] = uz * wx - ux * wz; fN[t * 3 + 2] = ux * wy - uy * wx;
  }
  for (let t = 0; t < triCount; t++) fL[t] = Math.hypot(fN[t * 3], fN[t * 3 + 1], fN[t * 3 + 2]) || 1;
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
    const nl = fL[t];
    for (let k = 0; k < 3; k++) {
      const v = vOf(t, k);
      let sx = 0, sy = 0, sz = 0;
      for (let j = deg[v]; j < deg[v + 1]; j++) {
        const g = adj[j];
        const gx = fN[g * 3], gy = fN[g * 3 + 1], gz = fN[g * 3 + 2];
        if ((nx * gx + ny * gy + nz * gz) / (nl * fL[g]) >= cosLimit) { sx += gx; sy += gy; sz += gz; }
      }
      const sl = Math.hypot(sx, sy, sz) || 1;
      const o = t * 9 + k * 3;
      outPos[o] = pos[v * 3]; outPos[o + 1] = pos[v * 3 + 1]; outPos[o + 2] = pos[v * 3 + 2];
      if (keepNor && keep[v]) { outNor[o] = keepNor[v * 3]; outNor[o + 1] = keepNor[v * 3 + 1]; outNor[o + 2] = keepNor[v * 3 + 2]; }
      else { outNor[o] = sx / sl; outNor[o + 1] = sy / sl; outNor[o + 2] = sz / sl; }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(outNor, 3));
  geometry.dispose();
  return out;
}

// Einlage für die Farbschrift: Raster über dem Textkasten, per Dreiecks-Clipping auf die Buchstaben
// beschnitten (Höhe h < 0 = Tasche); Oberhaut = ungestörte Wand, Unterhaut = Taschenboden, Seitenwände
// entlang der Schnittkanten. Ergebnis ist ein eigener manifold Körper, der die Tasche exakt füllt.
function buildInlay(relief, H, R, surface, sArc, step) {
  const rMid = R(relief.tC);
  const halfArc = (relief.field.width / 2 + 1.5) / rMid;
  const y0 = Math.max(relief.y0, relief.yText - relief.field.height / 2 - 1.2), y1 = Math.min(relief.y1, relief.yText + relief.field.height / 2 + 1.2);
  const nx = Math.max(8, Math.ceil((2 * halfArc * rMid) / step)), ny = Math.max(4, Math.ceil((y1 - y0) / step));
  const verts = []; // { theta, y, f }  f = Taschentiefe (> 0 innerhalb der Buchstaben)
  const depthAt = (theta, y) => { const t = y / H; return surface(theta, t, y, true) - surface(theta, t, y); };
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const theta = -halfArc + (i / nx) * 2 * halfArc, y = y0 + (j / ny) * (y1 - y0);
    verts.push({ theta, y, f: depthAt(theta, y) - 0.02 }); // 0,02 mm Schwelle: keine Nullflächen
  }
  const cuts = new Map(), tris = [];
  const cut = (ia, ib) => {
    const key = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`;
    if (cuts.has(key)) return cuts.get(key);
    const a = verts[ia], b = verts[ib], t = Math.max(0.001, Math.min(0.999, a.f / (a.f - b.f)));
    const id = verts.length;
    verts.push({ theta: a.theta + (b.theta - a.theta) * t, y: a.y + (b.y - a.y) * t, f: 0 });
    cuts.set(key, id); return id;
  };
  const clip = (ids) => {
    const out = [];
    for (let k = 0; k < 3; k++) {
      const a = ids[k], b = ids[(k + 1) % 3];
      if (verts[a].f > 0) out.push(a);
      if ((verts[a].f > 0) !== (verts[b].f > 0)) out.push(cut(a, b));
    }
    for (let k = 1; k < out.length - 1; k++) tris.push([out[0], out[k], out[k + 1]]);
  };
  const W = nx + 1;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * W + i, b = j * W + i + 1, c = (j + 1) * W + i, d = (j + 1) * W + i + 1;
    clip([a, b, c]); clip([b, d, c]);
  }
  if (!tris.length) return null;
  const positions = [], indices = [], pair = new Map(), edges = new Map();
  const point = (theta, y, r) => { positions.push(Math.sin(theta) * r, y, Math.cos(theta) * r); return positions.length / 3 - 1; };
  const skins = (id) => {
    if (pair.has(id)) return pair.get(id);
    const v = verts[id], t = v.y / H;
    const top = point(v.theta, v.y, R(t) + surface(v.theta, t, v.y, true));
    const bottom = point(v.theta, v.y, R(t) + Math.min(surface(v.theta, t, v.y), surface(v.theta, t, v.y, true) - 0.02));
    const pr = [top, bottom]; pair.set(id, pr); return pr;
  };
  for (const tri of tris) {
    const [a, b, c] = tri.map(skins);
    indices.push(a[0], b[0], c[0], c[1], b[1], a[1]); // Oberhaut nach außen, Unterhaut nach innen
    for (let k = 0; k < 3; k++) {
      const u = tri[k], v = tri[(k + 1) % 3], key = u < v ? `${u}:${v}` : `${v}:${u}`;
      if (edges.has(key)) edges.delete(key); else edges.set(key, [u, v]);
    }
  }
  for (const [u, v] of edges.values()) { // Seitenwände entlang der Buchstabenkontur
    const a = skins(u), b = skins(v);
    indices.push(b[0], a[0], a[1], b[0], a[1], b[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
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
  const bandRanges = []; // [startIndex, count] der Textband-Ringe → analytische Normalen
  for (const st of stations) {
    if (st.r === 0 && !st.rFn) {
      pointIdx.push(positions.length / 3);
      ringStart.push(-1); ringN.push(0);
      positions.push(0, st.y, 0);
    } else {
      const n = st.rs || RS;
      ringStart.push(positions.length / 3); ringN.push(n);
      if (st.band) bandRanges.push([positions.length / 3, n]);
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
  if (bandRanges.length) geometry.userData.bandRanges = bandRanges;
  return geometry;
}

// Analytische Normalen im Textband: aus dem Wandradius r(θ, y) per zentraler Differenz (ε = 0,04 mm).
// Damit bleiben Buchstabenkanten scharf, unabhängig von der Ringauflösung (keine gemittelten Normalen).
function bandNormals(geometry, wallR) {
  const pos = geometry.getAttribute('position').array;
  const nor = geometry.getAttribute('normal').array;
  const EPS = 0.1;
  for (const [start, count] of geometry.userData.bandRanges) {
    for (let k = 0; k < count; k++) {
      const i = (start + k) * 3;
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const r = Math.hypot(x, z) || 1e-6, theta = Math.atan2(x, z);
      const dth = EPS / r;
      const dr_du = (wallR(theta + dth, y) - wallR(theta - dth, y)) / (2 * EPS);
      const dr_dy = (wallR(theta, y + EPS) - wallR(theta, y - EPS)) / (2 * EPS);
      // n = r̂ − (∂r/∂u)·t̂ − (∂r/∂y)·ŷ   mit r̂ = (sinθ,0,cosθ), t̂ = (cosθ,0,−sinθ)
      let nx = Math.sin(theta) - dr_du * Math.cos(theta), ny = -dr_dy, nz = Math.cos(theta) + dr_du * Math.sin(theta);
      const l = Math.hypot(nx, ny, nz) || 1;
      nor[i] = nx / l; nor[i + 1] = ny / l; nor[i + 2] = nz / l;
    }
  }
  geometry.getAttribute('normal').needsUpdate = true;
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

/** Maximale Textbreite als Bogen (200°, ab 130° läuft der Text um die Seite) — für UI-Feedback. */
export function maxTextArc() {
  return MAX_TEXT_ARC;
}
