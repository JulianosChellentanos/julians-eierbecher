// OVJU — Preislogik (reine Rechnung, ohne DOM/Three): muss identisch zu priceItem() in server.js rechnen.
// Aufpreise kommen ausschließlich aus den öffentlichen APIs (/api/pricing: muster, farbschrift, gravur, volumen,
// aktion + serverNow; /api/colors: aufpreis je Farbe) — hier gibt es keine festen Beträge.
//
// Aktionen (Rabatt in % auf den Stückpreis, zeitlich begrenzt): der Server liefert unter pricing.aktion die gerade
// laufende Aktion (oder null) und unter serverNow seine Uhrzeit. Die Restzeit wird mit der korrigierten Zeit
// (Server-Uhr − Client-Uhr beim Laden) gerechnet; ist die Aktion abgelaufen, rechnet aktionFor() sofort ohne sie.

let pricing = null; // Antwort von /api/pricing
let colors = [];    // Antwort von /api/colors (id, name, hex, finish, aufpreis)
let timeOffset = 0; // serverNow − Date.now() beim Laden (ms)
const endeHooks = []; // Re-Render-Callbacks, wenn die Aktion abläuft (oder eine neue beginnt)

export function setPricing(p) {
  pricing = p || null;
  const sn = Date.parse(pricing?.serverNow || '');
  timeOffset = Number.isFinite(sn) ? sn - Date.now() : 0;
}
export function getPricing() { return pricing; }
export function setColors(list) { colors = Array.isArray(list) ? list : []; }
export function getColors() { return colors; }
/** Aktuelle Zeit nach Server-Uhr (ms) */
export function serverTime() { return Date.now() + timeOffset; }

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

// ---------------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------------
/** Laufende Aktion (unabhängig vom Produkt) — null, wenn keine läuft oder sie nach Server-Uhr schon vorbei ist */
export function aktionCurrent() {
  const a = pricing?.aktion;
  if (!a || !(Number(a.prozent) > 0)) return null;
  const now = serverTime();
  const ende = Date.parse(a.ende || '');
  const start = Date.parse(a.start || '');
  if (!Number.isFinite(ende) || ende <= now) return null;
  if (Number.isFinite(start) && start > now) return null;
  return a;
}
/** Aktion für ein Produkt → { id, prozent, name, ende, mengenrabatt, produkte, hinweis } | null */
export function aktionFor(product) {
  const a = aktionCurrent();
  if (!a) return null;
  const scope = a.produkte || 'alle';
  if (scope !== 'alle' && scope !== product) return null;
  return {
    id: a.id, prozent: Math.round(Number(a.prozent)), name: String(a.name || 'Aktion'), ende: a.ende,
    mengenrabatt: !!a.mengenrabatt, produkte: scope, hinweis: String(a.hinweis || ''),
  };
}
/** Restlaufzeit der Aktion in ms (0 ohne Aktion) */
export function aktionRemaining() {
  const a = aktionCurrent();
  return a ? Math.max(0, Date.parse(a.ende) - serverTime()) : 0;
}
/**
 * Countdown-Text: „endet in 1 Tag 3 Std“, unter 24 h „endet in 3 Std 12 Min“,
 * unter 1 h „endet in 12:34 Min“ (mit Sekunden), unter 1 Min „endet gleich“.
 * kurz = true: Kurzform für enge Stellen (Mobile-Leiste) — „noch 1 Tag 3 Std“ statt „endet in …“.
 */
export function formatRemaining(ms, kurz = false) {
  const t = Math.max(0, Number(ms) || 0);
  const MIN = 60e3, H = 3600e3, D = 86400e3;
  const pre = kurz ? 'noch' : 'endet in';
  if (t < MIN) return 'endet gleich';
  if (t < H) {
    const m = Math.floor(t / MIN), s = Math.floor(t / 1000) % 60;
    return `${pre} ${m}:${String(s).padStart(2, '0')} Min`;
  }
  if (t < D) {
    const h = Math.floor(t / H), m = Math.floor(t / MIN) % 60;
    return `${pre} ${h} Std${m ? ` ${m} Min` : ''}`;
  }
  const d = Math.floor(t / D), h = Math.floor(t / H) % 24;
  return `${pre} ${d} ${d === 1 ? 'Tag' : 'Tage'}${h ? ` ${h} Std` : ''}`;
}
export function aktionText() { return formatRemaining(aktionRemaining()); }
/** Kurzform „noch 1 Tag 3 Std“ (Mobile-Leiste; Stellen mit data-kurz werden von aktion.js damit aufgefrischt) */
export function aktionTextKurz() { return formatRemaining(aktionRemaining(), true); }
/** Callback, wenn die Aktion abläuft (oder nach dem Nachladen eine neue beginnt) → Preise neu rendern */
export function onAktionEnde(cb) { if (typeof cb === 'function') endeHooks.push(cb); }
export function notifyAktionChange() {
  for (const cb of endeHooks) { try { cb(); } catch (e) { console.warn('Aktion-Callback', e); } }
}
/** Aktion clientseitig beenden: Streichpreise weg, alle Preise ohne Aktion neu rendern */
export function expireAktion() {
  if (pricing) pricing.aktion = null;
  notifyAktionChange();
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
 * Aufschlüsselung des Stückpreises — gleiche Felder wie priceItem().parts auf dem Server, ergänzt um
 * uvp (Stückpreis inkl. aller Aufpreise, ohne Aktion), unit (Aktionspreis), aktionProzent, aktionBetrag, aktionName.
 * item = { product, saucer, config: { text, textStyle, pattern, depth, height, width }, color, colorName }
 */
export function unitParts(item) {
  const p = pricing?.products?.[item?.product];
  const zero = { grund: 0, untersetzer: 0, gravur: 0, farbschrift: 0, muster: 0, farbe: 0, groesse: 0, uvp: 0, unit: 0, aktionProzent: 0, aktionBetrag: 0, aktionName: null };
  if (!p) return zero;
  const c = item.config || {};
  const hasText = !!String(c.text || '').trim() && gravurAllowed(c);
  const parts = {
    grund: p.single,
    untersetzer: item.product === 'eierbecher' && item.saucer ? (p.untersetzer || 0) : 0,
    gravur: hasText ? (pricing.gravur || 0) : 0,
    farbschrift: hasText && c.textStyle === 'farbe' ? (pricing.farbschrift || 0) : 0,
    muster: patternSurcharge(c.pattern),
    farbe: colorSurcharge(item.color, item.colorName),
    groesse: volumeSurcharge(item.product, c),
  };
  // Aktion: uvp = bisheriger Stückpreis, unit = round2(uvp · (1 − p/100)) — Formel wie priceItem() auf dem Server
  const uvp = r2(parts.grund + parts.untersetzer + parts.gravur + parts.farbschrift + parts.muster + parts.farbe + parts.groesse);
  const a = aktionFor(item.product);
  const prozent = a ? a.prozent : 0;
  const unit = r2(uvp * (1 - prozent / 100));
  return { ...parts, uvp, unit, aktionProzent: prozent, aktionBetrag: r2(uvp - unit), aktionName: a ? a.name : null };
}
/** Stückpreis ohne Aktion (UVP, inkl. aller Aufpreise) */
export function unitUvp(item) { return unitParts(item).uvp; }
/** Stückpreis — während einer Aktion der reduzierte Preis */
export function unitPrice(item) { return unitParts(item).unit; }
/**
 * Zeilenpreis: off = Mengenrabatt (entfällt während einer Aktion ohne „Mengenrabatt zusätzlich“),
 * line = round2(unit · qty · (1 − off/100)); lineUvp = dieselbe Zeile ohne Aktion (für den Streichpreis),
 * ersparnis = aktionBetrag · qty (wie order.aktion.ersparnis auf dem Server).
 */
export function linePrice(item) {
  const q = unitParts(item);
  const qty = Math.max(1, Math.min(50, Math.round(Number(item?.qty) || 1)));
  const a = q.aktionProzent > 0 ? aktionFor(item.product) : null;
  const off = a && !a.mengenrabatt ? 0 : discountFor(item.product, qty);
  const lineFull = r2(q.unit * qty);
  const line = r2((q.unit * qty) * (1 - off / 100));
  const lineUvp = r2((q.uvp * qty) * (1 - off / 100));
  return {
    off, line, lineFull, lineUvp, unit: q.unit, uvp: q.uvp,
    aktionProzent: q.aktionProzent, aktionBetrag: q.aktionBetrag, aktionName: q.aktionName,
    ersparnis: r2(q.aktionBetrag * qty),
  };
}
