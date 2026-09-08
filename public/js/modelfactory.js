// OVJU — erzeugt aus einer gespeicherten Design-Konfiguration die druckfertige STL
// (wird vom Konfigurator UND vom Warenkorb-Checkout genutzt)
import * as THREE from 'three';
import { buildModel, buildSaucer, FONTS } from './geometry.js';
import { FontLoader } from '../vendor/FontLoader.js';
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

/** Konfiguration → binäre STL (ArrayBuffer), volle Auflösung, inkl. Gravur-Relief & Untersetzer. */
export async function makeSTL(config) {
  const txt = (config.text || '').trim();
  const textFont = txt ? await loadFont(config.font) : undefined;
  const fallbackFont = txt ? await loadFont('droid_sans') : undefined;
  const { geometry, info } = buildModel({ ...config, quality: 1, exportRes: true, textFont, fallbackFont }); // Export: feinstes Raster
  const meshes = [new THREE.Mesh(geometry)];
  const disposables = [geometry];

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
