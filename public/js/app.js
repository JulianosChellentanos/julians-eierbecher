// OVJU — Konfigurator: 3D-Szene, UI-Bindings, Bestellung
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { FontLoader } from '../vendor/FontLoader.js';
import { TextGeometry } from '../vendor/TextGeometry.js';
import { buildEggcup, bendTextOntoCup, maxTextArc, DEFAULTS, PRESETS } from './geometry.js';
import { exportSTL, downloadSTL, bufferToBase64 } from './exporter.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = { ...DEFAULTS, color: null, colorName: '', colorHex: '#efe9dc' };
let content = null;
let font = null;
let cupMesh = null;
let textMesh = null;
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

  // Farb-Swatches
  $('#swatches').innerHTML = content.colors.map((c) => `
    <button class="swatch" data-id="${c.id}" data-hex="${c.hex}" data-name="${c.name}"
      style="--sw:${c.hex}" title="${c.name}"><span></span></button>`).join('');
  $$('.swatch').forEach((b) => b.addEventListener('click', () => setColor(b.dataset)));
  setColor({ id: content.colors[0].id, hex: content.colors[0].hex, name: content.colors[0].name });

  renderPrices();
}

function money(v) {
  return v.toLocaleString('de-DE', { style: 'currency', currency: content.pricing.currency });
}

function renderPrices() {
  $('#price').textContent = money(content.pricing.single);
  $('#price-hint').textContent = `Duo ${money(content.pricing.duo)} · 4er-Set ${money(content.pricing.family4)}`;
}

function setColor({ id, hex, name }) {
  state.color = id; state.colorHex = hex; state.colorName = name;
  $$('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  $('#color-name').textContent = name;
  if (cupMesh) cupMesh.material.color.set(hex);
  if (textMesh) textMesh.material.color.set(hex);
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
const camera = new THREE.PerspectiveCamera(32, 1, 1, 800);
camera.position.set(95, 75, 150);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 30, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 70;
controls.maxDistance = 320;
controls.maxPolarAngle = Math.PI * 0.55;
controls.addEventListener('start', () => { userInteracted = true; });

// Licht: weiches Studio-Setup
scene.add(new THREE.HemisphereLight(0xfff6ea, 0xb9a894, 0.9));
const key = new THREE.DirectionalLight(0xfff2e0, 1.6);
key.position.set(80, 140, 90);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -80; key.shadow.camera.right = 80;
key.shadow.camera.top = 80; key.shadow.camera.bottom = -80;
key.shadow.radius = 6;
scene.add(key);
const fill = new THREE.DirectionalLight(0xdce8ff, 0.5);
fill.position.set(-90, 60, -60);
scene.add(fill);

// Boden mit weichem Schatten
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(220, 64).rotateX(-Math.PI / 2),
  new THREE.ShadowMaterial({ opacity: 0.16 })
);
ground.receiveShadow = true;
scene.add(ground);

const material = new THREE.MeshStandardMaterial({
  color: state.colorHex, roughness: 0.62, metalness: 0.0,
});

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
new ResizeObserver(resize).observe(canvas);

function animate() {
  requestAnimationFrame(animate);
  resize();
  if (!userInteracted && cupMesh) cupMesh.parent.rotation.y += 0.004;
  controls.update();
  renderer.render(scene, camera);
}

const cupGroup = new THREE.Group();
scene.add(cupGroup);

// ---------------------------------------------------------------------------
// Becher (neu) bauen
// ---------------------------------------------------------------------------
let currentInfo = null;

function rebuild() {
  const { geometry, info } = buildEggcup(state);
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
  rebuildText();
  $('#dim-info').textContent =
    `${info.height} mm hoch · Ø ${info.topDiameter.toFixed(0)} mm · Mulde Ø ${info.cavityDiameter.toFixed(0)} mm`;
}

function rebuildText() {
  if (textMesh) {
    cupGroup.remove(textMesh);
    textMesh.geometry.dispose();
    textMesh = null;
  }
  const txt = state.text.trim();
  $('#text-warn').textContent = '';
  if (!txt || !font || !currentInfo) return;

  const depth = currentInfo.surfaceAmp + 2.0;
  let size = state.textSize;
  let geo, result;
  for (let attempt = 0; attempt < 6; attempt++) {
    geo = new TextGeometry(txt, {
      font, size, height: depth, curveSegments: 6, bevelEnabled: false,
    });
    result = bendTextOntoCup(geo, currentInfo);
    if (result.arc <= maxTextArc()) break;
    geo.dispose();
    size *= 0.88; // Text zu breit → verkleinern
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
  cupGroup.add(textMesh);
}

const debounce = (fn, ms) => {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
const rebuildSoon = debounce(rebuild, 60);
const rebuildTextSoon = debounce(rebuildText, 150);

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

function initControls() {
  // Form-Presets
  $$('.preset-btn').forEach((b) => b.addEventListener('click', () => {
    state.preset = b.dataset.preset;
    $$('.preset-btn').forEach((x) => x.classList.toggle('active', x === b));
    rebuild();
  }));

  // Muster
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

  $('#i-text').addEventListener('input', (e) => {
    state.text = e.target.value.slice(0, 16);
    rebuildTextSoon();
  });

  // Überrasch mich
  $('#btn-random').addEventListener('click', () => {
    const presets = Object.keys(PRESETS);
    const patterns = ['wellen', 'rippen', 'rippen'];
    state.preset = presets[Math.floor(Math.random() * presets.length)];
    state.pattern = patterns[Math.floor(Math.random() * patterns.length)];
    state.ribs = 16 + Math.floor(Math.random() * 70);
    state.depth = 0.5 + Math.random() * 1.1;
    state.twist = Math.random() < 0.4 ? 0 : (Math.random() * 3 - 1.5);
    state.height = 45 + Math.floor(Math.random() * 25);
    syncControls();
    const c = content.colors[Math.floor(Math.random() * content.colors.length)];
    setColor({ id: c.id, hex: c.hex, name: c.name });
    rebuild();
  });

  $('#btn-download').addEventListener('click', () => {
    const buf = exportCurrentSTL();
    downloadSTL(buf, stlFilename());
  });

  $('#hero-cta').addEventListener('click', () => {
    $('#konfigurator').scrollIntoView({ behavior: 'smooth' });
  });

  initOrderModal();
}

function syncControls() {
  $$('.preset-btn').forEach((x) => x.classList.toggle('active', x.dataset.preset === state.preset));
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
  return `${brand}-eierbecher-${state.preset}-${state.pattern}${state.text ? '-' + state.text.replace(/[^a-z0-9äöüß]/gi, '_') : ''}.stl`;
}

function exportCurrentSTL() {
  const meshes = [cupMesh];
  if (textMesh) meshes.push(textMesh);
  // Ohne Gruppenrotation exportieren, damit die STL sauber ausgerichtet ist
  const rot = cupGroup.rotation.y;
  cupGroup.rotation.y = 0;
  cupGroup.updateMatrixWorld(true);
  const buf = exportSTL(meshes);
  cupGroup.rotation.y = rot;
  return buf;
}

// ---------------------------------------------------------------------------
// Bestell-Flow
// ---------------------------------------------------------------------------
function initOrderModal() {
  const modal = $('#order-modal');
  $('#btn-order').addEventListener('click', () => {
    $('#order-summary').innerHTML = orderSummaryHTML();
    modal.showModal();
  });
  $('#order-cancel').addEventListener('click', () => modal.close());
  $('#o-qty').addEventListener('input', updateOrderTotal);
  updateOrderTotal();

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
          config: { ...state },
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

function orderTotal(qty) {
  const p = content.pricing;
  if (qty === 2) return p.duo;
  if (qty === 4) return p.family4;
  if (qty > 4) return Math.round(qty * p.single * 0.85 * 10) / 10;
  return qty * p.single;
}

function updateOrderTotal() {
  const qty = Math.max(1, parseInt($('#o-qty').value || '1', 10));
  $('#order-total').textContent = money(orderTotal(qty));
}

function orderSummaryHTML() {
  const pat = { glatt: 'Glatt', wellen: 'Wellen', rippen: 'Rippen' }[state.pattern];
  const twist = state.twist === 0 ? '' : `, Drall ${Math.round(state.twist * 180)}°`;
  return `<span class="dot" style="background:${state.colorHex}"></span>
    <b>${PRESETS[state.preset].label}</b> · ${pat}${state.pattern !== 'glatt' ? ` (${state.ribs}×, ${state.depth.toFixed(1)} mm${twist})` : ''}
    · ${state.height} mm · <b>${state.colorName}</b>${state.text ? ` · Gravur „${state.text}“` : ''}`;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async () => {
  await loadContent();
  initControls();
  font = await new Promise((resolve, reject) =>
    new FontLoader().load('fonts/helvetiker_bold.typeface.json', resolve, undefined, reject));
  rebuild();
  animate();
  $('#loading').classList.add('hidden');
})();
