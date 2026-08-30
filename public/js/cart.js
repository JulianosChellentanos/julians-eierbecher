// OVJU — Warenkorb & Checkout (Preise kommen live vom Server: /api/pricing)
import { makeSTL } from './modelfactory.js';
import { PRODUCTS, PATTERNS, FLOWS, FONTS } from './geometry.js';
import { getAuthHeaders, getUser, refreshOrders } from './auth.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const LS_KEY = 'ovju-cart-v1';

let pricing = null;
let cart = [];

export async function initPricing() {
  if (!pricing) pricing = await (await fetch('/api/pricing')).json();
  return pricing;
}
export function getPricing() { return pricing; }
export function fmt(v) {
  return v.toLocaleString('de-DE', { style: 'currency', currency: pricing?.currency || 'EUR' });
}
/** "2 Stück −20 % · 4 Stück −35 %" für die Preisbox */
export function discountTeaser(product) {
  const tiers = pricing?.products?.[product]?.discounts || [];
  return tiers.map((t) => `${t.qty} Stück −${t.off} %`).join(' · ');
}

function loadCart() {
  try { cart = JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { cart = []; }
}
function saveCart() {
  localStorage.setItem(LS_KEY, JSON.stringify(cart));
  renderBadge();
}
function discountFor(product, qty) {
  let off = 0;
  for (const t of (pricing.products[product]?.discounts || [])) if (qty >= t.qty && t.off > off) off = t.off;
  return off;
}
function unitPrice(item) {
  const p = pricing.products[item.product];
  return p.single + (item.product === 'eierbecher' && item.saucer ? p.untersetzer : 0);
}
function linePrice(item) {
  const off = discountFor(item.product, item.qty);
  return { off, line: Math.round(unitPrice(item) * item.qty * (1 - off / 100) * 100) / 100 };
}
function totals() {
  const subtotal = Math.round(cart.reduce((s, it) => s + linePrice(it).line, 0) * 100) / 100;
  const shipping = cart.length === 0 ? 0 : (subtotal >= pricing.shipping.freeFrom ? 0 : pricing.shipping.flat);
  return { subtotal, shipping, total: Math.round((subtotal + shipping) * 100) / 100 };
}

function itemTitle(it) {
  const prod = PRODUCTS[it.product];
  const preset = it.config.preset === 'eigene' ? 'Eigene Form' : (prod.presets[it.config.preset]?.label || it.config.preset);
  return `${prod.label} „${preset}“`;
}
function itemSub(it) {
  const c = it.config;
  const flow = (c.twist && c.pattern !== 'glatt' && c.pattern !== 'querwellen') ? ` (${FLOWS[c.flow] || 'Spirale'})` : '';
  return `${PATTERNS[c.pattern] || c.pattern}${flow} · ${c.height} mm · ${it.colorName}` +
    (c.text ? ` · „${c.text}“ (${FONTS[c.font]?.label || ''})` : '') +
    (it.saucer ? ' · 🍽️ Untersetzer' : '');
}

// ---------------------------------------------------------------------------
// In den Warenkorb
// ---------------------------------------------------------------------------
export function addToCart({ config, colorName, colorHex, thumb }) {
  // Identisches Design (gleiche Konfiguration & Farbe) → Menge erhöhen (Rabatt!)
  const sig = JSON.stringify({ ...config, colorName });
  const existing = cart.find((it) => it.sig === sig);
  if (existing) {
    existing.qty = Math.min(50, existing.qty + 1);
  } else {
    cart.push({
      sig, product: config.product, config, colorName, colorHex, thumb,
      saucer: !!config.saucer, qty: 1,
    });
  }
  saveCart();
  openCart();
}

// ---------------------------------------------------------------------------
// Warenkorb-UI
// ---------------------------------------------------------------------------
function renderBadge() {
  const n = cart.reduce((s, it) => s + it.qty, 0);
  $('#cart-count').textContent = n;
  $('#cart-btn').classList.toggle('has-items', n > 0);
}

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
      const { off, line } = linePrice(it);
      const nextTier = (pricing.products[it.product].discounts || []).find((t) => t.qty > it.qty);
      return `<div class="cart-item">
        <img src="${it.thumb}" alt="">
        <div class="ci-main">
          <b>${itemTitle(it)}</b>
          <small>${itemSub(it)}</small>
          <div class="ci-qty">
            <button data-i="${i}" data-d="-1">−</button><span>${it.qty}</span><button data-i="${i}" data-d="1">+</button>
            ${off ? `<span class="ci-off">−${off} %</span>` : ''}
            ${nextTier ? `<small class="ci-hint">ab ${nextTier.qty} St. −${nextTier.off} %</small>` : ''}
          </div>
        </div>
        <div class="ci-right"><b>${fmt(line)}</b><button class="ci-del" data-del="${i}" title="Entfernen">🗑</button></div>
      </div>`;
    }).join('');
  }
  const t = totals();
  $('#cart-totals').innerHTML = cart.length ? `
    <div><span>Zwischensumme</span><b>${fmt(t.subtotal)}</b></div>
    <div><span>Versand</span><b>${t.shipping === 0 ? 'kostenlos' : fmt(t.shipping)}</b></div>
    ${t.shipping > 0 ? `<small>Noch ${fmt(pricing.shipping.freeFrom - t.subtotal)} bis zum Gratisversand</small>` : ''}
    <div class="ct-grand"><span>Gesamt</span><b>${fmt(t.total)}</b></div>` : '';
  $('#cart-checkout').disabled = !cart.length;

  box.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => {
    const it = cart[+b.dataset.i];
    it.qty = Math.max(1, Math.min(50, it.qty + (+b.dataset.d)));
    saveCart(); renderCart();
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
let coupon = null; // { code, off } — vom Server bestätigt

function checkoutTotals() {
  const t = totals();
  if (!coupon) return t;
  const after = Math.round((t.subtotal - coupon.off) * 100) / 100;
  const shipping = after >= pricing.shipping.freeFrom ? 0 : pricing.shipping.flat;
  return { ...t, shipping, total: Math.round((after + shipping) * 100) / 100 };
}

function renderCheckoutSummary() {
  const t = checkoutTotals();
  $('#co-summary').innerHTML = cart.map((it) => {
    const { off, line } = linePrice(it);
    return `<div><span>${it.qty}× ${itemTitle(it)}${off ? ` <em>(−${off} %)</em>` : ''}</span><b>${fmt(line)}</b></div>`;
  }).join('') + `
    ${coupon ? `<div><span>🎟️ Gutschein „${coupon.code}“</span><b>−${fmt(coupon.off)}</b></div>` : ''}
    <div><span>Versand</span><b>${t.shipping === 0 ? 'kostenlos' : fmt(t.shipping)}</b></div>
    <div class="ct-grand"><span>Gesamt</span><b>${fmt(t.total)}</b></div>`;
}

async function applyCoupon() {
  const code = $('#co-coupon').value.trim();
  const msg = $('#co-coupon-msg');
  if (!code) { coupon = null; msg.textContent = ''; renderCheckoutSummary(); return; }
  const r = await (await fetch('/api/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: cartPayload(), couponCode: code }),
  })).json();
  if (r.coupon) {
    coupon = { code: r.coupon.code, off: r.coupon.off };
    msg.textContent = `✅ Gutschein „${r.coupon.code}“ eingelöst: −${fmt(r.coupon.off)}`;
    msg.className = 'tiny ok-msg';
  } else {
    coupon = null;
    msg.textContent = '❌ Code ungültig oder Mindestbestellwert nicht erreicht.';
    msg.className = 'tiny warn-msg';
  }
  renderCheckoutSummary();
}

function openCheckout() {
  $('#cart-modal').close();
  renderCheckoutSummary();
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
  const pp = pricing.paypal?.enabled;
  $('#pay-paypal-row').hidden = !pp;
  if (!pp) $('#pay-vorkasse').checked = true;
  $('#checkout-modal').showModal();
  if (pp && !paypalReady) setupPayPal();
}

function setupPayPal() {
  paypalReady = true;
  const s = document.createElement('script');
  s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(pricing.paypal.clientId)}&currency=EUR&intent=capture`;
  s.onload = () => {
    window.paypal?.Buttons({
      createOrder: async () => {
        const r = await (await fetch('/api/paypal/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: cartPayload(), couponCode: coupon?.code || null }),
        })).json();
        if (!r.ok) throw new Error(r.error);
        return r.id;
      },
      onApprove: async (data) => {
        const r = await (await fetch(`/api/paypal/capture/${data.orderID}`, { method: 'POST' })).json();
        if (!r.ok) { alert('Zahlung fehlgeschlagen'); return; }
        await submitOrder('paypal', data.orderID);
      },
    }).render('#paypal-buttons');
  };
  document.head.appendChild(s);
}

function cartPayload() {
  return cart.map((it) => ({
    product: it.product, qty: it.qty, saucer: it.saucer,
    config: it.config, colorName: it.colorName,
  }));
}

async function submitOrder(payment, paypalOrderId = null) {
  const btn = $('#co-submit');
  const prog = $('#co-progress');
  btn.disabled = true;
  try {
    prog.textContent = 'Bestellung wird angelegt …';
    const customer = {
      name: $('#co-name').value, email: $('#co-email').value,
      street: $('#co-street').value, zip: $('#co-zip').value, city: $('#co-city').value,
      note: $('#co-note').value,
    };
    const r = await (await fetch('/api/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ customer, items: cartPayload(), payment, paypalOrderId, couponCode: coupon?.code || null }),
    })).json();
    if (!r.ok) throw new Error(r.error);

    // Druckdateien erzeugen & hochladen
    for (let i = 0; i < cart.length; i++) {
      prog.textContent = `Erzeuge Druckdatei ${i + 1}/${cart.length} …`;
      const buf = await makeSTL(cart[i].config);
      prog.textContent = `Lade Druckdatei ${i + 1}/${cart.length} hoch (${(buf.byteLength / 1e6).toFixed(1)} MB) …`;
      const up = await fetch(`/api/order/${r.orderId}/stl/${i}`, {
        method: 'PUT', headers: { 'Content-Type': 'model/stl' }, body: buf,
      });
      if (!up.ok) throw new Error('Upload fehlgeschlagen');
    }
    prog.textContent = 'Erstelle Rechnung …';
    const done = await (await fetch(`/api/order/${r.orderId}/complete`, { method: 'POST' })).json();

    cart = [];
    coupon = null;
    $('#co-coupon').value = '';
    $('#co-coupon-msg').textContent = '';
    saveCart();
    $('#checkout-modal').close();
    $('#confirm-id').textContent = r.orderId;
    $('#confirm-invoice').href = done.invoiceUrl;
    $('#confirm-pay-hint').textContent = payment === 'paypal'
      ? 'Deine Zahlung ist eingegangen — wir starten den Druck!'
      : 'Alle Zahlungsdaten (IBAN & Betrag) findest du auf deiner Rechnung.';
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
  $('#cart-btn').addEventListener('click', openCart);
  $('#cart-close').addEventListener('click', () => $('#cart-modal').close());
  $('#cart-checkout').addEventListener('click', openCheckout);
  $('#co-back').addEventListener('click', () => { $('#checkout-modal').close(); openCart(); });
  $('#co-coupon-btn').addEventListener('click', applyCoupon);
  $('#checkout-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitOrder('vorkasse');
  });
  $$('input[name=pay]').forEach((r) => r.addEventListener('change', () => {
    const pp = $('#pay-paypal').checked;
    $('#paypal-buttons').hidden = !pp;
    $('#co-submit').hidden = pp;
  }));
  $('#confirm-close').addEventListener('click', () => $('#confirm-modal').close());
}
