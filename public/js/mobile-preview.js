// OVJU Mobil — 3D-Vorschauen der sechs Swatch-Muster (Rippen … Glatt), gerendert aus dem echten Konfigurator-Modell:
// EINE Vasenform (Flasche 15 cm, mobile-patterns.js), je Muster eine eigene Markenfarbe, warmes Streiflicht von links, weicher
// Kontaktschatten, warmer Elfenbein-Grund. Je Muster ZWEI Bilder aus EINEM Mesh:
//  · full  — die ganze Vase im Hochformat 4:5 (Kachel und Sheet-Hauptbild): Kamera leicht von oben, Rahmen aus den echten Vertex-
//            Positionen berechnet (12 % Luft über dem Hals, Platz für den Schatten unter dem Fuß, nichts angeschnitten)
//  · macro — der Bauch aus der Nähe (rundes Detail unten rechts im Sheet), Streiflicht fast parallel zur Wand → das Relief zeichnet Schatten
// Läuft die Hero-3D, rendert studio.js im Hero-Canvas (ovju:world-snapshot → renderJob, kein zweiter WebGL-Kontext); ohne Hero-3D
// (prefers-reduced-motion, Poster-Modus, vorbeigescrollt) rendert renderPreviewsOffscreen in einem kurzlebigen Kontext, der danach
// verworfen wird. Beide Wege nutzen renderJob (transparent gerendert, Grund + Kontaktschatten in 2D) → gleiche Bilder auf jedem Weg.
import * as THREE from 'three';
import { makeStudio, makeObject } from './studio-scene.js';

const SMALL = matchMedia('(max-width:700px)').matches;

export const SWATCH_VIEW = {
  bg: 0xefe8da,                         // warmes Elfenbein (Kachel-, Sheet- und Platzhaltergrund, mobile.css --m-sw-bg)
  light: [-470, 150, 150], keyI: 3.6,   // Streiflicht von links, flach (Relief wirft Schatten), warm (Farbe aus studio-scene.js)
  hemi: .2, env: .3,                    // wenig Umgebungslicht → Relief bleibt plastisch
  full: { w: 480, h: 600, fov: 22, elev: .2, top: .12, bottom: .09, side: .08 },
  macro: { w: 176, h: 176, fov: 16, elev: .1, az: -.32, span: .3 },
};

/**
 * Szene für eine Vorschau umstellen (Streiflicht, Umgebung) — gibt die Rücksetzfunktion zurück. Boden und Schattenwurf sind aus: das flache
 * Streiflicht würfe einen meterlangen Schlagschatten; den weichen Kontaktschatten zeichnet grab() unter die Vase (Fußellipse aus der Kamera).
 */
export function applyView(scene, v) {
  const key = scene.children.find((o) => o.isDirectionalLight && o.castShadow), hemi = scene.children.find((o) => o.isHemisphereLight);
  const floor = scene.children.find((o) => o.isMesh && o.geometry && o.geometry.type === 'PlaneGeometry');
  const saved = { kp: key && key.position.clone(), ki: key && key.intensity, hi: hemi && hemi.intensity, fv: floor && floor.visible };
  if (key && v.light) { key.position.set(...v.light); key.intensity = v.keyI ?? key.intensity; }
  if (key) key.castShadow = false;
  if (hemi && v.hemi != null) hemi.intensity = v.hemi;
  if (floor) floor.visible = false;
  return () => {
    if (key) { key.position.copy(saved.kp); key.intensity = saved.ki; key.castShadow = true; }
    if (hemi) hemi.intensity = saved.hi;
    if (floor) floor.visible = saved.fv;
  };
}
/** Vorschau-Mesh in der Musterfarbe (matt, gedämpfte Spiegelung) */
export function previewMesh(job) {
  const mesh = makeObject({ config: job.config, hex: job.hex || '#efe9dc', finish: job.finish || 'matt' }, job.q ?? .5);
  if (job.env != null) mesh.material.envMapIntensity = job.env;
  mesh.rotation.y = job.rot ?? 0;
  return mesh;
}

/** Stichprobe der Vertex-Positionen (≈ 4000) — daraus rechnen beide Kameras ihren Bildausschnitt */
function samplePoints(mesh, n = 4000) {
  const p = mesh.geometry.attributes.position, step = Math.max(1, Math.floor(p.count / n)), pts = [];
  for (let i = 0; i < p.count; i += step) pts.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
  return pts;
}
function extents(cam, pts) {
  const v = new THREE.Vector3(); let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const q of pts) { v.copy(q).project(cam); if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x; if (v.y < y0) y0 = v.y; if (v.y > y1) y1 = v.y; }
  return { x0, x1, y0, y1 };
}
/**
 * Ganze Vase: Blick leicht von oben (elev), Abstand per Bisektion so, dass die projizierte Vase (echte Vertices) genau zwischen
 * top und bottom (Anteile der Bildhöhe) passt und seitlich ≥ side Luft bleibt; danach per View-Offset exakt ausgerichtet.
 */
function fullCamera(pts, bb, view) {
  const cam = new THREE.PerspectiveCamera(view.fov, view.w / view.h, 1, 5000);
  const H = bb.max.y - bb.min.y, tgt = new THREE.Vector3(0, bb.min.y + H * .5, 0), dir = new THREE.Vector3(0, Math.sin(view.elev), Math.cos(view.elev));
  const place = (D) => { cam.position.copy(tgt).addScaledVector(dir, D); cam.lookAt(tgt); cam.updateMatrixWorld(); cam.clearViewOffset(); cam.updateProjectionMatrix(); return extents(cam, pts); };
  const wantY = 2 * (1 - view.top - view.bottom), wantX = 2 * (1 - 2 * view.side);
  let lo = H * .3, hi = H * 40;
  for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2, e = place(mid); if (e.y1 - e.y0 > wantY || e.x1 - e.x0 > wantX) lo = mid; else hi = mid; }
  const e = place(hi);
  cam.setViewOffset(view.w, view.h, Math.round((e.x0 + e.x1) / 4 * view.w), Math.round(((1 - e.y1) / 2 - view.top) * view.h), view.w, view.h);
  cam.updateProjectionMatrix();
  // Fußellipse in Pixeln (Mitte + Radius) für den gezeichneten Kontaktschatten
  let rb = 0; for (const q of pts) if (q.y < bb.min.y + 3) rb = Math.max(rb, Math.hypot(q.x, q.z));
  const px = (x, y, z) => { const p = new THREE.Vector3(x, y, z).project(cam); return [(p.x + 1) / 2 * view.w, (1 - p.y) / 2 * view.h]; };
  const [cx, cy] = px(0, bb.min.y, 0), [ex] = px(rb || 30, bb.min.y, 0), [, fy] = px(0, bb.min.y, rb || 30);
  cam.userData.foot = { cx, cy, rx: Math.abs(ex - cx), ry: Math.max(3, Math.abs(fy - cy)) };
  return cam;
}
/** Makro: Blick auf die breiteste Stelle des Bauchs, leicht zum Licht gedreht (az), Bildhöhe ≈ span × Vasenhöhe auf der Wand */
function macroCamera(pts, bb, view) {
  let R = 0, yR = (bb.min.y + bb.max.y) / 2;
  for (const q of pts) { const r = Math.hypot(q.x, q.z); if (r > R && q.y > bb.min.y + 8 && q.y < bb.max.y - 8) { R = r; yR = q.y; } }
  const H = bb.max.y - bb.min.y, t = Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const D = R + (H * view.span / 2) / t;
  const cam = new THREE.PerspectiveCamera(view.fov, view.w / view.h, 1, 5000);
  const tgt = new THREE.Vector3(0, yR, 0);
  cam.position.set(Math.sin(view.az) * Math.cos(view.elev) * D, yR + Math.sin(view.elev) * D, Math.cos(view.az) * Math.cos(view.elev) * D);
  cam.lookAt(tgt); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  return cam;
}
/**
 * Zeichenpuffer direkt nach dem Rendern auslesen (auch ohne preserveDrawingBuffer; transparent gerendert, Farben vormultipliziert) und
 * auf den Elfenbein-Grund setzen — bei der ganzen Vase mit weichem Kontaktschatten unter dem Fuß (leicht nach rechts, Licht von links).
 * → data:-URL (WebP, sonst JPEG — Safari kodiert kein WebP)
 */
function grab(renderer, w, h, bg, foot) {
  const gl = renderer.getContext(), px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const tctx = t.getContext('2d'), img = tctx.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4, dst = y * w * 4;
    for (let x = 0; x < w * 4; x += 4) {
      const a = px[src + x + 3]; d[dst + x + 3] = a;
      if (a && a < 255) { const k = 255 / a; d[dst + x] = Math.min(255, px[src + x] * k); d[dst + x + 1] = Math.min(255, px[src + x + 1] * k); d[dst + x + 2] = Math.min(255, px[src + x + 2] * k); }
      else { d[dst + x] = px[src + x]; d[dst + x + 1] = px[src + x + 1]; d[dst + x + 2] = px[src + x + 2]; }
    }
  }
  tctx.putImageData(img, 0, 0);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#' + new THREE.Color(bg).getHexString(); ctx.fillRect(0, 0, w, h);
  if (foot) {
    const blob = (dx, sx, sy, alpha) => {
      ctx.save(); ctx.translate(foot.cx + dx, foot.cy); ctx.scale(1, sy / sx);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, sx);
      g.addColorStop(0, `rgba(58,44,30,${alpha})`); g.addColorStop(.55, `rgba(58,44,30,${alpha * .45})`); g.addColorStop(1, 'rgba(58,44,30,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, sx, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    };
    blob(foot.rx * .7, foot.rx * 2.1, foot.ry * 2.2, .16);  // weicher Streulicht-Schatten nach rechts
    blob(foot.rx * .12, foot.rx * 1.18, foot.ry * 1.35, .42); // Kontaktschatten direkt unter dem Fuß
  }
  ctx.drawImage(t, 0, 0);
  const u = c.toDataURL('image/webp', .86);
  return u.startsWith('data:image/webp') ? u : c.toDataURL('image/jpeg', .88);
}
/**
 * Eine Vorschau rendern: { full, macro } (data:-URLs). Setzt Pixelverhältnis 1, Clear-Farbe und Puffergröße — der Aufrufer stellt
 * seine Bühne danach wieder her (studio.js) bzw. verwirft den Kontext (offscreen). Wirft bei Fehlern.
 */
export function renderJob(renderer, scene, job) {
  const v = { ...SWATCH_VIEW, ...job };
  let mesh = null, restore = null;
  try {
    restore = applyView(scene, v);
    mesh = previewMesh(v); scene.add(mesh);
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox, pts = samplePoints(mesh), out = {};
    renderer.setPixelRatio(1); renderer.setClearColor(0x000000, 0);
    for (const id of ['full', 'macro']) {
      if (job[id] === false) continue; // z. B. Glatt: kein Makro (nichts zu zeigen)
      const view = { ...SWATCH_VIEW[id], ...(job[id] || {}) };
      renderer.setSize(view.w, view.h, false);
      const cam = id === 'full' ? fullCamera(pts, bb, view) : macroCamera(pts, bb, view);
      renderer.render(scene, cam);
      out[id] = grab(renderer, view.w, view.h, v.bg, cam.userData.foot);
    }
    return out;
  } finally {
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
    restore?.();
  }
}

/**
 * items: [{ config, hex, finish, … SWATCH_VIEW-Überschreibungen }] → Promise<({full, macro}|null)[]>
 * Kurzlebiger Kontext (transparent wie der Hero-Canvas), je Modell ein Leerlauf-Fenster; wirft nie.
 * onEach(i, out): sofort nach JEDEM Modell — die Kachel bekommt ihr Bild, ohne auf die übrigen zu warten (keine „Geister-Kacheln“).
 */
export async function renderPreviewsOffscreen(items, onEach = null) {
  if (!SMALL || !items.length) return items.map(() => null);
  let studio = null; const out = [];
  try {
    const canvas = document.createElement('canvas'); canvas.width = SWATCH_VIEW.full.w; canvas.height = SWATCH_VIEW.full.h;
    studio = makeStudio(canvas, { width: SWATCH_VIEW.full.w, height: SWATCH_VIEW.full.h, transparent: true, capture: true, shadowSize: 512 });
    for (const it of items) {
      let o = null;
      try { o = renderJob(studio.renderer, studio.scene, it); } catch (err) { console.warn('Muster-Vorschau (offscreen) nicht möglich', err); }
      out.push(o);
      if (onEach) { try { onEach(out.length - 1, o); } catch (err) { console.warn(err); } }
      await new Promise((r) => setTimeout(r, 40)); // Hauptthread zwischen zwei Modellen freigeben (Kachel-Einblendung kann malen)
    }
  } catch (err) { console.warn('Offscreen-Vorschau nicht verfügbar', err); while (out.length < items.length) out.push(null); }
  finally {
    if (studio) { try { studio.dispose(); studio.renderer.forceContextLoss(); } catch { /* egal */ } }
  }
  return out;
}
