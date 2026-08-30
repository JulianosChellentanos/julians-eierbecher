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

const p45 = (over45 / total * 100), pL = (overLimit / total * 100);
console.log(`  max. Überhang: ${maxAlpha.toFixed(1)}° (bei y=${worstZ.toFixed(0)} mm) · Fläche >45°: ${p45.toFixed(2)} % · >${LIMIT}°: ${pL.toFixed(2)} %`);
if (maxAlpha <= 50 || pL < 0.05) console.log('  ✅ ohne Support druckbar');
else if (maxAlpha <= 62) console.log('  ⚠️ grenzwertig — mit guter Kühlung/0,16er-Schichten druckbar');
else console.log('  ❌ zu steile Überhänge — braucht Support oder flachere Einstellungen');
process.exit(maxAlpha > 62 && pL >= 0.05 ? 1 : 0);
