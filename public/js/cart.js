// formsam — Warenkorb & Checkout (Preise kommen live vom Server: /api/pricing, Farbaufpreise aus /api/colors;
// die reine Preisformel lebt in pricing.js und rechnet identisch zu priceItem() auf dem Server)
import { exportModel } from './model-builder.js'; // Druckdateien im Hintergrund-Thread — die Kasse bleibt bedienbar
import { copyText, formatCode, esc } from './designcode.js';
import { PRODUCTS, PATTERNS, FLOWS, FONTS, RIMS } from './geometry.js';
import { getAuthHeaders, getUser, refreshOrders, emailLokalFehler, emailFeldPruefen, plzFehler, plzFeldPruefen } from './auth.js';
import { showToast } from './mobile.js';
import { produktAktiv, filterBestellbar, EIERBECHER_HINWEIS } from './produkte.js';
import { reloadPricing } from './aktion.js';
import {
  setPricing, getPricing, setColors, getColors, fmt, fmtPlus, discountTeaser,
  volumeSurcharge, colorByRef, colorSurcharge, patternSurcharge, unitParts, unitPrice, unitUvp, linePrice,
  aktionFor, aktionScopeLabel, onAktionEnde, referenzTextZeile, aktionProzentGueltig, summen,
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
  const { shipping, total } = summen(subtotal, 0, cart.length);   // Versand wie computeTotals() im Server (pricing.js)
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
  return { subtotal, shipping, total, aktionen, aktion: aktionen[0] || null, mitRef };
}
/** Regelbesteuerung (/api/pricing → shop.kleinunternehmer false): „inkl. MwSt.“ unter dem Gesamtbetrag in Warenkorb und Kasse */
const mwstZeile = (cls) => (pricing()?.shop?.kleinunternehmer === false ? `<small class="${cls}">inkl. MwSt.</small>` : '');
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
  // Farbschrift: Schriftfarbe mit Namen (wie Rechnung und Mails), nie die interne Kennung
  const schrift = c.textStyle === 'farbe' ? (colorByRef(c.textColor, null)?.name || it.textColorName || '') : '';
  return `${muster}${plus(q.muster)} · Höhe ${c.height}\u00a0mm${breite}${rim} · ${it.colorName}${plus(q.farbe)}` +
    (c.text ? ` · ${icon} „${c.text}“ (+${fmt(q.gravur)}${q.farbschrift > 0 ? ` · Farbschrift +${fmt(q.farbschrift)}` : ''})${schrift ? ` · Schriftfarbe ${schrift}` : ''}` : '') +
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
            <span class="ci-step"><button data-i="${i}" data-d="-1" aria-label="Eins weniger">−</button><span>${it.qty}</span><button data-i="${i}" data-d="1" aria-label="Eins mehr">+</button></span>
            ${ref ? `<span class="aktion-badge" title="${esc(akt.name)}: −${lp.refProzent} % gegenüber dem niedrigsten Preis der letzten 30 Tage">−${lp.refProzent}\u00a0%</span>` : ''}
            ${off ? `<span class="ci-off">−${off}\u00a0%</span>` : ''}
            ${nextTier ? `<small class="ci-hint">ab ${nextTier.qty} St. −${nextTier.off}\u00a0%</small>` : ''}
          </div>
        </div>
        <div class="ci-right"><b${ref ? ' class="aktion-price"' : ''}>${fmt(line)}</b>${ref ? refStrike(lp, it.qty) : ''}<button class="ci-del" data-del="${i}" title="Entfernen" aria-label="Aus dem Warenkorb entfernen">🗑</button></div>
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
    ${mwstZeile('ct-ref')}
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
// Werte, die die Kasse aus dem Konto vorbefüllt hat ({ name, email, street, zip, city }) — nach dem Abmelden verschwinden sie wieder
const ausKonto = {};
// Angelegte, noch nicht abgeschlossene Bestellung (Upload/Abschluss fehlgeschlagen): ein erneuter Versuch mit derselben Kasse
// setzt dort fort, statt eine zweite Bestellung anzulegen (sonst hielte die erste z. B. ein Guthaben fest, und bei PayPal wäre
// die Zahlung schon der ersten zugeordnet) — { sig, payment, body (gesendete Kassendaten), orderId (null: PayPal bezahlt, Anlegen
// ohne Antwort), accessKey, paypalOrderId, total, hochgeladen, abschlussUnklar (Abschluss ohne Antwort), abgeschlossen }
let offeneKasse = null;
// Laufende Kassen (submitOrder): ein weiterer Klick — z. B. ein Doppelklick auf den PayPal-Knopf beim Fortsetzen — startet keinen
// zweiten Checkout mit derselben Zahlung (der meldete sonst kurz „bereits einer Bestellung zugeordnet“, während der erste noch hochlädt)
let kasseLaeuft = 0;

/** Kasse: Versandfreigrenze am Warenwert VOR Gutschein/Guthaben, danach der Abzug laut Server (pricing.js summen, wie computeTotals) */
function checkoutTotals() {
  const t = totals();
  const coupon = gueltigerCoupon();
  if (!coupon) return t;
  return { ...t, ...summen(t.subtotal, coupon.off, cart.length) };
}
/** Nächstes Eingabefeld der Kasse (Enter in einem Feld springt weiter, statt die Bestellung abzuschicken); nach dem letzten: Tastatur zu */
function naechstesFeld(von) {
  const felder = [...$('#checkout-form').querySelectorAll('input')]
    .filter((f) => !['checkbox', 'radio', 'hidden', 'submit', 'button'].includes(f.type) && !f.disabled && f.offsetParent !== null);
  const i = felder.indexOf(von);
  if (i >= 0 && i + 1 < felder.length) felder[i + 1].focus(); else von.blur();
}
/** Nichts zu zahlen (Gutschein/Guthaben deckt alles): ohne PayPal bestellen — PayPal nimmt keine Zahlung über 0,00 € an */
function zahlartFuerBetrag(t) {
  const nullBetrag = cart.length > 0 && t.total <= 0;
  const pp = !!pricing().paypal?.enabled;
  $('#pay-paypal-row').hidden = !pp || nullBetrag;
  if (nullBetrag && $('#pay-paypal')?.checked) { $('#pay-vorkasse').checked = true; $('#pay-vorkasse').dispatchEvent(new Event('change')); }
  // Hinweis unter „Vorkasse / Überweisung“: bei 0 € keine Bankdaten und kein Warten auf eine Zahlung
  const hint = $('#pay-vorkasse')?.parentElement?.querySelector('small');
  if (hint) {
    hint.dataset.text ||= hint.textContent;
    const text = nullBetrag ? 'Nichts zu zahlen – der Druck startet direkt nach deiner Bestellung.' : hint.dataset.text;
    if (hint.textContent !== text) hint.textContent = text;
  }
}

/**
 * „Deine Bestellung“ unmittelbar über dem Bestellknopf (§ 312j Abs. 2 BGB): je Position Menge, Titel und alle gewählten Merkmale
 * (itemSub: Muster, Tiefe, Höhe, Breite, Rand, Farbe, Gravurtext, Aufpreise), Mengenrabatt, Streichpreis nur mit Zeilen-Bezugspreis;
 * danach Aktion, Rabatt-Gutschein, Versand und Gesamt — bei Guthaben wie auf der Rechnung: Gesamtbetrag, abzüglich Guthaben, Zu zahlen
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
    ${coupon && !coupon.guthaben ? `<div><span>🎟️ Gutschein „${esc(coupon.code)}“</span><b>−${fmt(coupon.off)}</b></div>` : ''}
    <div><span>Versand</span><b>${t.shipping === 0 ? 'kostenlos' : fmt(t.shipping)}</b></div>
    ${coupon?.guthaben ? `<div><span>Gesamtbetrag</span><b>${fmt(Math.round((t.subtotal + t.shipping) * 100) / 100)}</b></div>
    <div><span>💳 abzüglich Guthaben „${esc(coupon.code)}“</span><b>−${fmt(coupon.off)}</b></div>` : ''}
    <div class="ct-grand"><span>${coupon?.guthaben ? 'Zu zahlen' : 'Gesamt'}</span><b>${fmt(t.total)}</b></div>
    ${mwstZeile('co-ref')}
    ${cart.length && t.total <= 0 ? `<small class="co-ref">Nichts zu zahlen – dein ${coupon?.guthaben ? 'Guthaben' : 'Gutschein'} deckt den Gesamtbetrag.</small>` : ''}
    ${t.mitRef ? `<small class="co-ref">${REF_FUSSNOTE}</small>` : ''}`;
  zahlartFuerBetrag(t);
}

/** Bestätigten Gutschein verwerfen (Feld geleert, anderer Code, „✕ entfernen“) — die Kasse rechnet sofort ohne ihn */
function gutscheinWeg(feldLeeren = false) {
  const hatte = !!coupon;
  coupon = null;
  if (feldLeeren) $('#co-coupon').value = '';
  $('#co-coupon-msg').textContent = '';
  $('#co-coupon-msg').className = 'tiny';
  if (hatte || feldLeeren) renderCheckoutSummary();
}
/** Steht im Gutscheinfeld ein Code, der (für diesen Warenkorb) nicht eingelöst ist? Dann wird vor dem Bestellen erst eingelöst */
function gutscheinOffen() {
  const v = $('#co-coupon').value.trim().toUpperCase();
  const c = gueltigerCoupon();
  return !!v && !(c && String(c.code).toUpperCase() === v);
}
/** Gutschein prüfen lassen (/api/quote) → true, wenn er gilt; Ergebnis unter dem Feld (mit „✕ entfernen“), Summen neu */
async function applyCoupon() {
  const code = $('#co-coupon').value.trim();
  const msg = $('#co-coupon-msg');
  if (!code) { gutscheinWeg(); return false; }
  const sig = cartSig();   // Stand, für den der Server rechnet — ändert sich der Warenkorb danach, gilt der Gutschein nicht mehr
  const r = await kassenAnfrage('/api/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // E-Mail (falls schon eingetragen): ein Einmal-Code, den gerade eine andere Kundin in der Kasse hat, gilt dann schon hier als vergeben
    body: JSON.stringify({ items: cartPayload(), couponCode: code, email: $('#co-email')?.value.trim() || undefined }),
  });
  if ($('#co-coupon').value.trim() !== code) return false;   // inzwischen anderer Code im Feld — dessen Prüfung zählt
  if (r.coupon) {
    coupon = { code: r.coupon.code, off: r.coupon.off, guthaben: !!r.coupon.guthaben, sig };
    msg.innerHTML = `✅ ${coupon.guthaben ? 'Guthaben' : 'Gutschein'} „${esc(r.coupon.code)}“ eingelöst: −${esc(fmt(r.coupon.off))} ` +
      '<button type="button" class="linkbtn" id="co-coupon-del" title="Gutschein entfernen">✕ entfernen</button>';
    msg.className = 'tiny ok-msg';
  } else {
    coupon = null;
    // Server nennt den Grund (z. B. „Gutschein „X“ ist nicht mit der Aktion „Y“ kombinierbar.“) — sonst die allgemeine Meldung
    msg.textContent = `❌ ${r.netz ? `${KEINE_VERBINDUNG} und tippe noch einmal auf „Einlösen“.` : r.kaputt ? 'Der Shop antwortet gerade nicht – bitte versuch es gleich noch einmal.'
      : r.couponError || (r.ok === false && r.error) || 'Code ungültig oder Mindestbestellwert nicht erreicht.'}`;
    msg.className = 'tiny warn-msg';
  }
  renderCheckoutSummary();
  return !!r.coupon;
}

// ---------------------------------------------------------------------------
// Meldungen der Kasse im Dialog (Zeile #co-error über dem Bestellknopf, role="alert") statt Browser-alert(). feld = Kassenfeld
// (wie in der Server-Antwort: name, email, street, zip, city, coupon) — es bekommt den Fokus, Adressfelder zeigen die Meldung
// zusätzlich direkt am Feld (bis zur nächsten Eingabe)
// ---------------------------------------------------------------------------
const KEINE_VERBINDUNG = 'Keine Verbindung zum Shop – bitte prüf deine Internetverbindung';
const ADRESSFELDER = ['name', 'email', 'street', 'zip', 'city'];
function kassenMeldung(text, feld = null) {
  const el = $('#co-error');
  if (!el) { if (text) alert(text); return; }   // index.html von vor der Meldezeile (noch im Cache)
  el.textContent = text || '';
  el.hidden = !text;
  if (!text) return;
  const f = feld ? $(`#co-${feld}`) : null;
  if (f && ADRESSFELDER.includes(feld)) { f.setCustomValidity(text); f.reportValidity(); }
  if (f) f.focus(); else el.scrollIntoView({ block: 'nearest' });
}
/** Feld der Kasse nach einer Eingabe prüfen: eigene Regel (E-Mail, PLZ), sonst eine Server-Meldung am Feld wieder entfernen */
function feldPruefen(f) {
  f.setCustomValidity(f.id === 'co-email' ? emailLokalFehler(f.value) : f.id === 'co-zip' ? (f.value.trim() ? plzFehler(f.value) : '') : '');
}
/**
 * fetch der Kasse → JSON der Antwort (+ httpStatus) | { ok:false, netz:true } (keine Verbindung) | { ok:false, kaputt:true }
 * (keine JSON-Antwort, z. B. 502 vom Proxy) — nie eine technische Meldung wie „Failed to fetch“ für die Kundschaft
 */
async function kassenAnfrage(url, opts) {
  let res;
  try { res = await fetch(url, opts); } catch { return { ok: false, netz: true }; }
  const j = await res.json().catch(() => null);
  return j && typeof j === 'object' && !Array.isArray(j) ? { ...j, httpStatus: res.status } : { ok: false, kaputt: true, httpStatus: res.status };
}
/**
 * Bestellung ist angelegt, aber noch nicht abgeschlossen (Upload/Abschluss): ein neuer Klick setzt dort fort (offeneKasse) — bei
 * PayPal über den PayPal-Knopf (der Bestellknopf ist dann ausgeblendet), mit derselben Zahlung
 */
const nochmalKlick = (payment) => (payment === 'paypal'
  ? 'Bitte tipp noch einmal auf den PayPal-Knopf – es geht mit derselben Zahlung an derselben Stelle weiter, es wird nichts mehr abgebucht und eine zweite Bestellung entsteht nicht.'
  : 'Bitte bestell noch einmal mit „Zahlungspflichtig bestellen“ – es geht an derselben Stelle weiter, eine zweite Bestellung entsteht dabei nicht.');
const nichtAbgeschlossen = (grund, payment) => `Deine Bestellung ist noch nicht abgeschlossen: ${String(grund).replace(/[.!\s]+$/, '')}. ${nochmalKlick(payment)}`;
const grundVon = (r, wobei) => (r.netz ? `die Verbindung zum Shop ist ${wobei} abgebrochen` : r.kaputt ? 'der Shop antwortet gerade nicht' : r.error || 'das hat gerade nicht geklappt');
/** Abschluss ohne Antwort: er kann beim Shop trotzdem angekommen sein — der nächste Klick klärt das zuerst (offeneKlaeren) */
const abschlussOffen = (r, payment) => `${r.netz ? 'Die Verbindung zum Shop ist beim Abschluss abgebrochen' : 'Der Shop antwortet gerade nicht'} – vielleicht ist deine Bestellung trotzdem schon angekommen. ` +
  `Tipp einfach noch einmal auf ${payment === 'paypal' ? 'den PayPal-Knopf' : '„Zahlungspflichtig bestellen“'}: Dann siehst du, ob sie da ist, oder sie wird jetzt abgeschlossen – ${payment === 'paypal' ? 'es wird nichts mehr abgebucht und ' : ''}eine zweite Bestellung entsteht dabei nicht.`;
/** PayPal: Geld eingezogen, aber keine Antwort auf das Anlegen der Bestellung — nie zu einer zweiten Zahlung raten */
const paypalOhneBestellung = (grund, spaeter = false) => `Deine PayPal-Zahlung ist angekommen, ${grund} – deine Bestellung ist noch nicht abgeschlossen. ` +
  `Bitte bezahl nicht noch einmal: Tipp ${spaeter ? 'in ein paar Minuten ' : ''}wieder auf den PayPal-Knopf (ohne die Seite neu zu laden), dann geht es mit derselben Zahlung weiter – es wird nichts mehr abgebucht.`;
// Danke-Ansicht, wenn eine offene Kasse fortgesetzt wurde, die nach dem ersten Klick noch geändert wurde (bezahlt bzw. schon abgeschlossen)
const AENDERUNG_NICHT_DRIN = 'Hinweis: Deine Bestellung gilt so, wie du sie beim ersten Klick abgeschickt hast – was du danach in der Kasse geändert hast, ist darin nicht enthalten. Antworte einfach auf deine Bestellbestätigung, wenn etwas angepasst werden soll.';
/**
 * Vor einer neuen Kasse: Blieb der Abschluss der offenen Bestellung ohne Antwort, beim Shop nachfragen, ob sie schon abgeschlossen ist
 * (GET …/stand, wartet einen laufenden Abschluss ab) → 'fertig' (dann gilt sie, offeneKasse.abgeschlossen), 'neu' (nie abgeschlossen —
 * eine neue Kasse darf beginnen) oder 'netz' (keine Antwort, Meldung steht da)
 */
async function offeneKlaeren() {
  const k = offeneKasse;
  if (!k?.abschlussUnklar || !k.orderId) return 'neu';
  const st = await kassenAnfrage(`/api/order/${encodeURIComponent(k.orderId)}/stand`, { headers: { 'x-order-key': k.accessKey || '' }, cache: 'no-store' });
  if (st.ok) { k.abgeschlossen = !!st.abgeschlossen; return k.abgeschlossen ? 'fertig' : 'neu'; }
  if (st.httpStatus === 404) return 'neu';   // unbekannt (nie abgeschlossene Kasse, inzwischen aufgeräumt)
  // ungeklärt (keine Verbindung, Wartung, zu viele Anfragen): die offene Kasse bleibt, nichts Neues beginnt
  kassenMeldung(st.netz || st.kaputt ? abschlussOffen(st, k.payment) : `${String(st.error || 'Das hat gerade nicht geklappt').replace(/[.!\s]+$/, '')}. ${nochmalKlick(k.payment)}`);
  return 'netz';
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
  kassenMeldung('');
  // Angemeldet? → Adresse & Kontakt vorbefüllen (leere Felder; eine PLZ nur, wenn sie zum Liefergebiet passt — sonst fragt das Feld)
  const u = getUser();
  if (u) {
    const setze = (k, v) => { $(`#co-${k}`).value = v; ausKonto[k] = v; };
    if (!$('#co-name').value) setze('name', u.name);
    if (!$('#co-email').value) setze('email', u.email);
    if (u.address && !$('#co-street').value) {
      setze('street', u.address.street || '');
      setze('zip', u.address.zip && !plzFehler(u.address.zip) ? u.address.zip : '');
      setze('city', u.address.city || '');
    }
  }
  plzFeldPruefen($('#co-zip'));   // Muster/Hinweis nach dem Liefergebiet (/api/pricing)
  const pp = pricing().paypal?.enabled;
  $('#pay-paypal-row').hidden = !pp || checkoutTotals().total <= 0;
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
      onClick: async (data, actions) => {
        if (kasseLaeuft) return actions.reject();   // die Kasse läuft schon (Upload/Abschluss) — nichts Neues beginnen
        kassenMeldung('');
        if (offeneKasse?.paypalOrderId) { submitOrder('paypal', offeneKasse.paypalOrderId); return actions.reject(); }
        // Überweisungs-Bestellung von eben, deren Abschluss ohne Antwort blieb: ist sie schon da, gilt sie (keine Zahlung per PayPal)
        if (offeneKasse?.abschlussUnklar) {
          const st = await offeneKlaeren();
          if (st === 'fertig') submitOrder(offeneKasse.payment);
          if (st !== 'neu') return actions.reject();
        }
        if (farbFehler()) { kassenMeldung('Eine Farbe in deinem Warenkorb gibt es gerade nicht – bitte die markierte Position im Warenkorb ändern.'); return actions.reject(); }
        if (!$('#checkout-form').reportValidity()) return actions.reject();
        // Eingetippter, nicht eingelöster Gutschein: erst einlösen bzw. den Grund nennen — bezahlt wird der dann angezeigte Betrag
        if (gutscheinOffen()) { await gutscheinVorBestellen(); return actions.reject(); }
        return actions.resolve();
      },
      // Der Server prüft hier schon alles, was der Checkout prüft (Adresse, Warenkorb, Vereinbarung, Gutschein, angezeigter Betrag),
      // und garantiert ab jetzt den Preis — weicht der angezeigte Betrag ab, kommt keine Zahlung zustande
      createOrder: async () => {
        const r = await kassenAnfrage('/api/paypal/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(kassenDaten('paypal')),
        });
        if (!r.ok) {
          if (r.code === 'preis') await preisNeu();
          kassenMeldung(r.netz ? `${KEINE_VERBINDUNG} und versuch es noch einmal – es wurde nichts bezahlt.` : r.kaputt ? 'PayPal ist gerade nicht erreichbar – bitte versuch es gleich noch einmal oder bezahl per Überweisung.' : (r.error || 'PayPal ist gerade nicht erreichbar.'), r.feld);
          throw new Error(r.error || 'PayPal');
        }
        return r.id;
      },
      onApprove: async (data) => {
        const r = await kassenAnfrage(`/api/paypal/capture/${data.orderID}`, { method: 'POST' });
        if (!r.ok) {
          kassenMeldung(r.netz || r.kaputt
            ? 'Die Verbindung zum Shop ist während der PayPal-Zahlung abgebrochen. Bitte schau in dein PayPal-Konto: Wurde schon abgebucht, versuch es nicht noch einmal – ich melde mich bei dir und ordne die Zahlung zu oder erstatte sie.'
            : r.error || 'Die Zahlung mit PayPal hat nicht geklappt – es wurde nichts abgebucht. Bitte versuch es noch einmal oder bezahl per Überweisung.');
          return;
        }
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
    // Rechenstand dieser Kasse: 2 = Versandfreigrenze vor Gutschein/Guthaben — ältere Tabs bittet der Server bei Abweichung ums Neuladen
    kasseStand: 2,
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

/**
 * Vor dem Bestellen: ein eingetippter, nicht eingelöster Gutschein wird eingelöst (neuer Gesamtbetrag → erst nach einem weiteren
 * Klick bestellen, expectedTotal muss zur Anzeige passen) bzw. der Grund genannt, warum er nicht gilt
 */
async function gutscheinVorBestellen() {
  const ok = await applyCoupon();
  if (ok) kassenMeldung(`Dein ${coupon?.guthaben ? 'Guthaben' : 'Gutschein'} „${coupon?.code || ''}“ ist jetzt eingelöst – neuer Gesamtbetrag ${fmt(checkoutTotals().total)}. Bitte prüf ihn und bestell dann noch einmal.`);
  else kassenMeldung('Der Gutscheincode im Feld gilt nicht – den Grund siehst du direkt unter dem Feld. Bitte korrigiere oder entferne ihn, dann bestell noch einmal.', 'coupon');
}
/** „Zahlungspflichtig bestellen“ (nur der Knopf, siehe initCart) */
async function bestellen() {
  // Schon per PayPal bezahlt, Bestellung aber noch nicht abgeschlossen (z. B. danach auf Überweisung gewechselt): mit dieser Zahlung
  // weiter — nie zusätzlich eine Vorkasse-Bestellung
  if (offeneKasse?.paypalOrderId) return submitOrder('paypal', offeneKasse.paypalOrderId);
  if (gutscheinOffen()) { await gutscheinVorBestellen(); return; }
  await submitOrder('vorkasse');
}

async function submitOrder(payment, paypalOrderId = null) {
  // Nur eine Kasse zur Zeit — außer eine neue PayPal-Zahlung kommt herein (onApprove): die darf nie verloren gehen
  if (kasseLaeuft && (!paypalOrderId || paypalOrderId === offeneKasse?.paypalOrderId)) return;
  kasseLaeuft++;
  const btn = $('#co-submit');
  const prog = $('#co-progress');
  btn.disabled = true;
  kassenMeldung('');
  try {
    prog.textContent = 'Bestellung wird angelegt …';
    const jetzt = kassenDaten(payment, paypalOrderId);
    // Stand der Kasse (Warenkorb, Adresse, Zahlart, Gutschein) — derselbe wie beim letzten, abgebrochenen Versuch → dort fortsetzen
    const sig = JSON.stringify({ ...jetzt, expectedTotal: null });
    if (paypalOrderId && offeneKasse && offeneKasse.paypalOrderId !== paypalOrderId) offeneKasse = null;   // neue Zahlung → eigene Bestellung
    // Inzwischen geändert: die offene Kasse gilt trotzdem, wenn sie schon per PayPal bezahlt ist (es gilt, was bezahlt wurde) oder ihr
    // Abschluss ohne Antwort blieb und der Shop sie schon abgeschlossen hat — sonst beginnt eine neue (die offene wurde nie
    // abgeschlossen: keine Rechnung, kein Vertrag; der Shop räumt sie auf)
    if (offeneKasse && offeneKasse.sig !== sig && !offeneKasse.paypalOrderId && !offeneKasse.abgeschlossen) {
      const st = await offeneKlaeren();
      if (st === 'netz') return;
      if (st === 'neu') offeneKasse = null;
    }
    const k = offeneKasse;
    const geaendert = !!(k?.body && k.sig !== sig);   // Änderungen nach dem ersten Klick fehlen in der Bestellung → Hinweis im Danke
    const body = k?.body || jetzt;
    payment = body.payment;
    if (!k) {
      const lokal = emailLokalFehler(body.customer.email);   // z. B. vom Konto vorbefüllt (ohne Eingabe-Ereignis)
      if (lokal) return kassenMeldung(lokal, 'email');
    }
    const nichtsZuZahlen = payment !== 'paypal' && body.expectedTotal <= 0;
    // gesendete Kassendaten merken (Kopie): ein neuer Versuch schickt und druckt genau das, auch wenn Warenkorb/Felder sich ändern
    const merken = (orderId, rest) => {
      offeneKasse = { sig: k?.sig || sig, payment, body: k?.body || JSON.parse(JSON.stringify(body)), orderId, accessKey: '',
        paypalOrderId: payment === 'paypal' ? body.paypalOrderId : null, total: null, hochgeladen: [], ...rest };
    };
    let r;
    if (k?.orderId) {
      r = { ok: true, orderId: k.orderId, accessKey: k.accessKey };
    } else {
      r = await kassenAnfrage('/api/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        // PayPal: das Geld ist schon eingezogen — ohne Antwort oder bei einer vorübergehenden Ablehnung (Wartung 503, Serverfehler,
        // 429; nicht erstattet = ohne r.bezahlt) fragt der nächste Klick mit derselben Zahlung noch einmal (eine dabei schon angelegte
        // Bestellung gibt der Server zurück); nie beginnt eine zweite Zahlung und nie entsteht daneben eine Vorkasse-Bestellung
        const voruebergehend = r.httpStatus >= 500 || r.httpStatus === 429;
        if (payment === 'paypal' && body.paypalOrderId && !r.bezahlt && (r.netz || r.kaputt || voruebergehend)) {
          merken(null);
          const grund = r.netz ? 'aber danach ist die Verbindung zum Shop abgebrochen' : r.kaputt ? 'aber der Shop antwortet gerade nicht'
            : r.httpStatus === 503 ? 'aber der Shop wird gerade gewartet' : 'aber der Shop konnte deine Bestellung gerade nicht anlegen';
          return kassenMeldung(paypalOhneBestellung(grund, r.kaputt || voruebergehend));
        }
        if (r.bezahlt) offeneKasse = null;   // nach der Zahlung abgelehnt: der Shop erstattet sie (steht in der Meldung des Servers)
        // Ohne Antwort ist keine Bestellung entstanden, die gilt: ohne Abschluss gibt es weder Rechnung noch Vertrag
        if (r.netz) return kassenMeldung(`${KEINE_VERBINDUNG} und bestell dann noch einmal. Es wurde noch nichts bestellt.`);
        if (r.kaputt) return kassenMeldung('Der Shop antwortet gerade nicht – es wurde noch nichts bestellt. Bitte versuch es in ein paar Minuten noch einmal.');
        // Preis hat sich geändert (Admin hat Preise/Aktion geändert, während die Kasse offen war): neu rechnen, neu bestätigen lassen
        if (r.code === 'preis') await preisNeu();
        if (r.code === 'gutschein' && $('#co-coupon').value.trim()) await applyCoupon();   // Gutscheinfeld zeigt den Grund
        return kassenMeldung(r.error || 'Die Bestellung hat nicht geklappt – bitte versuch es noch einmal.', ADRESSFELDER.includes(r.feld) ? r.feld : null);
      }
      // hochgeladen = Positionen, deren Druckdatei schon angekommen ist (ein neuer Versuch lädt sie nicht noch einmal)
      merken(r.orderId, { accessKey: r.accessKey || '', total: r.total });
    }
    // Zugriffsschlüssel der Bestellung: ohne ihn nimmt der Server weder Druckdateien noch den Abschluss an
    const orderKey = { 'x-order-key': r.accessKey || '' };

    // Druckdateien erzeugen & hochladen — aus den gesendeten Positionen (nicht aus einem inzwischen geänderten Warenkorb); eine schon
    // abgeschlossene Bestellung hat alle
    const pos = body.items;
    for (let i = 0; i < pos.length && !offeneKasse?.abgeschlossen; i++) {
      if (offeneKasse?.hochgeladen?.includes(i)) continue;
      prog.textContent = `Erzeuge Druckdatei ${i + 1}/${pos.length} …`;
      let buf;
      try { ({ buffer: buf } = await exportModel(pos[i].config)); } catch (err) {   // STL oder 3MF (Farbschrift)
        console.warn('Druckdatei', err);
        return kassenMeldung(nichtAbgeschlossen(`Die Druckdatei für Position ${i + 1} ließ sich nicht erzeugen`, payment));
      }
      prog.textContent = `Lade Druckdatei ${i + 1}/${pos.length} hoch (${(buf.byteLength / 1e6).toFixed(1).replace('.', ',')} MB) …`;
      const up = await kassenAnfrage(`/api/order/${r.orderId}/stl/${i}`, {
        method: 'PUT', headers: { 'Content-Type': 'model/stl', ...orderKey }, body: buf,
      });
      // Meldung des Servers zeigen (z. B. 413 Datei zu groß, 429 zu viele Uploads, 507 Speicher knapp), sonst die allgemeine
      if (!up.ok) return kassenMeldung(nichtAbgeschlossen(grundVon(up, 'beim Hochladen der Druckdatei'), payment));
      offeneKasse?.hochgeladen?.push(i);
    }
    prog.textContent = 'Erstelle Rechnung …';
    const done = await kassenAnfrage(`/api/order/${r.orderId}/complete`, { method: 'POST', headers: orderKey });
    if (!done.ok) {
      // Keine Antwort: der Abschluss kann trotzdem angekommen sein — der nächste Klick ruft ihn noch einmal auf (für eine abgeschlossene
      // Bestellung antwortet der Server wieder mit der Rechnung) bzw. fragt nach einer Änderung erst nach (offeneKlaeren)
      if (done.netz || done.kaputt) {
        if (offeneKasse) offeneKasse.abschlussUnklar = true;
        return kassenMeldung(abschlussOffen(done, payment));
      }
      // Vorübergehend abgelehnt (Wartung, Serverfehler, zu viele Anfragen): dieselbe Bestellung bleibt offen, der nächste Klick setzt
      // dort fort (bei PayPal mit derselben Zahlung). Nach einem Serverfehler kann der Abschluss trotzdem durch sein → erst nachfragen
      if (done.httpStatus >= 500 || done.httpStatus === 429) {
        if (offeneKasse) offeneKasse.abschlussUnklar = done.httpStatus >= 500;
        return kassenMeldung(nichtAbgeschlossen(done.error || 'der Shop antwortet gerade nicht', payment));
      }
      if (offeneKasse) offeneKasse.abschlussUnklar = false;   // der Shop hat geantwortet: nicht abgeschlossen
      // Druckdatei fehlt/unvollständig: dieselbe Bestellung, Dateien beim nächsten Versuch noch einmal hochladen
      if (done.code === 'dateien' && offeneKasse) { offeneKasse.hochgeladen = []; return kassenMeldung(nichtAbgeschlossen(done.error, payment)); }
      // Abschluss abgelehnt (z. B. Guthaben inzwischen eingelöst, Gutschein mit Höchstzahl vergeben): diese Bestellung ist erledigt —
      // der nächste Versuch beginnt neu; den Gutschein neu prüfen, damit die Kasse den aktuellen Stand zeigt
      offeneKasse = null;
      if (['guthaben', 'gutschein'].includes(done.code) && $('#co-coupon').value.trim()) await applyCoupon();
      return kassenMeldung(done.error || 'Die Bestellung konnte nicht abgeschlossen werden – bitte versuch es noch einmal.');
    }
    const gesamt = offeneKasse?.total ?? body.expectedTotal;
    offeneKasse = null;

    // Warenkorb leeren — nach einer fortgesetzten, inzwischen geänderten Kasse nur um die bestellten Positionen kürzen (was nicht in
    // der Bestellung ist, z. B. eine danach dazugelegte Vase, bleibt liegen)
    cart = geaendert ? ohneBestellte(cart, body.items) : [];
    const restImKorb = cart.length > 0;
    coupon = null;
    if ($('#co-beschaffenheit')) $('#co-beschaffenheit').checked = false;   // gilt je Bestellung
    $('#co-coupon').value = '';
    $('#co-coupon-msg').textContent = '';
    saveCart();
    $('#checkout-modal').close();
    $('#confirm-id').textContent = r.orderId;
    $('#confirm-invoice').href = done.invoiceUrl;
    const pdfLink = $('#confirm-invoice-pdf');   // PDF-Fassung der Rechnung (fehlt sie in der Antwort, bleibt der Link verborgen)
    if (pdfLink) { pdfLink.hidden = !done.invoicePdfUrl; pdfLink.href = done.invoicePdfUrl || '#'; }
    // Lieferfrist wie in Bestellbestätigung, Rechnung und AGB § 7 — der Satz zum Fristbeginn kommt vom Server (/api/pricing → shop.fristBeginn)
    const { lieferzeit } = shopInfo();
    const frist = pricing()?.shop?.fristBeginn?.[payment === 'paypal' ? 'paypal' : 'vorkasse']
      || (payment === 'paypal' ? 'Die Frist beginnt am Tag nach Vertragsschluss, also am Tag nach deiner Bestellung.' : 'Die Frist beginnt am Tag nach deinem Überweisungsauftrag an deine Bank.');
    // Nichts zu zahlen: keine Überweisung — die Frist beginnt wie bei PayPal am Tag nach der Bestellung
    const fristOhneZahlung = pricing()?.shop?.fristBeginn?.paypal || 'Die Frist beginnt am Tag nach Vertragsschluss, also am Tag nach deiner Bestellung.';
    const mitBank = dankeZahlung(payment, done, gesamt);
    const hinweis = payment === 'paypal'
      ? `Deine Zahlung ist eingegangen, ich starte jetzt den Druck. Lieferzeit: ${lieferzeit}. ${frist}`
      : nichtsZuZahlen
        ? `Es ist nichts zu zahlen – dein Gutschein bzw. Guthaben deckt den Gesamtbetrag. Ich starte jetzt den Druck. Lieferzeit: ${lieferzeit}. ${fristOhneZahlung}`
        : `${mitBank ? 'Die Bankverbindung steht auch auf deiner Rechnung und in deiner Bestellbestätigung.' : 'Alle Zahlungsdaten (IBAN & Betrag) findest du auf deiner Rechnung.'} Sobald dein Geld da ist, starte ich den Druck. Lieferzeit: ${lieferzeit}. ${frist}`;
    $('#confirm-pay-hint').textContent = geaendert
      ? `${hinweis} ${AENDERUNG_NICHT_DRIN}${restImKorb ? ' Was nicht in dieser Bestellung ist, liegt weiter in deinem Warenkorb.' : ''}` : hinweis;
    $('#confirm-modal').showModal();
    refreshOrders(); // Bestellhistorie im Konto aktualisieren
  } catch (err) {
    console.warn('Kasse', err);
    if (offeneKasse) kassenMeldung(nichtAbgeschlossen('Das hat gerade nicht geklappt', offeneKasse.payment));
    else if (payment === 'paypal' && paypalOrderId) {
      // bezahlt, aber vor dem Anlegen abgebrochen: der nächste Klick versucht es mit derselben Zahlung
      offeneKasse = { sig: null, payment, body: null, orderId: null, accessKey: '', paypalOrderId, total: null, hochgeladen: [] };
      kassenMeldung(paypalOhneBestellung('aber danach ist etwas schiefgegangen'));
    } else kassenMeldung('Die Bestellung hat gerade nicht geklappt – bitte versuch es noch einmal.');
  } finally {
    kasseLaeuft = Math.max(0, kasseLaeuft - 1);
    btn.disabled = false;
    prog.textContent = '';
  }
}
/**
 * Warenkorb ohne die bestellten Positionen (gleiches Produkt, Design, Untersetzer und gleiche Farbe; die bestellte Menge wird
 * abgezogen) — nach einer fortgesetzten Kasse, deren Warenkorb nach dem ersten Klick noch geändert wurde
 */
function ohneBestellte(liste, bestellt) {
  const key = (it) => JSON.stringify([it.product, !!it.saucer, it.config, it.color || null]);
  const offen = new Map();
  for (const b of bestellt || []) offen.set(key(b), (offen.get(key(b)) || 0) + (Number(b.qty) || 0));
  return liste.map((it) => {
    const n = Math.min(offen.get(key(it)) || 0, it.qty);
    if (!n) return it;
    offen.set(key(it), (offen.get(key(it)) || 0) - n);
    return { ...it, qty: it.qty - n };
  }).filter((it) => it.qty > 0);
}
/**
 * Danke-Ansicht: Gesamtbetrag (mit Guthaben: auch „Zu zahlen“), bei 0 € „Nichts zu zahlen“, bei offener Vorkasse Bankverbindung und
 * Verwendungszweck wie auf der Rechnung (aus der Antwort von /complete; „kopieren“ für IBAN und Verwendungszweck). → true, wenn die
 * Bankverbindung dasteht. Ohne die Angaben (älterer Server) oder ohne #confirm-zahlung (ältere index.html) nur der Rechnungslink.
 */
function dankeZahlung(payment, done, gesamtKasse) {
  const box = $('#confirm-zahlung');
  if (!box) return false;
  const zahl = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const zu = zahl(done.zuZahlen) ?? zahl(gesamtKasse);
  if (zu === null) { box.hidden = true; return false; }
  const gesamt = zahl(done.gesamtbetrag) ?? zu;
  const teile = [`Gesamtbetrag: <b>${esc(fmt(gesamt))}</b>`];
  if (gesamt - zu > 0.004) teile.push(`zu zahlen nach deinem Guthaben: <b>${esc(fmt(zu))}</b>`);
  if (!(zu > 0)) teile.push('<b>Nichts zu zahlen</b>');
  else if (payment === 'paypal') teile.push('bezahlt mit PayPal');
  let html = `<p>${teile.join(' · ')}</p>`;
  const b = payment !== 'paypal' && zu > 0 && done.bank && typeof done.bank === 'object' ? done.bank : null;
  if (b) {
    const zeilen = [['Empfänger', b.empfaenger], ['IBAN', b.iban, true], ['BIC', b.bic], ['Bank', b.bank], ['Betrag', fmt(zu)], ['Verwendungszweck', b.verwendungszweck, true]]
      .filter(([, v]) => String(v || '').trim());
    html += `<p>Bitte überweise den Betrag innerhalb von ${Number(done.zahlungsfristTage) || 14} Tagen mit deiner Bestellnummer als Verwendungszweck:</p>` +
      '<table style="margin:4px auto 0;border-collapse:collapse;text-align:left">' + zeilen.map(([k, v, kopie]) =>
        `<tr><th style="padding:2px 12px 2px 0;font-weight:400;color:var(--ink-soft)">${esc(k)}</th><td style="padding:2px 0"><b>${esc(v)}</b>` +
        `${kopie ? ` <button type="button" class="linkbtn" data-kopie="${esc(String(v).replace(/\s+/g, k === 'IBAN' ? '' : ' '))}">kopieren</button>` : ''}</td></tr>`).join('') + '</table>';
  }
  box.innerHTML = html;
  box.hidden = false;
  box.querySelectorAll('[data-kopie]').forEach((k) => k.addEventListener('click', async () => {
    const ok = await copyText(k.dataset.kopie);
    k.textContent = ok ? '✓ kopiert' : 'bitte markieren';
    setTimeout(() => { k.textContent = 'kopieren'; }, 1600);
  }));
  return !!b;
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
  $('#co-coupon-btn').addEventListener('click', () => { kassenMeldung(''); applyCoupon(); });
  // Anderer Code oder Feld geleert: ein bestätigter Gutschein gilt sofort nicht mehr (die Kasse zeigt, was bestellt würde);
  // „✕ entfernen“ neben der Erfolgsmeldung leert das Feld
  $('#co-coupon').addEventListener('input', () => {
    const v = $('#co-coupon').value.trim().toUpperCase();
    if (!(coupon && String(coupon.code).toUpperCase() === v)) gutscheinWeg();
  });
  $('#co-coupon-msg').addEventListener('click', (e) => {
    if (e.target.closest?.('#co-coupon-del')) { gutscheinWeg(true); kassenMeldung(''); $('#co-coupon').focus(); }
  });
  emailFeldPruefen($('#co-email'));   // Umlaute vor dem @ → Meldung direkt am Feld (wie der Server)
  // Meldung des Servers am Feld (kassenMeldung) gilt bis zur nächsten Eingabe; E-Mail und PLZ prüfen dabei ihre eigene Regel
  for (const k of ADRESSFELDER) $(`#co-${k}`)?.addEventListener('input', (e) => feldPruefen(e.target));
  // Nur der Knopf „Zahlungspflichtig bestellen“ bestellt. Enter/„Los“ in einem Feld der Kasse schickt das Formular nicht ab
  // (implizites Absenden — der Browser „klickt“ dabei den Standardknopf, auch einen versteckten): im Gutscheinfeld löst Enter den
  // Gutschein ein, sonst geht es ins nächste Feld. Enter/Leertaste auf einem fokussierten Knopf bleiben normal bedienbar.
  let enterImFeld = 0, knopfBedient = 0;
  const knopf = $('#co-submit');
  // Bestellknopf selbst bedient (Maus, Finger, Enter/Leertaste auf dem Knopf) — ein implizites Absenden berührt ihn nicht
  knopf.addEventListener('pointerdown', () => { knopfBedient = Date.now(); });
  knopf.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') knopfBedient = Date.now(); });
  $('#checkout-form').addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key !== 'Enter' || !(t instanceof HTMLInputElement) || ['submit', 'button', 'reset', 'image'].includes(t.type)) return;
    enterImFeld = Date.now();
    if (e.isComposing) return;   // Enter übernimmt nur die Eingabe der Tastatur (Wortvorschlag, IME)
    e.preventDefault();
    if (t.id === 'co-coupon') { kassenMeldung(''); applyCoupon(); } else if (t.type !== 'checkbox' && t.type !== 'radio') naechstesFeld(t);
  });
  $('#checkout-form').addEventListener('submit', (e) => {
    e.preventDefault();
    // Jedes Absenden bei gewählter Zahlart PayPal zählt nicht — dort bestellt nur der PayPal-Knopf, nie entsteht eine Vorkasse-Bestellung
    if ($('#pay-paypal')?.checked) return;
    if (e.submitter && e.submitter !== knopf) return;
    // Sicherung, falls ein Browser nach Enter in einem Feld trotzdem implizit absendet: das zählt nicht, außer der Knopf selbst wurde
    // gerade bedient (ein echter Klick kurz nach Enter bestellt also) — und statt stillem Nichtstun steht da, was zu tun ist
    const direkt = Date.now() - knopfBedient < 3000;
    knopfBedient = 0;
    if (!direkt && Date.now() - enterImFeld < 1000) return kassenMeldung('Zum Bestellen tipp bitte auf „Zahlungspflichtig bestellen“.');
    bestellen();
  });
  // Abgemeldet (Konto-Dialog, abgelaufene Anmeldung): was die Kasse aus dem Konto vorbefüllt hat bzw. was den Kontodaten gleicht,
  // verschwindet — am geteilten Gerät sieht die nächste Person Name, E-Mail und Adresse nicht mehr. Selbst Getipptes (anderer Wert),
  // Anmerkung, Gutschein und Warenkorb bleiben.
  window.addEventListener('ovju:abgemeldet', (e) => {
    const u = e.detail || {};
    const konto = { name: u.name, email: u.email, street: u.address?.street, zip: u.address?.zip, city: u.address?.city };
    for (const k of ADRESSFELDER) {
      const f = $(`#co-${k}`);
      const v = f?.value.trim();
      if (v && [ausKonto[k], konto[k]].some((x) => x && String(x).trim() === v)) { f.value = ''; feldPruefen(f); }
      delete ausKonto[k];
    }
  });
  $$('input[name=pay]').forEach((r) => r.addEventListener('change', () => {
    const pp = $('#pay-paypal').checked;
    $('#paypal-buttons').hidden = !pp;
    $('#co-submit').hidden = pp;
    if (pp && pricing().paypal?.enabled && !paypalReady) setupPayPal();
  }));
  $('#confirm-close').addEventListener('click', () => $('#confirm-modal').close());
}
