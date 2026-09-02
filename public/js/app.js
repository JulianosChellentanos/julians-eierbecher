// OVJU — Konfigurator: 3D-Szene, UI-Bindings, Bestellung (Eierbecher & Vasen)
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TextGeometry } from '../vendor/TextGeometry.js';
import {
  buildModel, buildSaucer, bendTextOntoCup, maxTextArc, sampleProfile,
  DEFAULTS, PRODUCTS, PATTERNS, FLOWS, FONTS,
} from './geometry.js';
import { downloadSTL } from './exporter.js';
import { makeEgg, makeGrass } from './scenes.js';
import { RGBELoader } from '../vendor/RGBELoader.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { makeSTL, loadFont } from './modelfactory.js';
import { initCart, addToCart, getPricing, fmt, discountTeaser, volumeSurcharge } from './cart.js';
import { initAuth } from './auth.js';
import { initMobileShell, updateMobileTabs, showToast, bumpCart, animateMoney, setMobilePrice, IS_MOBILE } from './mobile.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const IS_SMALL = window.matchMedia('(max-width: 980px)').matches;
const state = {
  ...DEFAULTS,
  quality: IS_SMALL ? 0.55 : 1,
  saucer: false,
  color: null, colorName: '', colorHex: '#efe9dc',
};
const customByProduct = { eierbecher: null, vase: null };
const EDITOR_T = [0, 0.15, 0.3, 0.45, 0.62, 0.8, 1];
let lastRealPreset = { eierbecher: 'kelch', vase: 'flasche' };
const START_PRODUCT = 'vase';
let content = null;
let cupMesh = null;
let textMesh = null;
let currentInfo = null;
let userInteracted = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------------------------------------------------------------------------
// Content laden & Seite füllen
// ---------------------------------------------------------------------------
async function loadContent() {
  content = await (await fetch('content.json')).json();
  document.title = `${content.brand.name} — ${content.brand.tagline}`;
  $('#brand-name').textContent = content.brand.name;
  $('#brand-tagline').textContent = content.brand.tagline;
  $('#hero-headline').textContent = content.hero.headline;
  $('#hero-sub').textContent = content.hero.subheadline;
  $('#hero-cta').textContent = content.hero.cta;
  $('#footer-text').textContent = content.footer.text;
  $('#footer-brand').textContent = content.brand.name;

  $('#usps').innerHTML = content.usps.map((u) => `
    <div class="usp card"><div class="usp-icon">${u.icon}</div>
    <h3>${u.title}</h3><p>${u.text}</p></div>`).join('');
  $('#steps').innerHTML = content.steps.map((s) => `
    <div class="step"><div class="step-num">${s.num}</div>
    <h3>${s.title}</h3><p>${s.text}</p></div>`).join('');
  $('#faq-list').innerHTML = content.faq.map((f) => `
    <details class="card"><summary>${f.q}</summary><p>${f.a}</p></details>`).join('');

  // Rechtliche Hinweise & Trust-Row
  const h = content.hinweise || {};
  if (h.trust) $('#trust-row').innerHTML = h.trust.map((t) => `<span>${t}</span>`).join('');
  if (h.vase) $('#vase-note').textContent = h.vase;
  if (h.eigene) $('#eigene-note').textContent = h.eigene;
  if (h.checkout) $('#checkout-note').textContent = h.checkout;

  // Verfügbare Filament-Farben kommen live vom Server (Admin: 🎨 Farben)
  let colors = content.colors;
  try {
    const live = await (await fetch('/api/colors')).json();
    if (Array.isArray(live) && live.length) colors = live;
  } catch { /* Fallback: content.json */ }
  content.colors = colors;
  // Matt zuerst, dann Glanz/Metallic — mit Finish-Effekt auf dem Swatch
  const order = { matt: 0, glanz: 1, metall: 2 };
  colors.sort((a, b) => (order[a.finish || 'matt'] ?? 0) - (order[b.finish || 'matt'] ?? 0));
  $('#swatches').innerHTML = colors.map((c) => `
    <button class="swatch sw-${c.finish || 'matt'}" data-id="${c.id}" data-hex="${c.hex}" data-name="${c.name}" data-finish="${c.finish || 'matt'}"
      style="--sw:${c.hex}" title="${c.name}${(c.finish || 'matt') !== 'matt' ? ' · ' + FINISH_LABEL[c.finish] : ''}"><span></span></button>`).join('');
  $$('.swatch').forEach((b) => b.addEventListener('click', () => setColor(b.dataset)));
  setColor(colors[0]);
}

function renderPrices() {
  const pp = getPricing().products[state.product];
  const size = volumeSurcharge(state.product, { height: state.height, width: state.width });
  animateMoney($('#price'), pp.single + size, fmt);
  animateMoney($('#mb-price'), pp.single + size, fmt);
  setMobilePrice(undefined, size > 0 ? `inkl. ${fmt(size)} Größe` : 'pro Stück');
  $('#price-hint').textContent = discountTeaser(state.product);
  const badge = $('#price-size');
  if (size > 0) {
    badge.hidden = false;
    badge.textContent = `inkl. ${fmt(size)} Größenaufschlag (XL-Format = mehr Filament & Druckzeit)`;
  } else {
    badge.hidden = true;
  }
}

function setColor({ id, hex, name, finish }) {
  const f = finish || 'matt';
  state.color = id; state.colorHex = hex; state.colorName = name; state.colorFinish = f;
  $$('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  $('#color-name').textContent = f === 'matt' ? name : `${name} · ${FINISH_LABEL[f]}`;
  const fn = $('#farbe-name'); if (fn) fn.textContent = `— ${name} · ${FINISH_LABEL[f]}`;
  material.color.set(hex);
  Object.assign(material, FINISH_PROPS[f] || FINISH_PROPS.matt);
  material.needsUpdate = true;
  document.documentElement.style.setProperty('--accent-live', hex);
}

// ---------------------------------------------------------------------------
// 3D-Szene
// ---------------------------------------------------------------------------
const canvas = $('#viewer');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 1, 1600);
camera.position.set(95, 75, 150);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 30, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 60;
controls.maxDistance = 900;
controls.maxPolarAngle = Math.PI * 0.55;
controls.addEventListener('start', () => { userInteracted = true; });

const hemi = new THREE.HemisphereLight(0xfff6ea, 0xb9a894, 0.9);
scene.add(hemi);
const keyLight = new THREE.DirectionalLight(0xfff2e0, 1.6);
keyLight.position.set(120, 220, 140);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -140; keyLight.shadow.camera.right = 140;
keyLight.shadow.camera.top = 260; keyLight.shadow.camera.bottom = -140;
keyLight.shadow.radius = 6;
scene.add(keyLight);
const fill = new THREE.DirectionalLight(0xdce8ff, 0.5);
fill.position.set(-90, 60, -60);
scene.add(fill);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(400, 64).rotateX(-Math.PI / 2),
  new THREE.ShadowMaterial({ opacity: 0.16 })
);
ground.receiveShadow = true;
scene.add(ground);

// Finishes wie bei echten PLA-Sorten: matt, glossy, Silk/Metallic
const FINISH_PROPS = {
  matt: { roughness: 0.62, metalness: 0.0, clearcoat: 0.0, clearcoatRoughness: 0.5 },
  glanz: { roughness: 0.16, metalness: 0.04, clearcoat: 0.75, clearcoatRoughness: 0.18 },
  metall: { roughness: 0.28, metalness: 0.92, clearcoat: 0.0, clearcoatRoughness: 0.5 },
};
export const FINISH_LABEL = { matt: 'matt', glanz: 'glänzend', metall: 'metallic' };
const material = new THREE.MeshPhysicalMaterial({ color: state.colorHex, ...FINISH_PROPS.matt });

// Neutrale Studio-Umgebung → Metall & Glanz reflektieren auch ohne HDRI-Szene
const pmrem = new THREE.PMREMGenerator(renderer);
const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

// ---------------------------------------------------------------------------
// Szenen: Studio (clean) + fotoreale CC0-HDRI-Räume von Poly Haven
// ---------------------------------------------------------------------------
const SCENES = {
  studio: { label: 'Studio', props: false, hemi: 0.9, keyI: 1.6, keyColor: 0xfff2e0 },
  esstisch: { label: 'Esstisch', hdri: 'lebombo', surface: 'wood', props: true, blur: 0.22, bgI: 1.0, keyI: 1.15 },
  fenster: { label: 'Fensterbrett', hdri: 'spruit_sunrise', surface: 'sill', props: true, blur: 0.12, bgI: 0.95, keyI: 1.15, envI: 0.5, keyColor: 0xffffff },
  cafe: { label: 'Café', hdri: 'comfy_cafe', surface: 'wood', props: true, blur: 0.28, bgI: 1.05, keyI: 1.0 },
  abend: { label: 'Abend', hdri: 'warm_restaurant_night', surface: 'wood', props: true, blur: 0.3, bgI: 0.95, keyI: 1.3, keyColor: 0xffd3a0 },
};
let currentScene = 'studio';

const propsGroup = new THREE.Group();
propsGroup.visible = false;
scene.add(propsGroup);

// Echte Standflächen: Holztisch (CC0-Textur, Poly Haven) & helle Fensterbank
const woodMap = new THREE.TextureLoader().load('env/wood_table_001_diff_1k.jpg');
woodMap.colorSpace = THREE.SRGBColorSpace;
woodMap.wrapS = woodMap.wrapT = THREE.RepeatWrapping;
woodMap.repeat.set(1.6, 1);
const tableTop = new THREE.Mesh(
  new THREE.BoxGeometry(1200, 26, 680),
  new THREE.MeshStandardMaterial({ map: woodMap, roughness: 0.72 })
);
tableTop.position.y = -13; // Oberkante = y 0
tableTop.receiveShadow = true;
const sillTop = new THREE.Mesh(
  new THREE.BoxGeometry(1200, 26, 320),
  new THREE.MeshStandardMaterial({ color: 0xf2ede3, roughness: 0.5 })
);
sillTop.position.set(0, -13, -40);
sillTop.receiveShadow = true;
const surfaces = { wood: tableTop, sill: sillTop };
scene.add(tableTop, sillTop);
tableTop.visible = sillTop.visible = false;

const envCache = {};
function loadEnv(name) {
  if (!envCache[name]) {
    envCache[name] = new Promise((resolve, reject) =>
      new RGBELoader().load(`env/${name}_1k.hdr`, (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        resolve(tex);
      }, undefined, reject));
  }
  return envCache[name];
}

async function applyScene(key) {
  currentScene = key;
  const cfg = SCENES[key];
  propsGroup.visible = cfg.props;
  keyLight.intensity = cfg.keyI;
  keyLight.color.set(cfg.keyColor || 0xfff2e0);
  for (const [name, mesh] of Object.entries(surfaces)) mesh.visible = cfg.surface === name;
  ground.visible = !cfg.surface;
  material.envMapIntensity = cfg.envI ?? 1;
  $$('.scene-chip').forEach((c) => c.classList.toggle('active', c.dataset.scene === key));
  if (cfg.hdri) {
    const tex = await loadEnv(cfg.hdri);
    if (currentScene !== key) return; // inzwischen umgeschaltet
    scene.environment = tex;
    scene.background = tex;
    scene.backgroundBlurriness = cfg.blur;
    scene.backgroundIntensity = cfg.bgI;
    hemi.intensity = 0.15;
  } else {
    scene.environment = roomEnv; // neutrale Reflexionen fürs Studio
    scene.background = null;
    hemi.intensity = cfg.hemi * 0.7;
  }
  if (!userInteracted) frameCamera();
}

function updateProps() {
  while (propsGroup.children.length) {
    const c = propsGroup.children.pop();
    c.traverse?.((o) => o.geometry?.dispose());
    propsGroup.remove(c);
  }
  if (!currentInfo) return;
  const lift = saucerLift();
  if (currentInfo.product === 'eierbecher') {
    const egg = makeEgg();
    egg.position.y = currentInfo.height + 8 + lift;
    propsGroup.add(egg);
  } else {
    propsGroup.add(makeGrass(currentInfo.openingDiameter / 2, currentInfo.height));
  }
}

// Kamera so setzen, dass das Objekt in Höhe UND Breite passt (auch mobil)
function frameCamera() {
  const H = currentInfo ? currentInfo.height : 58;
  let rM = currentInfo ? currentInfo.maxRadius : 24;
  if (saucerInfo && state.saucer) rM = Math.max(rM, saucerInfo.outerRadius * 0.82);
  // Ei ragt über den Becher hinaus, wenn Deko-Props sichtbar sind
  const eggExtra = (propsGroup.visible && currentInfo?.product === 'eierbecher') ? 40 : 0;
  // Mobile: mehr Luft oben/unten, damit Badges & Chips das Modell nicht verdecken
  const halfH = (H * 0.62 + 8 + eggExtra) * (IS_SMALL ? 1.22 : 1), halfW = rM * 1.65;
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = Math.max(halfH / t, halfW / (t * camera.aspect));
  controls.target.set(0, H * 0.5, 0);
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1) dir.set(0.55, 0.35, 1);
  dir.normalize();
  camera.position.copy(controls.target).addScaledVector(dir, dist);
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!userInteracted) frameCamera();
  }
}
new ResizeObserver(resize).observe(canvas);

function animate() {
  requestAnimationFrame(animate);
  resize();
  if (!userInteracted && cupMesh) cupGroup.rotation.y += 0.004;
  controls.update();
  renderer.render(scene, camera);
}

const cupGroup = new THREE.Group();
scene.add(cupGroup);

// ---------------------------------------------------------------------------
// Modell (neu) bauen
// ---------------------------------------------------------------------------
function activePoints() {
  if (state.preset === 'eigene') return customByProduct[state.product];
  return PRODUCTS[state.product].presets[state.preset].points;
}

// Druckbarkeits-Ampel: analysiert die echten Flächennormalen des Meshes
// (Überhangwinkel: 0° = senkrechte Wand, 90° = horizontale Unterseite)
function overhangStats(geometry) {
  const pos = geometry.getAttribute('position').array;
  const idx = geometry.index.array;
  let worst = 0, total = 0, over55 = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const cy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    total += len;
    if (cy < 0.4) continue; // Bodenfläche liegt auf dem Druckbett
    const nyN = ny / len;
    if (nyN < -1e-6) {
      const al = Math.asin(Math.min(1, -nyN)) * 180 / Math.PI;
      if (al > worst) worst = al;
      if (al > 55) over55 += len;
    }
  }
  return { worst, frac55: total ? over55 / total : 0 };
}

// Silhouetten-Überhang: max. Auskrag-Winkel der glatten Außenkontur (analytisch).
// Das ist beim FDM-Druck das harte Kriterium — Mustertiefen ≤ 1,6 mm sind dagegen
// selbsttragende Mikro-Features (Faustregel: < 2 mm horizontale Ausdehnung).
function silhouetteOverhang(info) {
  let worst = 0;
  const N = 160;
  let prev = info.radiusAt(0);
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    const r = info.radiusAt(t);
    const drdy = (r - prev) / (info.height / N);
    if (drdy > 0) worst = Math.max(worst, Math.atan(drdy) * 180 / Math.PI);
    prev = r;
  }
  return worst;
}

function updatePrintBadge(geometry, info) {
  const el = $('#print-badge');
  const sil = silhouetteOverhang(info);
  const { worst, frac55 } = overhangStats(geometry);
  let cls, txt, tip;
  if (sil > 62) {
    cls = 'p-bad'; txt = '🔶 Form kragt stark aus — Silhouette flacher ziehen';
    tip = `Die Grundform hängt bis ${sil.toFixed(0)}° über — im Formen-Editor sanftere Übergänge wählen.`;
  } else if (sil > 50) {
    cls = 'p-warn'; txt = '⚠️ Ausladende Form — wir drucken mit extra Kühlung';
    tip = `Silhouette bis ${sil.toFixed(0)}° Auskragung — druckt mit feinen Schichten sauber.`;
  } else if (state.depth > 2.5 && worst > 65 && frac55 > 0.08) {
    cls = 'p-bad'; txt = '🔶 Tiefe Struktur zu schräg — Drall reduzieren';
    tip = `Bei ${state.depth.toFixed(1)} mm Mustertiefe sind ${worst.toFixed(0)}°-Flanken echte Überhänge.`;
  } else if (worst > 75 && frac55 > 0.15) {
    cls = 'p-warn'; txt = '⚠️ Markante Struktur — druckt mit extra Kühlung';
    tip = 'Steile Muster-Flanken (selbsttragende Mikro-Struktur) — feine Schichten empfohlen.';
  } else {
    cls = 'p-ok'; txt = '✅ Druckbar ohne Stützen';
    tip = `Silhouette max. ${sil.toFixed(0)}° — problemlos.`;
  }
  el.className = 'stage-print ' + cls;
  // Mobile: Kurzform, Langtext als Tooltip
  const short = { 'p-ok': '✅ Druckbar', 'p-warn': '⚠️ Steil', 'p-bad': '🔶 Zu steil' }[cls];
  el.textContent = IS_SMALL ? short : txt;
  el.title = IS_SMALL ? `${txt} — ${tip}` : tip;
}

let saucerMesh = null;
let saucerInfo = null;
function saucerLift() {
  return (state.product === 'eierbecher' && state.saucer && saucerInfo) ? saucerInfo.seatHeight : 0;
}

function rebuild() {
  const { geometry, info } = buildModel({ ...state, customPoints: customByProduct[state.product] });
  currentInfo = info;
  if (!cupMesh) {
    cupMesh = new THREE.Mesh(geometry, material);
    cupMesh.castShadow = true;
    cupMesh.receiveShadow = true;
    cupGroup.add(cupMesh);
  } else {
    cupMesh.geometry.dispose();
    cupMesh.geometry = geometry;
  }
  // Untersetzer (nur Eierbecher)
  if (saucerMesh) {
    cupGroup.remove(saucerMesh);
    saucerMesh.geometry.dispose();
    saucerMesh = null; saucerInfo = null;
  }
  if (state.product === 'eierbecher' && state.saucer) {
    const s = buildSaucer({ ...state, customPoints: customByProduct[state.product] });
    saucerInfo = s.info;
    saucerMesh = new THREE.Mesh(s.geometry, material);
    saucerMesh.castShadow = true;
    saucerMesh.receiveShadow = true;
    cupGroup.add(saucerMesh);
  }
  cupMesh.position.y = saucerLift();
  updatePrintBadge(geometry, info);
  rebuildText();
  updateProps();
  if (!userInteracted) frameCamera();
  const dimLong = info.product === 'vase'
    ? `${info.height} mm hoch · Ø ${info.topDiameter.toFixed(0)} mm · Öffnung Ø ${info.openingDiameter.toFixed(0)} mm`
    : `${info.height} mm hoch · Ø ${info.topDiameter.toFixed(0)} mm · Mulde Ø ${info.cavityDiameter.toFixed(0)} mm`
      + (state.saucer ? ` · Untersetzer Ø ${(saucerInfo.outerRadius * 2).toFixed(0)} mm` : '');
  $('#dim-info').textContent = IS_SMALL ? `${info.height} × Ø ${info.topDiameter.toFixed(0)} mm` : dimLong;
  $('#dim-info').title = dimLong;
}

let textBuildId = 0;
async function rebuildText() {
  const myId = ++textBuildId;
  if (textMesh) {
    cupGroup.remove(textMesh);
    textMesh.geometry.dispose();
    textMesh = null;
  }
  const txt = state.text.trim();
  $('#text-warn').textContent = '';
  if (!txt || !currentInfo) return;

  let font;
  try {
    font = await loadFont(state.font);
  } catch {
    $('#text-warn').textContent = 'Schrift konnte nicht geladen werden.';
    return;
  }
  if (myId !== textBuildId) return; // inzwischen neuer Aufruf

  const depth = currentInfo.ampAt(state.textPos) + 2.0;
  let size = state.textSize;
  let geo, result;
  for (let attempt = 0; attempt < 6; attempt++) {
    geo = new TextGeometry(txt, { font, size, height: depth, curveSegments: 6, bevelEnabled: false });
    result = bendTextOntoCup(geo, currentInfo, state.textPos);
    if (result.arc <= maxTextArc()) break;
    geo.dispose();
    size *= 0.88;
  }
  if (result.arc > maxTextArc()) {
    $('#text-warn').textContent = 'Text zu lang — bitte kürzen.';
    geo.dispose();
    return;
  }
  if (size < state.textSize - 0.01) {
    $('#text-warn').textContent = `Text automatisch auf ${size.toFixed(1)} mm verkleinert.`;
  }
  textMesh = new THREE.Mesh(geo, material);
  textMesh.castShadow = true;
  textMesh.position.y = saucerLift();
  cupGroup.add(textMesh);
}

const debounce = (fn, ms) => {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
const rebuildSoon = debounce(rebuild, 60);
const rebuildTextSoon = debounce(rebuildText, 120);

// ---------------------------------------------------------------------------
// Silhouetten (SVG) für Preset-Buttons & Formen-Editor
// ---------------------------------------------------------------------------
function silhouettePath(points, w, h, pad = 3) {
  const prof = sampleProfile(points, 26);
  const cx = w / 2;
  const sx = (w / 2 - pad) / 1.08;
  const ys = (t) => h - pad - t * (h - 2 * pad);
  let d = '';
  prof.forEach(([t, r], i) => {
    d += (i ? 'L' : 'M') + (cx + r * sx).toFixed(1) + ' ' + ys(t).toFixed(1) + ' ';
  });
  for (let i = prof.length - 1; i >= 0; i--) {
    d += 'L' + (cx - prof[i][1] * sx).toFixed(1) + ' ' + ys(prof[i][0]).toFixed(1) + ' ';
  }
  return d + 'Z';
}

function renderPresetButtons() {
  const product = PRODUCTS[state.product];
  const entries = Object.entries(product.presets);
  $('#preset-row').innerHTML = entries.map(([id, pr]) => `
    <button class="preset-btn" data-preset="${id}">
      <svg viewBox="0 0 40 52"><path d="${silhouettePath(pr.points, 40, 52)}"
        fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
      ${pr.label}</button>`).join('') + `
    <button class="preset-btn" data-preset="eigene">
      <svg viewBox="0 0 40 52"><path d="M20 6 L30 16 L14 44 L8 46 L10 38 Z" fill="currentColor" fill-opacity="0.16"
        stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
      Eigene</button>`;
  $$('.preset-btn').forEach((b) => b.addEventListener('click', () => selectPreset(b.dataset.preset)));
  markActivePreset();
}

function markActivePreset() {
  $$('.preset-btn').forEach((x) => x.classList.toggle('active', x.dataset.preset === state.preset));
  $('#shape-editor').hidden = state.preset !== 'eigene';
}

function selectPreset(id) {
  if (id === 'eigene') {
    if (!customByProduct[state.product]) {
      // Startform: aktuell gewähltes Preset an den Editor-Stationen abtasten
      const src = PRODUCTS[state.product].presets[lastRealPreset[state.product]].points;
      const prof = sampleProfile(src, 100);
      customByProduct[state.product] = EDITOR_T.map((t) => [t, prof[Math.round(t * 100)][1]]);
    }
  } else {
    lastRealPreset[state.product] = id;
  }
  state.preset = id;
  markActivePreset();
  if (id === 'eigene') renderShapeEditor();
  rebuild();
}

// --- Formen-Editor: Punkte horizontal ziehen -------------------------------
const ED = { w: 150, h: 200, pad: 12 };
function edX(r) { return ED.w / 2 + r * ((ED.w / 2 - ED.pad) / 1.08); }
function edY(t) { return ED.h - ED.pad - t * (ED.h - 2 * ED.pad); }

function renderShapeEditor() {
  const pts = customByProduct[state.product];
  const svg = $('#profile-svg');
  svg.innerHTML = `
    <path d="${silhouettePath(pts, ED.w, ED.h, ED.pad)}" class="ed-body"/>
    <line x1="${ED.w / 2}" y1="${ED.pad - 6}" x2="${ED.w / 2}" y2="${ED.h - ED.pad + 6}" class="ed-axis"/>
    ${pts.map(([t, r], i) => `
      <line x1="${ED.w / 2}" y1="${edY(t)}" x2="${edX(r)}" y2="${edY(t)}" class="ed-guide"/>
      <circle cx="${edX(r)}" cy="${edY(t)}" r="7" class="ed-handle" data-i="${i}"/>`).join('')}
  `;
  svg.querySelectorAll('.ed-handle').forEach((c) => {
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const i = parseInt(c.dataset.i, 10);
      const rect = svg.getBoundingClientRect();
      const scale = ED.w / rect.width;
      const move = (ev) => {
        const x = (ev.clientX - rect.left) * scale;
        const r = Math.min(1.08, Math.max(0.12, Math.abs(x - ED.w / 2) / ((ED.w / 2 - ED.pad) / 1.08)));
        customByProduct[state.product][i][1] = Math.round(r * 100) / 100;
        renderShapeEditor();
        rebuildSoon();
      };
      const up = () => {
        svg.removeEventListener('pointermove', move);
        svg.removeEventListener('pointerup', up);
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
    });
  });
}

// ---------------------------------------------------------------------------
// Produkt-Wechsel
// ---------------------------------------------------------------------------
function renderProductTabs() {
  $('#product-tabs').innerHTML = Object.entries(PRODUCTS).map(([id, pr]) => `
    <button class="product-tab" data-product="${id}">
      <span class="pt-icon">${pr.icon}</span>${pr.label}
      <small>ab ${fmt(getPricing().products[id].single)}</small>
    </button>`).join('');
  $$('.product-tab').forEach((b) => b.addEventListener('click', () => setProduct(b.dataset.product)));
  markActiveProduct();
}

function markActiveProduct() {
  $$('.product-tab').forEach((x) => x.classList.toggle('active', x.dataset.product === state.product));
}

function setProduct(id) {
  if (state.product === id) return;
  state.product = id;
  const product = PRODUCTS[id];
  state.preset = Object.keys(product.presets)[0];
  state.height = product.defaultHeight;
  const [hMin, hMax] = product.heightRange;
  const hs = $('#s-height');
  hs.min = hMin; hs.max = hMax; hs.value = state.height;
  $('#s-height-val').textContent = `${state.height} mm`;
  markActiveProduct();
  renderPresetButtons();
  renderPrices();
  $('#extras-section').style.display = id === 'eierbecher' ? '' : 'none';
  $('#vase-note').hidden = id !== 'vase'; // Trockenblumen-Hinweis nur bei Vasen
  updateMobileTabs(id);
  userInteracted = false; // neu einrahmen
  rebuild();
}

// ---------------------------------------------------------------------------
// UI-Bindings
// ---------------------------------------------------------------------------
function sliderFill(el) {
  const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--fill', pct + '%');
}

function bindSlider(id, key, fmt, cb) {
  const el = $(id);
  const out = $(id + '-val');
  const update = () => {
    state[key] = parseFloat(el.value);
    if (out) out.textContent = fmt(state[key]);
    sliderFill(el);
    cb();
  };
  el.addEventListener('input', update);
  update();
}

// Tiefe-Regler passt seinen Bereich dem Muster an (Lamellen dürfen richtig tief)
const DEPTH_RANGES = {
  lamellen: { min: 1.5, max: 6, step: 0.25, def: 4 },
  gehaemmert: { min: 0.3, max: 1.2, step: 0.1, def: 0.8 },
  default: { min: 0.2, max: 1.6, step: 0.1, def: 0.9 },
};
function applyDepthRange() {
  const r = DEPTH_RANGES[state.pattern] || DEPTH_RANGES.default;
  const el = $('#s-depth');
  el.min = r.min; el.max = r.max; el.step = r.step;
  if (state.depth < r.min || state.depth > r.max) {
    state.depth = r.def;
    el.value = r.def;
  }
  $('#s-depth-val').textContent = `${state.depth.toFixed(1)} mm`;
  sliderFill(el);
}

function renderFontRow() {
  $('#font-row').innerHTML = Object.entries(FONTS).map(([id, f]) => `
    <button class="font-chip font-${id}" data-font="${id}"><span>Aa</span><small>${f.label}</small></button>`).join('');
  $$('.font-chip').forEach((b) => b.addEventListener('click', () => {
    state.font = b.dataset.font;
    markActiveFont();
    rebuildTextSoon();
  }));
  markActiveFont();
}
function markActiveFont() {
  $$('.font-chip').forEach((x) => x.classList.toggle('active', x.dataset.font === state.font));
}

function initControls() {
  $$('.pattern-btn').forEach((b) => b.addEventListener('click', () => {
    state.pattern = b.dataset.pattern;
    $$('.pattern-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('#surface-sliders').classList.toggle('disabled', state.pattern === 'glatt');
    // Zickzack braucht ≥ 24 Facetten (sonst liest jede einzeln als Treppe)
    if (state.pattern === 'zickzack' && state.ribs < 24) {
      state.ribs = 24;
      $('#s-ribs').value = 24;
      $('#s-ribs-val').textContent = '24';
    }
    applyDepthRange();
    rebuild();
  }));

  const sizeChanged = () => { renderPrices(); rebuildSoon(); };
  bindSlider('#s-height', 'height', (v) => `${v} mm`, sizeChanged);
  bindSlider('#s-width', 'width', (v) => `${Math.round(v * 100)} %`, sizeChanged);
  bindSlider('#s-ribs', 'ribs', (v) => `${v}`, rebuildSoon);
  bindSlider('#s-depth', 'depth', (v) => `${v.toFixed(1)} mm`, rebuildSoon);
  bindSlider('#s-twist', 'twist', (v) => v === 0 ? 'gerade' : `${v > 0 ? '+' : ''}${Math.round(v * 180)}°`, rebuildSoon);
  bindSlider('#s-flowwaves', 'flowWaves', (v) => `${v}×`, rebuildSoon);

  // Verlaufsart (wie das Muster über die Höhe fließt)
  $$('.flow-btn').forEach((b) => b.addEventListener('click', () => {
    state.flow = b.dataset.flow;
    $$('.flow-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('#flowwaves-row').hidden = !(state.flow === 'fluss' || state.flow === 'zick');
    // Verlauf ohne Stärke ist unsichtbar → sanft eine Vorgabe setzen
    if (state.twist === 0 && state.flow !== 'spirale') {
      state.twist = 1;
      $('#s-twist').value = 1;
      $('#s-twist-val').textContent = '+180°';
    }
    rebuild();
  }));
  bindSlider('#s-textsize', 'textSize', (v) => `${v} mm`, rebuildTextSoon);
  bindSlider('#s-textpos', 'textPos', (v) => `${Math.round(v * 100)} %`, rebuildTextSoon);

  $('#i-text').addEventListener('input', (e) => {
    state.text = e.target.value.slice(0, 16);
    rebuildTextSoon();
  });

  $('#btn-random').addEventListener('click', () => {
    const presets = Object.keys(PRODUCTS[state.product].presets);
    const patterns = Object.keys(PATTERNS).filter((p) => p !== 'glatt');
    state.preset = presets[Math.floor(Math.random() * presets.length)];
    lastRealPreset[state.product] = state.preset;
    state.pattern = patterns[Math.floor(Math.random() * patterns.length)];
    state.ribs = 14 + Math.floor(Math.random() * 70);
    state.depth = 0.5 + Math.random() * 1.1;
    state.twist = Math.random() < 0.35 ? 0 : (Math.random() * 3 - 1.5);
    const flows = Object.keys(FLOWS);
    state.flow = flows[Math.floor(Math.random() * flows.length)];
    state.flowWaves = 2 + Math.floor(Math.random() * 4);
    const [hMin, hMax] = PRODUCTS[state.product].heightRange;
    state.height = hMin + Math.floor(Math.random() * (hMax - hMin));
    syncControls();
    const c = content.colors[Math.floor(Math.random() * content.colors.length)];
    setColor({ id: c.id, hex: c.hex, name: c.name });
    rebuild();
  });

  $('#btn-download').addEventListener('click', async () => {
    downloadSTL(await makeSTL(currentConfig()), stlFilename());
  });

  // In den Warenkorb (mit Live-Vorschaubild)
  $('#btn-order').addEventListener('click', () => {
    renderer.render(scene, camera);
    addToCart({
      config: currentConfig(),
      colorName: state.colorFinish && state.colorFinish !== 'matt'
        ? `${state.colorName} (${FINISH_LABEL[state.colorFinish]})` : state.colorName,
      colorHex: state.colorHex,
      thumb: captureThumb(),
    });
    bumpCart();
    if (IS_MOBILE) showToast('✓ Im Warenkorb — weiter gestalten oder zur Kasse');
  });

  // Szenen-Chips + Foto-Shooting
  $('#scene-chips').innerHTML = Object.entries(SCENES).map(([id, s]) =>
    `<button class="scene-chip" data-scene="${id}">${s.label}</button>`).join('');
  $$('.scene-chip').forEach((b) => b.addEventListener('click', () => applyScene(b.dataset.scene)));
  applyScene('studio');
  $('#btn-foto').addEventListener('click', fotoShooting);
  $('#foto-close').addEventListener('click', () => $('#foto-modal').close());

  // Gravur als aktivierbares Extra (Preis kommt aus dem Admin)
  $('#gravur-price').textContent = `+ ${fmt(getPricing().gravur ?? 3)}`;
  $('#c-gravur').addEventListener('change', (e) => {
    $('#gravur-options').hidden = !e.target.checked;
    if (!e.target.checked) {
      state.text = '';
      $('#i-text').value = '';
      rebuildText();
    } else {
      $('#i-text').focus();
    }
  });

  // Untersetzer
  $('#saucer-price').textContent = `+ ${fmt(getPricing().products.eierbecher.untersetzer)}`;
  $('#c-saucer').addEventListener('change', (e) => {
    state.saucer = e.target.checked;
    userInteracted = false; // neu einrahmen (Untersetzer ist breiter)
    rebuild();
  });

  $('#hero-cta').addEventListener('click', () => {
    $('#konfigurator').scrollIntoView({ behavior: 'smooth' });
  });

  // Hell/Dunkel-Modus
  const themeBtn = $('#theme-btn');
  const syncThemeBtn = () => {
    const dark = document.documentElement.classList.contains('dark');
    themeBtn.textContent = dark ? '☀️' : '🌙';
    // Browser-Chrome (Adressleiste/Statusbar) mitfärben
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#17130f' : '#f4efe7'));
  };
  themeBtn.addEventListener('click', () => {
    const dark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('ovju-theme', dark ? 'dark' : 'light');
    syncThemeBtn();
  });
  syncThemeBtn();
}

function syncControls() {
  markActivePreset();
  $$('.pattern-btn').forEach((x) => x.classList.toggle('active', x.dataset.pattern === state.pattern));
  $('#surface-sliders').classList.toggle('disabled', state.pattern === 'glatt');
  $('#s-height').value = state.height; $('#s-height-val').textContent = `${state.height} mm`;
  $('#s-ribs').value = state.ribs; $('#s-ribs-val').textContent = `${state.ribs}`;
  $('#s-depth').value = state.depth; $('#s-depth-val').textContent = `${state.depth.toFixed(1)} mm`;
  applyDepthRange();
  $('#s-twist').value = state.twist;
  $('#s-twist-val').textContent = state.twist === 0 ? 'gerade' : `${state.twist > 0 ? '+' : ''}${Math.round(state.twist * 180)}°`;
  $$('input[type=range]').forEach((el) => sliderFill(el));
  $$('.flow-btn').forEach((x) => x.classList.toggle('active', x.dataset.flow === state.flow));
  $('#flowwaves-row').hidden = !(state.flow === 'fluss' || state.flow === 'zick');
  $('#s-flowwaves').value = state.flowWaves;
  $('#s-flowwaves-val').textContent = `${state.flowWaves}×`;
}

function stlFilename() {
  const brand = content ? content.brand.name.toLowerCase() : 'ovju';
  return `${brand}-${state.product}-${state.preset}-${state.pattern}${state.text ? '-' + state.text.replace(/[^a-z0-9äöüß]/gi, '_') : ''}.stl`;
}

function currentConfig() {
  const { color, colorName, colorHex, quality, ...rest } = state;
  return {
    ...rest,
    saucer: state.product === 'eierbecher' && state.saucer, // Untersetzer gibt's nur beim Eierbecher
    customPoints: customByProduct[state.product],
  };
}

// Quadratisches Vorschaubild aus dem aktuellen Canvas (für den Warenkorb)
function captureThumb() {
  const src = renderer.domElement;
  const c = document.createElement('canvas');
  c.width = c.height = 260;
  const m = Math.min(src.width, src.height);
  const ctx = c.getContext('2d');
  // Canvas ist transparent → für JPEG erst den Studio-Hintergrund füllen
  ctx.fillStyle = document.documentElement.classList.contains('dark') ? '#231d17' : '#efe7d9';
  ctx.fillRect(0, 0, 260, 260);
  ctx.drawImage(src, (src.width - m) / 2, (src.height - m) / 2, m, m, 0, 0, 260, 260);
  return c.toDataURL('image/jpeg', 0.82);
}

// ---------------------------------------------------------------------------
// Foto-Shooting & Produkt-Showcase (Renderer offscreen wiederverwenden)
// ---------------------------------------------------------------------------
function placeCamera(zoom, dir = [0.55, 0.32, 1]) {
  const H = currentInfo ? currentInfo.height : 58;
  frameCamera();
  const d = new THREE.Vector3(...dir).normalize();
  const dist = camera.position.distanceTo(controls.target) * zoom;
  camera.position.copy(controls.target).addScaledVector(d, dist);
  camera.lookAt(controls.target);
}

function shotSetup(w, h) {
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

async function shotRestore(saved) {
  await applyScene(saved.scene);
  cupGroup.rotation.y = saved.rot;
  camera.position.copy(saved.pos);
  controls.target.copy(saved.tgt);
  camera.aspect = saved.aspect;
  camera.updateProjectionMatrix();
  canvas.width = 0; // erzwingt Restore der Canvas-Größe im nächsten Frame
  resize();
}

function saveView() {
  return {
    scene: currentScene, rot: cupGroup.rotation.y, aspect: camera.aspect,
    pos: camera.position.clone(), tgt: controls.target.clone(),
  };
}

async function fotoShooting() {
  const btn = $('#btn-foto');
  btn.disabled = true;
  const saved = saveView();
  const shots = [];
  const setups = [
    { scene: 'esstisch', angle: 0.45, zoom: 1.0, name: 'esstisch' },
    { scene: 'fenster', angle: -0.35, zoom: 0.9, name: 'fensterbrett' },
    { scene: 'cafe', angle: -0.55, zoom: 0.78, name: 'cafe' },
    { scene: 'abend', angle: 0.25, zoom: 0.85, name: 'abend' },
    { scene: 'studio', angle: 0.6, zoom: 0.95, name: 'studio' },
  ];
  shotSetup(1200, 900);
  for (const s of setups) {
    await applyScene(s.scene);
    cupGroup.rotation.y = s.angle;
    placeCamera(s.zoom);
    renderer.render(scene, camera);
    shots.push({ url: renderer.domElement.toDataURL('image/png'), name: s.name });
    await new Promise((r) => setTimeout(r, 30));
  }
  await shotRestore(saved);
  $('#foto-grid').innerHTML = shots.map((s) => `
    <a href="${s.url}" download="ovju-${state.product}-${s.name}.png"><img src="${s.url}" alt="Szene ${s.name}"></a>`).join('');
  $('#foto-modal').showModal();
  btn.disabled = false;
}

async function productShot(params, hex, extraProp) {
  const { geometry, info } = buildModel({ ...DEFAULTS, ...params, quality: 0.75 });
  const g = new THREE.Group();
  const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: hex, roughness: 0.62 }));
  m.castShadow = true;
  g.add(m);
  if (extraProp === 'egg') {
    const egg = makeEgg();
    egg.position.y = info.height + 8;
    g.add(egg);
  } else if (extraProp === 'grass') {
    g.add(makeGrass(info.openingDiameter / 2, info.height));
  }
  g.rotation.y = 0.5;
  const saved = saveView();
  const savedInfo = currentInfo;
  cupGroup.visible = false;
  scene.add(g);
  await applyScene(extraProp === 'egg' ? 'esstisch' : 'fenster');
  propsGroup.visible = false;
  currentInfo = info;
  shotSetup(880, 1050);
  placeCamera(extraProp === 'egg' ? 1.55 : 1.12, [0.5, 0.34, 1]);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/jpeg', 0.9);
  scene.remove(g);
  geometry.dispose();
  cupGroup.visible = true;
  currentInfo = savedInfo;
  await shotRestore(saved);
  return url;
}

// Galerie & Produktfotos (im Admin unter 🖼️ Bilder gepflegt)
let galleryPhotos = [];
async function loadGallery() {
  try { galleryPhotos = await (await fetch('/api/gallery')).json(); } catch { galleryPhotos = []; }
  const galerie = galleryPhotos.filter((g) => g.cat === 'galerie');
  // Produktfotos ergänzen, bis das Grid gut gefüllt ist
  const rest = galleryPhotos.filter((g) => g.cat !== 'galerie').sort((a, b) => (a.cat === 'vase' ? -1 : 1) - (b.cat === 'vase' ? -1 : 1));
  const items = [...galerie, ...(galerie.length < 4 ? rest : [])];
  // Hero-Foto: das Eierbecher-Produktfoto (oder erstes Galerie-Bild)
  const heroPic = galleryPhotos.find((g) => g.cat === 'vase') || galleryPhotos.find((g) => g.cat === 'eierbecher') || galleryPhotos[0];
  if (heroPic) {
    $('#hero-photo-img').src = heroPic.file;
    $('#hero-photo').hidden = false;
    $('#hero-grid').classList.add('has-photo');
  }
  if (!items.length) return;
  $('#galerie').hidden = false;
  $('#galerie-grid').innerHTML = items.slice(0, 8).map((g, i) => `
    <figure class="galerie-item ${i === 0 ? 'big' : ''}"><img src="${g.file}" loading="lazy" alt="OVJU Produktfoto"></figure>`).join('');
}

async function renderShowcase() {
  const sc = content.showcase;
  if (!sc) return;
  $('#showcase-title').textContent = sc.title;
  $('#showcase-sub').textContent = sc.sub;
  const defs = [
    {
      id: 'vase', c: sc.vase, hex: '#9caf88', extra: 'grass',
      params: { product: 'vase', preset: 'flasche', pattern: 'rippen', ribs: 72, depth: 0.9, height: 150 },
      price: getPricing().products.vase.single,
    },
    {
      id: 'eierbecher', c: sc.eierbecher, hex: '#c86f4a', extra: 'egg',
      params: { product: 'eierbecher', preset: 'kelch', pattern: 'rippen', ribs: 48, depth: 0.9, height: 58 },
      price: getPricing().products.eierbecher.single,
    },
  ];
  // Echte Produktfotos (Admin-Upload) bevorzugen, Engine-Render als Fallback
  for (const d of defs) {
    const photo = galleryPhotos.find((g) => g.cat === d.id);
    d.img = photo ? photo.file : await productShot(d.params, d.hex, d.extra);
  }
  $('#showcase').innerHTML = defs.map((d) => `
    <div class="showcase-card" data-product="${d.id}">
      <img src="${d.img}" alt="${d.c.title}">
      <div class="showcase-body">
        <h3>${d.c.title}</h3>
        <p>${d.c.text}</p>
        <div class="showcase-cta"><span class="showcase-price">ab ${fmt(d.price)}</span>
        <button class="btn btn-primary">${d.c.cta}</button></div>
      </div>
    </div>`).join('');
  $$('.showcase-card').forEach((card) => card.addEventListener('click', () => {
    setProduct(card.dataset.product);
    $('#konfigurator').scrollIntoView({ behavior: 'smooth' });
  }));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async () => {
  await loadContent();
  await initCart();
  await initAuth();
  renderProductTabs();
  renderPresetButtons();
  renderFontRow();
  renderPrices();
  initControls();
  loadFont(state.font); // Standardschrift vorwärmen
  // Startprodukt über setProduct() initialisieren (Slider-Bereiche, Tabs, Hinweise, Preise)
  state.product = START_PRODUCT === 'vase' ? 'eierbecher' : 'vase';
  setProduct(START_PRODUCT);
  animate();
  $('#loading').classList.add('hidden');
  await loadGallery();
  setTimeout(renderShowcase, 400); // Showcase: echte Fotos, sonst Engine-Renders
  initMobileShell({ product: state.product });

  // Steuer-Hook für automatisierte Tests/Renders (kein UI-Feature)
  window.__ovju = {
    apply(cfg) {
      if (cfg.product && cfg.product !== state.product) setProduct(cfg.product);
      Object.assign(state, cfg);
      syncControls();
      userInteracted = true; // Auto-Rotation stoppen für reproduzierbare Shots
      cupGroup.rotation.y = cfg.viewAngle ?? 0.5;
      rebuild();
      frameCamera();
    },
  };
})();
