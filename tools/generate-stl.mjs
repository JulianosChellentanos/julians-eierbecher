// OVJU — CLI: erzeugt eine Eierbecher-/Vasen-STL ohne Browser (für Tests/Reproduktion)
// Aufruf: node tools/generate-stl.mjs out.stl '{"preset":"kelch","ribs":48,"text":"Mia","textStyle":"gehaemmert",...}'
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import { buildEggcup, buildSaucer, FONTS } from '../public/js/geometry.js';
import { Font } from '../public/vendor/FontLoader.js';
import { exportSTL } from '../public/js/exporter.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = process.argv[2] || 'eierbecher.stl';
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const txt = String(params.text || '').trim();
const loadFont = (key) => new Font(JSON.parse(readFileSync(path.join(ROOT, 'public', 'fonts', FONTS[FONTS[key] ? key : 'helvetiker'].file), 'utf8')));
const font = txt ? loadFont(params.font) : null;
const fallbackFont = txt ? loadFont('droid_sans') : null;
const t0 = Date.now();
const { geometry, info } = buildEggcup({ ...params, exportRes: true, textFont: font, fallbackFont });
const meshes = [new THREE.Mesh(geometry)];
if (params.saucer) {
  const s = buildSaucer(params);
  const sm = new THREE.Mesh(s.geometry);
  sm.position.x = s.info.outerRadius + info.baseDiameter / 2 + 6; // nebeneinander aufs Bett
  meshes.push(sm);
}
const buf = exportSTL(meshes);
writeFileSync(out, Buffer.from(buf));
console.log(`✅ ${out} — ${(buf.byteLength / 1e6).toFixed(1)} MB, ${Date.now() - t0} ms, H=${info.height}mm, Ø oben=${info.topDiameter.toFixed(1)}mm, Mulde Ø${info.cavityDiameter.toFixed(1)}×${info.cavityDepth}mm${info.text?.warn ? ' · ' + info.text.warn : ''}${txt ? ` · Gravur „${txt}“ (${info.text?.style || params.textStyle}, ${(info.text?.size ?? params.textSize ?? 7).toFixed(1)} mm${info.text?.disabled ? ', DEAKTIVIERT: ' + info.text.reason : ''})` : ''}`);
