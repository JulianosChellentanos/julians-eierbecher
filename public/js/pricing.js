// OVJU — Preislogik (reine Rechnung, ohne DOM/Three): muss identisch zu priceItem() in server.js rechnen.
// Aufpreise kommen ausschließlich aus den öffentlichen APIs (/api/pricing: muster, farbschrift, gravur, volumen,
// aktionen + serverNow; /api/colors: aufpreis je Farbe) — hier gibt es keine festen Beträge.
//
// Aktionen (Rabatt in % auf den Stückpreis, zeitlich begrenzt): der Server liefert unter pricing.aktionen ALLE gerade
// laufenden Aktionen (pricing.aktion = die erste davon, Kompatibilität) und unter serverNow seine Uhrzeit. Jede Aktion
// hat einen Geltungsbereich: produkte ('alle' | 'vase' | 'eierbecher') und muster (Liste von Muster-Keys, leer = alle
// Oberflächen). Für eine Konfiguration gilt die ERSTE passende Aktion der nach Prozent sortierten Liste (bei Gleichstand
// der engere Geltungsbereich, dann der frühere Start). Die Restzeit wird mit der korrigierten Zeit (Server-Uhr − Client-Uhr
// beim Laden) gerechnet; eine abgelaufene Aktion zählt sofort nicht mehr.

let pricing = null; // Antwort von /api/pricing
let colors = [];    // Antwort von /api/colors (id, name, hex, finish, aufpreis)
let timeOffset = 0; // serverNow − Date.now() beim Laden (ms)
const endeHooks = []; // Re-Render-Callbacks, wenn eine Aktion abläuft (oder eine neue beginnt)

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
/** Muster-Labels — Spiegel von PATTERNS in geometry.js (geometry.js zieht three mit; die Preislogik bleibt ohne Abhängigkeiten) */
export const MUSTER_LABEL = {
  glatt: 'Glatt', rippen: 'Rippen', wellen: 'Wellen', lamellen: 'Lamellen', zickzack: 'Zickzack',
  querwellen: 'Querwellen', gehaemmert: 'Gehämmert', skelett: 'Voronoi', koralle: 'Fjordwelle',
};
const MUSTER_KEYS = Object.keys(MUSTER_LABEL);
const PRODUKT_LABEL = { alle: 'auf alles', vase: 'auf Vasen', eierbecher: 'auf Eierbecher' };
const PRODUKT_MIT = { vase: 'Vasen', eierbecher: 'Eierbecher' };

/** Muster-Liste einer Aktion: nur bekannte Keys, ohne Duplikate, in Musterreihenfolge (wie sanitizeAktionMuster auf dem
 *  Server); leer = alle Oberflächen (auch wenn alle 9 gewählt sind); ein einzelner String zählt als ein Key */
export function aktionMuster(a) {
  const raw = Array.isArray(a?.muster) ? a.muster.map(String) : (typeof a?.muster === 'string' && a.muster ? [a.muster] : []);
  const out = MUSTER_KEYS.filter((k) => raw.includes(k));
  return out.length >= MUSTER_KEYS.length ? [] : out;
}
/** „Gehämmert“ · „Rippen und Wellen“ · „Rippen, Wellen oder Lamellen“ · ab vier Namen „4 Oberflächen“ */
export function musterListLabel(keys, conj = 'und') {
  const names = aktionMuster({ muster: keys }).map((k) => MUSTER_LABEL[k]);
  if (!names.length) return 'alle Oberflächen';
  if (names.length >= 4) return `${names.length} Oberflächen`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} ${conj} ${names[names.length - 1]}`;
}
/**
 * Geltungsbereich einer Aktion in Worten (gleiche Wortwahl wie auf dem Server):
 * „auf alles“ | „auf Vasen“ | „auf Eierbecher“ | „auf Gehämmert“ | „auf Rippen, Wellen und Lamellen“ |
 * „auf 4 Oberflächen“ | „auf Vasen mit Gehämmert“ | „auf Eierbecher mit Rippen oder Wellen“
 */
export function aktionScopeLabel(a) {
  const prod = a?.produkte && PRODUKT_MIT[a.produkte] ? a.produkte : 'alle';
  const m = aktionMuster(a);
  if (!m.length) return PRODUKT_LABEL[prod];
  return prod === 'alle' ? `auf ${musterListLabel(m, 'und')}` : `auf ${PRODUKT_MIT[prod]} mit ${musterListLabel(m, 'oder')}`;
}

/** Läuft die Aktion zum Zeitpunkt now (ms)? — aktiv-Flag prüft der Server, hier zählen nur Prozent und Zeitraum */
function aktionValid(a, now) {
  if (!a || !(Number(a.prozent) > 0)) return false;
  const ende = Date.parse(a.ende || ''), start = Date.parse(a.start || '');
  if (!Number.isFinite(ende) || ende <= now) return false;
  if (Number.isFinite(start) && start > now) return false;
  return true;
}
/** Geltungsbreite = Zahl der (Produkt, Muster)-Kombinationen — kleiner = enger (Sortierung bei gleichem Prozentsatz) */
function scopeSize(a) { return ((a?.produkte || 'alle') === 'alle' ? 2 : 1) * (aktionMuster(a).length || MUSTER_KEYS.length); }
/** Passt die Aktion zu Produkt + Muster? (fehlendes Muster zählt als „glatt“) */
export function aktionMatches(a, product, pattern) {
  const scope = a?.produkte || 'alle';
  if (scope !== 'alle' && scope !== product) return false;
  const m = aktionMuster(a);
  return !m.length || m.includes(pattern || 'glatt');
}
/** Öffentliche, normalisierte Sicht einer Aktion (gleiche Felder an allen Stellen) */
function normAktion(a) {
  return {
    id: String(a.id ?? ''), name: String(a.name || 'Aktion'), prozent: Math.round(Number(a.prozent)),
    start: a.start, ende: a.ende, produkte: a.produkte || 'alle', muster: aktionMuster(a),
    mengenrabatt: !!a.mengenrabatt, hinweis: String(a.hinweis || ''),
  };
}
/**
 * Alle gerade laufenden Aktionen (nach Server-Uhr), sortiert: höchster Prozentsatz zuerst, bei Gleichstand engerer
 * Geltungsbereich, dann frühere Startzeit. Für eine Konfiguration gilt die erste passende (aktionFor).
 * Ältere Server ohne pricing.aktionen: die eine Aktion aus pricing.aktion.
 */
export function aktionenActive() {
  const list = Array.isArray(pricing?.aktionen) ? pricing.aktionen : (pricing?.aktion ? [pricing.aktion] : []);
  const now = serverTime();
  return list.filter((a) => aktionValid(a, now)).map(normAktion).sort((x, y) =>
    (y.prozent - x.prozent) || (scopeSize(x) - scopeSize(y)) || ((Date.parse(x.start) || 0) - (Date.parse(y.start) || 0)));
}
/** Primäre Aktion (höchster Rabatt) — null, wenn keine läuft; Banner & Countdown zeigen diese */
export function aktionCurrent() { return aktionenActive()[0] || null; }
/** Aktion für Produkt + Muster → { id, name, prozent, start, ende, produkte, muster, mengenrabatt, hinweis } | null */
export function aktionFor(product, pattern) {
  return aktionenActive().find((a) => aktionMatches(a, product, pattern)) || null;
}
/** Restlaufzeit einer Aktion in ms (ohne Argument: die primäre; 0 ohne Aktion) */
export function aktionRemaining(a = aktionCurrent()) {
  return a ? Math.max(0, (Date.parse(a.ende) || 0) - serverTime()) : 0;
}
/** Frühestes Ende aller laufenden Aktionen in ms Restzeit (0 ohne Aktion) — Takt für den Countdown-Timer */
export function aktionNextEnde() {
  const list = aktionenActive();
  return list.length ? Math.min(...list.map((a) => aktionRemaining(a))) : 0;
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
export function aktionText(a) { return formatRemaining(aktionRemaining(a)); }
/** Kurzform „noch 1 Tag 3 Std“ (Mobile-Leiste; Stellen mit data-kurz werden von aktion.js damit aufgefrischt) */
export function aktionTextKurz(a) { return formatRemaining(aktionRemaining(a), true); }
/** Callback, wenn eine Aktion abläuft (oder nach dem Nachladen eine neue beginnt) → Preise neu rendern */
export function onAktionEnde(cb) { if (typeof cb === 'function') endeHooks.push(cb); }
export function notifyAktionChange() {
  for (const cb of endeHooks) { try { cb(); } catch (e) { console.warn('Aktion-Callback', e); } }
}
/**
 * Aktion clientseitig beenden: mit id genau diese Aktion entfernen, ohne id alle abgelaufenen;
 * die restlichen laufen weiter (pricing.aktion = neue primäre), alle Preise werden neu gerendert.
 */
export function expireAktion(id) {
  if (pricing) {
    const now = serverTime();
    const gone = (a) => (id ? String(a?.id ?? '') === String(id) : !aktionValid(a, now));
    if (Array.isArray(pricing.aktionen)) pricing.aktionen = pricing.aktionen.filter((a) => !gone(a));
    else if (pricing.aktion && gone(pricing.aktion)) pricing.aktion = null;
    pricing.aktion = aktionenActive()[0] || null;
  }
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

/** Gravur-Regel (Spiegel von server.js/geometry.js): Die Geometrie schaltet die Gravur ab,
 * sobald die WIRKSAME Mustertiefe über 2,5 mm (Vase) bzw. 2,0 mm (Eierbecher) liegt — dann darf
 * auch kein Gravur-Aufpreis berechnet werden. Wirksam = Wunschtiefe, begrenzt durch die
 * Musterklemme aus geometry.js (Gehämmert liegt dank seiner eigenen Grenze nie darüber). */
export function gravurAllowed(c, product) {
  const depth = +c?.depth || 0;
  const isVase = (product || c?.product) === 'vase';
  const pattern = c?.pattern;
  if (!pattern || pattern === 'glatt') return true;
  const cap = pattern === 'lamellen' ? (isVase ? 6 : 3)
    : pattern === 'gehaemmert' ? (isVase ? 2.5 : 2.0)
    : pattern === 'skelett' ? (isVase ? 1.8 : 1.0)
    : pattern === 'koralle' ? (isVase ? 6 : 1.0)
    : 1.6;
  return Math.min(depth, cap) <= (isVase ? 2.5 : 2.0) + 1e-9;
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
 * uvp (Stückpreis inkl. aller Aufpreise, ohne Aktion), unit (Aktionspreis), aktionProzent, aktionBetrag, aktionName, aktionId.
 * item = { product, saucer, config: { text, textStyle, pattern, depth, height, width }, color, colorName }
 * Die Aktion wird je Zeile über Produkt + Muster (config.pattern, fehlend = glatt) bestimmt.
 */
export function unitParts(item) {
  const p = pricing?.products?.[item?.product];
  const zero = { grund: 0, untersetzer: 0, gravur: 0, farbschrift: 0, muster: 0, farbe: 0, groesse: 0, uvp: 0, unit: 0, aktionProzent: 0, aktionBetrag: 0, aktionName: null, aktionId: null };
  if (!p) return zero;
  const c = item.config || {};
  const hasText = !!String(c.text || '').trim() && gravurAllowed(c, item?.product);
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
  const a = aktionFor(item.product, c.pattern);
  const prozent = a ? a.prozent : 0;
  const unit = r2(uvp * (1 - prozent / 100));
  return { ...parts, uvp, unit, aktionProzent: prozent, aktionBetrag: r2(uvp - unit), aktionName: a ? a.name : null, aktionId: a ? a.id : null };
}
/** Stückpreis ohne Aktion (UVP, inkl. aller Aufpreise) */
export function unitUvp(item) { return unitParts(item).uvp; }
/** Stückpreis — während einer Aktion der reduzierte Preis */
export function unitPrice(item) { return unitParts(item).unit; }
/**
 * Zeilenpreis: off = Mengenrabatt (entfällt, wenn die geltende Aktion kein „Mengenrabatt zusätzlich“ hat),
 * line = round2(unit · qty · (1 − off/100)); lineUvp = dieselbe Zeile ohne Aktion (für den Streichpreis),
 * ersparnis = aktionBetrag · qty (wie order.aktionen[].ersparnis auf dem Server, dort je Aktion summiert).
 */
export function linePrice(item) {
  const q = unitParts(item);
  const qty = Math.max(1, Math.min(50, Math.round(Number(item?.qty) || 1)));
  const a = q.aktionProzent > 0 ? aktionFor(item.product, item.config?.pattern) : null;
  const off = a && !a.mengenrabatt ? 0 : discountFor(item.product, qty);
  const lineFull = r2(q.unit * qty);
  const line = r2((q.unit * qty) * (1 - off / 100));
  const lineUvp = r2((q.uvp * qty) * (1 - off / 100));
  return {
    off, line, lineFull, lineUvp, unit: q.unit, uvp: q.uvp,
    aktionProzent: q.aktionProzent, aktionBetrag: q.aktionBetrag, aktionName: q.aktionName, aktionId: q.aktionId,
    ersparnis: r2(q.aktionBetrag * qty),
  };
}
