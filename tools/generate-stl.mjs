// OVJU — CLI: erzeugt eine Eierbecher-STL ohne Browser (für Tests/Reproduktion)
// Aufruf: node tools/generate-stl.mjs out.stl '{"preset":"kelch","ribs":48,...}'
import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildEggcup } from '../public/js/geometry.js';
import { exportSTL } from '../public/js/exporter.js';

const out = process.argv[2] || 'eierbecher.stl';
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const { geometry, info } = buildEggcup(params);
const mesh = new THREE.Mesh(geometry);
const buf = exportSTL([mesh]);
writeFileSync(out, Buffer.from(buf));
console.log(`✅ ${out} — ${(buf.byteLength / 1e6).toFixed(1)} MB, H=${info.height}mm, Ø oben=${info.topDiameter.toFixed(1)}mm, Mulde Ø${info.cavityDiameter.toFixed(1)}×${info.cavityDepth}mm`);
