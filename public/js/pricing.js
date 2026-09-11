// OVJU — Preislogik (reine Rechnung, ohne DOM/Three): muss identisch zu priceItem() in server.js rechnen.
// Aufpreise kommen ausschließlich aus den öffentlichen APIs (/api/pricing: muster, farbschrift, gravur, volumen;
// /api/colors: aufpreis je Farbe) — hier gibt es keine festen Beträge.

let pricing = null; // Antwort von /api/pricing
let colors = [];    // Antwort von /api/colors (id, name, hex, finish, aufpreis)

export function setPricing(p) { pricing = p || null; }
export function getPricing() { return pricing; }
export function setColors(list) { colors = Array.isArray(list) ? list : []; }
export function getColors() { return colors; }

const r2 = (v) => Math.round(v * 100) / 100;

export function fmt(v) {
  return (Number(v) || 0).toLocaleString('de-DE', { style: 'currency', currency: pricing?.currency || 'EUR' });
}
/** Kurzform für Badges: „+3 €“ bzw. „+2,50 €“ */
export function fmtPlus(v) {
  const n = Number(v) || 0;
  const s = Number.isInteger(n) ? String(n) : n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `+${s} €`;
}
/** "2 Stück −20 % · 4 Stück −35 %" für die Preisbox */
export function discountTeaser(product) {
  const tiers = pricing?.products?.[product]?.discounts || [];
  return tiers.map((t) => `${t.qty} Stück −${t.off} %`).join(' · ');
}

export function discountFor(product, qty) {
  let off = 0;
  for (const t of (pricing?.products?.[product]?.discounts || [])) if (qty >= t.qty && t.off > off) off = t.off;
  return off;
}

/** Größenaufschlag (identische Formel wie auf dem Server) */
export function volumeSurcharge(product, config) {
  const vol = pricing?.volumen || {};
  const h0 = pricing?.normalHeight?.[product] || 1;
  const h = Number(config?.height) || h0;
  const w = Number(config?.width) || 1;
  const extra = Math.max(0, (h / h0) * w * w - 1);
  if (extra <= 0) return 0;
  const base = pricing?.products?.[product]?.single || 0;
  return r2(extra * ((vol.prozent || 0) / 100 * base + (vol.euro || 0)));
}

/** Gravur-Regel (Spiegel von server.js/geometry): Lamellen & Fjordwelle über 2,5 mm Tiefe → keine Gravur */
export function gravurAllowed(c) {
  const depth = +c?.depth || 0;
  if ((c?.pattern === 'lamellen' || c?.pattern === 'koralle') && depth > 2.5) return false;
  return true;
}

/** Farbe zu einer Warenkorb-Zeile: erst per ID, sonst per Name ohne Finish-Suffix („Gold · metallic“ / „Gold (metallic)“) */
export function colorByRef(id, name) {
  if (id) { const c = colors.find((x) => x.id === id); if (c) return c; }
  const n = String(name || '').trim();
  if (!n) return null;
  const bare = n.replace(/\s*(·.*|\(.*\))$/, '').trim();
  return colors.find((x) => x.name === n) || colors.find((x) => x.name === bare) || null;
}
/** Aufpreis der Körperfarbe in € (0 wenn unbekannt) */
export function colorSurcharge(id, name) {
  return Math.max(0, Number(colorByRef(id, name)?.aufpreis) || 0);
}
/** Aufpreis eines Musters in € (0 wenn nicht gesetzt) */
export function patternSurcharge(pattern) {
  return Math.max(0, Number(pricing?.muster?.[pattern]) || 0);
}

/**
 * Aufschlüsselung des Stückpreises — gleiche Felder wie priceItem().parts auf dem Server.
 * item = { product, saucer, config: { text, textStyle, pattern, depth, height, width }, color, colorName }
 */
export function unitParts(item) {
  const p = pricing?.products?.[item?.product];
  const zero = { grund: 0, untersetzer: 0, gravur: 0, farbschrift: 0, muster: 0, farbe: 0, groesse: 0 };
  if (!p) return zero;
  const c = item.config || {};
  const hasText = !!String(c.text || '').trim() && gravurAllowed(c);
  return {
    grund: p.single,
    untersetzer: item.product === 'eierbecher' && item.saucer ? (p.untersetzer || 0) : 0,
    gravur: hasText ? (pricing.gravur || 0) : 0,
    farbschrift: hasText && c.textStyle === 'farbe' ? (pricing.farbschrift || 0) : 0,
    muster: patternSurcharge(c.pattern),
    farbe: colorSurcharge(item.color, item.colorName),
    groesse: volumeSurcharge(item.product, c),
  };
}
export function unitPrice(item) {
  const q = unitParts(item);
  return r2(q.grund + q.untersetzer + q.gravur + q.farbschrift + q.muster + q.farbe + q.groesse);
}
export function linePrice(item) {
  const off = discountFor(item.product, item.qty);
  return { off, line: r2(unitPrice(item) * item.qty * (1 - off / 100)) };
}
