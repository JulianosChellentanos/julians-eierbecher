// OVJU — parametrische Geometrie für Eierbecher & Vasen
// Erzeugt wasserdichte (manifold) Meshes in Millimetern, bereit für den 3D-Druck.
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Produkte & Form-Presets: Silhouetten als (t, r)-Kontrollpunkte.
// t = 0..1 (Höhe von unten nach oben), r relativ zum Maximalradius.
// ---------------------------------------------------------------------------
export const PRODUCTS = {
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
  zickzack: 'Zickzack',
  querwellen: 'Querwellen',
};

// Verlauf: wie das Muster über die Höhe „fließt“ (Phasenverschiebung φ(t))
export const FLOWS = {
  spirale: 'Spirale',
  gegen: 'Gegenläufig',
  fluss: 'Wellenfluss',
  zick: 'Zickzack',
};

export const DEFAULTS = {
  product: 'eierbecher',
  preset: 'kelch',
  height: 58,        // mm
  width: 1.0,        // Faktor 0.85..1.15 auf den Maximalradius
  pattern: 'rippen',
  ribs: 48,          // Anzahl Rippen/Wellen
  depth: 0.9,        // Amplitude in mm (0..1.6)
  twist: 0,          // -2..2 — Stärke des Verlaufs (0 = gerade)
  flow: 'spirale',   // 'spirale' | 'gegen' | 'fluss' | 'zick'
  flowWaves: 3,      // Richtungswechsel bei fluss/zick (2..8)
  text: '',
  textSize: 7,       // mm
  textPos: 0.55,     // Gravur-Höhe als Anteil der Gesamthöhe (0.15..0.8)
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
  return c * 2 - 1;                                                        // weiche Wellen
}

// ---------------------------------------------------------------------------
/**
 * Baut die Becher-/Vasen-Geometrie (ohne Text).
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
  // (b) Tiefe an Rippenzahl koppeln: zu tief bei groben Rippen = klobig,
  //     zu tief bei feinen Rippen = Moiré-Flirren.
  const depthCap = ribs < 24 ? 1.1 : ribs > 56 ? 1.0 : 1.6;
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
  const RS = Math.round(Math.min(1080, Math.max(240, ribs * (p.pattern === 'zickzack' ? 16 : 12))) * q);
  const wallBase = isVase ? Math.max(160, H * 1.4) : 130;
  const querExtra = isQuer ? quersV * 14 : 0;
  const WALL_STEPS = Math.round(Math.min(430, wallBase + Math.abs(twistAngle) * 36 * Math.min(3, flowOsc) + querExtra) * q);
  const CAVITY_STEPS = Math.round(36 * q);
  const INNER_STEPS = Math.round(44 * q);

  // Rippen-Fade: unten glatt (Druckbett), oben sanft auslaufend — ausgefranste
  // Ränder waren der meistgenannte Kritikpunkt im Design-Panel.
  const fade = (t) => {
    let f = smoothstep(0.02, 0.12, t);
    f *= smoothstep(1.0, isQuer ? 0.93 : 0.96, t);
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
    return a * waveTheta(p.pattern, ribs * (theta + flowPhase(t)));
  };

  // --- Stationen: Kontur von Bodenmitte → außen hoch → Rand → innen → Achse
  const stations = [];
  const rBase = R(CHAMFER / H) - CHAMFER * 0.6;
  stations.push({ y: 0, r: 0 });
  stations.push({ y: 0, r: rBase * 0.55 });
  stations.push({ y: 0, r: rBase });
  for (let i = 0; i <= WALL_STEPS; i++) {
    const s = i / WALL_STEPS;
    const y = CHAMFER + s * (H - CHAMFER);
    const t = y / H;
    stations.push(
      ampAt(t) > 1e-4
        ? { y, rFn: (theta) => R(t) + offset(theta, t) }
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

  const geometry = revolve(stations, RS);

  return {
    geometry,
    info: {
      product: p.product,
      height: H,
      maxRadius: rMax,
      topDiameter: (R(1) + amp) * 2,
      baseDiameter: rBase * 2,
      cavityDiameter: cavityDia,
      cavityDepth,
      openingDiameter: openingDia,
      radialSegments: RS,
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
function revolve(stations, RS) {
  const positions = [];
  const ringStart = [];
  const pointIdx = [];
  for (const st of stations) {
    if (st.r === 0 && !st.rFn) {
      pointIdx.push(positions.length / 3);
      ringStart.push(-1);
      positions.push(0, st.y, 0);
    } else {
      ringStart.push(positions.length / 3);
      pointIdx.push(-1);
      for (let j = 0; j < RS; j++) {
        const theta = (j / RS) * Math.PI * 2;
        const r = st.rFn ? st.rFn(theta) : st.r;
        positions.push(Math.sin(theta) * r, st.y, Math.cos(theta) * r);
      }
    }
  }
  const indices = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = ringStart[i], b = ringStart[i + 1];
    if (a === -1 && b === -1) continue;
    if (a === -1) {
      const c = pointIdx[i];
      for (let j = 0; j < RS; j++) indices.push(c, b + (j + 1) % RS, b + j);
    } else if (b === -1) {
      const c = pointIdx[i + 1];
      for (let j = 0; j < RS; j++) indices.push(a + j, a + (j + 1) % RS, c);
    } else {
      for (let j = 0; j < RS; j++) {
        const j1 = (j + 1) % RS;
        indices.push(a + j, b + j1, b + j);
        indices.push(a + j, a + j1, b + j1);
      }
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

  const amp = p.pattern === 'glatt' ? 0 : p.depth;
  const q = Math.min(1, Math.max(0.4, p.quality));
  const RS = Math.round(Math.min(640, Math.max(200, p.ribs * 9)) * q);
  // Querwellen sind höhenbasiert — auf dem flachen Rand als normale Wellen zeigen
  const patt = p.pattern === 'querwellen' ? 'wellen' : p.pattern;

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
    const rFace = info.radiusAt(t) + info.ampAt(t) + 0.55;
    const r = rFace - (depth - z); // Rückseite steckt `depth` tief in der Wand
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
