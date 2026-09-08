// OVJU — erzeugt aus einer gespeicherten Design-Konfiguration die druckfertige STL
// (wird vom Konfigurator UND vom Warenkorb-Checkout genutzt)
import * as THREE from 'three';
import { buildModel, buildSaucer, FONTS } from './geometry.js';
import { FontLoader } from '../vendor/FontLoader.js';
import { exportSTL } from './exporter.js';
import { make3MF } from './threemf.js';

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


/** Dateiendung für den Export dieser Konfiguration: Farbschrift → 3MF (2 Teile), sonst STL */
export const exportExt = (config) => ((String(config.text || '').trim() && config.textStyle === 'farbe') ? '3mf' : 'stl');

/**
 * Konfiguration → Druckdatei. STL für einfarbige Modelle; bei Farbschrift ein 3MF mit einem Objekt
 * aus zwei Teilen (Körper = Filament 1, Schrift = Filament 2), das Bambu Studio/Orca direkt zuordnet.
 * Rückgabe: { buffer, ext, mime }
 */
export async function makeExport(config) {
  if (exportExt(config) !== '3mf') return { buffer: await makeSTL(config), ext: 'stl', mime: 'model/stl' };
  const txt = (config.text || '').trim();
  const textFont = await loadFont(config.font);
  const fallbackFont = await loadFont('droid_sans');
  // 3MF ist Text: normale Auflösung statt Feinst-Export, sonst wird die Datei riesig (Textband bleibt fein)
  const { geometry, info } = buildModel({ ...config, quality: 1, exportRes: false, textFont, fallbackFont });
  const parts = [{ name: 'Körper (Filament 1)', mesh: new THREE.Mesh(geometry), extruder: 1 }];
  if (info.inlay) parts.push({ name: `Schrift „${txt}“ (Filament 2)`, mesh: new THREE.Mesh(info.inlay), extruder: 2 });
  const objects = [{ name: config.product === 'vase' ? 'OVJU Vase' : 'OVJU Eierbecher', parts }];
  if (config.product === 'eierbecher' && config.saucer) {
    const s = buildSaucer({ ...config, quality: 1 });
    const sm = new THREE.Mesh(s.geometry);
    sm.position.x = s.info.outerRadius + info.baseDiameter / 2 + 6;
    objects.push({ name: 'Untersetzer', parts: [{ name: 'Untersetzer (Filament 1)', mesh: sm, extruder: 1 }] });
  }
  const buffer = await make3MF(objects);
  geometry.dispose(); info.inlay?.dispose();
  return { buffer, ext: '3mf', mime: 'model/3mf' };
}
