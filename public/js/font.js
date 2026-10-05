// formsam — Schrift für Gravuren: typeface.json → Glyphen-Umrisse (Font.generateShapes), Logik wie three.js r160 FontLoader.Font (MIT).
// Eigene Kopie, weil der Hintergrund-Thread (model-worker.js) sie laden muss: vendor/FontLoader.js importiert das „nackte“ 'three',
// das ein Worker ohne Import-Map nicht auflösen kann — und /vendor/ liegt 30 Tage im Browser-Cache, deshalb bleibt es unverändert.
import { ShapePath } from '../vendor/three.module.js';

export class Font {
  constructor(data) {
    this.isFont = true;
    this.type = 'Font';
    this.data = data;
  }

  generateShapes(text, size = 100) {
    const shapes = [];
    for (const path of createPaths(text, size, this.data)) shapes.push(...path.toShapes());
    return shapes;
  }
}

function createPaths(text, size, data) {
  const scale = size / data.resolution;
  const lineHeight = (data.boundingBox.yMax - data.boundingBox.yMin + data.underlineThickness) * scale;
  const paths = [];
  let offsetX = 0, offsetY = 0;
  for (const char of Array.from(text)) {
    if (char === '\n') { offsetX = 0; offsetY -= lineHeight; continue; }
    const ret = createPath(char, scale, offsetX, offsetY, data);
    if (!ret) continue;
    offsetX += ret.offsetX;
    paths.push(ret.path);
  }
  return paths;
}

function createPath(char, scale, offsetX, offsetY, data) {
  const glyph = data.glyphs[char] || data.glyphs['?'];
  if (!glyph) return null;
  const path = new ShapePath();
  if (glyph.o) {
    const outline = glyph._cachedOutline || (glyph._cachedOutline = glyph.o.split(' '));
    for (let i = 0, l = outline.length; i < l;) {
      const action = outline[i++];
      if (action === 'm' || action === 'l') {
        const x = outline[i++] * scale + offsetX, y = outline[i++] * scale + offsetY;
        if (action === 'm') path.moveTo(x, y); else path.lineTo(x, y);
      } else if (action === 'q') {
        const cpx = outline[i++] * scale + offsetX, cpy = outline[i++] * scale + offsetY;
        const cpx1 = outline[i++] * scale + offsetX, cpy1 = outline[i++] * scale + offsetY;
        path.quadraticCurveTo(cpx1, cpy1, cpx, cpy);
      } else if (action === 'b') {
        const cpx = outline[i++] * scale + offsetX, cpy = outline[i++] * scale + offsetY;
        const cpx1 = outline[i++] * scale + offsetX, cpy1 = outline[i++] * scale + offsetY;
        const cpx2 = outline[i++] * scale + offsetX, cpy2 = outline[i++] * scale + offsetY;
        path.bezierCurveTo(cpx1, cpy1, cpx2, cpy2, cpx, cpy);
      }
    }
  }
  return { offsetX: glyph.ha * scale, path };
}
