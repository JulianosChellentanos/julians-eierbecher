// OVJU — CLI: erzeugt eine Eierbecher-/Vasen-STL ohne Browser (für Tests/Reproduktion)
// Aufruf: node tools/generate-stl.mjs out.stl '{"preset":"kelch","ribs":48,"text":"Mia","textStyle":"gehaemmert",...}'
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import { buildEggcup, buildSaucer, bendTextOntoCup, maxTextArc, FONTS, isIntegratedTextStyle } from '../public/js/geometry.js';
import { Font } from '../public/vendor/FontLoader.js';
import { TextGeometry } from '../public/vendor/TextGeometry.js';
import { exportSTL } from '../public/js/exporter.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = process.argv[2] || 'eierbecher.stl';
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const txt = String(params.text || '').trim();
let font = null;
if (txt) {
  const f = FONTS[params.font] ? params.font : 'helvetiker';
  font = new Font(JSON.parse(readFileSync(path.join(ROOT, 'public', 'fonts', FONTS[f].file), 'utf8')));
}
const t0 = Date.now();
const { geometry, info } = buildEggcup({ ...params, exportRes: true, textFont: font });
const meshes = [new THREE.Mesh(geometry)];
if (txt && font && !isIntegratedTextStyle(params.textStyle)) {
  // aufgesetzte Schrift wie im Browser (modelfactory.makeSTL)
  const textPos = params.textPos ?? 0.55;
  const depth = info.ampAt(textPos) + 2.0;
  let size = params.textSize ?? 7, geo, result;
  for (let attempt = 0; attempt < 6; attempt++) {
    geo = new TextGeometry(txt, { font, size, height: depth, curveSegments: 6, bevelEnabled: false });
    result = bendTextOntoCup(geo, info, textPos);
    if (result.arc <= maxTextArc()) break;
    size *= 0.88;
  }
  if (result.arc <= maxTextArc()) meshes.push(new THREE.Mesh(geo));
}
if (params.saucer) {
  const s = buildSaucer(params);
  const sm = new THREE.Mesh(s.geometry);
  sm.position.x = s.info.outerRadius + info.baseDiameter / 2 + 6; // nebeneinander aufs Bett
  meshes.push(sm);
}
const buf = exportSTL(meshes);
writeFileSync(out, Buffer.from(buf));
console.log(`✅ ${out} — ${(buf.byteLength / 1e6).toFixed(1)} MB, ${Date.now() - t0} ms, H=${info.height}mm, Ø oben=${info.topDiameter.toFixed(1)}mm, Mulde Ø${info.cavityDiameter.toFixed(1)}×${info.cavityDepth}mm${info.text?.warn ? ' · ' + info.text.warn : ''}${txt ? ` · Gravur „${txt}“ (${params.textStyle || 'gepraegt'}, ${(info.text?.size ?? params.textSize ?? 7).toFixed(1)} mm)` : ''}`);
