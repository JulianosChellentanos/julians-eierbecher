// OVJU — Konfigurator: 3D-Szene, UI-Bindings, Bestellung (Eierbecher & Vasen)
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { FontLoader } from '../vendor/FontLoader.js';
import { TextGeometry } from '../vendor/TextGeometry.js';
import {
  buildModel, buildSaucer, bendTextOntoCup, maxTextArc, sampleProfile,
  DEFAULTS, PRODUCTS, PATTERNS, FONTS,
} from './geometry.js';
import { exportSTL, downloadSTL, bufferToBase64 } from './exporter.js';
import { woodTexture, wallTexture, makeEgg, makeGrass } from './scenes.js';

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
let content = null;
let cupMesh = null;
let textMesh = null;
let currentInfo = null;
let userInteracted = false;

const fontCache = {};
function loadFont(key) {
  if (fontCache[key]) return fontCache[key];
  fontCache[key] = new Promise((resolve, reject) =>
    new FontLoader().load(`fonts/${FONTS[key].file}`, resolve, undefined, reject));
  return fontCache[key];
}

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

  $('#swatches').innerHTML = content.colors.map((c) => `
    <button class="swatch" data-id="${c.id}" data-hex="${c.hex}" data-name="${c.name}"
      style="--sw:${c.hex}" title="${c.name}"><span></span></button>`).join('');
  $$('.swatch').forEach((b) => b.addEventListener('click', () => setColor(b.dataset)));
  setColor({ id: content.colors[0].id, hex: content.colors[0].hex, name: content.colors[0].name });
}

function money(v) {
  return v.toLocaleString('de-DE', { style: 'currency', currency: content.pricing.currency });
}

function productPricing() {
  return content.pricing[state.product];
}

function renderPrices() {
  const pp = productPricing();
  $('#price').textContent = money(pp.single);
  $('#price-hint').textContent = pp.family4
    ? `Duo ${money(pp.duo)} · 4er-Set ${money(pp.family4)}`
    : `Duo ${money(pp.duo)}`;
}

function setColor({ id, hex, name }) {
  state.color = id; state.colorHex = hex; state.colorName = name;
  $$('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  $('#color-name').textContent = name;
  material.color.set(hex);
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

const material = new THREE.MeshStandardMaterial({ color: state.colorHex, roughness: 0.62, metalness: 0.0 });

// ---------------------------------------------------------------------------
// Szenen: Studio / Frühstückstisch / Abendlicht (alles prozedural)
// ---------------------------------------------------------------------------
const SCENES = {
  studio: { label: 'Studio', room: false, props: false, hemi: 0.9, keyI: 1.6, keyColor: 0xfff2e0 },
  tisch: { label: 'Tisch', room: true, props: true, hemi: 0.95, keyI: 1.45, keyColor: 0xfff2e0, wallTop: '#eee3d2', wallBot: '#d8c8b0' },
  abend: { label: 'Abend', room: true, props: true, hemi: 0.42, keyI: 2.0, keyColor: 0xffd3a0, wallTop: '#59514a', wallBot: '#332e2a' },
};
let currentScene = 'studio';
const wallTexCache = {};

const roomGroup = new THREE.Group();
const woodFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(1400, 1400).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.85 })
);
woodFloor.material.map.wrapS = woodFloor.material.map.wrapT = THREE.RepeatWrapping;
woodFloor.material.map.repeat.set(2.6, 2.6);
woodFloor.receiveShadow = true;
const backWall = new THREE.Mesh(
  new THREE.PlaneGeometry(2400, 1300),
  new THREE.MeshStandardMaterial({ roughness: 1 })
);
backWall.position.set(0, 620, -430);
roomGroup.add(woodFloor, backWall);
roomGroup.visible = false;
scene.add(roomGroup);

const propsGroup = new THREE.Group();
propsGroup.visible = false;
scene.add(propsGroup);

function applyScene(key) {
  currentScene = key;
  const cfg = SCENES[key];
  roomGroup.visible = cfg.room;
  ground.visible = !cfg.room;
  propsGroup.visible = cfg.props;
  hemi.intensity = cfg.hemi;
  keyLight.intensity = cfg.keyI;
  keyLight.color.set(cfg.keyColor);
  if (cfg.room) {
    if (!wallTexCache[key]) wallTexCache[key] = wallTexture(cfg.wallTop, cfg.wallBot);
    backWall.material.map = wallTexCache[key];
    backWall.material.needsUpdate = true;
    controls.minAzimuthAngle = -1.05;
    controls.maxAzimuthAngle = 1.05;
  } else {
    controls.minAzimuthAngle = -Infinity;
    controls.maxAzimuthAngle = Infinity;
  }
  $$('.scene-chip').forEach((c) => c.classList.toggle('active', c.dataset.scene === key));
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
  const halfH = H * 0.62 + 8 + eggExtra, halfW = rM * 1.65;
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
  rebuildText();
  updateProps();
  if (!userInteracted) frameCamera();
  $('#dim-info').textContent = info.product === 'vase'
    ? `${info.height} mm hoch · Ø ${info.topDiameter.toFixed(0)} mm · Öffnung Ø ${info.openingDiameter.toFixed(0)} mm`
    : `${info.height} mm hoch · Ø ${info.topDiameter.toFixed(0)} mm · Mulde Ø ${info.cavityDiameter.toFixed(0)} mm`
      + (state.saucer ? ` · Untersetzer Ø ${(saucerInfo.outerRadius * 2).toFixed(0)} mm` : '');
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
      <small>ab ${money(content.pricing[id].single)}</small>
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
  userInteracted = false; // neu einrahmen
  rebuild();
}

// ---------------------------------------------------------------------------
// UI-Bindings
// ---------------------------------------------------------------------------
function bindSlider(id, key, fmt, cb) {
  const el = $(id);
  const out = $(id + '-val');
  const update = () => {
    state[key] = parseFloat(el.value);
    if (out) out.textContent = fmt(state[key]);
    cb();
  };
  el.addEventListener('input', update);
  update();
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
    rebuild();
  }));

  bindSlider('#s-height', 'height', (v) => `${v} mm`, rebuildSoon);
  bindSlider('#s-width', 'width', (v) => `${Math.round(v * 100)} %`, rebuildSoon);
  bindSlider('#s-ribs', 'ribs', (v) => `${v}`, rebuildSoon);
  bindSlider('#s-depth', 'depth', (v) => `${v.toFixed(1)} mm`, rebuildSoon);
  bindSlider('#s-twist', 'twist', (v) => v === 0 ? 'gerade' : `${v > 0 ? '+' : ''}${Math.round(v * 180)}°`, rebuildSoon);
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
    const [hMin, hMax] = PRODUCTS[state.product].heightRange;
    state.height = hMin + Math.floor(Math.random() * (hMax - hMin));
    syncControls();
    const c = content.colors[Math.floor(Math.random() * content.colors.length)];
    setColor({ id: c.id, hex: c.hex, name: c.name });
    rebuild();
  });

  $('#btn-download').addEventListener('click', () => {
    downloadSTL(exportCurrentSTL(), stlFilename());
  });

  // Szenen-Chips + Foto-Shooting
  $('#scene-chips').innerHTML = Object.entries(SCENES).map(([id, s]) =>
    `<button class="scene-chip" data-scene="${id}">${s.label}</button>`).join('');
  $$('.scene-chip').forEach((b) => b.addEventListener('click', () => applyScene(b.dataset.scene)));
  applyScene('studio');
  $('#btn-foto').addEventListener('click', fotoShooting);
  $('#foto-close').addEventListener('click', () => $('#foto-modal').close());

  // Untersetzer
  $('#saucer-price').textContent = `+ ${money(content.pricing.eierbecher.untersetzer)}`;
  $('#c-saucer').addEventListener('change', (e) => {
    state.saucer = e.target.checked;
    userInteracted = false; // neu einrahmen (Untersetzer ist breiter)
    rebuild();
  });

  $('#hero-cta').addEventListener('click', () => {
    $('#konfigurator').scrollIntoView({ behavior: 'smooth' });
  });

  initOrderModal();
}

function syncControls() {
  markActivePreset();
  $$('.pattern-btn').forEach((x) => x.classList.toggle('active', x.dataset.pattern === state.pattern));
  $('#surface-sliders').classList.toggle('disabled', state.pattern === 'glatt');
  $('#s-height').value = state.height; $('#s-height-val').textContent = `${state.height} mm`;
  $('#s-ribs').value = state.ribs; $('#s-ribs-val').textContent = `${state.ribs}`;
  $('#s-depth').value = state.depth; $('#s-depth-val').textContent = `${state.depth.toFixed(1)} mm`;
  $('#s-twist').value = state.twist;
  $('#s-twist-val').textContent = state.twist === 0 ? 'gerade' : `${state.twist > 0 ? '+' : ''}${Math.round(state.twist * 180)}°`;
}

function stlFilename() {
  const brand = content ? content.brand.name.toLowerCase() : 'ovju';
  return `${brand}-${state.product}-${state.preset}-${state.pattern}${state.text ? '-' + state.text.replace(/[^a-z0-9äöüß]/gi, '_') : ''}.stl`;
}

function exportCurrentSTL() {
  // Für den Export in voller Auflösung frisch bauen (Preview ist ggf. reduziert)
  const { geometry, info } = buildModel({ ...state, quality: 1, customPoints: customByProduct[state.product] });
  const meshes = [new THREE.Mesh(geometry)];
  if (textMesh) meshes.push(new THREE.Mesh(textMesh.geometry)); // Becher liegt beim Druck auf y=0
  const extra = [];
  if (state.product === 'eierbecher' && state.saucer) {
    const s = buildSaucer({ ...state, quality: 1, customPoints: customByProduct[state.product] });
    const sm = new THREE.Mesh(s.geometry);
    sm.position.x = s.info.outerRadius + info.baseDiameter / 2 + 6; // nebeneinander aufs Druckbett
    meshes.push(sm);
    extra.push(s.geometry);
  }
  const buf = exportSTL(meshes);
  geometry.dispose();
  extra.forEach((g) => g.dispose());
  return buf;
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

function shotRestore(saved) {
  applyScene(saved.scene);
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
    { scene: 'tisch', angle: 0.45, zoom: 1.0, name: 'tisch' },
    { scene: 'tisch', angle: -0.55, zoom: 0.78, name: 'nah' },
    { scene: 'abend', angle: 0.25, zoom: 0.85, name: 'abend' },
    { scene: 'studio', angle: 0.6, zoom: 0.95, name: 'studio' },
  ];
  shotSetup(1200, 900);
  for (const s of setups) {
    applyScene(s.scene);
    cupGroup.rotation.y = s.angle;
    placeCamera(s.zoom);
    renderer.render(scene, camera);
    shots.push({ url: renderer.domElement.toDataURL('image/png'), name: s.name });
    await new Promise((r) => setTimeout(r, 30));
  }
  shotRestore(saved);
  $('#foto-grid').innerHTML = shots.map((s) => `
    <a href="${s.url}" download="ovju-${state.product}-${s.name}.png"><img src="${s.url}" alt="Szene ${s.name}"></a>`).join('');
  $('#foto-modal').showModal();
  btn.disabled = false;
}

function productShot(params, hex, extraProp) {
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
  applyScene('tisch');
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
  shotRestore(saved);
  return url;
}

function renderShowcase() {
  const sc = content.showcase;
  if (!sc) return;
  $('#showcase-title').textContent = sc.title;
  $('#showcase-sub').textContent = sc.sub;
  const defs = [
    {
      id: 'eierbecher', c: sc.eierbecher, hex: '#c86f4a', extra: 'egg',
      params: { product: 'eierbecher', preset: 'kelch', pattern: 'rippen', ribs: 48, depth: 0.9, height: 58 },
      price: content.pricing.eierbecher.single,
    },
    {
      id: 'vase', c: sc.vase, hex: '#9caf88', extra: 'grass',
      params: { product: 'vase', preset: 'flasche', pattern: 'rippen', ribs: 72, depth: 0.9, height: 150 },
      price: content.pricing.vase.single,
    },
  ];
  $('#showcase').innerHTML = defs.map((d) => `
    <div class="showcase-card" data-product="${d.id}">
      <img src="${productShot(d.params, d.hex, d.extra)}" alt="${d.c.title}">
      <div class="showcase-body">
        <h3>${d.c.title}</h3>
        <p>${d.c.text}</p>
        <div class="showcase-cta"><span class="showcase-price">ab ${money(d.price)}</span>
        <button class="btn btn-primary">${d.c.cta}</button></div>
      </div>
    </div>`).join('');
  $$('.showcase-card').forEach((card) => card.addEventListener('click', () => {
    setProduct(card.dataset.product);
    $('#konfigurator').scrollIntoView({ behavior: 'smooth' });
  }));
}

// ---------------------------------------------------------------------------
// Bestell-Flow
// ---------------------------------------------------------------------------
function initOrderModal() {
  const modal = $('#order-modal');
  $('#btn-order').addEventListener('click', () => {
    $('#order-summary').innerHTML = orderSummaryHTML();
    renderQtyOptions();
    updateOrderTotal();
    modal.showModal();
  });
  $('#order-cancel').addEventListener('click', () => modal.close());
  $('#o-qty').addEventListener('input', updateOrderTotal);

  $('#order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#order-submit');
    btn.disabled = true;
    btn.textContent = 'Wird gesendet …';
    try {
      const buf = exportCurrentSTL();
      const res = await fetch('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('#o-name').value,
          email: $('#o-email').value,
          qty: parseInt($('#o-qty').value, 10),
          notes: $('#o-notes').value,
          config: { ...state, customPoints: customByProduct[state.product] },
          colorName: state.colorName,
          filename: stlFilename(),
          stlBase64: bufferToBase64(buf),
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Unbekannter Fehler');
      modal.close();
      $('#confirm-id').textContent = data.orderId;
      $('#confirm-modal').showModal();
    } catch (err) {
      alert('Bestellung fehlgeschlagen: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verbindlich bestellen';
    }
  });
  $('#confirm-close').addEventListener('click', () => $('#confirm-modal').close());
}

function renderQtyOptions() {
  const isEgg = state.product === 'eierbecher';
  $('#o-qty').innerHTML = isEgg
    ? `<option value="1">1 Stück</option>
       <option value="2">2 Stück (Duo-Preis)</option>
       <option value="4">4 Stück (Familien-Set)</option>
       <option value="6">6 Stück</option>`
    : `<option value="1">1 Vase</option>
       <option value="2">2 Vasen (Duo-Preis)</option>
       <option value="3">3 Vasen</option>`;
}

function orderTotal(qty) {
  const pp = productPricing();
  let total;
  if (qty === 2 && pp.duo) total = pp.duo;
  else if (qty === 4 && pp.family4) total = pp.family4;
  else if (qty > 2) total = Math.round(qty * pp.single * 0.85 * 10) / 10;
  else total = qty * pp.single;
  if (state.product === 'eierbecher' && state.saucer) total += qty * content.pricing.eierbecher.untersetzer;
  return Math.round(total * 100) / 100;
}

function updateOrderTotal() {
  const qty = Math.max(1, parseInt($('#o-qty').value || '1', 10));
  $('#order-total').textContent = money(orderTotal(qty));
}

function orderSummaryHTML() {
  const product = PRODUCTS[state.product];
  const presetLabel = state.preset === 'eigene' ? 'Eigene Form' : product.presets[state.preset].label;
  const twist = state.twist === 0 ? '' : `, Drall ${Math.round(state.twist * 180)}°`;
  return `<span class="dot" style="background:${state.colorHex}"></span>
    <b>${product.label} „${presetLabel}“</b> · ${PATTERNS[state.pattern]}${state.pattern !== 'glatt' ? ` (${state.ribs}×, ${state.depth.toFixed(1)} mm${twist})` : ''}
    · ${state.height} mm · <b>${state.colorName}</b>${state.text ? ` · Gravur „${state.text}“ (${FONTS[state.font].label})` : ''}${state.product === 'eierbecher' && state.saucer ? ' · 🍽️ mit Untersetzer' : ''}`;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async () => {
  await loadContent();
  renderProductTabs();
  renderPresetButtons();
  renderFontRow();
  renderPrices();
  initControls();
  loadFont(state.font); // Standardschrift vorwärmen
  rebuild();
  animate();
  $('#loading').classList.add('hidden');
  setTimeout(renderShowcase, 400); // Produkt-Showcase mit echten Engine-Renders
})();
