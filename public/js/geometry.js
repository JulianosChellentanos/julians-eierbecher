// OVJU — parametrische Eierbecher-Geometrie
// Erzeugt ein wasserdichtes (manifold) Mesh in Millimetern, bereit für den 3D-Druck.
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Form-Presets: Silhouetten als (t, r)-Kontrollpunkte.
// t = 0..1 (Höhe von unten nach oben), r relativ zum Maximalradius.
// ---------------------------------------------------------------------------
export const PRESETS = {
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
};

export const DEFAULTS = {
  preset: 'kelch',
  height: 58,        // mm
  width: 1.0,        // Faktor 0.85..1.15 auf den Maximalradius (24 mm)
  pattern: 'rippen', // 'glatt' | 'wellen' | 'rippen'
  ribs: 48,          // Anzahl Rippen/Wellen um den Umfang
  depth: 0.9,        // Amplitude in mm (0..1.6)
  twist: 0,          // -2..2 — Drall (Umdrehungsanteil über die Höhe → Spirale)
  text: '',
  textSize: 7,       // mm
};

const MAX_RADIUS = 24;      // mm bei width = 1
const CHAMFER = 0.8;        // Boden-Fase
const RIM_MIN_WALL = 2.6;   // minimale Randbreite oben
const CAVITY_R_MAX = 21.0;  // Ei-Mulde Öffnungsradius (Ei ≈ 44 mm breit)

// Kubische Hermite-Interpolation (Catmull-Rom für nicht-uniforme Knoten)
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

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Oberflächen-Welle: -1..1 über den Phasenwinkel
function waveFn(pattern, phase) {
  if (pattern === 'glatt') return 0;
  const c = (Math.cos(phase) + 1) / 2; // 0..1
  if (pattern === 'rippen') return Math.pow(c, 2.2) * 2 - 1; // schmale Grate
  return c * 2 - 1; // weiche Sinuswellen
}

/**
 * Baut die Eierbecher-Geometrie (ohne Text).
 * Rückgabe: { geometry, info } — geometry ist indexed BufferGeometry in mm,
 * y-Achse = Höhe, Ursprung in der Bodenmitte.
 */
export function buildEggcup(params) {
  const p = { ...DEFAULTS, ...params };
  const preset = PRESETS[p.preset] || PRESETS.kelch;
  const curve = makeCurve(preset.points);
  const H = p.height;
  const rMax = MAX_RADIUS * p.width;
  const R = (t) => curve(t) * rMax; // glatter Außenradius bei Höhe t

  const amp = p.pattern === 'glatt' ? 0 : p.depth;
  const twistAngle = p.twist * Math.PI; // Gesamtverdrehung über die Höhe

  // Auflösung: genug radiale Segmente für runde Rippen
  const RS = Math.min(720, Math.max(240, p.ribs * 10));
  // Bei starkem Drall wandern die Grate diagonal → mehr vertikale Auflösung nötig
  const WALL_STEPS = Math.min(340, Math.round(110 + Math.abs(twistAngle) * 34));
  const CAVITY_STEPS = 36;  // Stationen in der Ei-Mulde

  // Ei-Mulde: Kugelkappe
  const rTop = R(1);
  const rCav = Math.min(CAVITY_R_MAX, rTop - RIM_MIN_WALL - amp);
  const D = Math.min(20, H - 9); // Muldentiefe
  const Rs = (rCav * rCav + D * D) / (2 * D); // Kugelradius
  const yc = H - D + Rs; // Kugelzentrum auf der Achse
  const phiRim = Math.asin(Math.min(1, rCav / Rs));

  // Rippen-Fade: unten glatt (Druckbett), oben voll durchlaufend (gezackter Rand)
  const fade = (t) => smoothstep(0.02, 0.14, t);

  // --- Stationen definieren: Liste von { y, r(θ) | r:number } von unten nach oben,
  // Kontur läuft: Bodenmitte → Boden → Fase → Außenwand → Rand → Mulde → Muldengrund.
  const stations = [];
  const rBase = R(CHAMFER / H) - CHAMFER * 0.6;
  stations.push({ y: 0, r: 0 });                    // Bodenmitte (degeneriert)
  stations.push({ y: 0, r: rBase * 0.55 });         // Boden
  stations.push({ y: 0, r: rBase });                // Bodenkante
  // Außenwand mit Muster
  for (let i = 0; i <= WALL_STEPS; i++) {
    const s = i / WALL_STEPS;
    const y = CHAMFER + s * (H - CHAMFER);
    const t = y / H;
    const base = R(t);
    const a = amp * fade(t);
    if (a > 1e-4) {
      stations.push({
        y,
        rFn: (theta) => base + a * waveFn(p.pattern, p.ribs * (theta + twistAngle * t)),
      });
    } else {
      stations.push({ y, r: base });
    }
  }
  // Rand: von der (evtl. gezackten) Außenkante glatt zur Muldenöffnung
  stations.push({ y: H, r: rCav });
  // Ei-Mulde (Kugelkappe), von der Öffnung zum Grund
  for (let i = 1; i < CAVITY_STEPS; i++) {
    const phi = phiRim * (1 - i / CAVITY_STEPS);
    stations.push({ y: yc - Rs * Math.cos(phi), r: Rs * Math.sin(phi) });
  }
  stations.push({ y: H - D, r: 0 });                // Muldengrund (degeneriert)

  // --- Vertices erzeugen
  const positions = [];
  const ringStart = []; // Startindex je Station (-1 → degenerierter Punkt)
  const pointIdx = [];  // Vertexindex degenerierter Stationen
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

  // --- Triangulation: Bänder zwischen benachbarten Stationen.
  // θ läuft über sin/cos so, dass (bei Kontur „aufwärts außen") die Flächen-
  // normalen nach außen zeigen; Mulde und Boden ergeben sich automatisch korrekt.
  const indices = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = ringStart[i], b = ringStart[i + 1];
    if (a === -1 && b === -1) continue;
    if (a === -1) {
      // Fächer von Punkt (unten) zu Ring b — Bodenmitte, Normale -y
      const c = pointIdx[i];
      for (let j = 0; j < RS; j++) {
        const j1 = (j + 1) % RS;
        indices.push(c, b + j1, b + j);
      }
    } else if (b === -1) {
      // Fächer von Ring a zu Punkt (oben) — Muldengrund, Normale +y
      const c = pointIdx[i + 1];
      for (let j = 0; j < RS; j++) {
        const j1 = (j + 1) % RS;
        indices.push(a + j, a + j1, c);
      }
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

  return {
    geometry,
    info: {
      height: H,
      topDiameter: (rTop + amp) * 2,
      baseDiameter: rBase * 2,
      cavityDiameter: rCav * 2,
      cavityDepth: D,
      radialSegments: RS,
      textRadius: R(0.58),
      textY: H * 0.58,
      surfaceAmp: amp * fade(0.58),
    },
  };
}

/**
 * Biegt eine (bereits gebaute, zentrierte) Text-Geometrie um die Becherwand.
 * textGeo: extrudierte TextGeometry in xy, Extrusion in +z (Tiefe `depth`).
 * Ergebnis überlappt die Wand um ~1.5 mm → Slicer verschmilzt beide Körper.
 */
export function bendTextOntoCup(textGeo, info) {
  textGeo.computeBoundingBox();
  const bb = textGeo.boundingBox;
  const wdt = bb.max.x - bb.min.x;
  const hgt = bb.max.y - bb.min.y;
  const depth = bb.max.z - bb.min.z;
  const rOuterFace = info.textRadius + info.surfaceAmp + 0.55; // Textfront über den Rippen
  const rBase = rOuterFace - depth;                            // Textrückseite in der Wand
  const rMid = info.textRadius;

  const pos = textGeo.getAttribute('position');
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) - cx;
    const y = pos.getY(i) - cy;
    const z = pos.getZ(i) - bb.min.z;
    const alpha = x / rMid; // Bogenlänge → Winkel
    const r = rBase + z;
    pos.setXYZ(i, Math.sin(alpha) * r, info.textY + y, Math.cos(alpha) * r);
  }
  pos.needsUpdate = true;
  textGeo.computeVertexNormals();
  return { arc: wdt / rMid, height: hgt, depth };
}

/** Maximale Textbreite (Bogen ≤ 55 % des Umfangs) — für UI-Feedback. */
export function maxTextArc() {
  return Math.PI * 1.1;
}
