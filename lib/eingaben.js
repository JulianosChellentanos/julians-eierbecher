// formsam — Eingabeprüfung für den Shop-Server: E-Mail, Kontodaten, Design- und Warenkorb-Konfigurationen, Farbwerte.
// Grundregeln (ReDoS, Datenqualität):
//   1. Jede Eingabe wird vor einem regulären Ausdruck in der Länge begrenzt.
//   2. Nur lineare Prüfungen: einzelne Zeichenklassen, indexOf/slice — keine verschachtelten oder überlappenden Quantoren.
//   3. Konfigurationen: dieselben Werte, die der Konfigurator erzeugen kann (bekannte Formen/Muster/Schriften, Zahlenbereiche
//      der Regler inkl. früherer Reglergrenzen und der Klemmen beim Laden eines Designs in public/js/app.js applyDesign).
// Die Tabellen spiegeln public/js/geometry.js (PRODUCTS, PATTERNS, FLOWS, RIMS, FONTS) und textrelief.js (TEXT_STYLES) —
// tools/test-eingaben.mjs vergleicht beides. Neue Formen, Muster oder Schriften hier mit eintragen, sonst lehnt die Kasse sie ab.

export const EMAIL_MAX = 254;   // RFC 5321
const EMAIL_VERBOTEN = /[\s<>,;"()]/;   // eine Zeichenklasse, ein Durchlauf
/**
 * E-Mail-Adresse wie beim Mailversand (lib/mailer.js ADDR_RE: genau ein @, davor mindestens ein Zeichen, in der Domain ein Punkt,
 * der weder am Anfang noch am Ende steht, keine Leer- und Sonderzeichen <>,;"()), aber linear und höchstens 254 Zeichen.
 */
export function isEmail(s) {
  const v = String(s ?? '').trim();
  if (!v || v.length > EMAIL_MAX || EMAIL_VERBOTEN.test(v)) return false;
  const at = v.indexOf('@');
  if (at < 1 || at !== v.lastIndexOf('@')) return false;
  const dom = v.slice(at + 1);
  const dot = dom.indexOf('.', 1);
  return dot > 0 && dot < dom.length - 1;
}

/**
 * Kundenadressen (Kasse, Registrierung, Widerruf): vor dem @ nur ASCII. Umlaute dort bräuchten SMTPUTF8 auf jedem Mailserver
 * unterwegs — der Mailer meldet sonst einen endgültigen Fehler, die Bestätigung käme nie an. Umlaute in der Domain sind
 * erlaubt (der Mailer schickt sie als Punycode). Derselbe Text steht in public/js/auth.js und auf der Widerrufsseite
 * (lib/legal.js) — tools/test-eingaben.mjs prüft, dass er wörtlich gleich ist.
 */
export const EMAIL_LOKAL_FEHLER = 'Vor dem @ gehen leider keine Umlaute, kein ß und keine anderen Sonderzeichen – solche Adressen erreichen meine E-Mails nicht zuverlässig. Bitte gib eine E-Mail-Adresse ohne sie an (in der Domain nach dem @ sind Umlaute in Ordnung).';
/** → EMAIL_LOKAL_FEHLER, wenn vor dem @ ein Nicht-ASCII-Zeichen steht, sonst '' (eine Zeichenklasse, linear) */
export function emailLokalFehler(s) {
  const v = String(s ?? '').trim().slice(0, EMAIL_MAX + 1);
  const at = v.lastIndexOf('@');
  return at > 0 && /[^\x21-\x7e]/.test(v.slice(0, at)) ? EMAIL_LOKAL_FEHLER : '';
}

/**
 * Farbname ohne Finish-Zusatz: „Gold · metallic“ / „Gold (metallic)“ → „Gold“. Gleiche Wirkung wie der frühere Ausdruck
 * /\s*(?:·\s*[^·()]*|\([^()]*\))\s*$/ in colorOfItem (der lief bei langen Eingaben kubisch und blockierte den Server).
 */
export function ohneFinish(raw) {
  const s = String(raw ?? '').trim();
  if (s.endsWith(')')) {
    const i = s.lastIndexOf('(');
    return i >= 0 && s.indexOf(')', i) === s.length - 1 ? s.slice(0, i).trim() : s;
  }
  const i = s.lastIndexOf('·');
  if (i >= 0 && s.indexOf('(', i) < 0 && s.indexOf(')', i) < 0) return s.slice(0, i).trim();
  return s;
}

/** Farbwert für style-Attribute: nur #rrggbb */
export const isHex6 = (v) => typeof v === 'string' && v.length === 7 && /^#[0-9a-f]{6}$/i.test(v);

const STEUERZEICHEN = /[\x00-\x1f\x7f]/;
/** Eine Zeile Text: Steuerzeichen und Leerraum-Folgen → ein Leerzeichen, Ränder weg (Eingabe vorher begrenzen!) */
const einzeilig = (v) => String(v).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Kundenkonto: Name und Standard-Lieferadresse
// ---------------------------------------------------------------------------
export const NAME_MIN = 2, NAME_MAX = 80;
const NAME_FEHLER = `Bitte gib deinen Namen an (${NAME_MIN} bis ${NAME_MAX} Zeichen, ohne < und >).`;
/** Kontoname → { name } oder { error } (Text, 2–80 Zeichen nach dem Zusammenfassen von Leerraum, ohne spitze Klammern) */
export function kontoName(raw) {
  if (typeof raw !== 'string' || raw.length > NAME_MAX * 4) return { error: NAME_FEHLER };
  const name = einzeilig(raw);
  if (name.length < NAME_MIN || name.length > NAME_MAX || name.includes('<') || name.includes('>')) return { error: NAME_FEHLER };
  return { name };
}
export const ADRESSE_MAX = { street: 120, zip: 10, city: 80 };
const ADRESSE_LABEL = { street: 'Straße & Hausnummer', zip: 'PLZ', city: 'Ort' };
/** Standard-Lieferadresse → { address: { street, zip, city } } oder { error } — nur Text (fehlend = leer), mit Längengrenzen */
export function kontoAdresse(raw) {
  const address = {};
  for (const [k, max] of Object.entries(ADRESSE_MAX)) {
    const v = raw?.[k];
    if (v === undefined || v === null) { address[k] = ''; continue; }
    if (typeof v !== 'string') return { error: 'Ungültige Anfrage' };
    const t = v.length > max * 4 ? null : einzeilig(v);
    if (t === null || t.length > max) return { error: `${ADRESSE_LABEL[k]}: höchstens ${max} Zeichen` };
    address[k] = t;
  }
  return { address };
}

// ---------------------------------------------------------------------------
// Design- und Warenkorb-Konfiguration
// ---------------------------------------------------------------------------
export const KONFIG = {
  produkte: {
    vase: { presets: ['flasche', 'kugel', 'tropfen', 'zylinder', 'kurve'], hoehe: [90, 220] },
    eierbecher: { presets: ['kelch', 'schale', 'tulpe'], hoehe: [35, 75] },
  },
  muster: ['glatt', 'rippen', 'wellen', 'lamellen', 'zickzack', 'querwellen', 'gehaemmert', 'skelett', 'koralle'],
  verlauf: ['spirale', 'gegen', 'fluss', 'zick'],
  rand: ['glatt', 'muster', 'wulst'],
  schrift: ['helvetiker', 'optimer', 'gentilis', 'droid_sans', 'droid_serif', 'marcellus', 'greatvibes'],
  stil: ['gestanzt', 'gepraegt', 'gehaemmert', 'kissen', 'farbe'],
};
// Regler (public/index.html, app.js DEPTH_RANGES) bzw. Klemmen beim Laden (applyDesign) — die weiteste Grenze gilt, damit ältere
// Warenkörbe und Design-Codes (Schriftgröße früher ab 4 mm, Richtungswechsel bis 8) gültig bleiben
export const ZAHLEN = { width: [0.85, 1.15], ribs: [3, 120], depth: [0, 6], twist: [-2, 2], flowWaves: [1, 8], textSize: [4, 12], textPos: [0.15, 0.8] };
const AUSWAHL = { pattern: 'muster', flow: 'verlauf', rim: 'rand', font: 'schrift', textStyle: 'stil' };
export const TEXT_MAX = 40;        // Gravurfeld: 30 Zeichen (maxlength); Design-Codes speichern bis 40
const ID_MAX = 40;                 // Farb-IDs (color, textColor)
const PUNKTE = [3, 40];            // eigene Silhouette: Anzahl Punkte (Editor 7, applyDesign ab 3, Design-Codes bis 40)
const KONFIG_MAX = 16 * 1024;      // JSON einer Konfiguration (40 Punkte ≈ 1 KB)
const EPS = 1e-9;
export const KONFIG_LABEL = {
  config: 'Konfiguration', product: 'Produkt', preset: 'Form', height: 'Höhe', width: 'Breite', pattern: 'Muster', ribs: 'Anzahl',
  depth: 'Tiefe', twist: 'Verlauf', flow: 'Verlauf', flowWaves: 'Richtungswechsel', text: 'Gravurtext', textSize: 'Schriftgröße',
  textPos: 'Gravur-Position', font: 'Schrift', textStyle: 'Gravur-Stil', textColor: 'Schriftfarbe', color: 'Farbe', colorHex: 'Farbwert',
  saucer: 'Untersetzer', customPoints: 'eigene Form', rim: 'Rand',
};

const leer = (v) => v === undefined || v === null || v === '';
const zahl = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && v.length < 40 ? Number(v) : NaN);
const imBereich = (v, [lo, hi]) => { const n = zahl(v); return Number.isFinite(n) && n >= lo - EPS && n <= hi + EPS; };
const kurzerText = (v, max) => typeof v === 'string' && v.length <= max && !STEUERZEICHEN.test(v);
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Konfiguration (Design-Code oder Warenkorb-Position) prüfen → null (in Ordnung) oder der Schlüssel des ersten ungültigen Werts
 * (KONFIG_LABEL nennt ihn lesbar). Pflicht: Produkt, Form, Höhe, Muster; alles andere nur, wenn vorhanden. Unbekannte Zusatzschlüssel
 * (z. B. colorFinish, studioTab) stören nicht. product = Produkt der Warenkorb-Zeile (muss zu config.product passen).
 * farbeBekannt(id) → bool: optional, prüft config.color gegen die Farbliste.
 */
export function pruefeKonfig(cfg, { product = cfg?.product, farbeBekannt = null } = {}) {
  if (!plain(cfg)) return 'config';
  let json;
  try { json = JSON.stringify(cfg); } catch { return 'config'; }
  if (json.length > KONFIG_MAX) return 'config';
  const prod = typeof product === 'string' && Object.hasOwn(KONFIG.produkte, product) ? KONFIG.produkte[product] : null;
  if (!prod || (!leer(cfg.product) && cfg.product !== product)) return 'product';
  if (typeof cfg.preset !== 'string' || !(cfg.preset === 'eigene' || prod.presets.includes(cfg.preset))) return 'preset';
  if (!imBereich(cfg.height, prod.hoehe)) return 'height';
  if (leer(cfg.pattern)) return 'pattern';
  for (const [k, liste] of Object.entries(AUSWAHL)) {
    if (!leer(cfg[k]) && !(typeof cfg[k] === 'string' && KONFIG[liste].includes(cfg[k]))) return k;
  }
  for (const [k, r] of Object.entries(ZAHLEN)) if (!leer(cfg[k]) && !imBereich(cfg[k], r)) return k;
  if (!leer(cfg.text) && !kurzerText(cfg.text, TEXT_MAX)) return 'text';
  for (const k of ['color', 'textColor']) if (!leer(cfg[k]) && !kurzerText(cfg[k], ID_MAX)) return k;
  if (!leer(cfg.color) && farbeBekannt && !farbeBekannt(cfg.color)) return 'color';
  if (!leer(cfg.colorHex) && !isHex6(cfg.colorHex)) return 'colorHex';
  if (cfg.saucer !== undefined && cfg.saucer !== null && typeof cfg.saucer !== 'boolean') return 'saucer';
  if (!leer(cfg.customPoints)) {
    const pts = cfg.customPoints;
    if (!Array.isArray(pts) || pts.length < PUNKTE[0] || pts.length > PUNKTE[1]) return 'customPoints';
    for (const pt of pts) {
      const [t, r] = Array.isArray(pt) ? pt : plain(pt) ? [pt.t, pt.r] : [NaN, NaN];
      if (!imBereich(t, [0, 1]) || !imBereich(r, [0, 1.5])) return 'customPoints';
    }
  }
  return null;
}

/**
 * Positionen aus /api/quote, /api/paypal/create und /api/checkout prüfen → null oder Meldung (→ 400).
 * farbe(item) → Farbe aus den Einstellungen (colorOfItem: ID, sonst Name) oder null; schriftfarbe(id) → Farbe oder null.
 * Unbekannte Farben lehnt die Kasse ab — der Warenkorb im Shop sperrt sie genauso (cart.js farbeFehlt).
 */
export function pruefePositionen(items, { farbe, schriftfarbe }) {
  if (!Array.isArray(items)) return 'Ungültige Anfrage';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const neu = ' – bitte entferne sie aus dem Warenkorb und lege das Design im Konfigurator neu hinein.';
    if (!plain(it)) return `Position ${i + 1} ist ungültig${neu}`;
    if (!(typeof it.product === 'string' && Object.hasOwn(KONFIG.produkte, it.product))) return 'Unbekanntes Produkt';
    const k = pruefeKonfig(it.config, { product: it.product });
    if (k) return `Position ${i + 1}: ungültige Angabe (${KONFIG_LABEL[k] || k})${neu}`;
    if (!leer(it.colorName) && !kurzerText(it.colorName, 80)) return `Position ${i + 1}: ungültige Angabe (Farbe)${neu}`;
    if (!leer(it.color) && !kurzerText(it.color, ID_MAX)) return `Position ${i + 1}: ungültige Angabe (Farbe)${neu}`;
    if (!farbe(it)) {
      const n = String(it.colorName || it.color || '').trim();
      return n ? `Die Farbe „${n}“ gibt es nicht mehr – bitte wähle für dieses Design eine andere Farbe.`
        : `Position ${i + 1}: Bitte wähle eine Farbe für dieses Design.`;
    }
    const c = it.config;
    if (String(c.text || '').trim() && c.textStyle === 'farbe' && !schriftfarbe(c.textColor)) {
      return `Position ${i + 1}: Die Schriftfarbe gibt es nicht mehr – bitte wähle für dieses Design eine andere Schriftfarbe.`;
    }
  }
  return null;
}
