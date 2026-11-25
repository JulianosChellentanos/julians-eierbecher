// formsam — Konfigurator: 3D-Szene, UI-Bindings, Bestellung (Vasen; Eierbecher vorerst deaktiviert — Schalter in produkte.js,
// die Eierbecher-Logik bleibt für die Reaktivierung erhalten)
import * as THREE from 'three';
import { STUDIO_DESIGNS, designConfig as studioDesignConfig } from './studio-designs.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TextGeometry } from '../vendor/TextGeometry.js';
import {
  sampleProfile,
  DEFAULTS, PRODUCTS, PATTERNS, FLOWS, FONTS, RIMS, TEXT_STYLES, FONT_RULES, fontAllowsStyle, isIntegratedTextStyle, FRONT_TEXT_ARC,
} from './geometry.js';
import { downloadSTL } from './exporter.js';
import { makeEgg, makeGrass } from './scenes.js';
import { RGBELoader } from '../vendor/RGBELoader.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { exportExt } from './modelfactory.js';
import { requestModel, buildModelOnce, exportModel, onBuildStatus, warmUp, builderMode, preloadFonts } from './model-builder.js';
import {
  initCart, addToCart, getPricing, fmt, fmtPlus, discountTeaser, setCodeProvider, getCart,
  setColors, unitParts, unitPrice, colorSurcharge, patternSurcharge, eierbecherAktiv, fillShopInfo,
} from './cart.js';
import { produktAktiv, EIERBECHER_HINWEIS } from './produkte.js';
import { initDesignCodes, loadFromURL, loadDesign, saveDesign, uploadThumb, formatCode, normalizeCode, stripURLParam } from './designcode.js';
import { initLists, openList, loadListFromURL, createListFromCart } from './lists.js';
import { initAuth } from './auth.js';
import { activateTab, initMobileShell, updateMobileTabs, showToast, bumpCart, animateMoney, setMobilePrice, IS_MOBILE } from './mobile.js';
import { aktionFor, aktionMuster, musterListLabel, aktionText, aktionTextKurz, onAktionEnde, referenzpreis, referenzText, aktionProzentGueltig, versandHTML, ustText } from './pricing.js';
import { initAktionBar } from './aktion.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const IS_SMALL = window.matchMedia('(max-width: 980px)').matches;
const IS_PHONE = window.matchMedia('(max-width: 700px)').matches; // Handy-Layout (mobile.css): nur für die Live-Bühne im Konfigurator
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
let inlayMesh = null; // Farbschrift: Einlage im zweiten Filament
let currentInfo = null;
let userInteracted = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
/** Auswahlzustand setzen: Klasse active (Optik) UND aria-pressed (Screenreader) — an allen Auswahlknöpfen des Konfigurators */
const aktiv = (el, on) => { el.classList.toggle('active', on); el.setAttribute('aria-pressed', String(on)); };
/** Zahl mit deutschem Komma für Anzeigen („2,5 mm“, „7,5 mm“) — die Werte selbst bleiben Zahlen (niemand liest die Ausgaben zurück) */
const dez = (v, stellen = 1) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen });
const mmText = (v) => Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 });
// Grundbereich des Schriftgrößen-Reglers (mm) — markActiveFont() hebt die Untergrenze je Schrift später an
const TEXTSIZE_RANGE = [+$('#s-textsize').min, +$('#s-textsize').max];

// ---------------------------------------------------------------------------
// Content laden & Seite füllen
// ---------------------------------------------------------------------------
async function loadContent() {
  content = await (await fetch('content.json')).json();
  // Kopf- und Footer-Logo sind Inline-SVG (#fs-logo in index.html) — hier kein Text mehr hineinschreiben
  if (content.brand.title) document.title = content.brand.title;
  $('#brand-tagline').textContent = content.brand.tagline;
  $('#hero-headline').textContent = content.hero.headline;
  $('#hero-sub').textContent = content.hero.subheadline;
  $('#hero-cta').textContent = content.hero.cta;
  $('#footer-text').textContent = content.footer.text;

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
  // Trust-Zeile: lange Fassung für Desktop/Tablet, kurze Fassung (trustKurz) für das Handy – CSS blendet je Breite eine davon ein
  if (h.trust) $('#trust-row').innerHTML = h.trust.map((t, i) => { const k = h.trustKurz?.[i]; return `<span>${k ? `<span class="tr-long">${t}</span><span class="tr-short">${k}</span>` : t}</span>`; }).join('');

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
  setColors(colors); // Farbaufpreise (aufpreis je Farbe) für Preislogik & Warenkorb
  // Matt zuerst, dann Glanz/Metallic — mit Finish-Effekt auf dem Swatch; Aufpreis als kleines Badge
  const order = { matt: 0, glanz: 1, metall: 2 };
  colors.sort((a, b) => (order[a.finish || 'matt'] ?? 0) - (order[b.finish || 'matt'] ?? 0));
  // Farbangaben aus den Einstellungen (Admin) nur maskiert bzw. als geprüfter Farbwert ins HTML
  $('#swatches').innerHTML = colors.map((c) => {
    const sur = Math.max(0, Number(c.aufpreis) || 0);
    const fin = escAttr(c.finish || 'matt'), hex = cssHex(c.hex);
    return `
    <button class="swatch sw-${fin}" data-id="${escAttr(c.id)}" data-hex="${hex}" data-name="${escAttr(c.name)}" data-finish="${fin}"
      style="--sw:${hex}" title="${escAttr(c.name)}${(c.finish || 'matt') !== 'matt' ? ' · ' + escAttr(FINISH_LABEL[c.finish]) : ''}${sur > 0 ? ' · ' + fmtPlus(sur) + ' je Stück' : ''}"><span></span>${sur > 0 ? `<i class="sur sur-sw">${fmtPlus(sur)}</i>` : ''}</button>`;
  }).join('');
  $$('#swatches .swatch').forEach((b) => b.addEventListener('click', () => setColor(b.dataset)));
  setColor(colors[0]);
  // Schriftfarbe (Stil „Farbschrift“): gleiche Palette, zweites Filament
  $('#text-swatches').innerHTML = colors.map((c) => `
    <button class="swatch sw-${escAttr(c.finish || 'matt')}" data-id="${escAttr(c.id)}" data-hex="${cssHex(c.hex)}" data-name="${escAttr(c.name)}" data-finish="${escAttr(c.finish || 'matt')}"
      style="--sw:${cssHex(c.hex)}" title="${escAttr(c.name)}"><span></span></button>`).join('');
  $$('#text-swatches .swatch').forEach((b) => b.addEventListener('click', () => { setTextColor(b.dataset.id); rebuild(); }));
  setTextColor(state.textColor || 'tiefschwarz', true);
}

/**
 * Produktschalter anwenden (nach dem Laden der Preise): Die Seite ist statisch „nur Vasen“. Bietet der Server den
 * Eierbecher an (/api/pricing → produkte.eierbecher = true), kommen die Textvarianten, FAQ-Einträge und
 * data-produkt-Elemente aus content.json → eierbecher dazu. Solange der Schalter aus ist, sagt kein Text „Eierbecher“.
 */
function applyProduktSchalter() {
  const eb = eierbecherAktiv();
  document.body.classList.toggle('mit-eierbecher', eb);
  if (!eb) return;
  const v = content.eierbecher || {};
  // Textvarianten: Schlüssel = Element-ID, optional „id|attribut“ (z. B. favicon|href); <meta> bekommt content
  for (const [key, txt] of Object.entries(v.texte || {})) {
    const [id, attr] = key.split('|');
    const el = document.getElementById(id);
    if (!el) continue;
    if (attr) el.setAttribute(attr, txt);
    else if (el.tagName === 'META') el.setAttribute('content', txt);
    else el.textContent = txt;
  }
  if (Array.isArray(v.faq) && v.faq.length) {
    $('#faq-list').insertAdjacentHTML('afterbegin', v.faq.map((f) => `<details class="card"><summary>${f.q}</summary><p>${f.a}</p></details>`).join(''));
  }
}

/** HTML-sichere Attribut-Werte */
const escAttr = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Farbwert für style-Attribute: nur #rgb/#rrggbb, sonst neutrales Grau */
const cssHex = (h) => (typeof h === 'string' && h.length <= 7 && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(h) ? h : '#cccccc');
/** Streichpreis nach § 11 PAngV: niedrigster Preis der letzten 30 Tage, gekennzeichnet per title/aria-label (enge Stellen) */
function refStrikeHTML(ref, cls = 'uvp') {
  const t = escAttr(referenzText(ref.tiefst));
  return `<s class="${cls}" title="${t}" aria-label="${t}">${fmt(ref.tiefst)}</s>`;
}
/** „ab 24,90 €“ = günstigste Konfiguration (Muster „glatt“, keine Aufpreise) — gilt dafür eine Aktion: Aktionspreis in
 *  Akzentfarbe; ohne Bezugspreis nur der Aktionspreis. Eine Aktion nur auf Gehämmert ändert das „ab“ nicht.
 *  zeile = true (Produktkarten): dazu der durchgestrichene 30-Tage-Tiefstpreis (referenzpreis in pricing.js) mit SICHTBARER
 *  Kennzeichnung als kleine Zeile darunter und der Versandhinweis. Ohne zeile (Hero-Hinweis, Produkt-Tabs) kein Streichpreis:
 *  dort wäre er nur per title gekennzeichnet — auf Touch-Geräten unsichtbar (§ 11 PAngV) */
function abPriceHTML(product, zeile = false) {
  const single = getPricing()?.products?.[product]?.single;
  if (single == null) return '';
  const item = { product, config: { pattern: 'glatt' } };
  const ship = zeile ? `<small class="ship-zeile">${versandHTML({ kurz: true })}</small>` : '';
  if (!aktionFor(product, 'glatt')) return `ab ${fmt(single)}${ship}`;
  const ref = referenzpreis(item);
  if (!ref) return `ab ${fmt(unitPrice(item))}${ship}`;
  if (!zeile) return `ab <span class="aktion-price">${fmt(unitPrice(item))}</span>`;
  return `ab <span class="aktion-price">${fmt(unitPrice(item))}</span> ${refStrikeHTML(ref)}<small class="ref-zeile">${referenzText(ref.tiefst)}</small>${ship}`;
}
/**
 * Bessere Aktion mit einem anderen Muster dieses Produkts (Punkt 8c): aktuelle Konfiguration nicht (oder geringer)
 * rabattiert, aber eine laufende Aktion würde mit einem anderen Muster greifen → { aktion, pattern, keys } | null.
 * pattern = erstes Muster (in Musterreihenfolge), mit dem genau diese Aktion gilt; keys = alle solchen Muster (für den Text).
 */
function aktionAlternative(product, pattern, currentProzent = 0) {
  let best = null;
  for (const key of Object.keys(PATTERNS)) {
    if (key === pattern) continue;
    const a = aktionFor(product, key);
    if (!a || a.prozent <= currentProzent) continue;
    if (!best || a.prozent > best.aktion.prozent) best = { aktion: a, pattern: key, keys: [key] };
    else if (a.id === best.aktion.id) best.keys.push(key);
  }
  return best;
}
function renderHeroHint() {
  const el = $('#hero-hint'); if (!el) return;
  try {
    const parts = [`Vasen ${abPriceHTML('vase')}`];
    if (eierbecherAktiv()) parts.push(`Eierbecher ${abPriceHTML('eierbecher')}`); // nur, wenn der Server das Produkt anbietet
    // Versandhinweis direkt hinter den ab-Preisen (§ 6 PAngV); mobil spiegelt mobile-home.js nur die Preise (ohne .hh-versand/.hh-stl)
    el.innerHTML = `<span>${parts.join(' · ')}<span class="hh-versand"> ${versandHTML({ kurz: true })}</span><span class="hh-stl"> · STL-Download für deinen eigenen Drucker inklusive</span></span>`;
  } catch { /* Preise noch nicht geladen */ }
}
// Live-Preis der gezeigten Form („wie gezeigt 29,88 €“) im Knopf der Formenwelt – nur auf dem Handy sichtbar (CSS); gleiche Rechnung wie Warenkorb/Server.
// Bewusst ohne „ab“: der Grundpreis („Vasen ab 24,90 €“) steht schon in der Preiszeile darüber, hier zählt der Preis dieser Konfiguration.
// Der Listener muss synchron auf Modul-Ebene stehen: studio.js läuft nach app.js und schickt den Startzustand sofort.
let heroDesign = STUDIO_DESIGNS[0];
window.addEventListener('ovju:hero-select', (e) => { heroDesign = e.detail; renderHeroUsePrice(); });
function renderHeroUsePrice() {
  const el = $('#hero-use-price'); if (!el || !getPricing()) return;
  try {
    const cfg = studioDesignConfig(heroDesign);
    el.innerHTML = `<i>wie gezeigt</i> ${fmt(unitPrice({ product: cfg.product || 'vase', saucer: false, config: cfg, color: cfg.color }))}`;
    el.hidden = false;
  } catch { el.hidden = true; }
}
/** „ab …“-Preise im Produkt-Umschalter und auf den Showcase-Karten (mit Streichpreis während einer Aktion) */
function renderProductPrices() {
  if (!getPricing()) return;
  $$('.product-tab[data-product] small').forEach((el) => { el.innerHTML = abPriceHTML(el.closest('.product-tab').dataset.product); });
  $$('.showcase-price[data-product]').forEach((el) => { el.innerHTML = abPriceHTML(el.dataset.product, true); });
}
function renderPrices() {
  renderHeroHint();
  renderHeroUsePrice();
  renderProductPrices();
  if (!getPricing()) return; // Preise noch nicht geladen
  // Gleiche Aufschlüsselung wie Warenkorb & Server (pricing.js): Grund + Untersetzer + Gravur + Farbschrift + Muster + Farbe + Größe.
  // currentConfig() leert den Text, wenn die Gravur per Regel deaktiviert ist → dann auch kein Gravur-Aufpreis.
  const item = { product: state.product, saucer: state.saucer, config: currentConfig(), color: state.color, colorName: state.colorName };
  const q = unitParts(item);
  const total = q.unit; // = unitPrice(item): während einer Aktion der reduzierte Stückpreis
  // Aktion je Konfiguration (Produkt + Muster): Streichpreis/Badge nur, wenn genau diese Konfiguration rabattiert ist — und nur
  // gegenüber dem niedrigsten Preis der letzten 30 Tage (§ 11 PAngV, referenzpreis); ohne Bezugspreis nur der aktuelle Preis
  const aktion = q.aktionProzent > 0 ? aktionFor(state.product, state.pattern) : null;
  const ref = aktion ? referenzpreis(item) : null;
  const labels = [
    q.muster > 0 ? `${fmt(q.muster)} ${PATTERNS[state.pattern] || 'Muster'}` : '',
    q.gravur > 0 ? `${fmt(q.gravur)} Gravur` : '',
    q.farbschrift > 0 ? `${fmt(q.farbschrift)} Farbschrift` : '',
    q.farbe > 0 ? `${fmt(q.farbe)} Farbe ${state.colorName}` : '',
    q.untersetzer > 0 ? `${fmt(q.untersetzer)} Untersetzer` : '',
    q.groesse > 0 ? `${fmt(q.groesse)} Größe` : '',
  ].filter(Boolean);
  animateMoney($('#price'), total, fmt);
  animateMoney($('#mb-price'), total, fmt);
  animateMoney($('#cta-mini-price'), total, fmt); // kompakte Desktop-Leiste: nur der aktuelle Preis (ohne Streichpreis/Badge)
  // Versand (und bei Kleinunternehmern die USt.) direkt am Preis, vor „In den Warenkorb“ (§ 6 PAngV) — lang im Konfigurator,
  // kurz „zzgl. Versand“ in der Handy-Leiste (der Link führt zu den Beträgen)
  const shipEl = $('#price-ship'), mbShip = $('#mb-ship'), ust = ustText();
  const shipHTML = [ust, versandHTML()].filter(Boolean).join(' · ');
  if (shipEl && shipEl.innerHTML !== shipHTML) shipEl.innerHTML = shipHTML;
  const mbShipHTML = versandHTML({ kurz: true });
  for (const el of [mbShip, $('#cta-mini-ship')]) if (el && el.innerHTML !== mbShipHTML) el.innerHTML = mbShipHTML;
  // Aktion mit Bezugspreis: Aktionspreis in Akzentfarbe, 30-Tage-Tiefstpreis durchgestrichen daneben, Badge „−16 %“ (bezogen
  // auf den Tiefstpreis), Zeile „Aktionspreis · endet in …“ und darunter die Kennzeichnung „Niedrigster Preis der letzten 30 Tage: …“
  $('#price').classList.toggle('aktion', !!ref);
  $('#mb-price').classList.toggle('aktion', !!ref);
  const uvpEl = $('#price-uvp'), pBadge = $('#price-badge'), aLine = $('#price-aktion'), mbUvp = $('#mb-uvp'), refEl = $('#price-ref'), mbRef = $('#mb-ref');
  if (ref) {
    const t = referenzText(ref.tiefst);
    for (const el of [uvpEl, mbUvp]) { el.textContent = fmt(ref.tiefst); el.title = t; el.setAttribute('aria-label', t); }
    pBadge.textContent = `−${ref.prozent}\u00a0%`;
    pBadge.title = `−${ref.prozent} % gegenüber dem niedrigsten Preis der letzten 30 Tage`;
    aLine.innerHTML = `🔥 Aktionspreis · <span class="aktion-countdown" data-aktion-id="${aktion.id}">${aktionText(aktion)}</span>`;
    for (const el of [refEl, mbRef]) if (el) el.textContent = t;   // Konfigurator-Preisbereich (Desktop) und Mobile-Leiste
  }
  uvpEl.hidden = pBadge.hidden = aLine.hidden = mbUvp.hidden = !ref;
  for (const el of [refEl, mbRef]) if (el) el.hidden = !ref;
  // Hinweis-Knopf „🔥 −30 % auf Gehämmert · endet in 2 Tage“: eine laufende Aktion greift (besser) mit einem anderen
  // Muster dieses Produkts — Klick schaltet das Muster um (pattern-btn-Klick: Standardtiefe, Rebuild, Preis).
  // Die Prozentzahl bezieht sich auf den 30-Tage-Tiefstpreis genau dieser Konfiguration mit dem anderen Muster; hat sie keinen
  // Bezugspreis (Preis nicht unter dem Tiefstpreis), entfällt der Hinweis.
  let alt = aktionAlternative(state.product, state.pattern, aktion ? aktion.prozent : 0);
  const altRef = alt ? referenzpreis({ ...item, config: { ...item.config, pattern: alt.pattern } }) : null;
  if (!altRef || (ref && altRef.prozent <= ref.prozent)) alt = null;
  const hint = $('#price-aktion-hint');
  if (hint) {
    if (alt) {
      hint.dataset.pattern = alt.pattern;
      hint.innerHTML = `🔥 −${altRef.prozent}\u00a0% auf ${musterListLabel(alt.keys, 'oder')} · <span class="aktion-countdown" data-aktion-id="${alt.aktion.id}">${aktionText(alt.aktion)}</span>`;
      hint.title = `${alt.aktion.name}: auf ${PATTERNS[alt.pattern]} umschalten – ${referenzText(altRef.tiefst)}`;
    }
    hint.hidden = !alt;
  }
  // Mobile-Leiste: auf schmalen Handys reicht der Platz nur für die Summe der Aufpreise („inkl. 9,50 € Aufpreise“);
  // während einer Aktion steht dort Badge + Countdown in Kurzform „noch 1 Tag 4 Std“ (die Zeile ist auf ~130 px begrenzt,
  // „endet in …“ würde per Ellipsis abgeschnitten; das Badge blendet die CSS bei ≤ 430 px aus). Die Aufpreise stehen im Panel.
  // Ohne Aktion, aber mit besserer Aktion für ein anderes Muster: kurzer Hinweis „🔥 −30 % auf Gehämmert“ (Tipp schaltet um).
  const surSum = Math.round((q.muster + q.gravur + q.farbschrift + q.farbe + q.untersetzer + q.groesse) * 100) / 100;
  const narrow = window.innerWidth <= 430 && labels.length > 1;
  if (ref) $('#mb-sub').innerHTML = `<span class="aktion-badge" title="${escAttr(referenzText(ref.tiefst))}">−${ref.prozent}\u00a0%</span> <span class="aktion-countdown" data-kurz data-aktion-id="${aktion.id}">${aktionTextKurz(aktion)}</span>`;
  else if (alt) $('#mb-sub').innerHTML = `<button type="button" class="mb-aktion-hint" data-pattern="${alt.pattern}" title="${escAttr(referenzText(altRef.tiefst))}">🔥 −${altRef.prozent}\u00a0% auf ${musterListLabel(alt.keys, 'oder')}</button>`;
  else setMobilePrice(undefined, labels.length ? (narrow ? `inkl. ${fmt(surSum)} Aufpreise` : `inkl. ${labels.join(' · ')}`) : 'pro Stück');
  // Mengenrabatt-Teaser — entfällt während einer Aktion ohne „Mengenrabatt zusätzlich“
  $('#price-hint').textContent = aktion && !aktion.mengenrabatt ? 'Während der Aktion kein zusätzlicher Mengenrabatt' : discountTeaser(state.product);
  // Aufpreis-Zeile unter dem Preis („inkl. 3,00 € Lamellen · 2,00 € Farbschrift · 1,00 € Farbe Gold“)
  const badge = $('#price-size');
  badge.hidden = !labels.length;
  if (labels.length) badge.textContent = `inkl. ${labels.join(' · ')}${q.groesse > 0 ? ' (XL-Format = mehr Filament & Druckzeit)' : ''}`;
}

function setColor({ id, hex, name, finish }) {
  const f = finish || 'matt';
  state.color = id; state.colorHex = hex; state.colorName = name; state.colorFinish = f;
  $$('#swatches .swatch').forEach((b) => aktiv(b, b.dataset.id === id));
  // Farbaufpreis (aus /api/colors) mit in die Farbanzeige („Gold · metallic · +1 €“)
  const sur = colorSurcharge(id, name);
  const surTxt = sur > 0 ? ` · ${fmtPlus(sur)}` : '';
  $('#color-name').textContent = (f === 'matt' ? name : `${name} · ${FINISH_LABEL[f]}`) + surTxt;
  const fn = $('#farbe-name'); if (fn) fn.textContent = `– ${name} · ${FINISH_LABEL[f]}${surTxt}`;
  material.color.set(hex);
  Object.assign(material, FINISH_PROPS[f] || FINISH_PROPS.matt);
  material.needsUpdate = true;
  document.documentElement.style.setProperty('--accent-live', hex);
  farbschriftHinweis();
  renderPrices(); // Farbaufpreis fließt in den Live-Preis (vor dem Laden der Preise ein No-op)
  entwurfMerken();
}
/** Farbschrift in derselben Farbe wie die Vase hebt sich kaum ab — nur ein Hinweis, keine Sperre (Ton in Ton kann gewollt sein) */
function farbschriftHinweis() {
  const el = $('#text-color-same'); if (!el) return;
  el.hidden = !(state.textStyle === 'farbe' && state.textColor && state.textColor === state.color);
}

/** Schriftfarbe für die Farbschrift (zweites Filament) */
function setTextColor(id, silent = false) {
  const c = (content?.colors || []).find((x) => x.id === id) || (content?.colors || [])[0];
  if (!c) return;
  state.textColor = c.id;
  $$('#text-swatches .swatch').forEach((b) => aktiv(b, b.dataset.id === c.id));
  $('#text-color-name').textContent = `– ${c.name}`;
  farbschriftHinweis();
  inlayMaterial.color.set(c.hex);
  Object.assign(inlayMaterial, FINISH_PROPS[c.finish || 'matt'] || FINISH_PROPS.matt);
  inlayMaterial.needsUpdate = true;
  if (!silent) showToast(`🎨 Schriftfarbe: ${c.name}`);
  entwurfMerken();
}

// ---------------------------------------------------------------------------
// 3D-Szene
// ---------------------------------------------------------------------------
const canvas = $('#viewer');
// Ohne WebGL (abgeschaltete Hardwarebeschleunigung, alte Treiber, Suchmaschinen-Renderer) wirft der Renderer — dann läuft die Seite
// ohne 3D weiter: Inhalte, Preise, Warenkorb und Konto laden normal, die Bühne zeigt statt „Lade 3D-Studio …“ eine Erklärung (zeigeOhne3D).
// Szene, Kamera und Materialien brauchen kein WebGL; alles, was zeichnet, prüft renderer bzw. nutzt zeichne().
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
} catch (err) { renderer = null; console.warn('3D-Vorschau nicht verfügbar (kein WebGL):', err?.message || err); }
const zeichne = () => renderer?.render(scene, camera);

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
controls.addEventListener('start', () => { userInteracted = true; $('#stage-hint')?.classList.add('gone'); });
setTimeout(() => $('#stage-hint')?.classList.add('gone'), 9000);

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
// Handy (IS_PHONE): weicher, heller Schatten statt hartem grauem „Teller“ unter der Vase — PCF mit Radius (PCFSoft ignoriert radius),
// kleine Schattenkarte (breite, weiche Kante; 1/16 des Grafikspeichers), Deckkraft 0,10. Desktop/Tablet unverändert.
if (IS_PHONE) {
  if (renderer) renderer.shadowMap.type = THREE.PCFShadowMap;
  keyLight.shadow.mapSize.set(512, 512);
  keyLight.shadow.radius = 10;
  ground.material.opacity = 0.10;
}

// Finishes wie bei echten PLA-Sorten: matt, glossy, Silk/Metallic
const FINISH_PROPS = {
  matt: { roughness: 0.62, metalness: 0.0, clearcoat: 0.0, clearcoatRoughness: 0.5 },
  glanz: { roughness: 0.16, metalness: 0.04, clearcoat: 0.75, clearcoatRoughness: 0.18 },
  metall: { roughness: 0.28, metalness: 0.92, clearcoat: 0.0, clearcoatRoughness: 0.5 },
};
export const FINISH_LABEL = { matt: 'matt', glanz: 'glänzend', metall: 'metallic' };
const material = new THREE.MeshPhysicalMaterial({ color: state.colorHex, ...FINISH_PROPS.matt });
const inlayMaterial = material.clone(); // Farbschrift-Einlage (zweites Filament)

// Neutrale Studio-Umgebung → Metall & Glanz reflektieren auch ohne HDRI-Szene
let roomEnv = null;
if (renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}

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
// Handy (IS_PHONE): die Holz-Textur (≈ 210 KB) erst mit der ersten Holz-Szene laden (applyScene) — die Startszene „Studio“ braucht sie nicht;
// bis sie da ist, trägt die Tischplatte einen Holzton (kein schwarzes Aufblitzen einer leeren Textur)
function loadWoodMap(onLoad) {
  const tex = new THREE.TextureLoader().load('env/wood_table_001_diff_1k.jpg', onLoad);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1.6, 1);
  return tex;
}
const woodMap = IS_PHONE ? null : loadWoodMap();
let woodRequested = !IS_PHONE;
const tableTop = new THREE.Mesh(
  new THREE.BoxGeometry(1200, 26, 680),
  new THREE.MeshStandardMaterial(IS_PHONE ? { color: 0x9c7652, roughness: 0.72 } : { map: woodMap, roughness: 0.72 })
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
  if (!woodRequested && cfg.surface === 'wood') { // nur Handy (woodRequested ist sonst von Anfang an true)
    woodRequested = true;
    loadWoodMap((tex) => { tableTop.material.map = tex; tableTop.material.color.set(0xffffff); tableTop.material.needsUpdate = true; });
  }
  propsGroup.visible = cfg.props;
  keyLight.intensity = cfg.keyI;
  keyLight.color.set(cfg.keyColor || 0xfff2e0);
  for (const [name, mesh] of Object.entries(surfaces)) mesh.visible = cfg.surface === name;
  ground.visible = !cfg.surface;
  material.envMapIntensity = cfg.envI ?? 1;
  $$('.scene-chip').forEach((c) => aktiv(c, c.dataset.scene === key));
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

// Kamera so setzen, dass das Objekt in Höhe UND Breite passt (auch mobil).
// live = Live-Bühne (nicht Foto-Shooting/Produktfoto): auf dem Handy (≤ 700 px) ~24 % weiter weg und leicht nach oben gerückt — Hals mit Luft unter „formsam / LIVE STUDIO“,
// Fuß über Dreh-Hinweis und den (seit Runde 7 höheren, 44-px-tippbaren) Szenen-Chips (mobile.css); Tablet/Desktop unverändert.
function frameCamera(live = true) {
  const H = currentInfo ? currentInfo.height : 58;
  let rM = currentInfo ? currentInfo.maxRadius : 24;
  if (saucerInfo && state.saucer) rM = Math.max(rM, saucerInfo.outerRadius * 0.82);
  // Ei ragt über den Becher hinaus, wenn Deko-Props sichtbar sind
  const eggExtra = (propsGroup.visible && currentInfo?.product === 'eierbecher') ? 40 : 0;
  // Mobile: mehr Luft oben/unten, damit Badges & Chips das Modell nicht verdecken
  const halfH = (H * 0.62 + 8 + eggExtra) * (IS_SMALL ? 1.22 : 1) * (live && IS_PHONE ? 1.24 : 1), halfW = rM * 1.65;
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = Math.max(halfH / t, halfW / (t * camera.aspect));
  controls.target.set(0, H * (live && IS_PHONE ? 0.46 : 0.5), 0); // Handy: Blickziel etwas unter die Mitte → Vase rückt ein Stück hoch, Fuß frei über Hinweis und Chips
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1) dir.set(0.55, 0.35, 1);
  dir.normalize();
  camera.position.copy(controls.target).addScaledVector(dir, dist);
}

function resize() {
  if (!renderer) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!userInteracted) frameCamera();
  }
}
new ResizeObserver(resize).observe(canvas);

let stageVisible = true;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
new IntersectionObserver(([entry]) => { stageVisible = entry.isIntersecting; }).observe(canvas);

function animate() {
  requestAnimationFrame(animate);
  if (!stageVisible || document.hidden) return;
  resize();
  if (!userInteracted && cupMesh && !reducedMotion.matches) cupGroup.rotation.y += 0.004;
  controls.update();
  zeichne();
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

// Druckbarkeits-Ampel: Kennzahlen { sil, worst, frac55 } rechnet printcheck.js zusammen mit dem Modell im Hintergrund-Thread
function updatePrintBadge(stats, info) {
  const el = $('#print-badge');
  const { sil, worst, frac55 } = stats;
  let cls, txt, tip;
  if (sil > 62) {
    cls = 'p-bad'; txt = '🔶 Form kragt stark aus – Silhouette flacher ziehen';
    tip = `Die Grundform hängt bis ${sil.toFixed(0)}° über – im Formen-Editor sanftere Übergänge wählen.`;
  } else if (info.openCells) {
    cls = 'p-warn'; txt = 'ℹ️ Offene Zellen – Brücken prüfe ich vorab';
    tip = 'Voronoi hat echte Durchbrüche. Brücken und Stützen prüfe ich vor dem Druck. Für Trockenblumen oder mit passendem Einsatz.';
  } else if (sil > 50) {
    cls = 'p-warn'; txt = '⚠️ Ausladende Form – ich drucke mit extra Kühlung';
    tip = `Silhouette bis ${sil.toFixed(0)}° Auskragung – druckt mit feinen Schichten sauber.`;
  } else if (state.depth > 2.5 && worst > 65 && frac55 > 0.08) {
    cls = 'p-bad'; txt = '🔶 Tiefe Struktur zu schräg – Drall reduzieren';
    tip = `Bei ${dez(state.depth)} mm Mustertiefe sind ${worst.toFixed(0)}°-Flanken echte Überhänge.`;
  } else if (worst > 75 && frac55 > 0.15) {
    cls = 'p-warn'; txt = '⚠️ Markante Struktur – druckt mit extra Kühlung';
    tip = 'Steile Muster-Flanken (selbsttragende Mikro-Struktur) – feine Schichten empfohlen.';
  } else {
    cls = 'p-ok'; txt = '✅ Druckbar ohne Stützen';
    tip = `Silhouette max. ${sil.toFixed(0)}° – problemlos.`;
  }
  el.className = 'stage-print ' + cls;
  // Mobile: Kurzform, Langtext als Tooltip
  const short = { 'p-ok': '✅ Druckbar', 'p-warn': '⚠️ Steil', 'p-bad': '🔶 Zu steil' }[cls];
  el.textContent = IS_SMALL ? (info.openCells && cls === 'p-warn' ? 'ℹ️ Offene Zellen' : short) : txt;
  el.title = IS_SMALL ? `${txt} – ${tip}` : tip;
}

let saucerMesh = null;
let saucerInfo = null;
function saucerLift() {
  return (state.product === 'eierbecher' && state.saucer && saucerInfo) ? saucerInfo.seatHeight : 0;
}

// Entwürfe aus der Hero-Formenwelt/Formenkarten: Klicks vor der Initialisierung werden gepuffert
let studioReady = false, pendingStudioDesign = null;
async function onStudioDesign(cfg) {
  await applyDesign(cfg);
  activateTab(cfg.studioTab === 'muster' ? 'muster' : 'form');
  $('#konfigurator').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth' });
}
window.addEventListener('ovju:studio-design', (e) => {
  if (studioReady) { onStudioDesign(e.detail); return; }
  pendingStudioDesign = e.detail; // letzter Klick gewinnt
  $('#konfigurator')?.scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth' });
});

// ---------------------------------------------------------------------------
// Modell neu berechnen — im Hintergrund-Thread (model-builder.js): die Seite bleibt beim Tippen und Ziehen bedienbar,
// die Ladeanzeige zeigt den Fortschritt, und es zählt immer der neueste Stand (Zwischenstände fallen weg).
// rebuild() gibt ein Promise zurück, das erfüllt wird, sobald dieser oder ein neuerer Stand auf der Bühne steht.
// ---------------------------------------------------------------------------
let reqSeq = 0, shownSeq = 0, reframeAt = 0, lastReqParams = null;
const shownWaiters = [];
function waitShown(seq) {
  return shownSeq >= seq ? Promise.resolve() : new Promise((r) => shownWaiters.push({ seq, r }));
}
/** Alle bisher angeforderten Änderungen sind berechnet und sichtbar (vor Warenkorb, Download, Design-Code …) */
const modelReady = () => waitShown(reqSeq);
function markShown(seq) {
  if (seq > shownSeq) shownSeq = seq;
  for (let i = shownWaiters.length - 1; i >= 0; i--) {
    if (shownWaiters[i].seq <= shownSeq) { shownWaiters[i].r(); shownWaiters.splice(i, 1); }
  }
}
// Wofür gerechnet wird (Text der Ladeanzeige): die erste geänderte Gruppe gewinnt
const KIND_KEYS = [
  ['gravur', ['text', 'textSize', 'textPos', 'textStyle', 'font', 'textColor']],
  ['form', ['product', 'preset', 'customPoints', 'height', 'width', 'rim', 'saucer']],
  ['oberflaeche', ['pattern', 'ribs', 'depth', 'twist', 'flow', 'flowWaves']],
];
function changeKind(prev, next) {
  if (!prev) return 'modell';
  for (const [kind, keys] of KIND_KEYS) if (keys.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]))) return kind;
  return 'modell';
}
function rebuild() {
  entwurfMerken();
  const params = JSON.parse(JSON.stringify({ ...state, customPoints: customByProduct[state.product] }));
  const kind = changeKind(lastReqParams, params);
  lastReqParams = params;
  const seq = ++reqSeq;
  return requestModel(params, kind).then((res) => {
    if (!res) return; // von einem neueren Stand überholt
    if (seq > shownSeq) applyBuild(res, seq);
    markShown(seq);
  }, (err) => {
    console.error('Modell konnte nicht berechnet werden:', err);
    markShown(seq); // niemand soll ewig auf diesen Stand warten — die Bühne behält den letzten guten
  }).then(() => waitShown(seq));
}

// Shader vorab übersetzen, sobald das erste Modell steht und der Browser Luft hat: die Bühne zeichnet erst, wenn sie sichtbar ist —
// ohne Vorlauf würde der Browser die Programme genau dann übersetzen (auf schwächeren Handys gut 1 s Stillstand beim Ankommen).
// compileAsync nutzt KHR_parallel_shader_compile, wartet also ohne den Main-Thread anzuhalten.
function prewarmShaders() {
  if (typeof renderer?.compileAsync !== 'function') return;
  const go = () => renderer.compileAsync(scene, camera).catch(() => {});
  if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 4000 }); else setTimeout(go, 1200);
}

/** Ergebnis der Hintergrund-Rechnung auf die Bühne bringen (Meshes tauschen, Ampel, Hinweise, Maße) */
function applyBuild({ geometry, inlay, saucer, info, stats }, seq) {
  currentInfo = info;
  if (!cupMesh) {
    cupMesh = new THREE.Mesh(geometry, material);
    cupMesh.castShadow = true;
    cupMesh.receiveShadow = true;
    cupGroup.add(cupMesh);
    prewarmShaders();
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
  if (saucer) {
    saucerInfo = saucer.info;
    saucerMesh = new THREE.Mesh(saucer.geometry, material);
    saucerMesh.castShadow = true;
    saucerMesh.receiveShadow = true;
    cupGroup.add(saucerMesh);
  }
  cupMesh.position.y = saucerLift();
  if (inlayMesh) { cupGroup.remove(inlayMesh); inlayMesh.geometry.dispose(); inlayMesh = null; }
  if (inlay) {
    inlayMesh = new THREE.Mesh(inlay, inlayMaterial);
    inlayMesh.castShadow = true;
    inlayMesh.position.y = saucerLift();
    cupGroup.add(inlayMesh);
  }
  updatePrintBadge(stats, info);
  rebuildText();
  updateProps();
  // Neu einrahmen: solange niemand die Kamera bewegt hat — oder einmal nach einem geladenen Design (reframeAt)
  if (!userInteracted || (reframeAt && seq >= reframeAt)) { frameCamera(); reframeAt = 0; }
  // „Ø“ = größte Breite des Modells inkl. Muster (geometry.js maxDiameter) — so viel Platz braucht die Vase; der obere Rand allein
  // (topDiameter) war bei Flasche/Kugel/Tropfen nur ein Bruchteil davon. Ältere Worker ohne das Feld: Rückfall auf den Rand.
  const dia = (info.maxDiameter || info.topDiameter).toFixed(0);
  const dimLong = info.product === 'vase'
    ? `${info.height} mm hoch · Ø ${dia} mm · Öffnung Ø ${info.openingDiameter.toFixed(0)} mm`
    : `${info.height} mm hoch · Ø ${dia} mm · Mulde Ø ${info.cavityDiameter.toFixed(0)} mm`
      + (state.saucer ? ` · Untersetzer Ø ${(saucerInfo.outerRadius * 2).toFixed(0)} mm` : '');
  $('#dim-info').textContent = IS_SMALL ? `${info.height} × Ø ${dia} mm` : dimLong;
  $('#dim-info').title = `${dimLong} (Ø = größte Breite inkl. Muster)`;
  // Öffnungs-Hinweis (Vase): eng für Blumen — gelb unter Ø 18 mm, rot unter Ø 10 mm (nicht blockierend)
  const ow = $('#open-warn');
  ow.hidden = !info.openingWarn;
  ow.textContent = info.openingWarn || '';
  ow.classList.toggle('err', !!info.openingTight);
  // Gehämmert: bei vielen Schlägen begrenzt die Zellgröße die Tiefe → dezenter Hinweis
  const dn = $('#depth-note');
  if (dn) { dn.hidden = !info.depthNote; dn.textContent = info.depthNote || ''; }
  // Randoption: bei offenen Voronoi-Vasen ohne Wirkung → Hinweis, Auswahl gedimmt
  $('#rim-note').hidden = !info.openCells;
  $('#rim-row').classList.toggle('disabled', !!info.openCells);
}

// Konfigurator sichtbar → body.konf-aktiv + Ereignis 'ovju:konf-aktiv': Die Handy-Startseite pausiert dann ihre Hintergrundarbeit
// (Formenwelt-Vorbau in studio.js, Muster-Vorschaubilder in mobile-home.js) — beides rechnet im Main-Thread und würde hier
// Tippen und Regler verzögern. Verlässt man den Konfigurator, geht es weiter.
function initKonfAktiv() {
  const sec = $('#konfigurator');
  if (!sec || !('IntersectionObserver' in window)) return;
  let aktiv = false;
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting === aktiv) return;
    aktiv = e.isIntersecting;
    document.body.classList.toggle('konf-aktiv', aktiv);
    window.dispatchEvent(new CustomEvent('ovju:konf-aktiv', { detail: aktiv }));
  }).observe(sec);
  // Kommt der Konfigurator beim Scrollen in die Nähe (anderthalb Bildschirmhöhen vorher), die Bühne einmal unsichtbar zeichnen:
  // Browser ohne parallele Shader-Übersetzung übersetzen dann jetzt — während des Scrollens, das auf Handys im eigenen Thread
  // flüssig weiterläuft — statt beim ersten Antippen im Konfigurator.
  const near = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting || !cupMesh) return;
    near.disconnect();
    try { resize(); zeichne(); } catch { /* egal */ }
  }, { rootMargin: '0px 0px 150% 0px' });
  near.observe(sec);
}

// Ladeanzeige der Hintergrund-Rechnung: ab 160 ms ein dünner Balken am oberen Bühnenrand (Fortschritt geschätzt aus der zuletzt
// gemessenen Rechenzeit dieser Art) und eine Pille mit dem Schichten-Zeichen; bei der Gravur zusätzlich ein Hinweis unter dem
// Textfeld. Schnelle Rechnungen zeigen nichts (kein Flackern). Folgt direkt ein neuerer Stand, läuft der Balken weiter statt neu.
const BUILD_LABEL = { gravur: 'Gravur wird berechnet …', form: 'Form wird berechnet …', oberflaeche: 'Oberfläche wird berechnet …' };
function initBuildIndicator() {
  const box = $('#stage-build');
  if (!box) return;
  const stage = box.closest('.stage'), bar = box.querySelector('.sb-bar i'), label = box.querySelector('.sb-txt'), tb = $('#text-busy');
  let showTimer = 0, hideTimer = 0, raf = 0, t0 = 0, exp = 400, p0 = 0, p = 0, kind = 'modell', visible = false;
  const tick = () => {
    p = p0 + (0.94 - p0) * (1 - Math.exp(-2.2 * (performance.now() - t0) / exp));
    bar.style.transform = `scaleX(${p.toFixed(4)})`;
    raf = requestAnimationFrame(tick);
  };
  const show = () => {
    showTimer = 0;
    if (!$('#loading').classList.contains('hidden')) return; // erstes Modell: dafür steht die große Ladeanzeige
    visible = true;
    box.hidden = false;
    stage?.classList.add('is-building');
    stage?.setAttribute('aria-busy', 'true');
    if (tb) tb.hidden = kind !== 'gravur';
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const hide = () => {
    hideTimer = 0; visible = false; p = 0;
    cancelAnimationFrame(raf); raf = 0;
    box.hidden = true;
    stage?.classList.remove('is-building');
    stage?.removeAttribute('aria-busy');
    if (tb) tb.hidden = true;
    bar.style.transform = 'scaleX(0)';
  };
  onBuildStatus((ev) => {
    if (!ev.live) return; // Druckdateien und Showcase-Bilder: eigene bzw. keine Anzeige
    if (ev.type === 'start') {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; p = 0.12; } // gerade fertig geworden → kurz neu ansetzen
      kind = ev.kind;
      label.textContent = BUILD_LABEL[kind] || 'Vorschau wird berechnet …';
      if (tb && visible) tb.hidden = kind !== 'gravur';
      t0 = performance.now(); exp = Math.max(150, ev.expectedMs || 400); p0 = visible ? p : 0;
      if (!visible && !showTimer) showTimer = setTimeout(show, 160);
    } else if (ev.type === 'done' && !ev.more) {
      clearTimeout(showTimer); showTimer = 0;
      if (!visible) return;
      cancelAnimationFrame(raf); raf = 0;
      bar.style.transform = 'scaleX(1)';
      hideTimer = setTimeout(hide, 260);
    }
  });
}

let textBuildId = 0;
async function rebuildText() {
  // Alle Gravur-Stile sind Teil der Wand (siehe rebuild) — hier nur Status & Hinweise.
  if (textMesh) { cupGroup.remove(textMesh); textMesh.geometry.dispose(); textMesh = null; }
  const txt = state.text.trim();
  const warn = $('#text-warn'); warn.textContent = ''; warn.classList.remove('err');
  const opts = $('#gravur-options'); opts.classList.remove('disabled');
  $('#text-fix')?.remove();
  const ti = (currentInfo && currentInfo.text) || {};
  updateTextMeta();
  // Download-Button: Farbschrift liefert ein 3MF mit zwei Teilen statt STL
  const is3mf = !!txt && !ti.disabled && exportExt(currentConfig()) === '3mf';
  $('#btn-download').textContent = is3mf ? '⬇ 3MF' : '⬇ STL';
  $('#btn-download').title = is3mf ? '3MF mit zwei Teilen (Körper + Schrift) – Bambu Studio ordnet die Filamente automatisch zu' : 'STL-Datei herunterladen – druckfertig in mm, slicebar in Bambu Studio, PrusaSlicer & Co.';
  // Preis immer nachziehen: Gravur/Farbschrift/Muster/Untersetzer hängen am (Neu-)Aufbau — auch wenn der Text gerade gelöscht wurde
  renderPrices();
  if (!txt || !currentInfo) return;
  if (ti.disabled) {
    warn.textContent = '⛔ ' + (ti.reason || 'Gravur hier nicht möglich.');
    warn.classList.add('err');
    opts.classList.add('disabled');
    if (/Mustertiefe/.test(ti.reason || '')) {
      const b = document.createElement('button'); b.id = 'text-fix'; b.className = 'linkbtn'; b.textContent = 'Tiefe auf 2,5 mm setzen';
      b.addEventListener('click', () => { state.depth = 2.5; $('#s-depth').value = 2.5; $('#s-depth-val').textContent = '2,5 mm'; sliderFill($('#s-depth')); rebuild(); });
      warn.appendChild(document.createTextNode(' ')); warn.appendChild(b);
    }
    return;
  }
  warn.textContent = ti.warn || '';
}

// Zeichenzähler unter dem Gravurfeld („12/30“, ab 4 Zeichen vor dem Limit in Warnfarbe; rot mit der echten Grenze,
// wenn die Engine den Text als zu lang abschaltet — beim Eierbecher sind je nach Form/Schrift oft nur 15–20 Zeichen
// möglich) und ein dezenter Hinweis, wie viel Umfang ein umlaufender Text belegt (nur über FRONT_TEXT_ARC — die
// Warnung steht in #text-warn). Im input-Handler ist currentInfo noch alt; rebuildText() ruft nach dem Rebuild erneut auf.
function updateTextMeta() {
  const inp = $('#i-text');
  const max = inp.maxLength > 0 ? inp.maxLength : 30;
  const n = state.text.length;
  const count = $('#text-count');
  const ti = (currentInfo && currentInfo.text) || {};
  const over = !!state.text.trim() && !!ti.disabled && !!ti.maxChars;
  count.textContent = over ? `${n}/${max} – zu lang, hier max. ca. ${ti.maxChars}` : `${n}/${max}`;
  count.classList.toggle('over', over);
  count.classList.toggle('near', !over && n >= max - 4);
  const wraps = !!state.text.trim() && !ti.disabled && (ti.arcDeg || 0) > (FRONT_TEXT_ARC * 180) / Math.PI + 0.5;
  const arc = $('#text-arc');
  arc.hidden = !wraps;
  arc.textContent = wraps ? `belegt ${Math.round(ti.arcDeg)}° des Umfangs` : '';
}

const debounce = (fn, ms) => {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
const rebuildSoon = debounce(rebuild, 60);
const rebuildBodySoon = debounce(rebuild, 160);
// Relief-Stile leben in der Wand → Körper neu bauen; aufgesetzter Text → nur Text
const rebuildTextSoon = () => rebuildBodySoon();

// ---------------------------------------------------------------------------
// Entwurf sichern: die aktuelle Gestaltung liegt laufend im Browser (localStorage „ovju-entwurf“, nur auf diesem Gerät) und kommt beim
// nächsten Aufruf zurück — Handys verwerfen schwere Tabs gern im Hintergrund (App-Wechsel), dazu Neuladen oder versehentliches Zurück.
// Wiederhergestellt wird über applyDesign (dieselbe Prüfung und Klemmung wie bei Design-Codes); ein unlesbarer oder abgelaufener Stand
// (ENTWURF_TAGE ohne Änderung) wird gelöscht, nach einer Bestellung ebenso. Dazu „Zurücksetzen“ (Panel-Kopf, im Touch-Layout am Panel-Ende).
// Design-Codes (Link ?d=/#d=, Code-Eingabe): Ein Code in der Adresse hat Vorrang. Solange das geladene Design unverändert ist, wird nichts
// gesichert (ein eigener Entwurf bleibt erhalten, der Hinweis bietet ihn an); beim ersten Weitergestalten verschwindet der Code aus der
// Adresse — sie zeigt dieses Design nicht mehr, Neuladen/Tab-Verwurf bringt den Entwurf. Der Entwurf merkt sich, aus welchem Code er
// entstand (von): Öffnet man denselben Link erneut, kommt der Entwurf mit „Original-Design laden“.
// ---------------------------------------------------------------------------
const ENTWURF_KEY = 'ovju-entwurf', ENTWURF_TAGE = 30;
let entwurfAn = false;    // erst nach dem Start — sonst überschriebe der Grundzustand den gesicherten Entwurf
let startConfig = null;   // Grundzustand beim Laden (Ziel von „Zurücksetzen“/„Neu beginnen“)
let hinweisStand = null, hinweisAktion = null;
let codeStand = null;     // gerade aus einem Code geladen: { code, sig } (sig = Stand nach dem Laden, beim ersten Sichern ermittelt)
let entwurfVon = null;    // Code, aus dem der aktuelle Entwurf weitergestaltet wurde
let bestelltSig = null;   // Stand bei der letzten Bestellung (danach erst wieder sichern, wenn sich etwas ändert)
/** Was ein Entwurf festhält: das Design wie ein Design-Code, aber mit dem getippten Gravurtext (auch wenn eine Regel ihn gerade sperrt) */
const entwurfDaten = () => ({ ...designConfig(), text: state.text, textColor: state.textColor });
const ENTWURF_FELDER = ['product', 'preset', 'height', 'width', 'rim', 'pattern', 'ribs', 'depth', 'twist', 'flow', 'flowWaves', 'text', 'textSize', 'textPos', 'textStyle', 'font', 'textColor', 'color', 'customPoints', 'saucer'];
const entwurfSig = (c) => JSON.stringify(ENTWURF_FELDER.map((k) => (c?.[k] ?? null)));
const entwurfLoeschen = () => { try { localStorage.removeItem(ENTWURF_KEY); } catch { /* gesperrt – egal */ } };
const entwurfMerkenJetzt = debounce(() => {
  if (!entwurfAn) return;
  const d = entwurfDaten(), sig = entwurfSig(d);
  if (hinweisStand && sig !== hinweisStand) versteckeEntwurfHinweis(); // weitergestaltet → Hinweis hat sich erledigt
  if (codeStand) {
    if (codeStand.sig === null) codeStand.sig = sig;   // Stand direkt nach dem Laden (inkl. Klemmungen)
    if (sig === codeStand.sig) return;                 // Code-Design unverändert: nichts sichern
    entwurfVon = codeStand.code; codeStand = null;
    stripURLParam('d');                                // weitergestaltet: die Adresse zeigt dieses Design nicht mehr
  }
  if (sig === bestelltSig) return;                     // gerade bestellt, seitdem nichts geändert
  bestelltSig = null;
  if (startConfig && sig === entwurfSig(startConfig)) { entwurfLoeschen(); return; } // Grundzustand: nichts Eigenes zu sichern
  try { localStorage.setItem(ENTWURF_KEY, JSON.stringify({ v: 1, t: Date.now(), cfg: d, ...(entwurfVon ? { von: entwurfVon } : {}) })); } catch { /* privater Modus, Speicher voll – egal */ }
}, 600);
function entwurfMerken() { if (entwurfAn) entwurfMerkenJetzt(); }
/** Gesicherter Entwurf { cfg, von } oder null — ein unlesbarer oder abgelaufener Stand wird dabei gelöscht */
function entwurfLesen() {
  let d;
  try { d = JSON.parse(localStorage.getItem(ENTWURF_KEY) || 'null'); } catch { d = undefined; }
  if (d === null) return null;
  if (!d || d.v !== 1 || !d.cfg || typeof d.cfg !== 'object' || Array.isArray(d.cfg) || !(Date.now() - (+d.t || 0) < ENTWURF_TAGE * 864e5)) { entwurfLoeschen(); return null; }
  return { cfg: d.cfg, von: typeof d.von === 'string' ? d.von : null };
}
/** Code aus der Adresse (?d=/#d=), wie loadFromURL ihn liest */
const adressCode = () => normalizeCode((location.search + location.hash).match(/[?&#]d=([A-Za-z0-9-]{4,40})/)?.[1] || '') || null;
/**
 * Beim Start: gesicherten Entwurf laden (nur wenn er vom Grundzustand abweicht und das Produkt bestellbar ist). Mit Code in der Adresse
 * nur, wenn der Entwurf aus genau diesem Code weitergestaltet wurde — dann mit „Original-Design laden“. true = Entwurf statt Code geladen.
 */
function entwurfWiederherstellen(code) {
  const e = entwurfLesen();
  if (!e || entwurfSig(e.cfg) === entwurfSig(startConfig) || (code && e.von !== code)) return false;
  if (!produktAktiv(e.cfg.product === 'eierbecher' ? 'eierbecher' : 'vase', getPricing())) return false;
  if (code) stripURLParam('d'); // loadFromURL lädt den Code dann nicht mehr
  applyDesign(e.cfg, null, { still: true, von: e.von }).then((ok) => {
    if (ok === false) return;
    if (code) zeigeEntwurfHinweis('Dein letzter Entwurf ist wieder da.', 'Original-Design laden', () => originalLaden(code));
    else zeigeEntwurfHinweis('Dein letzter Entwurf ist wieder da.', 'Neu beginnen', () => zuruecksetzen('Neu begonnen.'));
  }).catch(() => {});
  return true;
}
/** „Original-Design laden“: den Code laden und den daraus weitergestalteten Entwurf verwerfen (Rückgängig bringt ihn zurück) */
async function originalLaden(code) {
  const vorher = entwurfDaten(), vorherVon = entwurfVon;
  try {
    const d = await loadDesign(code);
    if (await applyDesign(d.config, d.code, { still: true }) === false) return;
    entwurfLoeschen();
    history.replaceState(history.state, '', `${location.pathname}${location.search ? `${location.search}&` : '?'}d=${d.code}${location.hash}`);
    zeigeEntwurfHinweis(`Design ${formatCode(d.code)} geladen.`, 'Rückgängig', () => { stripURLParam('d'); applyDesign(vorher, null, { still: true, von: vorherVon }); });
  } catch (e) { showToast(`🔖 ${e.message}`, 5000); }
}
/** Nach dem Laden eines Codes (Link, Code-Eingabe): ein abweichender gesicherter Entwurf bleibt bis zum Weitergestalten — hier angeboten */
function entwurfAnbieten() {
  const e = entwurfLesen(), jetzt = entwurfSig(entwurfDaten());
  if (!e || entwurfSig(e.cfg) === jetzt || entwurfSig(e.cfg) === entwurfSig(startConfig)) return;
  if (!produktAktiv(e.cfg.product === 'eierbecher' ? 'eierbecher' : 'vase', getPricing())) return;
  zeigeEntwurfHinweis('Dein vorheriger Entwurf ist noch gesichert.', 'Wieder laden', () => { stripURLParam('d'); applyDesign(e.cfg, null, { still: true, von: e.von }); });
}
/** Zurück zum Grundzustand (Form, Muster, Farbe, Gravur aus) — mit „Rückgängig“ im Hinweis */
function zuruecksetzen(text = 'Alles auf Anfang gesetzt.') {
  if (!startConfig) return;
  const vorher = entwurfDaten(), vorherVon = entwurfVon;
  customByProduct[startConfig.product] = null; // eigene Silhouette verwerfen (Rückgängig bringt sie über vorher.customPoints zurück)
  stripURLParam('d');
  applyDesign(startConfig, null, { still: true }).then(() => {
    userInteracted = false; // neu einrahmen und wieder langsam drehen wie beim ersten Besuch
    zeigeEntwurfHinweis(text, 'Rückgängig', () => applyDesign(vorher, null, { still: true, von: vorherVon }));
  });
}
function zeigeEntwurfHinweis(text, knopf, aktion) {
  const box = $('#draft-note'); if (!box) return;
  $('#draft-note-txt').textContent = text;
  $('#draft-note-btn').textContent = knopf;
  hinweisAktion = aktion; hinweisStand = entwurfSig(entwurfDaten());
  box.hidden = false;
}
function versteckeEntwurfHinweis() {
  const box = $('#draft-note'); if (box) box.hidden = true;
  hinweisAktion = null; hinweisStand = null;
}
function initEntwurf() {
  $('#draft-note-btn')?.addEventListener('click', () => { const a = hinweisAktion; versteckeEntwurfHinweis(); a?.(); });
  $('#btn-reset')?.addEventListener('click', () => zuruecksetzen());
  // Bestellung abgeschlossen (cart.js trägt die Bestellnummer in die Erfolgsmeldung ein): gesicherten Entwurf löschen — der offene
  // Konfigurator behält das Design, gesichert wird erst wieder, wenn sich etwas ändert
  const nr = $('#confirm-id');
  if (nr) new MutationObserver(() => { if (nr.textContent.trim()) { entwurfLoeschen(); bestelltSig = entwurfSig(entwurfDaten()); } }).observe(nr, { childList: true, characterData: true, subtree: true });
}

/**
 * Bedienhilfen für Dialoge und Meldungen, deren Markup zur Kasse bzw. zum Konto gehört: nur ergänzen, was dort fehlt (index.html bleibt in
 * diesen Teilen unberührt) — Dialoge heißen wie ihre Überschrift, „✕“ heißt „Schließen“, Fehler werden sofort angesagt, Fortschritt höflich;
 * der Warenkorb-Knopf nennt die Anzahl (cart.js schreibt nur #cart-count).
 */
function initBedienhilfen() {
  for (const d of $$('dialog')) {
    if (d.hasAttribute('aria-labelledby') || d.hasAttribute('aria-label')) continue;
    const h = d.querySelector('h2'); if (!h) continue;
    if (!h.id) h.id = `${d.id || 'dialog'}-titel`;
    d.setAttribute('aria-labelledby', h.id);
  }
  for (const b of $$('dialog button')) if (!b.hasAttribute('aria-label') && b.textContent.trim() === '✕') b.setAttribute('aria-label', 'Schließen');
  const gs = $('#co-coupon'); if (gs && !gs.labels?.length && !gs.hasAttribute('aria-label')) gs.setAttribute('aria-label', 'Gutscheincode (optional)');
  for (const [sel, role] of [['#auth-err', 'alert'], ['#co-coupon-msg', 'alert'], ['#co-progress', 'status'], ['#acc-addr-msg', 'status']]) {
    const el = $(sel); if (el && !el.hasAttribute('role') && !el.hasAttribute('aria-live')) el.setAttribute('role', role);
  }
  const cnt = $('#cart-count'), btn = $('#cart-btn');
  if (cnt && btn) {
    const name = () => { const n = parseInt(cnt.textContent, 10) || 0; btn.setAttribute('aria-label', `Warenkorb, ${n} Artikel`); };
    name(); new MutationObserver(name).observe(cnt, { childList: true, characterData: true, subtree: true });
  }
}

/**
 * Desktop: kompakte Preisleiste unten im Panel (#cta-mini, configurator-studio.css), solange Preis oder „In den Warenkorb“ des
 * Preisbereichs nicht ganz im Panel zu sehen sind; ihr Knopf löst denselben Kauf aus. Ausgeblendet ist sie inert (kein Fokus, nicht
 * vorgelesen). scroll-padding-bottom hält per Tastatur angesteuerte Regler über ihr.
 */
function initPanelCta() {
  const panel = $('#konfigurator .panel'), mini = $('#cta-mini'), preis = $('#price'), kauf = $('#btn-order');
  if (!panel || !mini || !preis || !kauf) return;
  $('#cta-mini-order')?.addEventListener('click', () => kauf.click());
  const desk = matchMedia('(min-width: 981px)');
  const sichtbar = new Map([[preis, false], [kauf, false]]);
  const setze = () => {
    const an = desk.matches && [...sichtbar.values()].includes(false);
    mini.classList.toggle('an', an);
    mini.inert = !an; mini.setAttribute('aria-hidden', String(!an));
    const h = $('.cta-mini-in', mini)?.offsetHeight || 0;
    panel.style.scrollPaddingBottom = desk.matches && h ? `${h + 8}px` : '';
  };
  if (!('IntersectionObserver' in window)) { setze(); return; } // alter Browser: Leiste bleibt einfach da
  // ganz sichtbar = vollständig im sichtbaren Teil des Panels (die Leiste liegt darüber und gibt ihn beim Ausblenden frei)
  const io = new IntersectionObserver((eintraege) => {
    for (const e of eintraege) sichtbar.set(e.target, e.isIntersecting && e.intersectionRatio > 0.98);
    setze();
  }, { root: panel, threshold: [0, 0.98, 1] });
  io.observe(preis); io.observe(kauf);
  desk.addEventListener?.('change', setze);
}

/** Ohne WebGL: statt endlosem „Lade 3D-Studio …“ eine klare Erklärung in der Bühne (Inhalte, Preise und Warenkorb laufen normal) */
function zeigeOhne3D() {
  const el = $('#loading'); if (!el) return;
  el.classList.add('no3d');
  el.innerHTML = '<p><b>Die 3D-Vorschau startet in diesem Browser nicht.</b></p>'
    + '<p>Sie braucht WebGL. Bitte schalte in den Einstellungen deines Browsers die Hardwarebeschleunigung ein oder öffne die Seite in einem aktuellen Browser (Chrome, Edge, Firefox oder Safari).</p>'
    + '<p>Fragen? Schreib mir – die Kontaktdaten stehen im <a href="/impressum">Impressum</a>.</p>';
  $('#btn-foto')?.setAttribute('hidden', '');
  $('#btn-fullscreen')?.setAttribute('hidden', '');
  $('#stage-hint')?.setAttribute('hidden', '');
}

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
  $$('.preset-btn').forEach((x) => aktiv(x, x.dataset.preset === state.preset));
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
      <circle cx="${edX(r)}" cy="${edY(t)}" r="7" class="ed-handle" data-i="${i}" tabindex="0" role="slider" aria-orientation="horizontal"
        aria-label="Punkt ${i + 1} von ${pts.length} (Höhe ${Math.round(t * 100)} %)" aria-valuemin="12" aria-valuemax="108" aria-valuenow="${Math.round(r * 100)}" aria-valuetext="Breite ${Math.round(r * 100)} %"/>`).join('')}
  `;
  // Tastatur: Pfeile ±2 %, Bild auf/ab ±10 %, Pos1/Ende = schmalste/breiteste Stelle — wie Ziehen, danach Fokus zurück auf denselben Punkt
  svg.querySelectorAll('.ed-handle').forEach((c) => c.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -0.02, ArrowDown: -0.02, ArrowRight: 0.02, ArrowUp: 0.02, PageDown: -0.1, PageUp: 0.1 }[e.key];
    const i = parseInt(c.dataset.i, 10), pt = customByProduct[state.product][i];
    let r = e.key === 'Home' ? 0.12 : e.key === 'End' ? 1.08 : step !== undefined ? pt[1] + step : null;
    if (r === null) return;
    e.preventDefault();
    pt[1] = Math.round(Math.min(1.08, Math.max(0.12, r)) * 100) / 100;
    renderShapeEditor();
    svg.querySelector(`.ed-handle[data-i="${i}"]`)?.focus();
    rebuildSoon();
  }));
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
  // Nur bestellbare Produkte (Eierbecher derzeit deaktiviert → allein „Vase“ braucht keinen Umschalter: Leiste bleibt leer & versteckt)
  const list = Object.entries(PRODUCTS).filter(([id]) => produktAktiv(id, getPricing()));
  const box = $('#product-tabs');
  box.hidden = list.length < 2;
  box.innerHTML = list.length < 2 ? '' : list.map(([id, pr]) => `
    <button class="product-tab" data-product="${id}">
      <span class="pt-icon">${pr.icon}</span>${pr.label}
      <small>${abPriceHTML(id)}</small>
    </button>`).join('');
  $$('.product-tab').forEach((b) => b.addEventListener('click', () => setProduct(b.dataset.product)));
  markActiveProduct();
}

function markActiveProduct() {
  $$('.product-tab').forEach((x) => aktiv(x, x.dataset.product === state.product));
}

function setProduct(id) {
  if (state.product === id) return true;
  // Deaktiviertes Produkt (Eierbecher, solange der Schalter aus ist): Vase bleibt, kurzer Hinweis
  if (!produktAktiv(id, getPricing())) { showToast(EIERBECHER_HINWEIS, 3500); return false; }
  state.product = id;
  const product = PRODUCTS[id];
  state.preset = Object.keys(product.presets)[0];
  state.height = product.defaultHeight;
  const [hMin, hMax] = product.heightRange;
  const hs = $('#s-height');
  hs.min = hMin; hs.max = hMax; hs.value = state.height;
  $('#s-height-val').textContent = `${state.height} mm`;
  sliderFill(hs); // Füllbalken zum neuen Bereich (HTML-Grundwerte gehören zum Eierbecher)
  markActiveProduct();
  renderPresetButtons();
  renderPatternBadges(); // Aktions-Badges an den Musterknöpfen hängen am Produkt („nur Vasen mit Gehämmert“)
  renderPrices();
  $('#extras-section').style.display = id === 'eierbecher' ? '' : 'none';
  $('#vase-note').hidden = id !== 'vase'; // Trockenblumen-Hinweis nur bei Vasen
  updateMobileTabs(id);
  if (['skelett','koralle'].includes(state.pattern)) applyDepthRange();
  userInteracted = false; // neu einrahmen
  rebuild();
  return true;
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
  gehaemmert: { min: 0.3, max: 2.5, step: 0.1, def: 0.8 }, // ab 1,2 mm kippt die Optik zum eingeschlagenen Napf
  skelett: { min: 0.4, max: 1.8, step: 0.1, def: 1.4 },
  koralle: { min: 0.5, max: 6, step: 0.1, def: 5 },
  default: { min: 0.2, max: 1.6, step: 0.1, def: 0.9 },
};
function applyDepthRange(resetToDefault = false) {
  $('#skeleton-note').hidden = state.pattern !== 'skelett';
  $('#skeleton-note').textContent = state.product === 'vase'
    ? 'Voronoi: offene Zellen mit verbundenen Stegen. Für Trockenblumen oder einen passenden Einsatz. Brücken und Stützen prüfe ich vor dem Druck.'
    : 'Voronoi als Zellrelief: Die Ei-Mulde bleibt geschlossen. Die Tiefe wird für den Druck begrenzt.';
  const r = ['skelett','koralle'].includes(state.pattern) && state.product === 'eierbecher'
    ? { min: 0.4, max: 1, step: 0.1, def: 1 }
    : state.pattern === 'gehaemmert' && state.product === 'eierbecher'
      ? { ...DEPTH_RANGES.gehaemmert, max: 2.0 } // kleiner Radius: flacher begrenzen (= Gravurgrenze)
      : DEPTH_RANGES[state.pattern] || DEPTH_RANGES.default;
  const el = $('#s-depth');
  el.min = r.min; el.max = r.max; el.step = r.step;
  if (resetToDefault || state.depth < r.min || state.depth > r.max) {
    state.depth = r.def;
  }
  // Set the value after changing the range: the previous pattern may have clamped it.
  el.value = state.depth;
  $('#s-depth-val').textContent = `${dez(state.depth)} mm`;
  sliderFill(el);
}

function renderFontRow() {
  $('#font-row').innerHTML = Object.entries(FONTS).map(([id, f]) => `
    <button class="font-chip font-${id}" data-font="${id}"><span>Aa</span><small>${f.label}</small></button>`).join('');
  $$('.font-chip').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    state.font = b.dataset.font;
    markActiveFont();
    rebuild();
  }));
  markActiveFont();
}
function markActiveFont() {
  $$('.font-chip').forEach((x) => {
    aktiv(x, x.dataset.font === state.font);
    const ok = fontAllowsStyle(x.dataset.font, state.textStyle);
    x.disabled = !ok; x.title = ok ? (FONTS[x.dataset.font]?.label || '') : 'Diese Schrift ist zu fein für diesen Stil';
  });
  $$('.style-chip').forEach((x) => {
    aktiv(x, x.dataset.style === state.textStyle);
    const ok = fontAllowsStyle(state.font, x.dataset.style);
    x.disabled = !ok; if (!ok) x.title = 'Dieser Stil braucht eine kräftigere Schrift';
  });
  const st = TEXT_STYLES[state.textStyle] || TEXT_STYLES.gestanzt;
  $('#style-hint').textContent = `${st.label}: ${st.hint}`;
  $('#text-color-box').hidden = state.textStyle !== 'farbe';
  farbschriftHinweis();
  // Schriftgröße = Großbuchstabenhöhe; Untergrenze je Schrift (feine Schriften brauchen mehr Höhe)
  const minCap = FONT_RULES[state.font]?.minCap ?? 5;
  const sl = $('#s-textsize'); sl.min = minCap;
  if (state.textSize < minCap) { state.textSize = minCap; sl.value = minCap; $('#s-textsize-val').textContent = `${mmText(minCap)} mm`; }
  sliderFill(sl); // auch ohne Klemmen: die Untergrenze hat sich geändert
}
function renderStyleRow() {
  // Farbschrift kostet extra (zweites Filament) — Betrag aus /api/pricing als Badge am Chip
  const fs = Math.max(0, Number(getPricing()?.farbschrift) || 0);
  $('#style-row').innerHTML = Object.entries(TEXT_STYLES).map(([id, st]) => {
    const sur = id === 'farbe' ? fs : 0;
    return `
    <button class="style-chip" data-style="${id}" title="${st.hint}${sur > 0 ? ' · ' + fmtPlus(sur) + ' je Stück' : ''}"><span class="sc-ic">${st.icon || '✒️'}</span>${st.label}${sur > 0 ? `<span class="sur">${fmtPlus(sur)}</span>` : ''}</button>`;
  }).join('');
  $$('.style-chip').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    state.textStyle = b.dataset.style;
    markActiveFont();
    rebuild();
  }));
  markActiveFont(); // die Reihe wurde neu aufgebaut → aktiven Stil (Standard „Gestanzt“) und gesperrte Kombinationen wieder markieren
}

/** Muster-Aufpreise als kleine Badges an den Musterknöpfen (Beträge aus /api/pricing, erst nach dem Laden) — dazu links
 *  oben ein Aktions-Badge „−30 %“ für jede Oberfläche, die eine laufende Aktion NUR für bestimmte Muster erfasst
 *  (gilt sie für alle Oberflächen, reicht das Banner). Die Zahl steht nur, wenn sie für den ganzen Geltungsbereich gegenüber
 *  dem 30-Tage-Tiefstpreis stimmt (aktionProzentGueltig, § 11 PAngV). Hängt vom Produkt ab → auch nach setProduct() aufrufen. */
function renderPatternBadges() {
  $$('.pattern-btn[data-pattern]').forEach((b) => {
    b.querySelector('.sur')?.remove();
    b.querySelector('.aktion-sur')?.remove();
    const sur = patternSurcharge(b.dataset.pattern);
    if (sur > 0) { const s = document.createElement('span'); s.className = 'sur'; s.textContent = fmtPlus(sur); b.appendChild(s); }
    const a = aktionFor(state.product, b.dataset.pattern);
    if (a && aktionMuster(a).length && aktionProzentGueltig(a)) {
      const s = document.createElement('span'); s.className = 'aktion-sur'; s.textContent = `−${a.prozent}\u00a0%`;
      s.title = `${a.name}: −${a.prozent} % auf ${PATTERNS[b.dataset.pattern]} gegenüber dem niedrigsten Preis der letzten 30 Tage`;
      b.appendChild(s);
    }
  });
}
/** Hinweis-Knopf unter dem Preis bzw. in der Mobile-Leiste: auf das Muster der Aktion umschalten */
function switchToAktionPattern(pattern) {
  const btn = $(`.pattern-btn[data-pattern="${pattern}"]`);
  if (!btn || state.pattern === pattern) return;
  btn.click(); // setzt Muster, Standardtiefe, Rebuild und Preis wie ein Klick im Muster-Tab
  if (IS_MOBILE) showToast(`${PATTERNS[pattern]} gewählt – Aktionspreis aktiv`);
}

function initControls() {
  $$('.pattern-btn[data-pattern]').forEach((b) => b.addEventListener('click', () => {
    state.pattern = b.dataset.pattern;
    $$('.pattern-btn[data-pattern]').forEach((x) => aktiv(x, x === b)); // nur Musterknöpfe — die Anmelde-Reiter (auth) tragen dieselbe Klasse
    $('#surface-sliders').classList.toggle('disabled', state.pattern === 'glatt');
    // Zickzack braucht ≥ 24 Facetten (sonst liest jede einzeln als Treppe)
    if (state.pattern === 'zickzack' && state.ribs < 24) {
      state.ribs = 24;
      $('#s-ribs').value = 24;
      $('#s-ribs-val').textContent = '24';
      sliderFill($('#s-ribs'));
    }
    applyDepthRange(true); // neues Muster → passende Standardtiefe (Fjordwelle/Lamellen wirken erst richtig tief)
    rebuild();
  }));
  // Aktions-Hinweis („🔥 −30 % auf Gehämmert“) unter dem Preis und in der Mobile-Leiste → Muster umschalten
  $('#price-aktion-hint')?.addEventListener('click', (e) => switchToAktionPattern(e.currentTarget.dataset.pattern));
  $('#mb-sub')?.addEventListener('click', (e) => {
    const b = e.target.closest('.mb-aktion-hint');
    if (b) switchToAktionPattern(b.dataset.pattern);
  });

  const sizeChanged = () => { renderPrices(); rebuildSoon(); };
  bindSlider('#s-height', 'height', (v) => `${v} mm`, sizeChanged);
  bindSlider('#s-width', 'width', (v) => `${Math.round(v * 100)}\u00a0%`, sizeChanged);

  // Oberer Rand: Glatt · Muster bis Kante · Wulst (Vasen & Eierbecher; Voronoi-Vasen bleiben glatt)
  $$('.rim-btn').forEach((b) => b.addEventListener('click', () => {
    state.rim = RIMS[b.dataset.rim] ? b.dataset.rim : 'glatt';
    $$('.rim-btn').forEach((x) => aktiv(x, x === b));
    rebuild();
  }));
  bindSlider('#s-ribs', 'ribs', (v) => `${v}`, rebuildSoon);
  bindSlider('#s-depth', 'depth', (v) => `${dez(v)} mm`, rebuildSoon);
  bindSlider('#s-twist', 'twist', (v) => v === 0 ? 'gerade' : `${v > 0 ? '+' : ''}${Math.round(v * 180)}°`, rebuildSoon);
  bindSlider('#s-flowwaves', 'flowWaves', (v) => `${v}×`, rebuildSoon);

  // Verlaufsart (wie das Muster über die Höhe fließt)
  $$('.flow-btn').forEach((b) => b.addEventListener('click', () => {
    state.flow = b.dataset.flow;
    $$('.flow-btn').forEach((x) => aktiv(x, x === b));
    $('#flowwaves-row').hidden = !(state.flow === 'fluss' || state.flow === 'zick');
    // Verlauf ohne Stärke ist unsichtbar → sanft eine Vorgabe setzen
    if (state.twist === 0 && state.flow !== 'spirale') {
      state.twist = 1;
      $('#s-twist').value = 1;
      $('#s-twist-val').textContent = '+180°';
      sliderFill($('#s-twist'));
    }
    rebuild();
  }));
  bindSlider('#s-textsize', 'textSize', (v) => `${mmText(v)} mm`, rebuildTextSoon);
  bindSlider('#s-textpos', 'textPos', (v) => `${Math.round(v * 100)}\u00a0%`, rebuildTextSoon);

  // Gravurschriften erst bei Bedarf: sobald jemand die Gravur ansteuert (Reiter, „Weiter: Gravur“, Häkchen, Feld), vorladen
  document.addEventListener('click', (e) => { if (e.target.closest?.('.mtab[data-tab="gravur"], .m-next[data-next="gravur"], #c-gravur, .font-chip')) preloadFonts(['helvetiker', 'droid_sans', state.font]); }, true);
  $('#i-text').addEventListener('focus', () => preloadFonts(['helvetiker', 'droid_sans', state.font]));
  $('#i-text').addEventListener('input', (e) => {
    state.text = e.target.value.slice(0, 30);
    updateTextMeta();
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
    state.rim = Math.random() < 0.7 ? 'glatt' : Math.random() < 0.5 ? 'wulst' : 'muster';
    const flows = Object.keys(FLOWS);
    state.flow = flows[Math.floor(Math.random() * flows.length)];
    state.flowWaves = 2 + Math.floor(Math.random() * 4);
    const [hMin, hMax] = PRODUCTS[state.product].heightRange;
    state.height = hMin + Math.floor(Math.random() * (hMax - hMin));
    syncControls();
    const c = content.colors[Math.floor(Math.random() * content.colors.length)];
    setColor(c);
    rebuild();
  });

  $('#btn-download').addEventListener('click', async () => {
    await modelReady();
    const cfg = currentConfig();
    const ex = await exportModel(cfg);
    downloadSTL(ex.buffer, stlFilename(ex.ext), ex.mime);
    if (ex.ext === '3mf') showToast('🎨 3MF mit zwei Teilen – in Bambu Studio öffnen, Filamente sind zugeordnet');
  });

  // In den Warenkorb (mit Live-Vorschaubild)
  $('#btn-order').addEventListener('click', async () => {
    const btn = $('#btn-order');
    if (btn.dataset.wait) return; // Doppeltipp, während die Vorschau noch rechnet
    btn.dataset.wait = '1';
    try { await modelReady(); } finally { delete btn.dataset.wait; }
    zeichne();
    addToCart({
      config: designConfig(),
      color: state.color, // Farb-ID → Farbaufpreis & Bestellzeile
      colorName: state.colorFinish && state.colorFinish !== 'matt'
        ? `${state.colorName} (${FINISH_LABEL[state.colorFinish]})` : state.colorName,
      colorHex: state.colorHex,
      thumb: captureThumb(),
    });
    bumpCart();
    if (IS_MOBILE) showToast('✓ Im Warenkorb – weiter gestalten oder zur Kasse');
  });

  // Szenen-Chips + Foto-Shooting
  $('#scene-chips').innerHTML = Object.entries(SCENES).map(([id, s]) =>
    `<button class="scene-chip" data-scene="${id}">${s.label}</button>`).join('');
  $$('.scene-chip').forEach((b) => b.addEventListener('click', () => applyScene(b.dataset.scene)));
  applyScene('studio');
  $('#btn-foto').addEventListener('click', fotoShooting);
  $('#foto-close').addEventListener('click', () => $('#foto-modal').close());

  // Gravur als aktivierbares Extra (Preis kommt aus dem Admin)
  $('#gravur-price').textContent = fmtPlus(getPricing().gravur ?? 3);
  // Ausschalten: die Gravur entfällt (Preis, Bestellung, Design-Code: state.text = ''), der getippte Text bleibt aber im Feld stehen —
  // wieder einschalten holt ihn zurück (Preisvergleich mit/ohne Gravur ohne Neutippen)
  $('#c-gravur').addEventListener('change', (e) => {
    $('#gravur-options').hidden = !e.target.checked;
    const text = e.target.checked ? $('#i-text').value.slice(0, 30) : '';
    if (text !== state.text) { state.text = text; updateTextMeta(); rebuild(); }
    if (e.target.checked) $('#i-text').focus();
  });

  // Untersetzer
  $('#saucer-price').textContent = fmtPlus(getPricing().products.eierbecher?.untersetzer ?? 0);
  $('#c-saucer').addEventListener('change', (e) => {
    state.saucer = e.target.checked;
    userInteracted = false; // neu einrahmen (Untersetzer ist breiter)
    rebuild();
  });

  $('#hero-cta').addEventListener('click', async () => {
    await applyDesign(studioDesignConfig(STUDIO_DESIGNS[5]));
    activateTab('form');
    $('#konfigurator').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  });

  // Hell/Dunkel-Modus
  const themeBtn = $('#theme-btn');
  const syncThemeBtn = () => {
    const dark = document.documentElement.classList.contains('dark');
    themeBtn.textContent = dark ? '☀️' : '🌙';
    themeBtn.setAttribute('aria-pressed', String(dark)); // Name „Dunkles Design“ (index.html) + Zustand statt Mond/Sonne
    // Browser-Chrome (Adressleiste/Statusbar) in der Farbe des Seitengrunds (studio.css --bg hell/dunkel)
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#20241e' : '#f8f6f0'));
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
  $$('.pattern-btn[data-pattern]').forEach((x) => aktiv(x, x.dataset.pattern === state.pattern));
  $('#surface-sliders').classList.toggle('disabled', state.pattern === 'glatt');
  $('#s-height').value = state.height; $('#s-height-val').textContent = `${state.height} mm`;
  $('#s-ribs').value = state.ribs; $('#s-ribs-val').textContent = `${state.ribs}`;
  $('#s-depth').value = state.depth; $('#s-depth-val').textContent = `${dez(state.depth)} mm`;
  applyDepthRange();
  $('#s-twist').value = state.twist;
  $('#s-twist-val').textContent = state.twist === 0 ? 'gerade' : `${state.twist > 0 ? '+' : ''}${Math.round(state.twist * 180)}°`;
  $$('input[type=range]').forEach((el) => sliderFill(el));
  $$('.flow-btn').forEach((x) => aktiv(x, x.dataset.flow === state.flow));
  if (!RIMS[state.rim]) state.rim = 'glatt';
  $$('.rim-btn').forEach((x) => aktiv(x, x.dataset.rim === state.rim));
  markActiveFont();
  $('#flowwaves-row').hidden = !(state.flow === 'fluss' || state.flow === 'zick');
  $('#s-flowwaves').value = state.flowWaves;
  $('#s-flowwaves-val').textContent = `${state.flowWaves}×`;
}

/** Dateiname aus den sichtbaren Namen (Flasche, Voronoi, Fjordwelle …) statt interner Kennungen (skelett, koralle) */
const dateiTeil = (t) => String(t || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function stlFilename(ext = 'stl') {
  const brand = content ? content.brand.name.toLowerCase() : 'formsam';
  const form = state.preset === 'eigene' ? 'eigene-form' : PRODUCTS[state.product]?.presets[state.preset]?.label || state.preset;
  return `${brand}-${state.product}-${dateiTeil(form)}-${dateiTeil(PATTERNS[state.pattern] || state.pattern)}${state.text ? '-' + state.text.replace(/[^a-z0-9äöüß]/gi, '_') : ''}.${ext}`;
}

function currentConfig() {
  const { color, colorName, colorHex, quality, ...rest } = state;
  const textActive = !(currentInfo?.text?.disabled);
  return {
    ...rest,
    text: textActive ? rest.text : '', // deaktivierte Gravur kommt nicht in Bestellung/Preis
    saucer: state.product === 'eierbecher' && state.saucer, // Untersetzer gibt's nur beim Eierbecher
    customPoints: customByProduct[state.product],
  };
}

/** Konfiguration inkl. Farbe — das ist, was ein Design-Code speichert */
function designConfig() {
  return { ...currentConfig(), color: state.color };
}

/** Ein gespeichertes Design (aus Code/Link, Entwurf, Zurücksetzen) in den Konfigurator laden; opts.still = ohne Toast */
async function applyDesign(cfg, code, opts = {}) {
  const product = cfg.product === 'eierbecher' ? 'eierbecher' : 'vase';
  // Design eines deaktivierten Produkts (Eierbecher-Code/-Liste, Schalter aus): nicht laden, nur Hinweis
  if (!produktAktiv(product, getPricing())) { if (!opts.still) showToast(EIERBECHER_HINWEIS, 3500); return false; }
  if (product !== state.product) setProduct(product);
  const prod = PRODUCTS[product];
  if (Array.isArray(cfg.customPoints) && cfg.customPoints.length >= 3) customByProduct[product] = cfg.customPoints.map((p) => [+p[0], +p[1]]);
  const num = (k, lo, hi) => { const v = parseFloat(cfg[k]); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULTS[k]; };
  Object.assign(state, {
    pattern: PATTERNS[cfg.pattern] ? cfg.pattern : 'glatt',
    rim: RIMS[cfg.rim] ? cfg.rim : 'glatt', // Design-Codes ohne rim = glatt (Standard)
    flow: FLOWS[cfg.flow] ? cfg.flow : 'spirale',
    font: FONTS[cfg.font] ? cfg.font : DEFAULTS.font,
    height: num('height', prod.heightRange[0], prod.heightRange[1]),
    width: num('width', 0.85, 1.15),
    ribs: Math.round(num('ribs', 3, 120)),
    depth: num('depth', 0, 6),
    twist: num('twist', -2, 2),
    flowWaves: Math.round(num('flowWaves', 1, 8)),
    textSize: num('textSize', TEXTSIZE_RANGE[0], TEXTSIZE_RANGE[1]),
    textPos: num('textPos', 0.15, 0.8),
    text: String(cfg.text || '').slice(0, 30),
    textStyle: TEXT_STYLES[cfg.textStyle] ? cfg.textStyle : 'gestanzt',
    textColor: cfg.textColor || state.textColor,
    saucer: product === 'eierbecher' && !!cfg.saucer,
  });
  const col = (content.colors || []).find((c) => c.id === cfg.color);
  if (col) setColor(col);
  if (cfg.textColor) setTextColor(cfg.textColor, true);
  // Regler & Chips nachziehen
  const preset = cfg.preset === 'eigene' && customByProduct[product] ? 'eigene' : (prod.presets[cfg.preset] ? cfg.preset : Object.keys(prod.presets)[0]);
  if (preset !== 'eigene') lastRealPreset[product] = preset;
  state.preset = preset;
  markActivePreset();
  if (preset === 'eigene') renderShapeEditor();
  syncControls(); markActiveFont();
  $('#s-width').value = state.width; $('#s-width-val').textContent = `${Math.round(state.width * 100)}\u00a0%`;
  $('#s-textsize').value = state.textSize; $('#s-textsize-val').textContent = `${mmText(state.textSize)} mm`;
  $('#s-textpos').value = state.textPos; $('#s-textpos-val').textContent = `${Math.round(state.textPos * 100)}\u00a0%`;
  $$('input[type=range]').forEach((el) => sliderFill(el));
  $('#i-text').value = state.text; $('#c-gravur').checked = !!state.text; $('#gravur-options').hidden = !state.text;
  $('#c-saucer').checked = state.saucer;
  // Herkunft für den Entwurf: aus einem Code geladen → erst sichern, wenn weitergestaltet; sonst gilt die mitgegebene Herkunft (Entwurf)
  if (code) codeStand = { code: normalizeCode(code), sig: null };
  else { codeStand = null; entwurfVon = opts.von || null; }
  rebuild();
  reframeAt = reqSeq; // das geladene Design einrahmen, sobald es berechnet ist (auch wenn die Kamera schon bewegt wurde)
  if (!opts.still) showToast(code ? `🔖 Design ${formatCode(code)} geladen` : "Dein Entwurf ist im Konfigurator bereit");
  renderPrices();
  // Vorschaubild des geladenen Codes nachliefern, falls es fehlt (vom Admin entfernt, älterer Code): der Server nimmt es nur für einen
  // leeren Platz an (das erste Bild gilt), ein vorhandenes bleibt unverändert
  if (code) {
    const seq = reqSeq;
    modelReady().then(() => {
      if (seq !== reqSeq) return;   // inzwischen weiter gestaltet → das Bild passte nicht mehr zum Code
      zeichne();
      return uploadThumb(code, captureThumb());
    }).catch(() => {});
  }
  return true;
}

// Quadratisches Vorschaubild aus dem aktuellen Canvas (für den Warenkorb)
function captureThumb() {
  if (!renderer) return ''; // ohne 3D kein Vorschaubild (Warenkorb zeigt dann keins, uploadThumb lehnt '' ab)
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
  frameCamera(false);
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
  if (!renderer) return;
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
  // Fortschritt: die Szenen laden je bis zu 1,5 MB Umgebungslicht — der Knopf zählt mit, statt nur gesperrt dazustehen
  const label = btn.textContent;
  btn.setAttribute('aria-busy', 'true');
  if (IS_MOBILE) showToast('Szenenbilder werden erstellt …', 4000);
  shotSetup(1200, 900);
  for (const [n, s] of setups.entries()) {
    btn.textContent = `▧ Szene ${n + 1} von ${setups.length} …`;
    await applyScene(s.scene);
    cupGroup.rotation.y = s.angle;
    placeCamera(s.zoom);
    renderer.render(scene, camera);
    shots.push({ url: renderer.domElement.toDataURL('image/png'), name: s.name });
    await new Promise((r) => setTimeout(r, 30));
  }
  await shotRestore(saved);
  $('#foto-grid').innerHTML = shots.map((s) => `
    <a href="${s.url}" download="formsam-${state.product}-${s.name}.png"><img src="${s.url}" alt="Szene ${s.name}"></a>`).join('');
  $('#foto-modal').showModal();
  btn.textContent = label; btn.removeAttribute('aria-busy');
  btn.disabled = false;
}

async function productShot(params, hex, extraProp) {
  if (!renderer) return '/img/studio/fdm-collection.webp'; // ohne 3D: Kampagnenfoto statt Render
  const { geometry, info } = await buildModelOnce({ ...DEFAULTS, ...params, quality: 0.75 });
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
  // Produktfotos ergänzen, bis das Grid gut gefüllt ist — nur von bestellbaren Produkten (kein Eierbecher-Motiv bei Schalter aus)
  const rest = galleryPhotos.filter((g) => g.cat !== 'galerie' && produktAktiv(g.cat, getPricing())).sort((a, b) => (a.cat === 'vase' ? -1 : 1) - (b.cat === 'vase' ? -1 : 1));
  const items = [...galerie, ...(galerie.length < 4 ? rest : [])];
  if (!items.length) return;
  $('#galerie').hidden = false;
  // Galerie-Uploads sind Fotos — ein KI-Bild bekommt die Kennzeichnung, wenn sein Dateiname „ki“ bzw. „ai“ als eigenes Wort trägt
  // (z. B. galerie-…-ki-vase-gelb.jpg; der Admin-Upload übernimmt den Originalnamen)
  const isKi = (f) => /(^|[-_/])(ki|ai)([-_.]|$)/i.test(String(f).replace(/^.*\//, ''));
  $('#galerie-grid').innerHTML = items.slice(0, 8).map((g, i) => `
    <figure class="galerie-item ${i === 0 ? 'big' : ''}"><img src="${g.file}" loading="lazy" alt="Vase von formsam${isKi(g.file) ? ' (KI-Inszenierung)' : ''}">${isKi(g.file) ? '<mark class="ki-tag">KI-Inszenierung</mark>' : ''}</figure>`).join('');
}

async function renderShowcase() {
  const sc = content.showcase;
  if (!sc) return;
  // Eierbecher-Karte und die Überschriften-Variante „Auch im Kleinen“ nur, wenn der Server das Produkt anbietet
  const eb = eierbecherAktiv() ? (content.eierbecher?.showcase || null) : null;
  $('#showcase-title').textContent = eb?.title || sc.title;
  $('#showcase-sub').textContent = eb?.sub || sc.sub;
  const defs = [
    {
      id: 'vase', c: sc.vase, hex: '#9caf88', extra: 'grass',
      params: { product: 'vase', preset: 'flasche', pattern: 'rippen', ribs: 72, depth: 0.9, height: 150 },
    },
    ...(eb?.karte ? [{
      id: 'eierbecher', c: eb.karte, hex: '#c86f4a', extra: 'egg',
      params: { product: 'eierbecher', preset: 'kelch', pattern: 'rippen', ribs: 48, depth: 0.9, height: 58 },
    }] : []),
  ];
  $('#showcase').classList.toggle('solo', defs.length === 1); // eine Karte mittig statt halbleeres Raster
  // Echte Produktfotos (Admin-Upload) bevorzugen, Engine-Render als Fallback
  for (const d of defs) {
    const photo = galleryPhotos.find((g) => g.cat === d.id);
    d.img = photo ? photo.file : await productShot(d.params, d.hex, d.extra);
  }
  // Handy (IS_PHONE): #produkte ist dort ausgeblendet (mobile.css) → loading=lazy, so wird das Foto gar nicht erst angefordert
  $('#showcase').innerHTML = defs.map((d) => `
    <div class="showcase-card" data-product="${d.id}">
      <img src="${d.img}" alt="${d.c.title}"${IS_PHONE ? ' loading="lazy"' : ''}>
      <div class="showcase-body">
        <h3>${d.c.title}</h3>
        <p>${d.c.text}</p>
        <div class="showcase-cta"><span class="showcase-price" data-product="${d.id}">${abPriceHTML(d.id, true)}</span>
        <button class="btn btn-primary">${d.c.cta}</button></div>
      </div>
    </div>`).join('');
  $$('.showcase-card').forEach((card) => card.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;   // Link „Versand“ in der Preiszeile öffnet nur die Versandseite
    setProduct(card.dataset.product);
    $('#konfigurator').scrollIntoView({ behavior: 'smooth' });
  }));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
warmUp(); // Hintergrund-Thread lädt den Geometrie-Code, während die Seite noch Inhalte holt (Gravurschriften erst bei Bedarf)
(async () => {
  initBedienhilfen();
  await loadContent();
  await initCart();
  fillShopInfo(); // Lieferzeit/Liefergebiet aus /api/pricing → shop in alle [data-lieferzeit]/[data-liefergebiet] (FAQ, Schritte, Trust-Zeilen)
  applyProduktSchalter(); // braucht /api/pricing → produkte (Standard bis dahin: nur Vasen)
  await initAuth();
  // Aktionsleiste + Countdown; läuft eine Aktion ab (oder beginnt eine neue), werden Muster-Badges und alle Preise neu gerendert
  initAktionBar();
  onAktionEnde(() => { renderPatternBadges(); renderPrices(); });
  renderProductTabs();
  renderPresetButtons();
  renderFontRow();
  renderStyleRow();
  renderPatternBadges();
  renderPrices();
  initControls();
  initEntwurf();
  studioReady = true;
  // Startprodukt über setProduct() initialisieren (Slider-Bereiche, Tabs, Hinweise, Preise)
  state.product = START_PRODUCT === 'vase' ? 'eierbecher' : 'vase';
  setProduct(START_PRODUCT);
  startConfig = entwurfDaten(); // Grundzustand (Ziel von „Zurücksetzen“)
  // Vor dem Start angeklickter Entwurf (Formenwelt/Karten) gewinnt — erst nach setProduct(), das sonst Form und Höhe zurücksetzte;
  // sonst den gesicherten Entwurf zurückholen; ein Design-Code in der Adresse gewinnt (loadFromURL lädt ihn weiter unten), außer der
  // Entwurf ist aus genau diesem Code weitergestaltet
  const linkCode = adressCode();
  let entwurfStattLink = false;
  if (pendingStudioDesign) { const cfg = pendingStudioDesign; pendingStudioDesign = null; onStudioDesign(cfg); }
  else entwurfStattLink = entwurfWiederherstellen(linkCode) && !!linkCode;
  entwurfAn = true;
  if (renderer) animate(); else zeigeOhne3D();
  initBuildIndicator();
  initKonfAktiv();
  initPanelCta();
  if (renderer) modelReady().then(() => $('#loading').classList.add('hidden'));
  await loadGallery();
  setTimeout(renderShowcase, 400); // Showcase: echte Fotos, sonst Engine-Renders
  initMobileShell({ product: state.product });
  initDesignCodes({
    getConfig: designConfig,
    // Abgelehntes Design (deaktiviertes Produkt) als Fehler melden → der Code-Dialog zeigt den Hinweis statt zu schließen
    applyConfig: async (cfg, code) => {
      if (await applyDesign(cfg, code) === false) throw Object.assign(new Error(EIERBECHER_HINWEIS), { endgueltig: true });
      entwurfAnbieten(); // eigener, abweichender Entwurf bleibt erhalten und wird angeboten
    },
    getThumb: () => { zeichne(); return captureThumb(); },
    whenReady: modelReady,
    onListCode: (code) => openList(code),
  });
  setCodeProvider(async (item) => {
    const code = await saveDesign(item.config);
    if (item.thumb && item.thumb.startsWith('data:')) uploadThumb(code, item.thumb);
    return code;
  });
  initLists({
    getDesign: async () => {
      await modelReady();
      zeichne();
      const config = designConfig();
      const code = await saveDesign(config);
      await uploadThumb(code, captureThumb());
      return { code, config };
    },
    applyDesign,
    colorInfo: (id) => (content.colors || []).find((c) => c.id === id) || null,
  });
  $('#cart-to-list')?.addEventListener('click', () => createListFromCart(getCart()).catch((e) => showToast(e.message)));
  // Direktlinks: ?d=CODE → Design laden, ?l=CODE → Liste öffnen
  if (await loadFromURL() || entwurfStattLink) $('#konfigurator').scrollIntoView();
  await loadListFromURL();

  // Steuer-Hook für automatisierte Tests/Renders (kein UI-Feature)
  window.__ovju = {
    apply(cfg) {
      if (cfg.product && cfg.product !== state.product && !setProduct(cfg.product)) return; // deaktiviertes Produkt
      Object.assign(state, cfg);
      syncControls();
      userInteracted = true; // Auto-Rotation stoppen für reproduzierbare Shots
      cupGroup.rotation.y = cfg.viewAngle ?? 0.5;
      const done = rebuild();
      reframeAt = reqSeq;
      return done;
    },
    ready: () => modelReady(),
    builder: () => builderMode(), // 'worker' | 'main' | 'start' — Diagnose
    text: () => (currentInfo && currentInfo.text) || null,
  };
})();
