// OVJU — CLI: erzeugt eine Eierbecher-STL ohne Browser (für Tests/Reproduktion)
// Aufruf: node tools/generate-stl.mjs out.stl '{"preset":"kelch","ribs":48,...}'
import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildEggcup, buildSaucer } from '../public/js/geometry.js';
import { exportSTL } from '../public/js/exporter.js';

const out = process.argv[2] || 'eierbecher.stl';
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const { geometry, info } = buildEggcup(params);
const mesh = new THREE.Mesh(geometry);
const meshes = [mesh];
if (params.saucer) {
  const s = buildSaucer(params);
  const sm = new THREE.Mesh(s.geometry);
  sm.position.x = s.info.outerRadius + info.baseDiameter / 2 + 6; // nebeneinander aufs Bett
  meshes.push(sm);
}
const buf = exportSTL(meshes);
writeFileSync(out, Buffer.from(buf));
console.log(`✅ ${out} — ${(buf.byteLength / 1e6).toFixed(1)} MB, H=${info.height}mm, Ø oben=${info.topDiameter.toFixed(1)}mm, Mulde Ø${info.cavityDiameter.toFixed(1)}×${info.cavityDepth}mm`);
