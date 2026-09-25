// OVJU Mobil (≤ 700 px) — Startseite neu strukturiert: EIN Hero mit der 3D-Formenwelt als lebendigem Hintergrund (Bühne = Menü:
// Wischen wechselt die Form, Punkte zeigen die Position), Katalog „Formen“ (6 Kacheln) und Katalog „Oberflächen“ (9 Muster) mit Details
// im Bottom-Sheet, EIN klebender CTA (weicht jedem anderen Bestellknopf), danach nur noch das Nötigste.
// Läuft ausschließlich unter 700 px (SMALL-Gate); Desktop/Tablet bleiben unberührt.
// Nutzt bestehende Schnittstellen: ovju:studio-design (→ app.js), ovju:hero-select (← studio.js), ovju:world-ready/-snapshot (← studio.js, BG-Modus),
// #hero-hint (Preisfeed), #mb-price (Live-Preis), Body-Klassen has-mbar / no-scroll der App-Shell (mobile.js).
import { STUDIO_DESIGNS, designConfig, designImage } from './studio-designs.js';
import { buzz } from './mobile.js';
import { unitPrice, unitUvp, aktionFor, onAktionEnde, getPricing, fmt, colorByRef, aktionenActive, aktionTextKurz } from './pricing.js';
import { openSheet, isSheetOpen, sheetElement } from './mobile-sheet.js';
import { MOBILE_PATTERNS, patternConfig, patternByKey } from './mobile-patterns.js';
import { renderPreviewsOffscreen } from './mobile-preview.js';

const SMALL = matchMedia('(max-width:700px)').matches;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const WEAK = (navigator.deviceMemory ?? 8) <= 4; // wenig RAM: weniger Scroll-Reveal-Arbeit
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const idle = (f, timeout = 1500) => (window.requestIdleCallback ? requestIdleCallback(f, { timeout }) : setTimeout(f, 300));
const go = (cfg) => window.dispatchEvent(new CustomEvent('ovju:studio-design', { detail: cfg }));

const FORM_TEXT = {
  twist: 'Die klassische Flasche, um die sich 64 feine Rippen drehen. Ruhig von vorn, lebendig beim Drehen.',
  orbit: 'Eine runde Kugel mit sanften Wellen. Klein, freundlich, überall zuhause.',
  flow: 'Geschwungene Silhouette mit tiefen Lamellen. Licht und Schatten machen den Rest.',
  drop: 'Unten weit, oben schmal — der Tropfen mit spiralig gedrehten Rippen.',
  column: 'Ein gerader Zylinder mit scharfen Facetten. Architektonisch und klar.',
  own: 'Zieh deine eigene Linie: Im Konfigurator setzt du jeden Punkt der Silhouette selbst.',
};
// Handy-Kurzfassungen (ganze Sätze, passen in 1–2 Zeilen) statt abgeschnittener Desktop-Texte aus content.json
const KURZ = {
  // Die Vertrauenskarte (#usps) entfällt mobil — sie wiederholte die Trust-Zeile des Heros; „matt bis metallic“ lebt jetzt in Schritt 1
  steps: ['Form, Struktur und Farbe von matt bis metallic — live in 3D, auf Wunsch mit Gravur.', 'Speichern oder direkt in den Warenkorb.', 'Schicht für Schicht gedruckt, bei dir in 5–8 Werktagen. Transportschaden? Wir drucken gratis neu.'], // Material steht schon im Hero; das Neudruck-Versprechen (FAQ) steht hier sichtbar statt nur im zugeklappten FAQ
  galerie: 'Echte Stücke in echten Wohnungen.',
  subKurz: 'Deine Vase selbst gestalten – Form, Muster, Farbe und Gravur. In 3D gedruckt, zu dir geliefert.', // kurze Displays: ein Satz, nie abgeschnitten
};
// Monochrome Linien-Icons (currentColor, 1,5-px-Strich) statt bunter Emoji — eine Icon-Sprache für Hero, Topbar, Aktionsleiste, Bühne, Toast,
// Vertrauensband und Footer. width/height als Attribut: ohne CSS bleibt jedes Icon 16 px groß (nie wieder bildschirmfüllend).
const SVG = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
const ICON = {
  leaf: SVG('<path d="M5 19c0-8.5 5-13.5 14-14-.5 9-5.5 14-14 14z"/><path d="M5 19c3.5-4.5 6.5-7.5 10-9.5"/>'),
  printer: SVG('<path d="M7 9V4h10v5"/><rect x="3.5" y="9" width="17" height="8" rx="1.5"/><path d="M7 14h10v6H7z"/><path d="M17 12h.5"/>'),
  box: SVG('<path d="M3.5 8 12 4l8.5 4L12 12z"/><path d="M3.5 8v8l8.5 4 8.5-4V8"/><path d="M12 12v8"/>'),
  sliders: SVG('<path d="M4 7h9M19 7h1M4 17h3M13 17h7"/><circle cx="15.5" cy="7" r="2.2"/><circle cx="9.5" cy="17" r="2.2"/>'),
  sparkle: SVG('<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
  cart: SVG('<path d="M3 4h2.2l2.3 10.6a1 1 0 0 0 1 .8h8.6a1 1 0 0 0 1-.8L20 8H6.4"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="16.5" cy="19.5" r="1.3"/>'),
  moon: SVG('<path d="M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z"/>'),
  sun: SVG('<circle cx="12" cy="12" r="3.8"/><path d="M12 3v1.8M12 19.2V21M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M3 12h1.8M19.2 12H21M5.6 18.4l1.3-1.3M17.1 6.9l1.3-1.3"/>'),
  user: SVG('<circle cx="12" cy="8.5" r="3.6"/><path d="M5 19.5c1.1-3.5 3.8-5.2 7-5.2s5.9 1.7 7 5.2"/>'),
  list: SVG('<path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20"/><path d="M4.5 6.5h.5M4.5 12h.5M4.5 17.5h.5" stroke-width="2.2"/>'),
  check: SVG('<circle cx="12" cy="12" r="8.5"/><path d="m8.3 12.3 2.5 2.5 4.9-5.2"/>'),
  info: SVG('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.2"/><path d="M12 7.8v.1" stroke-width="2.2"/>'),
  alert: SVG('<path d="M12 4.2 20.8 19H3.2z"/><path d="M12 10v4.3"/><path d="M12 16.8v.1" stroke-width="2.2"/>'),
  drop: SVG('<path d="M12 3.8c3.4 4.2 5.8 7.4 5.8 10.4a5.8 5.8 0 0 1-11.6 0c0-3 2.4-6.2 5.8-10.4z"/>'),
  rotate: SVG('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.8 4.8v3.9h-3.9"/>'),
  tag: SVG('<path d="M3.8 12.4V4.8a1 1 0 0 1 1-1h7.6l7.9 7.9a1 1 0 0 1 0 1.4l-7.2 7.2a1 1 0 0 1-1.4 0z"/><circle cx="8.3" cy="8.3" r="1.3"/>'),
  bookmark: SVG('<path d="M6.8 3.8h10.4v16.4L12 16.4l-5.2 3.8z"/>'),
  download: SVG('<path d="M12 4v10.5"/><path d="m7.6 10.2 4.4 4.4 4.4-4.4"/><path d="M5 19.5h14"/>'),
  shield: SVG('<path d="M12 3.6 19 6.2v5.3c0 4.3-2.9 7.5-7 9-4.1-1.5-7-4.7-7-9V6.2z"/><path d="m8.9 12.1 2.2 2.2 4.1-4.3"/>'),
};
/** Emoji (inkl. Variationszeichen) am Textanfang — wird durch ein Linien-Icon ersetzt */
const EMOJI_START = /^\s*(?:\p{Extended_Pictographic}|[✓✔])\uFE0F?\s*/u;
const EMOJI_ICON = { '✅': 'check', '✓': 'check', '✔': 'check', '⚠': 'alert', '🔶': 'alert', 'ℹ': 'info', '☝': 'rotate', '🌙': 'moon', '☀': 'sun', '👤': 'user', '📋': 'list', '🛒': 'cart', '🔥': 'tag', '🌱': 'leaf', '🌾': 'drop', '⚖': 'info', '🔖': 'bookmark', '⬇': 'download' };
const iconFor = (emoji) => ICON[EMOJI_ICON[emoji.replace(/\uFE0F/g, '').trim()]] || null;
/**
 * Führendes Emoji im ersten Textknoten von el durch <span class="m-ico">SVG</span> ersetzen — auch nachdem app.js/auth.js/aktion.js den
 * Inhalt neu geschrieben haben (MutationObserver; die eigene Änderung erzeugt kein neues Emoji, also keine Schleife)
 */
function iconize(el, fallback = null, force = null) {
  if (!el) return;
  const run = () => {
    const n = [...el.childNodes].find((x) => x.nodeType === 3 && x.textContent.trim());
    const m = n && n.textContent.match(EMOJI_START); if (!m) return;
    const svg = force || iconFor(m[0]) || fallback; if (!svg) return;
    n.textContent = n.textContent.slice(m[0].length);
    el.querySelectorAll(':scope > .m-ico').forEach((x) => x.remove());
    const s = document.createElement('span'); s.className = 'm-ico'; s.setAttribute('aria-hidden', 'true'); s.innerHTML = svg;
    el.insertBefore(s, el.firstChild);
  };
  run(); new MutationObserver(run).observe(el, { childList: true, characterData: true, subtree: true });
}
const TRUST = [[ICON.leaf, 'Pflanzen-PLA'], [ICON.printer, 'Aus Deutschland'], [ICON.box, '5–8 Werktage']];
// Reihenfolge der Bühne: Start = Hammerschlag (Signatur, grobe Geometrie → kein Moiré im allerersten Bild; Nachbarn Freiform und Voronoi,
// nicht Fjordwelle), dann Orbit, Twist erst an Position 3, danach Formen und Muster im Wechsel. Erster Wechsel nach 5 s, danach alle 8 s.
const ORDER = [6, 1, 0, 7, 2, 8, 3, 4, 5];
const KIND = (i) => (i < 6 ? 'Form' : 'Oberfläche'); // Kapsel „FORM · TWIST“ / „OBERFLÄCHE · HAMMERSCHLAG“ statt einer zweiten Zählweise

/** 3D nur auf Geräten, die es flüssig schaffen — sonst bleibt das Poster (studio.js liest #hero-art[data-world]) */
function canRun3D() {
  const c = navigator.connection || {};
  return !reduced.matches && !c.saveData && !/^(slow-)?2g$|^3g$/.test(c.effectiveType || '') && (navigator.deviceMemory ?? 4) > 2 && (navigator.hardwareConcurrency ?? 4) >= 4 && !contextLost();
}
function contextLost() { try { return !!sessionStorage.getItem('ovju-3d-lost'); } catch { return false; } }

let art, hero, heroInView = false, hold = false, lastPointer = 0, heroIndex = 0, leadChip = 0, worldReady = false, worldStarted = false;
let heroPriceHTML = 'ab 24,90 €';
let revealIO = null;

// ---------------------------------------------------------------------------
// Scroll-Reveal: nur Sekundärinhalte, nie von 0 (Fotos „fehlen“ nie), früh (160 px vor der Kante), kurz (.35 s), Sicherheitsnetz für Sichtbares
// ---------------------------------------------------------------------------
function reveal(el, delay = 0) {
  if (!el || !revealIO) return;
  if (WEAK && el.getBoundingClientRect().top > innerHeight * 1.5) return; // schwaches Gerät: weit unten gar nicht erst animieren
  el.classList.add('m-reveal'); if (delay) el.style.setProperty('--d', Math.min(delay, 120) + 'ms');
  revealIO.observe(el);
}
function revealVisible() {
  for (const el of $$('.m-reveal:not(.visible)')) { const r = el.getBoundingClientRect(); if (r.top < innerHeight + 40 && r.bottom > -40) { el.classList.add('visible'); revealIO?.unobserve(el); } }
}
function whenFilled(el, cb) {
  if (!el) return;
  if (el.children.length) { cb(); return; }
  const mo = new MutationObserver(() => { if (el.children.length) { mo.disconnect(); cb(); } });
  mo.observe(el, { childList: true });
}
/** Bild-Crossfade 250 ms über ein zweites <img> (Leitkachel) */
function crossfade(imgA, imgB, src, alt) {
  if (imgA.src.endsWith(src)) return;
  if (reduced.matches) { imgA.src = src; if (alt) imgA.alt = alt; return; }
  let done = false;
  const swap = () => {
    if (done) return; done = true;
    imgB.style.opacity = '1';
    setTimeout(() => { imgA.src = src; if (alt) imgA.alt = alt; imgB.style.opacity = ''; }, 260);
  };
  imgB.onload = swap; imgB.src = src;
  if (imgB.complete && imgB.naturalWidth) swap();
}

// ---------------------------------------------------------------------------
// Preise (exakt wie app.js renderHeroUsePrice: unitPrice({product:'vase',saucer:false,config,color}))
// ---------------------------------------------------------------------------
const colorLabel = (id) => { try { const c = colorByRef(id); if (c && c.name) return c.name; } catch { /* Farben noch nicht geladen */ } return id ? id[0].toUpperCase() + id.slice(1) : ''; };
/** „ab 21,17 €“ ohne Streichpreis (Pille, Inline-CTA): der Streichpreis steht nur in der Hero-Preiszeile */
const heroFromHTML = () => heroPriceHTML.replace(/\s*<s\b[^>]*>.*?<\/s>/g, '').trim();
/** Preis der gezeigten Variante (genau der, den der Sheet-CTA übernimmt) — null, solange die Preise fehlen */
function shownPrice(cfg) {
  if (!getPricing()) return null;
  try {
    const item = { product: 'vase', saucer: false, config: cfg, color: cfg.color };
    const unit = unitPrice(item); if (!unit) return null;
    const uvp = unitUvp(item), a = aktionFor('vase', cfg.pattern);
    return { unit, uvp, a: a && uvp > unit + .004 ? a : null };
  } catch { return null; }
}
/** EINE Preiszeile im Sheet: „So wie gezeigt  25,40 €  29,88 €  −15 %“ (Größe/Farbe stehen einmal in der Meta-Zeile darüber) */
function priceHTML(cfg) {
  const p = shownPrice(cfg); if (!p) return '';
  return `<small>So wie gezeigt</small> <b${p.a ? ' class="aktion-price"' : ''}>${fmt(p.unit)}</b>${p.a ? ` <s>${fmt(p.uvp)}</s> <span class="m-badge">−${p.a.prozent} %</span>` : ''}`;
}
/** Euro kurz: ganze Beträge ohne Nachkommastellen („ab 39 € versandfrei“), sonst wie überall („4,90 €“) */
const euro = (v) => (Number.isInteger(+v) ? `${+v}\u00a0€` : fmt(v)); // geschütztes Leerzeichen wie fmt()
/** Versandzeile aus settings.pricing.shipping (nur gelesen): „zzgl. 4,90 € Versand · ab 39 € versandfrei“ — PAngV: Preis zzgl. Versand */
function shippingText() {
  const sh = getPricing()?.shipping; if (!sh || !(+sh.flat > 0)) return getPricing() ? 'Versandkostenfrei' : '';
  return `zzgl. ${euro(sh.flat)} Versand${+sh.freeFrom > 0 ? ` · ab ${euro(sh.freeFrom)} versandfrei` : ''}`;
}
/** Graue Mikrozeile unter dem Preis: Versandkosten (statt des Fachbegriffs „STL-Download“, der steht jetzt im FAQ) */
function factsText() { return shippingText(); }
/**
 * Mengenrabatt aus settings.pricing.vase.discounts: „2 Vasen −10 % · 3 Vasen −15 %“ — nur, wenn er für die gezeigte Vase auch gilt
 * (eine laufende Aktion ohne „Mengenrabatt zusätzlich“ ersetzt ihn im Warenkorb, linePrice in pricing.js; dann keine Zeile)
 */
function dealText(cfg) {
  const tiers = getPricing()?.products?.vase?.discounts || []; if (!tiers.length) return '';
  try { const a = aktionFor('vase', cfg?.pattern); if (a && !a.mengenrabatt) return ''; } catch { /* egal */ }
  return tiers.filter((t) => +t.off > 0).map((t) => `${t.qty} Vasen −${t.off} %`).join(' · ');
}
/** Absicherung am Kaufpunkt (unter dem Sheet-Knopf, Linien-Icon): Neudruck + Herkunft; PayPal nur, wenn es in settings.paypal aktiv ist */
function trustHTML() {
  const pp = getPricing()?.paypal?.enabled ? ' · Bezahlen mit PayPal' : '';
  return `${ICON.shield}<span>Neudruck bei Transportschaden · Gedruckt in Deutschland${pp}</span>`;
}
/**
 * Signatur-Kachel: Aktions-Badge („−15 %“, ohne Countdown) NUR bei einer musterbezogenen Aktion, die Hammerschlag besser stellt als alles
 * andere — eine Aktion „auf alles“ steht schon in der Aktionsleiste; ein Badge nur auf dieser Kachel sähe dann wie ein Sonderangebot aus.
 */
function renderPatternPrices() {
  if (!getPricing()) return;
  try {
    const a = aktionFor('vase', 'gehaemmert');
    const global = aktionenActive().find((x) => !x.muster.length && (x.produkte === 'alle' || x.produkte === 'vase'));
    const show = !!a && a.muster.length > 0 && a.prozent > (global?.prozent || 0);
    const badge = $('.m-lead-badge');
    if (badge) { if (show) { badge.textContent = `−${a.prozent} %`; badge.hidden = false; } else badge.hidden = true; }
    for (const el of $$('.m-swatch')) { const p = patternByKey(el.dataset.key), sub = $('.m-sw-sub', el); if (p && sub) sub.textContent = swatchSub(p); }
  } catch { /* Preise noch nicht vollständig */ }
}

// ---------------------------------------------------------------------------
// Sheet-Inhalte
// ---------------------------------------------------------------------------
// Ein Verb für jeden Bestellweg: „Vase gestalten“ (Hero, Pille, FAQ-Ende) bzw. „Diese Vase gestalten“ im Sheet (übernimmt genau das Gezeigte)
const SHEET_CTA = 'Diese Vase gestalten ↗';
function formSheet(i, source) {
  const d = STUDIO_DESIGNS[i]; const cfg = designConfig(d);
  return {
    source, kind: 'form', key: d.id, image: designImage(d), alt: `${d.description}, KI-Produktfotografie auf Basis des 3D-Modells`,
    kicker: `FORM 0${i + 1}`, title: d.name, meta: `${d.description} · ${d.config.height / 10} cm · ${colorLabel(d.color)}`, text: FORM_TEXT[d.id] || d.description,
    price: () => priceHTML(cfg), facts: () => factsText(cfg), deal: () => dealText(cfg), trust: trustHTML, cta: SHEET_CTA, onCta: () => go(cfg),
  };
}
function patternSheet(key, source, chipIndex = leadChip) {
  const p = patternByKey(key); if (!p) throw new Error('Unbekanntes Muster ' + key);
  const kicker = p.tier === 'lead' ? 'OBERFLÄCHE · SIGNATUR' : p.tier === 'new' ? 'OBERFLÄCHE · NEU' : 'OBERFLÄCHE';
  // Spezifikation genau einmal: „Flasche · 15 cm · Terrakotta“ (Farbe folgt dem Finish-Chip bzw. der gezeigten Swatch-Farbe), Aufpreis nur, wo es einen gibt
  const meta = (st) => `${p.form} · ${p.size} cm · ${st && st.color ? colorLabel(st.color) : p.colorName}${surchargeLabel(p) ? ` · Muster ${surchargeLabel(p)}` : ''}`;
  // Swatch: ganze Vase im Hochformat (3D-Vorschau) als Hauptbild, Makro als rundes Detail; bis die Vorschau da ist, das Symbol
  const swatch = p.tier === 'swatch';
  return {
    source, kind: swatch && p.preview ? 'swatch' : 'pattern', key, image: p.preview || p.image, inset: swatch ? p.macro || null : null,
    alt: p.alt || `${p.name} – Flasche in ${p.colorName}${p.preview ? ', 3D-Vorschau aus dem Konfigurator-Modell' : ''}`,
    insetAlt: `${p.name} aus der Nähe`,
    svg: p.preview ? null : p.svg, ground: swatch ? null : p.ground, hex: p.hex, preview: !!p.preview,
    kicker, title: p.name, meta, text: p.text, chips: p.chips, chipIndex: p.chips ? chipIndex : 0,
    price: (st) => priceHTML(patternConfig(p, st.color)), facts: (st) => factsText(patternConfig(p, st.color)), deal: (st) => dealText(patternConfig(p, st.color)), trust: trustHTML,
    note: p.note, cta: SHEET_CTA, onCta: (st) => go(patternConfig(p, st.color)),
  };
}
/** Muster-Aufpreis aus settings.pricing.muster (nur gelesen) — „+ 3 €“ bzw. '' ohne Aufpreis; vor dem Laden der Preise der Datenwert */
function surchargeLabel(p) {
  const m = getPricing()?.muster; if (!m) return p.extra || '';
  const v = +m[p.key] || 0; return v > 0 ? `+ ${euro(v)}` : '';
}

/** Kür: Kachelbild fliegt ins Sheet (Klon, nur transform/opacity, 380 ms) */
function flipFrom(img) {
  if (!img || reduced.matches || !img.complete || !img.naturalWidth) return;
  try {
    const r0 = img.getBoundingClientRect(); if (!r0.width) return;
    const clone = document.createElement('img'); clone.src = img.currentSrc || img.src; clone.alt = ''; clone.className = 'm-flip';
    clone.style.cssText = `left:0;top:0;width:${r0.width}px;height:${r0.height}px;transform:translate(${r0.left}px,${r0.top}px)`;
    document.body.appendChild(clone);
    requestAnimationFrame(() => {
      const sh = sheetElement(); const media = sh && sh.querySelector('.m-sheet-media');
      if (!media) { clone.remove(); return; }
      const rs = sh.getBoundingClientRect(), rm = media.getBoundingClientRect();
      const top = (innerHeight - rs.height) + (rm.top - rs.top); // Ziel nach dem Hochfahren des Sheets
      const s = rm.width / r0.width;
      const cx = rm.left + rm.width / 2 - r0.width * s / 2, cy = top + rm.height / 2 - r0.height * s / 2;
      sh.classList.add('flipping');
      const anim = clone.animate([
        { transform: `translate(${r0.left}px,${r0.top}px) scale(1)`, opacity: 1, offset: 0 },
        { opacity: 1, offset: .55 },
        { transform: `translate(${cx}px,${cy}px) scale(${s})`, opacity: 0, offset: 1 },
      ], { duration: 380, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
      setTimeout(() => sh.classList.remove('flipping'), 200);
      anim.onfinish = () => { clone.remove(); sh.classList.remove('flipping'); };
      setTimeout(() => { clone.remove(); sh.classList.remove('flipping'); }, 600);
    });
  } catch { /* Kür — ohne Animation weiter */ }
}

// ---------------------------------------------------------------------------
// Hero „Lebendige Bühne“
// ---------------------------------------------------------------------------
let dots = null, swipeHint = null, useLabel = null, shownIndex = 0, heroPriceEl = null;
/** Position der gezeigten Form in der Bühnen-Reihenfolge (ORDER) — Punkte und Wischen zählen danach */
const heroPos = () => Math.max(0, ORDER.indexOf(heroIndex));
/** Hero-Knopf: fest „Diese Vase gestalten ↗“ (wie in den Sheets) — der Name der gezeigten Vase steht in der Kapsel und klein in der Preiszeile */
const HERO_CTA = 'Diese Vase gestalten';
/**
 * Preiszeile unter dem Knopf, im selben Takt wie Kapsel und Punkte: „Hammerschlag 23,99 € 28,22 € zzgl. Versand“ — genau der Preis, den
 * der Knopf übernimmt (shownPrice = Warenkorb-Rechnung), kein gefühlter Preissprung nach dem Tippen. Vor dem Laden der Preise nur der Name.
 */
function paintHeroPrice() {
  if (!heroPriceEl) return;
  const d = STUDIO_DESIGNS[shownIndex] || STUDIO_DESIGNS[0], p = shownPrice(designConfig(d));
  heroPriceEl.innerHTML = `<span class="mhp-name">${esc(d.name)}</span>` + (p ? ` <b${p.a ? ' class="aktion-price"' : ''}>${fmt(p.unit)}</b>${p.a ? ` <s>${fmt(p.uvp)}</s>` : ''} <small>zzgl. Versand</small>` : '');
}
/**
 * EIN Schreibvorgang für alles, was die gezeigte Vase benennt: Punkte, Kapsel-Typ („Form“/„Oberfläche“), Knopf-Ziel (aria-label) und
 * Preiszeile — synchron im hero-select-Ereignis, damit Kapsel, Knopf und Preis nie auseinanderlaufen (kein Timer, den Mesh-Arbeit aufhält).
 * shownIndex = die Vase, die der Knopf öffnet (Capture-Listener in initHeroLogic).
 */
function paintHero() {
  shownIndex = heroIndex;
  const d = STUDIO_DESIGNS[heroIndex] || STUDIO_DESIGNS[0];
  if (dots) { const pos = heroPos(); dots.forEach((x, i) => x.classList.toggle('on', i === pos)); }
  const idx = $('#hero-index'); if (idx) idx.textContent = KIND(heroIndex);
  if (useLabel && useLabel.textContent !== HERO_CTA) useLabel.textContent = HERO_CTA;
  $('#hero-use')?.setAttribute('aria-label', `${HERO_CTA} – ${d.name} im Konfigurator öffnen`);
  paintHeroPrice();
}
function initHeroDom() {
  art = $('#hero-art'); hero = $('.form-hero');
  art.dataset.world = canRun3D() ? 'deferred' : 'photo'; // studio.js liest das synchron beim Start
  const side = $('.hero-side'), use = $('#hero-use'), hint = $('#hero-hint'), intro = $('.hero-intro');
  side.insertBefore(use, hint);
  // Knopftext fest „Diese Vase gestalten ↗“; der Klick öffnet genau die gezeigte Vase (Capture-Listener in initHeroLogic)
  for (const n of use.childNodes) { if (n.nodeType === 3 && n.textContent.trim()) { useLabel = document.createElement('span'); useLabel.className = 'm-use-label'; n.replaceWith(useLabel); break; } }
  // Preiszeile der gezeigten Vase (ersetzt mobil die „ab …“-Zeile #hero-hint; die bleibt versteckt als Preisquelle der Pille)
  heroPriceEl = document.createElement('p'); heroPriceEl.className = 'm-hero-price'; hint.after(heroPriceEl);
  // 3D-Bühne startet mit ORDER[0] (Hammerschlag) — Punkte, Kapsel und Knopf-Ziel schon jetzt darauf (studio.js wählt die Form beim Start)
  if (art.dataset.world !== 'photo') heroIndex = ORDER[0];
  paintHero();
  // Trust-Zeile: drei gleich verteilte Chips mit Linien-Icons (die Emoji-Zeile #trust-row aus content.json bleibt für Desktop/Tablet, mobil per CSS aus)
  const trust = document.createElement('div'); trust.className = 'm-trust'; trust.setAttribute('aria-label', 'Pflanzenbasiertes PLA, gedruckt in Deutschland, Lieferung in 5 bis 8 Werktagen');
  trust.innerHTML = TRUST.map(([ic, t]) => `<span>${ic}${t}</span>`).join('');
  ($('#trust-row') || hint).after(trust);
  const foot = $('.hero-foot a'); if (foot) { foot.classList.add('hero-foot-link'); side.appendChild(foot); }
  // Kurze Displays: der erklärende Satz bleibt (einzeilig kurz statt versteckt), nur der Kicker weicht (CSS)
  if (innerHeight <= 760) { const sub = $('#hero-sub-m'); if (sub) sub.textContent = KURZ.subKurz; }
  // Positionsanzeige der Bühne (9 Punkte, nur Anzeige) + einmaliger Wisch-Hinweis — im Textfluss direkt über dem Kicker
  // (im ersten Intro-Block, der per CSS display:contents hat; NICHT als erstes Kind von .hero-intro, sonst erbt die Punkteleiste diese Regel)
  const dotRow = document.createElement('div'); dotRow.className = 'm-dots'; dotRow.setAttribute('aria-hidden', 'true');
  dotRow.innerHTML = STUDIO_DESIGNS.map(() => '<i></i>').join('') + '<span class="m-swipe-hint">← Wischen →</span>';
  // Nur mit laufender 3D-Bühne: im Poster-Modus (reduced motion, schwaches Gerät) gibt es nichts zu wischen
  if (art.dataset.world !== 'photo') {
    const kick = $('.cover-kicker'); if (kick) kick.before(dotRow); else intro.prepend(dotRow);
    dots = $$('i', dotRow); swipeHint = $('.m-swipe-hint', dotRow); paintHero();
  }
  dotRow.style.setProperty('--i', 0); $('.cover-kicker')?.style.setProperty('--i', 0); $('#hero-headline').style.setProperty('--i', 1);
  [...side.children].forEach((el, i) => el.style.setProperty('--i', i + 2));
  const chrome = () => hero.style.setProperty('--m-chrome', hero.offsetTop + 'px');
  chrome(); window.addEventListener('resize', chrome); window.addEventListener('load', chrome);
  const ab = $('#aktion-bar'); if (ab) new MutationObserver(chrome).observe(ab, { attributeFilter: ['hidden'] });
  // Höhe des Textblocks → --intro-h: Verlauf (CSS) und Kamera (studio.js) richten die Vasenfüße daran aus, auf jedem Display
  const introH = () => hero.style.setProperty('--intro-h', Math.round(intro.getBoundingClientRect().height) + 'px');
  introH(); new ResizeObserver(introH).observe(intro);
  const cap = $('.world-caption'); cap.setAttribute('role', 'button'); cap.tabIndex = 0; cap.setAttribute('aria-label', 'Details zur gezeigten Vase – wischen wechselt die Vase');
  // „Details ›“ als echtes Element (vorher ::after) — das ::after der Kapsel ist jetzt die unsichtbare 44-px-Trefferfläche (mobile.css)
  const more = document.createElement('span'); more.className = 'm-cap-more'; more.setAttribute('aria-hidden', 'true'); more.textContent = 'Details ›'; cap.appendChild(more);
  $('#hero-viewer').addEventListener('webglcontextlost', () => { try { sessionStorage.setItem('ovju-3d-lost', '1'); } catch { /* egal */ } });
}

/** Bühne als Menü: einen Schritt in der ORDER-Liste weiter/zurück (studio.js select() über die versteckten Form-Chips) */
function stepHero(dir) {
  const cur = ORDER.indexOf(heroIndex); const next = ORDER[(cur + dir + ORDER.length) % ORDER.length];
  $(`[data-shape="${next}"]`)?.click();
}
function hideSwipeHint() { if (swipeHint) swipeHint.classList.remove('show'); try { sessionStorage.setItem('ovju-swiped', '1'); } catch { /* egal */ } }

/** Meshes für den NÄCHSTEN Formwechsel im Leerlauf vorbauen lassen (studio.js, ovju:world-prefetch): Mitte + beide Nachbarn der nächsten Station */
let prefetchTimer = null;
function prefetchNext(delay) {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    const next = ORDER[(ORDER.indexOf(heroIndex) + 1) % ORDER.length], n = STUDIO_DESIGNS.length;
    window.dispatchEvent(new CustomEvent('ovju:world-prefetch', { detail: [next, (next + 1) % n, (next - 1 + n) % n] }));
  }, delay);
}
function initHeroLogic() {
  window.addEventListener('ovju:hero-select', (e) => {
    const i = STUDIO_DESIGNS.indexOf(e.detail);
    if (i < 0 || (!worldStarted && art.dataset.world !== 'photo')) return; // Startzustand von studio.js (Twist) vor dem 3D-Start ignorieren: die Bühne beginnt mit ORDER[0]
    heroIndex = i; paintHero(); if (worldReady) prefetchNext(1500);
  });
  // Hero-Knopf: öffnet die gezeigte Vase (studio.js würde den internen Index nehmen — der wechselt schon beim Überblenden)
  $('.hero-side').addEventListener('click', (e) => {
    if (!e.target.closest('#hero-use')) return;
    e.stopPropagation(); lastPointer = Date.now();
    go(designConfig(STUDIO_DESIGNS[shownIndex] || STUDIO_DESIGNS[0]));
  }, true);
  window.addEventListener('ovju:world-hold', (e) => { hold = !!e.detail; });
  const cap = $('.world-caption');
  const openCurrent = () => {
    const i = heroIndex;
    try { openSheet(i < 6 ? formSheet(i, cap) : patternSheet(['gehaemmert', 'skelett', 'koralle'][i - 6], cap)); } catch (err) { console.warn(err); }
  };
  cap.addEventListener('click', openCurrent);
  cap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCurrent(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); lastPointer = Date.now(); stepHero(e.key === 'ArrowRight' ? 1 : -1); buzz(); hideSwipeHint(); }
  });
  for (const s of ['#hero-viewer', '.world-caption', '#motion-toggle', '#hero-use']) $(s)?.addEventListener('pointerdown', () => { lastPointer = Date.now(); }, { passive: true }); // Finger auf dem Knopf: kein Formwechsel mehr unter dem Daumen
  // Horizontales Wischen über der Bühne = nächster/voriger Entwurf (vertikal scrollt weiter: touch-action pan-y)
  const viewer = $('#hero-viewer'); let sx = 0, sy = 0, sid = null;
  viewer.addEventListener('pointerdown', (e) => { sid = e.pointerId; sx = e.clientX; sy = e.clientY; }, { passive: true });
  viewer.addEventListener('pointerup', (e) => {
    if (e.pointerId !== sid) return; sid = null;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.3 && art.classList.contains('ready')) { stepHero(dx < 0 ? 1 : -1); buzz(10); hideSwipeHint(); }
  }, { passive: true });
  viewer.addEventListener('pointercancel', () => { sid = null; }, { passive: true });
  // Hero sichtbar? (Parallax, Formwechsel, CTA)
  const intro = $('.hero-intro');
  let tick = false;
  const parallax = () => {
    if (tick) return; tick = true;
    requestAnimationFrame(() => {
      tick = false; if (!heroInView) return;
      const y = Math.max(0, scrollY);
      art.style.transform = `translate3d(0,${Math.round(y * .35)}px,0)`;
      intro.style.opacity = String(Math.max(0, Math.min(1, 1 - y / 260)));
    });
  };
  const photo = art.dataset.world === 'photo';
  new IntersectionObserver((es) => {
    heroInView = es[es.length - 1].isIntersecting;
    if (!reduced.matches && !photo) { art.style.willChange = heroInView ? 'transform' : ''; if (heroInView) parallax(); }
    if (!heroInView && catalogNear && !worldReady) kickPreviews(); // schnell am Hero vorbeigescrollt, bevor die 3D startete → Vorschauen offscreen
    ctaCheck();
  }, { threshold: 0 }).observe(hero);
  if (!reduced.matches && !photo) window.addEventListener('scroll', parallax, { passive: true });
  if (photo) { // schwaches Gerät / reduced motion: Poster, keine Timer — Muster-Vorschauen als Standbilder (offscreen, nach dem Laden)
    const run = () => setTimeout(kickPreviews, 1200);
    if (document.readyState === 'complete') run(); else window.addEventListener('load', run, { once: true });
    return;
  }
  // 3D-Freigabe: sobald der Konfigurator geladen hat (kein zweiter WebGL-Aufbau während des ersten) — ohne weitere Wartezeit,
  // damit das Poster früh in die 3D übergeht (Twist-Komposition = Poster-Motiv)
  let started = false, safety = null;
  const start = () => {
    if (started) return; started = true; clearTimeout(safety);
    setTimeout(() => { worldStarted = true; $(`[data-shape="${ORDER[0]}"]`)?.click(); window.dispatchEvent(new Event('ovju:world-start')); }, 120); // erst die Startform wählen, dann baut studio.js die Welt darum
  };
  const loading = $('#loading');
  if (!loading || loading.classList.contains('hidden')) start();
  else {
    const mo = new MutationObserver(() => { if (loading.classList.contains('hidden')) { mo.disconnect(); start(); } });
    mo.observe(loading, { attributeFilter: ['class'] });
    safety = setTimeout(() => { mo.disconnect(); start(); }, 8000); // Sicherheitsnetz, falls das Studio hängt (feuert nur, wenn noch nicht gestartet)
  }
  // Formwechsel: 5 s nach dem 3D-Start zu Orbit, danach alle 8 s (Formen und Muster im Wechsel), 12 s Pause nach jeder Berührung.
  // Die Meshes des nächsten Wechsels baut studio.js vorher im Leerlauf (prefetchNext) — nicht in den ersten Sekunden nach dem Laden.
  const pauseBtn = $('#motion-toggle');
  const canSwitch = () => art.classList.contains('ready') && heroInView && !hold && !isSheetOpen() && !document.hidden && pauseBtn.getAttribute('aria-pressed') === 'false' && Date.now() - lastPointer >= 12000;
  const tickSwitch = () => { const ok = canSwitch(); if (ok) stepHero(1); setTimeout(tickSwitch, ok ? 8000 : 1500); };
  window.addEventListener('ovju:world-ready', () => {
    worldReady = true; if (catalogNear) kickPreviews(); else setTimeout(kickPreviews, 6000);
    prefetchNext(3200);
    setTimeout(tickSwitch, 5000);
    // Einmaliger Wisch-Hinweis neben den Punkten (nicht bei reduced motion, nicht nach einem Wisch in dieser Sitzung)
    let swiped = false; try { swiped = !!sessionStorage.getItem('ovju-swiped'); } catch { /* egal */ }
    if (!swiped && swipeHint) { setTimeout(() => { if (!heroInView) return; swipeHint.classList.add('show'); setTimeout(() => swipeHint.classList.remove('show'), 4200); }, 1200); }
  }, { once: true });
}

// ---------------------------------------------------------------------------
// Katalog „Formen“ (#formen)
// ---------------------------------------------------------------------------
function initForms() {
  const grid = $('#design-grid');
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('.design-card'); if (!b) return;
    let o; try { o = formSheet(+b.dataset.design, b); } catch (err) { console.warn(err); return; } // Fallback: studio.js springt direkt in den Konfigurator
    e.stopPropagation(); e.preventDefault();
    flipFrom(b.querySelector('img'));
    openSheet(o);
  }, true);
  const eb = $('#formen .eyebrow'); if (eb) eb.textContent = 'Formen';
  const rh = $('#formen .rail-hint'); if (rh) rh.textContent = '06 Ausgangspunkte · antippen für Details';
  whenFilled(grid, () => {
    const own = $('.design-card:nth-child(6) .design-title>span', grid); if (own) own.textContent = 'Eigene Linie';
    $$('.design-card', grid).slice(2, 6).forEach((c, i) => reveal(c, (i % 2) * 60)); // erste Reihe (Verkaufsinhalt) nie versteckt
  });
}

// ---------------------------------------------------------------------------
// Katalog „Oberflächen“ (#m-oberflaechen, nur mobil erzeugt, nach #formen)
// ---------------------------------------------------------------------------
/** Swatch-Kachel: 3D-Vorschau (ganze Flasche in der Musterfarbe, 4:5, Streiflicht) — bis dahin das Muster-Symbol in der Musterfarbe */
function swatchMedia(p) {
  if (p.preview) return `<img src="${p.preview}" width="480" height="600" decoding="async" alt="${esc(p.name)} – Flasche in ${esc(p.colorName)}, 3D-Vorschau aus dem Konfigurator-Modell">`;
  return p.svg;
}
/** Zweite Zeile unter dem Swatch-Namen: Aufpreis („+ 3 €“) oder „inklusive“ */
const swatchSub = (p) => surchargeLabel(p) || 'inklusive';

function initPatterns() {
  const lead = MOBILE_PATTERNS.find((p) => p.tier === 'lead'), news = MOBILE_PATTERNS.filter((p) => p.tier === 'new'), sw = MOBILE_PATTERNS.filter((p) => p.tier === 'swatch');
  // Zwischengespeicherte 3D-Vorschauen (diese Sitzung) sofort verwenden
  for (const p of sw) { try { const o = JSON.parse(sessionStorage.getItem(PREV_KEY + p.key) || 'null'); if (o && /^data:image\//.test(o.full || '')) { p.preview = o.full; p.macro = o.macro || null; } } catch { /* egal */ } }
  const sec = document.createElement('section'); sec.id = 'm-oberflaechen'; sec.className = 'm-catalog';
  sec.innerHTML = `<div class="wrap"><p class="eyebrow">Oberflächen</p><h2>Nicht glatt.<br><em>Charakterstark.</em></h2><span class="rail-hint">09 Muster · antippen</span>` +
    // Signatur-Kachel: Bild + Titel (als Overlay mit Verlauf auf dem Foto — nie unter der klebenden Pille) im Knopf; die Finish-Wahl steht als eigene
    // Knopfgruppe (≥ 40 px Ziele) daneben – kein Bedienelement im Bedienelement. Foto lazy/niedrige Priorität: es steht ~2 Bildschirme tief
    `<div class="m-lead-wrap"><button class="m-lead" type="button" data-key="${lead.key}" aria-label="${esc(lead.name)} – Details"><div class="m-img"><img src="${lead.image}" width="1122" height="1402" loading="lazy" fetchpriority="low" decoding="async" alt="${esc(lead.alt)}"><img class="m-img2" aria-hidden="true" alt="" decoding="async"><span class="m-pill">Signatur</span><span class="m-badge m-lead-badge" hidden></span><div class="m-lead-title"><h3>${esc(lead.name)}</h3><span class="m-lead-sub">Gehämmert · Kupfer, Matt oder Silber</span></div></div></button>` +
    `<div class="m-finish" role="group" aria-label="Finish wählen">${lead.chips.map((c, i) => `<button type="button" data-finish="${i}" class="${i === 0 ? 'on' : ''}" style="--hex:${c.hex}" aria-label="${esc(c.label)}" aria-pressed="${i === 0}"></button>`).join('')}</div></div>` +
    `<div class="m-pair">${news.map((p) => `<button class="m-tile" type="button" data-key="${p.key}" aria-label="${esc(p.name)} – Details"><div class="m-img"><img src="${p.image}" width="1024" height="1280" loading="lazy" decoding="async" alt="${esc(p.alt)}"><span class="m-pill m-pill-new">Neu</span></div><h3>${esc(p.name)}</h3><span>${esc(p.sub)}</span></button>`).join('')}</div>` +
    // Swatches: Katalog-Beschriftung wie die Paar-Kacheln (Serifen-Name links, zweite Zeile Aufpreis bzw. „inklusive“)
    `<div class="m-swatches">${sw.map((p) => `<button class="m-swatch" type="button" data-key="${p.key}" aria-label="${esc(p.name)} – Details" style="--m-hex:${p.hex}"><div class="m-img${p.svg && !p.preview ? ' is-svg' : ''}">${swatchMedia(p)}</div><h3>${esc(p.name)}</h3><small class="m-sw-sub">${esc(swatchSub(p))}</small></button>`).join('')}</div></div>`;
  $('#formen').after(sec);
  // Finish-Knöpfe: Crossfade + Chip-Index fürs Sheet (Farbe wandert in den CTA)
  const imgA = $('.m-lead img:not(.m-img2)', sec), imgB = $('.m-img2', sec), fdots = $$('.m-finish button', sec);
  $('.m-finish', sec).addEventListener('click', (e) => {
    const d = e.target.closest('[data-finish]'); if (!d) return;
    leadChip = +d.dataset.finish; const c = lead.chips[leadChip];
    fdots.forEach((x, k) => { x.classList.toggle('on', k === leadChip); x.setAttribute('aria-pressed', String(k === leadChip)); });
    crossfade(imgA, imgB, c.image, `Gehämmerte Vase in ${c.label}, 3D-gedruckt mit sichtbaren Schichten`);
    buzz();
  });
  sec.addEventListener('click', (e) => {
    const b = e.target.closest('.m-lead,.m-tile,.m-swatch'); if (!b) return;
    let o; try { o = patternSheet(b.dataset.key, b, leadChip); } catch (err) { console.warn(err); return; }
    flipFrom(b.querySelector('img:not(.m-img2)')); // Symbol-Kacheln (noch ohne Vorschau) haben kein Bild → kein Flug
    openSheet(o);
  });
  // Reveal nur für Zweitrang-Kacheln (Überschrift + Signatur-Kachel stehen sofort)
  $$('.m-tile', sec).forEach((t, i) => reveal(t, i * 60));
  $$('.m-swatch', sec).forEach((t, i) => reveal(t, (i % 3) * 60));
  idle(renderPatternPrices);
  onAktionEnde(() => { renderPatternPrices(); paintHeroPrice(); });
}

/** 3D-Vorschau eines Swatches ({ full, macro }) in Kachel (sanft eingeblendet) + Sheet einsetzen und für die Sitzung merken */
function applyPreview(p, out) {
  if (!out || !out.full) return;
  p.preview = out.full; p.macro = out.macro || null;
  try { sessionStorage.setItem(PREV_KEY + p.key, JSON.stringify({ full: p.preview, macro: p.macro })); } catch { /* Speicher voll – egal */ }
  const b = $(`.m-swatch[data-key="${p.key}"]`); if (!b) return;
  const box = $('.m-img', b); box.classList.remove('is-svg'); box.innerHTML = swatchMedia(p);
  const img = $('img', box); if (img && !reduced.matches) { img.classList.add('m-prev-in'); requestAnimationFrame(() => requestAnimationFrame(() => img.classList.remove('m-prev-in'))); }
}
const PREV_KEY = 'ovju-mprev6-'; // Version im Schlüssel: alte Vorschauen (Runde 5: Zylinder-Makro) werden nicht wiederverwendet
const snapshotJob = (p) => ({ ...(p.view || {}), config: p.config, hex: p.hex, finish: 'matt' });

/**
 * Swatch-Vorschauen erzeugen — genau ein Weg zur Zeit (prevBusy), fehlende zuerst in Kachelreihenfolge:
 *  · Hero-3D läuft (worldReady): nacheinander im Hero-Kontext (studio.js, ovju:world-snapshot), kein zweiter WebGL-Kontext; Start 6 s nach
 *    dem 3D-Start (Startphase frei) oder sofort, wenn der Katalog in die Nähe kommt; je Muster ein Leerlauf-Fenster.
 *  · Kein Hero-3D (Poster-Modus, reduced motion) ODER Katalog in der Nähe, bevor die 3D überhaupt gestartet ist (schnell vorbeigescrollt):
 *    je Muster EIN Standbild in einem kurzlebigen Offscreen-Kontext (mobile-preview.js), danach verworfen.
 *  · Sehr schwaches Gerät / Kontextverlust: das Muster-Symbol bleibt.
 */
let prevBusy = false, catalogNear = false;
const missingPreviews = () => MOBILE_PATTERNS.filter((p) => p.tier === 'swatch' && !p.preview);
function kickPreviews() {
  if (prevBusy || !missingPreviews().length) return;
  const hero3D = worldReady && art.dataset.world !== 'photo';
  if (hero3D) {
    prevBusy = true;
    const next = () => {
      const p = missingPreviews()[0];
      if (!p || art.dataset.world === 'photo') { prevBusy = false; if (p) kickPreviews(); return; } // 3D inzwischen abgebrochen → offscreen weiter
      window.dispatchEvent(new CustomEvent('ovju:world-snapshot', { detail: { ...snapshotJob(p), cb: (out) => { if (out && out.full) applyPreview(p, out); else p.preview = ''; setTimeout(() => (out ? idle(next, 1200) : (prevBusy = false)), 120); } } }));
    };
    idle(next, 1500);
    return;
  }
  // Offscreen nur, wenn die Hero-3D nicht (mehr) kommt: Poster-Modus oder Katalog schon in der Nähe, während die 3D noch nicht gestartet ist
  if (art.dataset.world !== 'photo' && !(catalogNear && hero.getBoundingClientRect().bottom < 0)) return;
  if ((navigator.deviceMemory ?? 4) <= 2 || contextLost()) return;
  prevBusy = true;
  idle(async () => {
    const todo = missingPreviews();
    const outs = await renderPreviewsOffscreen(todo.map(snapshotJob));
    outs.forEach((o, i) => applyPreview(todo[i], o));
    prevBusy = false;
  }, 3000);
}
function initPreviewWatch() {
  const sw = $('.m-swatches'); if (!sw) return;
  const io = new IntersectionObserver((es) => { if (!es.some((e) => e.isIntersecting)) return; catalogNear = true; kickPreviews(); if (!missingPreviews().length) io.disconnect(); }, { rootMargin: '0px 0px 1200px 0px', threshold: [0, .5, 1] });
  io.observe(sw);
}

// ---------------------------------------------------------------------------
// Klebender CTA — zu jedem Scrollpunkt höchstens EIN Bestellknopf, immer gleich beschriftet: „Vase gestalten ↓/↑ · ab 21,17 €“ (Preisfeed aus
// #hero-hint, ohne Streichpreis; nur der Pfeil zeigt, wo das Studio liegt). Weicht der App-Shell-Leiste (#mobile-bar, inkl. ihrer Ausblend-
// Transition), dem Konfigurator selbst, jedem sichtbaren Inline-Bestellknopf, der Ruhezone Schritt 3 → FAQ, Sheet, Vollbild und dem Seitenende;
// hell über dem dunklen Footer statt versteckt.
// ---------------------------------------------------------------------------
let ctaWrap, ctaLabel, ctaPrice, konfEl, ctaShown = false, below = false, holdUntil = 0, holdTimer = null, ctaCheck = () => {};
/** Sichtbarkeit direkt aus dem DOM — kein gemerkter Zustand, der veralten kann */
function syncCta() {
  if (!ctaWrap) return;
  const b = document.body.classList, H = innerHeight;
  const heroOut = hero.getBoundingClientRect().bottom <= 0;
  const atEnd = scrollY + H > document.documentElement.scrollHeight - 72; // ganz unten: Fußzeilen-Links frei lassen
  const inlineIn = $$('.m-inline-cta').some((el) => { const q = el.getBoundingClientRect(); return q.bottom > 0 && q.top < H; }); // Inline-Bestellknopf irgendwo im Bild → weichen
  const barShown = b.contains('has-mbar') && !b.contains('m-konf-out'); // App-Shell-Leiste sichtbar (mobile.js), außer sie ist unterhalb der Bühne unterdrückt
  // Studio selbst kommt ins Bild (Überschrift bis Bühne): es IST der Bestellweg — die Pille würde nur die Konfigurator-Überschrift verdecken
  const kr = konfEl.getBoundingClientRect(); const konfNear = kr.top < H - 40 && kr.bottom > H * .4;
  const quiet = quietBand(H); // Lieferversprechen (Schritt 3) und FAQ-Fragen liegen im Pillen-Streifen → weichen
  const footer = $('footer'); const onFooter = !!footer && footer.getBoundingClientRect().top < H - 70; // Footer überlappt den CTA-Streifen → helle Variante
  // Signatur-Kachel: ihr Titel („Hammerschlag“) liegt unten auf dem Foto — solange er durch den Pillen-Streifen läuft, weicht die Pille
  const lt = $('.m-lead-title')?.getBoundingClientRect(); const overLead = !!lt && lt.height > 0 && lt.bottom > H - 86 && lt.top < H - 6;
  const show = heroOut && !atEnd && !inlineIn && !barShown && !konfNear && !quiet && !overLead && !b.contains('m-sheet-open') && !b.contains('no-scroll');
  ctaWrap.classList.toggle('compact', below); ctaWrap.classList.toggle('on-footer', onFooter);
  paintFade(H); // setzt auch on-dark (dunkle Sektion unter der Pille → helle Pille)
  if (show === ctaShown) return;
  if (show && Date.now() < holdUntil) { clearTimeout(holdTimer); holdTimer = setTimeout(syncCta, holdUntil - Date.now() + 10); return; } // Leiste gleitet noch hinaus → erst danach einblenden
  ctaShown = show;
  ctaWrap.classList.toggle('hide', !show); ctaWrap.classList.toggle('show', show);
}
/**
 * Weicher Verlauf hinter der Pille (mobile.css .m-cta-wrap::before): Farbe = Hintergrund der Sektion, die gerade unten durchläuft — über dem
 * dunklen Formen-Katalog dunkelgrün, über dem Footer dessen Farbe, sonst var(--bg). So verschwinden Bildunterschriften weich statt hart
 * unter der Pille abgeschnitten zu werden. Farbe je Sektion gemerkt (Theme-Wechsel leert den Speicher, s. initCta).
 */
let fadeCache = new WeakMap(), fadeLast = '';
function sectionBg(el) {
  while (el && el.parentElement && el.parentElement !== document.body && el.parentElement.tagName !== 'MAIN') el = el.parentElement;
  if (!el || el === document.body || el === document.documentElement) return '';
  if (fadeCache.has(el)) return fadeCache.get(el);
  const c = getComputedStyle(el).backgroundColor; const v = c && c !== 'transparent' && !/,\s*0\)$/.test(c) ? c : '';
  fadeCache.set(el, v); return v;
}
/** Relative Luminanz (0–1) einer CSS-Farbe „rgb(r, g, b)“ — für die Wahl der Pillen-Variante */
function lum(c) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || ''); if (!m) return 1;
  const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  return .2126 * f(+m[1]) + .7152 * f(+m[2]) + .0722 * f(+m[3]);
}
function paintFade(H) {
  let col = '', photo = false;
  try {
    const at = (y) => document.elementsFromPoint(innerWidth / 2, y).find((e) => !ctaWrap.contains(e));
    const hit = at(H - 41); col = sectionBg(hit); // Mitte der Pille (unten 14 px, 54 px hoch)
    photo = !!hit && !!hit.closest('img, canvas, .m-img, .design-image, .galerie-item'); // über einem Foto gibt es keinen Text zu schützen → kein milchiger Schleier
    if (!photo && sectionBg(at(H - 104)) !== col) photo = true; // Sektionsgrenze im Verlaufsband (hell ↔ dunkel): kein Schleier in der falschen Farbe
  } catch { /* egal */ }
  // Dunkle Sektion (Formen-Katalog, Footer) irgendwo hinter der Pille (oben, Mitte oder unten): helle Variante (Creme-Pille, dunkle Schrift,
  // heller Ring) — an der Grenze dunkel → hell lieber hell auf hell (Schatten trägt) als dunkel auf dunkel (halb verschwunden)
  let dark = false;
  try { for (const y of [H - 62, H - 41, H - 20]) { const e = document.elementsFromPoint(innerWidth / 2, y).find((x) => !ctaWrap.contains(x)); const c = sectionBg(e); if (c && lum(c) < .2) { dark = true; break; } } } catch { /* egal */ }
  ctaWrap.classList.toggle('on-dark', dark);
  col = col || 'var(--bg)';
  if (col !== fadeLast) { fadeLast = col; ctaWrap.style.setProperty('--m-cta-fade', col); }
  ctaWrap.classList.toggle('no-fade', photo);
}
/**
 * Ruhezone (Lesestrecke): von der Karte „Drei Schritte“ (mit dem Lieferversprechen in Schritt 3) bis zum Ende der FAQ („Mehr Fragen“).
 * Liegt irgendetwas davon im unteren 90-px-Streifen, bleibt die Pille weg — eine durchgehende Zone statt vieler Einzelziele, damit sie beim
 * Scrollen nicht flackert. Direkt danach übernimmt der Inline-Knopf „Vase gestalten“ am FAQ-Ende.
 */
function quietBand(H) {
  const start = $('#steps'), end = $('.m-faq-more') || $('#faq-list');
  if (!start || !end) return false;
  const a = start.getBoundingClientRect(), z = end.getBoundingClientRect();
  return a.top + 24 < H && z.bottom > H - 90;
}
/** Ein Label für alles: „Vase gestalten“ + Richtungspfeil (Studio unten ↓ / oben ↑), Preis immer „ab …“ ohne Streichpreis */
function paintCta() {
  if (!ctaWrap) return;
  ctaLabel.textContent = `Vase gestalten ${below ? '↑' : '↓'}`;
  ctaPrice.innerHTML = heroFromHTML();
  const inl = $('.m-inline-cta-primary b'); if (inl) inl.innerHTML = heroFromHTML();
}
function scrollToStudio() { buzz(12); $('#konfigurator').scrollIntoView({ behavior: reduced.matches ? 'instant' : 'smooth' }); }
function initCta() {
  ctaWrap = document.createElement('div'); ctaWrap.className = 'm-cta-wrap';
  ctaWrap.innerHTML = `<button class="m-cta" id="m-cta" type="button"><span class="m-cta-label">Vase gestalten ↓</span><b class="m-cta-price"></b></button><button class="m-cta-cart" id="m-cta-cart" type="button" hidden aria-label="Warenkorb">${ICON.cart}<i>0</i></button>`;
  document.body.insertBefore(ctaWrap, $('#toast'));
  ctaLabel = $('.m-cta-label', ctaWrap); ctaPrice = $('.m-cta-price', ctaWrap);
  // Preis-Spiegel aus #hero-hint (app.js rendert „Vasen ab 21,17 € <s>24,90 €</s> · STL …“)
  const hint = $('#hero-hint');
  const mirror = () => {
    const span = hint.querySelector(':scope > span'); if (!span) return;
    const t = span.firstChild; if (t && t.nodeType === 3) t.textContent = t.textContent.replace(/^Vasen\s+/, '');
    const clone = span.cloneNode(true); clone.querySelector('.hh-stl')?.remove();
    const html = clone.innerHTML.trim(); if (html) heroPriceHTML = html;
    paintCta(); paintHeroPrice(); idle(renderPatternPrices);
  };
  new MutationObserver(mirror).observe(hint, { childList: true, subtree: true });
  mirror();
  // Modus (über/unter der Bühne), Unterdrückung der App-Shell-Leiste unterhalb des Konfigurators und Sichtbarkeit im Scroll-Tick (rAF-gedrosselt)
  const stage = $('.stage'), konf = $('#konfigurator'), grid = $('#konfigurator .config-grid') || konf; konfEl = konf;
  let tick = false;
  const check = () => {
    if (tick) return; tick = true;
    requestAnimationFrame(() => {
      tick = false; const r = stage.getBoundingClientRect(), H = innerHeight;
      const bl = r.bottom < H * .4 ? true : r.top > H * .5 ? false : below;
      if (bl !== below) { below = bl; paintCta(); }
      // Unterkante des Konfigurator-Rahmens über 55 % der Viewport-Höhe → vom Panel ist kein Bedienelement mehr zu sehen, die Preisleiste der App-Shell
      // stünde über „Von der Idee zu dir“: weich ausfahren (mobile.css), Pille übernimmt
      document.body.classList.toggle('m-konf-out', grid.getBoundingClientRect().bottom < H * .55);
      syncCta();
    });
  };
  ctaCheck = check;
  window.addEventListener('scroll', check, { passive: true }); window.addEventListener('resize', check, { passive: true }); check();
  $('#m-cta', ctaWrap).addEventListener('click', scrollToStudio);
  // Body-Klassen: Leiste kommt/geht (has-mbar, m-konf-out) → Pille erst nach der Ausblend-Transition der Leiste (300 ms) zeigen;
  // Toast der App-Shell nur, solange die Bühne im Bild ist (sonst hängt er über dem Katalog)
  let wasBar = false;
  new MutationObserver(() => {
    const b = document.body.classList; const bar = b.contains('has-mbar') && !b.contains('m-konf-out');
    if (wasBar && !bar) { holdUntil = Date.now() + 340; $('#toast')?.classList.remove('show'); }
    wasBar = bar;
    syncCta();
  }).observe(document.body, { attributeFilter: ['class'] });
  new MutationObserver(() => { fadeCache = new WeakMap(); fadeLast = ''; syncCta(); }).observe(document.documentElement, { attributeFilter: ['class'] }); // Theme-Wechsel sitzt auf <html>
  // Warenkorb-Kreis
  const cc = $('#cart-count'), cart = $('#m-cta-cart', ctaWrap); let last = parseInt(cc?.textContent, 10) || 0;
  const syncCart = () => {
    const n = parseInt(cc.textContent, 10) || 0;
    cart.hidden = n === 0; cart.querySelector('i').textContent = n;
    if (n > last) { cart.classList.remove('bump'); void cart.offsetWidth; cart.classList.add('bump'); }
    last = n;
  };
  if (cc) { new MutationObserver(syncCart).observe(cc, { childList: true, characterData: true, subtree: true }); syncCart(); }
  cart.addEventListener('click', () => { buzz(); $('#cart-btn')?.click(); });
}

// ---------------------------------------------------------------------------
// Rest: Kopftexte, Handy-Kurztexte, Icons, Aktionsleiste, Hinweis-Kapsel im Panel, FAQ eingeklappt, ein Inline-CTA am Ende, Reveal, Ankunft
// ---------------------------------------------------------------------------
function initRest() {
  for (const el of $$('main .eyebrow')) { for (const n of el.childNodes) { if (n.nodeType === 3 && /^\d\d \/ /.test(n.textContent)) { n.textContent = n.textContent.replace(/^\d\d \/ /, ''); break; } } }
  const k = $('#konfigurator .eyebrow'); if (k) k.textContent = 'Konfigurator';
  const s = $('#sogehts .eyebrow'); if (s) s.textContent = 'Von der Idee zu dir';
  // Kurztexte (ganze Sätze) statt per CSS abgeschnittener Desktop-Texte
  const gs = $('#galerie-sub'); if (gs) gs.textContent = KURZ.galerie;
  whenFilled($('#steps'), () => { $$('#steps .step').forEach((u, i) => { const p = $('p', u); if (p && KURZ.steps[i]) p.textContent = KURZ.steps[i]; reveal(u, i * 60); }); });
  // „Zuhause“-Reihe: Motive nach Farbe abwechseln (gelb, blau, gelb statt zweimal gelb nebeneinander) — Farbe aus dem Dateinamen, nur die
  // Reihenfolge im DOM (app.js und die Galerie-Daten bleiben unberührt)
  whenFilled($('#galerie-grid'), () => {
    const grid = $('#galerie-grid'), items = $$('.galerie-item', grid);
    const tone = (el) => (/[-_](gelb|senf|blau|staubblau|gruen|grün|salbei|rot|rosa|lila|lavendel|weiss|weiß|elfenbein|schwarz|grau|orange|terrakotta|braun|mokka)\b/i.exec($('img', el)?.getAttribute('src') || '') || [])[1]?.toLowerCase() || '';
    const pool = [...items], out = [];
    while (pool.length) { const last = out.length ? tone(out[out.length - 1]) : null; let k = pool.findIndex((el) => !last || !tone(el) || tone(el) !== last); if (k < 0) k = 0; out.push(pool.splice(k, 1)[0]); }
    if (out.some((el, i) => el !== items[i])) out.forEach((el) => grid.appendChild(el));
    out.forEach((u, i) => reveal(u, i * 60));
  });
  whenFilled($('#faq-list'), () => {
    const list = $('#faq-list');
    // Der STL-Download (vorher als Fachbegriff in jedem Sheet) lebt jetzt hier und im Konfigurator — als Antwort auf die eigentliche Frage
    const stl = document.createElement('details'); stl.className = 'card m-faq-stl';
    stl.innerHTML = '<summary>Bekomme ich eine Vase oder eine Datei?</summary><p>Eine echte Vase: Wir drucken sie nach deinem Design und schicken sie dir. Wer selbst einen 3D-Drucker hat, kann sein Design im Konfigurator zusätzlich als STL-Datei herunterladen – ohne Aufpreis.</p>';
    const ds = $$('details', list); if (ds[3]) ds[3].after(stl); else list.appendChild(stl);
    const n = $$('details', list).length - 4;
    let anchor = list;
    if (n > 0) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'm-faq-more'; btn.textContent = `Mehr Fragen (${n}) ↓`;
      list.after(btn); anchor = btn;
      btn.addEventListener('click', () => { list.classList.add('m-all'); btn.remove(); buzz(); });
    }
    // Einziger Inline-Bestellknopf der Seite: nach der FAQ, vollbreit mit Preis (Rückweg am Ende des Funnels); die Pille weicht, solange er im Bild ist
    const b = document.createElement('button'); b.type = 'button'; b.className = 'm-inline-cta m-inline-cta-primary'; b.innerHTML = `Vase gestalten <b>${heroFromHTML()}</b>`;
    b.addEventListener('click', scrollToStudio); anchor.after(b);
  });
  // Aktionsleiste: Kurz-Countdown („noch 1 Tag 11 Std“) statt abgeschnittenem Langtext — aktion.js frischt Stellen mit data-kurz selbst so auf;
  // Linien-Icon statt 🔥; Aktionsname ruhig gesetzt (keine „!!!“) und weggelassen, wenn er nur den Geltungsbereich wiederholt
  // („Auf Alles: −15 % auf alles“ → „−15 % auf alles“). Nur Anzeige auf dem Handy — die Daten im Admin bleiben unverändert.
  const ab = $('#aktion-bar');
  if (ab) {
    const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
    const tidy = () => {
      const el = $('.ab-count', ab);
      if (el && !('kurz' in el.dataset)) {
        el.dataset.kurz = '';
        try { const a = aktionenActive().find((x) => x.id === el.dataset.aktionId) || aktionenActive()[0]; if (a) el.textContent = aktionTextKurz(a); } catch { /* egal */ }
      }
      const fire = $('.ab-fire', ab); if (fire && !fire.querySelector('svg')) fire.innerHTML = ICON.tag;
      const txt = $('.ab-text', ab), name = txt && $('b', txt);
      if (name && !('tidy' in name.dataset)) {
        name.dataset.tidy = '';
        const clean = name.textContent.replace(/\s*!{2,}/g, '').trim();
        const scope = [...txt.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
        if (!clean || norm(scope).includes(norm(clean))) { const sep = name.nextSibling; if (sep && sep.nodeType === 3) sep.textContent = sep.textContent.replace(/^:\s*/, ''); name.remove(); }
        else name.textContent = clean;
      }
    };
    tidy(); new MutationObserver(tidy).observe(ab, { childList: true });
  }
  // Rechtlicher Hinweis „Für Trockenblumen …“: nicht mehr über den Form-Chips, sondern als aufklappbare Ein-Zeilen-Kapsel am Panel-Ende
  // (Volltext bleibt dort, im Footer und im Checkout-Hinweis erhalten)
  const note = $('#vase-note'), panel = $('#konfigurator .panel');
  if (note && panel) {
    const det = document.createElement('details'); det.className = 'm-note';
    det.innerHTML = `<summary><i class="m-ico" aria-hidden="true">${ICON.info}</i>Für Trockenblumen · i. d. R. wasserfest <span>Details</span></summary>`;
    det.appendChild(note); panel.appendChild(det);
    // mobile.js blendet #vase-note je Tab aus (hidden-Attribut) – in der Kapsel steuert allein das Aufklappen, also den Hinweis dort immer sichtbar halten
    note.hidden = false;
    new MutationObserver(() => { if (note.hidden) note.hidden = false; }).observe(note, { attributeFilter: ['hidden'] });
  }
  // Höhe der Tab-Leiste → --m-tabs-h: Bühne und Tabs rollen beim Verlassen des Konfigurators gemeinsam aus (mobile.css)
  const tabs = $('#mtabs');
  if (tabs) { const th = () => { const h = tabs.offsetHeight; if (h) $('#konfigurator').style.setProperty('--m-tabs-h', h + 'px'); }; th(); new ResizeObserver(th).observe(tabs); }
  // Ankunft im Konfigurator: auf der Bühne landen (nicht auf der Sektions-Überschrift) – negativer Scroll-Rand in Höhe des Kopfes
  const sec = $('#konfigurator'), stage = $('.stage');
  const landing = () => { if (!sec || !stage) return; const d = stage.getBoundingClientRect().top - sec.getBoundingClientRect().top; if (d > 0) sec.style.scrollMarginTop = `${8 - Math.round(d)}px`; };
  landing(); window.addEventListener('load', landing); window.addEventListener('resize', landing); setTimeout(landing, 1500);
  window.addEventListener('ovju:studio-design', () => {
    buzz(12);
    setTimeout(() => { document.body.classList.add('m-arrive'); setTimeout(() => document.body.classList.remove('m-arrive'), 800); }, 350);
    // Landung nachjustieren: das weiche Scrollen von app.js endet bei Layoutwechseln (Bühne klebt/schrumpft) mitunter einige Pixel vor der Bühne
    const settle = () => { const d = stage.getBoundingClientRect().top - 8; if (Math.abs(d) > 14 && Math.abs(d) < 140 && !isSheetOpen()) window.scrollBy({ top: d, behavior: reduced.matches ? 'instant' : 'smooth' }); };
    setTimeout(settle, 1100); setTimeout(settle, 2100);
  });
}

// ---------------------------------------------------------------------------
// Eine Icon-Sprache: Topbar, Bühne (Druck-Ampel, Dreh-Hinweis), Preisleiste und Footer „Gut zu wissen“ auf Linien-Icons (18 px, currentColor)
// ---------------------------------------------------------------------------
function initIcons() {
  for (const el of [$('#theme-btn'), $('#account-btn'), $('#cart-btn'), $('#print-badge'), $('#stage-hint .sh-mob'), $('#mobile-bar .mb-code'), $('#mb-download')]) iconize(el);
  // Kopfzeile „Listen“: Lesezeichen statt Listen-Symbol (das las sich wie ein Hamburger-Menü), Name „Merkliste“
  const lists = $('.topbar .lists-btn');
  if (lists) { iconize(lists, null, ICON.bookmark); lists.setAttribute('aria-label', 'Merkliste'); lists.title = 'Merkliste'; }
  // Footer „Gut zu wissen“: nur die rechtlichen Hinweise (Trockenblumen/Voronoi, Standfestigkeit) — „Pflanzenbasiertes PLA“ steht schon im Hero
  // (keine Dopplung)
  const col = $$('footer .footer-col').find((c) => /Gut zu wissen/.test($('h4', c)?.textContent || ''));
  if (col) {
    col.classList.add('m-facts');
    $$('p', col).forEach((p) => { if (/Pflanzenbasiertes PLA/.test(p.textContent)) p.classList.add('m-dup'); else iconize(p); });
  }
}

// ---------------------------------------------------------------------------
// Toast der App-Shell (mobile.js): kurz, mit Icon statt Emoji; Übergabe „Dein Entwurf ist im Konfigurator bereit“ → „Im Studio bereit“ (1,8 s).
// Solange er steht, weicht der Dreh-Hinweis (body.m-toast, mobile.css) — erst Bestätigung, dann Geste, nie zwei Pillen übereinander.
// Schließt nach > 150 px eigenem Scrollen (Landungs-Scroll der ersten Sekunde zählt nicht) oder wenn die Bühne das Bild verlässt (initCta).
// ---------------------------------------------------------------------------
function initToast() {
  const t = $('#toast'); if (!t) return;
  const HANDOVER = 'Dein Entwurf ist im Konfigurator bereit';
  let mine = '', shown = false, y0 = null, timers = [];
  const clear = () => { timers.forEach(clearTimeout); timers = []; y0 = null; };
  const hide = () => t.classList.remove('show');
  const sync = () => {
    const txt = t.textContent.trim();
    if (t.innerHTML !== mine && txt) {
      // neuer Inhalt von mobile.js: umschreiben (die eigene Änderung löst einen weiteren, dann harmlosen Durchlauf aus)
      const m = txt.match(EMOJI_START);
      const body = txt === HANDOVER ? 'Im Studio bereit' : m ? txt.slice(m[0].length) : null;
      const ic = m && iconFor(m[0]) === ICON.alert ? ICON.alert : ICON.check; // Warnungen behalten ihr Warn-Icon, alles andere ist eine Bestätigung
      if (body !== null) { t.innerHTML = `${ic}<span>${esc(body)}</span>`; mine = t.innerHTML; }
      else mine = t.innerHTML;
      shown = false; // als neue Meldung behandeln (Timer neu)
    }
    const on = t.classList.contains('show');
    // Hinweis erst zurück, wenn der Toast ausgeblendet ist (Toast-Fade 250 ms) — kein Überblenden zweier Pillen
    if (on) document.body.classList.add('m-toast');
    else setTimeout(() => { if (!t.classList.contains('show')) document.body.classList.remove('m-toast'); }, 280);
    if (!on) { shown = false; clear(); return; }
    if (shown) return;
    shown = true; clear();
    if (t.textContent.trim() === 'Im Studio bereit') timers.push(setTimeout(hide, 1800));
    timers.push(setTimeout(() => { y0 = scrollY; }, 1000));
  };
  new MutationObserver(sync).observe(t, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
  window.addEventListener('scroll', () => { if (y0 !== null && Math.abs(scrollY - y0) > 150) hide(); }, { passive: true });
}

// ---------------------------------------------------------------------------
// Dreh-Hinweis der Konfigurator-Bühne: zeigen, sobald die Bühne ≥ 0,9 s zu ≥ 60 % im Bild steht (nicht beim bloßen Vorbeiscrollen) und bei jeder
// Ankunft über einen „… gestalten“-Knopf (nach dem Toast „Im Studio bereit“); je 4 s, beim ersten Berühren der Vase sofort und endgültig weg.
// app.js blendet ihn 9 s nach dem Laden aus — auf dem Handy ist die Bühne dann meist noch gar nicht im Bild.
// ---------------------------------------------------------------------------
function initStageHint() {
  const hint = $('#stage-hint'), stage = $('.stage'), viewer = $('#viewer'); if (!hint || !stage) return;
  let touched = false, dwelt = false, timer = null, dwell = null;
  const hide = () => { clearTimeout(timer); hint.classList.remove('m-show'); };
  const show = () => { if (touched) return; hint.classList.add('m-show'); clearTimeout(timer); timer = setTimeout(hide, 4000); };
  const io = new IntersectionObserver(([e]) => {
    clearTimeout(dwell);
    if (dwelt || touched || e.intersectionRatio < .6) return;
    dwell = setTimeout(() => { dwelt = true; io.disconnect(); show(); }, 900);
  }, { threshold: [0, .6] });
  io.observe(stage);
  window.addEventListener('ovju:studio-design', () => { if (touched) return; hide(); setTimeout(show, 2400); }); // Toast (1,8 s) zuerst, dann Geste
  viewer?.addEventListener('pointerdown', () => { touched = true; io.disconnect(); clearTimeout(dwell); hide(); }, { passive: true });
}

function init() {
  document.body.classList.add('m-home');
  if (!reduced.matches) revealIO = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('visible'); revealIO.unobserve(e.target); } }), { threshold: 0, rootMargin: '0px 0px 160px 0px' });
  initHeroDom();
  initForms();
  initPatterns();
  initPreviewWatch();
  initCta();
  initHeroLogic();
  initRest();
  initIcons();
  initToast();
  initStageHint();
  // Sicherheitsnetz: was jetzt schon im Bild ist, nie verdeckt lassen (belasteter Main-Thread, schnelles Wischen)
  revealVisible(); setTimeout(revealVisible, 1200); window.addEventListener('load', () => setTimeout(revealVisible, 300));
}

if (SMALL) { try { init(); } catch (err) { console.warn('Mobile Startseite: Aufbau unvollständig', err); } }
