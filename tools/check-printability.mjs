// OVJU — Druckbarkeits-Analyse: Überhangwinkel einer binären STL (FDM, ohne Support)
// Aufruf: node tools/check-printability.mjs <datei.stl> [grenzwinkel=55]
// Überhangwinkel α: 0° = senkrechte Wand, 90° = horizontale Unterseite.
// FDM druckt zuverlässig bis ~45–50°, mit guter Kühlung bis ~60°.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const LIMIT = parseFloat(process.argv[3] || '55');
const buf = readFileSync(file);
const n = buf.readUInt32LE(80);

let maxAlpha = 0, total = 0, over45 = 0, overLimit = 0;
let worstZ = 0;
for (let i = 0; i < n; i++) {
  const o = 84 + i * 50;
  const v = [];
  for (let k = 0; k < 3; k++) {
    v.push([buf.readFloatLE(o + 12 + k * 12), buf.readFloatLE(o + 16 + k * 12), buf.readFloatLE(o + 20 + k * 12)]);
  }
  // Normale aus Eckpunkten (verlässlicher als gespeicherte)
  const ux = v[1][0] - v[0][0], uy = v[1][1] - v[0][1], uz = v[1][2] - v[0][2];
  const wx = v[2][0] - v[0][0], wy = v[2][1] - v[0][1], wz = v[2][2] - v[0][2];
  const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) continue;
  const area = len / 2;
  const cy = (v[0][1] + v[1][1] + v[2][1]) / 3;
  total += area;
  if (cy < 0.4) continue;                 // Bodenfläche liegt auf dem Bett
  const nyN = ny / len;
  if (nyN >= -1e-6) continue;             // zeigt nicht nach unten → kein Überhang
  const alpha = Math.asin(Math.min(1, -nyN)) * 180 / Math.PI;
  if (alpha > maxAlpha) { maxAlpha = alpha; worstZ = cy; }
  if (alpha > 45) over45 += area;
  if (alpha > LIMIT) overLimit += area;
}

// Silhouette: max. Radius je 1-mm-Höhenscheibe → Auskrag-Steigung der Grundform.
// (Mikro-Textur ≤ ~2 mm horizontaler Ausdehnung ist selbsttragend und zählt nicht hart.)
const bins = [];
for (let i = 0; i < n; i++) {
  const o = 84 + i * 50;
  for (let k = 0; k < 3; k++) {
    const x = buf.readFloatLE(o + 12 + k * 12), y = buf.readFloatLE(o + 16 + k * 12), z = buf.readFloatLE(o + 20 + k * 12);
    const b = Math.round(y);
    const r = Math.hypot(x, z);
    if (bins[b] === undefined || r > bins[b]) bins[b] = r;
  }
}
let silh = 0, silhY = 0;
for (let b = 1; b < bins.length; b++) {
  if (bins[b] === undefined || bins[b - 1] === undefined) continue;
  const drdy = bins[b] - bins[b - 1]; // pro 1 mm
  if (drdy > 0) {
    const a = Math.atan(drdy) * 180 / Math.PI;
    if (a > silh) { silh = a; silhY = b; }
  }
}

// Brückenspannweite: fast waagerechte Unterseiten (Zelldecken bei Voronoi, Buchstabendecken) je 0,5-mm-Schicht
// nach Winkel sortiert und in Läufe geclustert (Lücke > 1,5 mm Bogen) → längster Lauf in mm.
const layers = new Map();
for (let i = 0; i < n; i++) {
  const o = 84 + i * 50;
  const v = [];
  for (let k = 0; k < 3; k++) v.push([buf.readFloatLE(o + 12 + k * 12), buf.readFloatLE(o + 16 + k * 12), buf.readFloatLE(o + 20 + k * 12)]);
  const ux = v[1][0] - v[0][0], uy = v[1][1] - v[0][1], uz = v[1][2] - v[0][2];
  const wx = v[2][0] - v[0][0], wy = v[2][1] - v[0][1], wz = v[2][2] - v[0][2];
  const ny = uz * wx - ux * wz, nx = uy * wz - uz * wy, nz = ux * wy - uy * wx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12 || ny / len > -0.95) continue;
  const cx = (v[0][0] + v[1][0] + v[2][0]) / 3, cy = (v[0][1] + v[1][1] + v[2][1]) / 3, cz = (v[0][2] + v[1][2] + v[2][2]) / 3;
  if (cy < 0.4) continue;
  const key = Math.round(cy * 2);
  if (!layers.has(key)) layers.set(key, []);
  layers.get(key).push([Math.atan2(cx, cz), Math.hypot(cx, cz)]);
}
let bridge = 0, bridgeY = 0;
for (const [key, pts] of layers) {
  if (pts.length < 2) continue;
  pts.sort((a, b) => a[0] - b[0]);
  const r = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  // Start am größten Winkel-Sprung, damit die Naht bei ±π keinen Lauf zerschneidet
  let gi = 0, gmax = -1;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i][0], b = pts[(i + 1) % pts.length][0] + (i === pts.length - 1 ? 2 * Math.PI : 0);
    if (b - a > gmax) { gmax = b - a; gi = (i + 1) % pts.length; }
  }
  let run = 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[(gi + k) % pts.length][0], bIdx = (gi + k + 1) % pts.length;
    let b = pts[bIdx][0]; if (b < a) b += 2 * Math.PI;
    const gap = (b - a) * r;
    if (gap > 1.5) { run = 0; continue; }
    run += gap;
    if (run > bridge) { bridge = run; bridgeY = key / 2; }
  }
}
console.log(`  Brücken: längste waagerechte Unterseite ${bridge.toFixed(1)} mm (bei y=${bridgeY} mm)`);

const p45 = (over45 / total * 100), pL = (overLimit / total * 100);
console.log(`  Silhouette: max. ${silh.toFixed(1)}° Auskragung (bei y=${silhY} mm)`);
console.log(`  Textur: max. Flankenwinkel ${maxAlpha.toFixed(1)}° · Fläche >45°: ${p45.toFixed(2)} % · >${LIMIT}°: ${pL.toFixed(2)} %`);
if (bridge > 45) console.log('  ❌ Brücke > 45 mm — Zellen kleiner wählen oder Stützen einplanen');
else if (bridge > 30) console.log('  ⚠️ Brücke > 30 mm — im Slicer Brücken/Stützen prüfen');
if (silh > 62) console.log('  ❌ Grundform kragt zu stark aus — braucht Support');
else if (silh > 50) console.log('  ⚠️ ausladende Grundform — mit guter Kühlung/0,16er-Schichten druckbar');
else if (maxAlpha > 75 && pL > 15) console.log('  ✅ druckbar — markante Struktur, extra Kühlung empfohlen');
else console.log('  ✅ ohne Support druckbar');
process.exit(silh > 62 || bridge > 45 ? 1 : 0);
