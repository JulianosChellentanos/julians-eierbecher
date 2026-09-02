// OVJU — Mobile App-Shell: Tabs statt Endlos-Scroll, Swipe, Bottom-Bar,
// Vollbild-3D, Toasts, Haptik, animierte Preise. Greift nur auf kleinen Screens.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

export const IS_MOBILE = window.matchMedia('(max-width: 980px)').matches;

const TABS = [
  ['form', '🏺', 'Form'],
  ['muster', '✨', 'Muster'],
  ['gravur', '✒️', 'Gravur'],
  ['farbe', '🎨', 'Farbe'],
  ['extras', '➕', 'Extras'],
];
let activeTab = 'form';
let tabOrder = TABS.map((t) => t[0]);
let currentProduct = 'vase';

/** Sanfte Vibration auf unterstützten Geräten (Android) */
export function buzz(ms = 8) {
  try { navigator.vibrate?.(ms); } catch { /* egal */ }
}

/** Toast unten (App-Feedback) */
let toastTimer = null;
export function showToast(msg, ms = 2200) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** Warenkorb-Icon hüpfen lassen */
export function bumpCart() {
  const b = $('#cart-btn');
  if (!b) return;
  b.classList.remove('bump');
  void b.offsetWidth; // Reflow → Animation neu starten
  b.classList.add('bump');
}

/** Zahl in einem Element weich hochzählen (Preis-Animation) */
const moneyState = new WeakMap();
export function animateMoney(el, target, fmt) {
  if (!el) return;
  const from = moneyState.get(el) ?? target;
  moneyState.set(el, target);
  if (Math.abs(from - target) < 0.005 || !el.textContent) { el.textContent = fmt(target); return; }
  const t0 = performance.now(), dur = 380;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3); // ease-out
    el.textContent = fmt(from + (target - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function setMobilePrice(text, sub) {
  const p = $('#mb-price');
  if (p && text !== undefined) p.textContent = text;
  const s = $('#mb-sub');
  if (s && sub !== undefined) s.textContent = sub;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function renderTabs() {
  const bar = $('#mtabs');
  bar.innerHTML = TABS.filter(([k]) => tabOrder.includes(k)).map(([k, icon, label]) => `
    <button class="mtab ${k === activeTab ? 'active' : ''}" data-tab="${k}">
      <span class="mtab-ic">${icon}</span><span>${label}</span></button>`).join('');
  bar.querySelectorAll('.mtab[data-tab]').forEach((b) => b.addEventListener('click', () => {
    buzz();
    activateTab(b.dataset.tab, undefined, true);
  }));
}

export function activateTab(key, dir, byUser = false) {
  if (!tabOrder.includes(key)) key = tabOrder[0];
  const prevIdx = tabOrder.indexOf(activeTab);
  const nextIdx = tabOrder.indexOf(key);
  const direction = dir || (nextIdx >= prevIdx ? 'right' : 'left');
  activeTab = key;
  $$('.panel .ctrl').forEach((sec) => {
    const on = sec.dataset.tab === key;
    sec.classList.toggle('active', on);
    sec.classList.remove('from-left', 'from-right');
    if (on) sec.classList.add(direction === 'right' ? 'from-right' : 'from-left');
  });
  $$('.mtab[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
  // Produkt-Umschalter (Eierbecher/Vase) gehört zur Form — mobil nur dort zeigen;
  // der Vasen-Hinweis gehört überall nur zum Form-Tab
  if (IS_MOBILE) { const pt = $('#product-tabs'); if (pt) pt.hidden = key !== 'form'; }
  const vn = $('#vase-note'); if (vn) vn.hidden = key !== 'form' || currentProduct !== 'vase';
  // Mobile: Inhalt des neuen Tabs direkt unter die Tab-Leiste holen (falls tief gescrollt)
  const tabs = $('#mtabs');
  const panel = $('.panel');
  if (IS_MOBILE && tabs && panel) {
    const stuckBottom = tabs.getBoundingClientRect().bottom;
    const panelTop = panel.getBoundingClientRect().top;
    if (panelTop < stuckBottom - 4) {
      window.scrollBy({ top: panelTop - stuckBottom - 6, behavior: 'smooth' });
    }
  }
  // Aktiven Tab in die Mitte scrollen (falls Tab-Leiste überläuft)
  // Aktiven Tab in der Leiste zentrieren — nur bei echter Nutzeraktion (sonst springt die Seite beim Laden)
  if (byUser && IS_MOBILE) $(`.mtab[data-tab="${key}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

/** Extras-Tab nur beim Eierbecher — Tabs gibt es auf Desktop UND Mobile */
export function updateMobileTabs(product) {
  tabOrder = TABS.map((t) => t[0]).filter((k) => k !== 'extras' || product === 'eierbecher');
  currentProduct = product;
  renderTabs();
  if (!tabOrder.includes(activeTab)) activateTab(tabOrder[0]);
  else activateTab(activeTab);
}

// ---------------------------------------------------------------------------
// Swipe zwischen Tabs (nicht auf Reglern/Scroll-Reihen)
// ---------------------------------------------------------------------------
function initSwipe() {
  const panel = $('.panel');
  let sx = 0, sy = 0, ok = false;
  panel.addEventListener('touchstart', (e) => {
    const t = e.target;
    ok = !t.closest('input, .seg, .preset-row, .swatch-grid, .font-row, #profile-svg, .flow-block, .mtabs');
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (!ok) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 64 && Math.abs(dy) < 48) {
      const i = tabOrder.indexOf(activeTab);
      const next = dx < 0 ? tabOrder[i + 1] : tabOrder[i - 1];
      if (next) { buzz(); activateTab(next, dx < 0 ? 'right' : 'left', true); }
    }
  }, { passive: true });
}

// ---------------------------------------------------------------------------
// Bottom-Bar (sichtbar, solange der Konfigurator im Bild ist)
// ---------------------------------------------------------------------------
function initBottomBar() {
  const bar = $('#mobile-bar');
  bar.hidden = false; // Sichtbarkeit steuert die CSS-Klasse .show (Slide-In)
  // Erst einblenden, wenn die 3D-Bühne wirklich im oberen Bereich des Screens ist
  const io = new IntersectionObserver(([en]) => {
    const on = en.isIntersecting;
    bar.classList.toggle('show', on);
    document.body.classList.toggle('has-mbar', on);
  }, { threshold: 0.2, rootMargin: '0px 0px -35% 0px' });
  io.observe($('.stage'));
  $('#mb-cart').addEventListener('click', () => { buzz(14); $('#btn-order').click(); });
  $('#mb-download').addEventListener('click', () => { buzz(); $('#btn-download').click(); });
}

// ---------------------------------------------------------------------------
// Vollbild-3D
// ---------------------------------------------------------------------------
function initFullscreen() {
  const btn = $('#btn-fullscreen');
  const stage = $('.stage');
  btn.addEventListener('click', () => {
    buzz();
    const on = stage.classList.toggle('stage-full');
    btn.textContent = on ? '✕' : '⤢';
    document.body.classList.toggle('no-scroll', on);
    window.dispatchEvent(new Event('resize'));
  });
}

// ---------------------------------------------------------------------------
export function initMobileShell({ product }) {
  if (!IS_MOBILE) return;
  document.body.classList.add('is-mobile');
  // Tab-Leiste aus dem Panel heraus direkt unter die Bühne hängen — so kleben
  // Bühne + Tabs gemeinsam (sticky im hohen Grid-Container statt im kurzen Panel)
  const grid = $('.config-grid');
  grid.insertBefore($('#mtabs'), $('.panel'));
  updateMobileTabs(product);
  initSwipe();
  initBottomBar();
  initFullscreen();
  // 🎲 als Floating-Button in der Bühne (unter dem Vollbild-Button)
  const dice = document.createElement('button');
  dice.className = 'stage-dice-btn';
  dice.textContent = '🎲';
  dice.title = 'Überrasch mich';
  dice.setAttribute('aria-label', 'Zufälliges Design');
  dice.addEventListener('click', () => { buzz(12); $('#btn-random').click(); });
  $('.stage').appendChild(dice);
  // Haptik auf allen Auswahl-Buttons
  $('.panel').addEventListener('click', (e) => {
    if (e.target.closest('.pattern-btn, .flow-btn, .preset-btn, .product-tab, .font-chip, .swatch, .check-row')) buzz();
  });
  $('.stage').addEventListener('click', (e) => {
    if (e.target.closest('.scene-chip')) buzz();
  });
}
