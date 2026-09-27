// formsam — Preislogik (reine Rechnung, ohne DOM/Three): muss identisch zu priceItem() in server.js rechnen.
// Aufpreise kommen ausschließlich aus den öffentlichen APIs (/api/pricing: muster, farbschrift, gravur, volumen,
// aktionen + serverNow; /api/colors: aufpreis je Farbe) — hier gibt es keine festen Beträge.
//
// Aktionen (Rabatt in % auf den Stückpreis, zeitlich begrenzt): der Server liefert unter pricing.aktionen ALLE gerade
// laufenden Aktionen (pricing.aktion = die erste davon, Kompatibilität) und unter serverNow seine Uhrzeit. Jede Aktion
// hat einen Geltungsbereich: produkte ('alle' | 'vase' | 'eierbecher') und muster (Liste von Muster-Keys, leer = alle
// Oberflächen). Für eine Konfiguration gilt die ERSTE passende Aktion der nach Prozent sortierten Liste (bei Gleichstand
// der engere Geltungsbereich, dann der frühere Start). Die Restzeit wird mit der korrigierten Zeit (Server-Uhr − Client-Uhr
// beim Laden) gerechnet; eine abgelaufene Aktion zählt sofort nicht mehr.
//
// § 11 PAngV (Streichpreis = niedrigster Preis der letzten 30 Tage): referenzpreis(item) rechnet aus pricing.preisHistorie
// (Momentaufnahmen des Servers, siehe „Preis-Historie“ in server.js) den Tiefstpreis im Fenster [Aktionsbeginn − 30 Tage,
// Aktionsbeginn) und die Prozentangabe bezogen darauf; aktionProzentGueltig(a) sagt, ob die Prozentzahl der Aktion für
// ihren ganzen Geltungsbereich stimmt (nur dann nennen Banner und Badges sie). Mengenrabatte und Gutscheine zählen nicht.

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
/** "2 Stück −20 % · 4 Stück −35 %" für die Preisbox (geschütztes Leerzeichen vor „%“: nie „−20“ / „%“ auf zwei Zeilen) */
export function discountTeaser(product) {
  const tiers = pricing?.products?.[product]?.discounts || [];
  return tiers.map((t) => `${t.qty} Stück −${t.off}\u00a0%`).join(' · ');
}

/** Mengenrabatt in % für qty nach einer Staffel [{ qty, off }] — höchster erreichter Satz */
function offAus(tiers, qty) {
  let off = 0;
  for (const t of (Array.isArray(tiers) ? tiers : [])) if (qty >= t.qty && t.off > off) off = t.off;
  return off;
}
export function discountFor(product, qty) {
  return offAus(pricing?.products?.[product]?.discounts, qty);
}

// ---------------------------------------------------------------------------
// Versandhinweis am Preis (§ 6 Abs. 1 Nr. 2 PAngV) — reine Anzeige aus pricing.shipping; die Rechnung (computeTotals auf dem
// Server, totals() in cart.js) bleibt unberührt. Überall derselbe Wortlaut: Konfigurator, Handy-Leiste, Hero, Karten, Sheets.
// ---------------------------------------------------------------------------
/** Euro kurz: ganze Beträge ohne Nachkommastellen („ab 39 € versandfrei“), sonst wie fmt() („4,90 €“) */
export function euroKurz(v) { return Number.isInteger(+v) ? `${+v}\u00a0€` : fmt(v); }
/** „zzgl. 4,90 € Versand · ab 39 € versandfrei“ · ohne Versandkosten „Versandkostenfrei“ · ohne geladene Preise '' */
export function versandText(p = pricing) {
  const sh = p?.shipping;
  if (!sh || !(+sh.flat > 0)) return p ? 'Versandkostenfrei' : '';
  return `zzgl. ${euroKurz(sh.flat)} Versand${+sh.freeFrom > 0 ? ` · ab ${euroKurz(sh.freeFrom)} versandfrei` : ''}`;
}
/** Link auf „Versand & Zahlung“ — neuer Tab, damit das Design im Konfigurator offen bleibt */
const VERSAND_LINK = (txt) => `<a href="/versand" target="_blank" rel="noopener">${txt}</a>`;
/**
 * Versandhinweis als HTML mit Link zur Versandseite: lang „zzgl. <a>4,90 € Versand</a> · ab 39 € versandfrei“,
 * kurz (enge Stellen: Handy-Leiste, Karten, Hero) „zzgl. <a>Versand</a>“ — der Betrag steht auf der verlinkten Seite.
 */
export function versandHTML({ kurz = false } = {}, p = pricing) {
  const sh = p?.shipping;
  if (!sh) return '';
  if (!(+sh.flat > 0)) return VERSAND_LINK('Versandkostenfrei');
  if (kurz) return `zzgl. ${VERSAND_LINK('Versand')}`;
  return `zzgl. ${VERSAND_LINK(`${euroKurz(sh.flat)} Versand`)}${+sh.freeFrom > 0 ? ` · ab ${euroKurz(sh.freeFrom)} versandfrei` : ''}`;
}
/** Kleinunternehmer (§ 19 UStG, /api/pricing → shop.kleinunternehmer): Hinweis zur Umsatzsteuer beim Preis, sonst '' */
export function ustText(p = pricing) {
  return p?.shop?.kleinunternehmer ? 'Endpreis, keine USt. nach § 19 UStG' : '';
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
export function volumeSurcharge(product, config) { return volumeSurchargeWith(pricing, product, config); }
/** Größenaufschlag mit einem bestimmten Preisstand pr (aktuelle Preise oder Momentaufnahme der Preis-Historie) */
function volumeSurchargeWith(pr, product, config) {
  const vol = pr?.volumen || {};
  const h0 = pr?.normalHeight?.[product] || pricing?.normalHeight?.[product] || 1;
  const h = Number(config?.height) || h0;
  const w = Number(config?.width) || 1;
  const extra = Math.max(0, (h / h0) * w * w - 1);
  if (extra <= 0) return 0;
  const base = pr?.products?.[product]?.single || 0;
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
 * Bestandteile des Stückpreises (ohne Aktion) mit einem bestimmten Preisstand pr — aktuelle Preise (unitParts) oder eine
 * Momentaufnahme der Preis-Historie (referenzpreis); farbe = Farbaufpreis in €. null, wenn es das Produkt im Stand nicht gibt.
 */
function partsWith(item, pr, farbe) {
  const p = pr?.products?.[item?.product];
  if (!p) return null;
  const c = item.config || {};
  const hasText = !!String(c.text || '').trim() && gravurAllowed(c, item?.product);
  return {
    grund: p.single,
    untersetzer: item.product === 'eierbecher' && item.saucer ? (p.untersetzer || 0) : 0,
    gravur: hasText ? (pr.gravur || 0) : 0,
    farbschrift: hasText && c.textStyle === 'farbe' ? (pr.farbschrift || 0) : 0,
    muster: Math.max(0, Number(pr.muster?.[c.pattern]) || 0),
    farbe,
    groesse: volumeSurchargeWith(pr, item.product, c),
  };
}
/** Summe der Bestandteile (gleiche Reihenfolge wie priceItem() auf dem Server) */
const sumParts = (q) => r2(q.grund + q.untersetzer + q.gravur + q.farbschrift + q.muster + q.farbe + q.groesse);

/**
 * Aufschlüsselung des Stückpreises — gleiche Felder wie priceItem().parts auf dem Server, ergänzt um
 * uvp (Normalpreis: Stückpreis inkl. aller Aufpreise, ohne Aktion — Feldname historisch), unit (Aktionspreis), aktionProzent,
 * aktionBetrag, aktionName, aktionId. Als Streichpreis gilt NICHT uvp, sondern referenzpreis(item).tiefst (§ 11 PAngV).
 * item = { product, saucer, config: { text, textStyle, pattern, depth, height, width }, color, colorName }
 * Die Aktion wird je Zeile über Produkt + Muster (config.pattern, fehlend = glatt) bestimmt.
 */
export function unitParts(item) {
  const zero = { grund: 0, untersetzer: 0, gravur: 0, farbschrift: 0, muster: 0, farbe: 0, groesse: 0, uvp: 0, unit: 0, aktionProzent: 0, aktionBetrag: 0, aktionName: null, aktionId: null };
  const parts = partsWith(item, pricing, colorSurcharge(item?.color, item?.colorName));
  if (!parts) return zero;
  const c = item.config || {};
  // Aktion: uvp = bisheriger Stückpreis, unit = round2(uvp · (1 − p/100)) — Formel wie priceItem() auf dem Server
  const uvp = sumParts(parts);
  const a = aktionFor(item.product, c.pattern);
  const prozent = a ? a.prozent : 0;
  const unit = r2(uvp * (1 - prozent / 100));
  return { ...parts, uvp, unit, aktionProzent: prozent, aktionBetrag: r2(uvp - unit), aktionName: a ? a.name : null, aktionId: a ? a.id : null };
}

// ---------------------------------------------------------------------------
// § 11 PAngV — niedrigster Preis der letzten 30 Tage vor Beginn der Aktion
// ---------------------------------------------------------------------------
const TAG = 864e5;
export const REF_TAGE = 30;
/**
 * Preis-Historie als Liste von Momentaufnahmen { at, pricing, colors, aktionen }, nach at aufsteigend (so liefert sie der
 * Server). Ohne Historie (älterer Server) gilt der aktuelle Stand als einzige Momentaufnahme — laufende Aktionen zählen mit.
 */
function historie() {
  const h = pricing?.preisHistorie;
  if (Array.isArray(h) && h.length) return h;
  return pricing ? [{ at: null, pricing, colors, aktionen: Array.isArray(pricing.aktionen) ? pricing.aktionen : (pricing.aktion ? [pricing.aktion] : []) }] : [];
}
/** Farbaufpreis in einer Momentaufnahme: colors als [{ id, aufpreis }] (Datei, Fallback) oder { id: aufpreis } (kompakt); fehlt = 0 */
function snapFarbe(snap, id) {
  const cs = snap?.colors;
  if (!id || !cs) return 0;
  const v = Array.isArray(cs) ? cs.find((c) => c?.id === id)?.aufpreis : cs[id];
  return Math.max(0, Number(v) || 0);
}
/**
 * Abschnitte der Historie, die das Fenster [von, bis) schneiden: je Momentaufnahme { e, von, bis } (Gültigkeit von at bis
 * zum nächsten at, auf das Fenster zugeschnitten); die erste gilt auch für die Zeit davor.
 */
function abschnitte(von, bis) {
  const h = historie(), out = [];
  h.forEach((e, i) => {
    const t0 = i === 0 ? -Infinity : Date.parse(e.at);
    const t1 = i + 1 < h.length ? Date.parse(h[i + 1].at) : Infinity;
    const v = Math.max(Number.isNaN(t0) ? -Infinity : t0, von), b = Math.min(Number.isNaN(t1) ? Infinity : t1, bis);
    if (v < b) out.push({ e, von: v, bis: b });
  });
  return out;
}
/** Lief die Aktion x (laut Momentaufnahme) irgendwann in [von, bis)? */
const liefIn = (x, von, bis) => Number(x?.prozent) > 0 && Date.parse(x.start) < bis && Date.parse(x.ende) > von;
/**
 * Niedrigster Stückpreis des Items im Fenster [start − 30 Tage, start) der Aktion a: je Abschnitt der Preis ohne Aktion und
 * mit jeder dort geltenden, zum Item passenden Aktion (gleiche Rechnung wie unitParts, Preise der Momentaufnahme) → Minimum.
 * null, wenn es im Fenster keinen Preis gab.
 */
function tiefstpreis(item, a) {
  const start = Date.parse(a?.start);
  if (!Number.isFinite(start)) return null;
  const cid = colorByRef(item?.color, item?.colorName)?.id || (typeof item?.color === 'string' ? item.color : '');
  const pattern = item?.config?.pattern;
  let min = Infinity;
  for (const { e, von, bis } of abschnitte(start - REF_TAGE * TAG, start)) {
    const parts = partsWith(item, e.pricing, snapFarbe(e, cid));
    if (!parts) continue;
    const base = sumParts(parts);
    min = Math.min(min, base);
    for (const x of Array.isArray(e.aktionen) ? e.aktionen : []) {
      if (liefIn(x, von, bis) && aktionMatches(x, item.product, pattern)) min = Math.min(min, r2(base * (1 - Math.round(Number(x.prozent)) / 100)));
    }
  }
  return Number.isFinite(min) ? min : null;
}
/**
 * Niedrigster ZEILENpreis für qty Stück im Fenster [start − 30 Tage, start) der Aktion a (Streichpreis im Warenkorb): wie
 * tiefstpreis(), aber je Abschnitt mit der damals geltenden Mengenstaffel (Momentaufnahme: pricing.products[p].discounts) —
 * ohne Aktion base·qty·(1 − Staffel), mit einer damals laufenden Aktion u·qty·(1 − Staffel), die Staffel nur, wenn diese Aktion
 * „Mengenrabatt zusätzlich“ hatte (fehlt die Angabe, zählt der niedrigere Preis mit Staffel). Sonst würde der Warenkorb bei
 * 2 Stück die Zeile ohne den Mengenrabatt vergleichen, der vor der Aktion galt, und eine zu hohe Ersparnis nennen.
 * Momentaufnahmen ohne Staffel (vor dieser Erweiterung) → null, sobald eine Staffel greifen könnte: den damaligen Zeilenpreis
 * kennen wir nicht, also lieber kein Zeilen-Streichpreis als ein zu hoher.
 */
function tiefstZeile(item, a, qty) {
  const start = Date.parse(a?.start);
  if (!Number.isFinite(start)) return null;
  const cid = colorByRef(item?.color, item?.colorName)?.id || (typeof item?.color === 'string' ? item.color : '');
  const pattern = item?.config?.pattern;
  let min = Infinity;
  for (const { e, von, bis } of abschnitte(start - REF_TAGE * TAG, start)) {
    const parts = partsWith(item, e.pricing, snapFarbe(e, cid));
    if (!parts) continue;
    const tiers = e.pricing?.products?.[item.product]?.discounts;
    if (!Array.isArray(tiers) && (qty > 1 || discountFor(item.product, qty) > 0)) return null;
    const offD = offAus(tiers, qty);
    const base = sumParts(parts);
    min = Math.min(min, r2(base * qty * (1 - offD / 100)));
    for (const x of Array.isArray(e.aktionen) ? e.aktionen : []) {
      if (!liefIn(x, von, bis) || !aktionMatches(x, item.product, pattern)) continue;
      const u = r2(base * (1 - Math.round(Number(x.prozent)) / 100));
      min = Math.min(min, r2(u * qty * (1 - (x.mengenrabatt === false ? 0 : offD) / 100)));
    }
  }
  return Number.isFinite(min) ? min : null;
}
/**
 * Bezugspreis für die Preisangabe während einer Aktion (§ 11 PAngV): { tiefst, prozent } | null.
 * tiefst = niedrigster Stückpreis der letzten 30 Tage vor Beginn der Aktion (Streichpreis), prozent = round((1 − unit/tiefst)·100)
 * (Badge). null ohne Aktion, ohne Bezugspreis oder wenn der Aktionspreis nicht darunter liegt (unit ≥ tiefst − 0,004 bzw.
 * weniger als 1 %) — dann nur den aktuellen Preis zeigen, ohne Streichpreis/Badge (die Aktion wirkt trotzdem).
 */
export function referenzpreis(item) {
  const q = unitParts(item);
  if (!(q.aktionProzent > 0)) return null;
  const a = aktionFor(item.product, item.config?.pattern);
  const tiefst = a ? tiefstpreis(item, a) : null;
  if (tiefst == null || q.unit >= tiefst - 0.004) return null;
  const prozent = Math.round((1 - q.unit / tiefst) * 100);
  return prozent >= 1 ? { tiefst, prozent } : null;
}
/** Wortlaut der Kennzeichnung: „Niedrigster Preis der letzten 30 Tage: 24,90 €“ (title/aria-label und kleine Zeilen) */
export function referenzText(tiefst) { return `Niedrigster Preis der letzten ${REF_TAGE} Tage: ${fmt(tiefst)}`; }
/** Kennzeichnung des Zeilen-Streichpreises: „Niedrigster Preis der letzten 30 Tage für 2 Stück: 47,52 €“ (1 Stück wie referenzText) */
export function referenzTextZeile(lineRef, qty) {
  return qty > 1 ? `Niedrigster Preis der letzten ${REF_TAGE} Tage für ${qty} Stück: ${fmt(lineRef)}` : referenzText(lineRef);
}
/** Produkte im Geltungsbereich, die der Shop gerade anbietet (Eierbecher nur mit Schalter) */
function scopeProdukte(a) {
  const list = (a?.produkte || 'alle') === 'alle' ? ['vase', 'eierbecher'] : [a.produkte];
  return list.filter((p) => pricing?.products?.[p] && pricing?.produkte?.[p] !== false);
}
/** Überschneiden sich die Geltungsbereiche zweier Aktionen (gemeinsames Produkt UND gemeinsame Oberfläche)? */
function scopeOverlap(a, b) {
  const pa = a?.produkte || 'alle', pb = b?.produkte || 'alle';
  if (pa !== 'alle' && pb !== 'alle' && pa !== pb) return false;
  const ma = aktionMuster(a), mb = aktionMuster(b);
  return !ma.length || !mb.length || ma.some((k) => mb.includes(k));
}
/**
 * Preisstand einer Momentaufnahme im Geltungsbereich (Produkte prods, Oberflächen keys) gegenüber heute:
 * −1 = irgendein Grundpreis/Aufpreis war niedriger, 0 = alles gleich, 1 = nichts niedriger, aber etwas höher.
 */
function standVergleich(e, prods, keys) {
  const sp = e.pricing || {}, cur = pricing || {};
  let billiger = false, hoeher = false;
  const cmp = (alt, neu) => {
    const x = Number(alt) || 0, y = Number(neu) || 0;
    if (x < y - 0.004) billiger = true; else if (x > y + 0.004) hoeher = true;
  };
  for (const p of prods) {
    if (!sp.products?.[p]) { billiger = true; continue; }   // Produkt fehlt im Stand → kein Bezugspreis, lieber keine Prozentzahl
    cmp(sp.products[p].single, cur.products[p].single);
    if (p === 'eierbecher') cmp(sp.products[p].untersetzer, cur.products[p].untersetzer);
  }
  cmp(sp.gravur, cur.gravur); cmp(sp.farbschrift, cur.farbschrift);
  for (const k of keys) cmp(sp.muster?.[k], cur.muster?.[k]);
  cmp(sp.volumen?.prozent, cur.volumen?.prozent); cmp(sp.volumen?.euro, cur.volumen?.euro);
  for (const c of colors) cmp(snapFarbe(e, c.id), c.aufpreis);
  return billiger ? -1 : hoeher ? 1 : 0;
}
/**
 * Darf die Prozentzahl der Aktion („−15 %“) im Banner, in der Aktionsleiste und an Badges stehen? Nur, wenn sie für den ganzen
 * Geltungsbereich gegenüber dem 30-Tage-Tiefstpreis stimmt: im Fenster [start − 30 Tage, start) laut Historie keine andere
 * Aktion mit überschneidendem Geltungsbereich, kein niedrigerer Grund- oder Aufpreis — und mindestens ein Abschnitt mit genau
 * den heutigen Preisen (sonst läge der Tiefstpreis höher und die Prozentzahl stimmte ebenfalls nicht). Sonst: Banner ohne Zahl.
 */
export function aktionProzentGueltig(a) {
  const start = Date.parse(a?.start);
  if (!pricing || !Number.isFinite(start) || !(Number(a?.prozent) > 0)) return false;
  const prods = scopeProdukte(a);
  const keys = aktionMuster(a).length ? aktionMuster(a) : MUSTER_KEYS;
  let gleich = false;
  for (const { e, von, bis } of abschnitte(start - REF_TAGE * TAG, start)) {
    if ((Array.isArray(e.aktionen) ? e.aktionen : []).some((x) => liefIn(x, von, bis) && scopeOverlap(a, x))) return false;
    const v = standVergleich(e, prods, keys);
    if (v < 0) return false;
    if (v === 0) gleich = true;
  }
  return gleich;
}

/** Stückpreis ohne Aktion (Normalpreis, inkl. aller Aufpreise) — kein Streichpreis, siehe referenzpreis() */
export function unitUvp(item) { return unitParts(item).uvp; }
/** Stückpreis — während einer Aktion der reduzierte Preis */
export function unitPrice(item) { return unitParts(item).unit; }
/**
 * Zeilenpreis: off = Mengenrabatt (entfällt, wenn die geltende Aktion kein „Mengenrabatt zusätzlich“ hat),
 * line = round2(unit · qty · (1 − off/100)); lineUvp = dieselbe Zeile ohne Aktion, aber mit dem Mengenrabatt, der ohne die
 * Aktion gälte (Normalpreis der Zeile), ersparnis = max(0, lineUvp − line) (wie order.aktionen[].ersparnis auf dem Server,
 * dort je Aktion summiert — ohne „Mengenrabatt zusätzlich“ kann eine Aktion bei 2+ Stück auch nichts sparen).
 * ref = referenzpreis(item) | null (Stückpreis-Bezug); lineRef = niedrigster Zeilenpreis der letzten 30 Tage für genau diese
 * Menge (tiefstZeile, mit der damaligen Staffel) — Streichpreis im Warenkorb, null ohne ref, ohne bekannte Staffel oder wenn die
 * Zeile nicht günstiger ist; refProzent = round((1 − line/lineRef)·100) (Badge der Zeile), ersparnisRef = lineRef − line
 * (Ersparnis gegenüber dem Tiefstpreis — so darf der Shop sie nennen).
 */
export function linePrice(item) {
  const q = unitParts(item);
  const qty = Math.max(1, Math.min(50, Math.round(Number(item?.qty) || 1)));
  const a = q.aktionProzent > 0 ? aktionFor(item.product, item.config?.pattern) : null;
  const staffel = discountFor(item.product, qty);
  const off = a && !a.mengenrabatt ? 0 : staffel;
  const lineFull = r2(q.unit * qty);
  const line = r2((q.unit * qty) * (1 - off / 100));
  const lineUvp = r2((q.uvp * qty) * (1 - staffel / 100));
  const ref = a ? referenzpreis(item) : null;
  let lineRef = ref ? tiefstZeile(item, a, qty) : null;
  let refProzent = lineRef != null && lineRef > 0 ? Math.round((1 - line / lineRef) * 100) : 0;
  if (lineRef != null && (line >= lineRef - 0.004 || refProzent < 1)) { lineRef = null; refProzent = 0; }
  return {
    off, line, lineFull, lineUvp, unit: q.unit, uvp: q.uvp,
    aktionProzent: q.aktionProzent, aktionBetrag: q.aktionBetrag, aktionName: q.aktionName, aktionId: q.aktionId,
    ersparnis: q.aktionProzent > 0 ? Math.max(0, r2(lineUvp - line)) : 0,
    ref, lineRef, refProzent, ersparnisRef: lineRef != null ? Math.max(0, r2(lineRef - line)) : 0,
  };
}
