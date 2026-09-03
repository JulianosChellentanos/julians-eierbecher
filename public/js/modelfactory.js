// OVJU — erzeugt aus einer gespeicherten Design-Konfiguration die druckfertige STL
// (wird vom Konfigurator UND vom Warenkorb-Checkout genutzt)
import * as THREE from 'three';
import { buildModel, buildSaucer, bendTextOntoCup, maxTextArc, FONTS, isIntegratedTextStyle } from './geometry.js';
import { FontLoader } from '../vendor/FontLoader.js';
import { TextGeometry } from '../vendor/TextGeometry.js';
import { exportSTL } from './exporter.js';

const fontCache = {};
export function loadFont(key) {
  if (!FONTS[key]) key = 'helvetiker';
  if (!fontCache[key]) {
    fontCache[key] = new Promise((resolve, reject) =>
      new FontLoader().load(`fonts/${FONTS[key].file}`, resolve, undefined, reject));
  }
  return fontCache[key];
}

/** Konfiguration → binäre STL (ArrayBuffer), volle Auflösung, inkl. Text & Untersetzer. */
export async function makeSTL(config) {
  const txt = (config.text || '').trim();
  const integrated = !!txt && isIntegratedTextStyle(config.textStyle);
  const textFont = integrated ? await loadFont(config.font) : undefined;
  const { geometry, info } = buildModel({ ...config, quality: 1, textFont });
  const meshes = [new THREE.Mesh(geometry)];
  const disposables = [geometry];

  if (txt && !integrated) {
    const font = await loadFont(config.font);
    const textPos = config.textPos ?? 0.55;
    const depth = info.ampAt(textPos) + 2.0;
    let size = config.textSize ?? 7;
    let geo, result;
    for (let attempt = 0; attempt < 6; attempt++) {
      geo = new TextGeometry(txt, { font, size, height: depth, curveSegments: 6, bevelEnabled: false });
      result = bendTextOntoCup(geo, info, textPos);
      if (result.arc <= maxTextArc()) break;
      geo.dispose();
      size *= 0.88;
    }
    if (result.arc <= maxTextArc()) {
      meshes.push(new THREE.Mesh(geo));
      disposables.push(geo);
    } else {
      geo.dispose();
    }
  }

  if (config.product === 'eierbecher' && config.saucer) {
    const s = buildSaucer({ ...config, quality: 1 });
    const sm = new THREE.Mesh(s.geometry);
    sm.position.x = s.info.outerRadius + info.baseDiameter / 2 + 6; // nebeneinander aufs Bett
    meshes.push(sm);
    disposables.push(s.geometry);
  }

  const buf = exportSTL(meshes);
  disposables.forEach((g) => g.dispose());
  return buf;
}
