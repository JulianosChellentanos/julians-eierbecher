// formsam — Warenkorb & Checkout (Preise kommen live vom Server: /api/pricing, Farbaufpreise aus /api/colors;
// die reine Preisformel lebt in pricing.js und rechnet identisch zu priceItem() auf dem Server)
import { exportModel } from './model-builder.js'; // Druckdateien im Hintergrund-Thread — die Kasse bleibt bedienbar
import { copyText, formatCode, esc } from './designcode.js';
import { PRODUCTS, PATTERNS, FLOWS, FONTS, RIMS } from './geometry.js';
import { getAuthHeaders, getUser, refreshOrders } from './auth.js';
import { showToast } from './mobile.js';
import { produktAktiv, filterBestellbar, EIERBECHER_HINWEIS } from './produkte.js';
import { reloadPricing } from './aktion.js';
import {
  setPricing, getPricing, setColors, getColors, fmt, fmtPlus, discountTeaser,
  volumeSurcharge, colorByRef, colorSurcharge, patternSurcharge, unitParts, unitPrice, unitUvp, linePrice,
  aktionFor, aktionScopeLabel, onAktionEnde, referenzTextZeile, aktionProzentGueltig,
} from './pricing.js';

export { getPricing, setColors, getColors, fmt, fmtPlus, discountTeaser, volumeSurcharge, colorByRef, colorSurcharge, patternSurcharge, unitParts, unitPrice, unitUvp };
/** Eierbecher bestellbar? Schalter aus /api/pricing → produkte (derzeit aus, Standard ohne Feld = aus; siehe produkte.js) */
export const eierbecherAktiv = () => produktAktiv('eierbecher', getPricing());

/** Shop-Angaben aus /api/pricing → shop (Admin → Einstellungen); Fallback = Standard des Servers, falls das Feld (noch) fehlt */
export function shopInfo() {
  const sh = getPricing()?.shop || {};
  return { lieferzeit: String(sh.lieferzeit || '').trim() || '5–8 Werktage', liefergebiet: String(sh.liefergebiet || '').trim() || 'Deutschland' };
}
/** Überall dieselbe Lieferzeit: Elemente mit data-lieferzeit / data-liefergebiet (statischer Fallback „5–8 Werktage“ im HTML bzw.
 *  content.json) bekommen den Wert aus den Einstellungen — nach dem Laden der Preise aufrufen */
export function fillShopInfo(root = document) {
  if (!getPricing()) return;
  const { lieferzeit, liefergebiet } = shopInfo();
  root.querySelectorAll('[data-lieferzeit]').forEach((el) => { if (el.textContent !== lieferzeit) el.textContent = lieferzeit; });
  root.querySelectorAll('[data-liefergebiet]').forEach((el) => { if (el.textContent !== liefergebiet) el.textContent = liefergebiet; });
  // Hersteller (= Anbieter aus /api/pricing → anbieter, wie im Impressum) im Footer „Gut zu wissen“ — Herstellerangabe nach GPSR
  const a = getPricing()?.anbieter;
  if (a && (a.street || a.email)) {
    const land = a.country && a.country !== 'Deutschland' ? a.country : '';
    const txt = `ℹ️ Hersteller: ${[a.name, a.owner, a.street, [a.zip, a.city].filter(Boolean).join(' '), land].filter(Boolean).join(', ')}${a.email ? ` · ${a.email}` : ''}`;
    root.querySelectorAll('[data-hersteller]').forEach((el) => { if (el.dataset.txt !== txt) { el.dataset.txt = txt; el.textContent = txt; } el.hidden = false; });
  }
}
/** Zahlungsarten wie in der Kasse: Überweisung immer, PayPal nur, wenn es in den Einstellungen aktiv ist */
const zahlartenText = () => `Bezahlen per Überweisung${pricing().paypal?.enabled ? ' oder PayPal' : ''}`;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const LS_KEY = 'ovju-cart-v1';
// Höchstens so viele verschiedene Designs (Positionen) je Bestellung — der Server nimmt nicht mehr an (MAX_POSITIONEN)
export const MAX_POSITIONEN = 20;
const ZU_VIELE = `Höchstens ${MAX_POSITIONEN} verschiedene Designs pro Bestellung – bitte teil deine Bestellung auf.`;

/**
 * Farbe einer Zeile gibt es gerade nicht mehr im Shop (Admin: „Im Shop“ aus) → Name der Farbe, sonst ''. Der Server nimmt solche
 * Zeilen nicht an (farbSperre), und ohne die Farbe in /api/colors fehlte hier ihr Aufpreis — deshalb markieren statt still weiterrechnen.
 * Geprüft werden Körperfarbe und bei Farbschrift die Schriftfarbe, nur wenn die Farbliste geladen ist.
 */
function farbeFehlt(it) {
  if (!getColors().length) return '';
  if (!colorByRef(it.color, it.colorName)) return it.colorName || it.color || 'dieser Farbe';
  const c = it.config || {};
  if (String(c.text || '').trim() && c.textStyle === 'farbe' && c.textColor && !colorByRef(c.textColor, null)) return it.textColorName || c.textColor;
  return '';
}
const farbFehler = () => cart.map(farbeFehlt).find(Boolean) || '';

let cart = [];
const pricing = () => getPricing(); // immer der aktuelle Stand (aktion.js lädt die Preise nach dem Aktionsende neu)

export async function initPricing() {
  if (!getPricing()) setPricing(await (await fetch('/api/pricing')).json());
  // Farbliste (mit Aufpreisen) setzt normalerweise der Konfigurator per setColors(); Fallback: selbst laden
  if (!getColors().length) {
    try { const live = await (await fetch('/api/colors')).json(); if (Array.isArray(live)) setColors(live); } catch { /* ohne Farbaufpreise weiter */ }
  }
  return getPricing();
}

function loadCart() {
  try { cart = JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { cart = []; }
  let changed = false;
  // Zeilen eines derzeit nicht bestellbaren Produkts (z. B. Eierbecher aus einem früheren Besuch) entfernen —
  // der Server lehnt sie beim Checkout ab; der Kunde bekommt einen Hinweis (Migration älterer localStorage-Stände)
  const f = filterBestellbar(cart, pricing());
  if (f.entfernt > 0) { cart = f.items; changed = true; showToast(EIERBECHER_HINWEIS, 4000); }
  // Ältere Zeilen ohne Farb-ID: über den Farbnamen nachziehen (Farbaufpreis & Bestellung brauchen die ID)
  for (const it of cart) {
    if (!it.color) { const c = colorByRef(it.config?.color, it.colorName); if (c) { it.color = c.id; changed = true; } }
  }
  if (changed) localStorage.setItem(LS_KEY, JSON.stringify(cart));
}
function saveCart() {
  localStorage.setItem(LS_KEY, JSON.stringify(cart));
  renderBadge();
}
/**
 * Summen — subtotal aus den (ggf. aktionsreduzierten) Zeilen; aktionen = je Aktion, die mindestens eine Zeile betrifft,
 * { id, name, prozent, scope, ersparnis, ersparnisRef, prozentOk } (Ersparnis absteigend — wie order.aktionen auf dem Server);
 * aktion = aktionen[0] | null. ersparnisRef = Ersparnis gegenüber dem 30-Tage-Tiefstpreis (nur Zeilen mit Bezugspreis),
 * prozentOk = die Prozentzahl der Aktion stimmt für ihren ganzen Geltungsbereich (aktionProzentGueltig, § 11 PAngV).
 */
function totals() {
  const lines = cart.map((it) => linePrice(it));
  const subtotal = Math.round(lines.reduce((s, l) => s + l.line, 0) * 100) / 100;
  const ship = pricing().shipping;
  const shipping = cart.length === 0 ? 0 : (subtotal >= ship.freeFrom ? 0 : ship.flat);
  const byId = new Map();
  cart.forEach((it, i) => {
    const l = lines[i];
    if (!(l.aktionProzent > 0)) return;
    const key = l.aktionId || l.aktionName;
    const ak = aktionFor(it.product, it.config?.pattern);
    const a = byId.get(key) || { id: l.aktionId, name: l.aktionName, prozent: l.aktionProzent, scope: aktionScopeLabel(ak), ersparnis: 0, ersparnisRef: 0, prozentOk: !!ak && aktionProzentGueltig(ak) };
    a.ersparnis = Math.round((a.ersparnis + l.ersparnis) * 100) / 100;
    a.ersparnisRef = Math.round((a.ersparnisRef + l.ersparnisRef) * 100) / 100;
    byId.set(key, a);
  });
  const aktionen = [...byId.values()].sort((x, y) => y.ersparnis - x.ersparnis);
  const mitRef = lines.some((l) => l.aktionProzent > 0 && l.lineRef != null);   // mindestens ein Streichpreis → Fußnote
  return { subtotal, shipping, total: Math.round((subtotal + shipping) * 100) / 100, aktionen, aktion: aktionen[0] || null, mitRef };
}
/** Zeilen „🔥 Herbstaktion −30 % auf Gehämmert · du sparst 3,98 €“ je betroffener Aktion für Warenkorb & Kasse
 *  (informativ — die Summen sind schon reduziert). § 11 PAngV: „du sparst“ nur gegenüber dem 30-Tage-Tiefstpreis
 *  (ersparnisRef), die Prozentzahl nur, wenn sie für die ganze Aktion stimmt; ohne beides nur „Aktionspreise“. */
function aktionRowHTML(t, cls) {
  return (t.aktionen || []).filter((a) => a.ersparnis > 0).map((a) =>
    `<div class="${cls}"><span>🔥 ${esc(a.name)}${a.prozentOk ? ` −${a.prozent}\u00a0%` : ': Aktionspreise'} ${esc(a.scope)}</span>` +
    `${a.ersparnisRef > 0 ? `<b title="gegenüber dem niedrigsten Preis der letzten 30 Tage">du sparst ${fmt(a.ersparnisRef)}</b>` : ''}</div>`).join('');
}
/** Kennzeichnung unter Warenkorb und Kasse, sobald ein Streichpreis vorkommt */
const REF_FUSSNOTE = 'Durchgestrichen: niedrigster Preis der letzten 30 Tage vor Beginn der Aktion.';
/** Streichpreis einer Zeile = niedrigster Zeilenpreis der letzten 30 Tage für genau diese Menge (mit der damaligen Mengenstaffel,
 *  pricing.js linePrice → lineRef) mit title/aria-label — nur aufrufen, wenn lp.lineRef != null */
function refStrike(lp, qty) {
  const t = esc(referenzTextZeile(lp.lineRef, qty));
  return `<s class="uvp" title="${t}" aria-label="${t}">${fmt(lp.lineRef)}</s>`;
}

export function itemTitle(it) {
  const prod = PRODUCTS[it.product];
  const preset = it.config.preset === 'eigene' ? 'Eigene Form' : (prod.presets[it.config.preset]?.label || 'Unbekannt');
  return `${prod.label} „${preset}“`;
}
/**
 * Zeile unter dem Titel — alle gewählten Merkmale wie auf der Rechnung (Muster mit Tiefe und Spirale, Höhe, Breite, Rand, Farbe,
 * Gravur, Untersetzer) samt Aufpreisen; steht im Warenkorb und in der Kasse unmittelbar vor dem Bestellknopf (§ 312j Abs. 2 BGB)
 */
export function itemSub(it) {
  const c = it.config;
  const q = unitParts(it);
  const plus = (v) => (v > 0 ? ` +${fmt(v)}` : '');
  const num = (v) => (Number(v) || 0).toLocaleString('de-DE', { maximumFractionDigits: 2 });
  const details = [
    c.pattern && c.pattern !== 'glatt' && Number(c.depth) > 0 ? `${num(c.depth)}\u00a0mm tief` : '',
    (c.twist && c.pattern !== 'glatt' && c.pattern !== 'querwellen') ? (FLOWS[c.flow] || 'Spirale') : '',
  ].filter(Boolean);
  const muster = `${PATTERNS[c.pattern] || c.pattern}${details.length ? ` (${details.join(', ')})` : ''}`;
  const breite = c.width && Number(c.width) !== 1 ? ` · Breite ${Math.round(Number(c.width) * 100)}\u00a0%` : '';
  const icon = c.textStyle === 'farbe' ? '🎨' : c.textStyle === 'gehaemmert' ? '🔨' : c.textStyle === 'gestanzt' ? '🪙' : '✒️';
  // Randoption nur nennen, wenn sie vom Standard (glatt) abweicht („Wulstrand“ / „Musterkante“)
  const rim = c.rim && c.rim !== 'glatt' && RIMS[c.rim] ? ` · ${RIMS[c.rim]}` : '';
  return `${muster}${plus(q.muster)} · Höhe ${c.height}\u00a0mm${breite}${rim} · ${it.colorName}${plus(q.farbe)}` +
    (c.text ? ` · ${icon} „${c.text}“ (+${fmt(q.gravur)}${q.farbschrift > 0 ? ` · Farbschrift +${fmt(q.farbschrift)}` : ''})` : '') +
    (it.saucer ? ` · 🍽️ Untersetzer${plus(q.untersetzer)}` : '') +
    (q.groesse > 0 ? ` · XL-Format${plus(q.groesse)}` : '');
}

// ---------------------------------------------------------------------------
// In den Warenkorb
// ---------------------------------------------------------------------------
/** In den Warenkorb → true, wenn die Zeile drin ist (neu oder Menge erhöht); false bei gesperrtem Produkt oder vollem Warenkorb */
export function addToCart({ config, color, colorName, colorHex, thumb, code }, opts = {}) {
  // Nicht bestellbare Produkte (Eierbecher, solange der Schalter aus ist) kommen nicht in den Warenkorb
  if (!produktAktiv(config?.product || 'vase', pricing())) { showToast(EIERBECHER_HINWEIS, 3500); return false; }
  const qty = Math.max(1, Math.min(50, Math.round(opts.qty || 1)));
  // Farb-ID (Körperfarbe) — der Server rechnet damit den Farbaufpreis; Design-Codes tragen sie in config.color
  const colorId = color || config?.color || colorByRef(null, colorName)?.id || null;
  // Identisches Design (gleiche Konfiguration & Farbe) → Menge erhöhen (Rabatt!)
  const sig = JSON.stringify({ ...config, colorName });
  const existing = cart.find((it) => it.sig === sig);
  if (existing) {
    existing.qty = Math.min(50, existing.qty + qty);
    if (code && !existing.code) existing.code = code;
    if (colorId && !existing.color) existing.color = colorId;
  } else {
    if (cart.length >= MAX_POSITIONEN) { showToast(ZU_VIELE, 4500); return false; }
    cart.push({
      sig, product: config.product, config, color: colorId, colorName, colorHex, thumb, code: code || null,
      saucer: !!config.saucer, qty,
    });
  }
  saveCart();
  renderBadge();
  if (!opts.silent) openCart();
  // Design-Code nachreichen, falls noch keiner da ist (Server vergibt ihn deterministisch)
  const item = existing || cart[cart.length - 1];
  if (!item.code && typeof codeProvider === 'function') {
    codeProvider(item).then((c) => { if (c) { item.code = c; saveCart(); if ($('#cart-modal').open) renderCart(); } }).catch(() => {});
  }
  return true;
}

/** Vom Konfigurator gesetzt: liefert für eine Warenkorb-Zeile den Design-Code (async) */
let codeProvider = null;
export function setCodeProvider(fn) { codeProvider = fn; }
export { formatCode };

// ---------------------------------------------------------------------------
// Warenkorb-UI
// ---------------------------------------------------------------------------
function renderBadge() {
  const n = cart.reduce((s, it) => s + it.qty, 0);
  $('#cart-count').textContent = n;
  $('#cart-btn').classList.toggle('has-items', n > 0);
}

export const getCart = () => cart;
export function openCart() {
  renderCart();
  $('#cart-modal').showModal();
}

function renderCart() {
  const box = $('#cart-items');
  if (!cart.length) {
    box.innerHTML = '<p class="cart-empty">Dein Warenkorb ist leer.<br><small>Gestalte etwas Schönes im Konfigurator! 🎨</small></p>';
  } else {
    box.innerHTML = cart.map((it, i) => {
      const lp = linePrice(it);
      const { off, line } = lp;
      const akt = lp.aktionProzent > 0 ? aktionFor(it.product, it.config?.pattern) : null;
      // Streichpreis, Badge und Kennzeichnung nur mit Zeilen-Bezugspreis: niedrigster Preis der letzten 30 Tage für genau diese Menge
      // (mit dem damaligen Mengenrabatt) — ist die Zeile nicht günstiger als damals (Aktion ohne Mengenrabatt ab 2 Stück), keiner
      const ref = akt && lp.lineRef != null ? lp.ref : null;
      // Staffel-Hinweis nur, wenn der Mengenrabatt gerade auch gilt (während einer Aktion ohne „zusätzlich“ entfällt er)
      const nextTier = akt && !akt.mengenrabatt ? null : (pricing().products[it.product].discounts || []).find((t) => t.qty > it.qty);
      return `<div class="cart-item">
        <img src="${esc(it.thumb)}" alt="">
        <div class="ci-main">
          <b>${esc(itemTitle(it))}</b>
          <small>${esc(itemSub(it))}</small>
          ${farbeFehlt(it) ? `<small class="warn-msg">⚠️ „${esc(farbeFehlt(it))}“ gibt es gerade nicht – bitte entferne die Position und gestalte das Design mit einer anderen Farbe neu.</small>` : ''}
          ${ref ? `<small class="ci-ref">${esc(referenzTextZeile(lp.lineRef, it.qty))}</small>` : ''}
          ${it.code ? `<button class="ci-code" data-code="${esc(it.code)}" title="Design-Code kopieren – damit kannst du dieses Design jederzeit wieder laden">🔖 ${esc(formatCode(it.code))}</button>` : ''}
          <div class="ci-qty">
            <span class="ci-step"><button data-i="${i}" data-d="-1">−</button><span>${it.qty}</span><button data-i="${i}" data-d="1">+</button></span>
            ${ref ? `<span class="aktion-badge" title="${esc(akt.name)}: −${lp.refProzent} % gegenüber dem niedrigsten Preis der letzten 30 Tage">−${lp.refProzent}\u00a0%</span>` : ''}
            ${off ? `<span class="ci-off">−${off}\u00a0%</span>` : ''}
            ${nextTier ? `<small class="ci-hint">ab ${nextTier.qty} St. −${nextTier.off}\u00a0%</small>` : ''}
          </div>
        </div>
        <div class="ci-right"><b${ref ? ' class="aktion-price"' : ''}>${fmt(line)}</b>${ref ? refStrike(lp, it.qty) : ''}<button class="ci-del" data-del="${i}" title="Entfernen">🗑</button></div>
      </div>`;
    }).join('');
  }
  const t = totals();
  $('#cart-totals').innerHTML = cart.length ? `
    <div><span>Zwischensumme</span><b>${fmt(t.subtotal)}</b></div>
    ${aktionRowHTML(t, 'ct-aktion')}
    <div><span>Versand</span><b>${t.shipping === 0 ? 'kostenlos' : fmt(t.shipping)}</b></div>
    ${t.shipping > 0 ? `<small>Noch ${fmt(pricing().shipping.freeFrom - t.subtotal)} bis zum Gratisversand</small>` : ''}
    <div class="ct-grand"><span>Gesamt</span><b>${fmt(t.total)}</b></div>
    ${t.mitRef ? `<small class="ct-ref">${REF_FUSSNOTE}</small>` : ''}` : '';
  // Kasse erst, wenn alles bestellbar ist: keine aus dem Shop genommene Farbe, höchstens MAX_POSITIONEN Positionen (ältere Warenkörbe)
  const sperre = farbFehler() ? 'Eine Farbe in deinem Warenkorb gibt es gerade nicht – bitte die markierte Position ändern.' : cart.length > MAX_POSITIONEN ? ZU_VIELE : '';
  if (sperre) $('#cart-totals').insertAdjacentHTML('beforeend', `<small class="warn-msg">${esc(sperre)}</small>`);
  $('#cart-checkout').disabled = !cart.length || !!sperre;
  // Kurz vor „Zur Kasse“: wohin, wie lange, wie bezahlen (dieselben Angaben wie Versandseite und Kasse)
  const ship = $('#cart-ship');
  if (ship) {
    const { lieferzeit, liefergebiet } = shopInfo();
    ship.textContent = `Lieferung nach ${liefergebiet} · ${lieferzeit} · ${zahlartenText()}`;
    ship.hidden = !cart.length;
  }

  box.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => {
    const it = cart[+b.dataset.i];
    it.qty = Math.max(1, Math.min(50, it.qty + (+b.dataset.d)));
    saveCart(); renderCart();
  }));
  box.querySelectorAll('.ci-code').forEach((b) => b.addEventListener('click', async () => {
    const ok = await copyText(formatCode(b.dataset.code));
    const old = b.textContent; b.textContent = ok ? '✓ kopiert' : b.textContent;
    setTimeout(() => { b.textContent = old; }, 1400);
  }));
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    cart.splice(+b.dataset.del, 1);
    saveCart(); renderCart();
  }));
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------
let paypalReady = false;
let coupon = null; // { code, off, guthaben, sig } — vom Server bestätigt, sig = Warenkorb, für den er gerechnet wurde
/** Preisrelevanter Stand des Warenkorbs (ohne Design-Code, der später nachkommt) — Grundlage eines bestätigten Gutscheins */
const cartSig = () => JSON.stringify(cart.map((it) => [it.product, it.qty, !!it.saucer, it.config, it.color || null, it.colorName]));
/**
 * Der bestätigte Gutschein, solange der Warenkorb derselbe ist — nach einer Änderung (Menge, Position entfernt oder dazu) gilt er
 * nicht mehr: Mindestbestellwert oder Prozentbetrag können sich geändert haben. Die Kasse rechnet dann ohne ihn, bis openCheckout()
 * ihn über /api/quote neu bestätigt hat; mitgeschickt wird nur ein gültiger (sonst zeigte die Kasse einen alten Abzug).
 */
const gueltigerCoupon = () => (coupon && coupon.sig === cartSig() ? coupon : null);
// Angelegte, noch nicht abgeschlossene Bestellung (Upload/Abschluss fehlgeschlagen): ein erneuter Versuch mit derselben Kasse
// setzt dort fort, statt eine zweite Bestellung anzulegen (sonst hielte die erste z. B. ein Guthaben fest, und bei PayPal wäre
// die Zahlung schon der ersten zugeordnet) — { sig, orderId, accessKey, paypalOrderId }
let offeneKasse = null;

function checkoutTotals() {
  const t = totals();
  const coupon = gueltigerCoupon();
  if (!coupon) return t;
  const after = Math.round((t.subtotal - coupon.off) * 100) / 100;
  const ship = pricing().shipping;
  const shipping = after >= ship.freeFrom ? 0 : ship.flat;
  return { ...t, shipping, total: Math.round((after + shipping) * 100) / 100 };
}

/**
 * „Deine Bestellung“ unmittelbar über dem Bestellknopf (§ 312j Abs. 2 BGB): je Position Menge, Titel und alle gewählten Merkmale
 * (itemSub: Muster, Tiefe, Höhe, Breite, Rand, Farbe, Gravurtext, Aufpreise), Mengenrabatt, Streichpreis nur mit Zeilen-Bezugspreis;
 * danach Aktion, Gutschein, Versand und Gesamt
 */
function renderCheckoutSummary() {
  const t = checkoutTotals();
  const coupon = gueltigerCoupon();
  $('#co-summary').innerHTML = cart.map((it) => {
    const lp = linePrice(it);
    const { off, line } = lp;
    const mitRef = lp.aktionProzent > 0 && lp.lineRef != null;   // Streichpreis/Badge nur mit Zeilen-Bezugspreis (30-Tage-Tiefstpreis dieser Menge)
    return `<div><span>${it.qty}× ${esc(itemTitle(it))}${mitRef ? ` <span class="aktion-badge" title="gegenüber dem niedrigsten Preis der letzten 30 Tage">−${lp.refProzent}\u00a0%</span>` : ''}${off ? ` <em>(Mengenrabatt −${off}\u00a0%)</em>` : ''}<br><small class="co-parts">${esc(itemSub(it))}</small></span>` +
      `<b${mitRef ? ' class="aktion-price"' : ''}>${fmt(line)}${mitRef ? ` ${refStrike(lp, it.qty)}` : ''}</b></div>`;
  }).join('') + `
    ${aktionRowHTML(t, 'co-aktion')}
    ${coupon ? `<div><span>${coupon.guthaben ? '💳 Guthaben' : '🎟️ Gutschein'} „${esc(coupon.code)}“</span><b>−${fmt(coupon.off)}</b></div>` : ''}
    <div><span>Versand</span><b>${t.shipping === 0 ? 'kostenlos' : fmt(t.shipping)}</b></div>
    <div class="ct-grand"><span>Gesamt</span><b>${fmt(t.total)}</b></div>
    ${t.mitRef ? `<small class="co-ref">${REF_FUSSNOTE}</small>` : ''}`;
}

async function applyCoupon() {
  const code = $('#co-coupon').value.trim();
  const msg = $('#co-coupon-msg');
  if (!code) { coupon = null; msg.textContent = ''; renderCheckoutSummary(); return; }
  const sig = cartSig();   // Stand, für den der Server rechnet — ändert sich der Warenkorb danach, gilt der Gutschein nicht mehr
  const r = await (await fetch('/api/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: cartPayload(), couponCode: code }),
  })).json();
  if (r.coupon) {
    coupon = { code: r.coupon.code, off: r.coupon.off, guthaben: !!r.coupon.guthaben, sig };
    msg.textContent = `✅ ${coupon.guthaben ? 'Guthaben' : 'Gutschein'} „${r.coupon.code}“ eingelöst: −${fmt(r.coupon.off)}`;
    msg.className = 'tiny ok-msg';
  } else {
    coupon = null;
    // Server nennt den Grund (z. B. „Gutschein „X“ ist nicht mit der Aktion „Y“ kombinierbar.“) — sonst die allgemeine Meldung
    msg.textContent = `❌ ${r.couponError || (r.ok === false && r.error) || 'Code ungültig oder Mindestbestellwert nicht erreicht.'}`;
    msg.className = 'tiny warn-msg';
  }
  renderCheckoutSummary();
}

function openCheckout() {
  if (farbFehler() || cart.length > MAX_POSITIONEN) { renderCart(); return; }   // Hinweis steht im Warenkorb
  $('#cart-modal').close();
  renderCheckoutSummary();
  // Eingegebener Gutschein, der für einen anderen Warenkorb bestätigt wurde (Menge geändert, Position entfernt …): für den jetzigen
  // neu prüfen — bis dahin rechnet die Kasse ohne ihn (gueltigerCoupon), danach mit dem neuen Betrag oder mit der Meldung des Servers
  if ($('#co-coupon').value.trim() && !gueltigerCoupon()) {
    $('#co-coupon-msg').textContent = '';
    applyCoupon().catch(() => { coupon = null; renderCheckoutSummary(); });
  }
  // Angemeldet? → Adresse & Kontakt vorbefüllen
  const u = getUser();
  if (u) {
    if (!$('#co-name').value) $('#co-name').value = u.name;
    if (!$('#co-email').value) $('#co-email').value = u.email;
    if (u.address && !$('#co-street').value) {
      $('#co-street').value = u.address.street || '';
      $('#co-zip').value = u.address.zip || '';
      $('#co-city').value = u.address.city || '';
    }
  }
  const pp = pricing().paypal?.enabled;
  $('#pay-paypal-row').hidden = !pp;
  if (!pp) $('#pay-vorkasse').checked = true;
  $('#checkout-modal').showModal();
  // Das PayPal-SDK (www.paypal.com) lädt erst, wenn PayPal als Zahlungsart gewählt ist — nicht schon beim Öffnen der Kasse
  if (pp && $('#pay-paypal').checked && !paypalReady) setupPayPal();
}

function setupPayPal() {
  paypalReady = true;
  const s = document.createElement('script');
  // Nur der PayPal-Knopf: AGB § 3/§ 8, „Versand & Zahlung“ und der Warenkorb nennen nur Vorkasse und PayPal — ohne disable-funding
  // blendete das SDK zusätzlich Lastschrift, Karte und „Später bezahlen“ ein (andere Zahlungsmittel, andere Knopf-Beschriftung)
  s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(pricing().paypal.clientId)}&currency=EUR&intent=capture&locale=de_DE&disable-funding=card,sepa,paylater`;
  s.onload = () => {
    window.paypal?.Buttons({
      fundingSource: window.paypal.FUNDING?.PAYPAL,   // zusätzlich zu disable-funding: genau ein Knopf
      // Button-Lösung (§ 312j Abs. 3 BGB): Beschriftung „Jetzt kaufen“ statt nur „PayPal“ — der Knopf ersetzt „Zahlungspflichtig bestellen“
      style: { label: 'buynow' },
      // Vor der Zahlung dieselben Pflichtfelder wie bei „Zahlungspflichtig bestellen“ (Adresse, Vereinbarung) — sonst
      // wäre bezahlt, aber die Bestellung könnte nicht angelegt werden. Ist eine bezahlte Bestellung noch nicht abgeschlossen
      // (Upload fehlgeschlagen), setzt der Klick dort fort, statt ein zweites Mal zu kassieren.
      onClick: (data, actions) => {
        if (offeneKasse?.paypalOrderId) { submitOrder('paypal', offeneKasse.paypalOrderId); return actions.reject(); }
        if (farbFehler()) { alert('Eine Farbe in deinem Warenkorb gibt es gerade nicht – bitte die markierte Position im Warenkorb ändern.'); return actions.reject(); }
        return $('#checkout-form').reportValidity() ? actions.resolve() : actions.reject();
      },
      // Der Server prüft hier schon alles, was der Checkout prüft (Adresse, Warenkorb, Vereinbarung, Gutschein, angezeigter Betrag),
      // und garantiert ab jetzt den Preis — weicht der angezeigte Betrag ab, kommt keine Zahlung zustande
      createOrder: async () => {
        const res = await fetch('/api/paypal/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(kassenDaten('paypal')),
        });
        const r = await res.json().catch(() => ({ ok: false, error: 'Keine Antwort vom Shop' }));
        if (!r.ok) {
          if (r.code === 'preis') await preisNeu();
          alert(r.error || 'PayPal ist gerade nicht erreichbar.');
          throw new Error(r.error);
        }
        return r.id;
      },
      onApprove: async (data) => {
        const r = await (await fetch(`/api/paypal/capture/${data.orderID}`, { method: 'POST' })).json();
        if (!r.ok) { alert('Zahlung fehlgeschlagen'); return; }
        await submitOrder('paypal', data.orderID);
      },
      onError: (err) => console.warn('PayPal:', err?.message || err),
    }).render('#paypal-buttons');
  };
  document.head.appendChild(s);
}

function cartPayload() {
  return cart.map((it) => ({
    product: it.product, qty: it.qty, saucer: it.saucer,
    config: it.config, color: it.color || null, colorName: it.colorName, code: it.code || null,
  }));
}
/**
 * Alles, was die Kasse an den Server schickt (/api/paypal/create und /api/checkout):
 * beschaffenheit = gesonderte Vereinbarung (Wasser/Standfestigkeit) — ohne sie nimmt der Server nichts an;
 * expectedTotal = der gerade angezeigte Gesamtbetrag — weicht der Server-Betrag ab, antwortet er mit 409 statt zu bestellen;
 * mitSchluessel = Upload und Abschluss schicken den Zugriffsschlüssel der Bestellung mit (x-order-key)
 */
function kassenDaten(payment, paypalOrderId = null) {
  return {
    customer: {
      name: $('#co-name').value, email: $('#co-email').value,
      street: $('#co-street').value, zip: $('#co-zip').value, city: $('#co-city').value,
      note: $('#co-note').value,
    },
    items: cartPayload(), payment, paypalOrderId, couponCode: gueltigerCoupon()?.code || null,
    beschaffenheit: $('#co-beschaffenheit')?.checked === true, mitSchluessel: true,
    expectedTotal: checkoutTotals().total,
  };
}
/**
 * Der Server meldet „Preis hat sich geändert“ (409): Farben und Preise frisch laden (aktion.js zeichnet dabei alle Preise neu,
 * der onAktionEnde-Callback unten prüft einen eingegebenen Gutschein neu), dann Warenkorb und Kasse neu zeichnen
 */
async function preisNeu() {
  try { const live = await (await fetch('/api/colors', { cache: 'no-store' })).json(); if (Array.isArray(live)) setColors(live); } catch { /* weiter mit dem bekannten Stand */ }
  await reloadPricing();
  if ($('#co-coupon').value.trim()) await applyCoupon().catch(() => {});
  if ($('#checkout-modal').open) renderCheckoutSummary();
}

async function submitOrder(payment, paypalOrderId = null) {
  const btn = $('#co-submit');
  const prog = $('#co-progress');
  btn.disabled = true;
  try {
    prog.textContent = 'Bestellung wird angelegt …';
    const body = kassenDaten(payment, paypalOrderId);
    // Dieselbe Kasse (Warenkorb, Adresse, Zahlart, Gutschein) wie beim letzten, abgebrochenen Versuch → dort fortsetzen
    const sig = JSON.stringify({ ...body, expectedTotal: null });
    let r;
    if (offeneKasse && offeneKasse.sig === sig) {
      r = { ok: true, orderId: offeneKasse.orderId, accessKey: offeneKasse.accessKey };
    } else {
      r = await (await fetch('/api/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      })).json();
      if (!r.ok) {
        // Preis hat sich geändert (Admin hat Preise/Aktion geändert, während die Kasse offen war): neu rechnen, neu bestätigen lassen
        if (r.code === 'preis') await preisNeu();
        throw new Error(r.error);
      }
      offeneKasse = { sig, orderId: r.orderId, accessKey: r.accessKey || '', paypalOrderId: payment === 'paypal' ? paypalOrderId : null };
    }
    // Zugriffsschlüssel der Bestellung: ohne ihn nimmt der Server weder Druckdateien noch den Abschluss an
    const orderKey = { 'x-order-key': r.accessKey || '' };

    // Druckdateien erzeugen & hochladen
    for (let i = 0; i < cart.length; i++) {
      prog.textContent = `Erzeuge Druckdatei ${i + 1}/${cart.length} …`;
      const { buffer: buf } = await exportModel(cart[i].config); // STL oder 3MF (Farbschrift)
      prog.textContent = `Lade Druckdatei ${i + 1}/${cart.length} hoch (${(buf.byteLength / 1e6).toFixed(1)} MB) …`;
      const up = await fetch(`/api/order/${r.orderId}/stl/${i}`, {
        method: 'PUT', headers: { 'Content-Type': 'model/stl', ...orderKey }, body: buf,
      });
      if (!up.ok) throw new Error('Upload fehlgeschlagen – bitte versuch es gleich noch einmal, deine Bestellung ist schon angelegt.');
    }
    prog.textContent = 'Erstelle Rechnung …';
    const done = await (await fetch(`/api/order/${r.orderId}/complete`, { method: 'POST', headers: orderKey })).json();
    // Abschluss abgelehnt (z. B. Guthaben inzwischen eingelöst): diese Bestellung ist erledigt — der nächste Versuch beginnt neu
    if (!done.ok) { offeneKasse = null; throw new Error(done.error || 'Die Bestellung konnte nicht abgeschlossen werden.'); }
    offeneKasse = null;

    cart = [];
    coupon = null;
    if ($('#co-beschaffenheit')) $('#co-beschaffenheit').checked = false;   // gilt je Bestellung
    $('#co-coupon').value = '';
    $('#co-coupon-msg').textContent = '';
    saveCart();
    $('#checkout-modal').close();
    $('#confirm-id').textContent = r.orderId;
    $('#confirm-invoice').href = done.invoiceUrl;
    // Lieferfrist wie in Bestellbestätigung, Rechnung und AGB § 7 — der Satz zum Fristbeginn kommt vom Server (/api/pricing → shop.fristBeginn)
    const { lieferzeit } = shopInfo();
    const frist = pricing()?.shop?.fristBeginn?.[payment === 'paypal' ? 'paypal' : 'vorkasse']
      || (payment === 'paypal' ? 'Die Frist beginnt am Tag nach Vertragsschluss, also am Tag nach deiner Bestellung.' : 'Die Frist beginnt am Tag nach deinem Überweisungsauftrag an deine Bank.');
    $('#confirm-pay-hint').textContent = payment === 'paypal'
      ? `Deine Zahlung ist eingegangen, ich starte jetzt den Druck. Lieferzeit: ${lieferzeit}. ${frist}`
      : `Alle Zahlungsdaten (IBAN & Betrag) findest du auf deiner Rechnung. Sobald dein Geld da ist, starte ich den Druck. Lieferzeit: ${lieferzeit}. ${frist}`;
    $('#confirm-modal').showModal();
    refreshOrders(); // Bestellhistorie im Konto aktualisieren
  } catch (err) {
    alert('Bestellung fehlgeschlagen: ' + err.message);
  } finally {
    btn.disabled = false;
    prog.textContent = '';
  }
}

// ---------------------------------------------------------------------------
export async function initCart() {
  await initPricing();
  loadCart();
  renderBadge();
  // Aktion abgelaufen (oder neue begonnen): offene Warenkorb-/Kassen-Ansicht ohne Streichpreise neu rendern,
  // eingegebenen Gutschein neu prüfen (ein abgelehnter kann jetzt gelten, ein gültiger ändert seinen Betrag)
  onAktionEnde(() => {
    if ($('#cart-modal').open) renderCart();
    if ($('#checkout-modal').open) {
      if ($('#co-coupon').value.trim()) applyCoupon().catch(() => renderCheckoutSummary());
      else renderCheckoutSummary();
    }
  });
  $('#cart-btn').addEventListener('click', openCart);
  $('#cart-close').addEventListener('click', () => $('#cart-modal').close());
  $('#cart-checkout').addEventListener('click', openCheckout);
  $('#co-back').addEventListener('click', () => { $('#checkout-modal').close(); openCart(); });
  $('#co-back-top').addEventListener('click', () => { $('#checkout-modal').close(); openCart(); });
  $('#co-close').addEventListener('click', () => $('#checkout-modal').close());
  $('#co-coupon-btn').addEventListener('click', applyCoupon);
  $('#checkout-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitOrder('vorkasse');
  });
  $$('input[name=pay]').forEach((r) => r.addEventListener('change', () => {
    const pp = $('#pay-paypal').checked;
    $('#paypal-buttons').hidden = !pp;
    $('#co-submit').hidden = pp;
    if (pp && pricing().paypal?.enabled && !paypalReady) setupPayPal();
  }));
  $('#confirm-close').addEventListener('click', () => $('#confirm-modal').close());
}
