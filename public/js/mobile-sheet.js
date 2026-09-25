// OVJU Mobil — Bottom-Sheet für Formen und Oberflächen (ein DOM-Knoten, erst beim ersten Öffnen angelegt, nur ≤ 700 px).
// Federndes Einblenden, Drag-to-close, Schließen-Kreuz, Backdrop/Esc/Android-Zurück (genau ein History-Eintrag je Öffnung), main inert,
// Fokus zurück zur Kachel; die Hero-3D pausiert währenddessen (ovju:world-hold). Der CTA feuert erst NACH dem Schließen.
import { buzz } from './mobile.js';

const SMALL = matchMedia('(max-width:700px)').matches;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const $ = (s, r = document) => r.querySelector(s);

let sheet = null, backdrop = null, open = false, source = null, closeTimer = null;
let state = {}; // { color, chip, cfg } — aktueller Sheet-Zustand (Chip-Wahl wandert in den CTA)
let onCta = null, onChip = null;

function build() {
  backdrop = document.createElement('div'); backdrop.className = 'm-sheet-backdrop';
  sheet = document.createElement('div'); sheet.className = 'm-sheet'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'm-sheet-title'); sheet.tabIndex = -1;
  // Reihenfolge: Griff → Inhalt (Bild [+ rundes Detail], Kicker, Titel, Meta, Text, Chips, Preis, Versand, Mengenrabatt, CTA, Absicherung, Notiz,
  // Fußzeile) → Schließen-Kreuz (letztes Tab-Ziel, optisch oben rechts)
  sheet.innerHTML = `<div class="m-sheet-grip"></div><div class="m-sheet-scroll"><div class="m-sheet-media"><img class="m-sheet-img" decoding="async" alt=""><img class="m-sheet-img m-sheet-img2" aria-hidden="true" alt=""><div class="m-sheet-svg"></div><img class="m-sheet-inset" decoding="async" alt="" hidden></div><p class="m-sheet-kicker"></p><h2 id="m-sheet-title" tabindex="-1"></h2><p class="m-sheet-meta"></p><p class="m-sheet-text"></p><div class="m-chips" role="group" aria-label="Finish"></div><p class="m-sheet-price"></p><p class="m-sheet-facts"></p><p class="m-sheet-deal"></p><button class="m-sheet-cta" type="button"></button><p class="m-sheet-trust"></p><p class="m-sheet-note"></p><p class="m-sheet-foot"></p></div><button class="m-sheet-close" type="button" aria-label="Schließen">×</button>`;
  const toast = $('#toast');
  document.body.insertBefore(backdrop, toast); document.body.insertBefore(sheet, toast);
  backdrop.addEventListener('click', () => closeSheet());
  $('.m-sheet-close', sheet).addEventListener('click', () => { buzz(); closeSheet(); });
  document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') { e.preventDefault(); closeSheet(); } });
  window.addEventListener('popstate', () => { if (open) closeSheet({ viaHistory: true }); });
  $('.m-sheet-cta', sheet).addEventListener('click', () => { buzz(12); const cb = onCta, st = { ...state }; closeSheet(); setTimeout(() => cb?.(st), 240); });
  $('.m-chips', sheet).addEventListener('click', (e) => { const b = e.target.closest('.m-chip'); if (b) selectChip(+b.dataset.index); });
  initDrag();
}

/** Chip wählen: Bild-Crossfade 250 ms über das zweite img, Farbe in den Zustand, Preis neu */
function selectChip(i) {
  const chips = state.chips || []; const c = chips[i]; if (!c) return;
  $('.m-chips', sheet).querySelectorAll('.m-chip').forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
  state.chip = i; state.color = c.color;
  if (c.image) crossfade(c.image, c.alt);
  buzz();
  onChip?.(state);
}

function crossfade(src, alt) {
  const a = $('.m-sheet-img:not(.m-sheet-img2)', sheet), b = $('.m-sheet-img2', sheet);
  if (a.src.endsWith(src) || reduced.matches) { a.src = src; if (alt) a.alt = alt; return; }
  const swap = () => {
    b.style.opacity = '1'; a.style.opacity = '0';
    setTimeout(() => { a.src = src; if (alt) a.alt = alt; a.style.opacity = ''; b.style.opacity = ''; }, 260);
  };
  b.src = src; if (b.complete) swap(); else b.onload = swap;
}

function initDrag() {
  const scroll = $('.m-sheet-scroll', sheet);
  let y0 = 0, t0 = 0, dy = 0, active = false, id = null;
  const start = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.currentTarget.classList.contains('m-sheet-media') && scroll.scrollTop > 0) return;
    active = true; id = e.pointerId; y0 = e.clientY; t0 = performance.now(); dy = 0;
    try { sheet.setPointerCapture(id); } catch { /* egal */ }
  };
  const move = (e) => {
    if (!active) return;
    dy = Math.max(0, e.clientY - y0);
    if (reduced.matches) return;
    sheet.classList.add('dragging'); sheet.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (!active) return; active = false;
    const v = dy / Math.max(1, performance.now() - t0);
    sheet.classList.remove('dragging'); sheet.style.transform = '';
    if (dy > 120 || v > .6) closeSheet();
  };
  for (const el of [$('.m-sheet-grip', sheet), $('.m-sheet-media', sheet)]) el.addEventListener('pointerdown', start);
  sheet.addEventListener('pointermove', move);
  sheet.addEventListener('pointerup', end); sheet.addEventListener('pointercancel', end);
}

export function isSheetOpen() { return open; }

/**
 * openSheet({source, kind, image, alt, inset, insetAlt, svg, ground, hex, preview, kicker, title, meta, text, chips, chipIndex, price, facts, deal, trust, note, cta, onCta, onChip, foot})
 * kind: 'form' (Produktfoto 4:5, Silhouette ganz) | 'swatch' (3D-Vorschau der ganzen Vase 4:5 auf Elfenbein, inset = rundes Makro-Detail unten
 *       rechts) | 'pattern' (Materialdetail 7:6) — steuert die Bildfläche per CSS (data-kind)
 * svg + hex: Muster ohne Vorschau → kompakter Streifen mit Symbol in der Musterfarbe statt großer Bildfläche; preview: 3D-Vorschau aus dem Konfigurator-Modell
 * meta / facts / deal: Text oder Funktion (state) → Text; price: Funktion (state) → HTML der EINEN Preiszeile oder fertiger HTML-String — werden
 * bei Chip-Wechsel neu gerechnet; trust: HTML (Linien-Icon + Text) unter dem Knopf
 */
export function openSheet(o) {
  if (!SMALL) return;
  if (!sheet) build();
  clearTimeout(closeTimer);
  source = o.source || null; onCta = o.onCta || null; onChip = null;
  state = { chips: o.chips || [], chip: o.chipIndex ?? 0, color: o.chips?.[o.chipIndex ?? 0]?.color, key: o.key };
  sheet.dataset.kind = o.kind || (o.svg ? 'pattern' : 'form');
  const media = $('.m-sheet-media', sheet), img = $('.m-sheet-img:not(.m-sheet-img2)', sheet), img2 = $('.m-sheet-img2', sheet), svg = $('.m-sheet-svg', sheet);
  img.style.opacity = ''; img2.style.opacity = ''; img2.removeAttribute('src');
  const useSvg = !!o.svg && !o.image;
  media.classList.toggle('is-svg', useSvg);
  if (o.ground) media.style.setProperty('--m-ground', o.ground); else media.style.removeProperty('--m-ground');
  if (o.hex) media.style.setProperty('--m-hex', o.hex); else media.style.removeProperty('--m-hex');
  const inset = $('.m-sheet-inset', sheet);
  if (o.inset && !useSvg) { inset.src = o.inset; inset.alt = o.insetAlt || ''; inset.hidden = false; } else { inset.hidden = true; inset.removeAttribute('src'); }
  if (useSvg) { img.hidden = true; img2.hidden = true; img.removeAttribute('src'); svg.innerHTML = o.svg + '<span>Live-Vorschau im Konfigurator</span>'; }
  else { img.hidden = false; img2.hidden = false; svg.innerHTML = ''; const c = state.chips[state.chip]; img.src = (c && c.image) || o.image; img.alt = o.alt || ''; }
  $('.m-sheet-kicker', sheet).textContent = o.kicker || '';
  $('#m-sheet-title', sheet).textContent = o.title || '';
  $('.m-sheet-text', sheet).textContent = o.text || '';
  $('.m-chips', sheet).innerHTML = state.chips.map((c, i) => `<button type="button" class="m-chip" data-index="${i}" style="--hex:${c.hex}" aria-pressed="${i === state.chip}"><i></i>${c.label}</button>`).join('');
  const price = $('.m-sheet-price', sheet), meta = $('.m-sheet-meta', sheet), facts = $('.m-sheet-facts', sheet), deal = $('.m-sheet-deal', sheet);
  const val = (x) => (typeof x === 'function' ? x(state) : x) || '';
  const paint = () => { meta.textContent = val(o.meta); price.innerHTML = val(o.price); facts.textContent = val(o.facts); deal.textContent = val(o.deal); };
  paint(); onChip = () => { paint(); o.onChip?.(state); };
  $('.m-sheet-cta', sheet).textContent = o.cta || 'Gestalten ↗';
  $('.m-sheet-trust', sheet).innerHTML = val(o.trust);
  $('.m-sheet-note', sheet).textContent = o.note || '';
  $('.m-sheet-foot', sheet).textContent = o.foot || (useSvg ? 'Kein Foto — im Konfigurator siehst du dein Muster live in 3D.' : o.preview ? '3D-Vorschau aus unserem Konfigurator-Modell · Live-Vorschau im Konfigurator' : 'KI-Produktfoto auf Basis unseres 3D-Modells · Live-Vorschau im Konfigurator');
  [...$('.m-sheet-scroll', sheet).children].forEach((el, i) => el.style.setProperty('--i', i));
  $('.m-sheet-scroll', sheet).scrollTop = 0;
  if (!open) { try { history.pushState({ mSheet: 1 }, ''); } catch { /* egal */ } }
  open = true;
  try { $('main').inert = true; } catch { /* iOS < 15.5 */ }
  document.body.classList.add('m-sheet-open');
  backdrop.classList.add('show');
  sheet.classList.remove('closing');
  requestAnimationFrame(() => sheet.classList.add('open'));
  window.dispatchEvent(new CustomEvent('ovju:world-hold', { detail: true }));
  buzz();
  sheet.focus({ preventScroll: true });
  setTimeout(() => { if (open) $('#m-sheet-title', sheet).focus({ preventScroll: true }); }, 60);
  sheet.dispatchEvent(new CustomEvent('m-sheet:opened'));
}

export function closeSheet({ viaHistory = false } = {}) {
  if (!open || !sheet) return;
  open = false;
  sheet.classList.remove('open', 'dragging'); sheet.classList.add('closing'); sheet.style.transform = '';
  backdrop.classList.remove('show');
  document.body.classList.remove('m-sheet-open');
  try { $('main').inert = false; } catch { /* egal */ }
  window.dispatchEvent(new CustomEvent('ovju:world-hold', { detail: false }));
  if (source && source.isConnected) { try { source.focus({ preventScroll: true }); } catch { /* egal */ } }
  closeTimer = setTimeout(() => sheet.classList.remove('closing'), 240);
  if (!viaHistory && history.state?.mSheet) { try { history.back(); } catch { /* egal */ } }
}

/** Rechteck des Sheet-Bildes (für die FLIP-Animation aus der Kachel) */
export function sheetMediaRect() { return sheet ? $('.m-sheet-media', sheet).getBoundingClientRect() : null; }
export function sheetElement() { return sheet; }
