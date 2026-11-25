// formsam — Shop-Server: Statik + Pricing + Warenkorb-Checkout + Rechnungen + Admin + PayPal + Rechtsseiten + Widerruf
// Start: node server.js   →   http://<host>:4488   (Admin: /admin — bei einer Neuinstallation steht ein zufälliges Admin-Passwort einmal im Protokoll)
import http from 'node:http';
import { createGzip, gzipSync, constants as zc } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync, statSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { mkdir, writeFile, readdir, readFile, rm, rename, open, stat, statfs, link } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { produktHinweise, BESCHAFFENHEIT_FASSUNG } from './lib/produkthinweise.js';
import crypto from 'node:crypto';
import { createMailer, baseUrlFor, mailSettings, addressList, keepStoredPass } from './lib/mailer.js';
import { orderConfirmation, orderStatus, statusMailAllowed, STATUS_MAIL, welcome, passwordReset, adminNewOrder, customMessage, surchargeList, surchargeText, aktionText,
  aktionSummary, aktionScopeLabel, orderAktionen, reklamationMail, REKLA_STATUS, REKLA_ART, REKLA_PHASES, RIM_LABELS,
  widerrufEingang, adminWiderruf, lieferzeitText, fristBeginnKurz, emailBestaetigung, VERIFY_TAGE, adminPaypalKasse, zahlungserinnerung, passwortGeaendert, ZAHLUNGSFRIST_TAGE } from './lib/mail-templates.js';
import { isEmail, emailLokalFehler, ohneFinish, kontoName, kontoAdresse, pruefeKonfig, pruefePositionen, KONFIG_LABEL } from './lib/eingaben.js';
import { chmodSync } from 'node:fs';   // Dateirechte der Bestandsordner (unten bei process.umask)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
// ORDERS_DIR/DATA_DIR: abgeschottete Testinstanz (z. B. PORT=4490 DATA_DIR=tmp-tests/sandbox/data ORDERS_DIR=tmp-tests/sandbox/orders)
const ORDERS = path.resolve(process.env.ORDERS_DIR || path.join(__dirname, 'orders'));
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PORT = process.env.PORT || 4488;
// HOST=127.0.0.1 hinter einem Reverse-Proxy (Produktivserver: nginx mit HTTPS) — der Shop-Port ist dann nicht von außen erreichbar
const HOST = process.env.HOST || '0.0.0.0';
const SERVER_STARTED = new Date().toISOString();
// Dateirechte: alles, was der Shop anlegt (data/: Einstellungen mit Passwörtern, Konten, Sitzungen; orders/: Kundendaten), nur für
// den Dienst-Benutzer — Dateien 0600, Ordner 0700.
process.umask(0o077);
// Bestand (Installationen von vor der umask): nur die Ordner data/, data/thumbs und orders/ selbst auf 0700 — die Dateien darin
// bleiben unverändert (kein rekursives chmod), sind für andere Benutzer aber nicht mehr erreichbar. Fehlt ein Ordner, legt der
// Shop ihn später ohnehin mit 0700 an; lässt er sich nicht ändern (anderer Eigentümer), steht ein Hinweis im Protokoll.
for (const dir of [DATA, path.join(DATA, 'thumbs'), ORDERS]) {
  try {
    const st = statSync(dir);
    if (!st.isDirectory() || !(st.mode & 0o077)) continue;
    chmodSync(dir, st.mode & 0o700);
    console.log(`Dateirechte: ${dir} nur noch für den Dienst-Benutzer (vorher ${(st.mode & 0o777).toString(8)}, jetzt ${(st.mode & 0o700).toString(8)})`);
  } catch (err) {
    if (err?.code !== 'ENOENT') console.error(`Dateirechte: ${dir} ließ sich nicht einschränken (${err?.code || err?.message}) — bitte von Hand: chmod 700 ${dir}`);
  }
}
const MAX_JSON = 4 * 1024 * 1024;      // Checkout-JSON (ohne Modelle)
// pro Modell-Datei: größte bestellbare Konfiguration 126,5 MB (gehämmert, 220 mm, Breite 115 %, Tiefe 1,6, Wulstrand, Gravur 12 mm
// „Anna & Tom“ in Marcellus — gemessen mit buildModel wie im Browser) + 50 % Reserve; nginx: client_max_body_size 200m
const MAX_STL = 190 * 1000 * 1000;

// ---------------------------------------------------------------------------
// Hooks — werden im Abschnitt „E-Mail-Versand“ (unten) mit den Mail-Aktionen befüllt.
// Aufrufe sind immer in try/catch gekapselt: ein Hook darf keinen Request scheitern lassen.
// ---------------------------------------------------------------------------
export const hooks = {
  orderCompleted: async (order) => {},
  statusChanged: async (order, prevStatus, opts) => {},
  reklamation: async (order, phase, opts) => {},
  userRegistered: async (user) => {},
  widerruf: async (widerruf) => {},
};
async function runHook(name, ...args) {
  try { await hooks[name]?.(...args); } catch (err) { console.error(`Hook ${name} fehlgeschlagen:`, err?.message || err); }
}

// ---------------------------------------------------------------------------
// Bestellstatus-Modell
// ---------------------------------------------------------------------------
const STATUSES = ['neu', 'bezahlt', 'im-druck', 'gedruckt', 'versendet', 'abgeschlossen', 'storniert'];
const STATUS_LABELS = {
  neu: 'Neu', bezahlt: 'Bezahlt', 'im-druck': 'Im Druck', gedruckt: 'Gedruckt',
  versendet: 'Versendet', abgeschlossen: 'Abgeschlossen', storniert: 'Storniert',
};
const CARRIERS = ['dhl', 'hermes', 'dpd', 'gls', 'post', 'sonstige', ''];
const CARRIER_LABELS = { dhl: 'DHL', hermes: 'Hermes', dpd: 'DPD', gls: 'GLS', post: 'Deutsche Post', sonstige: 'Sonstige', '': '' };
const PRINT_STATES = ['offen', 'druckt', 'fertig'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.stl': 'model/stl', '.3mf': 'model/3mf', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.hdr': 'application/octet-stream',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Einstellungen (data/settings.json) — Preise, Rabatte, Firma, PayPal, Admin
// ---------------------------------------------------------------------------
const SETTINGS_FILE = path.join(DATA, 'settings.json');
// Aufpreise: bekannte Muster-Keys (Spiegel von geometry.js PATTERNS) — unbekannte Keys werden verworfen
const MUSTER_KEYS = ['glatt', 'rippen', 'wellen', 'lamellen', 'zickzack', 'querwellen', 'gehaemmert', 'skelett', 'koralle'];
/** Betrag in € ≥ 0 auf 2 Nachkommastellen — Strings werden gewandelt, Unsinn/negativ wird 0 */
const euro = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; };
/** Muster-Aufpreise (Key → €): nur bekannte Muster, Zahlen ≥ 0 */
function sanitizeMuster(m) {
  const out = {};
  if (m && typeof m === 'object') for (const k of MUSTER_KEYS) if (m[k] !== undefined) out[k] = euro(m[k]);
  return out;
}

// ---------------------------------------------------------------------------
// Aktionen (settings.aktionen): zeitlich begrenzte Prozent-Rabatte auf den Stückpreis (Normalpreis → Aktionspreis; als Streichpreis
//   zeigt der Shop den niedrigsten Preis der letzten 30 Tage — siehe „Preis-Historie“ unten und pricing.js referenzpreis()).
//   { id 'ak-…', name ≤ 60, prozent 1–90 (ganz), start/ende ISO-UTC (ende > start), produkte 'alle'|'eierbecher'|'vase',
//     muster [Muster-Keys] (leer = alle Oberflächen; „nur Gehämmert“ = ['gehaemmert']),
//     mengenrabatt (true = Mengenrabatt zusätzlich, false = entfällt während der Aktion), hinweis ≤ 120, aktiv }
//   Ausgewertet wird ausschließlich zur Laufzeit (kein Cron): aktiveAktionen(now) = alle mit aktiv && start ≤ now < ende,
//   sortiert nach Prozent absteigend (Gleichstand: engerer Geltungsbereich zuerst, dann frühere Startzeit). Mehrere Aktionen
//   dürfen gleichzeitig laufen; je Position gilt die erste passende (aktionFuer: Produkt + Oberfläche, fehlendes Muster = glatt).
//   Der Client rechnet dieselbe Formel (pricing.js), der Server ist beim Checkout die Wahrheit.
// ---------------------------------------------------------------------------
const AKTION_PRODUKTE = ['alle', 'eierbecher', 'vase'];
const newAktionId = () => `ak-${Date.now().toString(36)}${crypto.randomInt(1296).toString(36).padStart(2, '0')}`;
/** ISO-Zeitpunkt (UTC) aus String/Zahl — null, wenn nicht parsebar */
function isoDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
/**
 * Oberflächen einer Aktion: nur bekannte Muster-Keys, ohne Duplikate, in der Reihenfolge von MUSTER_KEYS.
 * Leer = alle Oberflächen; sind alle neun gewählt, wird ebenfalls [] gespeichert. Ein einzelner String zählt als ein Key.
 */
function sanitizeAktionMuster(v) {
  const raw = Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? v.split(',') : []);
  const set = new Set(raw.map((k) => String(k ?? '').trim()).filter((k) => MUSTER_KEYS.includes(k)));
  return set.size >= MUSTER_KEYS.length ? [] : MUSTER_KEYS.filter((k) => set.has(k));
}
/** Eine Aktion prüfen und normalisieren (unbekannte Felder fallen weg) — wirft httpError(400) mit lesbarer Meldung */
function sanitizeAktion(a, i = 0) {
  const pos = `Aktion ${i + 1}`;
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw httpError(400, `${pos}: ungültiges Format`);
  const name = clipText(a.name, 60);
  if (!name) throw httpError(400, `${pos}: bitte einen Namen angeben`);
  const prozent = Math.round(Number(a.prozent));
  if (!Number.isFinite(prozent) || prozent < 1 || prozent > 90) throw httpError(400, `Aktion „${name}“: Prozent muss eine ganze Zahl zwischen 1 und 90 sein`);
  const start = isoDate(a.start), ende = isoDate(a.ende);
  if (!start || !ende) throw httpError(400, `Aktion „${name}“: Start und Ende müssen gültige Zeitpunkte sein`);
  if (Date.parse(ende) <= Date.parse(start)) throw httpError(400, `Aktion „${name}“: das Ende muss nach dem Start liegen`);
  const produkte = a.produkte === undefined || a.produkte === null || a.produkte === '' ? 'alle' : a.produkte;
  if (!AKTION_PRODUKTE.includes(produkte)) throw httpError(400, `Aktion „${name}“: Produkte muss „alle“, „eierbecher“ oder „vase“ sein`);
  const id = /^[A-Za-z0-9_-]{1,40}$/.test(String(a.id ?? '')) ? String(a.id) : newAktionId();
  return { id, name, prozent, start, ende, produkte, muster: sanitizeAktionMuster(a.muster), mengenrabatt: !!a.mengenrabatt, hinweis: clipText(a.hinweis, 120), aktiv: !!a.aktiv };
}
/** Liste sanieren: streng (400 beim ersten Fehler — Admin-Patch) oder nachsichtig (kaputte Einträge verwerfen — beim Laden) */
function sanitizeAktionen(list, { lenient = false } = {}) {
  if (!Array.isArray(list)) { if (lenient) return []; throw httpError(400, 'Aktionen: Liste erwartet'); }
  if (list.length > 50 && !lenient) throw httpError(400, 'Aktionen: höchstens 50 Einträge');
  const out = [], ids = new Set();
  list.slice(0, 50).forEach((a, i) => {
    let ak;
    try { ak = sanitizeAktion(a, i); } catch (err) { if (!lenient) throw err; console.warn(`⚠️  ${err.message} – Eintrag verworfen`); return; }
    while (ids.has(ak.id)) ak.id = newAktionId();   // doppelte IDs (kopierter Eintrag) → neue ID
    ids.add(ak.id);
    out.push(ak);
  });
  return out;
}
/** Größe des Geltungsbereichs (Produkte × Oberflächen) — kleiner = enger; entscheidet die Reihenfolge bei gleichem Prozentsatz */
const aktionScopeSize = (a) => (a.produkte === 'alle' ? 2 : 1) * (a.muster?.length ? a.muster.length : MUSTER_KEYS.length);
/**
 * Alle gerade laufenden Aktionen (aktiv && start ≤ now < ende), sortiert nach Prozent absteigend —
 * bei Gleichstand engerer Geltungsbereich zuerst, dann frühere Startzeit. Für eine Position gilt die erste passende (aktionFuer).
 */
function aktiveAktionen(now = Date.now()) {
  return (settings.aktionen || [])
    .filter((a) => a?.aktiv && Date.parse(a.start) <= now && now < Date.parse(a.ende))
    .sort((x, y) => y.prozent - x.prozent || aktionScopeSize(x) - aktionScopeSize(y) || Date.parse(x.start) - Date.parse(y.start));
}
/** Die primäre laufende Aktion (erste der Liste), sonst null — für Übersicht und Kompatibilität (aktion-Feld) */
const aktiveAktion = (now = Date.now()) => aktiveAktionen(now)[0] || null;
/**
 * Erste Aktion der Liste, die für eine Position gilt: Produkt passt (produkte 'alle' oder genau item.product) und die
 * Oberfläche passt (muster leer = alle, sonst muss config.pattern enthalten sein; fehlendes Muster zählt als 'glatt'). Sonst null.
 */
function aktionFuer(item, liste = aktiveAktionen()) {
  const pattern = item?.config?.pattern || 'glatt';
  return liste.find((a) => (a.produkte === 'alle' || a.produkte === item?.product) && (!a.muster?.length || a.muster.includes(pattern))) || null;
}
/** Öffentliche Sicht für Shop & Countdown (/api/pricing) — ohne aktiv-Flag */
const publicAktion = (a) => (a ? { id: a.id, name: a.name, prozent: a.prozent, start: a.start, ende: a.ende, produkte: a.produkte, muster: Array.isArray(a.muster) ? a.muster : [], mengenrabatt: !!a.mengenrabatt, hinweis: a.hinweis || '' } : null);
// ---------------------------------------------------------------------------
// Produktschalter (settings.produkte): Vasen sind immer bestellbar; Eierbecher nur, wenn der Schalter an ist.
// Der Schalter blendet das Produkt im Shop und im Admin aus und sperrt neue Bestellungen — alte Bestellungen,
// Designs, Listen, Preise und Geometrie bleiben unverändert, damit nichts gelöscht werden muss.
// ---------------------------------------------------------------------------
const PRODUKT_SCHALTER = ['eierbecher'];
const EIERBECHER_GESPERRT = 'Eierbecher sind derzeit nicht bestellbar.';
/** { eierbecher: bool } aus beliebiger Eingabe (Datei/Patch) — fehlt oder ungültig → Standard (aus) */
function sanitizeProdukte(v) {
  const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return { eierbecher: src.eierbecher === true };
}
/** Ist das Produkt aktuell bestellbar? 'vase' immer, 'eierbecher' nur mit Schalter, Unbekanntes nie. */
function produktAktiv(product) {
  if (product === 'vase') return true;
  if (product === 'eierbecher') return settings?.produkte?.eierbecher === true;
  return false;
}
/**
 * Prüft die Zeilen einer Anfrage (Quote, PayPal, Checkout) gegen den Produktschalter:
 * Meldung (→ 400) bei gesperrtem Eierbecher oder unbekanntem Produkt, sonst null.
 */
function produktSperre(items) {
  for (const it of Array.isArray(items) ? items : []) {
    const product = it?.product;
    if (product === 'eierbecher' && !produktAktiv('eierbecher')) return EIERBECHER_GESPERRT;
    if (!['vase', 'eierbecher'].includes(product)) return 'Unbekanntes Produkt';
  }
  return null;
}
/**
 * Farben, die der Admin aus dem Shop genommen hat („Im Shop“ aus): /api/colors liefert sie nicht mehr, der Client rechnet ihren
 * Aufpreis deshalb nicht — der Server (colorOfItem findet auch inaktive) würde ihn aber berechnen. Solche Zeilen (Körperfarbe,
 * bei Farbschrift auch die Schriftfarbe) weisen Quote, PayPal und Checkout ab (→ 400), statt anders zu rechnen als die Kasse.
 * Unbekannte Farben (nicht in den Einstellungen) bleiben wie bisher ohne Aufpreis erlaubt.
 */
function farbSperre(items) {
  for (const it of Array.isArray(items) ? items : []) {
    const c = colorOfItem(it);
    if (c && !c.active) return `Die Farbe „${c.name}“ ist derzeit nicht verfügbar – bitte wähle für dieses Design eine andere Farbe.`;
    const cfg = it?.config || {};
    if (String(cfg.text || '').trim() && cfg.textStyle === 'farbe' && typeof cfg.textColor === 'string') {
      const t = (settings.colors || []).find((x) => x?.id === cfg.textColor);
      if (t && !t.active) return `Die Schriftfarbe „${t.name}“ ist derzeit nicht verfügbar – bitte wähle für dieses Design eine andere Schriftfarbe.`;
    }
  }
  return null;
}
/**
 * Wertprüfung der Positionen (Quote, PayPal, Checkout; lib/eingaben.js pruefePositionen): Form, Muster, Schrift, Stil, Rand und Verlauf
 * müssen bekannt sein, Zahlen in den Grenzen der Regler, Texte begrenzt (Gravur 40, Farbname 80), colorHex nur #rrggbb, Farbe
 * (und bei Farbschrift die Schriftfarbe) muss es in den Einstellungen geben → Meldung (→ 400) oder null
 */
const positionenFehler = (items) => pruefePositionen(items, {
  farbe: colorOfItem, schriftfarbe: (id) => (settings.colors || []).find((x) => x?.id === id) || null,
});

// Kein Standard-Admin-Passwort: settings.adminKeyHash entsteht beim Start (Klartext umstellen oder zufällig erzeugen, siehe loadSettings)
const DEFAULT_SETTINGS = {
  invoicePrefix: 'RE-2026-',
  nextInvoice: 1,
  // Gutschriften (Reklamation): eigener Nummernkreis, vierstellig
  creditPrefix: 'GS-2026-',
  nextCredit: 1,
  // Eierbecher sind vorerst deaktiviert — Produktcode, Bestellungen und Designs bleiben erhalten,
  // damit das Produkt später wieder aktiviert werden kann. (Admin → System → „Eierbecher als Produkt anbieten“)
  produkte: { eierbecher: false },
  pricing: {
    currency: 'EUR',
    eierbecher: {
      single: 9.90, untersetzer: 4.90,
      discounts: [{ qty: 2, off: 20 }, { qty: 4, off: 35 }, { qty: 6, off: 40 }],
    },
    vase: {
      single: 24.90,
      discounts: [{ qty: 2, off: 10 }, { qty: 3, off: 15 }],
    },
    shipping: { flat: 4.90, freeFrom: 39 },
    gravur: 3.00,
    // Aufpreise je Stück: Muster (Key → €, fehlender Key = 0) und Farbschrift (zusätzlich zur Gravur)
    muster: { lamellen: 3 },
    farbschrift: 2,
    // Größenaufschlag: mehr Volumen = mehr Filament & Druckzeit.
    // relVol = (Höhe/Normalhöhe) · Breitenfaktor² ; Aufschlag nur oberhalb Normal.
    volumen: { prozent: 60, euro: 0 },
  },
  company: {
    name: 'formsam', owner: 'Julian Sendlhofer',
    street: 'Musterstraße 1', zip: '00000', city: 'Musterstadt', country: 'Deutschland',
    email: 'jsendlhofer.js@gmail.com', phone: '',
    ustId: '', wIdNr: '', steuerNr: '', kleinunternehmer: true,
    iban: 'DE00 0000 0000 0000 0000 00', bic: '', bank: '',
  },
  // Shop-Angaben für Kasse, Mails und Rechnung (Lieferzeit steht u. a. in der Bestellbestätigung)
  shop: { lieferzeit: '5–8 Werktage', liefergebiet: 'Deutschland' },
  // Angaben für die Rechtsseiten (lib/legal.js, Datenschutzerklärung): Hoster und Serverstandort je Server — bewusst ohne
  // Standardwert (Admin-Hinweis, solange leer); avVertrag = AV-Vertrag mit dem Hoster im Admin bestätigt;
  // mailVersand 'eigen' (eigener Mailserver auf dem gemieteten Server) | 'anbieter' (E-Mail-Anbieter, Name optional in mailAnbieter)
  legal: { hoster: '', serverOrt: '', avVertrag: false, mailVersand: 'anbieter', mailAnbieter: '' },
  paypal: { enabled: false, sandbox: true, clientId: '', secret: '' },
  // Wartungsmodus: Shop nur mit Zugangskennwort (hash = scrypt, secret = HMAC-Schlüssel für das Freigabe-Cookie)
  wartung: { aktiv: false, hash: '', secret: '' },
  colors: null,   // wird beim ersten Start aus content.json übernommen
  coupons: [],    // [{ code, type: 'percent'|'fixed', value, minOrder, active, note?, mitAktion }] — mitAktion: mit laufender Aktion kombinierbar
  // Aktionen (zeitlich begrenzte Prozent-Rabatte): [{ id, name, prozent, start, ende, produkte, muster, mengenrabatt, hinweis, aktiv }] — siehe sanitizeAktion()
  aktionen: [],
  // Druck-Schätzwerte je Stück bei Normalhöhe (Admin: Warteschlange, Filamentbedarf);
  // Skalierung ≈ (Höhe/Normalhöhe)^1.5
  printing: { minutesEgg: 75, minutesVase: 210, gramsEgg: 22, gramsVase: 110 },
  // E-Mail-Versand (SMTP) — wird von der E-Mail-Integration (Phase 2) genutzt
  mail: {
    enabled: false, host: '', port: 465, secure: 'ssl', user: '', pass: '',
    from: '', fromName: 'formsam', replyTo: '', adminTo: '', adminCopy: true,
    autoStatusMails: true, publicUrl: '',
  },
};

// ---------------------------------------------------------------------------
// Firma, Shop-Angaben und Rechtsangaben (settings.company / .shop / .legal): nur bekannte Felder,
// Texte ohne Steuerzeichen, getrimmt und gekürzt. Beim Laden werden fehlende Felder nur aufgefüllt (Live-Daten
// bleiben unverändert); ein Admin-Patch wird streng geprüft (400 mit lesbarer Meldung).
// ---------------------------------------------------------------------------
const COMPANY_TEXT = { name: 60, owner: 120, street: 120, zip: 10, city: 80, country: 60, email: 254, phone: 40, ustId: 20, wIdNr: 20, steuerNr: 20, iban: 42, bic: 11, bank: 80 };
const SHOP_TEXT = { lieferzeit: 60, liefergebiet: 80 };
const LEGAL_TEXT = { hoster: 200, serverOrt: 120, mailAnbieter: 120 };
const MAIL_VERSAND = ['eigen', 'anbieter'];
const plainObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
/** Einzeiliger Text: alle Leerraum-Folgen (auch Zeilenumbrüche) → ein Leerzeichen, dann wie clipText */
const oneLine = (v, n) => clipText(String(v ?? '').replace(/\s+/g, ' '), n);
/** Nur bekannte Textfelder (Key → Maximallänge); fehlende/leere Felder → Standardwert (leer bleibt leer, wenn der Standard leer ist) */
function pickText(src, fields, defaults) {
  const out = {};
  for (const [k, max] of Object.entries(fields)) {
    const v = src[k] === undefined || src[k] === null ? '' : oneLine(src[k], max);
    out[k] = v || String(defaults[k] ?? '');
  }
  return out;
}
/**
 * Firmendaten aus einem Admin-Patch prüfen: Name/Land fallen auf „formsam“/„Deutschland“ zurück, E-Mail (wenn gesetzt) gültig,
 * USt-IdNr. „DE123456789“-Form, Wirtschafts-Identifikationsnummer „DE123456789-00001“ (§ 139c AO; eigenes Feld wIdNr — steht sie
 * im USt-IdNr.-Feld, wird sie dorthin verschoben), Steuernummer 10–13 Ziffern (mit / - Leerzeichen), IBAN über cleanIban.
 * Wirft httpError(400); liefert das vollständige company-Objekt.
 */
function sanitizeCompany(raw) {
  const src = plainObj(raw);
  const co = pickText(src, COMPANY_TEXT, { name: DEFAULT_SETTINGS.company.name, country: DEFAULT_SETTINGS.company.country });
  co.kleinunternehmer = src.kleinunternehmer === undefined ? true : !!src.kleinunternehmer;
  co.email = co.email.toLowerCase();
  if (co.email && !isEmail(co.email)) throw httpError(400, 'Firma: E-Mail-Adresse ungültig');
  co.ustId = co.ustId.toUpperCase().replace(/\s+/g, '');
  co.wIdNr = co.wIdNr.toUpperCase().replace(/\s+/g, '');
  if (/^DE\d{9}-\d{5}$/.test(co.ustId) && (!co.wIdNr || co.wIdNr === co.ustId)) { co.wIdNr = co.ustId; co.ustId = ''; }
  if (co.ustId && !/^[A-Z]{2}[0-9A-Z+*.]{2,12}$/.test(co.ustId)) throw httpError(400, 'Firma: USt-IdNr. ungültig (z. B. DE123456789)');
  if (co.wIdNr && !/^DE\d{9}-\d{5}$/.test(co.wIdNr)) throw httpError(400, 'Firma: Wirtschafts-Identifikationsnummer ungültig (DE, 9 Ziffern, Bindestrich, 5 Ziffern – z. B. DE123456789-00001)');
  const stDigits = co.steuerNr.replace(/\D/g, '').length;
  if (co.steuerNr && (!/^[0-9 /-]+$/.test(co.steuerNr) || stDigits < 10 || stDigits > 13)) throw httpError(400, 'Firma: Steuernummer ungültig (z. B. 12/345/67890)');
  const iban = cleanIban(co.iban);
  if (iban === null) throw httpError(400, 'Firma: IBAN ungültig – nur Buchstaben und Ziffern, 15–34 Zeichen, beginnt mit Länderkennung');
  co.iban = iban;
  co.bic = co.bic.toUpperCase().replace(/\s+/g, '');
  return co;
}
/** Shop-Angaben: Lieferzeit/Liefergebiet als Text, leer → Standard */
const sanitizeShop = (raw) => pickText(plainObj(raw), SHOP_TEXT, DEFAULT_SETTINGS.shop);
/**
 * Rechtsangaben: Hoster, Serverstandort und Name des Mail-Anbieters als Text (leer bleibt leer — kein stiller Hoster-Standard
 * mehr), avVertrag als Boolean (nur mit Hoster; wird der Hoster geleert, ist auch die Bestätigung weg), mailVersand
 * 'eigen' | 'anbieter'. Migration älterer Einstellungen ohne die neuen Felder: ein eingetragener Hoster gilt als bestätigt
 * (der Text der Datenschutzerklärung bleibt dort gleich) — außer dem früheren stillen Standard (IONOS): den hat der alte Code
 * bei jedem Start in settings.json geschrieben, er ist also kein Eintrag und muss je Server bestätigt werden (Hinweis in
 * legalWarnings); Mailversand wie bisher 'anbieter'.
 */
const ALTER_HOSTER_STANDARD = 'IONOS SE, Elgendorfer Str. 57, 56410 Montabaur';   // wie lib/legal.js
function sanitizeLegal(raw) {
  const src = plainObj(raw);
  const out = pickText(src, LEGAL_TEXT, { hoster: '', serverOrt: '', mailAnbieter: '' });
  out.avVertrag = !!out.hoster && (src.avVertrag === undefined ? out.hoster !== ALTER_HOSTER_STANDARD : src.avVertrag === true);   // ohne Hoster keine Bestätigung
  out.mailVersand = MAIL_VERSAND.includes(src.mailVersand) ? src.mailVersand : DEFAULT_SETTINGS.legal.mailVersand;
  return out;
}
/**
 * Hinweise für den Admin (Übersicht): fehlende Pflichtangaben für Rechnungen mit Umsatzsteuer und — wenn lib/legal.js
 * geladen ist — dessen legalWarnings() (Impressum-Pflichtangaben, Platzhalter-Adresse, Telefon …)
 */
function settingsHinweise() {
  const co = settings.company || {};
  const out = [];
  // § 14 Abs. 4 Nr. 2 UStG bzw. § 34a Satz 1 Nr. 2 UStDV: auch Kleinunternehmer-Rechnungen tragen Steuernummer oder USt-IdNr.
  // (ausgenommen nur Kleinbetragsrechnungen bis 250 €, § 33 UStDV)
  if (!String(co.steuerNr || '').trim() && !String(co.ustId || '').trim()) {
    out.push(co.kleinunternehmer
      ? 'Steuernummer fehlt: Auch als Kleinunternehmer muss jede Rechnung über 250 € die Steuernummer oder USt-IdNr. tragen (§ 34a UStDV) – bitte unter Firma eintragen.'
      : 'Rechnungen mit Umsatzsteuer brauchen eine Steuernummer oder USt-IdNr. – bitte unter Firma eintragen.');
  }
  // IBAN: Platzhalter aus der Grundeinstellung oder falsche Prüfziffer — Rechnung und Bestätigungsmail nennen sie als Zahlungsziel
  const iban = String(co.iban || '').replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z]{2}00/.test(iban) || /^DE0+$/.test(iban)) out.push('Bankverbindung: Die IBAN ist noch der Platzhalter „DE00 …“ – Rechnungen und Bestätigungsmails nennen sie als Zahlungsziel. Bitte unter Firma die echte IBAN eintragen.');
  else if (iban && !ibanPruefzifferOk(iban)) out.push(`Bankverbindung: Die Prüfziffer der IBAN ${iban.slice(0, 4)} … stimmt nicht – bitte unter Firma prüfen (Tippfehler?).`);
  // Nummern, die bei einem Schreibfehler nicht vergeben werden konnten (belegNrFreigeben) — Lücke mit Grund für die Buchhaltung
  for (const l of (Array.isArray(settings.belegLuecken) ? settings.belegLuecken : []).slice(-5)) {
    out.push(`Nummernkreis: Belegnummer ${l.nr} wurde am ${dateDE(l.at)} nicht vergeben (${l.grund}) – Lücke bitte in der Buchhaltung vermerken.`);
  }
  if (historieDefekt) out.push(`Preis-Historie war beim Start unlesbar (gesichert als ${historieDefekt}) – die Streichpreise der nächsten 30 Tage (niedrigster Preis vor einer Aktion) bitte prüfen.`);
  if (historieGesperrt) out.push('Preis-Historie (data/preis-historie.json) ist nicht lesbar und wird nicht fortgeschrieben – bitte Datei prüfen und den Shop neu starten.');
  if (speicherZuletzt !== null && speicherZuletzt < 2 * MIN_FREI) out.push(`Speicher fast voll: nur noch ${(speicherZuletzt / 1e9).toFixed(1).replace('.', ',')} GB frei – unter 1 GB nimmt die Kasse keine Druckdateien mehr an.`);
  if (Object.keys(designs).length > 50_000 || Object.keys(lists).length > 10_000) out.push(`Ungewöhnlich viele Design-Codes (${Object.keys(designs).length}) bzw. Listen (${Object.keys(lists).length}) – bitte data/designs.json und data/lists.json prüfen (Missbrauch?).`);
  if (bestellungenDefekt.size) out.push(`Bestellung ${[...bestellungenDefekt].join(', ')}: order.json ist beschädigt und fehlt in der Liste – bitte aus der Sicherung (/var/backups/formsam) zurückholen.`);
  let legal = null;
  try { legal = typeof legalMod?.legalWarnings === 'function' ? legalMod.legalWarnings(settings) : null; } catch { legal = null; }
  if (Array.isArray(legal)) out.push(...legal.map(String));
  else if (!String(co.owner || '').trim()) out.push('Firma: Inhaber (voller Name) fehlt – er gehört auf Rechnungen und ins Impressum.');
  return out;
}

let settings;
function loadSettings() {
  mkdirSync(DATA, { recursive: true });
  // Fehlt settings.json, ist das eine Neuinstallation (Standardwerte). Ist sie da, aber unlesbar, bricht der Start ab (ladeDatei) —
  // nie still mit Standardwerten weiterlaufen (anderes Admin-Passwort, Mail aus, Gutscheine und Nummernkreise zurückgesetzt)
  const gespeichert = ladeDatei(SETTINGS_FILE, { pruefe: nurObjekt });
  settings = gespeichert ? { ...DEFAULT_SETTINGS, ...gespeichert } : structuredClone(DEFAULT_SETTINGS);
  // Filament-Farben einmalig aus content.json übernehmen
  if (!Array.isArray(settings.colors)) {
    try {
      const content = JSON.parse(readFileSync(path.join(PUBLIC, 'content.json'), 'utf8'));
      settings.colors = content.colors.map((c) => ({ ...c, active: true, note: '' }));
    } catch { settings.colors = []; }
  }
  if (!Array.isArray(settings.coupons)) settings.coupons = [];
  // Gutscheine: nur Objekte; mitAktion (mit laufender Aktion kombinierbar) fehlt bei älteren Einträgen → false
  settings.coupons = settings.coupons.filter((c) => c && typeof c === 'object');
  for (const c of settings.coupons) c.mitAktion = !!c.mitAktion;
  // Migration: Gutschrift-Codes aus Reklamationen („GS-XXXX-XXXX“, Notiz „Gutschrift … zu <Bestellung>“) sind Guthaben —
  // einmal pro Betrag einlösbar (Rest bleibt) und auch während einer Aktion gültig
  for (const c of settings.coupons) {
    if (c.guthaben === undefined && c.type === 'fixed' && /^GS-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(String(c.code || '')) && /^Gutschrift\b/.test(String(c.note || ''))) {
      c.guthaben = true; c.mitAktion = true;
    }
    // Guthaben gilt ohne Mindestbestellwert und auch während einer Aktion (Gutschrift-Beleg, AGB § 14) — ältere Einstellungen angleichen
    if (c.guthaben) { c.minOrder = 0; c.mitAktion = true; }
  }
  // Preise: auf Cent runden, fehlende Teile (Versand, Produkte, Währung) auffüllen — Altstände laufen ohne Handarbeit weiter
  settings.pricing = preiseBeimLaden(settings.pricing);
  // Aktionen: Array erzwingen, kaputte Einträge verwerfen (Meldung im Log)
  settings.aktionen = sanitizeAktionen(settings.aktionen, { lenient: true });
  // Admin-Passwort nur als scrypt-Hash (adminKeyHash). Ein Klartext-adminKey (ältere settings.json, von Hand oder per Skript
  // gesetzt) wird umgestellt — dasselbe Passwort gilt weiter. Fehlt beides oder ist der Hash kaputt, gibt es ein zufälliges Passwort,
  // das genau einmal im Protokoll steht (kein bekanntes Standard-Passwort mehr). An der Stelle von adminKey steht danach ein
  // Platzhalter (adminKeyPlatzhalter, siehe adminPlatzhalterSetzen) — den erkennt diese Fassung und lässt ihn stehen
  const platzhalter = adminKeyIstPlatzhalter(settings);
  if (!platzhalter && typeof settings.adminKey === 'string' && settings.adminKey.trim()) {
    settings.adminKeyHash = pwHashSync(settings.adminKey);
    console.log('🔐 Admin-Passwort: Klartext in settings.json durch einen scrypt-Hash ersetzt (das Passwort bleibt gleich)');
  } else if (!pwHashGueltig(settings.adminKeyHash)) {
    const neu = crypto.randomBytes(15).toString('base64url');
    settings.adminKeyHash = pwHashSync(neu);
    console.warn(`🔐 ${gespeichert ? 'settings.json ohne gültiges Admin-Passwort' : 'Neuinstallation'} – neues Admin-Passwort (steht nur hier, bitte notieren und im Admin unter System ändern): ${neu}`);
  }
  if (!platzhalter) adminPlatzhalterSetzen(settings);
  if (typeof settings.pricing.gravur !== 'number') settings.pricing.gravur = 3.00;
  if (!settings.pricing.volumen) settings.pricing.volumen = { prozent: 60, euro: 0 };
  // Migration Aufpreise: Muster (Betreiber-Wunsch: Lamellen +3 €), Farbschrift +2 €
  settings.pricing.muster = (settings.pricing.muster && typeof settings.pricing.muster === 'object')
    ? sanitizeMuster(settings.pricing.muster) : { lamellen: 3 };
  settings.pricing.farbschrift = typeof settings.pricing.farbschrift === 'number' ? euro(settings.pricing.farbschrift) : 2;
  settings.printing = { ...DEFAULT_SETTINGS.printing, ...(settings.printing || {}) };
  settings.mail = { ...DEFAULT_SETTINGS.mail, ...(settings.mail || {}) };
  // Gutschrift-Nummernkreis (Reklamationen)
  if (typeof settings.creditPrefix !== 'string') settings.creditPrefix = DEFAULT_SETTINGS.creditPrefix;
  settings.nextCredit = Math.max(1, Math.round(Number(settings.nextCredit)) || 1);
  // Migration Produktschalter: fehlt in älteren settings.json → Eierbecher aus (siehe DEFAULT_SETTINGS.produkte)
  settings.produkte = sanitizeProdukte(settings.produkte);
  // Migration: Finishes (matt/glanz/metall) + bekannte Silk-/Glossy-PLA-Farben
  if (!settings.colorsV2) {
    for (const c of settings.colors) if (!c.finish) c.finish = 'matt';
    const have = new Set(settings.colors.map((c) => c.id));
    const neu = [
      { id: 'gold', name: 'Gold', hex: '#d4af37', finish: 'metall', note: 'Silk/Metallic PLA' },
      { id: 'silber', name: 'Silber', hex: '#c7c9cc', finish: 'metall', note: 'Silk/Metallic PLA' },
      { id: 'kupfer', name: 'Kupfer', hex: '#b87333', finish: 'metall', note: 'Silk/Metallic PLA' },
      { id: 'feuerrot', name: 'Feuerrot', hex: '#c8102e', finish: 'glanz', note: 'Glossy PLA' },
      { id: 'tiefschwarz', name: 'Tiefschwarz', hex: '#1a1a1c', finish: 'glanz', note: 'Glossy PLA' },
      { id: 'perlmutt', name: 'Perlmutt', hex: '#ece6da', finish: 'metall', note: 'Silk PLA' },
    ];
    for (const c of neu) if (!have.has(c.id)) settings.colors.push({ ...c, active: true });
    settings.colorsV2 = true;
  }
  // Migration: Farbaufpreis je Körperfarbe (€/Stück, Standard 0)
  for (const c of settings.colors) if (c && typeof c === 'object') c.aufpreis = euro(c.aufpreis);
  // Migration Marke (formsam): alter Firmenname „OVJU — …“ → „formsam“, Absendername „OVJU“ → „formsam“.
  // Neue Felder (Land, Steuernummer, Shop- und Rechtsangaben) mit Standardwerten auffüllen — Adresse, IBAN usw. bleiben, wie sie sind.
  const co = { ...plainObj(settings.company) };
  if (/ovju/i.test(String(co.name || ''))) co.name = DEFAULT_SETTINGS.company.name;
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS.company)) if (co[k] === undefined || co[k] === null) co[k] = v;
  settings.company = co;
  if (/ovju/i.test(String(settings.mail.fromName || ''))) settings.mail.fromName = DEFAULT_SETTINGS.mail.fromName;
  settings.shop = sanitizeShop(settings.shop);
  settings.legal = sanitizeLegal(settings.legal);
  for (const h of settingsHinweise()) console.warn(`⚠️  ${h}`);
  saveSettings().catch((err) => console.error('Einstellungen konnten nicht gespeichert werden:', err?.message || err));
}
// Atomar (Temp-Datei + rename) und nacheinander: ein Absturz mitten im Schreiben hinterlässt nie eine halbe settings.json,
// und zwei schnelle Speichervorgänge überholen sich nicht (der spätere Stand gewinnt)
let settingsWrite = Promise.resolve();
function saveSettings() {
  const json = JSON.stringify(settings, null, 2);   // Stand zum Aufrufzeitpunkt
  settingsWrite = settingsWrite.catch(() => {}).then(() => writeFileAtomic(SETTINGS_FILE, json));
  return settingsWrite;
}
let atomicSeq = 0;
/** Datei atomar schreiben (Temp-Datei im selben Ordner + rename) */
async function writeFileAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${(++atomicSeq).toString(36)}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Datendateien (settings, users, sessions, designs, lists, paypal-captures): Laden beim Start, Speichern atomar und nacheinander.
//   Fehlt eine Datei, beginnt sie leer (Neuinstallation). Ist sie da, aber nicht lesbar oder kein gültiges JSON, bricht der Start
//   mit klarer Meldung ab (startAbbruch) — sonst liefe der Shop mit leeren Konten/Codes oder Standard-Einstellungen weiter und
//   überschriebe die Datei beim nächsten Speichern. Ausnahme sessions.json (nur Anmeldungen): als .defekt-<Zeit> beiseitelegen,
//   laut warnen, leer weiter. Gespeichert wird über writeFileAtomic in einer Kette je Datei (speicherKette).
// ---------------------------------------------------------------------------
const SICHERUNG_HINWEIS = 'Sicherungen: /var/backups/formsam auf dem Produktivserver (täglich, 14 Tage). Datei von dort zurückholen oder reparieren, dann den Shop neu starten (README, Abschnitt „Daten, Sicherung und defekte Dateien“).';
/** JSON-Datei lesen → Wert (geprüft) | null, wenn sie fehlt; unlesbar → beiseitelegen (beiseite) oder Startabbruch */
function ladeDatei(file, { pruefe = (v) => v, beiseite = false } = {}) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return null;
    return dateiDefekt(file, `nicht lesbar (${err.code || err.message})`, beiseite);
  }
  try { return pruefe(JSON.parse(text)); } catch (err) { return dateiDefekt(file, `beschädigt (${err.message})`, beiseite); }
}
function dateiDefekt(file, grund, beiseite) {
  if (beiseite) {
    const backup = `${file}.defekt-${Date.now()}`;
    try {
      renameSync(file, backup);
      console.error(`⚠️  ${path.basename(file)} ${grund} – gesichert als ${path.basename(backup)}, leer weiter`);
      return null;
    } catch (e2) { grund += `; Sichern als ${path.basename(backup)} fehlgeschlagen (${e2.code || e2.message})`; }
  }
  throw Object.assign(new Error(`${file} ist ${grund}`), { startAbbruch: true });
}
const nurObjekt = (v) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('kein JSON-Objekt'); return v; };
/**
 * Speichern je Datei: atomar (writeFileAtomic) und nacheinander. Wer speichert, während ein Schreibvorgang noch wartet, fährt in
 * diesem mit — serialisiert wird erst beim Start des Schreibens, also immer der neueste Stand. → () => Promise (nach dem Schreiben)
 */
function speicherKette(file, stand) {
  let letzte = Promise.resolve(), wartend = null;
  return () => {
    if (wartend) return wartend;
    wartend = letzte.catch(() => {}).then(() => { wartend = null; return writeFileAtomic(file, stand()); });
    letzte = wartend;
    return wartend;
  };
}
const speicherFehler = (was) => (err) => console.error(`${was} konnte nicht gespeichert werden:`, err?.message || err);

// --- Passwörter (Kundenkonten, Admin): crypto.scrypt asynchron — blockiert den Shop nicht wie scryptSync. Höchstens SCRYPT_PARALLEL
//   Rechnungen gleichzeitig: scrypt läuft im libuv-Threadpool (4 Plätze), den auch jeder Dateizugriff braucht — ein Schub
//   Rateversuche darf Seiten, Skripte und Druckdateien nicht ausbremsen. Prüfungen (pruefung = true: Anmeldung, Admin-Passwort)
//   scheitern sofort mit code 'ueberlast' (Anmeldung → 503, Admin → 429), wenn schon SCRYPT_WARTEND_MAX warten — die Warteschlange
//   wächst nicht unbegrenzt. Neue Passwörter (Registrierung, Reset, Wechsel; vorher gebremst) warten immer.
const SCRYPT_PARALLEL = 2, SCRYPT_WARTEND_MAX = 100;
const UEBERLAST = { ok: false, error: 'Gerade ist sehr viel los – bitte versuch es in einer Minute noch einmal.' };
let scryptLaeuft = 0;
const scryptWarten = [];
function scryptAsync(pw, salt, len, pruefung = false) {
  if (pruefung && scryptLaeuft >= SCRYPT_PARALLEL && scryptWarten.length >= SCRYPT_WARTEND_MAX) return Promise.reject(Object.assign(new Error('scrypt ausgelastet'), { code: 'ueberlast' }));
  return new Promise((ok, fail) => {
    const los = () => {
      scryptLaeuft++;
      const fertig = (err, key) => { scryptLaeuft--; scryptWarten.shift()?.(); if (err) fail(err); else ok(key); };
      try { crypto.scrypt(String(pw), salt, len, fertig); } catch (err) { fertig(err); }
    };
    if (scryptLaeuft < SCRYPT_PARALLEL) los(); else scryptWarten.push(los);
  });
}
/**
 * Platzhalter statt adminKey: Eine ältere Fassung (Rückkehr per git nach einem Update) kennt nur settings.adminKey und nähme ohne ihn
 * das früher bekannte Standard-Passwort „formsam-admin“. Deshalb steht dort ein zufälliger, nirgends angezeigter Wert — die alte
 * Fassung sperrt den Admin damit zu, statt ihn zu öffnen. adminKeyPlatzhalter = SHA-256 davon: Daran erkennt diese Fassung den
 * Platzhalter. Hat die alte Fassung adminKey inzwischen geändert (Admin → System), passt der SHA-256 nicht mehr → das neue Passwort
 * wird beim nächsten Start in den Hash übernommen. Gleiches Verfahren in tools/admin-passwort.mjs.
 */
function adminPlatzhalterSetzen(s) {
  s.adminKey = crypto.randomBytes(24).toString('base64url');
  s.adminKeyPlatzhalter = crypto.createHash('sha256').update(s.adminKey).digest('hex');
}
const adminKeyIstPlatzhalter = (s) => typeof s.adminKey === 'string' && typeof s.adminKeyPlatzhalter === 'string'
  && s.adminKeyPlatzhalter === crypto.createHash('sha256').update(s.adminKey).digest('hex');
/** Admin-Passwort → 'scrypt$salt$hash' (32 Bytes, wie das Wartungskennwort); synchron nur beim Start und in tools/admin-passwort.mjs */
function pwHashSync(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
async function pwHash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await scryptAsync(pw, salt, 32)).toString('hex')}`;
}
const pwHashGueltig = (h) => /^scrypt\$[0-9a-f]{16,64}\$[0-9a-f]{64}$/.test(String(h || ''));
async function pwHashStimmt(pw, h) {
  if (!pwHashGueltig(h) || typeof pw !== 'string') return false;
  const [, salt, hex] = h.split('$');
  const a = await scryptAsync(pw, salt, 32, true), b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Preis-Historie (data/preis-historie.json) — § 11 PAngV: Wer eine Preisermäßigung bekannt gibt (Streichpreis, „−15 %“),
// muss den niedrigsten Gesamtpreis der letzten 30 Tage vor Beginn der Ermäßigung als Bezugspreis nennen, und eine
// Prozentangabe muss sich auf diesen Bezugspreis beziehen (Art. 6a RL 98/6/EG, EuGH C-330/23). Dafür merkt sich der
// Server jeden preisrelevanten Stand als Momentaufnahme:
//   { at (ISO), pricing: { products: { vase: { single, discounts }, eierbecher: { single, untersetzer, discounts } }, gravur, farbschrift,
//     muster, volumen }, colors: [{ id, aufpreis }], aktionen: [{ id, name, prozent, start, ende, produkte, muster, mengenrabatt }]
//     (nur aktive Aktionen) }
// discounts (Mengenstaffel) und mengenrabatt braucht der Warenkorb für den Zeilen-Streichpreis ab 2 Stück (pricing.js tiefstZeile:
// niedrigster Preis genau dieser Menge in den 30 Tagen); Einträge von vor dieser Erweiterung haben sie nicht → dort kein
// Zeilen-Streichpreis ab 2 Stück.
// Eine Momentaufnahme gilt von at bis zum nächsten at; vor dem ersten Eintrag gelten dessen Werte. Neuer Eintrag beim Start
// (wenn anders als der letzte) und nach jedem Admin-Speichern, das Preise, Farbaufpreise oder Aktionen ändert. Der erste
// Eintrag übernimmt ALLE aktiven Aktionen, auch abgelaufene (und abgelaufene pausierte — ob sie liefen, weiß der Server
// nicht; im Zweifel zählt der niedrigere Preis), damit frühere Aktionen im 30-Tage-Fenster mitzählen.
// Aufbewahrt wird alles der letzten 90 Tage + der letzte Eintrag davor (und was die Fenster laufender Aktionen brauchen).
// Gerechnet wird nur im Client (pricing.js → referenzpreis(), eine Implementierung); /api/pricing liefert unter
// preisHistorie kompakt die Einträge, die die 30-Tage-Fenster der gerade laufenden Aktionen schneiden.
// Individuelle Gutscheine und Mengenrabatte sind keine Preisermäßigung im Sinne von § 11 — der Mengenrabatt zählt nur beim
// Zeilen-Streichpreis mit (der Vergleich muss dieselbe Menge zum damaligen Preis nehmen).
// ---------------------------------------------------------------------------
const HISTORIE_FILE = path.join(DATA, 'preis-historie.json');
const TAG_MS = 864e5;
const REF_TAGE = 30;        // § 11 PAngV: Bezugszeitraum vor Beginn der Ermäßigung
const HISTORIE_TAGE = 90;   // Aufbewahrung
let preisHistorie = [];     // Momentaufnahmen, nach at aufsteigend
// Unlesbare preis-historie.json beim Start: historieDefekt = Name der Sicherung (Admin-Hinweis); historieGesperrt = die Datei
// ließ sich gar nicht lesen (z. B. Rechte) — dann wird sie nicht überschrieben, bis das behoben ist und der Shop neu startet
let historieDefekt = null;
let historieGesperrt = false;
/** Preisrelevanter Stand jetzt (ohne at); erste = true: auch abgelaufene pausierte Aktionen mitnehmen (siehe oben) */
/** Mengenstaffel für die Momentaufnahme: nur gültige Stufen { qty, off }, nach Menge sortiert */
const staffelStand = (list) => (Array.isArray(list) ? list : [])
  .map((t) => ({ qty: Math.round(Number(t?.qty)), off: Number(t?.off) }))
  .filter((t) => t.qty >= 1 && t.off > 0 && t.off < 100)
  .sort((x, y) => x.qty - y.qty);
function preisStand(erste = false, now = Date.now()) {
  const pr = settings.pricing || {};
  return {
    pricing: {
      products: {
        vase: { single: euro(pr.vase?.single), discounts: staffelStand(pr.vase?.discounts) },
        eierbecher: { single: euro(pr.eierbecher?.single), untersetzer: euro(pr.eierbecher?.untersetzer), discounts: staffelStand(pr.eierbecher?.discounts) },
      },
      gravur: euro(pr.gravur),
      farbschrift: euro(pr.farbschrift),
      muster: sanitizeMuster(pr.muster),
      volumen: { prozent: Number(pr.volumen?.prozent) || 0, euro: Number(pr.volumen?.euro) || 0 },
    },
    // alle Farben (auch inaktive: priceItem rechnet ihren Aufpreis ebenfalls) — fehlt eine Farbe, zählt ihr Aufpreis als 0
    colors: (settings.colors || []).filter((c) => c && typeof c === 'object' && c.id).map((c) => ({ id: String(c.id), aufpreis: euro(c.aufpreis) })),
    aktionen: (settings.aktionen || []).filter((a) => a.aktiv || (erste && Date.parse(a.ende) <= now))
      .map((a) => ({ id: a.id, name: a.name, prozent: a.prozent, start: a.start, ende: a.ende, produkte: a.produkte, muster: Array.isArray(a.muster) ? a.muster : [], mengenrabatt: !!a.mengenrabatt })),
  };
}
const standKey = (e) => JSON.stringify({ pricing: e.pricing, colors: e.colors, aktionen: e.aktionen });
/**
 * preis-historie.json lesen (synchron, beim Start) — wie readWiderrufe(): fehlt die Datei, beginnt die Historie leer; ist sie
 * unlesbar (kaputtes JSON), wird sie als preis-historie.json.defekt-<Zeit> beiseitegelegt und im Log sowie im Admin gemeldet,
 * statt still mit einer neuen „ersten“ Momentaufnahme überschrieben zu werden (sonst wäre der 30-Tage-Nachweis weg).
 */
function loadPreisHistorie() {
  let text;
  try { text = readFileSync(HISTORIE_FILE, 'utf8'); } catch (err) {
    preisHistorie = [];
    if (err.code === 'ENOENT') return;
    historieGesperrt = true;
    console.error(`⚠️  preis-historie.json nicht lesbar (${err.code || err.message}) – sie wird nicht überschrieben; bitte Datei prüfen und den Shop neu starten`);
    return;
  }
  let raw;
  try {
    raw = JSON.parse(text);
    if (!Array.isArray(raw) && !Array.isArray(raw?.eintraege)) throw new Error('keine Liste');
  } catch (err) {
    const backup = `${HISTORIE_FILE}.defekt-${Date.now()}`;
    try {
      renameSync(HISTORIE_FILE, backup);
      historieDefekt = path.basename(backup);
      console.error(`⚠️  preis-historie.json unlesbar (${err.message}) – gesichert als ${historieDefekt}, neue Historie begonnen; Streichpreise laufender und kommender Aktionen (30-Tage-Bezugspreis) prüfen`);
    } catch (e2) {
      historieGesperrt = true;   // Sicherung nicht möglich → lieber gar nicht schreiben
      console.error(`⚠️  preis-historie.json unlesbar (${err.message}) und nicht zu sichern (${e2.message}) – sie wird nicht überschrieben`);
    }
    raw = [];
  }
  const list = Array.isArray(raw) ? raw : raw.eintraege;
  preisHistorie = list.filter((e) => e && typeof e === 'object' && Number.isFinite(Date.parse(e.at)) && e.pricing && typeof e.pricing === 'object')
    .map((e) => ({ at: new Date(Date.parse(e.at)).toISOString(), pricing: e.pricing, colors: Array.isArray(e.colors) ? e.colors : [], aktionen: Array.isArray(e.aktionen) ? e.aktionen : [] }))
    .sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  if (list.length > preisHistorie.length) console.warn(`⚠️  preis-historie.json: ${list.length - preisHistorie.length} ungültige Einträge übersprungen`);
}
/**
 * Alte Einträge entfernen: behalten wird alles ab (jetzt − 90 Tage) und der letzte Eintrag davor — reicht ein 30-Tage-Fenster
 * einer noch laufenden oder geplanten Aktion weiter zurück, gilt dessen Beginn als Grenze.
 */
function prunePreisHistorie(now = Date.now()) {
  let grenze = now - HISTORIE_TAGE * TAG_MS;
  for (const a of settings.aktionen || []) {
    if (a.aktiv && Date.parse(a.ende) > now) grenze = Math.min(grenze, Date.parse(a.start) - REF_TAGE * TAG_MS);
  }
  let i = preisHistorie.findIndex((e) => Date.parse(e.at) >= grenze);
  if (i === -1) i = preisHistorie.length;
  if (i > 1) preisHistorie = preisHistorie.slice(i - 1);
}
// Atomar und nacheinander wie saveSettings()
let historieWrite = Promise.resolve();
/** Momentaufnahme anhängen, wenn sich der preisrelevante Stand geändert hat (Start, Admin-Speichern) — sonst nichts */
function notePreisHistorie() {
  if (historieGesperrt) return historieWrite;   // unlesbare Datei nicht überschreiben (siehe loadPreisHistorie)
  const now = Date.now();
  const stand = preisStand(!preisHistorie.length, now);
  const last = preisHistorie[preisHistorie.length - 1];
  if (last && standKey(last) === standKey(stand)) return historieWrite;
  const at = new Date(Math.max(now, last ? Date.parse(last.at) + 1 : 0)).toISOString();
  preisHistorie.push({ at, ...stand });
  prunePreisHistorie(now);
  // eine Zeile je Momentaufnahme — kompakt und trotzdem mit dem Auge lesbar
  const json = `{"version":1,"eintraege":[\n${preisHistorie.map((e) => JSON.stringify(e)).join(',\n')}\n]}\n`;
  historieWrite = historieWrite.catch(() => {}).then(() => writeFileAtomic(HISTORIE_FILE, json));
  return historieWrite;
}
/**
 * Kompakte Historie für /api/pricing: nur die Einträge, die die Fenster [start − 30 Tage, start) der gerade laufenden
 * Aktionen schneiden (der letzte Eintrag vor dem frühesten Fensterbeginn gilt dort noch; liegt keiner davor, der erste),
 * Muster- und Farbaufpreise nur > 0 (Farben als { id: aufpreis }), Aktionen nur, wenn ihr Zeitraum die Fenster berührt.
 */
function preisHistorieFuer(laufende) {
  if (!laufende.length || !preisHistorie.length) return [];
  const starts = laufende.map((a) => Date.parse(a.start));
  const von = Math.min(...starts) - REF_TAGE * TAG_MS, bis = Math.max(...starts);
  let i0 = 0;
  preisHistorie.forEach((e, i) => { if (Date.parse(e.at) <= von) i0 = i; });
  const out = [];
  for (let i = i0; i < preisHistorie.length; i++) {
    const e = preisHistorie[i];
    if (i > i0 && Date.parse(e.at) >= bis) break;
    const pr = e.pricing || {};
    out.push({
      at: e.at,
      pricing: {
        products: pr.products, gravur: pr.gravur, farbschrift: pr.farbschrift, volumen: pr.volumen,
        muster: Object.fromEntries(Object.entries(pr.muster || {}).filter(([, v]) => v > 0)),
      },
      colors: Object.fromEntries((e.colors || []).filter((c) => c.aufpreis > 0).map((c) => [c.id, c.aufpreis])),
      aktionen: (e.aktionen || []).filter((a) => Date.parse(a.start) < bis && Date.parse(a.ende) > von)
        .map(({ id, prozent, start, ende, produkte, muster, mengenrabatt }) => ({ id, prozent, start, ende, produkte, muster, mengenrabatt })),
    });
  }
  return out;
}
/** Alle Aktionen aus der Historie (je id + Zeitraum einmal, neuester Stand) — der Admin warnt damit auch vor gelöschten Vor-Aktionen */
function historieAktionen() {
  const map = new Map();
  for (const e of preisHistorie) for (const a of e.aktionen || []) map.set(`${a.id}|${a.start}|${a.ende}`, a);
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Kundenkonten (data/users.json) & Sessions (data/sessions.json)
// ---------------------------------------------------------------------------
const USERS_FILE = path.join(DATA, 'users.json');
const SESS_FILE = path.join(DATA, 'sessions.json');
let users = [];
let sessions = {};
function loadUsers() {
  // users.json kaputt → Startabbruch (ladeDatei); sessions.json kaputt → beiseitelegen, alle müssen sich neu anmelden
  users = ladeDatei(USERS_FILE, { pruefe: (v) => { if (!Array.isArray(nurObjekt(v).users)) throw new Error('Liste „users“ fehlt'); return v.users; } }) || [];
  sessions = ladeDatei(SESS_FILE, { pruefe: nurObjekt, beiseite: true }) || {};
  // alte Sessions (> 90 Tage) aufräumen
  const cutoff = Date.now() - SESSION_TTL;
  for (const [t, s] of Object.entries(sessions)) if (s.createdAt < cutoff) delete sessions[t];
}
const SESSION_TTL = 90 * 864e5;   // Anmeldung gilt 90 Tage — danach wird sie beim nächsten Zugriff bzw. Serverstart entfernt
const saveUsers = speicherKette(USERS_FILE, () => JSON.stringify({ users }, null, 2));

// ---------------------------------------------------------------------------
// Design-Codes (data/designs.json): kurzer Code ⇄ komplette Konfiguration.
// Der Code ist ein Hash der kanonischen Konfiguration → gleiches Design = gleicher Code.
// ---------------------------------------------------------------------------
const DESIGNS_FILE = path.join(DATA, 'designs.json');
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // ohne I/L/O/0/1 (verwechselbar)
const DESIGN_KEYS = ['product', 'preset', 'height', 'width', 'pattern', 'ribs', 'depth', 'twist', 'flow', 'flowWaves',
  'text', 'textSize', 'textPos', 'font', 'textStyle', 'textColor', 'saucer', 'customPoints', 'color', 'rim'];
let designs = {};
function loadDesigns() {
  designs = ladeDatei(DESIGNS_FILE, { pruefe: nurObjekt }) || {};
}
const saveDesigns = speicherKette(DESIGNS_FILE, () => JSON.stringify(designs));
// Abrufzähler (loads/lastLoad) gebündelt schreiben: ein Code-Abruf merkt sich nur die Änderung, gespeichert wird höchstens
// einmal je DESIGN_ZAEHLER_MS (vorher schrieb jeder Abruf die ganze designs.json neu). Beim Beenden kann ein Rest fehlen — egal.
const DESIGN_ZAEHLER_MS = 60_000;
let designZaehlerOffen = false;
setInterval(() => {
  if (!designZaehlerOffen) return;
  designZaehlerOffen = false;
  saveDesigns().catch(speicherFehler('designs.json (Abrufzähler)'));
}, DESIGN_ZAEHLER_MS).unref();
function canonicalDesign(cfg) {
  const out = {};
  for (const k of DESIGN_KEYS) {
    let v = cfg?.[k];
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (k === 'rim' && v === 'glatt') continue;   // Standardrand → nicht Teil des Codes (bestehende Codes bleiben gültig)
    if (typeof v === 'number') v = Math.round(v * 1000) / 1000;
    if (k === 'customPoints') {
      if (!Array.isArray(v)) continue;
      v = v.slice(0, 40).map((pt) => [Math.round((pt[0] ?? pt.t ?? 0) * 1000) / 1000, Math.round((pt[1] ?? pt.r ?? 0) * 1000) / 1000]);
    } else if (typeof v === 'string') v = v.slice(0, 40);
    else if (typeof v !== 'number' && typeof v !== 'boolean') continue;
    out[k] = v;
  }
  return out;
}
function designCode(cfg) {
  const canon = canonicalDesign(cfg);
  const json = JSON.stringify(canon);
  const digest = crypto.createHash('sha256').update(json).digest();
  const chars = [...digest].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  // 6 Zeichen; bei Kollision mit einem ANDEREN Design verlängern
  for (let len = 6; len <= chars.length; len++) {
    const code = chars.slice(0, len);
    const ex = designs[code];
    if (!ex || JSON.stringify(ex.config) === json) return { code, canon, isNew: !ex };
  }
  return { code: chars, canon, isNew: !designs[chars] };
}
const normalizeCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^OVJU/, '');

// Vorschaubilder zu Design-Codes (data/thumbs/CODE.jpg, ≤ 80 KB, vom Client gerendert)
const THUMBS = path.join(DATA, 'thumbs');

// ---------------------------------------------------------------------------
// Design-Listen (data/lists.json): Sammlungen von Design-Codes, z. B. für eine
// Hochzeit. Besitzer bearbeiten per Token, alle anderen lesen per Code/Link.
// ---------------------------------------------------------------------------
const LISTS_FILE = path.join(DATA, 'lists.json');
let lists = {};
function loadLists() { lists = ladeDatei(LISTS_FILE, { pruefe: nurObjekt }) || {}; }
const saveLists = speicherKette(LISTS_FILE, () => JSON.stringify(lists));
function newListCode() {
  for (;;) {
    let c = 'L';
    for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!lists[c]) return c;
  }
}
const LIST_OCCASIONS = ['hochzeit', 'geburtstag', 'taufe', 'weihnachten', 'firma', 'sonstiges'];
function cleanListItems(items) {
  const out = [];
  for (const it of Array.isArray(items) ? items.slice(0, 60) : []) {
    const code = normalizeCode(it?.code);
    if (!designs[code]) continue;
    const qty = Math.max(1, Math.min(50, Math.round(+it.qty || 1)));
    const ex = out.find((o) => o.code === code);
    if (ex) ex.qty = Math.min(50, ex.qty + qty); else out.push({ code, qty });
  }
  return out;
}
function publicList(l) {
  return {
    code: l.code, name: l.name, occasion: l.occasion, note: l.note || '',
    createdAt: l.createdAt, updatedAt: l.updatedAt,
    items: l.items.map((it) => ({ ...it, config: designs[it.code]?.config || null })).filter((it) => it.config),
  };
}

const saveSessions = speicherKette(SESS_FILE, () => JSON.stringify(sessions));
// Kundenpasswörter: scrypt (64 Bytes, Salz je Konto), asynchron. Neue Passwörter: Text mit 8–200 Zeichen (bestehende kürzere
// gelten weiter). Bei unbekannter Adresse rechnet die Anmeldung einen Schein-Hash — die Antwortzeit verrät nicht, ob es das Konto gibt.
const hashPw = async (pw, salt, pruefung = false) => (await scryptAsync(pw, salt, 64, pruefung)).toString('hex');
const PW_MIN = 8, PW_MAX = 200;
const pwRegel = (pw) => (typeof pw === 'string' && pw.length >= PW_MIN && pw.length <= PW_MAX ? null : `Passwort: ${PW_MIN} bis ${PW_MAX} Zeichen`);
const SCHEIN_SALZ = crypto.randomBytes(16).toString('hex');
async function passwortStimmt(u, pw) {
  const text = typeof pw === 'string' && pw.length <= 1024 ? pw : '';
  const h = await hashPw(text, u?.salt || SCHEIN_SALZ, true);
  if (!u || !text || !/^[0-9a-f]{128}$/.test(String(u.hash || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), Buffer.from(h, 'hex'));
}
const SESSIONS_JE_KONTO = 20;   // gleichzeitige Anmeldungen je Konto — darüber fallen die ältesten weg
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { userId, createdAt: Date.now() };
  const eigene = Object.entries(sessions).filter(([, x]) => x.userId === userId).sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (const [t] of eigene.slice(0, Math.max(0, eigene.length - SESSIONS_JE_KONTO))) delete sessions[t];
  saveSessions().catch(speicherFehler('sessions.json'));
  return token;
}
/** Alle Anmeldungen eines Kontos beenden — außer der Kennung ausser (z. B. die eigene beim Passwortwechsel); → Anzahl */
function sitzungenBeenden(userId, ausser = null) {
  let n = 0;
  for (const [t, x] of Object.entries(sessions)) if (x.userId === userId && t !== ausser) { delete sessions[t]; n++; }
  return n;
}
function userFromReq(req) {
  const t = String(req.headers['x-auth'] || '');
  const s = t && Object.hasOwn(sessions, t) ? sessions[t] : null;
  if (!s) return null;
  // Abgelaufene Anmeldung (> 90 Tage) auch im laufenden Betrieb entfernen (so steht es in der Datenschutzerklärung)
  if (!(s.createdAt >= Date.now() - SESSION_TTL)) {
    delete sessions[t];
    saveSessions().catch(() => {});
    return null;
  }
  return users.find((u) => u.id === s.userId) || null;
}
// emailVerified: Adresse per Link bestätigt (user.emailVerifiedAt) — erst dann zeigt das Konto Gastbestellungen mit dieser Adresse
const publicUser = (u) => ({ name: u.name, email: u.email, address: u.address || null, emailVerified: !!u.emailVerifiedAt });
/**
 * Kontoname für Mails an die Kontoadresse (Willkommen, Passwort vergessen/geändert, Bestätigungslink: Anrede, Betreff, Empfängername):
 * nur, wenn er wie ein Name aussieht — bis 6 Wörter aus Buchstaben, Bindestrich, Apostroph, höchstens ein Punkt am Ende („Dr.“).
 * Sonst leer (→ „Hallo!“): Wer ein Konto mit fremder Adresse anlegt, darf darüber keinen eigenen Text (Links, Domains) verschicken.
 */
function kontoMailName(name) {
  const s = String(name || '').trim().replace(/ {2,}/g, ' ');
  const woerter = s.split(' ');
  return s.length <= 80 && woerter.length <= 6 && woerter.every((w) => /^\p{L}[\p{L}\p{M}'’-]*\.?$/u.test(w)) ? s : '';
}

// --- Passwort vergessen: Token nur als SHA-256-Hash im Konto, 60 Minuten gültig. user.reset = [{ hash, exp }, …] — die letzten
//   RESET_LINKS verschickten Links gelten (eine verspätete Mail oder ein Dritter, der neue Links anfordert, entwertet keinen gerade
//   angekommenen); ein erfolgreicher Reset entwertet alle. Ältere Konten haben noch ein einzelnes Objekt { hash, exp }.
const RESET_TTL = 60 * 60 * 1000;
const RESET_LINKS = 3;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
/** Konto zu einem Mail-Token (field 'reset' = Passwort vergessen, 'verify' = E-Mail bestätigen) — nur gültige, nicht abgelaufene */
function userByToken(token, field) {
  const t = String(token || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
  const h = Buffer.from(sha256(t), 'hex');
  const now = Date.now();
  let found = null;
  for (const u of users) {   // alle Konten durchgehen (kein Abbruch → keine Zeitmessung möglich)
    for (const r of [].concat(u[field] || [])) {
      if (!r || !/^[0-9a-f]{64}$/.test(String(r.hash || ''))) continue;
      if (crypto.timingSafeEqual(h, Buffer.from(r.hash, 'hex')) && Number(r.exp) > now) found = u;
    }
  }
  return found;
}
const userByResetToken = (token) => userByToken(token, 'reset');

/**
 * Kundenkonto löschen (Kundin selbst oder Admin): Konto und alle Anmeldungen weg. Bestellungen bleiben wegen der
 * Aufbewahrungspflicht (Rechnungen, § 147 AO) erhalten, verlieren aber den Kontobezug (userId → null, Vermerk in der Historie).
 * → Zahl der Bestellungen, die zum Konto gehörten
 */
async function kontoLoeschen(u, wer) {
  const i = users.indexOf(u);
  if (i >= 0) users.splice(i, 1);
  sitzungenBeenden(u.id);
  await saveUsers();
  await saveSessions();
  let n = 0;
  for (const o of await listOrders()) {
    if (o.userId !== u.id) continue;
    const release = await lockOrder(o.orderId);
    try {
      const x = await readOrder(o.orderId);
      if (x.userId === u.id) {
        x.userId = null;
        addHistory(x, x.status, 'Kundenkonto gelöscht – die Bestellung bleibt (Aufbewahrungspflicht), ohne Kontobezug', 'system');
        await writeOrder(x);
        n++;
      }
    } catch (err) { console.error(`Konto ${u.id}: Bestellung ${o.orderId} nicht gelöst:`, err?.message || err); }
    finally { release(); }
  }
  console.log(`🗑️  Kundenkonto ${u.id} gelöscht (${wer}) – ${n} Bestellung(en) ohne Kontobezug`);
  return n;
}
/** Datenauskunft zu einem Kundenkonto (Admin, Art. 15 DSGVO): Konto ohne Passwort-Hash, Anmeldungen, Bestellungen, Widerrufe und
 *  Einträge im Mail-Protokoll an diese Adresse. Was nur über die E-Mail-Adresse zugeordnet ist (Gastbestellungen, Widerrufe, Mails dazu),
 *  gehört nur bei bestätigter Adresse dazu — wie im Konto; sonst könnte es jemand anderem gehören, der die Adresse wirklich hat. */
async function kontoExport(u) {
  const { salt, hash, reset, verify, ...konto } = u;
  const bestaetigt = !!u.emailVerifiedAt;
  const bestellungen = (await listOrders())
    .filter((o) => o.userId === u.id || (bestaetigt && String(o.customer?.email || '').trim().toLowerCase() === u.email)).map(ohneSchluessel);
  const eigene = new Set([u.id, ...bestellungen.map((o) => o.orderId)]);
  const widerrufe = await withWiderrufe((l) => ({ result: l.filter((w) => w.email === u.email && (bestaetigt || eigene.has(w.orderId))) })).catch(() => []);
  for (const w of widerrufe) eigene.add(w.ref);
  let mails = [];
  try {
    mails = (await mailer.list({ limit: 100000 })).filter((m) => String(m.to || '').toLowerCase().split(/,\s*/).includes(u.email) && (bestaetigt || eigene.has(m.ref)))
      .map(({ createdAt, sentAt, subject, kind, status }) => ({ createdAt, sentAt, subject, kind, status }));
  } catch { /* Protokoll nicht lesbar → ohne Mails */ }
  return {
    exportiertAm: new Date().toISOString(), anbieter: settings.company?.name || BRAND,
    konto: { ...konto, emailBestaetigt: !!u.emailVerifiedAt },
    anmeldungen: Object.values(sessions).filter((x) => x.userId === u.id).map((x) => ({ seit: new Date(x.createdAt).toISOString() })),
    bestellungen, widerrufe, mails,
  };
}

// --- E-Mail-Adresse bestätigen (Double-Opt-in): bei der Registrierung wird die Adresse nicht geprüft — wer sie nur eintippt,
//   darf keine fremden Gastbestellungen (Status, Sendungsnummer, Guthaben-Code, Altbestand-Rechnungen) sehen. Der Link aus der
//   Willkommensmail (bzw. „Link erneut senden“ im Konto) setzt user.emailVerifiedAt — aber nur zusammen mit der Anmeldung
//   in genau diesem Konto: Klickt die echte Inhaberin der Adresse den Link aus einer Mail, die jemand anderes mit ihrer
//   Adresse ausgelöst hat, bestätigt sie damit nicht das fremde Konto. Token als SHA-256-Hash (user.verify = { hash, exp }).
//   Ein Passwort-Reset über die Mail bestätigt die Adresse ebenfalls (er beweist den Zugriff aufs Postfach und löst alle
//   anderen Sitzungen). Bestehende Konten beginnen unbestätigt.
const VERIFY_TTL = VERIFY_TAGE * 864e5;
function newVerifyToken(u) {
  const token = crypto.randomBytes(24).toString('base64url');
  u.verify = { hash: sha256(token), exp: Date.now() + VERIFY_TTL };
  return token;
}
const verifyLinkFor = (token) => `${baseUrlFor(settings)}/?verify=${token}`;
// Bremsen (im Speicher): forgotLimited(key, max, fenster) zählt einen Versuch und meldet true, wenn schon max im Zeitfenster liegen;
// rateLimitReached(key, max, fenster) sieht nur nach (für Sperren, die nur Fehlgriffe zählen). Schlüssel je IP nutzen clientIp(),
// das IPv6 auf das /64-Netz kürzt. Jeder Schlüssel merkt sich sein Zeitfenster (Tagesgrenzen überleben das Aufräumen von
// 15-Minuten-Schlüsseln). Ein Neustart setzt alle Zähler zurück (bewusst: kein Angreifer kann den Shop neu starten).
// Speicher gegen Verdrängen geschützt: Jede Bremse (Art = Teil vor dem ersten „:“, z. B. login, login-ip, admin-fehl, wartung)
// hat einen eigenen Speicher mit eigener Obergrenze (BREMSE_MAX_JE_ART). Ein Schlüssel mit Treffern im Zeitfenster wird nie
// verdrängt — ist der Speicher einer Art voll, räumt sie abgelaufene Schlüssel weg; bleibt er voll, gilt der neue Schlüssel als
// gebremst (lieber eine neue Adresse kurz bremsen, als laufende Sperren zurückzusetzen). Schlüssel entstehen erst beim Zählen
// (rateLimitReached legt keine an), leere Schlüssel (bremseFrei nach einem richtigen Passwort) verschwinden sofort. Zusammengesetzte
// Schlüssel mit frei wählbarem Teil (login:<ip>|<mail>, mail:<mail>, register-mail:<mail> …) belegt ein Aufruf erst, wenn die
// Bremse je IP frei ist — eine IP legt so höchstens so viele an, wie ihre IP-Bremse Versuche zulässt.
// „Passwort vergessen“: 3 je E-Mail und 10 je IP in 15 Minuten (je IP großzügiger, damit ein Proxy ohne X-Forwarded-For nicht alle
// Kunden gemeinsam sperrt).
const FORGOT_IP_MAX = 10;
const BREMSE_MAX_JE_ART = 20000;
const STUNDE_MS = 3600e3;
const bremsen = new Map();   // Art → Map(Schlüssel → { win: Zeitfenster ms, hits: [Zeitpunkte] })
const bremseArt = (key) => { const s = String(key); const i = s.indexOf(':'); return i < 0 ? s : s.slice(0, i); };
const bremseAufgeraeumt = new Map();   // Art → Zeitpunkt des letzten Aufräumens (höchstens alle 10 s, wenn sie voll ist)
/** abgelaufene Schlüssel (kein Treffer mehr im eigenen Fenster) einer Art entfernen */
function bremseAufraeumen(art, m, now = Date.now()) {
  bremseAufgeraeumt.set(art, now);
  for (const [k, v] of m) if (!v.hits.some((t) => now - t < v.win)) m.delete(k);
  if (!m.size) bremsen.delete(art);
}
function forgotLimited(key, max = 3, windowMs = 15 * 60 * 1000) {
  const now = Date.now(), art = bremseArt(key);
  let m = bremsen.get(art);
  const alt = m?.get(key);
  if (!alt) {
    // neuer Schlüssel: nur wenn Platz ist — laufende Zähler (auch anderer IPs und anderer Bremsen) werden nie verdrängt
    if (m && m.size >= BREMSE_MAX_JE_ART) {
      if (now - (bremseAufgeraeumt.get(art) || 0) > 10_000) bremseAufraeumen(art, m, now);
      m = bremsen.get(art);
      if (m && m.size >= BREMSE_MAX_JE_ART) {
        if (!forgotLimited.gemeldet?.has(art)) { (forgotLimited.gemeldet ||= new Set()).add(art); console.warn(`⚠️  Bremse „${art}“: Speicher voll (${BREMSE_MAX_JE_ART} laufende Zähler) – neue Adressen werden gebremst, bis Zähler ablaufen`); }
        return true;
      }
    }
    if (!m) { m = new Map(); bremsen.set(art, m); }
    if (max <= 0) return true;
    m.set(key, { win: windowMs, hits: [now] });
    return false;
  }
  const hits = alt.hits.filter((t) => now - t < Math.max(windowMs, alt.win));
  alt.win = Math.max(windowMs, alt.win);
  alt.hits = hits;
  if (hits.filter((t) => now - t < windowMs).length >= max) return true;
  hits.push(now);
  return false;
}
/** Nur nachsehen (ohne zu zählen, legt keinen Schlüssel an): ist das Limit für key im Zeitfenster erreicht? */
function rateLimitReached(key, max, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  return (bremsen.get(bremseArt(key))?.get(key)?.hits || []).filter((t) => now - t < windowMs).length >= max;
}
/**
 * Fehlversuch vorab belegen (Passwortprüfungen): zählt sofort, noch bevor die Prüfung (scrypt) fertig ist — sonst kämen parallel
 * abgeschickte Rateversuche alle an der Bremse vorbei, weil keiner fertig ist, wenn der nächste nachsieht. → Zeitpunkt des Eintrags
 * (für bremseFrei, wenn das Passwort stimmt) oder 0, wenn die Grenze schon erreicht ist (dann wird nichts belegt).
 */
function bremsePlatz(key, max, windowMs = 15 * 60 * 1000) {
  return forgotLimited(key, max, windowMs) ? 0 : (bremsen.get(bremseArt(key))?.get(key)?.hits.at(-1) || 0);
}
/** Belegten Platz zurückgeben (richtiges Passwort) — ein dadurch leerer Schlüssel verschwindet ganz */
function bremseFrei(key, t) {
  const art = bremseArt(key), m = bremsen.get(art), e = m?.get(key);
  const i = t && e ? e.hits.lastIndexOf(t) : -1;
  if (i >= 0) e.hits.splice(i, 1);
  if (e && !e.hits.length) { m.delete(key); if (!m.size) bremsen.delete(art); }
}
// Alle 10 Minuten abgelaufene Schlüssel aller Bremsen entfernen (hält den Speicher klein, ohne laufende Zähler anzufassen)
setInterval(() => { const now = Date.now(); for (const [art, m] of bremsen) bremseAufraeumen(art, m, now); }, 10 * 60e3).unref();
/**
 * Anmeldeversuch (Login, Passwort ändern, Konto löschen) in beiden Bremsen belegen — je IP und je IP + Konto → { frei() } oder null.
 * Erst die Bremse je IP (fester Schlüssel): Ist sie erreicht, entsteht für die frei wählbare Adresse gar kein Schlüssel — eine IP
 * legt so höchstens LOGIN_FEHL_IP Konto-Schlüssel je 15 Minuten an und kann keine fremden Zähler aus dem Speicher drängen.
 */
function anmeldePlatz(ip, mail) {
  const kk = `login:${ip}|${mail}`, ki = `login-ip:${ip}`;
  if (rateLimitReached(ki, LOGIN_FEHL_IP) || rateLimitReached(kk, LOGIN_FEHL_KONTO)) return null;
  const b = bremsePlatz(ki, LOGIN_FEHL_IP);
  if (!b) return null;
  const a = bremsePlatz(kk, LOGIN_FEHL_KONTO);
  if (!a) { bremseFrei(ki, b); return null; }
  return { frei: () => { bremseFrei(kk, a); bremseFrei(ki, b); } };
}
/**
 * Adresse für Bremsen: IPv4 (auch IPv4-mapped ::ffff:a.b.c.d) unverändert, IPv6 auf das /64-Netz gekürzt („2001:db8:1:2::/64“) —
 * ein gewöhnlicher Anschluss hat ein ganzes /64, sonst zählte jede seiner Adressen einzeln.
 */
function ipNetz(raw) {
  let ip = String(raw || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  if (!ip.includes(':') || !/^[0-9a-f:.]+$/.test(ip)) return ip;
  ip = ip.replace(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/, (_, a, b, c, d) => `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`);
  const teile = ip.split('::');
  if (teile.length > 2) return ip;
  const links = teile[0] ? teile[0].split(':') : [], rechts = teile[1] ? teile[1].split(':') : [];
  const gruppen = teile.length === 2 ? [...links, ...Array(Math.max(0, 8 - links.length - rechts.length)).fill('0'), ...rechts] : links;
  if (gruppen.length !== 8) return ip;
  return `${gruppen.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}
// X-Forwarded-For ist clientgesteuert — nur hinter eigenem Reverse-Proxy auswerten (TRUST_PROXY=1 = ein Proxy,
// der seinen Wert hinten anhängt); ohne Proxy zählt die Socket-Adresse. Ergebnis ist der Bremsen-Schlüssel (ipNetz).
const TRUST_PROXY = Math.max(0, parseInt(process.env.TRUST_PROXY || '0', 10) || 0);
function clientIp(req) {
  const ip = req.socket?.remoteAddress || '';
  if (!TRUST_PROXY) return ipNetz(ip);
  const list = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return ipNetz(list[list.length - TRUST_PROXY] || ip);
}
// Weitere Bremsen (Richtwerte; über der Grenze 429 mit Meldung, außer beim Widerruf — siehe dort)
const LOGIN_FEHL_KONTO = 10;    // falsche Passwörter je IP + Konto in 15 Minuten (kein Sperren des Kontos selbst: Fremde können
const LOGIN_FEHL_IP = 30;       //   den Inhaber nicht aussperren) — und je IP über alle Konten
const PW_WECHSEL_MAX = 5;       // Passwortwechsel je Konto und Stunde (jeder schickt eine Hinweis-Mail — die ist zusätzlich gedeckelt)
const REG_IP_MAX = 5;           // Registrierungen je IP und Stunde
const REG_MAIL_MAX = 3;         // Konten (= Willkommensmails) je Empfängeradresse und Tag
const REG_ALLE_MAX = 30;        // Registrierungen insgesamt je Stunde
const WIDERRUF_MAIL_MAX = 3;    // Eingangsbestätigungen je Empfänger und Tag
const WIDERRUF_ALLE_MAX = 30;   // Eingangsbestätigungen insgesamt je Stunde (beides nur für nicht zugeordnete Widerrufe)
const WIDERRUF_BESTELLUNG_MAX = 5;   // Eingangsbestätigungen zugeordneter Widerrufe je Bestellung und Tag
const KASSE_IP_MAX = 20;        // neue Kassen (Bestellungen, PayPal-Zahlungen) je IP und Stunde
const DESIGN_IP_MAX = 300;      // neue Design-Codes je IP und Stunde — der Konfigurator speichert bei jeder Code-Anzeige, normaler
const DESIGN_ALLE_MAX = 5000;   //   Gebrauch bleibt weit darunter; insgesamt je Stunde
const THUMB_IP_MAX = 600;       // Vorschaubilder je IP und Stunde
const LISTE_IP_MAX = 30;        // neue Listen je IP und Stunde
const LISTE_AENDERN_IP_MAX = 600;   // Listen ändern/löschen je IP und Stunde
const UPLOAD_IP_BYTES = 4e9;    // Modelldateien je IP und Stunde (Bytes) — 20 Positionen der größten Konfiguration ≈ 2,5 GB
const LOGIN_GEBREMST = { ok: false, error: 'Zu viele Fehlversuche – bitte in 15 Minuten noch einmal versuchen oder „Passwort vergessen?“ nutzen.' };
const GEBREMST = (wann = 'in einer Stunde') => ({ ok: false, error: `Zu viele Anfragen von deinem Anschluss – bitte ${wann} noch einmal versuchen.` });

// ---------------------------------------------------------------------------
// Wartungsmodus (settings.wartung): vor dem ganzen Shop steht eine Seite mit Zugangskennwort. Wer es kennt, bekommt ein
// Cookie (30 Tage) und sieht den Shop normal — so lässt sich die Seite vor dem Start ansehen und testen.
// Kennwort nur als scrypt-Hash; das Cookie trägt sein Ablaufdatum und einen HMAC über Hash + Ablauf → es gilt höchstens
// 30 Tage, ein neues Kennwort macht alle Freigaben ungültig.
// Frei bleiben die Wartungsseite selbst, ihre Schriften/Logos, das Favicon und sw.js (damit der Service Worker aktualisieren
// kann) — und alles, was Besucher und Bestandskunden auch in der Wartung brauchen: Rechtsseiten samt Widerrufsfunktion
// (POST /api/widerruf, § 356a BGB), Beleg-Abrufe aus Mails und Konto (/orders/<ID>/rechnung|gutschrift|storno.html|pdf —
// der Schlüssel wird wie sonst im Handler geprüft) und /robots.txt („Disallow: /“). Sonst bekommen API-Aufrufe 503.
// Pfade mit kodiertem Schrägstrich, Backslash oder ..-Segment lehnt das Tor mit 400 ab (sonst hinter /fonts/ jede Datei).
// Ein- und ausschalten: Admin → System, oder auf dem Server  node tools/wartung.mjs an <kennwort> | aus | status
// ---------------------------------------------------------------------------
const WARTUNG_COOKIE = 'fs_zugang';
const WARTUNG_TAGE = 30;
// Manifest und App-Icons holt der Browser ohne Cookies (anonymous) → müssen frei sein, sonst 503 nach dem Freischalten
const WARTUNG_FREI = new Set(['/__wartung', '/favicon.ico', '/sw.js', '/manifest.webmanifest']);
const WARTUNG_FREI_PREFIX = ['/img/brand/', '/img/icons/', '/fonts/'];
const WARTUNG_FREI_BELEG = /^\/orders\/[^/]+\/(rechnung|gutschrift|storno)\.(html|pdf)$/;
/** Ohne Freigabe erreichbar? (Rechtsseiten mit und ohne / am Ende — LEGAL_ROUTES steht unten bei den Rechtsseiten) */
function wartungFrei(req, p) {
  if (WARTUNG_FREI.has(p) || WARTUNG_FREI_PREFIX.some((x) => p.startsWith(x)) || p === '/robots.txt') return true;
  if (req.method === 'POST') return p === '/api/widerruf';
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const m = p.match(/^\/([a-z]+)\/?$/);
  return !!(m && LEGAL_ROUTES.includes(m[1])) || WARTUNG_FREI_BELEG.test(p);
}
/** Pfad taugt für die Freigabe-Prüfung: keine kodierten Schrägstriche, kein Backslash/NUL, bereits normalisiert (kein .., //, /./) */
const wartungPfadOk = (url, p) => !/%2f|%5c/i.test(url.pathname) && !/[\\\0]/.test(p) && path.posix.normalize(p) === p;
const wartungAktiv = () => !!(settings.wartung?.aktiv && settings.wartung?.hash && settings.wartung?.secret);
/** Signatur des Freigabe-Cookies: HMAC über Kennwort-Hash und Ablauf (Sekunden seit 1970) */
const wartungSig = (exp) => crypto.createHmac('sha256', settings.wartung.secret).update(`zugang|${settings.wartung.hash}|${exp}`).digest('base64url');
/** Cookie-Wert „<Ablauf>.<Signatur>“ — Cookies im alten Format (nur HMAC, ohne Ablauf) gelten nicht mehr */
const wartungToken = () => { const exp = Math.floor(Date.now() / 1000) + WARTUNG_TAGE * 86400; return `${exp}.${wartungSig(exp)}`; };
function cookieWert(req, name) {
  for (const teil of String(req.headers.cookie || '').split(';')) {
    const i = teil.indexOf('=');
    if (i > 0 && teil.slice(0, i).trim() === name) { try { return decodeURIComponent(teil.slice(i + 1).trim()); } catch { return ''; } }
  }
  return '';
}
function wartungFreigegeben(req) {
  const m = /^(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(cookieWert(req, WARTUNG_COOKIE));
  if (!m || Number(m[1]) * 1000 <= Date.now()) return false;
  const c = Buffer.from(m[2]), t = Buffer.from(wartungSig(m[1]));
  return c.length === t.length && crypto.timingSafeEqual(c, t);
}
/** Kennwort → 'scrypt$salt$hash' (auch tools/wartung.mjs nutzt dieses Format) */
function wartungHash(kennwort) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(kennwort), salt, 32).toString('hex')}`;
}
function wartungKennwortStimmt(kennwort) {
  const [art, salt, hex] = String(settings.wartung?.hash || '').split('$');
  if (art !== 'scrypt' || !salt || !hex) return false;
  const a = crypto.scryptSync(String(kennwort), salt, 32), b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// HTTPS direkt oder hinter dem eigenen Reverse-Proxy (TRUST_PROXY) → Cookie mit Secure
const istHttps = (req) => !!req.socket?.encrypted || (TRUST_PROXY > 0 && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https');
const wartungCookie = (req) => `${WARTUNG_COOKIE}=${wartungToken()}; Path=/; Max-Age=${WARTUNG_TAGE * 86400}; HttpOnly; SameSite=Lax${istHttps(req) ? '; Secure' : ''}`;
// Ziel nach dem Freischalten: nur Pfade dieser Seite — kein //host, kein Schema, keine Steuer- oder Leerzeichen (Browser
// entfernen Tabs: aus „/<Tab>/evil.example“ würde „//evil.example“); aufgelöst gegen eine feste Basis bleibt der Host gleich.
// Das Ergebnis wird noch einmal geprüft: Punktsegmente ergeben nach dem Auflösen sonst wieder „//host“ („/.//evil.example“).
const ZIEL_PFAD = /^\/(?![/\\])[\x21-\x7e]*$/;
function wartungZiel(z) {
  if (typeof z !== 'string' || z.length >= 500 || !ZIEL_PFAD.test(z)) return '/';
  let u;
  try { u = new URL(z, 'http://formsam.invalid'); } catch { return '/'; }
  if (u.origin !== 'http://formsam.invalid') return '/';
  const ziel = u.pathname + u.search;
  return ZIEL_PFAD.test(ziel) && !ziel.startsWith('/__wartung') ? ziel : '/';
}
// Sperre nach 10 Fehlversuchen je IP in 15 Minuten: danach prüft das Tor ein Kennwort dieser IP nur noch nach einer Pause,
// die mit jeder Prüfung wächst (30 s, 60 s, 120 s … höchstens 5 Minuten; vergessen nach einer Stunde Ruhe oder beim richtigen
// Kennwort). Raten bleibt so etwa so langsam wie mit fester Sperre, wer das richtige Kennwort hat (z. B. hinter derselben
// Adresse wie ein Rater), kommt nach kurzer Wartezeit trotzdem hinein. WARTUNG_BREMSE_S ändert die Grundpause (nur für Prüfskripte).
const WARTUNG_BREMSE_MS = (Math.max(1, parseInt(process.env.WARTUNG_BREMSE_S || '30', 10) || 30)) * 1000;
const WARTUNG_BREMSE_MAX_MS = 10 * WARTUNG_BREMSE_MS;   // 5 Minuten
const WARTUNG_BREMSE_RUHE_MS = 60 * 60 * 1000;
const wartungGeprueft = new Map();   // Schlüssel wartung:<IP> → { t: letzte Prüfung während der Sperre, n: Zahl dieser Prüfungen }
/** Pause nach der n-ten Prüfung während der Sperre */
const wartungPause = (n) => Math.min(WARTUNG_BREMSE_MS * 2 ** Math.max(0, n - 1), WARTUNG_BREMSE_MAX_MS);
const wartungDauer = (sek) => (sek >= 90 ? `${Math.ceil(sek / 60)} Minuten` : sek === 1 ? '1 Sekunde' : `${sek} Sekunden`);
let wartungLogo = '';
try { wartungLogo = readFileSync(path.join(PUBLIC, 'img/brand/formsam-logo.svg'), 'utf8').replace(/<title>.*?<\/title>/, '').replace('<svg ', '<svg class="logo" aria-label="formsam" '); } catch { /* Logo fehlt → nur Text */ }
function wartungSeite(res, code, { fehler = '', ziel = '/', warten = 0 } = {}) {
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>formsam – bald für dich da</title><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#f4efe7">
<link rel="icon" href="/img/brand/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="any">
<style>
@font-face{font-family:Fraunces;src:url(/fonts/fraunces-latin.woff2) format('woff2');font-weight:300 900;font-display:swap}
@font-face{font-family:Inter;src:url(/fonts/inter-latin.woff2) format('woff2');font-weight:100 900;font-display:swap}
:root{color-scheme:light dark;--bg:#f4efe7;--ink:#211d18;--soft:#6b6258;--line:#e2d9cb;--card:#fbf8f2;--acc:#c86f4a;--acc-t:#9e4f2c}
@media (prefers-color-scheme:dark){:root{--bg:#17130f;--ink:#f0e9dc;--soft:#b9ad9c;--line:#3a332b;--card:#211c17;--acc-t:#e3a07f}.logo path[fill="#211d18"]{fill:#f0e9dc}}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:28px 20px;background:var(--bg);color:var(--ink);font:400 15px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:440px;text-align:center}
.logo{width:210px;height:auto;display:block;margin:0 auto 34px}
h1{font:500 32px/1.15 Fraunces,Georgia,serif;letter-spacing:-.02em;margin:0 0 12px}
h1 em{color:var(--acc-t);font-style:italic}
p{margin:0 0 26px;color:var(--soft)}
form{display:flex;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px}
input{flex:1;min-width:0;border:0;background:transparent;color:var(--ink);font:500 16px Inter,system-ui,sans-serif;padding:10px 14px;outline:none}
button{border:0;border-radius:999px;background:var(--ink);color:var(--bg);font:600 14px Inter,system-ui,sans-serif;padding:10px 20px;cursor:pointer}
input:focus{outline:none}form:focus-within{border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 25%,transparent)}button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.err{color:#b3261e;font-size:13px;margin:12px 0 0}
@media (prefers-color-scheme:dark){.err{color:#ffb4ad}}
small{display:block;margin-top:34px;color:var(--soft);font-size:12px;letter-spacing:.04em}
.recht{margin-top:14px;font-size:12px}.recht a{color:var(--soft);text-underline-offset:.16em;margin:0 6px}.recht a:hover{color:var(--ink)}
</style></head><body><main>
${wartungLogo || '<div style="font:600 34px Fraunces,Georgia,serif;margin-bottom:30px">formsam</div>'}
<h1>Gleich geht’s los.<br><em>Ich arbeite noch an der Seite.</em></h1>
<p>formsam ist bald für dich da: Vasen, die du selbst gestaltest. Mit dem Zugangskennwort kannst du schon jetzt hineinsehen.</p>
<form method="post" action="/__wartung" autocomplete="off">
<input type="hidden" name="ziel" value="${esc(ziel)}">
<label for="kw" style="position:absolute;left:-9999px">Zugangskennwort</label>
<input id="kw" name="kennwort" type="password" inputmode="text" placeholder="Zugangskennwort" required autofocus>
<button type="submit">Ansehen</button>
</form>
${fehler ? `<p class="err" role="alert">${esc(fehler)}</p>` : ''}
<small>Sorgsam geformt. Auf dich zugeschnitten.</small>
<nav class="recht" aria-label="Rechtliches"><a href="/impressum">Impressum</a><a href="/datenschutz">Datenschutz</a><a href="/widerruf#widerrufen">Vertrag widerrufen</a></nav>
</main></body></html>`;
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
    'X-Formsam-Wartung': '1', ...(code === 503 ? { 'Retry-After': '3600' } : warten > 0 ? { 'Retry-After': String(warten) } : {}),
  });
  res.end(html);
}
/** Vor jeder Anfrage: true = beantwortet (Wartungsseite, Login, Sperre), false = normal weiter */
async function wartungTor(req, res, p, url) {
  if (!wartungAktiv()) {
    if (p === '/__wartung') { res.writeHead(303, { Location: '/' }); res.end(); return true; }
    return false;
  }
  // Kodierte Schrägstriche, Backslash, ..-Segmente: kein legitimer Link sieht so aus → ablehnen statt am Tor vorbei
  if (!wartungPfadOk(url, p)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Formsam-Wartung': '1' });
    res.end('Ungültige Adresse');
    return true;
  }
  if (p === '/__wartung' && req.method === 'POST') {
    const body = new URLSearchParams((await readBody(req, 8 * 1024)).toString('utf8'));
    const ziel = wartungZiel(body.get('ziel'));
    const key = `wartung:${clientIp(req)}`;
    const gesperrt = rateLimitReached(key, 10);
    let pause = 0;
    if (gesperrt) {
      const jetzt = Date.now();
      let g = wartungGeprueft.get(key);
      if (g && jetzt - g.t > WARTUNG_BREMSE_RUHE_MS) g = null;
      const warten = g ? Math.ceil((g.t + wartungPause(g.n) - jetzt) / 1000) : 0;
      if (warten > 0) { wartungSeite(res, 429, { fehler: `Zu viele Versuche – bitte warte ${wartungDauer(warten)} und gib das Kennwort dann noch einmal ein.`, ziel, warten }); return true; }
      g = { t: jetzt, n: (g?.n || 0) + 1 };
      wartungGeprueft.delete(key); wartungGeprueft.set(key, g);   // neu einreihen → bei Überlauf fliegen die ältesten raus
      if (wartungGeprueft.size > 5000) wartungGeprueft.delete(wartungGeprueft.keys().next().value);
      pause = Math.ceil(wartungPause(g.n) / 1000);
    }
    if (!wartungKennwortStimmt(body.get('kennwort') || '')) {
      forgotLimited(key, 10); // nur Fehlgriffe zählen
      if (gesperrt) wartungSeite(res, 429, { fehler: `Das Kennwort stimmt nicht. Nach vielen Fehlversuchen geht der nächste Versuch erst in ${wartungDauer(pause)}.`, ziel, warten: pause });
      else wartungSeite(res, 401, { fehler: 'Das Kennwort stimmt nicht.', ziel });
      return true;
    }
    wartungGeprueft.delete(key);
    res.writeHead(303, {
      Location: ziel, 'Cache-Control': 'no-store',
      'Set-Cookie': wartungCookie(req),
    });
    res.end();
    return true;
  }
  if (wartungFrei(req, p) || wartungFreigegeben(req)) {
    if (p === '/__wartung') { res.writeHead(303, { Location: '/' }); res.end(); return true; }
    return false;
  }
  if (p.startsWith('/api/')) {
    // bewusst ohne Retry-After: Werkzeuge mit automatischer Wiederholung (curl --retry, Überwachung) hielten sich daran und
    // warteten eine Stunde — auch wenn die Wartung längst vorbei ist; Seiten und Dateien behalten Retry-After 3600
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Formsam-Wartung': '1' });
    res.end(JSON.stringify({ ok: false, error: 'Wartungsmodus – bitte später noch einmal versuchen.' }));
    return true;
  }
  const seite = (req.method === 'GET' || req.method === 'HEAD') && (/text\/html/.test(String(req.headers.accept || '')) || !path.extname(p));
  if (seite) { wartungSeite(res, 503, { ziel: wartungZiel(url.pathname + url.search) }); return true; }
  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Formsam-Wartung': '1', 'Retry-After': '3600' });
  res.end('Wartungsmodus');
  return true;
}

// ---------------------------------------------------------------------------
// E-Mail-Versand (lib/mailer.js + lib/mail-templates.js) — Protokoll in data/mail-outbox.json (Inhalte in data/mail-outbox/)
//   Hooks (unten): Bestellbestätigung + Admin-Kopie, Status-Mails, Reklamation, Widerruf, Willkommensmail.
//   Eine automatische Mail zu einer Bestellung reserviert vorher order.mailsSent[key] (key = 'bestaetigung' | Status |
//   'reklamation:<Phase>' | 'widerruf:<Referenz>') — so gibt es je Status nur eine automatische Mail, auch wenn er erneut gesetzt
//   wird, während die Zustellung noch wiederholt wird. Den Endstand meldet der Mailer (onFinal → mailErgebnis): zugestellt →
//   mailsSent[key] = Zustellzeit und Historie „E-Mail „…“ → …“; endgültig gescheitert oder Versand aus → Historie „nicht
//   zugestellt/nicht gesendet“, die Reservierung fällt weg (die Automatik greift später noch). Ebenso für Admin-Versand und Freitext.
// ---------------------------------------------------------------------------
const mailer = createMailer({
  dataDir: DATA, getSettings: () => settings, log: (m) => console.log('✉️ ', m),
  onFinal: (e) => mailErgebnis(e), rebuildable: (e) => mailNeuBaubar(e), rebuild: (e) => mailNeuBauen(e),
  // Zahlungserinnerung nie aus dem Speicher: Zahlstand, abgebrochene Kasse, eine je Tag und die Frist von heute gelten auch bei „Erneut“
  frischBauen: (e) => e.kind === 'zahlungserinnerung',
});
const MAIL_KEYS = ['enabled', 'host', 'port', 'secure', 'user', 'pass', 'from', 'fromName', 'replyTo', 'adminTo', 'adminCopy', 'autoStatusMails', 'publicUrl', 'allowSelfSigned'];
// isEmail kommt aus lib/eingaben.js (wie der Mailversand, aber linear und höchstens 254 Zeichen)
const customerAddress = (order) => ({ name: String(order.customer?.name || '').trim(), email: String(order.customer?.email || '').trim().toLowerCase() });
const httpError = (code, message) => Object.assign(new Error(message), { httpCode: code });
/** Einstellungen fürs Admin-UI/Export: Geheimnisse maskiert (leer + …Set) — SMTP-Passwort, PayPal-Secret und Admin-Passwort verlassen den Server nie. */
const adminSettingsView = () => {
  const { adminKey, adminKeyHash, adminKeyPlatzhalter, ...rest } = settings;
  return {
    ...rest,
    mail: { ...settings.mail, pass: '', passSet: !!settings.mail?.pass },
    paypal: { ...settings.paypal, secret: '', secretSet: !!settings.paypal?.secret },
    wartung: { aktiv: !!settings.wartung?.aktiv, kennwortGesetzt: !!settings.wartung?.hash }, // Hash/Schlüssel bleiben auf dem Server
  };
};

/** Bestellnummer zu einem Protokolleintrag (neu: orderId; ältere Einträge: ref = Bestellnummer) */
const mailOrderId = (e) => { const id = String(e?.orderId || e?.ref || ''); return /^(FS|OV)-[A-Z0-9-]+$/.test(id) ? id : ''; };
/** mailsSent-Schlüssel älterer Protokolleinträge (ohne key) aus der Mail-Art */
const mailKeyAlt = (kind) => (kind === 'bestaetigung' ? kind : /^status:/.test(kind || '') ? kind.slice(7) : /^reklamation:/.test(kind || '') ? kind : null);
/**
 * Mail zu einer Bestellung einreihen: mailsSent[key] vorher unter der Bestellsperre reservieren (Bestellung frisch gelesen, damit
 * parallele Aufrufe nicht zweimal senden). Ist der Schlüssel schon belegt (unterwegs oder zugestellt): nichts tun → null.
 */
async function queueOrderMail(order, key, msg) {
  let reserviert = null;
  if (key) {
    const release = await lockOrder(order.orderId);
    try {
      const o = await readOrder(order.orderId);
      if (o.mailsSent?.[key]) return null;
      reserviert = new Date().toISOString();
      o.mailsSent[key] = reserviert;
      await writeOrder(o);
    } finally { release(); }
  }
  return mailer.queue({ ref: order.orderId, ...msg, orderId: order.orderId, key, reserviert });
}
/** Endstand einer Mail an der Bestellung vermerken (Mailer → onFinal): Historie + mailsSent (siehe oben) */
async function mailErgebnis(e) {
  const orderId = mailOrderId(e);
  if (!orderId || /^admin-/.test(e.kind || '')) return;   // Meldungen an den Shop gehören nicht in die Bestellhistorie
  const key = e.key ?? mailKeyAlt(e.kind);
  const release = await lockOrder(orderId);
  try {
    let o;
    try { o = await readOrder(orderId); } catch { return; }
    if (e.status === 'gesendet') {
      if (key) o.mailsSent[key] = e.sentAt || new Date().toISOString();
      // Altbestand (e.vermerkt): der alte Code hat dieselbe Zeile schon beim Einreihen geschrieben — nicht doppelt
      const note = `E-Mail „${e.subject}“ → ${e.to}`;
      if (!(e.vermerkt && (o.history || []).some((h) => h?.note === note))) addHistory(o, o.status, note, 'mail');
    } else {
      if (key && e.reserviert && o.mailsSent[key] === e.reserviert) delete o.mailsSent[key];
      addHistory(o, o.status, e.status === 'deaktiviert'
        ? `E-Mail „${e.subject}“ an ${e.to} nicht gesendet: ${e.error || 'Versand aus'} – liegt im Versandprotokoll`
        : `E-Mail „${e.subject}“ an ${e.to} nicht zugestellt: ${e.error || 'Fehler'} – im Versandprotokoll erneut senden`, 'mail');
    }
    await writeOrder(o);
  } finally { release(); }
}
/**
 * Empfänger der Meldungen an den Shop: settings.mail.adminTo — auch mehrere Adressen (Komma/Semikolon); ungültige fallen weg,
 * bleibt keine übrig, die Firmen-Adresse. Leer = niemand.
 */
function adminEmpfaenger() {
  const list = addressList(String(mailSettings(settings.mail).adminTo || '').replace(/;/g, ',')).filter((a) => isEmail(a.email));
  if (list.length) return list;
  const co = String(settings.company?.email || '').trim().toLowerCase();
  return isEmail(co) ? [{ name: '', email: co }] : [];
}
/** Reply-To der Meldungen an den Shop = Adresse der Kundschaft („Antworten“ geht an sie, nicht an den Shop selbst); nur ASCII vor dem @ */
const antwortAn = (email) => { const e = String(email || '').trim(); return isEmail(e) && /^[\x21-\x7e]+@/.test(e) ? e : ''; };
/** Storno-Mail: Beträge wie die Stornorechnung (stornoBetraege) — schon erledigte Gutschrift und wieder freies Guthaben */
function stornoMailInfo(order) {
  const { gutschrift, guth } = stornoBetraege(order);
  return { gutschrift, gutschriftNo: gutschrift > 0 ? String(order.reklamation?.gutschriftNo || '') : '', guthaben: guth ? { code: guth.code, off: guth.off } : null };
}
/**
 * Zahlungserinnerung höchstens einmal je Kalendertag (deutsche Zeit): Uhrzeit der heutigen (zugestellten) Erinnerung, sonst ''.
 * erinnerungLaeuft = Bestellungen, deren Erinnerung gerade gesendet wird — so kommt bei Doppelklick oder zwei Admin-Tabs nur eine an.
 */
function erinnertHeute(order) {
  const z = order?.mailsSent?.zahlungserinnerung;
  const tag = (t) => new Date(t).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
  return z && tag(z) === tag(Date.now()) ? new Date(z).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }) : '';
}
const erinnerungLaeuft = new Map();   // orderId → wer gerade sendet ('senden' = Knopf im Drawer, sonst ID des Protokolleintrags bei „Erneut“)
// „Erneut“ im Versandprotokoll bei Mails, deren Inhalt nicht mehr gespeichert ist (zugestellt) oder deren Anhänge fehlen:
// aus Bestellung bzw. Widerruf neu erzeugen — wie „senden“ im Bestell-Drawer. Passwort-/Bestätigungslinks und Freitext nicht.
function mailNeuBaubar(e) {
  if (/^(bestaetigung|status:[a-z-]+|reklamation:[a-z]+|zahlungserinnerung|admin-neu)$/.test(e.kind || '')) return !!mailOrderId(e);
  if (/^(widerruf|admin-widerruf)$/.test(e.kind || '')) return /^WR-[A-Z0-9-]+$/.test(String(e.ref || ''));
  return false;
}
async function mailNeuBauen(e) {
  const baseUrl = baseUrlFor(settings);
  const kind = String(e.kind || '');
  if (kind === 'widerruf' || kind === 'admin-widerruf') {
    const w = await withWiderrufe((list) => ({ result: list.find((x) => x.ref === e.ref) || null }));
    if (!w) throw new Error(`Widerruf ${e.ref} ist nicht mehr gespeichert`);
    if (kind === 'widerruf') return { to: e.to || w.email, ...widerrufEingang({ widerruf: w, settings, baseUrl }) };
    return { to: adminEmpfaenger(), replyTo: antwortAn(w.email), ...adminWiderruf({ widerruf: w, settings, baseUrl }) };
  }
  const orderId = mailOrderId(e);
  let order;
  try { order = await readOrder(orderId); } catch { throw new Error(`Bestellung ${orderId} nicht gefunden`); }
  // Dieselben Anhänge wie beim ersten Versand (Beleg-PDFs, bei der Bestätigung die damals gespeicherten Rechtstext-PDFs)
  if (kind === 'admin-neu') {
    const attachments = await mailAnhaenge(order, kind);
    return { to: adminEmpfaenger(), replyTo: antwortAn(order.customer?.email), ...adminNewOrder({ order, settings, baseUrl, anhaenge: attachments.map((a) => a.filename) }), attachments };
  }
  // „Erneut“ einer zugestellten Zahlungserinnerung: dieselbe Tagesgrenze wie der Knopf im Drawer
  const um = kind === 'zahlungserinnerung' ? erinnertHeute(order) : '';
  const laeuft = kind === 'zahlungserinnerung' ? erinnerungLaeuft.get(orderId) : undefined;
  if (um || (laeuft !== undefined && laeuft !== e.id)) throw new Error(`Heute ist schon eine Zahlungserinnerung rausgegangen${um ? ` (um ${um} Uhr)` : ''} – eine je Tag`);
  const body = kind.startsWith('status:') ? { kind: 'status', status: kind.slice(7) }
    : kind.startsWith('reklamation:') ? { kind: 'reklamation', phase: kind.slice(12) } : { kind };
  const attachments = await mailAnhaenge(order, kind);
  const m = renderOrderMail(order, { ...body, anhaenge: attachments.map((a) => a.filename) });
  return { to: e.to || customerAddress(order), subject: m.subject, text: m.text, html: m.html, attachments };
}

// ---------------------------------------------------------------------------
// PDF-Belege und PDF-Rechtstexte (lib/html-pdf.js: eigener Satz mit eingebetteten Schriften Inter/Fraunces, ohne Fremdpakete)
// Lieber keine PDF als eine falsche: der Satz arbeitet streng (Zeichen ohne Glyphe, nicht unterstützter Aufbau, Selbstprüfung
// → PdfError) — dann bleibt es beim Link auf den HTML-Beleg bzw. beim Rechtstext als HTML-Anhang. Eine PDF-Panne hält nie
// eine Bestellung, eine Antwort oder eine Mail auf; protokolliert werden nur Code, Codepunkt und Bestellnummer (keine
// Kundendaten). orders/<ID>/<art>.pdf entsteht einmal aus der gespeicherten HTML-Datei und wird danach nie verändert.
// ---------------------------------------------------------------------------
const BELEG_ARTEN = { rechnung: 'Rechnung', gutschrift: 'Gutschrift', storno: 'Stornorechnung' };
const PDF_TYP = 'application/pdf';
let pdfMod = null;
let pdfWarned = false;
/** lib/html-pdf.js dynamisch laden (wie lib/legal.js): fehlt das Modul oder ist es fehlerhaft, gibt es einfach keine PDFs */
async function pdfModul() {
  if (pdfMod) return pdfMod;
  try {
    const m = await import('./lib/html-pdf.js');
    if (typeof m.belegPdf !== 'function' || typeof m.legalPdf !== 'function') throw new Error('belegPdf/legalPdf fehlen');
    pdfMod = m;
    pdfWarned = false;
  } catch (err) {
    if (!pdfWarned) { pdfWarned = true; console.warn(`⚠️  PDF-Satz nicht verfügbar (lib/html-pdf.js): ${err?.code || err?.name || 'Fehler'} – Belege nur als Link, Rechtstexte als HTML`); }
    return null;
  }
  return pdfMod;
}
/** Protokoll einer gescheiterten PDF — nur Code, Codepunkt, Art und Bestellnummer (Meldung/e.context können Kundentext enthalten) */
function pdfFehler(was, orderId, err) {
  const cp = Number.isInteger(err?.codePoint) ? ` U+${err.codePoint.toString(16).toUpperCase().padStart(4, '0')}` : '';
  console.warn(`📄 PDF ${was}${orderId ? ` ${orderId}` : ''} nicht erzeugt: ${err?.code || err?.name || 'Fehler'}${cp} – stattdessen Link bzw. HTML`);
}
/** Beleg-Datum als Erstellungsdatum der PDF (deterministisch: dieselbe Datei ergibt dieselben Bytes) — nur ISO-Zeit mit Z */
function belegDatum(order, art) {
  const r = order?.reklamation || {};
  const v = art === 'rechnung' ? order?.invoiceAt || order?.completedAt || order?.createdAt
    : art === 'gutschrift' ? r.resolvedAt || r.updatedAt : order?.storno?.at;
  return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z$/.test(v) ? v : undefined;
}
/** Dateiname: formsam-Rechnung-RE-2026-0042.pdf | formsam-Gutschrift-… | formsam-Stornorechnung-… (Nummer nur [A-Za-z0-9._-]) */
function belegPdfName(order, art) {
  const nr = art === 'rechnung' ? order?.invoiceNo : art === 'gutschrift' ? order?.reklamation?.gutschriftNo : order?.storno?.nr;
  const s = String(nr || order?.orderId || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40);
  return `formsam-${BELEG_ARTEN[art]}${s ? `-${s}` : ''}.pdf`;
}
/** Datei einmal anlegen, nie ersetzen (Temp-Datei 0600 + link): gibt es sie schon, bleibt sie → Inhalt der vorhandenen Datei */
async function einmalSchreiben(file, buffer) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, buffer, { mode: 0o600, flag: 'wx' });
    try { await link(tmp, file); } catch (err) {
      if (err?.code === 'EEXIST') return await readFile(file);
      if (existsSync(file)) return await readFile(file);
      await rename(tmp, file);   // Dateisystem ohne harte Links: die laufende Erzeugung ist je Datei ohnehin nur einmal unterwegs
    }
    return buffer;
  } finally { await rm(tmp, { force: true }).catch(() => {}); }
}
const pdfLaeuft = new Map();       // '<ID>/<art>' → laufende Erzeugung (gleichzeitige Aufrufe teilen sie)
const pdfGescheitert = new Map();  // '<ID>/<art>' → Stand der HTML-Datei, an dem der Satz scheiterte (nicht bei jedem Abruf neu rechnen)
/**
 * PDF zu einem Beleg (art: rechnung | gutschrift | storno) → { buffer, filename } oder null. Liegt orders/<ID>/<art>.pdf schon
 * vor, wird sie genommen; sonst entsteht sie EINMAL aus der gespeicherten <art>.html (Datum = Belegdatum) und bleibt danach,
 * wie sie ist. Ohne HTML-Beleg oder wenn der Satz scheitert: null (dann gilt der Link auf die HTML-Fassung).
 */
function ensureBelegPdf(order, art) {
  const id = String(order?.orderId || '');
  if (!Object.hasOwn(BELEG_ARTEN, art) || !ORDER_ID_RE.test(id)) return Promise.resolve(null);
  const key = `${id}/${art}`;
  if (pdfLaeuft.has(key)) return pdfLaeuft.get(key);
  const p = (async () => {
    const filename = belegPdfName(order, art);
    const file = path.join(ORDERS, id, `${art}.pdf`);
    try { return { buffer: await readFile(file), filename }; } catch (err) { if (err?.code !== 'ENOENT') { pdfFehler(art, id, err); return null; } }
    const htmlFile = path.join(ORDERS, id, `${art}.html`);
    let html, stand;
    try { const st = await stat(htmlFile); stand = `${st.size}:${st.mtimeMs}`; html = await readFile(htmlFile, 'utf8'); } catch { return null; }
    if (pdfGescheitert.get(key) === stand) return null;
    const mod = await pdfModul();
    if (!mod) return null;
    let buffer;
    try { ({ buffer } = mod.belegPdf(html, { createdAt: belegDatum(order, art) })); } catch (err) {
      if (pdfGescheitert.size >= 2000) pdfGescheitert.delete(pdfGescheitert.keys().next().value);
      pdfGescheitert.set(key, stand);
      pdfFehler(art, id, err);
      return null;
    }
    // nicht speicherbar (z. B. Platte voll): die PDF taugt trotzdem als Anhang, beim nächsten Abruf wird sie neu gesetzt
    try { buffer = await einmalSchreiben(file, buffer); } catch (err) { pdfFehler(`${art} (Speichern)`, id, err); }
    return { buffer, filename };
  })().catch((err) => { pdfFehler(art, id, err); return null; }).finally(() => pdfLaeuft.delete(key));
  pdfLaeuft.set(key, p);
  return p;
}
const RECHTSTEXTE = [['agb', 'formsam-AGB'], ['widerruf', 'formsam-Widerrufsbelehrung']];
const rechtPdfCache = new Map();   // SHA-256 der Druckfassung → PDF bzw. null (gleiche Fassung → dieselben Bytes, ohne neu zu setzen)
/** Rechtstext als PDF in der heute gültigen Fassung → Buffer oder null (z. B. INCOMPLETE: Firmendaten unvollständig) */
async function rechtPdf(slug, orderId) {
  const [lmod, pmod] = [await legalModule(), await pdfModul()];
  if (!lmod || !pmod || typeof lmod.renderLegalPage !== 'function') return null;
  const opts = { settings, baseUrl: baseUrlFor(settings), logoHtml: logoHTML(28) };
  try {
    // Schlüssel: Druckfassung + Firmendaten (die Pflichtangaben-Prüfung von legalPdf hängt an ihnen, auch wo der Text sie nicht nennt)
    const key = sha256(`${slug}\n${JSON.stringify(settings.company || {})}\n${lmod.renderLegalPage(slug, { ...opts, forPdf: true })}`);
    if (!rechtPdfCache.has(key)) {
      let buf = null;
      try { buf = pmod.legalPdf(slug, { ...opts, createdAt: lmod.LEGAL_STAND || undefined }).buffer; } catch (err) { pdfFehler(slug, orderId, err); }
      if (rechtPdfCache.size >= 16) rechtPdfCache.delete(rechtPdfCache.keys().next().value);
      rechtPdfCache.set(key, buf);
    }
    return rechtPdfCache.get(key);
  } catch (err) { pdfFehler(slug, orderId, err); return null; }
}
/**
 * AGB und Widerrufsbelehrung (mit Muster-Widerrufsformular) für die Bestellbestätigung — so hat die Kundschaft die
 * Vertragsbedingungen auf einem dauerhaften Datenträger (§ 312f Abs. 2 BGB). Je Text: die beim Abschluss verschickte PDF
 * (orders/<ID>/agb.pdf, widerruf.pdf — damit „Erneut“ den damaligen Stand schickt), sonst jetzt als PDF (speichern: beim
 * Abschluss festhalten), sonst wie bisher als HTML. Ohne lib/legal.js: keine Anhänge.
 */
async function rechtsAnhaenge(order, { speichern = false } = {}) {
  const out = [];
  const id = ORDER_ID_RE.test(String(order?.orderId || '')) ? order.orderId : '';
  for (const [slug, name] of RECHTSTEXTE) {
    try {
      const file = id ? path.join(ORDERS, id, `${slug}.pdf`) : '';
      let buf = null;
      if (file) { try { buf = await readFile(file); } catch { /* noch keine gespeicherte Fassung */ } }
      if (!buf) {
        buf = await rechtPdf(slug, id);
        if (buf && speichern && file) { try { buf = await einmalSchreiben(file, buf); } catch (err) { pdfFehler(`${slug} (Speichern)`, id, err); } }
      }
      if (buf) { out.push({ filename: `${name}.pdf`, content: buf, contentType: PDF_TYP }); continue; }
      const mod = await legalModule();
      const html = mod ? await mod.renderLegalPage(slug, { settings, baseUrl: baseUrlFor(settings), forMail: true }) : null;
      if (typeof html === 'string') out.push({ filename: `${name}.html`, content: html, contentType: 'text/html; charset=utf-8' });
    } catch (err) { console.error(`Anhang ${name} fehlgeschlagen:`, err?.code || err?.message || err); }
  }
  return out;
}
/**
 * Anhänge einer Bestellmail — dieselben beim ersten Versand, bei „Erneut“ und beim Senden aus dem Drawer. kind wie im
 * Versandprotokoll: bestaetigung = Rechnung (PDF) + AGB + Widerrufsbelehrung, admin-neu = Rechnung, status:storniert =
 * Stornorechnung, reklamation:erledigt mit Gutschrift = Gutschrift. Fehlt eine Beleg-PDF, bleibt es beim Link in der Mail.
 */
async function mailAnhaenge(order, kind, { speichern = false } = {}) {
  const out = [];
  const beleg = async (art) => {
    const b = await ensureBelegPdf(order, art);
    if (b) out.push({ filename: b.filename, content: b.buffer, contentType: PDF_TYP });
  };
  try {
    if (kind === 'bestaetigung' || kind === 'admin-neu') await beleg('rechnung');
    if (kind === 'bestaetigung') out.push(...await rechtsAnhaenge(order, { speichern }));
    if (kind === 'status:storniert' && order?.storno?.nr) await beleg('storno');
    if (kind === 'reklamation:erledigt' && order?.reklamation?.gutschriftNo) await beleg('gutschrift');
  } catch (err) { pdfFehler(kind, order?.orderId, err); }
  return out;
}
/**
 * Mail zu einer Bestellung rendern (Admin: Vorschau & Versand). kind: bestaetigung | status | freitext | reklamation (+ phase) | zahlungserinnerung
 * anhaenge: Dateinamen der Anhänge (mailAnhaenge: Beleg-PDFs, Rechtstexte) — die Mail nennt nur, was wirklich anhängt
 */
function renderOrderMail(order, { kind, status, phase, subject, text, anhaenge = [] } = {}) {
  const baseUrl = baseUrlFor(settings);
  switch (kind) {
    case 'reklamation': {
      const ph = String(phase || '');
      if (!REKLA_PHASES.includes(ph)) throw httpError(400, 'Unbekannte Reklamationsphase (angelegt | eingegangen | erledigt | abgelehnt)');
      const r = order.reklamation;
      if (!r) throw httpError(400, 'Zu dieser Bestellung gibt es keine Reklamation');
      // Nur die Phase zum aktuellen Stand — sonst ginge z. B. eine Ablehnungs-Mail zu einer bereits erledigten Erstattung raus
      if (REKLA_PHASE_OF[r.status] !== ph) {
        throw httpError(400, `Phase „${ph}“ passt nicht zum Status der Reklamation (${REKLA_STATUS[r.status] || r.status} → Mail „${REKLA_PHASE_OF[r.status] || '–'}“)`);
      }
      return { key: `reklamation:${ph}`, kind: `reklamation:${ph}`, ...reklamationMail({ order, phase: ph, settings, baseUrl, anhaenge }) };
    }
    case 'bestaetigung':
      return { key: 'bestaetigung', kind, ...orderConfirmation({ order, settings, baseUrl, anhaenge }) };
    case 'status': {
      const st = String(status || order.status || '');
      if (!STATUSES.includes(st)) throw httpError(400, 'Ungültiger Status');
      if (!statusMailAllowed(st)) throw httpError(400, `Für den Status „${STATUS_LABELS[st] || st}“ gibt es keine Mail-Vorlage`);
      return { key: st, kind: `status:${st}`, ...orderStatus({ order, status: st, settings, baseUrl, storno: st === 'storniert' ? stornoMailInfo(order) : null, anhaenge }) };
    }
    case 'zahlungserinnerung': {
      // Nur für offene Vorkasse mit Betrag — nach Zahlung oder Storno gibt es nichts zu erinnern
      if (order.payment === 'paypal' || order.paymentStatus === 'bezahlt' || order.status === 'storniert' || !(euro(order.total) > 0)) {
        throw httpError(400, 'Eine Zahlungserinnerung gibt es nur für offene Vorkasse-Bestellungen (nicht bezahlt, nicht storniert, Betrag über 0 €)');
      }
      // Nie abgeschlossene Kasse (keine Rechnung, keine Bestätigung — wie „Kasse abgebrochen“ im Admin): kein Vertrag, keine Zahlungspflicht
      if (!order.completedAt && !order.invoiceNo && (order.status || 'neu') === 'neu') {
        throw httpError(400, 'Die Kasse dieser Bestellung wurde nie abgeschlossen (keine Rechnung, keine Bestätigung) – dafür gibt es keine Zahlungserinnerung');
      }
      return { key: 'zahlungserinnerung', kind, ...zahlungserinnerung({ order, settings, baseUrl }) };
    }
    case 'freitext': {
      const subj = String(subject || '').trim().slice(0, 200);
      const body = String(text || '').trim().slice(0, 20000);
      if (!subj || !body) throw httpError(400, 'Bitte Betreff und Text ausfüllen');
      return { key: null, kind, ...customMessage({ order, subject: subj, text: body, settings, baseUrl }) };
    }
    default:
      throw httpError(400, 'Unbekannte Mail-Art (bestaetigung | status | freitext | reklamation | zahlungserinnerung)');
  }
}

// Bestellung abgeschlossen → Bestätigung an den Kunden, Kopie an den Shop (adminTo — auch mehrere —, sonst Firmen-Adresse)
hooks.orderCompleted = async (order) => {
  if (order.mailsSent?.bestaetigung) return;   // /complete wurde doppelt aufgerufen
  const baseUrl = baseUrlFor(settings);
  const mc = mailSettings(settings.mail);
  const cust = customerAddress(order);
  if (isEmail(cust.email)) {
    // Rechnung als PDF + AGB und Widerrufsbelehrung zum Aufbewahren (PDF, je Bestellung gespeichert; sonst HTML) — hier, nach der
    // Antwort an die Kasse; scheitert eine PDF, geht die Mail trotzdem (ohne diese PDF, der Text nennt nur, was anhängt)
    const attachments = await mailAnhaenge(order, 'bestaetigung', { speichern: true });
    const m = orderConfirmation({ order, settings, baseUrl, anhaenge: attachments.map((a) => a.filename) });
    const q = await queueOrderMail(order, 'bestaetigung', { to: cust, subject: m.subject, text: m.text, html: m.html, attachments, kind: 'bestaetigung' });
    if (q === null) return;   // parallel schon bestätigt → auch keine zweite Admin-Kopie
  }
  const admins = adminEmpfaenger();
  if (mc.adminCopy && admins.length) {
    const attachments = await mailAnhaenge(order, 'admin-neu');   // Rechnung als PDF (schon erzeugt, aus orders/<ID>/rechnung.pdf)
    const m = adminNewOrder({ order, settings, baseUrl, anhaenge: attachments.map((a) => a.filename) });
    await mailer.queue({ to: admins, replyTo: antwortAn(cust.email), subject: m.subject, text: m.text, html: m.html, attachments, kind: 'admin-neu', ref: order.orderId });
  }
};
// Statuswechsel → Status-Mail (nur mit notify, aktivierter Automatik und passender Vorlage; je Status einmal)
hooks.statusChanged = async (order, prevStatus, { notify = true } = {}) => {
  const status = order.status;
  if (!notify || !mailSettings(settings.mail).autoStatusMails || !statusMailAllowed(status)) return;
  if (order.mailsSent?.[status]) return;
  const cust = customerAddress(order);
  if (!isEmail(cust.email)) return;
  const attachments = await mailAnhaenge(order, `status:${status}`);   // Storno: Stornorechnung als PDF
  const m = orderStatus({ order, status, settings, baseUrl: baseUrlFor(settings), storno: status === 'storniert' ? stornoMailInfo(order) : null, anhaenge: attachments.map((a) => a.filename) });
  await queueOrderMail(order, status, { to: cust, subject: m.subject, text: m.text, html: m.html, attachments, kind: `status:${status}` });
};
// Reklamation angelegt/eingegangen/erledigt/abgelehnt → Kundenmail (je Phase einmal: mailsSent['reklamation:<phase>'])
hooks.reklamation = async (order, phase, { notify = true } = {}) => {
  if (!notify || !mailSettings(settings.mail).autoStatusMails || !order.reklamation || !REKLA_PHASES.includes(phase)) return;
  const key = `reklamation:${phase}`;
  if (order.mailsSent?.[key]) return;
  const cust = customerAddress(order);
  if (!isEmail(cust.email)) return;
  const attachments = await mailAnhaenge(order, key);   // erledigt mit Gutschrift: Gutschrift als PDF
  const m = reklamationMail({ order, phase, settings, baseUrl: baseUrlFor(settings), anhaenge: attachments.map((a) => a.filename) });
  await queueOrderMail(order, key, { to: cust, subject: m.subject, text: m.text, html: m.html, attachments, kind: key });
};
// Widerruf eingegangen → Eingangsbestätigung an die angegebene Adresse (sofort, mit Inhalt, Datum/Uhrzeit, Referenz) und
// Meldung an den Shop (adminTo, sonst Firmen-Adresse) — die Meldung geht unabhängig von „Kopie an den Shop“ raus,
// ein Widerruf darf nicht untergehen. Zugeordnete Bestellung: Zustellung dort vermerkt (mailsSent['widerruf:<Referenz>'] + Historie).
// w.bestaetigungGebremst (Bremse für Widerruf-Mails an dieselbe Adresse): keine Eingangsbestätigung, die Meldung an den Shop geht trotzdem.
hooks.widerruf = async (w) => {
  const baseUrl = baseUrlFor(settings);
  const m = widerrufEingang({ widerruf: w, settings, baseUrl });
  const msg = { to: { name: w.name, email: w.email }, subject: m.subject, text: m.text, html: m.html, kind: 'widerruf', ref: w.ref };
  if (!w.bestaetigungGebremst) {
    if (w.orderMatched) await queueOrderMail({ orderId: w.orderId }, `widerruf:${w.ref}`, msg);
    else await mailer.queue(msg);
  }
  const admins = adminEmpfaenger();
  if (admins.length) {
    const a = adminWiderruf({ widerruf: w, settings, baseUrl });
    await mailer.queue({ to: admins, replyTo: antwortAn(w.email), subject: a.subject, text: a.text, html: a.html, kind: 'admin-widerruf', ref: w.ref });
  }
};
// Neues Kundenkonto → Willkommensmail
hooks.userRegistered = async (user) => {
  if (!isEmail(user?.email)) return;
  const m = welcome({ user, settings, baseUrl: baseUrlFor(settings), verifyLink: user.verifyLink || '' });
  await mailer.queue({ to: { name: user.name, email: user.email }, subject: m.subject, text: m.text, html: m.html, kind: 'willkommen', ref: user.id });
};

// ---------------------------------------------------------------------------
// Preisberechnung (Server = einzige Wahrheit)
// ---------------------------------------------------------------------------
// Normalgrößen (Standard-Höhe des Produkts, Breite 100 %)
const NORMAL_HEIGHT = { eierbecher: 58, vase: 150 };

/** Größenaufschlag in € — Mehrvolumen relativ zur Normalgröße, nur nach oben. */
function volumeSurcharge(product, config, basePrice) {
  const vol = settings.pricing.volumen || {};
  const h = Number(config?.height) || NORMAL_HEIGHT[product] || 1;
  const w = Number(config?.width) || 1;
  const rel = (h / (NORMAL_HEIGHT[product] || h)) * w * w;
  const extra = Math.max(0, rel - 1); // Mehrvolumen-Anteil (1 = +100 %)
  if (extra <= 0) return 0;
  return Math.round(extra * ((vol.prozent || 0) / 100 * basePrice + (vol.euro || 0)) * 100) / 100;
}

function discountFor(product, qty) {
  const tiers = settings.pricing[product]?.discounts || [];
  let off = 0;
  for (const t of tiers) if (qty >= t.qty && t.off > off) off = t.off;
  return off;
}
/** Gravur-Regel (Spiegel von public/js/pricing.js und geometry.js): Die Geometrie schaltet die Gravur ab,
 * sobald die WIRKSAME Mustertiefe über 2,5 mm (Vase) bzw. 2,0 mm (Eierbecher) liegt — dann darf
 * auch kein Gravur-Aufpreis berechnet werden. Wirksam = Wunschtiefe, begrenzt durch die
 * Musterklemme aus geometry.js (Gehämmert liegt dank seiner eigenen Grenze nie darüber). */
function gravurAllowed(c, product) {
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
/**
 * Körperfarbe einer Position: per Farb-ID (item.color), sonst über den Anzeigenamen — alte Warenkorb-Items
 * kennen nur colorName, ggf. mit Finish-Zusatz („Gold · metallic“ / „Gold (metallic)“), der abgeschnitten wird.
 */
function colorOfItem(item) {
  const cols = settings.colors || [];
  const id = typeof item?.color === 'string' ? item.color : '';
  if (id) { const c = cols.find((x) => x.id === id); if (c) return c; }
  const raw = String(item?.colorName || '').trim();
  if (!raw) return null;
  const plain = ohneFinish(raw);   // linear (der frühere Ausdruck blockierte bei langen Namen den ganzen Server)
  return cols.find((x) => x.name === raw) || (plain && cols.find((x) => x.name === plain)) || null;
}
/**
 * Stückpreis: uvp = Grundpreis + Untersetzer + Gravur + Farbschrift + Muster-Aufpreis + Farbaufpreis + Größe;
 * unit = uvp abzüglich Aktionsprozent (wenn eine Aktion für Produkt + Oberfläche gilt); dieselbe Formel rechnet der Client
 * in pricing.js (unitParts/unitPrice, Zeile: linePrice). parts = Aufschlüsselung in € (0 = nicht zutreffend).
 * Während einer Aktion ohne „mengenrabatt“ entfällt der Mengenrabatt (off = 0) — aber mit einer Aktion zahlt niemand mehr als
 * ohne: ist der Normalpreis der Zeile mit Mengenrabatt nicht teurer als der Aktionspreis (z. B. 3 Vasen bei −10 % ohne
 * Mengenrabatt), gilt für diese Zeile der Normalpreis mit Mengenrabatt und keine Aktion (aktionProzent 0, aktionName null).
 * aktionen = Ergebnis von aktiveAktionen() (computeTotals wertet sie einmal je Anfrage aus, damit alle Zeilen denselben Stand sehen);
 * für die Zeile gilt die erste passende (aktionFuer) — aktionName/aktionId nennen sie, null ohne Aktion.
 */
function priceItem(item, aktionen = aktiveAktionen()) {
  const p = settings.pricing[item.product];
  if (!p) throw new Error('Unbekanntes Produkt');
  const qty = Math.max(1, Math.min(50, parseInt(item.qty, 10) || 1));
  const c = item.config || {};
  const hasText = !!String(c.text || '').trim() && gravurAllowed(c, item.product);
  const col = colorOfItem(item);
  const parts = {
    grund: euro(p.single),
    untersetzer: item.product === 'eierbecher' && item.saucer ? euro(p.untersetzer) : 0,
    gravur: hasText ? euro(settings.pricing.gravur) : 0,
    farbschrift: hasText && c.textStyle === 'farbe' ? euro(settings.pricing.farbschrift) : 0,
    muster: euro(settings.pricing.muster?.[c.pattern]),
    farbe: euro(col?.aufpreis),
    groesse: volumeSurcharge(item.product, c, p.single),
  };
  const uvp = Math.round(Object.values(parts).reduce((s, v) => s + v, 0) * 100) / 100;
  // Erste laufende Aktion, die für Produkt und Oberfläche dieser Zeile gilt (null = voller Preis) — nur, wenn sie die Zeile
  // gegenüber dem Normalpreis mit Mengenrabatt wirklich günstiger macht (gleiche Rechnung wie linePrice() in pricing.js)
  const staffel = discountFor(item.product, qty);
  let aktion = aktionFuer(item, aktionen);
  if (aktion) {
    const unitA = Math.round(uvp * (1 - aktion.prozent / 100) * 100) / 100;
    const lineA = Math.round(unitA * qty * (1 - (aktion.mengenrabatt ? staffel : 0) / 100) * 100) / 100;
    const lineN = Math.round(uvp * qty * (1 - staffel / 100) * 100) / 100;
    if (!(lineA < lineN - 0.004)) aktion = null;
  }
  const aktionProzent = aktion ? aktion.prozent : 0;
  const unit = Math.round(uvp * (1 - aktionProzent / 100) * 100) / 100;
  const aktionBetrag = Math.round((uvp - unit) * 100) / 100;
  const off = aktionProzent > 0 && !aktion.mengenrabatt ? 0 : staffel;
  const lineFull = unit * qty;
  const line = Math.round(lineFull * (1 - off / 100) * 100) / 100;
  // color = aufgelöste Farb-ID (Fallback über den Namen), sonst die vom Client gesendete ID
  const color = col?.id || (typeof item.color === 'string' ? item.color.slice(0, 40) : null);
  return { qty, unit, off, lineFull: Math.round(lineFull * 100) / 100, line, parts, color, uvp, aktionProzent, aktionBetrag, aktionName: aktion ? aktion.name : null, aktionId: aktion ? aktion.id : null };
}
/**
 * Summen einer Bestellung: Zeilen (priceItem), Zwischensumme, Gutschein, Versand, Gesamt.
 * aktionen = [{ id, name, prozent, ersparnis, produkte, muster }] für jede Aktion, die mindestens eine Zeile günstiger gemacht hat
 * (Ersparnis = Σ je Zeile Normalpreis mit Staffel − Zeilenpreis, nur Aktionen mit Ersparnis > 0), sortiert nach Ersparnis
 * absteigend; aktion = aktionen[0] || null.
 * Gutschein während einer Aktion: nur mit coupon.mitAktion — gesperrt wird er nur, wenn eine Aktion in DIESER Bestellung etwas
 * spart (sonst coupon null und couponError mit lesbarer Meldung, genannt wird die Aktion mit der größten Ersparnis);
 * Mindestbestellwert nicht erreicht → coupon null mit couponError; unbekannter/inaktiver Code → coupon null ohne couponError
 * (allgemeine Meldung im Client).
 * Versand (AGB § 6): frei, wenn der Warenwert nach Aktion und Mengenrabatt (subtotal) die Freigrenze erreicht — gemessen VOR
 * Gutschein und Guthaben, damit ein Gutschein eine Bestellung nie teurer macht. Ein Rabatt-Gutschein mindert nur den Warenwert
 * (off ≤ subtotal); ein Guthaben ist ein Zahlungsmittel und deckt auch den Versand (off ≤ subtotal + shipping).
 * total = subtotal + shipping − coupon.off (≥ 0; 0 = nichts zu zahlen). Spiegel im Client: cart.js totals()/checkoutTotals().
 * email = Kundin der Kasse (Höchstzahl eines Gutscheins: ihre eigenen Reservierungen zählen nicht, siehe couponEinloesungen).
 */
function computeTotals(items, couponCode, { email = null } = {}) {
  const aks = aktiveAktionen();
  const lines = items.map((it) => ({ ...it, ...priceItem(it, aks) }));
  const subtotal = Math.round(lines.reduce((s, l) => s + l.line, 0) * 100) / 100;
  // Aktions-ID → Σ Ersparnis der Zeilen: Normalpreis der Zeile MIT dem Mengenrabatt, der ohne die Aktion gälte, minus Zeilenpreis
  // (≥ 0) — ohne „Mengenrabatt zusätzlich“ spart eine Aktion bei 2+ Stück weniger als aktionBetrag·qty, evtl. gar nichts.
  // Gleiche Rechnung wie linePrice().ersparnis in public/js/pricing.js (Warenkorb).
  const ersparnisJe = new Map();
  for (const l of lines) {
    if (!(l.aktionProzent > 0) || !l.aktionId) continue;
    const normal = Math.round((l.uvp * l.qty) * (1 - discountFor(l.product, l.qty) / 100) * 100) / 100;
    ersparnisJe.set(l.aktionId, (ersparnisJe.get(l.aktionId) || 0) + Math.max(0, Math.round((normal - l.line) * 100) / 100));
  }
  const aktionen = aks.filter((a) => ersparnisJe.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, prozent: a.prozent, ersparnis: Math.round(ersparnisJe.get(a.id) * 100) / 100, produkte: a.produkte, muster: a.muster || [] }))
    .filter((a) => a.ersparnis > 0)
    .sort((x, y) => y.ersparnis - x.ersparnis);
  const aktion = aktionen[0] || null;
  // Versand am Warenwert vor Gutschein/Guthaben; Freigrenze ≤ 0 = immer versandkostenfrei (wie AGB § 6 und pricing.js versandText)
  const ship = settings.pricing.shipping || {};
  const shipping = items.length === 0 ? 0 : (subtotal >= euro(ship.freeFrom) ? 0 : euro(ship.flat));
  // Gutschein
  let coupon = null;
  let couponError = null;
  if (couponCode) {
    const c = settings.coupons.find((x) => x.active && String(x.code || '').trim().toLowerCase() === String(couponCode).trim().toLowerCase());
    // Mindestbestellwert nicht (mehr) erreicht — z. B. Menge im Warenkorb verringert: mit Meldung statt still ohne Gutschein
    // abrechnen (die Kasse zeigt sie, der Checkout lehnt mit 400 ab). Guthaben gilt ohne Mindestbestellwert (AGB § 14).
    // Optionale Grenzen normaler Codes: gueltigBis (Datum, deutsche Zeit, einschließlich) und maxEinloesungen (Bestellungen, die
    // den Code fest eingelöst oder gerade in der Kasse einer anderen Kundin reserviert haben — couponEinloesungen; email = Kasse)
    if (c && !isGuthaben(c) && c.gueltigBis && heuteBerlin() > c.gueltigBis) couponError = `Gutschein „${c.code}“ ist abgelaufen (gültig bis ${dateDE(`${c.gueltigBis}T12:00:00Z`)}).`;
    else if (c && !isGuthaben(c) && c.maxEinloesungen > 0 && couponEinloesungen(c, { email }) >= c.maxEinloesungen) couponError = `Gutschein „${c.code}“ ist bereits vergeben – er war ${c.maxEinloesungen === 1 ? 'nur einmal' : `nur ${c.maxEinloesungen}-mal`} einlösbar.`;
    else if (c && !isGuthaben(c) && subtotal < (c.minOrder || 0)) couponError = `Gutschein „${c.code}“ gilt erst ab einem Bestellwert von ${money(c.minOrder)}.`;
    else if (c) {
      // Guthaben-Gutschein (Gutschrift): höchstens der noch offene Restwert
      const rest = isGuthaben(c) ? couponRest(c) : null;
      if (rest !== null && rest <= 0) {
        couponError = `Gutschein „${c.code}“ ist bereits vollständig eingelöst.`;
      } else if (aktion && !c.mitAktion) {
        couponError = `Gutschein „${c.code}“ ist nicht mit der Aktion „${aktion.name}“ kombinierbar.`;
      } else {
        const wert = euro(c.value);
        // Guthaben: bis zum Rest, höchstens Warenwert + Versand (Zahlungsmittel); Rabatt: höchstens der Warenwert, Prozent ≤ 100
        const off = rest !== null ? Math.min(rest, wert, Math.round((subtotal + shipping) * 100) / 100)
          : c.type === 'fixed' ? Math.min(wert, subtotal) : subtotal * Math.min(100, wert) / 100;
        // guthaben: Anrechnung eines Guthabens (Gutschrift) — die Rechnung weist das Entgelt dann ohne diesen Abzug aus (USt!)
        coupon = { code: c.code, type: c.type, value: c.value, off: Math.round(off * 100) / 100, ...(isGuthaben(c) ? { guthaben: true } : {}) };
      }
    }
  }
  const total = Math.max(0, Math.round((subtotal + shipping - (coupon?.off || 0)) * 100) / 100);
  return { lines, subtotal, coupon, couponError, shipping, total, aktion, aktionen };
}
function money(v) {
  return v.toLocaleString('de-DE', { style: 'currency', currency: settings.pricing.currency });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  if (res.headersSent) { if (!res.writableEnded) res.end(); return; }   // Antwort ging schon raus (z. B. Fehler nach Hook)
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
/**
 * Body lesen (höchstens limit Bytes). Zu groß → sofort Antwort 413 (JSON) und httpError 413 — eine Route, die Lesefehler selbst
 * abfängt, kann die Antwort danach nicht mehr ändern (send() schreibt nichts mehr). Der Rest des Bodys wird noch angenommen und
 * verworfen (bis 64 MB bzw. 10 s) — sonst ginge die Verbindung mit ungelesenen Daten zu und der Absender sähe nur einen
 * Verbindungsabbruch statt der Meldung. Abgebrochene Anfrage → httpError 400.
 */
const ANTWORTEN = new WeakMap();   // Anfrage → Antwort (readBody beantwortet Überlänge selbst, auch in Routen mit eigenem try/catch)
function readBody(req, limit = MAX_JSON) {
  return new Promise((resolve, reject) => {
    let size = 0, zuGross = false;
    const chunks = [];
    const ablehnen = () => {
      zuGross = true; chunks.length = 0;
      const res = ANTWORTEN.get(req);
      if (res && !res.headersSent) send(res, 413, { ok: false, error: 'Anfrage zu groß' });
      reject(httpError(413, 'Anfrage zu groß'));
      const t = setTimeout(() => req.destroy(), 10000);
      req.once('end', () => clearTimeout(t)); req.once('close', () => clearTimeout(t));
    };
    if (Number(req.headers['content-length']) > limit) ablehnen();
    req.on('data', (c) => {
      size += c.length;
      if (zuGross) { if (size > limit + 64 * 1024 * 1024) req.destroy(); return; }
      if (size > limit) { ablehnen(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!zuGross) resolve(Buffer.concat(chunks)); });
    req.on('error', () => reject(httpError(400, 'Anfrage abgebrochen')));
  });
}
/** JSON-Body als Objekt lesen — kaputtes JSON, leerer Body, null, Liste oder Zahl → httpError 400 „Ungültige Anfrage“ */
async function readJson(req, limit = MAX_JSON) {
  const raw = (await readBody(req, limit)).toString('utf8');
  let v = null;
  try { v = JSON.parse(raw); } catch { /* unten 400 */ }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw httpError(400, 'Ungültige Anfrage');
  return v;
}
/**
 * Schutz-Kopfzeilen für jede Antwort (vor writeHead gesetzt; Routen mit eigenen Werten überschreiben sie, z. B. Belege mit
 * Referrer-Policy no-referrer). Bewusst ohne script-src: Shop und Admin nutzen Inline-Skripte, Inline-Handler und Worker —
 * eine Skript-Richtlinie bräuchte erst deren Umbau. HSTS setzt nginx (nur über HTTPS sinnvoll, deploy/nginx-formsam.conf).
 */
function schutzKopfzeilen(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
}
/** Datumsstempel YYMMDD (UTC) für Bestell- und Widerrufsnummern */
const stampYYMMDD = (d = new Date()) => d.toISOString().slice(2, 10).replace(/-/g, '');
// Bestellnummern: neu „FS-YYMMDD-XXXXXX“; ältere Bestellungen tragen „OV-…“ und bleiben gültig (Routen/Prüfungen akzeptieren beide)
const ORDER_ID_RE = /^(OV|FS)-\d{6}-[A-F0-9]{4,6}$/;
function newOrderId() {
  return `FS-${stampYYMMDD()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Belegnummern (Rechnung RE-…, Gutschrift GS-…) mit automatischem Jahreswechsel
// ---------------------------------------------------------------------------
/** Kalenderjahr in deutscher Zeit — Belegdatum und Nummernkreis richten sich danach, nicht nach der Server-Zeitzone */
const berlinYear = (d = new Date()) => Number(new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric' }).format(d));
/**
 * Jahreswechsel im Nummernkreis: steht im Präfix eine Jahreszahl vor dem aktuellen Jahr („RE-2026-“ im Jahr 2027),
 * wird sie auf das aktuelle Jahr gesetzt und der Zähler beginnt wieder bei 1. Präfixe ohne Jahreszahl oder mit
 * aktuellem/künftigem Jahr bleiben unverändert. Reine Funktion (Datum injizierbar) — vergebene Nummern ändern sich nie.
 * → { prefix, next, gewechselt }
 */
function belegJahreswechsel(prefix, next, now = new Date()) {
  const year = berlinYear(now);
  const p = String(prefix ?? '');
  const n = Math.max(1, Math.round(Number(next)) || 1);
  const m = p.match(/(?<!\d)(?:19|20)\d{2}(?!\d)/);
  if (m && Number(m[0]) < year) return { prefix: p.slice(0, m.index) + year + p.slice(m.index + 4), next: 1, gewechselt: true };
  return { prefix: p, next: n, gewechselt: false };
}
/**
 * Nächste Belegnummer aus settings[prefixKey] + settings[nextKey] ziehen (vierstellig, mit Jahreswechsel) und den Zähler
 * weiterzählen — der Aufrufer speichert die Einstellungen. Synchron, damit parallele Anfragen nie dieselbe Nummer bekommen.
 */
function nextBelegNr(prefixKey, nextKey, fallbackPrefix, now = new Date()) {
  const j = belegJahreswechsel(settings[prefixKey] || fallbackPrefix, settings[nextKey], now);
  if (j.gewechselt) console.log(`🗓️  Nummernkreis ${prefixKey}: Jahreswechsel „${settings[prefixKey]}“ → „${j.prefix}“, Zähler beginnt bei 1`);
  // Sicherheitsnetz: eine Nummer, die schon auf einem Beleg steht, wird nie ein zweites Mal vergeben (§ 14 Abs. 4 Nr. 4 UStG) —
  // auch wenn Präfix oder Zähler zurückgesetzt wurden (alter Admin-Tab, Tippfehler, erneuter Jahreswechsel)
  let n = j.next;
  while (belegeVergeben.has(j.prefix + String(n).padStart(4, '0'))) n++;
  if (n !== j.next) console.warn(`⚠️  Nummernkreis ${prefixKey}: ${j.prefix}${String(j.next).padStart(4, '0')} ist schon vergeben – weiter mit ${j.prefix}${String(n).padStart(4, '0')}`);
  const nr = j.prefix + String(n).padStart(4, '0');
  belegeVergeben.add(nr);
  settings[prefixKey] = j.prefix;
  settings[nextKey] = n + 1;
  return nr;
}
/**
 * Eine gezogene Nummer, die nicht an der Bestellung gespeichert werden konnte (Schreibfehler): zurückgeben, wenn seitdem keine
 * weitere gezogen wurde (dann bekommt der nächste Beleg genau diese Nummer), sonst als Lücke mit Grund protokollieren
 * (settings.belegLuecken, Hinweis in der Admin-Übersicht) — der Nummernkreis bleibt so lückenlos oder begründet.
 */
function belegNrFreigeben(prefixKey, nextKey, nr, grund) {
  const m = /^(.*?)(\d{4,})$/.exec(String(nr));
  if (m && settings[prefixKey] === m[1] && Number(settings[nextKey]) === Number(m[2]) + 1) {
    settings[nextKey] = Number(m[2]);
    belegeVergeben.delete(nr);
    console.warn(`⚠️  Belegnummer ${nr} nicht vergeben (${grund}) – wird als nächste wieder verwendet`);
    return;
  }
  const luecke = { nr: String(nr), at: new Date().toISOString(), grund: String(grund).slice(0, 300) };
  settings.belegLuecken = [...(Array.isArray(settings.belegLuecken) ? settings.belegLuecken : []), luecke].slice(-50);
  console.error(`⚠️  Lücke im Nummernkreis: ${nr} nicht vergeben – ${grund}`);
  saveSettings().catch((err) => console.error('Einstellungen konnten nicht gespeichert werden:', err?.message || err));
}
/**
 * Gerade gezogene Rechnungsnummer festhalten (handleComplete) — Nummernkreis ohne Widersprüche: 1. mit Rechnungsdatum und
 * Steuerstatus an der Bestellung speichern (scheitert das, geht die Nummer zurück bzw. die Lücke wird protokolliert,
 * belegNrFreigeben); 2. Zähler speichern (ein Fehler dort schadet nicht mehr: die Nummer steht an der Bestellung und wird nach
 * einem Neustart übersprungen); danach schreibt handleComplete rechnung.html mit genau dieser Nummer. Ein erneuter Aufruf nach
 * einem Fehler setzt mit derselben Nummer fort. Gutschrift und Stornorechnung richten sich später nach order.steuer.
 * Nichts zu zahlen (Gutschein/Guthaben deckt alles): bezahlt erst jetzt, mit dem Abschluss — eine nie abgeschlossene 0-€-Kasse
 * bleibt „offen“ (nicht in der Druckwarteschlange, wird wie jede abgebrochene Kasse aufgeräumt).
 */
async function rechnungFesthalten(order) {
  const nr = order.invoiceNo, at = new Date().toISOString();
  order.invoiceAt = at;
  order.steuer = steuerJetzt();
  if (typeof order.total === 'number' && order.total <= 0 && order.paymentStatus !== 'bezahlt') {
    order.paymentStatus = 'bezahlt';
    order.paidAt = at;
    addHistory(order, order.status, 'Nichts zu zahlen – Betrag durch Gutschein/Guthaben beglichen', 'system');
  }
  try { await writeOrder(order); } catch (err) {
    belegNrFreigeben('invoicePrefix', 'nextInvoice', nr, `Rechnung zu ${order.orderId}: Bestellung nicht speicherbar (${err?.message || err})`);
    throw err;
  }
  await saveSettings().catch((err) => console.error(`Zähler nach Rechnung ${nr} nicht gespeichert (Nummer steht an der Bestellung):`, err?.message || err));
}
/** Alle ausgestellten Belegnummern (Rechnung, Gutschrift, Storno) — beim Start aus den Bestellungen, danach bei jedem Schreiben */
const belegeVergeben = new Set();
function merkeBelege(o) {
  for (const nr of [o?.invoiceNo, o?.reklamation?.gutschriftNo, o?.storno?.nr]) if (nr) belegeVergeben.add(String(nr));
}
/**
 * Präfix aus einem Admin-Patch prüfen (key 'invoicePrefix' | 'creditPrefix') → { prefix, hinweis } — prefix null = nichts ändern.
 * Leer → das aktuelle bleibt (kein Rückfall auf den festen Standard „…-2026-“). Ergibt das Präfix nach dem Jahreswechsel genau
 * das aktuelle, ist es der Stand eines Admin-Tabs, der vor dem automatischen Wechsel geladen wurde → nicht übernehmen (mit
 * Hinweis), sonst stünde beim nächsten Beleg wieder der Jahreswechsel mit Zähler 1 an. Jede andere Jahreszahl vor dem
 * aktuellen Jahr würde den Zähler ebenfalls auf 1 setzen und Nummern doppelt vergeben → 400.
 */
function belegPraefixAusPatch(key, raw, label) {
  const neu = oneLine(raw, 20);
  if (!neu || neu === settings[key]) return { prefix: null };   // leer oder unverändert (auch ein noch nicht umgestelltes Vorjahres-Präfix)
  const j = belegJahreswechsel(neu, 1);
  if (j.prefix === settings[key]) return { prefix: null, hinweis: `${label} „${neu}“ nicht übernommen – der Nummernkreis steht nach dem Jahreswechsel schon auf „${settings[key]}“.` };
  if (j.gewechselt) throw httpError(400, `${label}: Die Jahreszahl in „${neu}“ liegt vor dem aktuellen Jahr – der Zähler würde neu beginnen und Nummern doppelt vergeben.`);
  return { prefix: neu };
}
// ---------------------------------------------------------------------------
// Admin-Anmeldung: Passwort im Kopf x-admin-key, geprüft gegen settings.adminKeyHash (scrypt) — einmal je Anfrage ganz oben im
// Request-Handler (adminAnmeldung); isAdmin(req) liest danach nur das Ergebnis. Ein richtig geprüftes Passwort merkt sich der
// Server als SHA-256 bis ADMIN_CACHE_MS nach der letzten Anfrage, damit nicht jede Admin-Anfrage scrypt rechnet. Fehlversuche je IP (IPv6: /64) bremsen:
// nach ADMIN_FEHL_IP in 15 Minuten 429 — auch mit richtigem Passwort von dieser IP, sonst ginge das Raten weiter. Gezählt wird
// jede Prüfung schon beim Start (bremsePlatz) und bei richtigem Passwort wieder freigegeben: parallel abgeschickte Versuche zählen
// so sofort, aus einer IP laufen nie mehr als ADMIN_FEHL_IP Prüfungen. Gesamtbremse: liegen insgesamt ADMIN_FEHL_GESAMT Fehlversuche
// im Fenster (verteilter Angriff, mindestens 10 Netze), hat jede IP nur noch einen Fehlversuch frei — wer sich nicht vertippt,
// kommt immer durch. Ist scrypt ausgelastet (scryptAsync), gibt es 429 ohne Zählung.
// ---------------------------------------------------------------------------
const ADMIN_FEHL_IP = 10;
const ADMIN_FEHL_GESAMT = 100;
const ADMIN_CACHE_MS = 5 * 60e3;
const adminCache = new Map();        // SHA-256(Passwort) → gültig bis (ms); leer nach jedem Passwortwechsel
const adminPruefungen = new Map();   // IP|SHA-256(Passwort) → laufende Prüfung (gleichzeitige Anfragen eines Tabs rechnen nur einmal)
const adminAnfragen = new WeakSet(); // Anfragen mit geprüftem Admin-Passwort
/** → 'ok' | 'falsch' | 'gebremst' | 'ohne' (kein Kopf) */
async function adminAnmeldung(req) {
  const k = req.headers['x-admin-key'];
  if (typeof k !== 'string' || !k) return 'ohne';
  const ip = clientIp(req), kIp = `admin-fehl:${ip}`;
  const h = sha256(k), now = Date.now(), schluessel = `${ip}|${h}`;
  // Läuft für dieselbe IP gerade die Prüfung desselben Passworts (Admin lädt mehreres gleichzeitig), wird sie mitgenutzt — das ist
  // kein weiterer Rateversuch; sonst sperrte die Reservierung der ersten Anfrage die zweite (nach Tippfehlern oder bei Gesamtbremse)
  let pruefung = adminPruefungen.get(schluessel);
  if (!pruefung) {
    // Bremse vor dem Cache: sonst käme ein gesperrter Rater mit dem richtigen (gerade gemerkten) Passwort doch durch
    const breit = rateLimitReached('admin-fehl', ADMIN_FEHL_GESAMT);
    if (rateLimitReached(kIp, breit ? 1 : ADMIN_FEHL_IP)) return 'gebremst';
    if (adminCache.get(h) > now) { adminCache.set(h, now + ADMIN_CACHE_MS); adminAnfragen.add(req); return 'ok'; }   // gleitend: 5 min nach der letzten Anfrage
    const tIp = bremsePlatz(kIp, breit ? 1 : ADMIN_FEHL_IP);
    if (!tIp) return 'gebremst';
    const tAlle = bremsePlatz('admin-fehl', ADMIN_FEHL_GESAMT);
    pruefung = (k.length <= 200 ? pwHashStimmt(k, settings.adminKeyHash) : Promise.resolve(false))
      .catch((err) => (err?.code === 'ueberlast' ? null : false))
      .then((stimmt) => {
        if (stimmt !== false) { bremseFrei(kIp, tIp); bremseFrei('admin-fehl', tAlle); }   // richtig oder nicht geprüft → kein Fehlversuch
        else if (rateLimitReached(kIp, ADMIN_FEHL_IP) && !forgotLimited(`admin-warn:${ip}`, 1)) {
          console.warn(`🔐 Admin: ${ADMIN_FEHL_IP} falsche Passwörter von ${ip} – Anmeldung von dort 15 Minuten gesperrt`);
        }
        return stimmt;
      });
    adminPruefungen.set(schluessel, pruefung);
    pruefung.finally(() => adminPruefungen.delete(schluessel));
  }
  const stimmt = await pruefung;
  if (stimmt === null) return 'gebremst';
  if (stimmt) {
    if (adminCache.size > 20) adminCache.clear();
    adminCache.set(h, now + ADMIN_CACHE_MS);
    adminAnfragen.add(req);
    return 'ok';
  }
  return 'falsch';
}
const isAdmin = (req) => adminAnfragen.has(req);

// ---------------------------------------------------------------------------
// Zugriffsschlüssel für Belege und Modelldateien (orders/<ID>/rechnung.html, gutschrift.html, *.stl, *.3mf)
//   Neue Bestellungen bekommen order.accessKey (16 Zufallsbytes, base64url). Die Dateien gibt es nur mit ?k=<accessKey>
//   (Links in Kasse, Mails, Konto, Admin), mit dem Admin-Passwort im Header x-admin-key oder — bei Bestellungen von vor
//   dem Schlüssel (ohne accessKey) — wie bisher allein über die Bestellnummer. Falscher/fehlender Schlüssel → 404 wie bei
//   einer unbekannten Bestellung. Upload und Abschluss in der Kasse (/api/order/<ID>/stl|complete) verlangen den Schlüssel
//   ebenfalls (Header x-order-key), sonst könnte, wer eine Bestellnummer errät, Druckdateien austauschen oder den Link holen.
//   Fehlgriffe (404) auf /orders/ und /api/order/ zählen je IP; nach ORDER_MISS_MAX in 15 Minuten gibt es 429 — außer mit
//   gültigem Schlüssel oder Admin-Header (ein 128-Bit-Schlüssel lässt sich nicht erraten; gebremst wird das Durchprobieren
//   von Bestellnummern). Der Schlüssel steht nie in Logs, im CSV-/JSON-Export oder in öffentlichen APIs.
// ---------------------------------------------------------------------------
const ORDER_MISS_MAX = 20;
const newAccessKey = () => crypto.randomBytes(16).toString('base64url');
const sha256Buf = (s) => crypto.createHash('sha256').update(String(s)).digest();
/** Schlüssel passt zur Bestellung? Vergleich in konstanter Zeit (über SHA-256, damit auch die Länge nichts verrät) */
function accessKeyMatches(order, k) {
  const key = typeof order?.accessKey === 'string' ? order.accessKey : '';
  if (!key || typeof k !== 'string' || !k) return false;
  return crypto.timingSafeEqual(sha256Buf(k), sha256Buf(key));
}
/** Schlüssel aus der Anfrage: Header x-order-key (Kasse) oder ?k= (Links) */
const requestOrderKey = (req, url) => String(req.headers['x-order-key'] || url.searchParams.get('k') || '');
/**
 * Zugriff auf eine Bestellung über ihre Nummer → 'ok' | 'miss' (404) | 'gesperrt' (429).
 * order = gelesene Bestellung oder null (unbekannt/unzulässig); offen(order) = Zugriff ohne Schlüssel erlaubt.
 * Jeder Fehlgriff zählt für die IP-Sperre; Admin-Header und gültiger Schlüssel kommen immer durch.
 */
function orderZugriff(req, url, order, offen) {
  if (isAdmin(req)) return order ? 'ok' : 'miss';   // Admin: weder Sperre noch Zählung
  if (order && accessKeyMatches(order, requestOrderKey(req, url))) return 'ok';
  const key = `order-miss:${clientIp(req)}`;
  if (rateLimitReached(key, ORDER_MISS_MAX)) return 'gesperrt';
  if (order && offen(order)) return 'ok';
  forgotLimited(key, ORDER_MISS_MAX);
  return 'miss';
}
const TOO_MANY = { ok: false, error: 'Zu viele Anfragen – bitte in 15 Minuten noch einmal versuchen.' };
/** Belege/Modelle: ohne Schlüssel nur Altbestand (Bestellungen von vor dem Schlüssel) */
const dateiOffen = (o) => !o.accessKey;
/**
 * Kasse (Upload/Abschluss): ohne Schlüssel nur Altbestand und — bis zum Abschluss — Bestellungen aus einem Shop-Tab, der vor
 * der Umstellung geladen wurde (cart.js ohne Schlüssel, order.kasseOhneSchluessel). Kann nach der Übergangszeit entfallen.
 */
const kasseOffen = (o) => !o.accessKey || (o.kasseOhneSchluessel === true && !o.completedAt);
/** Relativer Link auf eine Datei der Bestellung (Rechnung, Gutschrift, Modell) — mit ?k=, sobald die Bestellung einen Schlüssel hat */
function orderFileUrl(order, file) {
  const u = `/orders/${encodeURIComponent(order.orderId)}/${encodeURIComponent(file)}`;
  return order.accessKey ? `${u}?k=${encodeURIComponent(order.accessKey)}` : u;
}
/** Bestellung ohne Zugriffsschlüssel (JSON-Backup): der Schlüssel ist ein Geheimnis wie das Admin-Passwort */
const ohneSchluessel = (o) => { const { accessKey, ...rest } = o || {}; return rest; };

async function readOrder(id) {
  return normalizeOrder(JSON.parse(await readFile(path.join(ORDERS, id, 'order.json'), 'utf8')));
}
// Lesen-Ändern-Schreiben je Bestellung serialisieren, damit parallele Requests (Admin-Klicks, Mail-Hooks
// nach der Antwort) einander nicht überschreiben:  const release = await lockOrder(id); try { … } finally { release(); }
const orderLocks = new Map();
function lockOrder(id) {
  const prev = orderLocks.get(id) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  orderLocks.set(id, chain);
  return prev.then(() => () => {
    release();
    if (orderLocks.get(id) === chain) orderLocks.delete(id);
  });
}
/**
 * Migration beim Lesen (ohne Schreiben): Bestellhistorie, Druckstatus je Position,
 * Versandfelder. Sehr alte Bestellungen (Einzelmodell ohne `lines`) bekommen eine
 * synthetische Position, damit Admin und Druckzettel sie einheitlich anzeigen können.
 */
function normalizeOrder(order) {
  if (!order || typeof order !== 'object') return order;
  if (!order.status) order.status = 'neu';
  if (!order.payment) order.payment = 'vorkasse';
  if (!order.paymentStatus) order.paymentStatus = 'offen';
  if (!order.customer && (order.name || order.email)) {
    order.customer = { name: order.name || '', email: order.email || '', street: '', zip: '', city: '', note: order.notes || '' };
  }
  if (!Array.isArray(order.lines)) {
    order.lines = order.config ? [{
      product: order.config.product || 'eierbecher', qty: order.qty || 1, saucer: !!order.config.saucer,
      config: order.config, colorName: order.colorName || order.config.colorName || '',
      stlFile: order.stlFile || '', legacy: true,
    }] : [];
  }
  for (const l of order.lines) {
    if (!l.print || !PRINT_STATES.includes(l.print.status)) l.print = { status: 'offen' };
  }
  if (order.carrier === undefined) order.carrier = '';
  if (order.paidAt === undefined) order.paidAt = null;
  if (order.shippedAt === undefined) order.shippedAt = null;
  if (order.trackingNo === undefined) order.trackingNo = '';
  if (order.adminNote === undefined) order.adminNote = '';
  if (order.completedAt === undefined) order.completedAt = null;   // Zeitpunkt des (ersten) /complete
  if (!order.mailsSent || typeof order.mailsSent !== 'object') order.mailsSent = {};   // { bestaetigung|Status|reklamation:<Phase>: ISO }
  if (!order.reklamation || typeof order.reklamation !== 'object') order.reklamation = null;   // Reklamation/Rückversand/Gutschrift
  if (!Array.isArray(order.widerrufe)) order.widerrufe = [];   // [{ ref, at }] — Widerrufe über die Widerrufsfunktion, deren E-Mail zur Bestellung passte
  if (!order.aktion || typeof order.aktion !== 'object') order.aktion = null;   // { id, name, prozent, ersparnis } — Bestellungen vor den Aktionen: null
  if (!Array.isArray(order.aktionen)) order.aktionen = [];   // alle betroffenen Aktionen (Format wie aktion + produkte/muster) — ältere Bestellungen: [] (orderAktionen() fällt auf aktion zurück)
  if (!Array.isArray(order.history)) {
    order.history = [{ at: order.createdAt, status: 'neu', note: 'Bestellung eingegangen', by: 'system' }];
    if (order.payment === 'paypal' && order.paymentStatus === 'bezahlt') {
      order.history.push({ at: order.createdAt, status: 'neu', note: 'Zahlung per PayPal', by: 'kunde' });
    }
    if (order.status !== 'neu') {
      order.history.push({ at: order.createdAt, status: order.status, note: 'Status nachgetragen (vor Einführung der Historie)', by: 'admin' });
    }
  }
  return order;
}
function addHistory(order, status, note, by = 'admin') {
  if (!Array.isArray(order.history)) order.history = [];
  const entry = { at: new Date().toISOString(), status, by };
  if (note) entry.note = String(note).slice(0, 300);
  order.history.push(entry);
  return entry;
}
/** Setzt den Bestellstatus inkl. Historie und Zeitstempeln; liefert true, wenn sich etwas geändert hat. */
function setOrderStatus(order, status, note, by = 'admin') {
  if (!STATUSES.includes(status) || order.status === status) return false;
  order.status = status;
  if (status === 'bezahlt' && order.paymentStatus !== 'bezahlt') {
    order.paymentStatus = 'bezahlt';
    order.paidAt = order.paidAt || new Date().toISOString();
  }
  if (status === 'versendet') order.shippedAt = new Date().toISOString();
  addHistory(order, status, note || `Status → ${STATUS_LABELS[status]}`, by);
  return true;
}
const orderIsPaid = (o) => o.status === 'bezahlt' || (o.status === 'neu' && o.paymentStatus === 'bezahlt');
// Atomar (Temp-Datei + rename): ein paralleles listOrders()/readOrder() sieht nie eine halb geschriebene Datei
async function writeOrder(order) {
  // writeFileAtomic räumt die Temp-Datei auf, wenn Schreiben oder Umbenennen scheitert
  await writeFileAtomic(path.join(ORDERS, order.orderId, 'order.json'), JSON.stringify(order, null, 2));
  trackCouponUse(order);
  merkeBelege(order);
}

// ---------------------------------------------------------------------------
// Guthaben-Gutscheine (Gutschrift aus einer Reklamation: coupon.guthaben = true, Typ „fixed“): ein Betrag, der über
// mehrere Bestellungen aufgebraucht wird — ohne das wäre ein Erstattungs-Code beliebig oft einlösbar. Eingelöst ist, was
// nicht stornierte Bestellungen mit diesem Code abgezogen haben; die Zahl kommt aus den Bestelldateien (beim Start
// eingelesen, bei jedem writeOrder aktualisiert) — ein veralteter Admin-Stand kann den Gutschein so nicht „auffüllen“.
// Fest eingelöst ist eine Bestellung erst mit dem Abschluss der Kasse (completedAt bzw. Rechnungsnummer) oder bezahlt
// (PayPal); eine angelegte, aber nie abgeschlossene Kasse (Upload fehlgeschlagen, Tab geschlossen) hält den Betrag nur
// GUTHABEN_RESERVIERUNG_MS lang fest — sonst wäre das Guthaben blockiert, bis jemand die verwaiste Bestellung storniert.
// Der Abschluss prüft danach noch einmal (handleComplete), ob der Betrag inzwischen anderweitig eingelöst wurde.
// Normale Rabattcodes (OSTERN10 …) bleiben unbegrenzt einlösbar.
// ---------------------------------------------------------------------------
const GUTHABEN_RESERVIERUNG_MS = 2 * 3600e3;
const couponUse = new Map();   // CODE (groß) → Map(orderId → { off, fest, at })
function trackCouponUse(order) {
  const id = order?.orderId;
  if (!id) return;
  for (const m of couponUse.values()) m.delete(id);
  const code = String(order.coupon?.code || '').trim().toUpperCase();
  if (!code || order.status === 'storniert') return;
  if (!couponUse.has(code)) couponUse.set(code, new Map());
  couponUse.get(code).set(id, {
    off: Number(order.coupon.off) || 0,
    // bezahlt zählt nur mit echtem Betrag (PayPal) — eine Bestellung über 0 € (Guthaben deckt alles) hält es bis zum Abschluss nur fest
    fest: !!order.completedAt || !!order.invoiceNo || (order.paymentStatus === 'bezahlt' && Number(order.total) > 0),
    at: Date.parse(order.createdAt) || Date.now(),
    email: String(order.customer?.email || '').trim().toLowerCase() || null,   // Kundin (maxEinloesungen: eigene Reservierungen zählen nicht)
  });
}
/** Einlösung aus couponUse entfernen (z. B. die Reservierung einer PayPal-Kasse, sobald die Bestellung sie übernimmt) */
const untrackCouponUse = (id) => { for (const m of couponUse.values()) m.delete(id); };
const isGuthaben = (c) => !!c?.guthaben && c.type === 'fixed';
/**
 * Gutschein-Liste aus dem Admin übernehmen, ohne Guthaben zu verlieren: Guthaben-Codes (guthaben: true) legt nur der Server an
 * (Reklamation „gutschein“ erledigen). Ein Admin-Tab, der vor der Gutschrift geladen wurde, kennt den neuen Code nicht — fehlt er
 * im Patch, bleibt er trotzdem stehen. Löschen nur ausdrücklich über loeschen (Codes aus dem 🗑 des Admins).
 * Kommt ein Guthaben-Code im Patch vor, bleiben die vom Server gesetzten Felder (Code, Art, Wert, Notiz) — aus dem Admin kommt nur
 * „aktiv“ (Mindestbestellwert 0 und „mit Aktion“ erzwingt gutscheineAus; der Admin zeigt beides nicht änderbar). Ein Eintrag mit
 * guthaben: true, den der Server nicht als Guthaben kennt (umbenannt, veralteter Tab nach dem Löschen), wird verworfen — sonst
 * entstünde neues Guthaben ohne Gutschrift.
 */
function mergeCoupons(alt, neu, loeschen) {
  const key = (x) => String(x ?? '').trim().toUpperCase();
  const weg = new Set((Array.isArray(loeschen) ? loeschen : []).map(key));
  const guthaben = new Map((alt || []).filter((c) => c && typeof c === 'object' && c.guthaben && !weg.has(key(c.code))).map((c) => [key(c.code), c]));
  const out = [], drin = new Set();
  for (const c of neu) {
    if (!c || typeof c !== 'object') continue;
    const k = key(c.code), g = guthaben.get(k);
    if (g) {
      if (drin.has(k)) continue;   // doppelt im Patch → einmal
      out.push({ ...c, code: g.code, type: g.type, value: g.value, guthaben: true, ...(g.note !== undefined ? { note: g.note } : {}) });
    } else if (c.guthaben) continue;
    else out.push(c);
    drin.add(k);
  }
  for (const [k, g] of guthaben) if (!drin.has(k)) out.push(g);
  return out;
}
/** Gutschein aus den Einstellungen zu einem Code (ohne Groß/Klein, ohne active-Prüfung) oder null */
const couponByCode = (code) => (settings.coupons || []).find((x) => String(x?.code || '').trim().toUpperCase() === String(code || '').trim().toUpperCase()) || null;
/**
 * Restwert eines Guthaben-Gutscheins: Wert − Summe der zählenden Einlösungen (fest oder jünger als das Reservierungsfenster),
 * auf Cent, nie negativ. ohne = orderId, deren eigene Einlösung nicht mitzählt (Nachprüfung beim Abschluss).
 */
function couponRest(c, { ohne = null } = {}) {
  const now = Date.now();
  let used = 0;
  for (const [id, e] of couponUse.get(String(c?.code || '').trim().toUpperCase()) || []) {
    if (id !== ohne && (e.fest || now - e.at < GUTHABEN_RESERVIERUNG_MS)) used += e.off;
  }
  return Math.max(0, Math.round(((Number(c?.value) || 0) - used) * 100) / 100);
}
/**
 * Zählende Einlösungen eines Codes für maxEinloesungen normaler Gutscheine: feste (abgeschlossen bzw. per PayPal bezahlt) und
 * Reservierungen offener Kassen anderer Kundinnen, jünger als GUTHABEN_RESERVIERUNG_MS. Reservierungen derselben E-Mail-Adresse
 * zählen nicht — eine eigene gescheiterte Kasse (Upload abgebrochen, Seite neu geladen, Adresse geändert) sperrte sonst 2 Stunden;
 * dass dieselbe Kundin den Code so nicht doppelt bekommt, prüft handleComplete beim Abschluss. email = null (Vorschau /api/quote,
 * Kundin noch unbekannt): nur feste. ohne = orderId, die nicht mitzählt (Nachprüfung beim Abschluss).
 */
function couponEinloesungen(c, { ohne = null, email = null, paypalEigene = false } = {}) {
  const now = Date.now(), mail = String(email || '').trim().toLowerCase();
  let n = 0;
  for (const [id, e] of couponUse.get(String(c?.code || '').trim().toUpperCase()) || []) {
    // paypalEigene (Abschluss): auch eigene laufende PayPal-Zahlungen zählen — sie werden nach dem Einzug ohne weitere
    // Gutschein-Prüfung zur Bestellung (Preisgarantie), eine eigene offene Vorkasse-Kasse dagegen nicht
    const offen = now - e.at < GUTHABEN_RESERVIERUNG_MS && mail && (e.email !== mail || (paypalEigene && id.startsWith('paypal:')));
    if (id !== ohne && (e.fest || offen)) n++;
  }
  return n;
}
/**
 * Darf diese Bestellung ihren Gutschein bzw. ihr Guthaben jetzt fest einlösen? → null oder { code, note, error } (409).
 * Guthaben: Rest ohne diese Bestellung reicht noch. Höchstzahl (maxEinloesungen): feste Einlösungen, offene Kassen anderer
 * Kundinnen und laufende PayPal-Zahlungen (auch eigene) — handleComplete prüft das unmittelbar vor der Rechnungsnummer und
 * vermerkt die Einlösung im selben Schritt als fest (trackCouponUse), damit ein gleichzeitiger Abschluss einer zweiten Kasse
 * sie schon sieht. Per PayPal bezahlte Bestellungen sind schon fest (Einzug nach der Prüfung in /api/paypal/create).
 */
function einloesungGesperrt(order) {
  if (!order.coupon || (order.paymentStatus === 'bezahlt' && Number(order.total) > 0) || order.status === 'storniert') return null;
  const gc = couponByCode(order.coupon.code);
  if (!gc) return null;
  if (isGuthaben(gc)) {
    if (couponRest(gc, { ohne: order.orderId }) + 0.005 >= euro(order.coupon.off)) return null;
    return { code: 'guthaben', note: `Kasse abgebrochen: Guthaben „${gc.code}“ wurde inzwischen anderweitig eingelöst`,
      error: `Dein Guthaben „${gc.code}“ wurde inzwischen eingelöst – bitte starte die Kasse neu.` };
  }
  if (gc.maxEinloesungen > 0 && !order.invoiceNo
    && couponEinloesungen(gc, { ohne: order.orderId, email: order.customer?.email, paypalEigene: true }) >= gc.maxEinloesungen) {
    return { code: 'gutschein', note: `Kasse abgebrochen: Gutschein „${gc.code}“ ist inzwischen vergeben (höchstens ${gc.maxEinloesungen}-mal einlösbar)`,
      error: `Der Gutschein „${gc.code}“ ist inzwischen vergeben – bitte starte die Kasse neu.` };
  }
  return null;
}
/** Heutiges Datum in deutscher Zeit als „JJJJ-MM-TT“ (Vergleich mit gueltigBis eines Gutscheins) */
const heuteBerlin = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(d);
/** Restwerte aller Guthaben-Gutscheine { CODE: Rest } für den Admin */
const guthabenRest = () => Object.fromEntries(settings.coupons.filter(isGuthaben).map((c) => [String(c.code).trim().toUpperCase(), couponRest(c)]));
/** Beim Start: Guthaben-Einlösungen und vergebene Belegnummern aus allen Bestellungen einlesen */
async function loadCouponUse() {
  for (const o of await listOrders()) { trackCouponUse(o); merkeBelege(o); }
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/**
 * Bezeichnung einer Position (Rechnung, CSV); mitAktion: „Aktion „Name“ −16 % (Normalpreis 24,90 €)“ anhängen — die Rechnung zeigt das als eigene Zeile.
 * mitAufpreis = false: „· Aufpreis Farbe/…“ weglassen — die Rechnung nennt die Aufpreise mit Beträgen in der Hinweiszeile darunter.
 */
function itemLabel(it, { mitAktion = false, mitAufpreis = true } = {}) {
  const c = it.config || {};
  const sur = surchargeList(it).filter((x) => x.key !== 'gravur').map((x) => x.label);
  const patt = { glatt: 'Glatt', rippen: 'Rippen', wellen: 'Wellen', zickzack: 'Zickzack', querwellen: 'Querwellen', lamellen: 'Lamellen', gehaemmert: 'Gehämmert', skelett: 'Voronoi', koralle: 'Fjordwelle' }[c.pattern] || c.pattern;
  return `${it.product === 'vase' ? 'Vase' : 'Eierbecher'} „${PRESET_LABELS[c.preset] || c.preset || ''}“ · ${patt}` +
    ` · ${c.height} mm · ${it.colorName || ''}` +
    (c.text ? ` · Gravur „${c.text}“${{ gehaemmert: ' (gehämmert)', gestanzt: ' (gestanzt)', kissen: ' (Kissen)', farbe: ` (Farbschrift${it.textColorName ? ' ' + it.textColorName : ''} – 3MF, 2 Filamente)` }[c.textStyle] || ''}` : '') +
    (c.rim && c.rim !== 'glatt' && RIM_LABELS[c.rim] ? ` · ${RIM_LABELS[c.rim]}` : '') +
    (it.saucer ? ' · mit Untersetzer' : '') +
    (it.code ? ` · Design-Code ${it.code}` : '') +
    // Aufpreise (Muster/Farbschrift/Farbe) nur wenn > 0 — Gravur/Untersetzer stehen schon im Label
    (mitAufpreis && sur.length ? ` · Aufpreis ${sur.join('/')}` : '') +
    (mitAktion && it.aktionProzent > 0 ? ` · Aktion${it.aktionName ? ` „${it.aktionName}“` : ''} −${it.aktionProzent} % (Normalpreis ${money(it.uvp)})` : '');
}

// Anzeigenamen für Druckzettel & Admin (Spiegel der Client-Labels)
const PATTERN_LABELS = { glatt: 'Glatt', rippen: 'Rippen', wellen: 'Wellen', zickzack: 'Zickzack', querwellen: 'Querwellen', lamellen: 'Lamellen', gehaemmert: 'Gehämmert', skelett: 'Voronoi', koralle: 'Fjordwelle' };
const PRESET_LABELS = { flasche: 'Flasche', kugel: 'Kugel', tropfen: 'Tropfen', zylinder: 'Zylinder', kurve: 'Kurve', kelch: 'Kelch', schale: 'Schale', tulpe: 'Tulpe', eigene: 'Eigene Form' };
const FONT_LABELS = { helvetiker: 'Modern', optimer: 'Soft', gentilis: 'Fein', droid_sans: 'Kräftig', droid_serif: 'Klassisch', marcellus: 'Edel', greatvibes: 'Kalligrafie' };
const TEXT_STYLE_LABELS = { gestanzt: 'Gestanzt', gepraegt: 'Geprägt', gehaemmert: 'Gehämmert', kissen: 'Kissen', farbe: 'Farbschrift' };
const FLOW_LABELS = { spirale: 'Spirale', gegen: 'Gegenläufig', fluss: 'Wellenfluss', zick: 'Zickzack' };
function colorByRef(id, name) {
  const cols = settings.colors || [];
  return (id && cols.find((c) => c.id === id)) || (name && cols.find((c) => c.name === name)) || null;
}
// Farbwerte aus der Bestellung (config.colorHex kommt vom Kunden) nur als echte Hex-Farbe in style-Attribute lassen
const safeHex = (h) => (/^#[0-9a-f]{3,8}$/i.test(String(h || '')) ? h : '#cccccc');

// ---------------------------------------------------------------------------
// Belege im formsam-Look (Rechnung, Gutschrift, Druckzettel): gemeinsamer Kopf (Wort-Bild-Marke + Absender),
// Fußzeile und Druck-CSS (A4, @page-Rand 14 mm). Schriften kommen vom eigenen Server (/fonts), sonst Georgia bzw.
// system-ui — keine externen Ressourcen. Rechnung und Gutschrift sind statische Dateien in orders/<ID>/ und werden
// nach dem Ausstellen nie neu geschrieben (ältere Belege behalten ihr altes Aussehen).
// ---------------------------------------------------------------------------
const BRAND = 'formsam';
const TZ = 'Europe/Berlin';
/** Datum in deutscher Zeit („27.9.2026“) — Belege zeigen das Datum, an dem sie in Deutschland ausgestellt wurden */
const dateDE = (iso) => new Date(iso || Date.now()).toLocaleDateString('de-DE', { timeZone: TZ });
/**
 * Wort-Bild-Marke aus public/img/brand/formsam-logo.svg (Vektor aus Julians Entwurf: Terrakotta-Zeichen + Schriftzug in Tinte,
 * fill-rule evenodd) — einmal beim Start gelesen und als Inline-SVG eingebettet; fehlt die Datei, steht die Wortmarke als Text.
 */
const LOGO_SVG = (() => {
  try {
    const raw = readFileSync(path.join(PUBLIC, 'img', 'brand', 'formsam-logo.svg'), 'utf8');
    const vb = raw.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    const paths = [...raw.matchAll(/<path\b[^>]*\/>/g)].map((m) => m[0]);
    return vb && paths.length ? { w: Number(vb[1]), h: Number(vb[2]), paths: paths.join('') } : null;
  } catch { return null; }
})();
function logoHTML(height = 34) {
  if (!LOGO_SVG) return `<span class="wortmarke">${BRAND}</span>`;
  const w = Math.round((LOGO_SVG.w / LOGO_SVG.h) * height * 10) / 10;
  return `<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LOGO_SVG.w} ${LOGO_SVG.h}" width="${w}" height="${height}" role="img" aria-label="${BRAND}"><title>${BRAND}</title>${LOGO_SVG.paths}</svg>`;
}
/** Öffentlicher Host für Fußzeilen: aus mail.publicUrl (wenn gesetzt), sonst die Hauptadresse (www.formsam.com → formsam.com) */
function publicHost() {
  const u = String(settings.mail?.publicUrl || '').trim();
  try { if (/^https?:\/\//i.test(u)) return new URL(u).host.replace(/^www\./, ''); } catch { /* ungültig → Standard */ }
  return new URL(HAUPTADRESSE).host.replace(/^www\./, '');
}
/** „00000 Musterstadt“ + Land (nur außerhalb Deutschlands) */
function companyOrt(co) {
  const land = String(co.country || '').trim();
  return [[co.zip, co.city].filter(Boolean).join(' '), land && land !== 'Deutschland' ? land : ''].filter(Boolean).join(', ');
}
/** Text maskiert, Leerzeichen geschützt (Telefonnummer, IBAN) — bricht nie mitten in der Nummer um */
const nbspAlle = (v) => esc(v).replace(/ /g, '&nbsp;');
/**
 * Geschützte Leerzeichen zwischen Zahl und Einheit („150&nbsp;mm“, „19&nbsp;%“, „14&nbsp;Tagen“, „50&nbsp;°C“) in fertig maskiertem
 * Beleg-Text — nur neue Belege; der Satz und der Browser-Druck trennen Zahl und Einheit dann nicht mehr
 */
const einheitNbsp = (html) => String(html).replace(/(\d) (?=(?:mm|cm|%|€|°C|Stück|Werktag(?:en?)?|Tag(?:en?)?|Wochen?|Monat(?:en?)?)(?![\p{L}\d]))/gu, '$1&nbsp;');
/** Absenderblock rechts im Kopf (zweispaltig, damit der Kopf flach bleibt): Marke, Inhaber (voller Name), Anschrift | Kontakt, Steuernummer/USt-IdNr. */
function belegAbsender(co) {
  const adresse = [`<b>${esc(co.name || BRAND)}</b>`, esc(co.owner), esc(co.street), esc(companyOrt(co))].filter(Boolean);
  const kontakt = [
    co.email ? esc(co.email) : '', co.phone ? `Tel.&nbsp;${nbspAlle(co.phone)}` : '',
    co.steuerNr ? `Steuernummer ${esc(co.steuerNr)}` : '', co.ustId ? `USt-IdNr. ${esc(co.ustId)}` : '',
  ].filter(Boolean);
  return `<div class="absender"><div>${adresse.join('<br>')}</div>${kontakt.length ? `<div class="kontakt">${kontakt.join('<br>')}</div>` : ''}</div>`;
}
/** Rücksendezeile über der Empfängeranschrift (klein) */
const belegRuecksende = (co) => [co.name || BRAND, co.owner, co.street, companyOrt(co)].map((x) => String(x || '').trim()).filter(Boolean).map(esc).join(' · ');
/** Fußzeile: formsam · Inhaber · Anschrift · E-Mail · Web-Adresse */
function belegFuss(co) {
  const parts = [co.name || BRAND, co.owner, [co.street, companyOrt(co)].filter(Boolean).join(', '), co.email, publicHost()];
  return `<footer class="fuss">${parts.map((x) => String(x || '').trim()).filter(Boolean).map(esc).join(' · ')}</footer>`;
}
// Neue Belege: Positionstabelle mit <thead> (wiederholt sich im Druck/PDF auf Folgeseiten), Beträge rechtsbündig (.pos .r). Auf dem
// Handy (≤ 640 px, nur Bildschirm) stehen die Positionen als Karten — Bezeichnung, darunter „Menge × Einzelpreis · Rabatt · Summe“,
// nichts ragt über den Rand; den „@media screen“-Block übergeht der PDF-Satz (er setzt für den Druck)
const BELEG_CSS = `
    @font-face{font-family:'Fraunces';src:url(/fonts/fraunces-latin.woff2) format('woff2');font-weight:400 700;font-display:swap}
    @font-face{font-family:'Inter';src:url(/fonts/inter-latin.woff2) format('woff2');font-weight:100 900;font-display:swap}
    @page{size:A4;margin:14mm}
    *{box-sizing:border-box}
    html{background:#f4efe7}
    body{margin:0;padding:22px 16px 40px;font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#211d18;font-size:13px;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .blatt{background:#fff;max-width:210mm;margin:0 auto;padding:15mm 15mm 11mm;border-radius:4px;box-shadow:0 1px 3px rgba(33,29,24,.08),0 14px 36px rgba(33,29,24,.08)}
    .leiste{max-width:210mm;margin:0 auto 14px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
    .leiste button{font:inherit;font-weight:600;padding:10px 22px;border-radius:999px;border:none;background:#211d18;color:#f4efe7;cursor:pointer}
    .leiste a{color:#9e4f2c}
    .kopf{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:12px;border-bottom:1px solid #e6ddd0}
    .logo{display:block;height:34px;width:auto;margin-top:2px}
    .wortmarke{font-family:Fraunces,Georgia,serif;font-size:30px;line-height:1}
    .absender{display:flex;gap:22px;font-size:11px;line-height:1.5;color:#4a433b}
    .absender b{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:12.5px;color:#211d18}
    .absender .kontakt{padding-top:1px}
    .anschrift{display:flex;justify-content:space-between;align-items:flex-start;gap:28px;margin:18px 0 14px}
    .empfaenger{min-width:0;font-size:13px}
    .ruecksende{font-size:9px;color:#6b6257;border-bottom:1px solid #e6ddd0;padding-bottom:2px;margin-bottom:7px}
    table.meta{border-collapse:collapse;font-size:12px}
    .meta th{text-align:left;font-weight:400;color:#6b6257;padding:1px 16px 1px 0;white-space:nowrap;vertical-align:top}
    .meta td{text-align:right;padding:1px 0;font-weight:600;white-space:nowrap}
    .meta td small{display:block;font-weight:400;color:#6b6257;font-size:10px}
    h1{font-family:Fraunces,Georgia,serif;font-weight:500;font-size:24px;line-height:1.15;margin:0;letter-spacing:-.01em}
    .muted{color:#6b6257}
    table.pos{width:100%;border-collapse:collapse;margin:10px 0 4px}
    .pos th,.pos td{padding:4px 7px;border-bottom:1px solid #e6ddd0;text-align:left;vertical-align:top;line-height:1.38}
    .pos th{font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#6b6257;border-bottom:1.5px solid #211d18}
    .pos td{font-size:12px}
    .pos td small{font-size:10.5px}
    .r{text-align:right;white-space:nowrap}
    .pos .r{text-align:right}
    table.summen{width:100%;max-width:470px;margin:0 0 0 auto;border-collapse:collapse}
    .summen td{padding:2px 7px;font-size:12.5px}
    .summen .grand td{font-weight:700;font-size:14.5px;border-top:1.5px solid #211d18;padding-top:6px}
    .summen .fein td{font-size:11px;color:#6b6257;padding-top:1px;padding-bottom:1px}
    .summen .zahl td{font-weight:700;border-top:1px solid #e6ddd0;padding-top:5px}
    .steuer{margin:10px 0 0;font-size:11.5px;color:#4a433b}
    .zahlung{margin-top:10px;padding:9px 14px;background:#f4efe7;border-left:3px solid #c86f4a;border-radius:0 8px 8px 0;font-size:12px}
    .zahlung table{border-collapse:collapse;margin-top:4px}
    .zahlung th{font-weight:400;color:#6b6257;text-align:left;padding:0 12px 0 0;white-space:nowrap}
    .zahlung td{font-weight:600;padding:0 28px 0 0}
    .dank{margin:12px 0 0;font-size:12.5px}
    .akzent{color:#9e4f2c}
    .nm{text-transform:none;letter-spacing:0}
    .klein{font-size:10px;line-height:1.4;color:#6b6257;margin:6px 0 0}
    .fuss{margin-top:14px;padding-top:6px;border-top:1px solid #e6ddd0;font-size:9.5px;color:#6b6257;text-align:center}
    @media print{html{background:none}body{padding:0;font-size:12px}.blatt{max-width:none;padding:0;box-shadow:none;border-radius:0}.leiste{display:none}
      h1{font-size:22px}.empfaenger{font-size:12.5px}.pos td{font-size:11.5px}.pos td small{font-size:10px}.summen td{font-size:12px}.summen .grand td{font-size:14px}.dank{font-size:12px}}
    @media (max-width:640px){.blatt{padding:18px}.kopf,.anschrift,.absender{flex-direction:column}.absender{gap:6px}.zahlung tr{display:flex;flex-wrap:wrap}}
    @media screen and (max-width:640px){.posten thead{display:none}.posten,.posten tbody{display:block}
      .posten tr{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;padding:7px 0;border-bottom:1px solid #e6ddd0}
      .posten td{padding:0;border:0}.posten .nr{flex:0 0 1.2em}.posten .art{flex:1 1 calc(100% - 1.2em - 11px);min-width:0;overflow-wrap:anywhere}
      .posten .menge{margin-left:calc(1.2em + 10px)}.posten .menge::after{content:' ×'}.posten .rabatt::before{content:'Rabatt '}.posten .leer{display:none}
      .posten .summe{margin-left:auto;font-weight:600}}`;
/**
 * Komplettes Beleg-Dokument: Knopfleiste (nur Bildschirm) + Blatt mit Kopf, Inhalt und Fußzeile.
 * pdf = Datei der PDF-Fassung (rechnung.pdf …): Leiste „Drucken“ + „PDF herunterladen“ — den Zugriffsschlüssel (?k=…) nimmt
 * der Link aus der Adresse der Seite, in der gespeicherten Datei steht er nie
 */
function belegSeite({ title, co, body, css = '', leiste = '<button type="button" onclick="print()">Drucken / als PDF speichern</button>', logoHeight = 34, pdf = '' }) {
  if (pdf) leiste = `<button type="button" onclick="print()">Drucken</button> <a id="pdf-link" href="${esc(pdf)}">PDF herunterladen</a><script>document.getElementById('pdf-link').search=location.search</script>`;
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>${BELEG_CSS}${css}</style></head><body>
  <div class="leiste noprint">${leiste}</div>
  <main class="blatt">
  <header class="kopf"><div class="marke">${logoHTML(logoHeight)}</div>${belegAbsender(co)}</header>
  ${body}
  ${belegFuss(co)}
  </main>
  </body></html>`;
}
/** Brutto → { netto, ust } bei 19 % Umsatzsteuer, auf Cent gerundet — netto + ust ergibt exakt den Bruttobetrag */
function ustAus(brutto, satz = 19) {
  const c = Math.round((Number(brutto) || 0) * 100);
  const n = Math.round(c / (1 + satz / 100));
  return { netto: n / 100, ust: (c - n) / 100 };
}
/**
 * Leistungszeitpunkt als Kalendermonat (§ 31 Abs. 4 UStDV): Rechnungsdatum + längste Lieferzeit aus settings.shop.lieferzeit
 * („5–8 Werktage“ → 8 Werktage Mo–Fr, „2 Wochen“, „10 Tage“) → „Oktober 2026“. Ohne Zahl: Monat des Rechnungsdatums.
 */
function lieferMonat(fromIso, lieferzeit) {
  const d = new Date(fromIso || Date.now());
  const lz = String(lieferzeit || '');
  const nums = lz.match(/\d+/g);
  const n = nums ? Math.max(...nums.map(Number)) : 0;
  if (n > 0 && n <= 366) {
    if (/woche/i.test(lz)) d.setUTCDate(d.getUTCDate() + n * 7);
    else if (/werktag|arbeitstag/i.test(lz)) {
      for (let k = n; k > 0;) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) k--; }
    } else d.setUTCDate(d.getUTCDate() + n);
  }
  return d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: TZ });
}

// ---------------------------------------------------------------------------
// Druckzettel (A4, schwarz/weiß-tauglich) — GET /admin/druckzettel/<ID> mit Kopf x-admin-key
// ---------------------------------------------------------------------------
function druckzettelHTML(order) {
  const cu = order.customer || {};
  const dt = (iso) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }) : '—');
  const rows = order.lines.map((l, i) => {
    const c = l.config || {};
    const body = colorByRef(c.color, l.colorName);
    const bodyHex = safeHex(body?.hex || c.colorHex || '#ffffff');
    const bodyName = l.colorName || body?.name || '—';
    const finish = { matt: 'matt', glanz: 'glänzend', metall: 'metallic' }[body?.finish || c.colorFinish] || '';
    const hasText = !!String(c.text || '').trim();
    const txtCol = c.textStyle === 'farbe' ? colorByRef(c.textColor, l.textColorName) : null;
    const flow = (c.twist && c.pattern !== 'glatt' && c.pattern !== 'querwellen') ? ` · Verlauf ${FLOW_LABELS[c.flow] || 'Spirale'} ${c.twist}` : '';
    const gravur = hasText
      ? `<b>„${esc(c.text)}“</b><br>${esc(TEXT_STYLE_LABELS[c.textStyle] || c.textStyle || 'Gestanzt')} · Schrift ${esc(FONT_LABELS[c.font] || c.font || 'Modern')} · ${esc(c.textSize ?? '')} mm`
        + (c.textStyle === 'farbe' ? `<br><span class="sw" style="background:${esc(safeHex(txtCol?.hex || '#000'))}"></span> Schriftfarbe ${esc(txtCol?.name || l.textColorName || c.textColor || '?')} (2. Filament)` : '')
      : '<span class="muted">keine</span>';
    const file = l.stlFile ? `${esc(l.stlFile)}${/\.3mf$/i.test(l.stlFile) ? ' <small>(3MF, 2 Filamente)</small>' : ''}` : '—';
    const pr = l.print || { status: 'offen' };
    return `<tr>
      <td class="c"><span class="box ${pr.status === 'fertig' ? 'x' : ''}"></span></td>
      <td class="c big">${l.qty}×</td>
      <td><b>${l.product === 'vase' ? 'Vase' : 'Eierbecher'} „${esc(PRESET_LABELS[c.preset] || c.preset || '')}“</b>${l.saucer ? '<br>+ Untersetzer' : ''}
        <br><small>Pos. ${i + 1}${l.code ? ` · Code ${esc(l.code)}` : ''}</small></td>
      <td>${esc(PATTERN_LABELS[c.pattern] || c.pattern || '')}${c.pattern && c.pattern !== 'glatt' ? ` · ${esc(c.depth ?? '')} mm` : ''}${esc(flow)}${c.rim && c.rim !== 'glatt' && RIM_LABELS[c.rim] ? ` · ${esc(RIM_LABELS[c.rim])}` : ''}<br>Höhe ${esc(c.height)} mm${c.width && c.width !== 1 ? ` · Breite ${Math.round(c.width * 100)} %` : ''}</td>
      <td><span class="sw" style="background:${esc(bodyHex)}"></span> ${esc(bodyName)}${finish ? `<br><small>${finish}</small>` : ''}</td>
      <td>${gravur}</td>
      <td class="file">${file}</td>
      <td class="note"></td>
    </tr>`;
  }).join('');
  const pay = order.payment === 'paypal' ? `PayPal${order.paypalOrderId ? ` (${esc(order.paypalOrderId)})` : ''}` : 'Vorkasse';
  const payState = order.paymentStatus === 'bezahlt' ? `bezahlt${order.paidAt ? ' am ' + dt(order.paidAt) : ''}` : 'OFFEN';
  const pieces = order.lines.reduce((s, l) => s + (l.qty || 0), 0);
  const css = `
    @page{size:A4;margin:12mm}
    .blatt{font-size:12.5px;line-height:1.4}
    .zettel-kopf{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:14px 0 10px;padding-bottom:8px;border-bottom:2px solid #211d18}
    .zettel-kopf h1{font-family:Inter,system-ui,sans-serif;font-weight:700;font-size:28px;letter-spacing:.02em}
    .zettel-kopf .etikett{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#6b6257}
    .zmeta{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin:10px 0 14px}
    .zmeta b{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#555;margin-bottom:2px}
    table.zettel{width:100%;border-collapse:collapse;margin:8px 0}
    .zettel th,.zettel td{border:1px solid #333;padding:6px 7px;text-align:left;vertical-align:top}
    .zettel th{font-size:10px;text-transform:uppercase;letter-spacing:.05em;background:#eee}
    td.c{text-align:center} td.big{font-size:18px;font-weight:700;white-space:nowrap}
    td.file{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;max-width:120px}
    td.note{min-width:70px}
    .box{display:inline-block;width:16px;height:16px;border:2px solid #111;border-radius:3px;vertical-align:middle;position:relative}
    .box.x::after{content:'✓';position:absolute;left:1px;top:-4px;font-size:15px;font-weight:700}
    .sw{display:inline-block;width:14px;height:14px;border:1px solid #333;border-radius:3px;vertical-align:-2px;margin-right:3px}
    .notes{border:1px solid #333;border-radius:6px;min-height:70px;padding:6px 8px;margin-top:10px}
    .notes b{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#555}
    .zfoot{display:flex;justify-content:space-between;gap:16px;border-top:1px solid #333;margin-top:12px;padding-top:6px;font-size:11.5px}
    .absender{font-size:10px}`;
  const body = `
  <div class="zettel-kopf">
    <div><div class="etikett"><span class="nm">${BRAND}</span> · Druckzettel</div><h1>${esc(order.orderId)}</h1></div>
    <div style="text-align:right">Bestellt am<br><b>${dt(order.createdAt)}</b>${order.invoiceNo ? `<br><small>Rechnung ${esc(order.invoiceNo)}</small>` : ''}</div>
  </div>
  <div class="zmeta">
    <div><b>Kunde &amp; Lieferadresse</b>${esc(cu.name)}<br>${esc(cu.street)}<br>${esc(cu.zip)} ${esc(cu.city)}<br><span class="muted">${esc(cu.email)}</span></div>
    <div><b>Auftrag</b>${order.lines.length} Position(en) · ${pieces} Stück${cu.note ? `<br><b style="margin-top:6px">Kundenhinweis</b>${esc(cu.note)}` : ''}${order.adminNote ? `<br><b style="margin-top:6px">Interne Notiz</b>${esc(order.adminNote)}` : ''}</div>
  </div>
  <table class="zettel"><tr><th>gedruckt</th><th>Menge</th><th>Produkt / Form</th><th>Muster · Höhe</th><th>Farbe</th><th>Gravur</th><th>Datei</th><th>Notiz</th></tr>${rows}</table>
  <div class="notes"><b>Notizen</b></div>
  <div class="zfoot">
    <span>Status: <b>${esc(STATUS_LABELS[order.status] || order.status)}</b></span>
    <span>Zahlung: ${pay} · <b>${payState}</b></span>
    <span>Gesamt: <b>${order.total != null ? money(order.total) : '—'}</b></span>
  </div>`;
  return belegSeite({
    title: `Druckzettel ${order.orderId} · ${BRAND}`, co: settings.company || {}, body, css, logoHeight: 26,
    leiste: '<button type="button" onclick="print()">Druckzettel drucken</button> <a href="/admin">← zurück zum Admin</a>',
  });
}

// ---------------------------------------------------------------------------
// Rechnung (HTML, druckbar → PDF über Browser-Druck; ein typischer Auftrag passt auf eine A4-Seite)
//   Pflichtangaben: voller Name + Anschrift des Unternehmers und der Kundschaft, Rechnungsnummer, Ausstellungsdatum,
//   Menge/Art, Entgelt; Kleinunternehmer: Hinweis auf § 19 UStG (§ 34a UStDV); sonst Netto/USt/Brutto,
//   Leistungszeitpunkt als Kalendermonat und Steuernummer bzw. USt-IdNr. (Hinweis im Admin, wenn beides fehlt).
//   Rechenwerte (Zeilen, Summen) kommen unverändert aus der Bestellung.
// ---------------------------------------------------------------------------
/**
 * Steuerstatus einer Rechnung (order.steuer = { kleinunternehmer, satz }) — wird beim Ausstellen der Rechnung an der Bestellung
 * gespeichert; Gutschrift und Stornorechnung folgen ihm statt der Einstellung am Ausstellungstag (sonst „berichtigte“ ein Storno
 * nach einem Wechsel der Betriebsart Umsatzsteuer, die nie ausgewiesen war, oder ließe ausgewiesene stehen).
 */
const STEUERSATZ = 19;
const steuerJetzt = () => ({ kleinunternehmer: !!settings.company?.kleinunternehmer, satz: STEUERSATZ });
/**
 * Steuerstatus der Rechnung einer Bestellung → { kleinunternehmer, satz }. Bestellungen von vor dem Feld: aus der ausgestellten
 * rechnung.html abgeleitet (§ 19-Hinweis → Kleinunternehmer, „Umsatzsteuer 19 %“/„USt (19 %)“ → Regelbesteuerung), sonst die
 * aktuelle Einstellung mit Warnung im Protokoll. Das Ergebnis bleibt an der Bestellung (order.steuer mit quelle), damit spätere
 * Belege dieselbe Grundlage haben. Belege selbst werden nie geändert.
 */
function steuerDerRechnung(order) {
  const s0 = order?.steuer;
  if (s0 && typeof s0.kleinunternehmer === 'boolean') return { kleinunternehmer: s0.kleinunternehmer, satz: Number(s0.satz) > 0 ? Number(s0.satz) : STEUERSATZ };
  let text = '';
  try { text = readFileSync(path.join(ORDERS, order.orderId, 'rechnung.html'), 'utf8').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' '); } catch { /* keine Rechnung */ }
  const satz = /(?:Umsatzsteuer|USt\.?)\s*\(?\s*(\d{1,2}(?:[.,]\d+)?)\s*%/.exec(text) || /(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:Umsatzsteuer|USt)/.exec(text);
  let st;
  if (/§\s*19\b.{0,40}?UStG/.test(text)) st = { kleinunternehmer: true, satz: STEUERSATZ, quelle: 'rechnung.html' };
  else if (satz) st = { kleinunternehmer: false, satz: Number(satz[1].replace(',', '.')) || STEUERSATZ, quelle: 'rechnung.html' };
  else {
    st = { ...steuerJetzt(), quelle: 'einstellung' };
    console.warn(`⚠️  ${order.orderId}: Steuerstatus der Rechnung ${order.invoiceNo || '(ohne Nummer)'} nicht feststellbar – aktuelle Einstellung (${st.kleinunternehmer ? 'Kleinunternehmer' : `USt ${st.satz} %`}) verwendet`);
  }
  order.steuer = st;
  return { kleinunternehmer: st.kleinunternehmer, satz: st.satz };
}
/**
 * Guthaben-Anrechnung einer Bestellung → { code, off, gutschriftNo } oder null (normaler Rabattcode / kein Gutschein).
 * Neue Bestellungen tragen coupon.guthaben; ältere werden über den Gutschein in den Einstellungen erkannt. Die Gutschrift-Nummer
 * steht in der Notiz des Gutscheins („Gutschrift GS-2026-0002 zu FS-…“).
 */
function guthabenDerBestellung(order) {
  const c = order?.coupon;
  if (!c || !(Number(c.off) > 0)) return null;
  const gc = couponByCode(c.code);
  if (c.guthaben !== true && !isGuthaben(gc)) return null;
  return { code: String(c.code || ''), off: euro(c.off), gutschriftNo: /\bGutschrift\s+(\S+)/.exec(String(gc?.note || ''))?.[1] || '' };
}
function invoiceHTML(order) {
  const co = settings.company || {};
  // Steuerstatus beim Ausstellen (handleComplete speichert ihn an der Bestellung — Gutschrift/Storno folgen ihm später)
  const st = order.steuer && typeof order.steuer.kleinunternehmer === 'boolean' ? order.steuer : steuerJetzt();
  const ku = !!st.kleinunternehmer, satz = Number(st.satz) || STEUERSATZ;
  const vorkasse = order.payment !== 'paypal';
  const ausgestellt = order.completedAt || order.invoiceAt || order.createdAt;
  // Hinweiszeile je Position: Aktion „Normalpreis 24,90 € · Aktion −16 % (Name)“ (Einzelpreis = reduzierter Preis, nur bei aktionProzent > 0)
  // und Aufpreise „inkl. Aufpreise: …“ (aus l.parts; ältere Bestellungen ohne parts zeigen keine) — Untersetzer/Größe stecken wie bisher im Einzelpreis
  const rows = order.lines.map((l, i) => {
    const note = [aktionText(l, settings), surchargeText(l, settings)].filter(Boolean).join(' · ');
    return `
    <tr><td class="muted nr">${i + 1}</td><td class="art">${einheitNbsp(esc(itemLabel(l, { mitAufpreis: false })))}${note ? `<br><small class="muted">${einheitNbsp(esc(note))}</small>` : ''}</td><td class="r menge">${l.qty}</td><td class="r einzel">${money(l.unit)}</td>
    <td class="r rabatt${l.off ? '' : ' leer'}">${l.off ? `−${l.off}&nbsp;%` : '—'}</td><td class="r summe">${money(l.line)}</td></tr>`;
  }).join('');
  // Ersparnis je betroffener Aktion („Aktion „Name“ −30 % auf Gehämmert: Ersparnis“) — informativ direkt unter der Zwischensumme,
  // als „in den Preisen enthalten“ gekennzeichnet (die Summen entstehen aus den reduzierten Zeilen; nach dem Gesamtbetrag läse
  // sie sich wie ein weiterer Abzug); ältere Bestellungen mit nur order.aktion: eine Zeile
  const aktionRow = aktionSummary(order, settings)
    .map((a) => `<tr class="fein"><td>${einheitNbsp(esc(a.label))} <small>(in den Preisen enthalten)</small></td><td class="r">${esc(a.value)}</td></tr>`).join('');
  // Guthaben (Gutschrift aus einer Reklamation) ist eine Anrechnung, kein Rabatt: Die Gutschrift hat das Entgelt der ersten
  // Rechnung (samt USt) schon gemindert — hier zählt es als Zahlung. Entgelt und USt beziehen sich deshalb auf den Betrag vor
  // dem Guthaben, danach „abzüglich Guthaben“ und „Zu zahlen“ (= order.total). Ältere Bestellungen ohne Kennzeichen: über den Code.
  const guth = guthabenDerBestellung(order);
  const entgelt = guth ? Math.round((order.total + guth.off) * 100) / 100 : order.total;
  const ust = ku ? null : ustAus(entgelt, satz);
  const ustRows = ust
    ? `<tr class="fein"><td>darin Nettobetrag</td><td class="r">${money(ust.netto)}</td></tr><tr class="fein"><td>darin Umsatzsteuer ${satz}&nbsp;%</td><td class="r">${money(ust.ust)}</td></tr>` : '';
  const guthRows = guth
    ? `<tr><td>abzüglich Guthaben „${esc(guth.code)}“${guth.gutschriftNo ? ` <small class="muted">(aus Gutschrift ${esc(guth.gutschriftNo)})</small>` : ''}</td><td class="r">−${money(guth.off)}</td></tr>
    <tr class="zahl"><td>Zu zahlen</td><td class="r">${money(order.total)}</td></tr>` : '';
  // § 34a UStDV (seit 2025): Hinweis, dass die Steuerbefreiung für Kleinunternehmer nach § 19 Abs. 1 UStG gilt
  const steuerNote = (ku
    ? 'Steuerbefreiung für Kleinunternehmer nach §&nbsp;19 Abs.&nbsp;1 UStG – es wird keine Umsatzsteuer berechnet.'
    : `Alle Beträge in Euro inklusive ${satz}&nbsp;% Umsatzsteuer.`) +
    (guth ? ' Dein Guthaben wird wie eine Zahlung angerechnet: Es mindert weder den Gesamtbetrag noch die Versandkostenfreiheit.' : '');
  const bank = [['Kontoinhaber', co.owner || co.name], ['IBAN', co.iban], ['BIC', co.bic], ['Bank', co.bank], ['Verwendungszweck', order.orderId], ['Betrag', money(order.total)]]
    .filter(([, v]) => String(v || '').trim());
  const bankRows = [];
  for (let i = 0; i < bank.length; i += 2) bankRows.push(bank.slice(i, i + 2));
  // Zahlungshinweis nach dem Zahlungsstand: nichts zu zahlen (Gutschein/Guthaben deckt alles) · schon bezahlt · Überweisung
  const payNote = !(order.total > 0)
    ? `Nichts zu zahlen – der Betrag ist durch ${guth ? `dein Guthaben „${esc(guth.code)}“` : `den Gutschein „${esc(order.coupon?.code || '')}“`} beglichen. Danke!`
    : !vorkasse
      ? `Bezahlt per PayPal am ${esc(dateDE(order.paidAt || order.createdAt))}${guth ? ` (${money(order.total)}, der Rest über dein Guthaben)` : ''} – danke!`
      : order.paymentStatus === 'bezahlt'
        ? `Bezahlt per Überweisung${order.paidAt ? ` am ${esc(dateDE(order.paidAt))}` : ''}${guth ? ` (${money(order.total)}, der Rest über dein Guthaben)` : ''} – danke!`
        : `Bitte überweise ${guth ? 'den zu zahlenden Betrag' : 'den Gesamtbetrag'} innerhalb von ${ZAHLUNGSFRIST_TAGE}&nbsp;Tagen mit deiner Bestellnummer als Verwendungszweck:
       <table>${bankRows.map((row) => `<tr>${row.map(([k, v]) => `<th>${esc(k)}</th><td>${k === 'IBAN' ? nbspAlle(v) : esc(v)}</td>`).join('')}</tr>`).join('')}</table>`;
  // Leistungszeitpunkt (§ 14 Abs. 4 Nr. 6 UStG, Kalendermonat genügt nach § 31 Abs. 4 UStDV): schon versandt → Versanddatum,
  // sonst der voraussichtliche Liefermonat (Rechnungsdatum + längste Lieferzeit) — ausdrücklich als „voraussichtlich“
  const leistung = order.shippedAt
    ? `${esc(dateDE(order.shippedAt))}<small>(Versanddatum)</small>`
    : `voraussichtlich ${esc(lieferMonat(ausgestellt, settings.shop?.lieferzeit))}<small>(Kalendermonat der Lieferung)</small>`;
  const meta = [
    ['Rechnungsnummer', esc(order.invoiceNo)],
    ['Rechnungsdatum', esc(dateDE(ausgestellt))],
    ['Bestellnummer', esc(order.orderId)],
    ...(ku ? [] : [['Leistungszeitpunkt', leistung]]),
  ];
  const cu = order.customer || {};
  const body = `
  <section class="anschrift">
    <div class="empfaenger"><div class="ruecksende">${belegRuecksende(co)}</div>
      <b>${esc(cu.name)}</b><br>${esc(cu.street)}<br>${esc(cu.zip)} ${esc(cu.city)}</div>
    <table class="meta">${meta.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
  </section>
  <h1>Rechnung</h1>
  <table class="pos posten"><thead><tr><th class="nr">Pos.</th><th class="art">Artikel (individuell 3D-gedruckt)</th><th class="r menge">Menge</th><th class="r einzel">Einzelpreis</th><th class="r rabatt">Rabatt</th><th class="r summe">Summe</th></tr></thead><tbody>${rows}</tbody></table>
  <table class="summen">
    <tr><td>Zwischensumme</td><td class="r">${money(order.subtotal)}</td></tr>
    ${aktionRow}
    ${order.coupon && !guth ? `<tr><td>Gutschein „${esc(order.coupon.code)}“</td><td class="r">−${money(order.coupon.off)}</td></tr>` : ''}
    <tr><td>Versand</td><td class="r">${order.shipping === 0 ? 'kostenlos' : money(order.shipping)}</td></tr>
    <tr class="grand"><td>Gesamtbetrag</td><td class="r">${money(entgelt)}</td></tr>
    ${ustRows}
    ${guthRows}
  </table>
  <p class="steuer">${steuerNote}</p>
  <div class="zahlung">${payNote}</div>
  <p class="dank">Danke für deine Bestellung! <span class="akzent">Gedruckt wird erst, wenn du bestellst</span> – jedes Stück entsteht individuell für dich.<br>Lieferzeit:&nbsp;${einheitNbsp(esc(lieferzeitText(settings)))}. ${einheitNbsp(esc(fristBeginnKurz(order.payment)))}</p>
  <p class="klein">Produkthinweise: ${einheitNbsp(esc(produktHinweise(order.lines).join(' ')))}</p>`;
  return belegSeite({ title: `Rechnung ${order.invoiceNo} · ${BRAND}`, co, body, pdf: 'rechnung.pdf' });
}

// ---------------------------------------------------------------------------
// Gutschrift (HTML, druckbar) — orders/<ID>/gutschrift.html, entsteht beim Erledigen einer Reklamation
// mit Erstattung (Gutschein / Überweisung / PayPal). Aufbau wie die Rechnung, Bezug auf Rechnung & Bestellung.
// ---------------------------------------------------------------------------
/** IBAN nur mit den letzten vier Zeichen — das Dokument liegt unter einer erratbaren Adresse */
const maskIban = (iban) => { const c = String(iban || '').replace(/\s+/g, ''); return c.length >= 4 ? `${c.slice(0, 2)}•• •••• ${c.slice(-4)}` : ''; };
function creditNoteHTML(order) {
  const co = settings.company || {};
  const r = order.reklamation || {};
  const betrag = euro(r.betrag);
  // Steuer wie in der Rechnung, die die Gutschrift mindert (order.steuer) — nicht wie die Einstellung am Ausstellungstag
  const { kleinunternehmer: ku, satz } = order.invoiceNo ? steuerDerRechnung(order) : steuerJetzt();
  const ust = ku ? null : ustAus(betrag, satz);
  const vatNote = ku
    ? 'Steuerbefreiung für Kleinunternehmer nach §&nbsp;19 Abs.&nbsp;1 UStG – es wird keine Umsatzsteuer berechnet.'
    : `Im Gutschriftbetrag enthaltene USt (${satz}&nbsp;%): ${money(ust.ust)} (netto ${money(ust.netto)}).`;
  const how = {
    gutschein: `Gutschrift als Gutschein-Code <b>${esc(r.gutscheinCode || '')}</b> – einlösbar in der Kasse des Shops im Feld „Gutscheincode“, ohne Mindestbestellwert und auch während einer Aktion. Ist die Bestellung kleiner, bleibt der Rest auf dem Code.`,
    ueberweisung: `Erstattung per Überweisung${r.iban ? ` auf IBAN ${nbspAlle(maskIban(r.iban))}` : ''} innerhalb von 5&nbsp;Werktagen.`,
    paypal: `Erstattung über PayPal auf das Zahlungskonto der Bestellung${r.refundId ? ` (Referenz ${esc(r.refundId)})` : ''}.`,
  }[r.art] || esc(REKLA_ART[r.art] || '');
  const ref = order.invoiceNo ? `Rechnung ${esc(order.invoiceNo)} vom ${esc(dateDE(order.completedAt || order.createdAt))} · Bestellung ${esc(order.orderId)}` : `Bestellung ${esc(order.orderId)} vom ${esc(dateDE(order.createdAt))}`;
  const meta = [
    ['Gutschriftnummer', esc(r.gutschriftNo || '')],
    ['Datum', esc(dateDE(r.resolvedAt || r.updatedAt))],
    ...(order.invoiceNo ? [['zu Rechnung', esc(order.invoiceNo)]] : []),
    ['Bestellnummer', esc(order.orderId)],
  ];
  const cu = order.customer || {};
  const body = `
  <section class="anschrift">
    <div class="empfaenger"><div class="ruecksende">${belegRuecksende(co)}</div>
      <b>${esc(cu.name)}</b><br>${esc(cu.street)}<br>${esc(cu.zip)} ${esc(cu.city)}</div>
    <table class="meta">${meta.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
  </section>
  <h1>Gutschrift <span class="muted" style="font-size:.62em">(Rechnungskorrektur)</span></h1>
  <table class="pos"><thead><tr><th>Position</th><th class="r">Betrag</th></tr></thead><tbody>
    <tr><td>Gutschrift zu ${ref}<br><small class="muted">Grund: ${esc(r.grund || '—')}</small></td><td class="r">${money(betrag)}</td></tr></tbody></table>
  <table class="summen">
    <tr class="grand"><td>Gutschriftbetrag</td><td class="r">${money(betrag)}</td></tr>
  </table>
  <p class="steuer">${vatNote}</p>
  <div class="zahlung"><b>Art der Erstattung:</b> ${how}</div>
  <p class="dank">Diese Gutschrift bezieht sich auf die oben genannte Rechnung bzw. Bestellung${order.invoiceNo ? ' und mindert deren Betrag entsprechend' : ''}. Bei Fragen antworte einfach auf meine E-Mail.</p>`;
  return belegSeite({ title: `Gutschrift (Rechnungskorrektur) ${r.gutschriftNo || ''} · ${BRAND}`, co, body, pdf: 'gutschrift.pdf' });
}

// ---------------------------------------------------------------------------
// Stornorechnung (HTML, druckbar) — orders/<ID>/storno.html, entsteht, sobald eine Bestellung mit ausgestellter Rechnung
// storniert wird (die Rechnung gibt es schon ab dem Abschluss der Kasse, auch bei Vorkasse vor der Zahlung). Sie hebt die
// Rechnung auf: negativer Betrag, ohne Kleinunternehmerregelung mit negativer USt (sonst bliebe die ausgewiesene Steuer nach
// § 14c UStG geschuldet). Nummer aus dem Gutschrift-Nummernkreis, Datei wird nie überschrieben (GoBD). Wurde schon eine
// Gutschrift/Erstattung (Reklamation) ausgestellt, storniert der Beleg nur den Rest.
// ---------------------------------------------------------------------------
/** Beträge des Stornos → { entgelt, gutschrift, betrag, guth } (betrag = aufzuhebender Rest, positiv) */
function stornoBetraege(order) {
  const guth = guthabenDerBestellung(order);
  const entgelt = guth ? Math.round((euro(order.total) + guth.off) * 100) / 100 : euro(order.total);
  const r = order.reklamation;
  const gutschrift = r?.status === 'erledigt' && r.art !== 'nachdruck' && r.gutschriftNo ? euro(r.betrag) : 0;
  return { entgelt, gutschrift, betrag: Math.max(0, Math.round((entgelt - gutschrift) * 100) / 100), guth };
}
/**
 * Darf eine stornierte Bestellung wieder aufleben („Storno aufheben“)? → null oder Meldung (409). Nicht mehr, sobald eine
 * Stornorechnung existiert oder die Rechnung schon mit einer Gutschrift vollständig gutgeschrieben ist (die Rechnung ist
 * aufgehoben — ein neuer Vorgang braucht eine neue Bestellung), und nicht, wenn ihr Guthaben inzwischen anderweitig eingelöst ist
 * (sonst wäre es über seinen Wert eingelöst). Ohne Rechnung (nie abgeschlossene Kasse) oder bei einer Rechnung über 0,00 € (es gab
 * nichts aufzuheben, siehe stornoBeleg) bleibt das Aufheben als Korrekturweg erlaubt.
 */
function stornoAufhebenSperre(order) {
  if (order.storno?.nr) return `Zu dieser Bestellung gibt es die Stornorechnung ${order.storno.nr} – die Rechnung ${order.invoiceNo} ist damit aufgehoben, das Storno lässt sich nicht zurücknehmen. Für einen neuen Auftrag bitte eine neue Bestellung anlegen.`;
  const sb = stornoBetraege(order);
  if (order.invoiceNo && sb.gutschrift > 0 && sb.betrag <= 0) return `Die Rechnung ${order.invoiceNo} ist vollständig gutgeschrieben – das Storno lässt sich nicht zurücknehmen. Für einen neuen Auftrag bitte eine neue Bestellung anlegen.`;
  const gc = order.coupon ? couponByCode(order.coupon.code) : null;
  if (gc && isGuthaben(gc)) {
    const rest = couponRest(gc, { ohne: order.orderId });
    if (rest + 0.005 < euro(order.coupon.off)) return `Das Guthaben „${gc.code}“ dieser Bestellung ist inzwischen anderweitig eingelöst (frei: ${money(rest)}) – das Storno lässt sich nicht zurücknehmen. Bitte eine neue Bestellung anlegen.`;
  }
  // Gutschein mit Höchstzahl: das Storno hat die Einlösung freigegeben (z. B. eine Rechnung über 0,00 € ohne Stornorechnung) —
  // ist der Code seitdem anderweitig vergeben (feste Einlösungen und offene Kassen anderer Kundinnen), bleibt das Storno
  if (gc && !isGuthaben(gc) && gc.maxEinloesungen > 0
    && couponEinloesungen(gc, { ohne: order.orderId, email: order.customer?.email || '-' }) >= gc.maxEinloesungen) {
    return `Der Gutschein „${gc.code}“ dieser Bestellung ist inzwischen anderweitig eingelöst (höchstens ${gc.maxEinloesungen}-mal) – das Storno lässt sich nicht zurücknehmen. Bitte eine neue Bestellung anlegen.`;
  }
  return null;
}
/**
 * Höchstbetrag einer Gutschrift/Erstattung (Reklamation): bezahlter Betrag minus frühere Gutschriften. Bezahlt ist bei
 * „bezahlt“ der Rechnungsbetrag samt Guthaben-Anteil (Guthaben ist Geld der Kundschaft), sonst nur der Guthaben-Anteil;
 * per PayPal lässt sich höchstens zurückgeben, was per PayPal gezahlt wurde. Ohne Rechnung oder nach Storno: 0.
 */
function reklaMax(order, art) {
  if (!order?.invoiceNo || order.status === 'storniert' || order.storno?.nr) return 0;
  const { entgelt, gutschrift, guth } = stornoBetraege(order);
  const bezahlt = order.paymentStatus === 'bezahlt';
  let max = bezahlt ? entgelt : (guth?.off || 0);
  if (art === 'paypal') max = Math.min(max, bezahlt ? euro(order.total) : 0);
  return Math.max(0, Math.round((max - gutschrift) * 100) / 100);
}
function stornoHTML(order) {
  const co = settings.company || {};
  // Steuer wie in der aufgehobenen Rechnung (order.steuer); die berichtigte USt = USt der Rechnung − USt einer früheren Gutschrift,
  // damit Gutschrift und Storno zusammen genau die ausgewiesene Steuer aufheben (sonst 1 Cent Rundungsdifferenz möglich)
  const { kleinunternehmer: ku, satz } = steuerDerRechnung(order);
  const st = order.storno || {};
  const { entgelt, gutschrift, betrag, guth } = stornoBetraege(order);
  const ustBetrag = ku ? 0 : Math.round((ustAus(entgelt, satz).ust - (gutschrift ? ustAus(gutschrift, satz).ust : 0)) * 100) / 100;
  const ust = ku ? null : { ust: ustBetrag, netto: Math.round((betrag - ustBetrag) * 100) / 100 };
  const rechnungVom = dateDE(order.completedAt || order.createdAt);
  const r = order.reklamation || {};
  const meta = [
    ['Stornonummer', esc(st.nr || '')],
    ['Datum', esc(dateDE(st.at))],
    ['zu Rechnung', `${esc(order.invoiceNo)}<small>vom ${esc(rechnungVom)}</small>`],
    ['Bestellnummer', esc(order.orderId)],
  ];
  const ustRows = ust
    ? `<tr class="fein"><td>darin Nettobetrag</td><td class="r">−${money(ust.netto)}</td></tr><tr class="fein"><td>darin Umsatzsteuer ${satz}&nbsp;%</td><td class="r">−${money(ust.ust)}</td></tr>` : '';
  const vatNote = ku
    ? 'Steuerbefreiung für Kleinunternehmer nach §&nbsp;19 Abs.&nbsp;1 UStG – es wird keine Umsatzsteuer berechnet.'
    : `Die in Rechnung ${esc(order.invoiceNo)} ausgewiesene Umsatzsteuer wird in dieser Höhe berichtigt.`;
  const bezahlt = order.paymentStatus === 'bezahlt';
  // 0 € zu zahlen (Gutschein/Guthaben deckte alles): kein Geld zu erstatten, nur ein Guthaben wird wieder frei
  const zahlung = [
    !(order.total > 0) ? ''
      : bezahlt
        ? `Den bereits gezahlten Betrag${gutschrift ? ', soweit noch nicht erstattet,' : ''} erstatte ich dir ${order.payment === 'paypal' ? 'über PayPal' : 'per Überweisung'}.`
        : 'Du musst nichts überweisen. Hast du schon überwiesen, erstatte ich dir den Betrag.',
    guth ? `Dein Guthaben „${esc(guth.code)}“ über ${money(guth.off)} steht dir wieder zur Verfügung.` : '',
  ].filter(Boolean).join(' ') || 'Es war nichts zu zahlen – es wird nichts erstattet.';
  const cu = order.customer || {};
  const body = `
  <section class="anschrift">
    <div class="empfaenger"><div class="ruecksende">${belegRuecksende(co)}</div>
      <b>${esc(cu.name)}</b><br>${esc(cu.street)}<br>${esc(cu.zip)} ${esc(cu.city)}</div>
    <table class="meta">${meta.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
  </section>
  <h1>Stornorechnung</h1>
  <table class="pos"><thead><tr><th>Position</th><th class="r">Betrag</th></tr></thead><tbody>
    <tr><td>Stornierung der Rechnung ${esc(order.invoiceNo)} vom ${esc(rechnungVom)} · Bestellung ${esc(order.orderId)}<br><small class="muted">Die Bestellung wurde storniert.</small></td><td class="r">−${money(entgelt)}</td></tr>
    ${gutschrift ? `<tr><td>bereits gutgeschrieben mit Gutschrift ${esc(r.gutschriftNo)}</td><td class="r">${money(gutschrift)}</td></tr>` : ''}</tbody></table>
  <table class="summen">
    <tr class="grand"><td>Stornobetrag</td><td class="r">−${money(betrag)}</td></tr>
    ${ustRows}
  </table>
  <p class="steuer">${vatNote}</p>
  <div class="zahlung">${zahlung}</div>
  <p class="dank">Diese Stornorechnung hebt die Rechnung ${esc(order.invoiceNo)} auf. Bei Fragen antworte einfach auf meine E-Mail.</p>`;
  return belegSeite({ title: `Stornorechnung ${st.nr || ''} · ${BRAND}`, co, body, pdf: 'storno.pdf' });
}
/**
 * Beim Wechsel auf „storniert“ (unter der Bestellsperre, vor writeOrder): Stornorechnung zu einer ausgestellten Rechnung
 * anlegen — einmal je Bestellung (order.storno = { nr, at }). Ohne Rechnung (Kasse nie abgeschlossen), bei einer Rechnung über
 * 0,00 € (100-%-Gutschein) oder wenn schon alles gutgeschrieben ist, gibt es nichts aufzuheben (nur ein Vermerk in der Historie).
 * Reihenfolge wie bei der Rechnung: Nummer ziehen → an der Bestellung speichern (scheitert das, geht die Nummer zurück bzw. die
 * Lücke wird protokolliert) → Zähler speichern → storno.html schreiben. So tragen
 * Beleg und Bestellung immer dieselbe Nummer. nachholen = true: nur eine fehlende storno.html zu einer gespeicherten Nummer schreiben.
 */
async function stornoBeleg(order, { nachholen = false } = {}) {
  if (!order.invoiceNo) return;
  const file = path.join(ORDERS, order.orderId, 'storno.html');
  if (!order.storno?.nr) {
    if (nachholen) return;
    const sb = stornoBetraege(order);
    if (sb.betrag <= 0) {
      // nichts aufzuheben: schon mit einer Gutschrift vollständig gutgeschrieben, oder die Rechnung lautet über 0,00 € (100-%-Gutschein)
      addHistory(order, order.status, sb.gutschrift > 0 ? `Keine Stornorechnung nötig: Rechnung ${order.invoiceNo} ist bereits vollständig gutgeschrieben`
        : `Keine Stornorechnung nötig: Rechnung ${order.invoiceNo} lautet über ${money(sb.entgelt)}`, 'system');
      return;
    }
    steuerDerRechnung(order);   // Altbestand: Steuerstatus der Rechnung jetzt festhalten (wird mit gespeichert)
    const nr = nextBelegNr('creditPrefix', 'nextCredit', DEFAULT_SETTINGS.creditPrefix);
    order.storno = { nr, at: new Date().toISOString() };
    addHistory(order, order.status, `Stornorechnung ${nr} zu Rechnung ${order.invoiceNo} ausgestellt`, 'system');
    try { await writeOrder(order); } catch (err) {
      belegNrFreigeben('creditPrefix', 'nextCredit', nr, `Stornorechnung zu ${order.orderId}: Bestellung nicht speicherbar (${err?.message || err})`);
      throw err;
    }
    await saveSettings().catch((err) => console.error(`Zähler nach Stornorechnung ${nr} nicht gespeichert (Nummer steht an der Bestellung):`, err?.message || err));
    if (existsSync(file)) { console.warn(`⚠️  ${order.orderId}: storno.html existiert bereits – ${nr} nicht als Datei geschrieben`); return; }
  }
  if (!existsSync(file)) await writeFileAtomic(file, stornoHTML(order));
}

// ---------------------------------------------------------------------------
// Einstellungen aus dem Admin prüfen (POST /api/admin/settings) — jedes Feld nach Typ und Bereich, Fehler als 400 mit deutscher
// Meldung und Feldname, bevor irgendetwas übernommen wird (nie 500, nie halb gespeichert). Beträge: Zahl ≥ 0 mit höchstens zwei
// Nachkommastellen (sonst rechneten Browser und Server verschieden), Grundpreise > 0. Der Admin schickt immer vollständige
// Objekte; Teil-Patches (ältere Skripte) werden mit dem gespeicherten Stand ergänzt. Gespeicherte Altwerte prüft loadSettings()
// nachsichtig (preiseBeimLaden: nur auf Cent runden und fehlende Teile auffüllen).
// ---------------------------------------------------------------------------
/** Betrag in € aus dem Admin: Zahl (oder Zahl als Text), min ≤ n ≤ max, höchstens 2 Nachkommastellen → auf Cent */
function betragAus(v, feld, { min = 0, max = 100000, groesserNull = false } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v.trim().replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw httpError(400, `${feld}: bitte eine Zahl angeben`);
  if (groesserNull && !(n > 0)) throw httpError(400, `${feld}: muss größer als 0 sein`);
  if (n < min || n > max) throw httpError(400, `${feld}: muss zwischen ${min} und ${max} liegen`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw httpError(400, `${feld}: höchstens zwei Nachkommastellen (Cent)`);
  return Math.round(n * 100) / 100;
}
const objAus = (v, feld) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw httpError(400, `${feld}: ungültiges Format`); return v; };
const boolAus = (v, feld) => { if (typeof v !== 'boolean') throw httpError(400, `${feld}: muss an oder aus sein (true/false)`); return v; };
/** Mengenstaffel [{ qty 2–50 ganz, off 0 bis < 100 % }] — doppelte Mengen abgelehnt, nach Menge sortiert */
function staffelAus(list, feld) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 10) throw httpError(400, `${feld}: Liste mit höchstens 10 Stufen erwartet`);
  const out = list.map((t, i) => {
    objAus(t, `${feld}, Stufe ${i + 1}`);
    const qty = Number(t.qty);
    if (!Number.isInteger(qty) || qty < 2 || qty > 50) throw httpError(400, `${feld}, Stufe ${i + 1}: Menge muss eine ganze Zahl von 2 bis 50 sein`);
    const off = betragAus(t.off, `${feld}, Stufe ${i + 1} (Rabatt %)`, { max: 99.99 });
    return { qty, off };
  }).sort((a, b) => a.qty - b.qty);
  for (let i = 1; i < out.length; i++) if (out[i].qty === out[i - 1].qty) throw httpError(400, `${feld}: die Menge ${out[i].qty} steht doppelt`);
  return out;
}
/** Preise (settings.pricing) prüfen — Teil-Patch wird mit dem gespeicherten Stand ergänzt; Rückgabe: vollständiges pricing */
function preiseAus(raw) {
  const alt = settings.pricing || {};
  const p = { ...alt, ...objAus(raw, 'Preise') };
  if (p.currency !== undefined && p.currency !== 'EUR') throw httpError(400, 'Preise: Währung muss EUR sein');
  const produkt = (k, label) => {
    const x = { ...plainObj(alt[k]), ...objAus(p[k] ?? {}, `Preise ${label}`) };
    return {
      ...x,
      single: betragAus(x.single, `Grundpreis ${label}`, { groesserNull: true, max: 10000 }),
      ...(k === 'eierbecher' ? { untersetzer: betragAus(x.untersetzer ?? 0, 'Untersetzer-Aufpreis', { max: 10000 }) } : {}),
      discounts: staffelAus(x.discounts, `Mengenrabatt ${label}`),
    };
  };
  const ship = { ...plainObj(alt.shipping), ...objAus(p.shipping ?? {}, 'Versand') };
  const vol = { ...plainObj(alt.volumen), ...objAus(p.volumen ?? {}, 'Größenaufschlag') };
  const muster = objAus(p.muster ?? {}, 'Muster-Aufpreise');
  for (const k of Object.keys(muster)) if (MUSTER_KEYS.includes(k)) betragAus(muster[k] ?? 0, `Aufpreis ${k}`, { max: 10000 });
  return {
    ...p,
    currency: 'EUR',
    vase: produkt('vase', 'Vase'),
    eierbecher: produkt('eierbecher', 'Eierbecher'),
    gravur: betragAus(p.gravur ?? 0, 'Gravur-Aufpreis', { max: 10000 }),
    farbschrift: betragAus(p.farbschrift ?? 0, 'Farbschrift-Aufpreis', { max: 10000 }),
    muster: sanitizeMuster(muster),
    volumen: { prozent: betragAus(vol.prozent ?? 0, 'Größenaufschlag %', { max: 1000 }), euro: betragAus(vol.euro ?? 0, 'Größenaufschlag €', { max: 10000 }) },
    shipping: { flat: betragAus(ship.flat, 'Versand pauschal', { max: 1000 }), freeFrom: betragAus(ship.freeFrom, 'Versandfrei ab', { max: 100000 }) },
  };
}
/** Filament-Farben prüfen: id (eindeutig), Name, Hex-Farbe, Finish, aktiv, Notiz, Bestand, Aufpreis */
function farbenAus(list) {
  if (!Array.isArray(list) || list.length > 200) throw httpError(400, 'Farben: Liste mit höchstens 200 Einträgen erwartet');
  const ids = new Set();
  return list.map((c, i) => {
    objAus(c, `Farbe ${i + 1}`);
    const name = oneLine(c.name, 40);
    const pos = `Farbe „${name || i + 1}“`;
    const id = String(c.id ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw httpError(400, `${pos}: ungültige Kennung`);
    if (ids.has(id)) throw httpError(400, `${pos}: Kennung „${id}“ doppelt`);
    ids.add(id);
    if (!name) throw httpError(400, `Farbe ${i + 1}: bitte einen Namen angeben`);
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c.hex ?? ''))) throw httpError(400, `${pos}: Farbwert muss eine Hex-Farbe sein (z. B. #a0a0a0)`);
    const finish = c.finish === undefined || c.finish === '' ? 'matt' : c.finish;
    if (!['matt', 'glanz', 'metall'].includes(finish)) throw httpError(400, `${pos}: Finish muss matt, glanz oder metall sein`);
    const stock = c.stock === undefined || c.stock === null || c.stock === '' ? null : Number(c.stock);
    if (stock !== null && !(Number.isFinite(stock) && stock >= 0 && stock <= 1e7)) throw httpError(400, `${pos}: Bestand muss eine Zahl ≥ 0 sein`);
    return { ...c, id, name, hex: String(c.hex), finish, active: c.active === undefined ? true : !!c.active, note: oneLine(c.note, 200), stock,
      aufpreis: betragAus(c.aufpreis ?? 0, `${pos}: Aufpreis`, { max: 10000 }) };
  });
}
/** Gutscheine prüfen (nach mergeCoupons, Guthaben-Felder kommen vom Server): Code eindeutig, Art, Wert, Mindestbestellwert */
function gutscheineAus(list) {
  if (list.length > 500) throw httpError(400, 'Gutscheine: höchstens 500 Einträge');
  const codes = new Set();
  return list.map((c, i) => {
    const code = String(c.code ?? '').trim().toUpperCase();
    const pos = `Gutschein „${code || i + 1}“`;
    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) throw httpError(400, `${pos}: Code muss 2–40 Zeichen lang sein (Buchstaben A–Z, Ziffern, - oder _)`);
    if (codes.has(code)) throw httpError(400, `${pos}: der Code steht doppelt`);
    codes.add(code);
    if (!['percent', 'fixed'].includes(c.type)) throw httpError(400, `${pos}: Art muss „% Rabatt“ oder „€ Betrag“ sein`);
    const value = c.type === 'percent'
      ? betragAus(c.value, `${pos}: Prozent`, { groesserNull: true, max: 100 })
      : betragAus(c.value, `${pos}: Betrag`, { groesserNull: true, max: 10000 });
    const g = !!c.guthaben;
    // Guthaben (Gutschrift aus einer Reklamation) gilt laut Gutschrift und AGB § 14 ohne Mindestbestellwert und auch während einer Aktion
    const minOrder = g ? 0 : betragAus(c.minOrder ?? 0, `${pos}: Mindestbestellwert`, { max: 100000 });
    const gueltigBis = g || c.gueltigBis === undefined || c.gueltigBis === null || c.gueltigBis === '' ? null : String(c.gueltigBis);
    if (gueltigBis !== null && !(/^\d{4}-\d{2}-\d{2}$/.test(gueltigBis) && Number.isFinite(Date.parse(gueltigBis)))) throw httpError(400, `${pos}: „gültig bis“ muss ein Datum sein`);
    const maxEinloesungen = g || c.maxEinloesungen === undefined || c.maxEinloesungen === null || c.maxEinloesungen === '' ? null : Number(c.maxEinloesungen);
    if (maxEinloesungen !== null && !(Number.isInteger(maxEinloesungen) && maxEinloesungen >= 1 && maxEinloesungen <= 100000)) throw httpError(400, `${pos}: „höchstens … Einlösungen“ muss eine ganze Zahl ab 1 sein`);
    const out = { ...c, code: g ? c.code : code, value, minOrder, active: !!c.active, mitAktion: g ? true : !!c.mitAktion };
    if (c.note !== undefined) out.note = oneLine(c.note, 200);
    if (gueltigBis) out.gueltigBis = gueltigBis; else delete out.gueltigBis;
    if (maxEinloesungen) out.maxEinloesungen = maxEinloesungen; else delete out.maxEinloesungen;
    return out;
  });
}
/** Druck-Schätzwerte: Minuten/Gramm je Stück > 0 */
function druckAus(raw) {
  const p = { ...DEFAULT_SETTINGS.printing, ...plainObj(settings.printing), ...objAus(raw, 'Druck-Schätzwerte') };
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS.printing)) {
    const n = Number(p[k]);
    if (!(Number.isFinite(n) && n > 0 && n <= 100000)) throw httpError(400, `Druck-Schätzwerte: ${k} muss eine Zahl größer als 0 sein`);
    out[k] = n;
  }
  return out;
}
/** Host-Name eines SMTP-Servers (ohne Schema, Port, Pfad oder Leerzeichen) */
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
/**
 * Mail-Einstellungen prüfen (zusammengeführter Stand next, Passwort-Maske schon angewendet): Host, Port 1–65535, Verschlüsselung,
 * Adressen (Absender, Antwort, Admin — eine oder mehrere, mit Komma getrennt), öffentliche Shop-Adresse als absolute
 * http(s)-Adresse ohne Pfad (Pflicht bei aktivem Versand: sonst zeigen alle Links in Kundenmails ins Leere). → next normalisiert
 */
function mailAus(next) {
  for (const k of ['enabled', 'adminCopy', 'autoStatusMails', 'allowSelfSigned']) if (next[k] !== undefined) boolAus(next[k], `E-Mail: ${k}`);
  for (const k of ['host', 'user', 'from', 'fromName', 'replyTo', 'adminTo', 'publicUrl']) {
    if (next[k] === null || next[k] === undefined) next[k] = '';
    if (typeof next[k] !== 'string' || next[k].length > 500 || /[\x00-\x1f\x7f]/.test(next[k])) throw httpError(400, `E-Mail: ${k} ungültig`);
    next[k] = next[k].trim();
  }
  if (typeof next.pass !== 'string' || next.pass.length > 500) throw httpError(400, 'E-Mail: Passwort ungültig');
  if (next.host && !HOST_RE.test(next.host)) throw httpError(400, 'E-Mail: Host ungültig – nur den Servernamen eintragen, z. B. smtp.example.de (ohne smtp:// und ohne Port)');
  const port = typeof next.port === 'string' && next.port.trim() ? Number(next.port) : next.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'E-Mail: Port muss eine ganze Zahl von 1 bis 65535 sein');
  next.port = port;
  if (!['ssl', 'starttls', 'none'].includes(next.secure)) throw httpError(400, 'E-Mail: Verschlüsselung muss SSL/TLS, STARTTLS oder unverschlüsselt sein');
  if (next.from && !isEmail(next.from)) throw httpError(400, 'E-Mail: Absender-Adresse ungültig');
  if (next.replyTo && !isEmail(next.replyTo)) throw httpError(400, 'E-Mail: Antwort-Adresse (Reply-To) ungültig');
  if (next.adminTo) {
    const liste = next.adminTo.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    const falsch = liste.find((x) => !isEmail(x));
    if (!liste.length || falsch) throw httpError(400, `E-Mail: Admin-Adresse „${falsch || next.adminTo}“ ungültig – mehrere Adressen mit Komma trennen`);
    next.adminTo = liste.join(', ');
  }
  if (next.fromName.length > 100) throw httpError(400, 'E-Mail: Absender-Name zu lang (höchstens 100 Zeichen)');
  if (next.publicUrl) {
    let u = null;
    try { u = new URL(next.publicUrl); } catch { u = null; }
    if (!u || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
      throw httpError(400, 'E-Mail: Öffentliche Shop-Adresse muss eine vollständige Adresse ohne Pfad sein, z. B. https://www.formsam.com');
    }
    next.publicUrl = u.origin;
  }
  if (next.enabled) {
    if (!next.host) throw httpError(400, 'E-Mail: Für den Versand fehlt der Host des SMTP-Servers');
    if (!next.publicUrl) throw httpError(400, 'E-Mail: Für den Versand fehlt die öffentliche Shop-Adresse (z. B. https://www.formsam.com) – sonst führen die Links in den Mails ins Leere');
  }
  return next;
}
/** PayPal-Angaben: Schalter als true/false, Client-ID nur aus Buchstaben/Ziffern/-/_ — aktiv nur mit Client-ID */
function paypalAus(next) {
  for (const k of ['enabled', 'sandbox']) boolAus(next[k], `PayPal: ${k === 'enabled' ? 'aktiv' : 'Sandbox'}`);
  next.clientId = String(next.clientId ?? '').trim();
  if (next.clientId.length > 200 || !/^[A-Za-z0-9_-]*$/.test(next.clientId)) throw httpError(400, 'PayPal: Client-ID ungültig');
  if (typeof next.secret !== 'string' || next.secret.length > 500) throw httpError(400, 'PayPal: Secret ungültig');
  if (next.enabled && !next.clientId) throw httpError(400, 'PayPal: Zum Einschalten fehlt die Client-ID');
  return next;
}
/**
 * Gespeicherte Preise beim Start: nur auf Cent runden (ältere Stände mit 3 Nachkommastellen) und fehlende Teile (Versand, Staffeln,
 * Währung) aus den Standardwerten auffüllen — mit Meldung im Protokoll, ohne den Shop anzuhalten
 */
function preiseBeimLaden(pr) {
  const p = plainObj(pr);
  const warn = (t) => console.warn(`⚠️  Preise: ${t}`);
  const cent = (obj, k, wo) => {
    const n = Number(obj[k]);
    if (Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) { obj[k] = Math.round(n * 100) / 100; warn(`${wo} auf Cent gerundet (${n} → ${obj[k]})`); }
  };
  if (p.currency !== 'EUR') { if (p.currency !== undefined) warn(`Währung „${p.currency}“ → EUR`); p.currency = 'EUR'; }
  for (const k of ['vase', 'eierbecher']) {
    if (!p[k] || typeof p[k] !== 'object') { p[k] = structuredClone(DEFAULT_SETTINGS.pricing[k]); warn(`${k} fehlte – Standardpreise eingesetzt`); }
    cent(p[k], 'single', `Grundpreis ${k}`);
    if (k === 'eierbecher') cent(p[k], 'untersetzer', 'Untersetzer');
    if (!Array.isArray(p[k].discounts)) p[k].discounts = [];
  }
  if (!p.shipping || typeof p.shipping !== 'object') { p.shipping = { ...DEFAULT_SETTINGS.pricing.shipping }; warn('Versand fehlte – Standard eingesetzt'); }
  for (const k of ['flat', 'freeFrom']) cent(p.shipping, k, `Versand ${k}`);
  cent(p, 'gravur', 'Gravur-Aufpreis');
  if (p.volumen && typeof p.volumen === 'object') cent(p.volumen, 'euro', 'Größenaufschlag €');
  return p;
}

// ---------------------------------------------------------------------------
// PayPal (REST) — aktiv, sobald in den Einstellungen Zugangsdaten hinterlegt sind
// ---------------------------------------------------------------------------
function paypalBase() {
  return settings.paypal.sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
}
async function paypalToken() {
  const auth = Buffer.from(`${settings.paypal.clientId}:${settings.paypal.secret}`).toString('base64');
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error('PayPal-Auth fehlgeschlagen');
  return (await r.json()).access_token;
}
const paypalEnabled = () => !!(settings.paypal?.enabled && settings.paypal?.clientId);
const PAYPAL_ID_RE = /^[A-Z0-9]{10,30}$/;
// Eingelöste Zahlungen (data/paypal-captures.json): PayPal-Order-ID → { amount, currency, capturedAt, usedBy }.
// Der Checkout gilt nur als bezahlt, wenn die ID hier mit passendem Betrag liegt und noch keiner Bestellung zugeordnet ist.
const CAPTURES_FILE = path.join(DATA, 'paypal-captures.json');
const CAPTURES_MAX = 500;
let paypalCaptures = {};
// Unlesbar beim Start → Startabbruch wie users.json (leer weiterzulaufen hieße, eine eingelöste Zahlung ein zweites Mal anzunehmen)
function loadCaptures() { paypalCaptures = ladeDatei(CAPTURES_FILE, { pruefe: (v) => (v === null ? {} : nurObjekt(v)) }) || {}; }
const capturesSchreiben = speicherKette(CAPTURES_FILE, () => JSON.stringify(paypalCaptures, null, 2));
async function saveCaptures() {
  const ids = Object.keys(paypalCaptures);
  if (ids.length > CAPTURES_MAX) for (const id of ids.slice(0, ids.length - CAPTURES_MAX)) delete paypalCaptures[id];   // älteste zuerst (Einfügereihenfolge)
  await capturesSchreiben();
}
/** Betrag/Währung aus einer PayPal-Order-Antwort (Capture bevorzugt, sonst purchase_unit) */
function paypalAmountOf(j) {
  const pu = j?.purchase_units?.[0];
  const a = pu?.payments?.captures?.[0]?.amount || pu?.amount || {};
  return { amount: String(a.value ?? ''), currency: String(a.currency_code ?? '') };
}
/**
 * Zahlung zu einer PayPal-Order-ID bestätigen: aus dem Capture-Speicher, sonst Nachfrage bei PayPal
 * (status COMPLETED). Liefert den Eintrag oder wirft einen Fehler mit lesbarer Meldung.
 */
async function verifyPaypalCapture(id) {
  let cap = paypalCaptures[id];
  if (!cap) {
    const token = await paypalToken();
    const r = await fetch(`${paypalBase()}/v2/checkout/orders/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = r.ok ? await r.json() : null;
    if (!j || j.status !== 'COMPLETED') throw new Error('Zahlung nicht bestätigt');
    cap = { ...paypalAmountOf(j), capturedAt: new Date().toISOString(), usedBy: null };
    paypalCaptures[id] = cap;
  }
  return cap;
}
/**
 * Erstattung (Reklamation) über die PayPal-API: Capture-ID zur PayPal-Order holen, dann Teil-/Vollerstattung.
 * Wirft Fehler mit lesbarer Meldung; PayPal-Request-Id macht den Aufruf je Reklamation idempotent.
 */
async function paypalRefund(order, amount) {
  if (!paypalEnabled() || !settings.paypal?.secret) throw new Error('PayPal ist nicht aktiviert (Client-ID/Secret fehlen in den Einstellungen)');
  const id = String(order.paypalOrderId || '');
  if (!PAYPAL_ID_RE.test(id)) throw new Error('Die Bestellung hat keine gültige PayPal-Zahlungs-ID');
  const token = await paypalToken();
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const r = await fetch(`${paypalBase()}/v2/checkout/orders/${id}`, { headers: hdr });
  const j = r.ok ? await r.json() : null;
  if (!j) throw new Error(`Zahlung ${id} bei PayPal nicht gefunden (HTTP ${r.status})`);
  const cap = j.purchase_units?.[0]?.payments?.captures?.[0];
  if (!cap?.id) throw new Error('Zu dieser Zahlung liegt bei PayPal kein Zahlungseinzug (Capture) vor');
  const rr = await fetch(`${paypalBase()}/v2/payments/captures/${cap.id}/refund`, {
    method: 'POST',
    // Interne Idempotenz-Kennung (nicht sichtbar) — Präfix bleibt, damit eine wiederholte Erstattung nicht doppelt ausgezahlt wird
    headers: { ...hdr, 'PayPal-Request-Id': `ovju-rekla-${order.orderId}-${Date.parse(order.reklamation?.createdAt) || 0}` },
    body: JSON.stringify({
      amount: { value: Number(amount).toFixed(2), currency_code: cap.amount?.currency_code || settings.pricing.currency },
      note_to_payer: `Erstattung zu Bestellung ${order.orderId}`,
    }),
  });
  const rj = await rr.json().catch(() => ({}));
  if (!rr.ok || !['COMPLETED', 'PENDING'].includes(rj.status)) {
    throw new Error(rj.details?.[0]?.description || rj.message || `PayPal antwortet mit HTTP ${rr.status}`);
  }
  return { id: String(rj.id || ''), status: rj.status };
}

// ---------------------------------------------------------------------------
// Kasse mit PayPal: vor der Zahlung dieselben Prüfungen wie beim Checkout (pruefeKasse), Preisgarantie ab dem Klick auf
// „Jetzt kaufen“ und ein Sicherheitsnetz, falls der Checkout nach eingezogener Zahlung trotzdem ablehnt.
//   /api/paypal/create merkt sich je PayPal-Order-ID den geprüften Stand (Warenkorb-Hash, Gutschein, Summen, Zeitpunkt der
//   Beschaffenheits-Bestätigung). Der Checkout übernimmt genau diese Summen, wenn Warenkorb und eingezogener Betrag passen —
//   endet in der Zwischenzeit eine Aktion oder ändert der Admin Preise, bleibt es beim bezahlten Betrag. Im Speicher, 3 Stunden
//   (nach einem Neustart rechnet der Checkout wie bei Vorkasse neu). Lehnt der Checkout nach dem Einzug ab, wird die Zahlung
//   automatisch über PayPal erstattet; klappt das nicht, bekommt der Shop eine Mail und einen Hinweis im Admin.
// ---------------------------------------------------------------------------
const MAX_POSITIONEN = 20;   // verschiedene Designs je Bestellung (Client begrenzt den Warenkorb genauso)
const PAYPAL_PENDING_TTL = 3 * 3600e3;
const paypalPending = new Map();   // PayPal-Order-ID → { hash, totals, beschaffenheitAt, at }
const kasseHash = (items, couponCode) => sha256(JSON.stringify({ items, coupon: String(couponCode || '').trim().toUpperCase() }));
function paypalPendingAufraeumen(now = Date.now()) {
  for (const [id, e] of paypalPending) if (now - e.at > PAYPAL_PENDING_TTL) paypalPending.delete(id);
}
/**
 * Unsichtbare Formatzeichen (Unicode Cf: Bidi-Marken und -Einbettungen, Null-Breiten-Zeichen, weiches Trennzeichen, BOM …) entfernen
 * — sie kommen beim Kopieren aus Kontakten mit, sind auf Belegen unsichtbar und könnten die Leserichtung verdrehen
 */
const ohneFormatzeichen = (v) => String(v ?? '').replace(/\p{Cf}+/gu, '');
/**
 * Gravurtext und Farbname einer Position für Bestellung und Belege: ohne C0/C1-Steuer- und Formatzeichen, Gravur höchstens
 * GRAVUR_MAX Zeichen wie das Kassenfeld (maxlength; ein Ersatzpaar wird nicht zerteilt). Die Druckdatei kommt vom Konfigurator,
 * der dieselbe Grenze hat — gekürzt wird also nur, was nicht aus dem Shop stammt.
 */
const GRAVUR_MAX = 30;
const positionsText = (v) => ohneFormatzeichen(v).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ');
function positionSauber(l) {
  const config = l.config && typeof l.config.text === 'string'
    ? { ...l.config, text: positionsText(l.config.text).slice(0, GRAVUR_MAX).replace(/[\ud800-\udbff]$/, '') } : l.config;
  return { config, colorName: typeof l.colorName === 'string' ? positionsText(l.colorName).trim().slice(0, 80) : l.colorName };
}
/**
 * Kundendaten aus der Kasse: nur die bekannten Felder, ohne Steuerzeichen (C0/C1) und unsichtbare Formatzeichen, mit
 * Längengrenzen (Notiz darf Zeilenumbrüche haben) — auf Rechnung und PDF stehen so nur sichtbare Zeichen
 */
function kundeAus(raw) {
  const clip = (v, n, nl = false) => ohneFormatzeichen(v).replace(nl ? /[^\S\n]+|[\x00-\x08\x0b-\x1f\x7f-\x9f]+/g : /[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').trim().slice(0, n);
  return {
    name: clip(raw?.name, 120), email: clip(raw?.email, 254).toLowerCase(),
    street: clip(raw?.street, 200), zip: clip(raw?.zip, 20), city: clip(raw?.city, 120),
    note: clip(raw?.note, 1000, true),
  };
}
/**
 * Gemeinsame Prüfung für /api/paypal/create (vor der Zahlung) und /api/checkout: Adresse, Warenkorb (1–20 Positionen),
 * Produkt- und Farbsperre, gesonderte Vereinbarung zu Wasser und Standfestigkeit (§ 476 Abs. 1 Satz 2 BGB), Gutschein und der
 * in der Kasse angezeigte Gesamtbetrag (expectedTotal, § 312j Abs. 2 BGB / AGB § 6 Abs. 1: es gilt der Preis, den die Kasse
 * zeigt) — weicht er vom Server-Betrag ab, gibt es 409 statt einer Bestellung zu einem anderen Preis.
 * garantie = gemerkter Stand aus /api/paypal/create (Summen stehen fest, Vereinbarung wurde vor der Zahlung geprüft).
 * → { customer, items, totals } oder { status, error, code?, total?, customer }
 */
function pruefeKasse(data, { garantie = null } = {}) {
  const customer = kundeAus(data?.customer);
  if (!customer.name || !isEmail(customer.email) || !customer.street || !customer.zip || !customer.city) {
    return { status: 400, error: 'Bitte Adresse vollständig ausfüllen', customer };
  }
  // Umlaute vor dem @: die Bestätigung käme nie an (lib/eingaben.js emailLokalFehler — derselbe Text wie im Browser)
  const lokal = emailLokalFehler(customer.email);
  if (lokal) return { status: 400, error: lokal, customer };
  // PLZ wie das Kassenfeld (pattern [0-9]{4,5}); Zahlart nur Vorkasse oder PayPal (alles andere wäre still als Vorkasse angelegt worden)
  if (!/^[0-9]{4,5}$/.test(customer.zip)) return { status: 400, error: 'Bitte eine gültige Postleitzahl angeben (4 oder 5 Ziffern).', customer };
  if (data.payment !== undefined && data.payment !== null && !['vorkasse', 'paypal'].includes(data.payment)) {
    return { status: 400, error: 'Unbekannte Zahlungsart – bitte Überweisung (Vorkasse) oder PayPal wählen.', customer };
  }
  const items = data?.items;
  if (!Array.isArray(items) || !items.length) return { status: 400, error: 'Warenkorb ist leer', customer };
  if (items.length > MAX_POSITIONEN) return { status: 400, error: `Höchstens ${MAX_POSITIONEN} verschiedene Designs pro Bestellung – bitte teil deine Bestellung auf.`, customer };
  if (garantie) return { customer, items, totals: garantie.totals };
  // Werte wie im Konfigurator, bekannte Farben (lib/eingaben.js) — bei PayPal schon vor der Zahlung geprüft (garantie = dieselben Positionen)
  const ungueltig = positionenFehler(items);
  if (ungueltig) return { status: 400, error: ungueltig, customer };
  // Produktschalter (derzeit Eierbecher) und aus dem Shop genommene Farben vor der Preisberechnung abweisen
  const sperre = produktSperre(items) || farbSperre(items);
  if (sperre) return { status: 400, error: sperre, customer };
  // Ohne die gesonderte Vereinbarung gälten die objektiven Anforderungen (§ 434 Abs. 3 BGB) — Kassen-Tabs von vor der
  // Umstellung schicken das Feld nicht und müssen neu laden
  if (data.beschaffenheit !== true) {
    return { status: 400, error: 'Bitte bestätige die Vereinbarung zu Wasser und Standfestigkeit (Häkchen in der Kasse) – fehlt das Häkchen, lade die Seite bitte neu.', customer };
  }
  const totals = computeTotals(items, data.couponCode, { email: customer.email });
  // Gutschein, der (inzwischen) nicht mehr gilt — laufende Aktion, Mindestbestellwert unterschritten, aufgebraucht: lieber abbrechen
  // als still ohne Gutschein abrechnen — der Kunde sieht die Meldung in der Kasse und kann den Code entfernen
  if (data.couponCode && totals.couponError) return { status: 400, error: totals.couponError, code: 'gutschein', customer };
  const exp = data.expectedTotal === undefined || data.expectedTotal === null || data.expectedTotal === '' ? NaN : Number(data.expectedTotal);
  if (!Number.isFinite(exp)) {
    return { status: 409, code: 'preis', total: totals.total, customer, error: 'Die Kasse ist nicht mehr aktuell – bitte lade die Seite neu und prüf den Betrag.' };
  }
  if (Math.abs(exp - totals.total) > 0.005) {
    // Kassen-Tab von vor der Versandregel „Freigrenze vor Gutschein/Guthaben“ (cart.js ohne kasseStand 2) rechnet den Versand anders
    // und käme mit „Preise neu laden“ nicht weiter — er muss die Seite neu laden
    const veraltet = !(Number(data.kasseStand) >= 2);
    return { status: 409, code: 'preis', total: totals.total, customer, error: veraltet ? 'Die Kasse ist nicht mehr aktuell – bitte lade die Seite neu und prüf den Betrag.' : `Der Preis hat sich gerade geändert: Gesamt jetzt ${money(totals.total)}. Bitte prüf die Kasse und bestätige noch einmal.` };
  }
  return { customer, items, totals };
}
/**
 * Automatische Erstattung einer eingezogenen PayPal-Zahlung, zu der die Kasse keine Bestellung anlegen konnte.
 * Idempotent über die PayPal-Request-Id (interne Kennung, Präfix bleibt). → { erstattet, fehler? } — Ergebnis steht im Capture-Speicher.
 */
async function paypalKasseErstatten(id, cap, grund) {
  if (cap.erstattet) return { erstattet: true };
  try {
    if (!paypalEnabled() || !settings.paypal?.secret) throw new Error('PayPal-Zugangsdaten fehlen');
    const token = await paypalToken();
    const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const r = await fetch(`${paypalBase()}/v2/checkout/orders/${id}`, { headers: hdr });
    const j = r.ok ? await r.json() : null;
    const capId = j?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (!capId) throw new Error(`Zahlungseinzug zu ${id} bei PayPal nicht gefunden (HTTP ${r.status})`);
    const rr = await fetch(`${paypalBase()}/v2/payments/captures/${capId}/refund`, {
      method: 'POST',
      headers: { ...hdr, 'PayPal-Request-Id': `ovju-kasse-${id}` },
      body: JSON.stringify({ note_to_payer: 'Deine Bestellung konnte nicht angelegt werden – die Zahlung wird vollständig erstattet.' }),
    });
    const rj = await rr.json().catch(() => ({}));
    if (!rr.ok || !['COMPLETED', 'PENDING'].includes(rj.status)) throw new Error(rj.details?.[0]?.description || rj.message || `PayPal antwortet mit HTTP ${rr.status}`);
    cap.erstattet = { at: new Date().toISOString(), refundId: String(rj.id || ''), status: rj.status, grund };
    delete cap.problem;
    console.warn(`↩️  PayPal ${id}: Kasse abgelehnt (${grund}) – ${cap.amount} ${cap.currency} automatisch erstattet`);
    return { erstattet: true };
  } catch (err) {
    cap.problem = { at: new Date().toISOString(), grund, fehler: String(err?.message || err) };
    console.error(`⚠️  PayPal ${id}: Kasse abgelehnt (${grund}) – automatische Erstattung fehlgeschlagen: ${cap.problem.fehler}`);
    return { erstattet: false, fehler: cap.problem.fehler };
  } finally {
    await saveCaptures().catch((e) => console.error('paypal-captures.json konnte nicht gespeichert werden:', e?.message || e));
  }
}
/** Checkout lehnt nach eingezogener PayPal-Zahlung ab: erstatten, den Shop informieren, der Kundschaft ehrlich sagen, was passiert */
async function kasseAbgelehntNachZahlung(res, id, cap, status, body, kunde) {
  const grund = String(body.error || 'Bestellung abgelehnt');
  const r = await paypalKasseErstatten(id, cap, grund);
  try {   // Meldung an den Shop — unabhängig von „Kopie an den Shop“, hier geht es um Geld
    const admins = adminEmpfaenger();
    if (admins.length) {
      const m = adminPaypalKasse({ p: { id, amount: cap.amount, currency: cap.currency, capturedAt: cap.capturedAt, grund, erstattet: r.erstattet, fehler: r.fehler, customer: { name: kunde?.name, email: kunde?.email } }, settings, baseUrl: baseUrlFor(settings) });
      await mailer.queue({ to: admins, replyTo: antwortAn(kunde?.email), subject: m.subject, text: m.text, html: m.html, kind: 'admin-paypal', ref: id });
    }
  } catch (err) { console.error(`PayPal ${id}: Meldung an den Shop fehlgeschlagen:`, err?.message || err); }
  const zusatz = r.erstattet
    ? ' Deine PayPal-Zahlung habe ich deshalb automatisch erstattet – das Geld ist in wenigen Tagen wieder bei dir.'
    : ' Deine PayPal-Zahlung ist bei mir eingegangen – ich melde mich bei dir und erstatte sie.';
  return send(res, status, { ...body, error: `${grund}${zusatz}`, bezahlt: true, erstattet: r.erstattet });
}
/** Admin-Hinweise: eingezogene PayPal-Zahlungen der letzten 30 Tage ohne Bestellung und ohne Erstattung (älter als 15 Minuten) */
function paypalHinweise(now = Date.now()) {
  return Object.entries(paypalCaptures)
    .filter(([, c]) => c && !c.usedBy && !c.erstattet && Number.isFinite(Date.parse(c.capturedAt)) && now - Date.parse(c.capturedAt) > 15 * 60e3 && now - Date.parse(c.capturedAt) < 30 * TAG_MS)
    .map(([id, c]) => `PayPal-Zahlung ${id} über ${c.amount} ${c.currency} vom ${dateDE(c.capturedAt)} gehört zu keiner Bestellung${c.problem ? ` (automatische Erstattung fehlgeschlagen: ${c.problem.fehler})` : ''} – bitte in PayPal prüfen und erstatten.`);
}

// ---------------------------------------------------------------------------
// Reklamation / Rückversand / Gutschrift (order.reklamation) — Endpoint POST /api/admin/reklamation
//   { status: offen|ruecksendung|eingegangen|erledigt|abgelehnt, art: nachdruck|gutschein|ueberweisung|paypal,
//     grund, betrag, ruecksendung, iban?, gutschriftNo?, gutscheinCode?, refundId?, note?, createdAt, updatedAt, resolvedAt? }
// ---------------------------------------------------------------------------
const REKLA_ACTIONS = ['anlegen', 'eingegangen', 'erledigen', 'ablehnen', 'zuruecknehmen'];
const REKLA_OPEN = ['offen', 'ruecksendung', 'eingegangen'];   // noch in Bearbeitung
// Welche Kundenmail-Phase zu welchem Reklamationsstatus gehört (Admin-Vorschau/-Versand; Spiegel von reklaPhase() im Admin-UI)
const REKLA_PHASE_OF = { offen: 'angelegt', ruecksendung: 'angelegt', eingegangen: 'eingegangen', erledigt: 'erledigt', abgelehnt: 'abgelehnt' };
/** IBAN-Prüfziffer (ISO 13616, mod 97) — nur für Hinweise; gespeichert wird auch eine IBAN mit falscher Prüfziffer (Testdaten) */
function ibanPruefzifferOk(iban) {
  const c = String(iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(c)) return false;
  let rest = 0;
  for (const ch of c.slice(4) + c.slice(0, 4)) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}
/** IBAN-Eingabe: nur A–Z/0–9 (Leerzeichen erlaubt), 15–34 Zeichen → Vierergruppen; '' bei leer, null bei ungültig */
function cleanIban(raw) {
  const s = String(raw ?? '').toUpperCase().trim();
  if (!s) return '';
  if (!/^[A-Z0-9 ]+$/.test(s)) return null;
  const compact = s.replace(/ /g, '');
  if (compact.length < 15 || compact.length > 34 || !/^[A-Z]{2}[0-9]{2}/.test(compact)) return null;
  return compact.replace(/(.{4})/g, '$1 ').trim();
}
/** Freitext aus dem Admin: Steuerzeichen raus, Länge begrenzen */
const clipText = (v, n) => String(v ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, ' ').trim().slice(0, n);
/**
 * Eindeutiger Guthaben-Code GH-XXXX-XXXX (ohne verwechselbare Zeichen), geprüft gegen settings.coupons — „GH“ statt früher „GS“,
 * damit er nicht wie eine Gutschrift-/Stornonummer (GS-2026-0003) aussieht; ältere GS-Codes bleiben gültig
 */
function newCouponCode() {
  const taken = new Set((settings.coupons || []).map((c) => String(c?.code || '').trim().toUpperCase()));
  for (;;) {
    let c = 'GH-';
    for (let i = 0; i < 8; i++) c += (i === 4 ? '-' : '') + CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!taken.has(c)) return c;
  }
}
/** Erstatteter Betrag einer Bestellung (erledigte Gutschrift/Erstattung, kein Nachdruck) — für Umsatz-KPIs */
const refundAmount = (o) => (o?.reklamation?.status === 'erledigt' && o.reklamation.art !== 'nachdruck' ? euro(o.reklamation.betrag) : 0);
/** Kundenansicht (Konto): ohne IBAN, Grund und interne Notiz */
const publicRekla = (r) => (r && typeof r === 'object' ? {
  status: r.status, art: r.art, betrag: euro(r.betrag), gutscheinCode: r.gutscheinCode || '', gutschriftNo: r.gutschriftNo || '',
  createdAt: r.createdAt || null, resolvedAt: r.resolvedAt || null,
} : null);

// ---------------------------------------------------------------------------
// Widerruf (data/widerrufe.json) — elektronische Widerrufsfunktion „Vertrag widerrufen“ (Seite /widerruf#widerrufen)
//   POST /api/widerruf { orderId?, name, email, nachricht? } → { ok, ref: 'WR-YYMMDD-XXXX', at }
//   Jede Erklärung wird gespeichert, per Mail bestätigt (Inhalt, Datum + Uhrzeit des Eingangs, Referenz) und dem Shop
//   gemeldet. Passen Bestellnummer und E-Mail zusammen, landet der Eingang zusätzlich in der Bestellung
//   (order.widerrufe + Historie). Die Antwort ist immer gleich — sie verrät nichts über fremde Bestellungen.
//   Admin: GET /api/admin/widerrufe (neueste zuerst) · POST /api/admin/widerruf-status { ref, status, notiz }
//   Eintrag: { ref, at, orderId, name, email, nachricht, orderMatched, status: 'offen'|'erledigt', notiz }
// ---------------------------------------------------------------------------
const WIDERRUF_FILE = path.join(DATA, 'widerrufe.json');
const WIDERRUF_STATUS = ['offen', 'erledigt'];
const WIDERRUF_REF_RE = /^WR-\d{6}-[A-F0-9]{4}$/;
const WIDERRUF_IP_MAX = 10;   // wie „Passwort vergessen“ je IP: 10 Erklärungen in 15 Minuten
/** widerrufe.json lesen — fehlt die Datei: []; ist sie unlesbar, wird sie beiseitegelegt (nichts geht verloren) und neu begonnen */
async function readWiderrufe() {
  let raw;
  try { raw = await readFile(WIDERRUF_FILE, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error('keine Liste');
    return list.filter((w) => w && typeof w === 'object');
  } catch (err) {
    const backup = `${WIDERRUF_FILE}.defekt-${Date.now()}`;
    await rename(WIDERRUF_FILE, backup);
    console.error(`⚠️  widerrufe.json unlesbar (${err.message}) – gesichert als ${path.basename(backup)}, neue Liste begonnen`);
    return [];
  }
}
// Zugriffe auf widerrufe.json nacheinander (wie lockOrder): fn(liste) → { result, changed } — bei changed wird atomar geschrieben
let widerrufChain = Promise.resolve();
function withWiderrufe(fn) {
  const run = widerrufChain.then(async () => {
    const list = await readWiderrufe();
    const out = (await fn(list)) || {};
    if (out.changed) await writeFileAtomic(WIDERRUF_FILE, JSON.stringify(list, null, 2));
    return out.result;
  });
  widerrufChain = run.catch(() => {});
  return run;
}
/** Neue Referenz WR-YYMMDD-XXXX (eindeutig in der Liste) */
function newWiderrufRef(list) {
  const taken = new Set(list.map((w) => w.ref));
  for (;;) {
    const ref = `WR-${stampYYMMDD()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    if (!taken.has(ref)) return ref;
  }
}

// ---------------------------------------------------------------------------
// Rechtsseiten (lib/legal.js): /impressum /datenschutz /agb /widerruf /versand — HTML aus den Einstellungen gerendert.
// Das Modul wird dynamisch geladen: fehlt es (oder ist es fehlerhaft), antworten die Routen mit 503 und einer
// Notseite mit den Anbieterangaben, statt den Server zu stoppen.
// ---------------------------------------------------------------------------
const LEGAL_ROUTES = ['impressum', 'datenschutz', 'agb', 'widerruf', 'versand'];
let legalMod = null;
let legalWarned = false;
async function legalModule() {
  if (legalMod) return legalMod;
  try {
    const m = await import('./lib/legal.js');
    if (typeof m.renderLegalPage !== 'function') throw new Error('renderLegalPage fehlt');
    legalMod = m;
    legalWarned = false;
  } catch (err) {
    if (!legalWarned) { legalWarned = true; console.warn(`⚠️  Rechtsseiten nicht verfügbar (lib/legal.js): ${err?.message || err}`); }
    return null;
  }
  return legalMod;
}
/** Notseite (503), solange lib/legal.js fehlt: wenigstens Anbieter und Kontakt, bei /widerruf der Weg per E-Mail */
function legalFallbackHTML(slug) {
  const co = settings.company || {};
  const titel = { impressum: 'Impressum', datenschutz: 'Datenschutz', agb: 'AGB', widerruf: 'Widerruf', versand: 'Versand & Zahlung' }[slug] || 'Rechtliches';
  const anbieter = [co.name || BRAND, co.owner, co.street, companyOrt(co)].map((x) => String(x || '').trim()).filter(Boolean).map(esc).join('<br>');
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${titel} · ${BRAND}</title>
  <style>body{font-family:system-ui,sans-serif;background:#f4efe7;color:#211d18;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.6}h1{font-family:Georgia,serif;font-weight:normal}a{color:#9e4f2c}</style></head><body>
  <h1>${titel}</h1><p>Diese Seite ist gleich wieder erreichbar – bitte versuch es in ein paar Minuten noch einmal.</p>
  <p><b>Anbieter</b><br>${anbieter}${co.email ? `<br>E-Mail: ${esc(co.email)}` : ''}</p>
  ${slug === 'widerruf' && co.email ? `<p>Du möchtest einen Vertrag widerrufen? Schreib mir einfach eine E-Mail an ${esc(co.email)}.</p>` : ''}
  <p><a href="/">Zurück zum Shop</a></p></body></html>`;
}

// ---------------------------------------------------------------------------
// Öffentliche Adresse für Suchmaschinen und Link-Vorschau: Startseite (Canonical, og:url, og:image, twitter:image),
// robots.txt und sitemap.xml nehmen mail.publicUrl; leer oder lokal (localhost/127.…) → Hauptadresse www.formsam.com
// ---------------------------------------------------------------------------
const HAUPTADRESSE = 'https://www.formsam.com';
function oeffentlicheAdresse() {
  const u = String(settings.mail?.publicUrl || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s"'<>]+$/i.test(u) && !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(u) ? u : HAUPTADRESSE;
}
/**
 * robots.txt: Admin, Belege und Konto-/Admin-API nicht crawlen; Preise, Farben, Texte, Skripte und Stile bleiben frei (braucht
 * die Suchmaschine zum Darstellen der Startseite). Im Wartungsmodus alles sperren (die Datei ist dann ohne Kennwort erreichbar).
 */
function robotsTxt() {
  if (wartungAktiv()) return 'User-agent: *\nDisallow: /\n';
  return ['User-agent: *', 'Disallow: /admin', 'Disallow: /orders/', 'Disallow: /api/admin/', 'Disallow: /api/auth/', '',
    `Sitemap: ${oeffentlicheAdresse()}/sitemap.xml`, ''].join('\n');
}
/** sitemap.xml: Startseite und die fünf Rechtsseiten (ohne lastmod — die Rechtsseiten ändern sich mit den Einstellungen) */
function sitemapXml() {
  const base = oeffentlicheAdresse();
  const urls = ['/', ...LEGAL_ROUTES.map((r) => `/${r}`)].map((u) => `  <url><loc>${esc(base + u)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
/**
 * Startseite (public/index.html) mit Canonical und Vorschau-Adressen aus der öffentlichen Adresse. Zwischengespeichert je
 * Dateistand und Adresse; das ETag kommt aus dem Ergebnis (ändert sich also auch, wenn nur die Adresse im Admin wechselt).
 */
let startseiteCache = null;   // { key, html, gz, etag }
function startseite() {
  const file = path.join(PUBLIC, 'index.html');
  if (!existsSync(file)) return null;
  const st = statSync(file), base = oeffentlicheAdresse();
  const key = `${st.mtimeMs}|${st.size}|${base}`;
  if (startseiteCache?.key === key) return startseiteCache;
  const b = esc(base);
  const html = readFileSync(file, 'utf8')
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${b}/$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${b}/$2`)
    .replace(/(<meta (?:property="og:image"|name="twitter:image") content=")[^"]*?(\/img\/brand\/og\.jpg")/g, `$1${b}$2`);
  const etag = `"s-${crypto.createHash('sha1').update(html).digest('base64url').slice(0, 20)}"`;
  startseiteCache = { key, html, gz: gzipSync(html, { level: zc.Z_BEST_SPEED }), etag };
  return startseiteCache;
}

/**
 * Fehlerseite für Beleg- und Modell-Links (/orders/…) bei 404 (Link unvollständig, falscher Schlüssel, unbekannt) und 429
 * (zu viele Fehlgriffe) — im formsam-Look, mit Weg zur Hilfe, ohne Auskunft darüber, ob es die Bestellung gibt.
 */
function sendBelegFehler(res, code) {
  const co = settings.company || {};
  const mail = String(co.email || '').trim();
  const text = code === 429
    ? '<p>Von deinem Anschluss kamen gerade zu viele Aufrufe mit unvollständigen Links. Bitte versuch es in 15 Minuten noch einmal – mit dem vollständigen Link aus deiner Bestellbestätigung.</p>'
    : '<p>Dieser Link ist unvollständig oder nicht mehr gültig. Den vollständigen Link zu deiner Rechnung findest du in deiner Bestellbestätigung per E-Mail (Knopf „Rechnung ansehen“) – kopiere ihn am besten ganz, er endet mit einem langen Schlüssel.</p>';
  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${code === 429 ? 'Bitte kurz warten' : 'Link nicht gültig'} · ${BRAND}</title>
  <style>@font-face{font-family:'Fraunces';src:url(/fonts/fraunces-latin.woff2) format('woff2');font-weight:400 700;font-display:swap}
  @font-face{font-family:'Inter';src:url(/fonts/inter-latin.woff2) format('woff2');font-weight:100 900;font-display:swap}
  body{margin:0;background:#f4efe7;color:#211d18;font:16px/1.6 Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
  main{max-width:560px;margin:48px auto;padding:32px 28px;background:#fbf8f2;border-radius:18px;box-shadow:0 14px 36px rgba(33,29,24,.08)}
  .logo{display:block;height:34px;width:auto;margin-bottom:24px}.wortmarke{font-family:Fraunces,Georgia,serif;font-size:30px}
  h1{font-family:Fraunces,Georgia,serif;font-weight:500;font-size:26px;line-height:1.2;margin:0 0 12px}a{color:#9e4f2c}
  @media (max-width:600px){main{margin:16px;padding:24px 20px}}</style></head><body><main>
  ${logoHTML(34)}<h1>${code === 429 ? 'Bitte kurz warten' : 'Dieser Link funktioniert so nicht'}</h1>${text}
  ${mail ? `<p>Findest du die E-Mail nicht mehr? Schreib mir an <a href="mailto:${esc(mail)}">${esc(mail)}</a> und nenn mir deine Bestellnummer – ich schicke dir den Link noch einmal.</p>` : ''}
  <p><a href="/">Zum Shop</a></p></main></body></html>`;
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', ...(code === 429 ? { 'Retry-After': '900' } : {}) });
  res.end(html);
}

/**
 * Unbekannte Adresse: API → JSON, Seitenaufrufe (Accept text/html bzw. Pfad ohne Endung) → kleine Seite im formsam-Look mit Weg
 * zurück in den Shop, alles andere (Bilder, Skripte …) → kurzer Text. Rechtsseiten in anderer Schreibweise (/Impressum,
 * /impressum.html) → 301 auf die richtige Adresse. Status bleibt 404.
 */
function sendNichtGefunden(req, res, p, url) {
  if (p.startsWith('/api/')) return send(res, 404, { ok: false, error: 'Unbekannte Schnittstelle' });
  const slug = p.length < 40 ? p.slice(1).toLowerCase().replace(/\/+$/, '').replace(/\.html?$/, '') : '';
  if (LEGAL_ROUTES.includes(slug) && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(301, { Location: `/${slug}${url.search}`, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  const seite = /text\/html/.test(String(req.headers.accept || '').slice(0, 500)) || !path.extname(p);
  if (!seite) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Seite nicht gefunden · ${BRAND}</title>
  <style>@font-face{font-family:'Fraunces';src:url(/fonts/fraunces-latin.woff2) format('woff2');font-weight:400 700;font-display:swap}
  @font-face{font-family:'Inter';src:url(/fonts/inter-latin.woff2) format('woff2');font-weight:100 900;font-display:swap}
  body{margin:0;background:#f4efe7;color:#211d18;font:16px/1.6 Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
  main{max-width:560px;margin:48px auto 24px;padding:32px 28px;background:#fbf8f2;border-radius:18px;box-shadow:0 14px 36px rgba(33,29,24,.08)}
  .logo{display:block;height:34px;width:auto;margin-bottom:24px}.wortmarke{font-family:Fraunces,Georgia,serif;font-size:30px}
  h1{font-family:Fraunces,Georgia,serif;font-weight:500;font-size:26px;line-height:1.2;margin:0 0 12px}a{color:#9e4f2c}
  .knopf{display:inline-block;margin-top:8px;padding:10px 22px;border-radius:999px;background:#211d18;color:#f4efe7;text-decoration:none}
  footer{max-width:560px;margin:0 auto 40px;padding:0 28px;font-size:14px;color:#6b6157}footer a{color:inherit}
  @media (max-width:600px){main{margin:16px;padding:24px 20px}footer{padding:0 20px}}</style></head><body><main>
  <a href="/" aria-label="Zur Startseite">${logoHTML(34)}</a><h1>Diese Seite gibt es nicht</h1>
  <p>Unter dieser Adresse ist nichts zu finden – vielleicht ein Tippfehler oder ein veralteter Link.</p>
  <p><a class="knopf" href="/">Zum Shop</a></p></main>
  <footer><a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a> · <a href="/agb">AGB</a> · <a href="/widerruf">Widerruf</a></footer></body></html>`;
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : html);
}

// ---------------------------------------------------------------------------
// Bestellungen
// ---------------------------------------------------------------------------
const bestellungenDefekt = new Set();   // Ordner mit unlesbarer order.json — Hinweis im Admin (settingsHinweise)
async function listOrders() {
  if (!existsSync(ORDERS)) return [];
  const dirs = (await readdir(ORDERS, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
  const orders = [];
  for (const d of dirs) {
    try { orders.push(await readOrder(d)); bestellungenDefekt.delete(d); } catch (err) {
      // fehlt order.json (Kasse legt den Ordner gerade an) → still überspringen; beschädigt → laut melden statt still verschwinden
      if (err?.code === 'ENOENT') continue;
      if (!bestellungenDefekt.has(d)) console.error(`⚠️  Bestellung ${d}: order.json unlesbar (${err?.message || err}) – sie fehlt im Admin`);
      bestellungenDefekt.add(d);
    }
  }
  return orders;
}

// ---------------------------------------------------------------------------
// Abgebrochene Kassen aufräumen (Datensparsamkeit — ohne Abschluss gibt es keinen Vertrag): Bestellungen, die nach
// KASSE_AUFRAEUMEN_TAGE noch immer ohne Abschluss, Rechnung und Zahlung sind, werden samt Ordner (Adresse, Modelldateien) gelöscht.
// Ihre Druckdateien (bis 190 MB je Position) schon nach KASSE_DATEIEN_STUNDEN — bei weniger als SPEICHER_KNAPP freiem Speicher nach
// einer Stunde (dann stößt auch ein Upload den Lauf an, höchstens alle 10 Minuten): Wer die Platte mit nie abgeschlossenen Kassen
// füllen will, hält sie so nicht lange belegt. Eine echte Kasse lädt hoch und schließt gleich danach ab.
// Nie angefasst wird, was eine Rechnung/Gutschrift/Storno, eine Zahlung (auch PayPal), einen Status über „neu“, eine Reklamation,
// einen Widerruf, eine Notiz oder Sendungsnummer, eine Admin-Änderung oder eine verschickte Mail hat — und keine Bestellung von
// vor der Rechnungsnummer (die Kasse schreibt seit jeher invoiceNo: null und filesComplete: false). Lauf beim Start und stündlich.
// ---------------------------------------------------------------------------
const KASSE_AUFRAEUMEN_TAGE = 14;
const KASSE_DATEIEN_STUNDEN = 48;
/** Nie abgeschlossene, unberührte Kasse, die mindestens alterMs alt ist */
function kasseAbgebrochen(o, id, now = Date.now(), alterMs = KASSE_AUFRAEUMEN_TAGE * TAG_MS) {
  const at = Date.parse(o?.createdAt);
  return !!o && typeof o === 'object' && o.orderId === id && Number.isFinite(at) && now - at >= alterMs
    && o.invoiceNo === null && o.filesComplete === false && !o.completedAt
    && o.status === 'neu' && (o.paymentStatus ?? 'offen') === 'offen' && o.payment !== 'paypal' && !o.paypalOrderId && !o.paidAt
    && !o.storno && !o.reklamation && !(Array.isArray(o.widerrufe) && o.widerrufe.length)
    && !String(o.adminNote || '').trim() && !String(o.trackingNo || '').trim()
    && !Object.keys(o.mailsSent || {}).length && !(o.history || []).some((h) => h?.by === 'admin');
}
async function abgebrocheneKassenAufraeumen(now = Date.now(), knapp = false) {
  if (!existsSync(ORDERS)) return 0;
  const frei = await speicherFrei();   // auch Messwert für den Admin-Hinweis
  const dateienNach = knapp || (frei !== null && frei < SPEICHER_KNAPP) ? STUNDE_MS : KASSE_DATEIEN_STUNDEN * STUNDE_MS;
  let n = 0;
  for (const d of await readdir(ORDERS, { withFileTypes: true })) {
    if (!d.isDirectory() || !ORDER_ID_RE.test(d.name)) continue;
    const dir = path.join(ORDERS, d.name);
    const release = await lockOrder(d.name);
    try {
      let o;
      try { o = JSON.parse(await readFile(path.join(dir, 'order.json'), 'utf8')); } catch { continue; }   // unlesbar → nie anfassen
      if (!kasseAbgebrochen(o, d.name, now, dateienNach)) continue;
      const dateien = await readdir(dir);
      if (dateien.some((f) => /^(rechnung|gutschrift|storno)\.html$/.test(f))) continue;
      if (kasseAbgebrochen(o, d.name, now)) {
        await rm(dir, { recursive: true, force: true });
        untrackCouponUse(d.name);
        n++;
        console.log(`🧹 Abgebrochene Kasse ${d.name} vom ${dateDE(o.createdAt)} gelöscht (nie abgeschlossen, keine Rechnung, keine Zahlung)`);
        continue;
      }
      // Nur die Druckdateien (und liegengebliebene Temp-Dateien; ein laufender Upload schreibt seine gerade noch → jünger als 20 min)
      let bytes = 0, k = 0;
      for (const f of dateien) {
        if (!/^modell-\d+-[a-z]+\.(stl|3mf)$|\.tmp$/.test(f)) continue;
        const st = await stat(path.join(dir, f)).catch(() => null);
        if (!st || (f.endsWith('.tmp') && Date.now() - st.mtimeMs < 20 * 60e3)) continue;
        await rm(path.join(dir, f), { force: true });
        bytes += st.size; k++;
      }
      if (k) console.log(`🧹 Druckdateien der nie abgeschlossenen Kasse ${d.name} gelöscht (${k} Datei(en), ${Math.round(bytes / 1e6)} MB) – die Bestellung selbst bleibt bis zum ${KASSE_AUFRAEUMEN_TAGE}. Tag`);
    } catch (err) { console.error(`Aufräumen ${d.name} fehlgeschlagen:`, err?.message || err); }
    finally { release(); }
  }
  return n;
}
let aufraeumenLauf = null, aufraeumenKnappZuletzt = 0;
/** Ein Lauf zur Zeit (Start, stündlich, knapper Speicher teilen sich einen laufenden) */
function kassenAufraeumen(knapp = false) {
  aufraeumenLauf ||= abgebrocheneKassenAufraeumen(Date.now(), knapp).catch((err) => console.error('Aufräumen abgebrochener Kassen fehlgeschlagen:', err?.message || err))
    .finally(() => { aufraeumenLauf = null; });
  return aufraeumenLauf;
}
/** Upload bei knappem Speicher: vorher aufräumen (höchstens alle 10 Minuten ein neuer Lauf) */
function kassenAufraeumenKnapp() {
  if (aufraeumenLauf) return aufraeumenLauf;
  if (Date.now() - aufraeumenKnappZuletzt < 10 * 60e3) return Promise.resolve();
  aufraeumenKnappZuletzt = Date.now();
  console.warn('💾 Weniger als 5 GB frei – Druckdateien nie abgeschlossener Kassen (älter als 1 Stunde) werden jetzt gelöscht');
  return kassenAufraeumen(true);
}

async function handleCheckout(req, res) {
  let data;
  try { data = JSON.parse((await readBody(req)).toString('utf8')); } catch { data = null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { ok: false, error: 'Ungültige Anfrage' });
  const { payment, paypalOrderId } = data;
  // Bremse: höchstens KASSE_IP_MAX neue Kassen je IP und Stunde (gezählt wird nur, was eine Bestellung anlegt). Eine bezahlte
  // PayPal-Kasse wird nie gebremst — das Geld ist schon eingezogen (die Zahlung selbst zählt in /api/paypal/create)
  const kasseKey = `kasse:${clientIp(req)}`;
  if (payment !== 'paypal' && rateLimitReached(kasseKey, KASSE_IP_MAX, STUNDE_MS)) return send(res, 429, GEBREMST());
  // PayPal zuerst: Zahlung serverseitig bestätigen (Capture-Speicher bzw. Nachfrage bei PayPal) — ist das Geld schon eingezogen,
  // endet jede Ablehnung danach mit automatischer Erstattung (kasseAbgelehntNachZahlung), nie mit „bezahlt, aber keine Bestellung“.
  // Die PayPal-ID darf nur einmal verwendet werden; Betrag/Währung müssen zur Bestellung passen.
  let paypalCap = null, garantie = null;
  const ppId = String(paypalOrderId || '');
  if (payment === 'paypal') {
    if (!paypalEnabled()) return send(res, 400, { ok: false, error: 'PayPal nicht aktiviert' });
    if (!PAYPAL_ID_RE.test(ppId)) return send(res, 400, { ok: false, error: 'Ungültige PayPal-Zahlungs-ID' });
    try { paypalCap = await verifyPaypalCapture(ppId); } catch (err) {
      console.error(`PayPal-Prüfung ${ppId} fehlgeschlagen:`, err?.message || err);
      return send(res, 400, { ok: false, error: 'Zahlung nicht bestätigt' });
    }
    if (paypalCap.usedBy) return send(res, 400, { ok: false, error: 'Zahlung nicht bestätigt (bereits einer Bestellung zugeordnet)' });
    if (paypalCap.erstattet) return send(res, 400, { ok: false, error: 'Diese Zahlung wurde bereits erstattet – bitte starte die Kasse neu.' });
    // Preisgarantie: gleicher Warenkorb + Gutschein wie bei „Jetzt kaufen“ und genau der damals berechnete Betrag eingezogen
    const pend = paypalPending.get(ppId);
    if (pend && pend.hash === kasseHash(data.items, data.couponCode) && paypalCap.amount === pend.totals.total.toFixed(2) && paypalCap.currency === settings.pricing.currency) garantie = pend;
  }
  const k = pruefeKasse(data, { garantie });
  if (k.error) {
    const body = { ok: false, error: k.error, ...(k.code ? { code: k.code, total: k.total } : {}) };
    return paypalCap ? kasseAbgelehntNachZahlung(res, ppId, paypalCap, k.status, body, k.customer) : send(res, k.status, body);
  }
  const { customer, totals } = k;
  if (paypalCap && (paypalCap.amount !== totals.total.toFixed(2) || paypalCap.currency !== settings.pricing.currency)) {
    return kasseAbgelehntNachZahlung(res, ppId, paypalCap, 400, { ok: false, error: 'Zahlung nicht bestätigt (Betrag weicht von der Bestellung ab)' }, customer);
  }
  // Guthaben-Gutschein: zwei gleichzeitige Bestellungen dürfen den Restwert nicht doppelt ausgeben — Prüfung und
  // Reservierung passieren ohne await dazwischen (PayPal ist schon bezahlt → dann nicht mehr abbrechen)
  const gc = totals.coupon ? couponByCode(totals.coupon.code) : null;
  if (gc && isGuthaben(gc) && !paypalCap && couponRest(gc) + 0.005 < totals.coupon.off) {
    return send(res, 400, { ok: false, code: 'gutschein', error: `Gutschein „${gc.code}“ wurde inzwischen eingelöst – bitte prüf den Betrag in der Kasse.` });
  }
  if (!paypalCap) forgotLimited(kasseKey, KASSE_IP_MAX, STUNDE_MS);
  // neue Nummer, die es noch nicht gibt (synchron geprüft — ein vorhandener Ordner würde sonst überschrieben)
  let orderId;
  do orderId = newOrderId(); while (existsSync(path.join(ORDERS, orderId)));
  const createdAt = new Date().toISOString();
  if (paypalCap) untrackCouponUse(`paypal:${ppId}`);   // Reservierung aus /api/paypal/create geht auf die Bestellung über
  if (totals.coupon) trackCouponUse({ orderId, coupon: totals.coupon, status: 'neu', createdAt, paymentStatus: paypalCap ? 'bezahlt' : 'offen', customer });
  if (paypalCap) { paypalCap.usedBy = orderId; paypalPending.delete(ppId); await saveCaptures(); }
  await mkdir(path.join(ORDERS, orderId), { recursive: true });
  const account = userFromReq(req);
  const order = {
    orderId,
    // Zugriffsschlüssel für Rechnung, Gutschrift und Modelldateien (siehe orderZugriff) — geht nur an die Kasse zurück
    accessKey: newAccessKey(),
    // Kasse aus einem Shop-Tab von vor der Umstellung (cart.js schickt mitSchluessel noch nicht): Upload und Abschluss
    // dort ohne Schlüssel, damit die Bestellung nicht hängen bleibt — die Belege schützt der Schlüssel trotzdem
    ...(data.mitSchluessel === true ? {} : { kasseOhneSchluessel: true }),
    userId: account?.id || null,
    createdAt,
    status: 'neu',
    payment: paypalCap ? 'paypal' : 'vorkasse',
    paymentStatus: paypalCap ? 'bezahlt' : 'offen',
    paidAt: paypalCap ? paypalCap.capturedAt : null,
    paypalOrderId: paypalCap ? ppId : null,
    customer,
    lines: totals.lines.map((l, i) => ({
      // Gravur und Farbname ohne Steuer-/Formatzeichen, Gravur auf die Länge des Kassenfelds (positionSauber)
      product: l.product, qty: l.qty, saucer: !!l.saucer, config: positionSauber(l).config,
      // Design-Code der Zeile (Warenkorb schickt ihn mit) — für Druckzettel, Admin, Rechnung und Nachbestellung; nur in Normalform
      code: typeof l.code === 'string' && /^[A-Z0-9]{4,20}$/.test(normalizeCode(l.code)) ? normalizeCode(l.code) : null,
      color: l.color, colorName: positionSauber(l).colorName, unit: l.unit, off: l.off, line: l.line, parts: l.parts,
      // Aktion: uvp = Normalpreis (Preis vor der Aktion, Feldname historisch), Prozent und Ersparnis je Stück — 0 wenn die Zeile nicht reduziert war;
      // aktionName/aktionId = die Aktion, die für diese Zeile galt (bei mehreren gleichzeitigen je Zeile verschieden)
      uvp: l.uvp, aktionProzent: l.aktionProzent, aktionBetrag: l.aktionBetrag, aktionName: l.aktionName ?? null, aktionId: l.aktionId ?? null,
      // Farbschrift (zweites Filament) kommt als 3MF mit zwei Teilen, sonst STL
      stlFile: `modell-${i + 1}-${l.product}.${(String(l.config?.text || '').trim() && l.config?.textStyle === 'farbe') ? '3mf' : 'stl'}`,
    })),
    subtotal: totals.subtotal, coupon: totals.coupon, shipping: totals.shipping, total: totals.total,
    // Gesonderte Vereinbarung in der Kasse (Wasser/Standfestigkeit, § 476 Abs. 1 Satz 2 BGB): Zeitpunkt als Nachweis — Pflicht
    // (pruefeKasse); bei PayPal der Zeitpunkt vor der Zahlung (/api/paypal/create)
    beschaffenheitBestaetigt: garantie?.beschaffenheitAt || createdAt,
    beschaffenheitFassung: BESCHAFFENHEIT_FASSUNG,   // Wortlaut des Häkchens: lib/produkthinweise.js BESCHAFFENHEIT_TEXTE[Fassung]
    aktionen: totals.aktionen,   // [{ id, name, prozent, ersparnis, produkte, muster }] je betroffener Aktion (nach Ersparnis absteigend)
    aktion: totals.aktion,       // aktionen[0] | null (Kompatibilität)
    invoiceNo: null, filesComplete: false,
    trackingNo: '', adminNote: '',
  };
  // Nichts zu zahlen (Gutschein/Guthaben deckt alles): bezahlt erst mit dem Abschluss (rechnungFesthalten) — bis dahin ist es
  // eine offene Kasse wie jede andere (nicht in der Druckwarteschlange, eine abgebrochene wird aufgeräumt)
  await writeOrder(order);
  // accessKey: Upload und Abschluss schicken ihn als x-order-key mit (Links auf Rechnung/Modelle tragen ihn als ?k=)
  send(res, 200, { ok: true, orderId, accessKey: order.accessKey, itemCount: order.lines.length, total: order.total });
}

// ---------------------------------------------------------------------------
// Modelldateien der Kasse (PUT /api/order/<ID>/stl/<i>): Der Upload landet in einer Temp-Datei und ersetzt die Druckdatei erst,
// wenn er vollständig angekommen ist und inhaltlich passt (modellPruefen) — ein Abbruch hinterlässt weder Teildatei noch offenen
// Dateideskriptor. Abgelehnt werden: abgeschlossene/stornierte Bestellungen (409, die Datei ist ab dem Abschluss unveränderlich),
// mehr als MAX_STL (413), weniger als MIN_FREI freier Speicher (507), mehr als UPLOAD_IP_BYTES je IP und Stunde (429).
// ---------------------------------------------------------------------------
const MIN_FREI = 1024 ** 3;   // 1 GB muss frei bleiben (Bestellungen, Einstellungen, Mailserver auf derselben Platte)
const UPLOAD_ZEIT_MS = 15 * 60e3;   // ganze Anfrage (server.requestTimeout): 126 MB brauchen bei 1,2 Mbit/s Upload knapp 15 Minuten
const SPEICHER_KNAPP = 5 * 1024 ** 3;   // darunter räumt ein Upload vorher Druckdateien nie abgeschlossener Kassen auf (siehe unten)
const uploadMengen = new Map();   // IP → [{ t, n }] (Bytes je Upload, Fenster 1 Stunde; laufende Uploads zählen ab dem Start mit)
let speicherZuletzt = null;   // freie Bytes bei der letzten Messung (Upload, Start, stündlich) — Hinweis im Admin unter 2 GB
async function speicherFrei() {
  try { const st = await statfs(ORDERS); speicherZuletzt = st.bavail * st.bsize; } catch (err) { console.error('Freier Speicher nicht ermittelbar:', err?.message || err); return null; }
  return speicherZuletzt;
}
/** Bytes der IP in der letzten Stunde (mit eintrag: diesen Upload dazunehmen — sein n wächst beim Lesen mit) */
function uploadMenge(ip, eintrag = null) {
  const now = Date.now();
  const liste = (uploadMengen.get(ip) || []).filter((e) => now - e.t < STUNDE_MS);
  if (eintrag) liste.push(eintrag);
  uploadMengen.delete(ip);
  if (liste.length) uploadMengen.set(ip, liste);
  while (uploadMengen.size > BREMSE_MAX_JE_ART) uploadMengen.delete(uploadMengen.keys().next().value);   // eine IP = ein Schlüssel
  return liste.reduce((s, e) => s + e.n, 0);
}
/** Abgebrochener oder abgelehnter Upload: belegt nichts auf der Platte → zählt nicht */
function uploadFrei(ip, eintrag) {
  const liste = uploadMengen.get(ip) || [];
  if (liste.includes(eintrag)) liste.splice(liste.indexOf(eintrag), 1);
}
/**
 * Inhalt einer Druckdatei prüfen → null (in Ordnung) oder Fehlertext. STL binär: 80 Bytes Kopf + Dreieckszahl n + 50·n Bytes;
 * STL als Text: beginnt mit „solid“ und endet mit „endsolid“; 3MF: ZIP (Signatur am Anfang, Endsatz in den letzten 64 KB).
 */
async function modellPruefen(file, ext) {
  let fh;
  try { fh = await open(file, 'r'); } catch { return 'Datei fehlt'; }
  try {
    const { size } = await fh.stat();
    if (size < 84) return 'Datei leer oder zu klein';
    const lies = async (pos, len) => { const b = Buffer.alloc(len); await fh.read(b, 0, len, pos); return b; };
    const kopf = await lies(0, 84), ende = await lies(Math.max(0, size - 65_557), Math.min(size, 65_557));
    if (ext === '.3mf') {
      if (kopf.readUInt32LE(0) !== 0x04034b50) return 'keine 3MF-Datei';
      return ende.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0 ? null : '3MF-Datei unvollständig';
    }
    const n = kopf.readUInt32LE(80);
    if (n > 0 && 84 + 50 * n === size) return null;
    if (/^\s*solid\b/i.test(kopf.toString('latin1'))) return /endsolid[^\n]*\s*$/i.test(ende.subarray(-1024).toString('latin1')) ? null : 'STL-Datei unvollständig';
    return 'keine gültige STL-Datei';
  } catch (err) {
    return `Datei nicht lesbar (${err.code || err.message})`;
  } finally { await fh.close().catch(() => {}); }
}
let uploadSeq = 0;
// Upload und Abschluss nur mit Schlüssel (x-order-key) — sonst 404 wie bei einer unbekannten Bestellung (siehe orderZugriff)
async function handleStlUpload(req, res, id, idx, url) {
  let order = null;
  try { order = await readOrder(id); } catch { order = null; }
  const z = orderZugriff(req, url, order, kasseOffen);
  // Antwort vor dem Lesen des Körpers: Verbindung danach schließen, statt den Rest (bis 190 MB) anzunehmen
  const ablehnen = (code, body) => { res.setHeader('Connection', 'close'); return send(res, code, body); };
  if (z !== 'ok') return z === 'gesperrt' ? ablehnen(429, TOO_MANY) : ablehnen(404, { ok: false, error: 'Bestellung unbekannt' });
  if (order.completedAt || order.filesComplete || order.status === 'storniert') {
    return ablehnen(409, { ok: false, error: 'Die Bestellung ist abgeschlossen – ihre Druckdateien lassen sich nicht mehr ändern.' });
  }
  const i = parseInt(idx, 10);
  if (!(i >= 0 && i < order.lines.length)) return ablehnen(400, { ok: false, error: 'Ungültiger Index' });
  const laenge = Number(req.headers['content-length']);
  if (laenge > MAX_STL) return ablehnen(413, { ok: false, error: 'Die Druckdatei ist zu groß.' });
  // Bremse je IP: die angekündigte Größe zählt sofort (gleichzeitige Uploads sehen einander), ohne Content-Length wächst der Anteil
  // beim Lesen mit; ein abgebrochener oder abgelehnter Upload gibt seinen Anteil wieder frei
  const ip = clientIp(req);
  const anteil = { t: Date.now(), n: laenge || 0 };
  if (uploadMenge(ip, anteil) > UPLOAD_IP_BYTES) { uploadFrei(ip, anteil); return ablehnen(429, GEBREMST()); }
  let frei = await speicherFrei();
  if (frei !== null && frei - (laenge || 0) < SPEICHER_KNAPP) { await kassenAufraeumenKnapp(); frei = await speicherFrei(); }
  if (frei !== null && frei - (laenge || 0) < MIN_FREI) {
    uploadFrei(ip, anteil);
    console.error(`💾 Upload ${id}/${i} abgelehnt: weniger als 1 GB frei (${Math.round(frei / 1e6)} MB)`);
    return ablehnen(507, { ok: false, error: 'Der Speicher des Shops ist gerade voll – bitte versuch es später noch einmal oder schreib mir eine E-Mail.' });
  }
  const file = path.join(ORDERS, id, order.lines[i].stlFile);
  const tmp = `${file}.upload-${process.pid}-${(++uploadSeq).toString(36)}.tmp`;
  const out = createWriteStream(tmp, { flags: 'wx' });
  let size = 0, fertig = false;
  // Abbruch (Verbindung weg, zu groß, Schreibfehler): Temp-Datei schließen und löschen; Antwort nur, solange die Verbindung steht
  const abbrechen = (code, body) => {
    if (fertig) return;
    fertig = true;
    uploadFrei(ip, anteil);
    req.unpipe(out);
    out.once('close', () => rm(tmp, { force: true }).catch(() => {}));   // erst nach dem Schließen: kein Schreibvorgang legt sie neu an
    out.destroy();
    if (code) { ablehnen(code, body); req.resume(); }
  };
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_STL) return abbrechen(413, { ok: false, error: 'Die Druckdatei ist zu groß.' });
    if (size > anteil.n) { anteil.n = size; if (uploadMenge(ip) > UPLOAD_IP_BYTES) abbrechen(429, GEBREMST()); }
  });
  req.on('close', () => { if (!req.complete) abbrechen(); });
  req.on('error', () => abbrechen());
  out.on('error', (err) => abbrechen(err?.code === 'ENOSPC' ? 507 : 500, { ok: false, error: 'Die Druckdatei konnte nicht gespeichert werden – bitte versuch es noch einmal.' }));
  out.on('close', async () => {
    if (fertig) return;
    fertig = true;
    anteil.n = size;
    const fehler = await modellPruefen(tmp, path.extname(file).toLowerCase());
    if (fehler) {
      uploadFrei(ip, anteil);
      await rm(tmp, { force: true }).catch(() => {});
      return send(res, 400, { ok: false, error: `Druckdatei abgelehnt: ${fehler}.` });
    }
    // Stand nach dem Hochladen: inzwischen abgeschlossen oder storniert → die Datei bleibt, wie sie war
    let jetzt = null;
    try { jetzt = await readOrder(id); } catch { jetzt = null; }
    if (!jetzt || jetzt.completedAt || jetzt.filesComplete || jetzt.status === 'storniert') {
      uploadFrei(ip, anteil);
      await rm(tmp, { force: true }).catch(() => {});
      return send(res, 409, { ok: false, error: 'Die Bestellung ist abgeschlossen – ihre Druckdateien lassen sich nicht mehr ändern.' });
    }
    try { await rename(tmp, file); } catch (err) {
      uploadFrei(ip, anteil);
      await rm(tmp, { force: true }).catch(() => {});
      return send(res, 500, { ok: false, error: 'Die Druckdatei konnte nicht gespeichert werden – bitte versuch es noch einmal.' });
    }
    send(res, 200, { ok: true, bytes: size });
  });
  req.pipe(out);
}

// Idempotent: ein zweiter Aufruf (Retry, Doppelklick, Dritte) liefert nur noch die Rechnungsdaten —
// keine neue Rechnungsnummer, kein erneutes Schreiben, keine zweite Bestätigungsmail
async function handleComplete(req, res, id, url) {
  let order;
  const release = await lockOrder(id);
  try {
    try { order = await readOrder(id); } catch { order = null; }
    const z = orderZugriff(req, url, order, kasseOffen);
    if (z !== 'ok') return z === 'gesperrt' ? send(res, 429, TOO_MANY) : send(res, 404, { ok: false, error: 'Bestellung unbekannt' });
    if (order.completedAt) return send(res, 200, { ok: true, invoiceUrl: orderFileUrl(order, 'rechnung.html'), invoicePdfUrl: orderFileUrl(order, 'rechnung.pdf'), invoiceNo: order.invoiceNo });
    // Guthaben (Reservierung einer offenen Kasse gilt nur GUTHABEN_RESERVIERUNG_MS) bzw. Gutschein mit Höchstzahl (eigene parallele
    // Kassen zählen beim Anlegen nicht mit): inzwischen anderweitig eingelöst → nicht abschließen (keine Rechnung), als abgebrochen
    // stornieren. Geprüft hier (früh, ohne Upload-Prüfung) und noch einmal unmittelbar vor der Rechnungsnummer (siehe unten).
    const abbrechen = async (sperre) => {
      setOrderStatus(order, 'storniert', sperre.note, 'system');
      await writeOrder(order);
      return send(res, 409, { ok: false, code: sperre.code, error: sperre.error });
    };
    const sperre = einloesungGesperrt(order);
    if (sperre) return await abbrechen(sperre);
    if (order.status === 'storniert') return send(res, 409, { ok: false, error: 'Diese Bestellung wurde storniert – bitte starte die Kasse neu.' });
    // Rechnung nur, wenn jede Position eine vollständige, gültige Druckdatei hat (danach sind die Dateien unveränderlich)
    if (!order.invoiceNo) {
      const fehlen = [];
      for (const [i, l] of order.lines.entries()) if (!l.stlFile || await modellPruefen(path.join(ORDERS, id, l.stlFile), path.extname(l.stlFile).toLowerCase())) fehlen.push(i + 1);
      if (fehlen.length) {
        return send(res, 409, { ok: false, code: 'dateien', error: `Die Druckdatei für ${fehlen.length > 1 ? 'die Positionen' : 'Position'} ${fehlen.join(', ')} fehlt noch oder ist unvollständig – bitte versuch es noch einmal.` });
      }
      // Nach den Dateiprüfungen (await) noch einmal — ab hier ohne await bis zum Vormerken: zwei gleichzeitige Abschlüsse mit
      // demselben Einmal-Code (zwei Kassen derselben Kundin) sehen sich so gegenseitig, nur einer bekommt eine Rechnung
      const sperreJetzt = einloesungGesperrt(order);
      if (sperreJetzt) return await abbrechen(sperreJetzt);
      order.invoiceNo = nextBelegNr('invoicePrefix', 'nextInvoice', DEFAULT_SETTINGS.invoicePrefix);
      trackCouponUse(order);   // Einlösung fest vormerken (invoiceNo gesetzt), bevor rechnungFesthalten auf die Platte wartet
      try { await rechnungFesthalten(order); } catch (err) {
        // nicht gespeichert: Vormerkung auf den gespeicherten Stand zurücknehmen (Nummer gibt rechnungFesthalten selbst frei)
        try { trackCouponUse(await readOrder(id)); } catch { untrackCouponUse(id); }
        throw err;
      }
    } else if (!order.steuer) steuerDerRechnung(order);
    order.filesComplete = order.lines.every((l) => existsSync(path.join(ORDERS, id, l.stlFile)));
    // Eine ausgestellte Rechnung wird nie neu geschrieben (GoBD) — ältere Bestellungen ohne completedAt behalten ihre Datei
    const invoiceFile = path.join(ORDERS, id, 'rechnung.html');
    if (!existsSync(invoiceFile)) await writeFileAtomic(invoiceFile, invoiceHTML(order));
    order.completedAt = order.invoiceAt || new Date().toISOString();   // = Rechnungsdatum auf dem Beleg
    await writeOrder(order);
  } finally { release(); }
  console.log(`📦 Bestellung ${id} – ${order.lines.length} Position(en), ${money(order.total)}, ${order.payment} (${order.customer.name})`);
  // invoicePdfUrl: PDF-Fassung (entsteht beim ersten Abruf bzw. mit der Bestätigungsmail; scheitert sie → Weiterleitung auf die HTML-Fassung)
  send(res, 200, { ok: true, invoiceUrl: orderFileUrl(order, 'rechnung.html'), invoicePdfUrl: orderFileUrl(order, 'rechnung.pdf'), invoiceNo: order.invoiceNo });
  await runHook('orderCompleted', order);
}

// Admin-Seite: /admin liefert public/admin.html wie eine statische Datei (Login clientseitig, API mit x-admin-key)

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  schutzKopfzeilen(res);
  ANTWORTEN.set(req, res);
  // URL-Parsen/Dekodieren geschützt: kaputte Prozentkodierung oder ein ungültiger Host-Header dürfen den
  // Prozess nicht beenden (400 statt unbehandelter Ausnahme). Der Host wird nirgends ausgewertet → feste Basis.
  let url, p;
  try {
    url = new URL(req.url, 'http://localhost');
    p = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, { ok: false, error: 'Ungültige URL' });
  }
  // API-Antworten (Konto, Bestellungen, Admin) nie zwischenspeichern — Routen mit eigenem Cache-Control (Vorschaubilder) überschreiben es
  if (p.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

  try {
    // --- Wartungsmodus: ohne Freigabe nur die Wartungsseite
    if (await wartungTor(req, res, p, url)) return;
    // --- Admin-Passwort (Kopf x-admin-key) einmal je Anfrage prüfen; zu viele Fehlversuche → 429 auf Admin-Wegen
    if (await adminAnmeldung(req) === 'gebremst' && (p.startsWith('/api/admin/') || p.startsWith('/admin/'))) {
      res.setHeader('Retry-After', '900');
      return send(res, 429, { ok: false, error: 'Zu viele falsche Admin-Passwörter – bitte in 15 Minuten noch einmal versuchen.' });
    }

    // --- öffentliche API
    if (p === '/api/pricing') {
      const pr = settings.pricing;
      const laufende = aktiveAktionen();
      return send(res, 200, {
        currency: pr.currency,
        products: {
          eierbecher: { single: pr.eierbecher.single, untersetzer: pr.eierbecher.untersetzer, discounts: pr.eierbecher.discounts },
          vase: { single: pr.vase.single, discounts: pr.vase.discounts },
        },
        shipping: pr.shipping,
        gravur: pr.gravur,
        muster: pr.muster || {},
        farbschrift: pr.farbschrift || 0,
        volumen: pr.volumen,
        normalHeight: NORMAL_HEIGHT,
        // Produktschalter: der Shop blendet Eierbecher-Elemente aus und nimmt keine Eierbecher-Designs/-Warenkorbzeilen an, solange false
        produkte: { vase: true, eierbecher: produktAktiv('eierbecher') },
        paypal: { enabled: settings.paypal.enabled && !!settings.paypal.clientId, clientId: settings.paypal.clientId, sandbox: settings.paypal.sandbox },
        // laufende Aktionen (nach Prozent absteigend; leer = keine), aktion = primäre (Kompatibilität)
        // + Serverzeit für den Countdown im Shop (Client rechnet den Zeitversatz heraus)
        aktionen: laufende.map(publicAktion),
        aktion: publicAktion(laufende[0] || null),
        serverNow: new Date().toISOString(),
        // § 11 PAngV: Preis-Historie für die 30-Tage-Fenster der laufenden Aktionen (leer ohne Aktion) — pricing.js referenzpreis()
        // rechnet daraus den niedrigsten Preis der letzten 30 Tage vor Aktionsbeginn (Streichpreis) und die Prozentangabe
        preisHistorie: preisHistorieFuer(laufende),
        // Shop-Angaben (Lieferzeit/Liefergebiet) für Kasse, Produktseiten und Hinweise
        // fristBeginn: Satz je Zahlungsart wie in Bestätigung, Rechnung und AGB § 7 (lib/lieferfrist.js) — Hinweis nach dem Bestellen;
        // kleinunternehmer: Hinweis „keine USt. nach § 19 UStG“ am Preis (§ 6 Abs. 1 PAngV, pricing.js ustText)
        shop: { lieferzeit: settings.shop.lieferzeit, liefergebiet: settings.shop.liefergebiet, fristBeginn: { vorkasse: fristBeginnKurz('vorkasse'), paypal: fristBeginnKurz('paypal') }, kleinunternehmer: !!settings.company?.kleinunternehmer },
        // Hersteller = Anbieter (dieselben Angaben wie im Impressum) — Herstellerangabe beim Produktangebot (GPSR Art. 19)
        anbieter: (({ name, owner, street, zip, city, country, email }) => ({ name: name || BRAND, owner, street, zip, city, country, email }))(settings.company || {}),
      });
    }
    // --- Kundenkonten
    if (req.method === 'POST' && p === '/api/auth/register') {
      const { name: rohName, email, password } = await readJson(req, 16 * 1024);
      // Name 2–80 Zeichen ohne < >, E-Mail wie beim Versand (isEmail, ≤ 254) — sonst entstünde ein Konto, an das nie eine Mail geht
      const { name, error: nameFehler } = kontoName(rohName);
      if (nameFehler) return send(res, 400, { ok: false, error: nameFehler });
      const mail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!isEmail(mail)) return send(res, 400, { ok: false, error: 'Bitte gib eine gültige E-Mail-Adresse an.' });
      if (emailLokalFehler(mail)) return send(res, 400, { ok: false, error: emailLokalFehler(mail) });
      const pwFehler = pwRegel(password);
      if (pwFehler) return send(res, 400, { ok: false, error: pwFehler });
      // Bremsen vor der Kontoanlage (jedes neue Konto verschickt eine Mail an die angegebene Adresse): je IP 5 Versuche je Stunde
      // (zählt auch „existiert schon“ → Konten lassen sich nicht massenhaft abfragen), je Empfänger 3 Konten am Tag, 30 je Stunde insgesamt
      if (forgotLimited(`register-ip:${clientIp(req)}`, REG_IP_MAX, STUNDE_MS)) return send(res, 429, GEBREMST());
      if (users.some((u) => u.email === mail)) return send(res, 400, { ok: false, error: 'Für diese E-Mail existiert schon ein Konto – bitte anmelden' });
      if (rateLimitReached(`register-mail:${mail}`, REG_MAIL_MAX, TAG_MS) || rateLimitReached('register-alle', REG_ALLE_MAX, STUNDE_MS)) {
        console.warn(`⚠️  Registrierung gebremst (${rateLimitReached('register-alle', REG_ALLE_MAX, STUNDE_MS) ? `${REG_ALLE_MAX} je Stunde erreicht` : 'Empfänger-Grenze'})`);
        return send(res, 429, GEBREMST('später'));
      }
      forgotLimited(`register-mail:${mail}`, REG_MAIL_MAX, TAG_MS);
      forgotLimited('register-alle', REG_ALLE_MAX, STUNDE_MS);
      const salt = crypto.randomBytes(16).toString('hex');
      const user = { id: crypto.randomUUID(), name, email: mail, salt, hash: await hashPw(password, salt), address: null, createdAt: new Date().toISOString(), emailVerifiedAt: null };
      if (users.some((u) => u.email === mail)) return send(res, 400, { ok: false, error: 'Für diese E-Mail existiert schon ein Konto – bitte anmelden' });   // parallel angelegt
      const verifyToken = newVerifyToken(user);   // Bestätigungslink kommt mit der Willkommensmail
      users.push(user);
      await saveUsers();
      send(res, 200, { ok: true, token: createSession(user.id), user: publicUser(user) });
      return runHook('userRegistered', { id: user.id, name: kontoMailName(user.name), email: user.email, createdAt: user.createdAt, verifyLink: verifyLinkFor(verifyToken) });
    }
    // Anmeldung: Fehlversuche je IP + Konto (10) und je IP (30) in 15 Minuten → 429; das Konto selbst wird nie gesperrt. Jeder Versuch
    // belegt seinen Platz vor der Prüfung (anmeldePlatz) — auch parallel abgeschickte zählen; ein richtiges Passwort gibt ihn frei
    if (req.method === 'POST' && p === '/api/auth/login') {
      const { email, password } = await readJson(req, 16 * 1024);
      const mail = String(email || '').trim().toLowerCase().slice(0, 254);
      const platz = anmeldePlatz(clientIp(req), mail);
      if (!platz) return send(res, 429, LOGIN_GEBREMST);
      const u = users.find((x) => x.email === mail);
      let stimmt;
      try { stimmt = await passwortStimmt(u, password); } catch (err) {
        platz.frei();
        if (err?.code === 'ueberlast') return send(res, 503, UEBERLAST);
        throw err;
      }
      if (!stimmt) return send(res, 401, { ok: false, error: 'E-Mail oder Passwort falsch' });
      platz.frei();
      return send(res, 200, { ok: true, token: createSession(u.id), user: publicUser(u) });
    }
    if (req.method === 'POST' && p === '/api/auth/logout') {
      delete sessions[req.headers['x-auth'] || ''];
      await saveSessions();
      return send(res, 200, { ok: true });
    }
    // Passwort vergessen: Link per Mail (Antwort verrät nicht, ob ein Konto existiert)
    if (req.method === 'POST' && p === '/api/auth/forgot') {
      let body; try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch { body = {}; }
      const mail = String(body?.email || '').trim().toLowerCase();
      if (mail.length > 254 || !isEmail(mail)) return send(res, 400, { ok: false, error: 'Bitte eine gültige E-Mail-Adresse angeben' });   // 254 = RFC-5321-Maximum
      // IP-Limit zuerst und kurzschließend: eine gesperrte IP legt keine neuen Mail-Schlüssel mehr an. Gebremst: trotzdem 200, aber
      // keine neue Mail und kein neuer Link — die zuletzt verschickten Links bleiben gültig (Dritte können den Inhaber nicht aussperren)
      const gebremst = forgotLimited(`ip:${clientIp(req)}`, FORGOT_IP_MAX) || forgotLimited(`mail:${mail}`);
      send(res, 200, { ok: true });
      const u = users.find((x) => x.email === mail);
      if (!u || gebremst) return;
      try {
        const token = crypto.randomBytes(24).toString('base64url');
        const frueher = [].concat(u.reset || []).filter((r) => r && Number(r.exp) > Date.now()).slice(-(RESET_LINKS - 1));
        u.reset = [...frueher, { hash: sha256(token), exp: Date.now() + RESET_TTL }];
        await saveUsers();
        const m = passwordReset({ user: { name: kontoMailName(u.name), email: u.email }, link: `${baseUrlFor(settings)}/?reset=${token}`, settings });
        await mailer.queue({ to: { name: kontoMailName(u.name), email: u.email }, subject: m.subject, text: m.text, html: m.html, kind: 'passwort-reset', ref: u.id });
      } catch (err) { console.error('Passwort-Reset-Mail fehlgeschlagen:', err?.message || err); }
      return;
    }
    // Neues Passwort mit Token aus der Mail; meldet alle bisherigen Sitzungen ab und startet eine neue
    if (req.method === 'POST' && p === '/api/auth/reset') {
      let body; try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch { body = {}; }
      const u = userByResetToken(body?.token);
      if (!u) return send(res, 400, { ok: false, error: 'Link ungültig oder abgelaufen' });
      const pwFehler = pwRegel(body?.password);
      if (pwFehler) return send(res, 400, { ok: false, error: pwFehler });
      const salt = crypto.randomBytes(16).toString('hex'), hash = await hashPw(body.password, salt);
      if (userByResetToken(body?.token) !== u) return send(res, 400, { ok: false, error: 'Link ungültig oder abgelaufen' });   // inzwischen benutzt
      u.salt = salt;
      u.hash = hash;
      delete u.reset;   // alle Links aus „Passwort vergessen“ sind damit verbraucht
      // Der Reset-Link kam per Mail an diese Adresse → sie gehört der Person, die jetzt das Passwort setzt
      if (!u.emailVerifiedAt) u.emailVerifiedAt = new Date().toISOString();
      delete u.verify;
      sitzungenBeenden(u.id);
      await saveUsers();
      return send(res, 200, { ok: true, token: createSession(u.id), user: publicUser(u) });
    }
    // E-Mail bestätigen: Token aus dem Link + Anmeldung in genau diesem Konto (siehe newVerifyToken)
    if (req.method === 'POST' && p === '/api/auth/verify') {
      let body; try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch { body = {}; }
      const me = userFromReq(req);
      if (!me) return send(res, 401, { ok: false, error: 'Bitte melde dich an – dann bestätige ich deine E-Mail-Adresse.' });
      if (me.emailVerifiedAt) return send(res, 200, { ok: true, user: publicUser(me), schon: true });
      const u = userByToken(body?.token, 'verify');
      if (!u || u.id !== me.id) return send(res, 400, { ok: false, error: 'Der Bestätigungslink ist ungültig, abgelaufen oder gehört zu einem anderen Konto – im Konto kannst du einen neuen anfordern.' });
      u.emailVerifiedAt = new Date().toISOString();
      delete u.verify;
      await saveUsers();
      console.log(`✉️  E-Mail-Adresse bestätigt (Konto ${u.id})`);
      return send(res, 200, { ok: true, user: publicUser(u) });
    }
    // Bestätigungslink erneut senden (angemeldet; je IP und Adresse begrenzt wie „Passwort vergessen“)
    if (req.method === 'POST' && p === '/api/auth/verify-resend') {
      const u = userFromReq(req);
      if (!u) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      if (u.emailVerifiedAt) return send(res, 200, { ok: true, schon: true });
      if (forgotLimited(`verify-ip:${clientIp(req)}`, FORGOT_IP_MAX) || forgotLimited(`verify-mail:${u.email}`)) {
        return send(res, 429, { ok: false, error: 'Zu viele Anfragen – bitte in 15 Minuten noch einmal versuchen.' });
      }
      const token = newVerifyToken(u);
      await saveUsers();
      send(res, 200, { ok: true });
      try {
        const m = emailBestaetigung({ user: { name: kontoMailName(u.name), email: u.email }, link: verifyLinkFor(token), settings, baseUrl: baseUrlFor(settings) });
        await mailer.queue({ to: { name: kontoMailName(u.name), email: u.email }, subject: m.subject, text: m.text, html: m.html, kind: 'email-bestaetigung', ref: u.id });
      } catch (err) { console.error('Bestätigungsmail fehlgeschlagen:', err?.message || err); }
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/api/auth/me') {
      const u = userFromReq(req);
      if (!u) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      // Zuordnung: Bestellungen dieses Kontos (userId) immer; Bestellungen mit derselben E-Mail-Adresse (Gast, Altbestand)
      // erst, wenn die Adresse bestätigt ist — sonst sähe, wer sich mit einer fremden Adresse registriert, deren Bestellungen
      const verified = !!u.emailVerifiedAt;
      const orders = (await listOrders())
        .filter((o) => o.userId === u.id || (verified && (o.customer?.email || '').toLowerCase() === u.email))
        .map((o) => {
          // Beleg-Links und Guthaben-Code nur für Bestellungen dieses Kontos (und Altbestand ohne Schlüssel — der erscheint nur
          // bei bestätigter Adresse): über die Adresse zugeordnete Gastbestellungen zeigen Belegnummern, Link und Code stehen in
          // meinen Mails an die Kundschaft (Bestellbestätigung, Reklamation)
          const links = o.userId === u.id || !o.accessKey;
          const r = o.reklamation;
          return {
            orderId: o.orderId, createdAt: o.createdAt, status: o.status || 'neu',
            total: o.total, invoiceNo: o.invoiceNo, trackingNo: o.trackingNo || '', carrier: o.carrier || '',
            invoiceUrl: o.invoiceNo && links ? orderFileUrl(o, 'rechnung.html') : null,
            invoicePdfUrl: o.invoiceNo && links ? orderFileUrl(o, 'rechnung.pdf') : null,
            // Stornobeleg (Rechnung aufgehoben) — Nummer immer, Link wie bei der Rechnung
            stornoNo: o.storno?.nr || '', stornoUrl: o.storno?.nr && links ? orderFileUrl(o, 'storno.html') : null,
            stornoPdfUrl: o.storno?.nr && links ? orderFileUrl(o, 'storno.pdf') : null,
            paidAt: o.paidAt || null, shippedAt: o.shippedAt || null,
            pieces: (o.lines || []).reduce((s, l) => s + (l.qty || 0), 0),
            reklamation: r ? {   // ohne IBAN/Grund/Notiz
              ...publicRekla(r), gutscheinCode: links ? (r.gutscheinCode || '') : '', gutscheinPerMail: !links && !!r.gutscheinCode,
              gutschriftUrl: r.gutschriftNo && links ? orderFileUrl(o, 'gutschrift.html') : null,
              gutschriftPdfUrl: r.gutschriftNo && links ? orderFileUrl(o, 'gutschrift.pdf') : null,
            } : null,
            // Zeitleiste fürs Konto — nur echte Statuswechsel mit Zeitpunkt; interne Notizen (Admin/Automatik/Mail) bleiben hier
            history: (o.history || []).filter((h) => h && h.by !== 'mail')
              .filter((h, i, a) => i === 0 || h.status !== a[i - 1].status)
              .slice(-30).map((h) => ({ at: h.at, status: h.status })),
          };
        });
      return send(res, 200, { ok: true, user: publicUser(u), orders });
    }
    if (req.method === 'POST' && p === '/api/auth/address') {
      const u = userFromReq(req);
      if (!u) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const { address, error } = kontoAdresse(await readJson(req, 16 * 1024));   // nur Text: Straße ≤ 120, PLZ ≤ 10, Ort ≤ 80
      if (error) return send(res, 400, { ok: false, error });
      u.address = address;
      await saveUsers();
      return send(res, 200, { ok: true });
    }
    // Konto (angemeldet): Passwort ändern (altes Passwort; beendet alle anderen Anmeldungen, Mail „Passwort geändert“),
    // auf allen Geräten abmelden, Konto löschen (Passwort zur Bestätigung). Falsche Passwörter zählen wie bei der Anmeldung.
    if (req.method === 'POST' && (p === '/api/auth/password' || p === '/api/auth/delete' || p === '/api/auth/logout-all')) {
      const u = userFromReq(req);
      if (!u) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const token = String(req.headers['x-auth'] || '');
      if (p === '/api/auth/logout-all') {
        const n = sitzungenBeenden(u.id);
        await saveSessions();
        return send(res, 200, { ok: true, beendet: n });
      }
      const body = await readJson(req, 16 * 1024);
      // Passwortwechsel je Konto höchstens PW_WECHSEL_MAX je Stunde (jeder verschickt eine Mail, siehe unten) — gezählt werden nur
      // gelungene Wechsel (unten); Tippfehler beim alten Passwort bremst anmeldePlatz, ein zu kurzes neues kostet nichts
      if (p === '/api/auth/password') {
        if (rateLimitReached(`pw-wechsel:${u.id}`, PW_WECHSEL_MAX, STUNDE_MS)) {
          return send(res, 429, { ok: false, error: 'Du hast dein Passwort gerade mehrmals geändert – bitte versuch es in einer Stunde noch einmal.' });
        }
        const pwFehler = pwRegel(body.neuesPasswort);
        if (pwFehler) return send(res, 400, { ok: false, error: pwFehler });
      }
      const platz = anmeldePlatz(clientIp(req), u.email);
      if (!platz) return send(res, 429, LOGIN_GEBREMST);
      const altes = p === '/api/auth/password' ? body?.altesPasswort : body?.passwort;
      let stimmt;
      try { stimmt = await passwortStimmt(u, altes); } catch (err) {
        platz.frei();
        if (err?.code === 'ueberlast') return send(res, 503, UEBERLAST);
        throw err;
      }
      if (!stimmt) return send(res, 400, { ok: false, error: p === '/api/auth/password' ? 'Das bisherige Passwort stimmt nicht.' : 'Das Passwort stimmt nicht.' });
      platz.frei();
      if (p === '/api/auth/delete') {
        await kontoLoeschen(u, 'auf Wunsch im Konto');
        return send(res, 200, { ok: true });
      }
      if (!users.includes(u)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });   // inzwischen gelöscht
      if (forgotLimited(`pw-wechsel:${u.id}`, PW_WECHSEL_MAX, STUNDE_MS)) {   // gleichzeitig abgeschickte Wechsel: Grenze gilt trotzdem
        return send(res, 429, { ok: false, error: 'Du hast dein Passwort gerade mehrmals geändert – bitte versuch es in einer Stunde noch einmal.' });
      }
      u.salt = crypto.randomBytes(16).toString('hex');
      u.hash = await hashPw(body.neuesPasswort, u.salt);
      delete u.reset;
      const beendet = sitzungenBeenden(u.id, token);
      await saveUsers();
      await saveSessions();
      send(res, 200, { ok: true, beendet });
      // Hinweis-Mail an die Kontoadresse: je Adresse und Tag höchstens 3, solange sie nicht bestätigt ist nur 1 — wer ein Konto mit
      // fremder Adresse anlegt, kann darüber keine Mail-Flut an Dritte auslösen
      if (forgotLimited(`pw-mail:${u.email}`, u.emailVerifiedAt ? 3 : 1, TAG_MS)) return console.log(`🔐 Passwort von Konto ${u.id} geändert – Hinweis-Mail heute schon verschickt, keine weitere`);
      try {
        const name = kontoMailName(u.name);
        const m = passwortGeaendert({ user: { name, email: u.email }, settings, baseUrl: baseUrlFor(settings) });
        await mailer.queue({ to: { name, email: u.email }, subject: m.subject, text: m.text, html: m.html, kind: 'passwort-geaendert', ref: u.id });
      } catch (err) { console.error('Mail „Passwort geändert“ fehlgeschlagen:', err?.message || err); }
      return;
    }

    // --- Widerruf (elektronische Widerrufsfunktion): speichern, Bestellung zuordnen, bestätigen — Antwort immer gleich
    if (req.method === 'POST' && p === '/api/widerruf') {
      let body; try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { ok: false, error: 'Ungültige Anfrage' });
      const name = oneLine(body.name, 500);
      const email = oneLine(body.email, 500).toLowerCase();
      const orderId = clipText(body.orderId, 40).toUpperCase().replace(/\s+/g, '');
      const nachricht = String(body.nachricht ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, ' ').trim();
      if (name.length < 2 || name.length > 120) return send(res, 400, { ok: false, error: 'Bitte gib deinen Namen an (2 bis 120 Zeichen).' });
      if (email.length > 254 || !isEmail(email)) return send(res, 400, { ok: false, error: 'Bitte gib eine gültige E-Mail-Adresse an – dorthin schicke ich die Eingangsbestätigung.' });
      if (emailLokalFehler(email)) return send(res, 400, { ok: false, error: emailLokalFehler(email) });
      if (orderId && !ORDER_ID_RE.test(orderId)) return send(res, 400, { ok: false, error: 'Die Bestellnummer hat nicht das richtige Format (z. B. FS-260927-A1B2C3). Du kannst das Feld auch leer lassen.' });
      if (nachricht.length > 2000) return send(res, 400, { ok: false, error: 'Die Nachricht ist zu lang (höchstens 2000 Zeichen).' });
      if (forgotLimited(`widerruf-ip:${clientIp(req)}`, WIDERRUF_IP_MAX)) {
        const mail = String(settings.company?.email || '').trim();
        return send(res, 429, { ok: false, error: `Zu viele Anfragen – bitte in 15 Minuten noch einmal versuchen${mail ? ` oder schreib mir direkt an ${mail}` : ''}.` });
      }
      // Zuordnung: Bestellung existiert UND die E-Mail stimmt (ohne Groß/Klein) — sonst wird nur die Erklärung gespeichert
      let order = null;
      if (orderId) { try { order = await readOrder(orderId); } catch { order = null; } }
      const orderMatched = !!order && String(order.customer?.email || '').trim().toLowerCase() === email;
      // Eingangsbestätigung je Empfänger höchstens 3 am Tag und insgesamt 30 je Stunde — darüber wird die Erklärung trotzdem gespeichert
      // und dem Shop gemeldet (ein Widerruf geht nie verloren), nur die Mail an die angegebene Adresse entfällt (bestaetigungGebremst).
      // Zugeordnete Widerrufe (Bestellnummer UND Adresse passen) zählen dort nicht mit und werden immer bestätigt — Spam ohne echte
      // Bestellung kann ihnen die Bestätigung nicht nehmen; nur je Bestellung höchstens WIDERRUF_BESTELLUNG_MAX am Tag (Wiederholungen)
      const gebremst = orderMatched
        ? forgotLimited(`widerruf-bestellung:${orderId}`, WIDERRUF_BESTELLUNG_MAX, TAG_MS)
        : rateLimitReached(`widerruf-mail:${email}`, WIDERRUF_MAIL_MAX, TAG_MS) || rateLimitReached('widerruf-alle', WIDERRUF_ALLE_MAX, STUNDE_MS);
      if (!gebremst && !orderMatched) { forgotLimited(`widerruf-mail:${email}`, WIDERRUF_MAIL_MAX, TAG_MS); forgotLimited('widerruf-alle', WIDERRUF_ALLE_MAX, STUNDE_MS); }
      const entry = await withWiderrufe((list) => {
        const w = { ref: newWiderrufRef(list), at: new Date().toISOString(), orderId: orderId || '', name, email, nachricht, orderMatched, status: 'offen', notiz: '', ...(gebremst ? { bestaetigungGebremst: true } : {}) };
        list.push(w);
        return { changed: true, result: w };
      });
      if (orderMatched) {
        const release = await lockOrder(orderId);
        try {
          const o = await readOrder(orderId);
          o.widerrufe.push({ ref: entry.ref, at: entry.at });
          addHistory(o, o.status, `Widerruf ${entry.ref} über die Widerrufsfunktion eingegangen`, 'kunde');
          await writeOrder(o);
        } catch (err) { console.error(`Widerruf ${entry.ref}: Vermerk in ${orderId} fehlgeschlagen:`, err?.message || err); }
        finally { release(); }
      }
      console.log(`↩️  Widerruf ${entry.ref}${orderId ? ` zu ${orderId}` : ''} (${orderMatched ? 'zugeordnet' : 'nicht zugeordnet'})${gebremst ? ' – Eingangsbestätigung gebremst, nur Meldung an den Shop' : ''}`);
      send(res, 200, { ok: true, ref: entry.ref, at: entry.at });
      return runHook('widerruf', entry);
    }

    // --- Galerie (Produktfotos, gepflegt über den Admin)
    if (p === '/api/gallery') {
      const dir = path.join(PUBLIC, 'img', 'gallery');
      if (!existsSync(dir)) return send(res, 200, []);
      const files = (await readdir(dir)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
      return send(res, 200, files.map((f) => ({
        file: `/img/gallery/${f}`,
        cat: (f.match(/^(eierbecher|vase|galerie)-/) || [, 'galerie'])[1],
      })));
    }
    const mImg = p.match(/^\/api\/admin\/gallery\/([a-zA-Z0-9._-]+)$/);
    if (req.method === 'PUT' && p === '/api/admin/gallery') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const cat = ['eierbecher', 'vase', 'galerie'].includes(url.searchParams.get('cat')) ? url.searchParams.get('cat') : 'galerie';
      const rawName = (url.searchParams.get('name') || 'foto.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!/\.(jpe?g|png|webp)$/i.test(rawName)) return send(res, 400, { ok: false, error: 'Nur JPG/PNG/WebP' });
      const body = await readBody(req, 10 * 1024 * 1024);
      if (body.length < 100) return send(res, 400, { ok: false, error: 'Leere Datei' });
      const dir = path.join(PUBLIC, 'img', 'gallery');
      await mkdir(dir, { recursive: true });
      const fname = `${cat}-${Date.now().toString(36)}-${rawName}`;
      await writeFile(path.join(dir, fname), body);
      return send(res, 200, { ok: true, file: `/img/gallery/${fname}` });
    }
    if (req.method === 'DELETE' && mImg) {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const file = path.join(PUBLIC, 'img', 'gallery', mImg[1]);
      if (existsSync(file)) await rm(file);
      return send(res, 200, { ok: true });
    }

    // --- Design-Codes: speichern (POST) & laden (GET /api/design/CODE)
    if (req.method === 'POST' && p === '/api/design') {
      const cfg = (await readJson(req, 64 * 1024)).config;
      if (!cfg || !['vase', 'eierbecher'].includes(cfg.product)) return send(res, 400, { ok: false, error: 'Ungültiges Design' });
      let dc;
      try { dc = designCode(cfg); } catch { return send(res, 400, { ok: false, error: 'Ungültiges Design' }); }   // z. B. customPoints [null]
      const { code, canon, isNew } = dc;
      if (isNew) {
        // Neue Codes nur mit Werten, die der Konfigurator erzeugen kann (lib/eingaben.js) und für bestellbare Produkte —
        // bestehende Codes bleiben unverändert gültig (gleiches Design = gleicher Code)
        const k = pruefeKonfig(cfg, { farbeBekannt: (id) => (settings.colors || []).some((c) => c?.id === id) });
        if (k) return send(res, 400, { ok: false, error: `Ungültiges Design (${KONFIG_LABEL[k] || k})` });
        if (!produktAktiv(cfg.product)) return send(res, 400, { ok: false, error: EIERBECHER_GESPERRT });
        // nur neue Codes zählen (je IP und insgesamt je Stunde) — ein schon bekanntes Design kostet keinen Speicher
        if (forgotLimited(`design:${clientIp(req)}`, DESIGN_IP_MAX, STUNDE_MS) || forgotLimited('design-alle', DESIGN_ALLE_MAX, STUNDE_MS)) return send(res, 429, GEBREMST());
        designs[code] = { config: canon, createdAt: Date.now(), loads: 0 };
        await saveDesigns();
      }
      return send(res, 200, { ok: true, code });
    }
    const mDesign = p.match(/^\/api\/design\/([A-Za-z0-9-]{4,40})$/);
    if (req.method === 'GET' && mDesign) {
      const code = normalizeCode(mDesign[1]);
      const d = designs[code];
      if (!d) return send(res, 404, { ok: false, error: 'Diesen Design-Code gibt es nicht – bitte prüfen (z. B. B statt 8).' });
      d.loads = (d.loads || 0) + 1; d.lastLoad = Date.now();
      designZaehlerOffen = true;   // gespeichert wird gebündelt (DESIGN_ZAEHLER_MS)
      return send(res, 200, { ok: true, code, config: d.config });
    }

    // --- Vorschaubild eines Designs (PUT: data-URL JPEG vom Client, GET: Bild)
    const mThumb = p.match(/^\/api\/design\/([A-Za-z0-9-]{4,40})\/thumb$/);
    if (mThumb) {
      const code = normalizeCode(mThumb[1]);
      const file = path.join(THUMBS, `${code}.jpg`);
      if (req.method === 'PUT') {
        if (!designs[code]) return send(res, 404, { ok: false, error: 'Design unbekannt' });
        if (forgotLimited(`thumb:${clientIp(req)}`, THUMB_IP_MAX, STUNDE_MS)) return send(res, 429, GEBREMST());
        const raw = (await readBody(req, 120 * 1024)).toString('utf8');
        const m = raw.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
        const jpeg = m ? Buffer.from(m[1], 'base64') : null;
        if (!jpeg || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) return send(res, 400, { ok: false, error: 'Nur JPEG (data-URL)' });
        // Nur das erste Bild gilt: es entsteht aus derselben Konfiguration wie jedes spätere — so kann niemand das Vorschaubild
        // eines fremden Codes (geteilte Listen) austauschen. Erst vollständig in eine Temp-Datei schreiben, dann per link()
        // anlegen: das schlägt fehl, wenn es die Datei schon gibt (wie 'wx'), und niemand sieht ein halbes Bild (wie writeFileAtomic).
        await mkdir(THUMBS, { recursive: true });
        const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}.tmp`;
        try {
          await writeFile(tmp, jpeg);
          await link(tmp, file);
        } catch (err) {
          if (err?.code === 'EEXIST') return send(res, 200, { ok: true, vorhanden: true });
          throw err;
        } finally { await rm(tmp, { force: true }).catch(() => {}); }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET') {
        if (!existsSync(file)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
        return res.end(await readFile(file));
      }
      // Admin (Produktfotos & Galerie → Vorschaubild eines Design-Codes): verunglücktes oder vorab fremd belegtes Bild entfernen —
      // sobald der Code im Shop geöffnet (?d=, Code eingeben, Listeneintrag — app.js applyDesign) oder gespeichert wird, lädt der
      // Browser ein neues hoch (nur für den leeren Platz)
      if (req.method === 'DELETE') {
        if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
        if (!designs[code]) return send(res, 404, { ok: false, error: 'Diesen Design-Code gibt es nicht' });
        const entfernt = existsSync(file);
        await rm(file, { force: true });
        return send(res, 200, { ok: true, entfernt });
      }
    }

    // --- Design-Listen
    if (req.method === 'POST' && p === '/api/list') {
      if (forgotLimited(`liste:${clientIp(req)}`, LISTE_IP_MAX, STUNDE_MS)) return send(res, 429, GEBREMST());
      const b = await readJson(req, 64 * 1024);
      const name = (typeof b.name === 'string' ? oneLine(b.name, 60) : '') || 'Meine Liste';
      const code = newListCode();
      const token = crypto.randomBytes(16).toString('hex');
      const l = {
        code, token, name, occasion: LIST_OCCASIONS.includes(b.occasion) ? b.occasion : 'sonstiges',
        note: typeof b.note === 'string' ? clipText(b.note, 300) : '', items: cleanListItems(b.items),
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      lists[code] = l;
      await saveLists();
      return send(res, 200, { ok: true, code, token, list: publicList(l) });
    }
    const mList = p.match(/^\/api\/list\/([A-Za-z0-9-]{4,20})$/);
    if (mList) {
      const code = normalizeCode(mList[1]);
      const l = lists[code];
      if (!l) return send(res, 404, { ok: false, error: 'Diese Liste gibt es nicht – bitte den Code prüfen.' });
      if (req.method === 'GET') return send(res, 200, { ok: true, list: publicList(l) });
      if (forgotLimited(`liste-aendern:${clientIp(req)}`, LISTE_AENDERN_IP_MAX, STUNDE_MS)) return send(res, 429, GEBREMST());
      const b = await readJson(req, 64 * 1024);
      if (!b.token || b.token !== l.token) return send(res, 403, { ok: false, error: 'Nur der Besitzer kann diese Liste ändern.' });
      if (req.method === 'DELETE') { delete lists[code]; await saveLists(); return send(res, 200, { ok: true }); }
      if (req.method === 'PUT') {
        if (b.name !== undefined) l.name = oneLine(typeof b.name === 'string' ? b.name : '', 60) || l.name;
        if (b.occasion !== undefined && LIST_OCCASIONS.includes(b.occasion)) l.occasion = b.occasion;
        if (b.note !== undefined) l.note = typeof b.note === 'string' ? clipText(b.note, 300) : '';
        if (b.items !== undefined) l.items = cleanListItems(b.items);
        l.updatedAt = Date.now();
        await saveLists();
        return send(res, 200, { ok: true, list: publicList(l) });
      }
    }

    if (p === '/api/colors') {
      return send(res, 200, settings.colors.filter((c) => c.active).map(({ id, name, hex, finish, aufpreis }) => ({ id, name, hex, finish: finish || 'matt', aufpreis: euro(aufpreis) })));
    }
    if (req.method === 'POST' && p === '/api/quote') {
      const { items, couponCode, email: rohEmail } = await readJson(req);
      // optional die E-Mail aus der Kasse: dann zählen beim Gutschein mit Höchstzahl auch offene Kassen anderer Kundinnen (wie /api/checkout)
      const email = typeof rohEmail === 'string' && isEmail(rohEmail) ? rohEmail.trim().toLowerCase() : null;
      if (Array.isArray(items) && items.length > MAX_POSITIONEN) return send(res, 400, { ok: false, error: `Höchstens ${MAX_POSITIONEN} verschiedene Designs pro Bestellung – bitte teil deine Bestellung auf.` });
      const sperre = (Array.isArray(items) && positionenFehler(items)) || produktSperre(items) || farbSperre(items);
      if (sperre) return send(res, 400, { ok: false, error: sperre });
      const t = computeTotals(Array.isArray(items) ? items : [], couponCode, { email });
      return send(res, 200, {
        ok: true,
        lines: t.lines.map((l) => ({ qty: l.qty, unit: l.unit, off: l.off, line: l.line, parts: l.parts, color: l.color, uvp: l.uvp, aktionProzent: l.aktionProzent, aktionBetrag: l.aktionBetrag, aktionName: l.aktionName, aktionId: l.aktionId })),
        subtotal: t.subtotal, coupon: t.coupon, couponValid: couponCode ? !!t.coupon : null,
        couponError: t.couponError,   // Grund, wenn ein bekannter Code nicht gilt (Aktion, Mindestbestellwert, aufgebraucht)
        aktionen: t.aktionen,         // [{ id, name, prozent, ersparnis, produkte, muster }] je Aktion mit betroffener Zeile (Ersparnis absteigend)
        aktion: t.aktion,             // aktionen[0] | null
        shipping: t.shipping, total: t.total,
      });
    }
    if (req.method === 'POST' && p === '/api/checkout') return await handleCheckout(req, res);
    const mUp = p.match(/^\/api\/order\/([A-Z0-9-]+)\/stl\/(\d+)$/);
    if (req.method === 'PUT' && mUp) return await handleStlUpload(req, res, mUp[1], mUp[2], url);
    const mDone = p.match(/^\/api\/order\/([A-Z0-9-]+)\/complete$/);
    if (req.method === 'POST' && mDone) return await handleComplete(req, res, mDone[1], url);

    // --- PayPal
    if (req.method === 'POST' && p === '/api/paypal/create') {
      if (!paypalEnabled()) return send(res, 400, { ok: false, error: 'PayPal nicht aktiviert' });
      let data; try { data = JSON.parse((await readBody(req)).toString('utf8')); } catch { data = null; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { ok: false, error: 'Ungültige Anfrage' });
      // Vor der Zahlung genau die Prüfungen des Checkouts (Adresse, 1–20 Positionen, Sperren, Vereinbarung, Gutschein, angezeigter
      // Betrag) — sonst wäre bezahlt, die Bestellung aber abgelehnt
      const k = pruefeKasse(data);
      if (k.error) return send(res, k.status, { ok: false, error: k.error, ...(k.code ? { code: k.code, total: k.total } : {}) });
      if (forgotLimited(`kasse:${clientIp(req)}`, KASSE_IP_MAX, STUNDE_MS)) return send(res, 429, GEBREMST());   // wie /api/checkout
      const t = k.totals;
      // 0 € (Gutschein/Guthaben deckt alles): PayPal nimmt keine Zahlung über 0,00 € an — die Kasse bestellt dann ohne Zahlung
      if (!(t.total > 0)) return send(res, 400, { ok: false, error: 'Es ist nichts zu zahlen – bitte bestell über „Zahlungspflichtig bestellen“ ohne PayPal.' });
      const token = await paypalToken();
      const r = await fetch(`${paypalBase()}/v2/checkout/orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{ amount: { currency_code: settings.pricing.currency, value: t.total.toFixed(2) }, description: 'formsam – individuell gestaltete Vasen, 3D-gedruckt' }],
        }),
      });
      const j = await r.json();
      if (!r.ok || !j?.id) return send(res, 500, { ok: false, error: j?.message || 'PayPal-Fehler' });
      // Preisgarantie ab hier (siehe paypalPending) + Guthaben für die Dauer der Zahlung reservieren (wie eine offene Kasse)
      paypalPendingAufraeumen();
      const at = new Date().toISOString();
      paypalPending.set(String(j.id), { hash: kasseHash(k.items, data.couponCode), totals: t, beschaffenheitAt: at, at: Date.now() });
      if (t.coupon?.guthaben || couponByCode(t.coupon?.code)?.maxEinloesungen) trackCouponUse({ orderId: `paypal:${j.id}`, coupon: t.coupon, status: 'neu', createdAt: at, customer: k.customer });
      return send(res, 200, { ok: true, id: j.id });
    }
    const mCap = p.match(/^\/api\/paypal\/capture\/([A-Z0-9]+)$/i);
    if (req.method === 'POST' && mCap) {
      const token = await paypalToken();
      const r = await fetch(`${paypalBase()}/v2/checkout/orders/${mCap[1]}/capture`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const j = await r.json();
      const ok = r.ok && j.status === 'COMPLETED';
      // Eingelöste Zahlung merken — der Checkout prüft dagegen (Betrag, Währung, einmalige Verwendung)
      if (ok && !paypalCaptures[mCap[1]]) {
        paypalCaptures[mCap[1]] = { ...paypalAmountOf(j), capturedAt: new Date().toISOString(), usedBy: null };
        await saveCaptures();
      }
      return send(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, error: 'Zahlung nicht abgeschlossen' });
    }

    // --- Admin-API
    const orderIdOk = (id) => typeof id === 'string' && /^[A-Z0-9-]+$/.test(id);
    if (p === '/api/admin/data') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const orders = await listOrders();
      return send(res, 200, {
        ok: true, settings: adminSettingsView(), orders,
        statuses: STATUSES, statusLabels: STATUS_LABELS, carriers: CARRIER_LABELS, normalHeight: NORMAL_HEIGHT,
        mailStatuses: Object.keys(STATUS_MAIL),   // Status mit Mail-Vorlage (Admin blendet Status-Mail-Knöpfe danach ein)
        reklaStatus: REKLA_STATUS, reklaArt: REKLA_ART, reklaPhases: REKLA_PHASES,
        aktionen: aktiveAktionen().map(publicAktion), aktion: publicAktion(aktiveAktion()), serverNow: new Date().toISOString(),   // Übersicht: alle laufenden Aktionen + Countdown
        // Aktionen laut Preis-Historie (auch gelöschte) — Hinweis im Bereich Aktionen: Vor-Aktion < 30 Tage vor dem Start (§ 11 PAngV)
        aktionenHistorie: historieAktionen(),
        // erledigte Erstattungen/Gutschriften (kein Nachdruck) — Umsatz-KPIs ziehen sie ab
        kpi: { erstattet: Math.round(orders.reduce((s, o) => s + refundAmount(o), 0) * 100) / 100, erstattungen: orders.filter((o) => refundAmount(o) > 0).length },
        info: { node: process.version, uptime: Math.round(process.uptime()), startedAt: SERVER_STARTED },
        // Hinweise für die Übersicht (z. B. fehlende Steuernummer bei Rechnungen mit USt) + Zahl offener Widerrufe
        hinweise: [...settingsHinweise(), ...paypalHinweise()],
        // Restwert je Guthaben-Gutschein (Gutschrift aus Reklamation) — Admin zeigt ihn in der Gutschein-Tabelle
        couponRest: guthabenRest(),
        widerrufeOffen: await withWiderrufe((list) => ({ result: list.filter((w) => w.status !== 'erledigt').length })).catch(() => 0),
      });
    }
    if (req.method === 'POST' && p === '/api/admin/settings') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const patch = await readJson(req);
      // Admin-Passwort: Text mit 8–200 Zeichen (leer würde den Admin für alle öffnen, Nicht-Strings sperren aus) — gespeichert wird nur
      // der scrypt-Hash (übernommen erst, wenn der ganze Patch geprüft ist); danach gilt der Speicher-Cache nicht mehr
      let adminHashNeu = null;
      if (patch.adminKey !== undefined) {
        if (typeof patch.adminKey !== 'string' || patch.adminKey.trim().length < 8 || patch.adminKey.trim().length > 200) return send(res, 400, { ok: false, error: 'Admin-Passwort: 8 bis 200 Zeichen' });
        adminHashNeu = await pwHash(patch.adminKey.trim());
      }
      if (patch.pricing !== undefined && (!patch.pricing || typeof patch.pricing !== 'object' || Array.isArray(patch.pricing))) {
        return send(res, 400, { ok: false, error: 'Preise: ungültiges Format' });
      }
      // Aktionen & Gutscheine vor jeder Änderung prüfen (400 mit Meldung, nichts wird übernommen)
      let aktionen;
      if (patch.aktionen !== undefined) {
        try { aktionen = sanitizeAktionen(patch.aktionen); } catch (err) { return send(res, err.httpCode || 400, { ok: false, error: err.message }); }
      }
      if (patch.coupons !== undefined && (!Array.isArray(patch.coupons) || patch.coupons.some((c) => !c || typeof c !== 'object' || Array.isArray(c)))) return send(res, 400, { ok: false, error: 'Gutscheine: Liste erwartet' });
      if (patch.couponsLoeschen !== undefined && !Array.isArray(patch.couponsLoeschen)) return send(res, 400, { ok: false, error: 'Gutscheine löschen: Liste erwartet' });
      // Produktschalter: Objekt { eierbecher: true|false } (ein mitgeschicktes vase wird ignoriert — Vasen sind immer an)
      if (patch.produkte !== undefined) {
        if (!patch.produkte || typeof patch.produkte !== 'object' || Array.isArray(patch.produkte)) return send(res, 400, { ok: false, error: 'Produkte: ungültiges Format' });
        for (const [k, v] of Object.entries(patch.produkte)) {
          if (k !== 'vase' && !PRODUKT_SCHALTER.includes(k)) return send(res, 400, { ok: false, error: `Produkte: unbekanntes Produkt „${k}“` });
          if (typeof v !== 'boolean') return send(res, 400, { ok: false, error: `Produkte: ${k} muss true oder false sein` });
        }
      }
      // Firma, Shop- und Rechtsangaben: nur bekannte Felder, geprüft und gekürzt; fehlende Felder behalten den alten Stand
      let company, shop, legal, invoicePrefix = { prefix: null }, creditPrefix = { prefix: null };
      // Preise, Farben, Gutscheine, Druckwerte, Mail, PayPal: geprüft (preiseAus, farbenAus … mailAus) — null = nicht im Patch
      let pricingNeu = null, colorsNeu = null, couponsNeu = null, printingNeu = null, mailNeu = null, paypalNeu = null, nextCreditNeu = null;
      for (const k of ['company', 'shop', 'legal']) {
        if (patch[k] !== undefined && (!patch[k] || typeof patch[k] !== 'object' || Array.isArray(patch[k]))) {
          return send(res, 400, { ok: false, error: `${{ company: 'Firma', shop: 'Shop-Angaben', legal: 'Rechtsangaben' }[k]}: ungültiges Format` });
        }
      }
      try {
        if (patch.company !== undefined) company = sanitizeCompany({ ...settings.company, ...patch.company });
        if (patch.shop !== undefined) shop = sanitizeShop({ ...settings.shop, ...patch.shop });
        if (patch.legal !== undefined) legal = sanitizeLegal({ ...settings.legal, ...patch.legal });
        // Nummernkreise: nur echte Änderungen (siehe belegPraefixAusPatch) — ein veralteter Admin-Tab setzt nichts zurück
        if (patch.invoicePrefix !== undefined) invoicePrefix = belegPraefixAusPatch('invoicePrefix', patch.invoicePrefix, 'Rechnungspräfix');
        if (patch.creditPrefix !== undefined) creditPrefix = belegPraefixAusPatch('creditPrefix', patch.creditPrefix, 'Gutschriftpräfix');
        // Rechnungen und Gutschriften/Stornos brauchen getrennte Nummernkreise (sonst zwei Belege mit gleicher Nummernfolge)
        const reP = String(invoicePrefix.prefix || settings.invoicePrefix || '').toUpperCase(), gsP = String(creditPrefix.prefix || settings.creditPrefix || '').toUpperCase();
        if (reP && reP === gsP) throw httpError(400, 'Rechnungs- und Gutschrift-Präfix müssen sich unterscheiden (z. B. RE-2026- und GS-2026-)');
        if (patch.nextCredit !== undefined) {
          nextCreditNeu = Number(patch.nextCredit);
          if (!Number.isInteger(nextCreditNeu) || nextCreditNeu < 1) throw httpError(400, 'Nächste Gutschriftnummer: ganze Zahl ab 1');
        }
        if (patch.pricing !== undefined) pricingNeu = preiseAus(patch.pricing);
        if (patch.colors !== undefined) colorsNeu = farbenAus(patch.colors);
        if (patch.printing !== undefined) printingNeu = druckAus(patch.printing);
        if (patch.coupons !== undefined) couponsNeu = gutscheineAus(mergeCoupons(settings.coupons, patch.coupons, patch.couponsLoeschen));
        if (patch.mail !== undefined) {
          // Passwort-Maske — leer = gespeichertes behalten, null = löschen; dann den zusammengeführten Stand prüfen
          const pm = objAus(patch.mail, 'E-Mail'), prev = settings.mail || {};
          const next = { ...DEFAULT_SETTINGS.mail, ...prev };
          for (const k of MAIL_KEYS) if (pm[k] !== undefined) next[k] = pm[k];
          // Ein leeres Feld behält das gespeicherte Passwort nur für denselben Zugang (Host/Port/Benutzer, nicht auf
          // „unverschlüsselt“ heruntergestellt) — sonst ginge es an einen anderen Server (lib/mailer.js keepStoredPass)
          const mp = keepStoredPass(prev, next, pm.pass);
          if (mp.error) throw httpError(400, mp.error);
          next.pass = mp.pass;
          mailNeu = mailSettings(mailAus(next));
        }
        if (patch.paypal !== undefined) {
          // Secret-Maske wie beim SMTP-Passwort — leer = gespeichertes behalten, null = löschen
          const pp = objAus(patch.paypal, 'PayPal'), prev = settings.paypal || {};
          const next = { ...DEFAULT_SETTINGS.paypal, ...prev };
          for (const k of ['enabled', 'sandbox', 'clientId']) if (pp[k] !== undefined) next[k] = pp[k];
          if (pp.secret === null) next.secret = '';
          else if (String(pp.secret ?? '')) next.secret = String(pp.secret);
          paypalNeu = paypalAus(next);
        }
      } catch (err) { return send(res, err.httpCode || 400, { ok: false, error: err.message }); }
      // Wartungsmodus: { aktiv, kennwort? } — Kennwort nur als Hash speichern; neues Kennwort = alle Freigaben ungültig
      let wartungNeu = null;
      if (patch.wartung !== undefined) {
        const w = patch.wartung;
        if (!w || typeof w !== 'object' || Array.isArray(w)) return send(res, 400, { ok: false, error: 'Wartungsmodus: ungültiges Format' });
        const neu = { ...DEFAULT_SETTINGS.wartung, ...(settings.wartung || {}) };
        if (w.kennwort !== undefined && w.kennwort !== '') {
          if (typeof w.kennwort !== 'string' || w.kennwort.trim().length < 6 || w.kennwort.length > 100) return send(res, 400, { ok: false, error: 'Zugangskennwort: 6 bis 100 Zeichen' });
          neu.hash = wartungHash(w.kennwort.trim());
          neu.secret = crypto.randomBytes(32).toString('base64url');
        }
        if (w.aktiv !== undefined) neu.aktiv = !!w.aktiv;
        if (neu.aktiv && !neu.hash) return send(res, 400, { ok: false, error: 'Wartungsmodus: bitte zuerst ein Zugangskennwort setzen' });
        wartungNeu = neu;
      }
      // Ab hier nur noch Übernahme geprüfter Werte (Gutscheine: mergeCoupons + gutscheineAus)
      if (pricingNeu) settings.pricing = pricingNeu;
      if (colorsNeu) settings.colors = colorsNeu;
      if (printingNeu) settings.printing = printingNeu;
      if (couponsNeu) settings.coupons = couponsNeu;
      if (company) settings.company = company;
      if (shop) settings.shop = shop;
      if (legal) settings.legal = legal;
      // Rechnungs-Nummernkreis: Präfix als Text (≤ 20 Zeichen) — der Jahreswechsel passiert automatisch beim nächsten Beleg;
      // der Zähler läuft weiter (nextBelegNr überspringt ohnehin jede schon vergebene Nummer)
      if (invoicePrefix.prefix) settings.invoicePrefix = invoicePrefix.prefix;
      if (aktionen) settings.aktionen = aktionen;
      // Produktschalter übernehmen (fehlende Schlüssel behalten den alten Stand)
      if (patch.produkte !== undefined) settings.produkte = sanitizeProdukte({ ...settings.produkte, ...patch.produkte });
      // Gutscheine: nur Objekte; mitAktion als echter Boolean (fehlt → false = nicht mit Aktion kombinierbar)
      settings.coupons = settings.coupons.filter((c) => c && typeof c === 'object');
      for (const c of settings.coupons) c.mitAktion = !!c.mitAktion;
      // Gutschrift-Nummernkreis: Präfix als Text (≤ 20 Zeichen), nächste Nummer als ganze Zahl ≥ 1
      if (creditPrefix.prefix) settings.creditPrefix = creditPrefix.prefix;
      if (nextCreditNeu) settings.nextCredit = nextCreditNeu;
      if (wartungNeu) settings.wartung = wartungNeu;
      if (adminHashNeu) { settings.adminKeyHash = adminHashNeu; adminPlatzhalterSetzen(settings); adminCache.clear(); }
      if (patch.paypal && typeof patch.paypal === 'object') {
        settings.paypal = paypalNeu;   // geprüft oben (paypalAus, Secret-Maske angewendet)
      }
      settings.printing = { ...DEFAULT_SETTINGS.printing, ...(settings.printing || {}) };
      // E-Mail: nur bekannte Felder (geprüft in mailAus); ohne Patch bleibt der gespeicherte Stand
      if (mailNeu) settings.mail = mailNeu;
      else settings.mail = { ...DEFAULT_SETTINGS.mail, ...(settings.mail || {}) };
      await saveSettings();
      // Wartungsmodus gerade eingeschaltet oder neues Kennwort: der Admin sperrt sich nicht selbst aus — Freigabe-Cookie gleich mit
      if (wartungNeu && wartungAktiv()) res.setHeader('Set-Cookie', wartungCookie(req));
      // Preise, Farbaufpreise oder Aktionen geändert → Momentaufnahme für den 30-Tage-Tiefstpreis (§ 11 PAngV)
      await notePreisHistorie().catch((err) => console.error('Preis-Historie konnte nicht gespeichert werden:', err?.message || err));
      // hinweis: nicht übernommene Angaben (z. B. Präfix aus einem Tab von vor dem Jahreswechsel) — der Admin zeigt ihn an
      const hinweis = [invoicePrefix.hinweis, creditPrefix.hinweis].filter(Boolean).join(' ');
      // coupons: gespeicherter Stand (inkl. Guthaben-Codes, die der Tab noch nicht kannte) — der Admin übernimmt ihn
      return send(res, 200, { ok: true, coupons: settings.coupons, couponRest: guthabenRest(), ...(hinweis ? { hinweis } : {}) });
    }
    if (req.method === 'POST' && p === '/api/admin/order-update') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const body = await readJson(req);
      const { orderId, status, paymentStatus, trackingNo, carrier, adminNote, note } = body;
      if (!orderIdOk(orderId)) return send(res, 400, { ok: false, error: 'Ungültige Bestellnummer' });
      if (status !== undefined && !STATUSES.includes(status)) return send(res, 400, { ok: false, error: 'Ungültiger Status' });
      if (paymentStatus !== undefined && !['offen', 'bezahlt'].includes(paymentStatus)) return send(res, 400, { ok: false, error: 'Ungültiger Zahlungsstatus' });
      if (carrier !== undefined && !CARRIERS.includes(carrier)) return send(res, 400, { ok: false, error: 'Unbekannter Versender' });
      let order, prevStatus;
      const release = await lockOrder(orderId);
      try {
        try { order = await readOrder(orderId); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
        prevStatus = order.status;
        // Storno aufheben nur ohne Stornorechnung und mit noch verfügbarem Guthaben (stornoAufhebenSperre)
        if (status !== undefined && status !== 'storniert' && order.status === 'storniert') {
          const sperre = stornoAufhebenSperre(order);
          if (sperre) return send(res, 409, { ok: false, code: 'storno', error: sperre });
        }
        // Status „Bezahlt“ mit offener Zahlung wäre widersprüchlich (Druckwarteschlange, Rechnung, Mails) — erst den Status ändern
        if (paymentStatus === 'offen' && (status ?? order.status) === 'bezahlt') {
          return send(res, 400, { ok: false, error: 'Status „Bezahlt“ und Zahlung „offen“ passen nicht zusammen – bitte die Bestellung dafür zurück auf „Neu“ setzen.' });
        }
        const now = new Date().toISOString();
        // „Zahlung verbuchen“ schickt paymentStatus UND status 'bezahlt' — dann nur ein Historieneintrag (über setOrderStatus)
        const paidViaStatus = status === 'bezahlt' && order.status !== 'bezahlt';
        if (paymentStatus !== undefined && paymentStatus !== order.paymentStatus) {
          order.paymentStatus = paymentStatus;
          if (paymentStatus === 'bezahlt') {
            order.paidAt = now;
            if (!paidViaStatus) addHistory(order, order.status, note || 'Zahlung eingegangen', 'admin');
          } else {
            order.paidAt = null;
            delete order.mailsSent.bezahlt;   // Fehlklick zurückgenommen → die echte Bezahlt-Mail darf später noch raus
            addHistory(order, order.status, note || 'Zahlung auf „offen“ zurückgesetzt', 'admin');
          }
        }
        if (carrier !== undefined) order.carrier = carrier;
        const trackingChanged = trackingNo !== undefined && String(trackingNo).trim() !== (order.trackingNo || '');
        if (trackingNo !== undefined) order.trackingNo = String(trackingNo).trim().slice(0, 80);
        if (adminNote !== undefined) order.adminNote = String(adminNote).slice(0, 2000);
        if (status !== undefined) {
          const shipNote = status === 'versendet' && order.trackingNo
            ? `Versendet${order.carrier ? ' mit ' + CARRIER_LABELS[order.carrier] : ''} · ${order.trackingNo}` : null;
          const payNote = paidViaStatus && paymentStatus === 'bezahlt' ? 'Zahlung eingegangen' : null;
          setOrderStatus(order, status, note || shipNote || payNote, 'admin');
          if (order.status === 'storniert') await stornoBeleg(order, { nachholen: prevStatus === 'storniert' });
        } else if (trackingChanged && order.trackingNo) {
          addHistory(order, order.status, `Sendungsnummer hinterlegt${order.carrier ? ' (' + CARRIER_LABELS[order.carrier] + ')' : ''}: ${order.trackingNo}`, 'admin');
        }
        await writeOrder(order);
      } finally { release(); }
      send(res, 200, { ok: true, order });
      if (order.status !== prevStatus) await runHook('statusChanged', order, prevStatus, { notify: body.notify !== false });
      return;
    }
    // Druckstatus je Position — mit Automatik für den Bestellstatus (im-druck / gedruckt)
    if (req.method === 'POST' && p === '/api/admin/line-print') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const { orderId, idx, status, note } = await readJson(req);
      if (!orderIdOk(orderId)) return send(res, 400, { ok: false, error: 'Ungültige Bestellnummer' });
      if (!PRINT_STATES.includes(status)) return send(res, 400, { ok: false, error: 'Ungültiger Druckstatus' });
      let order, prevStatus, wasPrinted;
      const release = await lockOrder(orderId);
      try {
        try { order = await readOrder(orderId); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
        const i = parseInt(idx, 10);
        if (!(i >= 0 && i < order.lines.length)) return send(res, 400, { ok: false, error: 'Ungültige Position' });
        const line = order.lines[i];
        const prev = line.print || { status: 'offen' };
        const now = new Date().toISOString();
        const print = { status };
        if (status === 'druckt') { print.startedAt = prev.status === 'druckt' && prev.startedAt ? prev.startedAt : now; }
        if (status === 'fertig') { print.startedAt = prev.startedAt || now; print.doneAt = now; }
        if (note !== undefined) print.note = String(note).slice(0, 300);
        else if (prev.note) print.note = prev.note;
        line.print = print;
        const label = `Position ${i + 1} (${line.qty}× ${line.product === 'vase' ? 'Vase' : 'Eierbecher'})`;
        addHistory(order, order.status, { offen: `${label}: Druck zurückgesetzt`, druckt: `${label}: Druck gestartet`, fertig: `${label}: gedruckt` }[status], 'admin');
        prevStatus = order.status;
        wasPrinted = order.status === 'gedruckt';   // Nachdruck: aus „gedruckt“ zurück nach „im Druck“
        const allDone = () => order.lines.every((l) => l.print?.status === 'fertig');
        if (status === 'druckt' && (orderIsPaid(order) || wasPrinted)) {
          setOrderStatus(order, 'im-druck', wasPrinted ? 'Automatisch: Nachdruck gestartet' : 'Automatisch: erster Druck gestartet', 'system');
        } else if (status === 'fertig' && allDone() && (orderIsPaid(order) || order.status === 'im-druck')) {
          setOrderStatus(order, 'gedruckt', 'Automatisch: alle Positionen gedruckt', 'system');
        } else if (status === 'offen' && wasPrinted && !allDone()) {
          setOrderStatus(order, 'im-druck', 'Automatisch: Position zurückgesetzt (Nachdruck)', 'system');
        }
        await writeOrder(order);
      } finally { release(); }
      send(res, 200, { ok: true, order });
      // Rückstufung gedruckt → im-druck ohne Kundenmail (sonst käme nach „Fertig gedruckt“ noch „Im Druck“)
      if (order.status !== prevStatus) await runHook('statusChanged', order, prevStatus, { notify: !wasPrinted, auto: true });
      return;
    }
    // Reklamation: anlegen | eingegangen | erledigen | ablehnen | zuruecknehmen — Antwort { ok, order } wie order-update
    if (req.method === 'POST' && p === '/api/admin/reklamation') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      let body; try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch { body = null; }
      if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: 'Ungültige Anfrage' });
      const { orderId, action } = body;
      if (!orderIdOk(orderId)) return send(res, 400, { ok: false, error: 'Ungültige Bestellnummer' });
      if (!REKLA_ACTIONS.includes(action)) return send(res, 400, { ok: false, error: 'Unbekannte Aktion (anlegen | eingegangen | erledigen | ablehnen | zuruecknehmen)' });
      const bad = (msg) => send(res, 400, { ok: false, error: msg });
      const grund = clipText(body.grund, 500);
      const note = clipText(body.note, 500);
      const iban = body.iban === undefined ? undefined : cleanIban(body.iban);
      if (iban === null) return bad('IBAN ungültig – nur Buchstaben und Ziffern (Leerzeichen erlaubt), 15–34 Zeichen, beginnt mit Länderkennung');
      let order, phase = null, info = '', coupon = null;
      const release = await lockOrder(orderId);
      try {
        try { order = await readOrder(orderId); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
        const r = order.reklamation;
        const now = new Date().toISOString();
        const clearReklaMails = () => { for (const k of Object.keys(order.mailsSent)) if (k.startsWith('reklamation:')) delete order.mailsSent[k]; };
        switch (action) {
          case 'anlegen': {
            // Eine zweite Reklamation nur nach Ablehnung oder erledigtem Nachdruck — erledigte Erstattungen bleiben stehen (kein doppeltes Geld)
            if (r && !(r.status === 'abgelehnt' || (r.status === 'erledigt' && r.art === 'nachdruck'))) {
              return bad(`Zu dieser Bestellung gibt es bereits eine Reklamation (${REKLA_STATUS[r.status] || r.status}) – erst erledigen, ablehnen oder zurücknehmen`);
            }
            const art = String(body.art || '');
            if (!REKLA_ART[art]) return bad('Unbekannte Art (nachdruck | gutschein | ueberweisung | paypal)');
            if (!grund) return bad('Bitte einen Grund angeben');
            // Nach einem Storno ist die Rechnung aufgehoben (Stornorechnung) — weder Nachdruck noch Geld für eine stornierte Bestellung
            if (order.status === 'storniert' || order.storno?.nr) return bad('Die Bestellung ist storniert – eine Reklamation ist nicht mehr möglich (die Stornorechnung hebt die Rechnung schon auf).');
            if (art === 'paypal' && !(order.payment === 'paypal' && order.paypalOrderId)) return bad('Erstattung per PayPal geht nur bei Bestellungen, die per PayPal bezahlt wurden');
            // Gutschrift/Erstattung nur zu einer Rechnung und höchstens bis zum bezahlten Betrag (inkl. Guthaben-Anteil) minus frühere Gutschriften
            if (art !== 'nachdruck' && !order.invoiceNo) return bad('Gutschrift/Erstattung geht nur zu einer ausgestellten Rechnung – diese Kasse wurde nie abgeschlossen. Bitte stattdessen stornieren.');
            const max = art === 'nachdruck' ? 0 : reklaMax(order, art);
            if (art !== 'nachdruck' && max <= 0) return bad('Für diese Bestellung ist nichts bezahlt, das sich erstatten ließe – eine Gutschrift/Erstattung gibt es erst nach Zahlungseingang.');
            let betrag = art === 'nachdruck' ? euro(order.total) : max;   // Nachdruck: Betrag nur informativ (wie bisher die Bestellsumme)
            if (art !== 'nachdruck' && body.betrag !== undefined && body.betrag !== null && body.betrag !== '') {
              const n = Number(body.betrag);
              if (!Number.isFinite(n) || n < 0.01 || n > max + 1e-9) return bad(`Betrag muss zwischen 0,01 € und ${money(max)} (bezahlter Betrag${stornoBetraege(order).gutschrift ? ' abzüglich früherer Gutschriften' : ''}) liegen`);
              betrag = Math.round(n * 100) / 100;
            }
            const ruecksendung = !!body.ruecksendung;
            order.reklamation = { status: ruecksendung ? 'ruecksendung' : 'offen', art, grund, betrag, ruecksendung, createdAt: now, updatedAt: now };
            if (art === 'ueberweisung' && iban) order.reklamation.iban = iban;
            clearReklaMails();   // neue Reklamation = neuer Mailzyklus
            addHistory(order, order.status, `Reklamation angelegt – ${REKLA_ART[art]}${art !== 'nachdruck' ? ` über ${money(betrag)}` : ''}${ruecksendung ? ', Rücksendung erwartet' : ''}: ${grund}`, 'admin');
            if (art === 'nachdruck') {
              // Alle Positionen zurück in die Druckwarteschlange; Bestellstatus wieder „bezahlt“ (bzw. „neu“ bei offener Zahlung)
              for (const l of order.lines) l.print = { status: 'offen', ...(l.print?.note ? { note: l.print.note } : {}) };
              const target = order.paymentStatus === 'bezahlt' ? 'bezahlt' : 'neu';
              if (!setOrderStatus(order, target, `Nachdruck wegen Reklamation: ${grund}`, 'admin')) addHistory(order, order.status, `Nachdruck wegen Reklamation: ${grund}`, 'admin');
            }
            phase = 'angelegt';
            break;
          }
          case 'eingegangen': {
            if (!r) return bad('Keine Reklamation zu dieser Bestellung');
            if (!['offen', 'ruecksendung'].includes(r.status)) return bad(`„Ware eingegangen“ ist im Status „${REKLA_STATUS[r.status] || r.status}“ nicht möglich`);
            r.status = 'eingegangen'; r.updatedAt = now;
            if (note) r.note = note;
            addHistory(order, order.status, `Rücksendung eingegangen${note ? ': ' + note : ''}`, 'admin');
            phase = 'eingegangen';
            break;
          }
          case 'erledigen': {
            if (!r) return bad('Keine Reklamation zu dieser Bestellung');
            if (r.status === 'erledigt') { info = 'Reklamation war bereits erledigt – nichts geändert'; break; }   // idempotent: keine zweite Gutschrift/Mail
            if (!REKLA_OPEN.includes(r.status)) return bad(`Erledigen ist im Status „${REKLA_STATUS[r.status] || r.status}“ nicht möglich`);
            if (r.art === 'ueberweisung' && iban) r.iban = iban;
            if (r.art === 'ueberweisung' && !r.iban) return bad('Für die Erstattung per Überweisung fehlt die IBAN des Kunden');
            // Inzwischen storniert, nie abgeschlossen oder Zahlung zurückgesetzt: keine Gutschrift über den bezahlten Betrag hinaus
            if (r.art !== 'nachdruck') {
              if (order.status === 'storniert' || order.storno?.nr) return bad('Die Bestellung wurde inzwischen storniert – die Stornorechnung hebt die Rechnung schon auf. Bitte die Reklamation ablehnen oder zurücknehmen.');
              if (!order.invoiceNo) return bad('Gutschrift/Erstattung geht nur zu einer ausgestellten Rechnung – bitte die Reklamation zurücknehmen und die Bestellung stornieren.');
              if (!r.refundId && euro(r.betrag) > reklaMax(order, r.art) + 1e-9) return bad(`Der Betrag ${money(euro(r.betrag))} ist höher als der bezahlte Betrag (${money(reklaMax(order, r.art))}) – bitte die Reklamation zurücknehmen und neu anlegen.`);
            }
            if (note) r.note = note;
            if (r.art === 'paypal' && !r.refundId) {
              try {
                const ref = await paypalRefund(order, r.betrag);
                r.refundId = ref.id; r.updatedAt = now;
                await writeOrder(order);   // Geld ist raus → sofort festhalten, auch wenn ein späterer Schritt scheitert
              } catch (err) {
                console.error(`PayPal-Erstattung ${orderId} fehlgeschlagen:`, err?.message || err);
                return bad(`PayPal-Erstattung nicht möglich: ${err?.message || err}`);
              }
            }
            if (r.art !== 'nachdruck') {
              if (r.art === 'gutschein' && !r.gutscheinCode) r.gutscheinCode = newCouponCode();
              if (!r.gutschriftNo) {
                // Nummer erst an der Bestellung speichern, dann Gutschein und gutschrift.html — Beleg und Bestellung tragen dieselbe Nummer
                steuerDerRechnung(order);
                r.gutschriftNo = nextBelegNr('creditPrefix', 'nextCredit', DEFAULT_SETTINGS.creditPrefix);
                try { await writeOrder(order); } catch (err) {
                  belegNrFreigeben('creditPrefix', 'nextCredit', r.gutschriftNo, `Gutschrift zu ${orderId}: Bestellung nicht speicherbar (${err?.message || err})`);
                  throw err;
                }
              }
              if (r.art === 'gutschein' && !settings.coupons.some((c) => String(c?.code || '').toUpperCase() === r.gutscheinCode)) {
                // Guthaben: Restwert bleibt für spätere Bestellungen, gilt auch während einer Aktion (es ist Geld der Kundschaft)
                settings.coupons.push({ code: r.gutscheinCode, type: 'fixed', value: r.betrag, minOrder: 0, active: true, mitAktion: true, guthaben: true, note: `Gutschrift ${r.gutschriftNo} zu ${orderId}` });
              }
              if (r.art === 'gutschein') coupon = couponByCode(r.gutscheinCode);   // der Admin übernimmt ihn in seine Gutschein-Liste
              await saveSettings();
            }
            r.status = 'erledigt'; r.updatedAt = now; r.resolvedAt = now;
            // Ausgestellte Gutschrift nie überschreiben (GoBD) — liegt schon eine vor, bleibt sie stehen
            const creditFile = path.join(ORDERS, orderId, 'gutschrift.html');
            if (r.gutschriftNo && !existsSync(creditFile)) await writeFileAtomic(creditFile, creditNoteHTML(order));
            else if (r.gutschriftNo) console.warn(`⚠️  ${orderId}: gutschrift.html existiert bereits – ${r.gutschriftNo} nicht als Datei geschrieben`);
            const detail = { gutschein: `Gutschein ${r.gutscheinCode}`, ueberweisung: `Überweisung ${maskIban(r.iban)}`, paypal: `PayPal-Referenz ${r.refundId || '—'}`, nachdruck: 'Nachdruck' }[r.art];
            addHistory(order, order.status, `Reklamation erledigt – ${REKLA_ART[r.art]}${r.gutschriftNo ? `, Gutschrift ${r.gutschriftNo} über ${money(r.betrag)}` : ''} (${detail})${note ? ': ' + note : ''}`, 'admin');
            phase = 'erledigt';
            break;
          }
          case 'ablehnen': {
            if (!r) return bad('Keine Reklamation zu dieser Bestellung');
            if (!REKLA_OPEN.includes(r.status)) return bad(`Ablehnen ist im Status „${REKLA_STATUS[r.status] || r.status}“ nicht möglich`);
            if (!grund) return bad('Bitte eine Begründung für die Ablehnung angeben');
            r.status = 'abgelehnt'; r.note = grund; r.updatedAt = now; r.resolvedAt = now;
            addHistory(order, order.status, `Reklamation abgelehnt: ${grund}`, 'admin');
            phase = 'abgelehnt';
            break;
          }
          case 'zuruecknehmen': {
            if (!r) return bad('Keine Reklamation zu dieser Bestellung');
            if (!['offen', 'ruecksendung'].includes(r.status)) return bad(`Zurücknehmen geht nur, solange die Reklamation „${REKLA_STATUS.offen}“ oder „${REKLA_STATUS.ruecksendung}“ ist`);
            order.reklamation = null;
            clearReklaMails();
            addHistory(order, order.status, `Reklamation zurückgenommen (${REKLA_ART[r.art] || r.art})`, 'admin');
            break;
          }
        }
        await writeOrder(order);
      } finally { release(); }
      send(res, 200, { ok: true, order, ...(info ? { info } : {}), ...(coupon ? { coupon, couponRest: couponRest(coupon) } : {}) });
      if (phase) await runHook('reklamation', order, phase, { notify: body.notify !== false });
      return;
    }
    // Widerrufe (Admin): Liste neueste zuerst · Status offen/erledigt mit Notiz
    if (req.method === 'GET' && p === '/api/admin/widerrufe') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const list = await withWiderrufe((l) => ({ result: l.slice() }));
      return send(res, 200, { ok: true, widerrufe: list.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))) });
    }
    if (req.method === 'POST' && p === '/api/admin/widerruf-status') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      let body; try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch { body = null; }
      const ref = String(body?.ref || '').trim().toUpperCase();
      if (!WIDERRUF_REF_RE.test(ref)) return send(res, 400, { ok: false, error: 'Ungültige Referenz' });
      if (!WIDERRUF_STATUS.includes(body.status)) return send(res, 400, { ok: false, error: 'Status muss „offen“ oder „erledigt“ sein' });
      const notiz = body.notiz === undefined ? undefined : clipText(body.notiz, 1000);
      const found = await withWiderrufe((list) => {
        const w = list.find((x) => x.ref === ref);
        if (!w) return { result: null };
        const prev = w.status;
        w.status = body.status;
        if (notiz !== undefined) w.notiz = notiz;
        return { changed: true, result: { orderId: w.orderId, orderMatched: !!w.orderMatched, prev } };
      });
      if (!found) return send(res, 404, { ok: false, error: 'Widerruf unbekannt' });
      // Statuswechsel auch in der Historie der zugeordneten Bestellung festhalten
      if (found.orderMatched && found.prev !== body.status && ORDER_ID_RE.test(found.orderId)) {
        const release = await lockOrder(found.orderId);
        try {
          const o = await readOrder(found.orderId);
          addHistory(o, o.status, `Widerruf ${ref}: ${body.status === 'erledigt' ? 'als erledigt markiert' : 'wieder offen'}`, 'admin');
          await writeOrder(o);
        } catch (err) { console.error(`Widerruf ${ref}: Historie in ${found.orderId} fehlgeschlagen:`, err?.message || err); }
        finally { release(); }
      }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/users') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      return send(res, 200, { ok: true, users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, createdAt: u.createdAt, address: u.address || null, emailVerifiedAt: u.emailVerifiedAt || null })) });
    }
    // Kundenkonto (Admin): Datenauskunft als JSON (Art. 15 DSGVO) bzw. löschen (Bestellungen bleiben, ohne Kontobezug)
    if ((req.method === 'GET' && p === '/api/admin/user-export') || (req.method === 'POST' && p === '/api/admin/user-delete')) {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      let id = url.searchParams.get('id');
      if (req.method === 'POST') { try { id = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'))?.id; } catch { id = null; } }
      const u = typeof id === 'string' ? users.find((x) => x.id === id) : null;
      if (!u) return send(res, 404, { ok: false, error: 'Kundenkonto unbekannt' });
      if (req.method === 'GET') {
        res.setHeader('Content-Disposition', `attachment; filename="formsam-konto-${u.id.slice(0, 8)}.json"`);
        res.setHeader('Cache-Control', 'no-store');
        return send(res, 200, await kontoExport(u));
      }
      const n = await kontoLoeschen(u, 'im Admin');
      return send(res, 200, { ok: true, bestellungen: n });
    }
    const mAdminOrder = p.match(/^\/api\/admin\/order\/([A-Z0-9-]+)$/);
    if (req.method === 'GET' && mAdminOrder) {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try { return send(res, 200, { ok: true, order: await readOrder(mAdminOrder[1]) }); }
      catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
    }
    if (p === '/api/admin/export') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      // Backup ohne Geheimnisse (SMTP-Passwort, PayPal-Secret, Admin-Passwort, Zugriffsschlüssel der Belege) — die Datei landet im Download-Ordner
      return send(res, 200, { exportedAt: new Date().toISOString(), settings: adminSettingsView(), orders: (await listOrders()).map(ohneSchluessel) });
    }
    if (p === '/api/admin/orders.csv') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const orders = await listOrders();
      // Datum/Uhrzeit in deutscher Zeit wie auf Belegen und in Mails (der Server läuft in UTC) — sonst stünde eine Bestellung vom
      // 1.1. 00:30 in der CSV am 31.12. und im Vorjahr
      const dtCsv = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString('de-DE', { timeZone: TZ }) : '');
      // Formel-Injection (Excel/Calc): Zellen, die mit = + - @ Tab/CR beginnen, bekommen ein Hochkomma (OWASP)
      const csvEsc = (v) => {
        let s = String(v ?? '');
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return `"${s.replace(/"/g, '""')}"`;
      };
      // „Summe“ = zu zahlender Betrag (wie bisher, damit vorhandene Importe nicht verrutschen); hinten angehängt: Rechnungsbetrag
      // (Gesamtbetrag der Rechnung, Guthaben zählt als Zahlung), davon Guthaben, Gutschriftbetrag (erledigte Erstattung)
      const eur = (v) => euro(v).toFixed(2).replace('.', ',');
      const rows = [['Bestellung', 'Datum', 'Status', 'Zahlart', 'Rechnung', 'Name', 'E-Mail', 'Straße', 'PLZ', 'Ort', 'Positionen', 'Gutschein', 'Aktion', 'Summe', 'Tracking', 'Versender', 'Bezahlt am', 'Versendet am', 'Reklamation', 'Rechnungsbetrag', 'davon Guthaben', 'Gutschriftbetrag'].join(';')];
      for (const o of orders) {
        const sb = stornoBetraege(o);
        rows.push([
          csvEsc(o.orderId), csvEsc(dtCsv(o.createdAt)), csvEsc(o.status || 'neu'),
          csvEsc(o.payment || ''), csvEsc(o.invoiceNo ? `${o.invoiceNo}${o.storno?.nr ? ` (storniert: ${o.storno.nr})` : ''}` : ''), csvEsc(o.customer?.name || o.name || ''),
          csvEsc(o.customer?.email || o.email || ''), csvEsc(o.customer?.street || ''), csvEsc(o.customer?.zip || ''),
          csvEsc(o.customer?.city || ''),
          csvEsc((o.lines || []).map((l) => `${l.qty}x ${itemLabel(l, { mitAktion: true })}`).join(' | ')),
          csvEsc(o.coupon ? o.coupon.code : ''),
          // alle betroffenen Aktionen: „Name / −30 % auf Gehämmert / 7,47 | Name2 / −10 % auf alles / 2,49“ (ältere Bestellungen: ohne Geltungsbereich)
          csvEsc(orderAktionen(o).map((a) => `${a.name} / −${a.prozent} %${a.produkte !== undefined || a.muster !== undefined ? ` ${aktionScopeLabel(a)}` : ''} / ${euro(a.ersparnis).toFixed(2).replace('.', ',')}`).join(' | ')),
          csvEsc((o.total ?? 0).toFixed(2).replace('.', ',')), csvEsc(o.trackingNo || ''),
          csvEsc(CARRIER_LABELS[o.carrier] || ''),
          csvEsc(dtCsv(o.paidAt)),
          csvEsc(dtCsv(o.shippedAt)),
          csvEsc(o.reklamation ? `${REKLA_STATUS[o.reklamation.status] || o.reklamation.status} / ${REKLA_ART[o.reklamation.art] || o.reklamation.art} / ${euro(o.reklamation.betrag).toFixed(2).replace('.', ',')}` : ''),
          csvEsc(o.invoiceNo ? eur(sb.entgelt) : ''), csvEsc(sb.guth ? eur(sb.guth.off) : ''), csvEsc(refundAmount(o) ? eur(refundAmount(o)) : ''),
        ].join(';'));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="formsam-bestellungen.csv"' });
      return res.end('﻿' + rows.join('\n'));
    }
    // Kompatibel: alter Kurz-Endpoint (nur Status)
    if (req.method === 'POST' && p === '/api/admin/order-status') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const { orderId, status } = await readJson(req);
      if (!orderIdOk(orderId)) return send(res, 400, { ok: false, error: 'Ungültige Bestellnummer' });
      if (!STATUSES.includes(status)) return send(res, 400, { ok: false, error: 'Ungültiger Status' });
      let order, prevStatus;
      const release = await lockOrder(orderId);
      try {
        try { order = await readOrder(orderId); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
        prevStatus = order.status;
        const sperre = status !== 'storniert' && order.status === 'storniert' ? stornoAufhebenSperre(order) : null;
        if (sperre) return send(res, 409, { ok: false, code: 'storno', error: sperre });
        setOrderStatus(order, status, null, 'admin');
        if (order.status === 'storniert') await stornoBeleg(order, { nachholen: prevStatus === 'storniert' });
        await writeOrder(order);
      } finally { release(); }
      send(res, 200, { ok: true, order });
      if (order.status !== prevStatus) await runHook('statusChanged', order, prevStatus, { notify: true });
      return;
    }
    // --- E-Mail (Admin): Vorschau & Versand zu einer Bestellung, Testmail, Protokoll, erneut senden
    if (req.method === 'POST' && (p === '/api/admin/mail-preview' || p === '/api/admin/mail-send')) {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try {
        const body = await readJson(req, 256 * 1024);
        if (!orderIdOk(body.orderId)) return send(res, 400, { ok: false, error: 'Ungültige Bestellnummer' });
        let order;
        try { order = await readOrder(body.orderId); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
        // Dieselben Anhänge wie beim automatischen Versand (Bestätigung: Rechnung + Rechtstexte, Storno-/Reklamationsmail: Beleg-PDF);
        // die Vorschau nennt sie nur
        const art = body.kind === 'status' ? `status:${String(body.status || order.status || '')}`
          : body.kind === 'reklamation' ? `reklamation:${String(body.phase || '')}` : String(body.kind || '');
        const attachments = await mailAnhaenge(order, art);
        const m = renderOrderMail(order, { ...body, anhaenge: attachments.map((a) => a.filename) });
        const cust = customerAddress(order);
        if (p === '/api/admin/mail-preview') return send(res, 200, { ok: true, subject: m.subject, html: m.html, text: m.text, to: cust.email, kind: m.kind });
        if (!isEmail(cust.email)) return send(res, 400, { ok: false, error: 'Die Bestellung hat keine gültige Kunden-E-Mail' });
        // Zahlungserinnerung höchstens einmal je Kalendertag (deutsche Zeit): für die Dauer des Versands reserviert (erinnerungLaeuft),
        // geprüft an der frisch gelesenen Bestellung — mailErgebnis hat eine eben zugestellte Erinnerung dort schon vermerkt
        const erinnerung = m.key === 'zahlungserinnerung';
        if (erinnerung) {
          if (erinnerungLaeuft.has(order.orderId)) return send(res, 409, { ok: false, error: 'Die Zahlungserinnerung wird gerade gesendet – eine je Tag' });
          erinnerungLaeuft.set(order.orderId, 'senden');
        }
        try {
          if (erinnerung) {
            let frisch = order;
            try { frisch = await readOrder(order.orderId); } catch { /* wie oben gelesen */ }
            const um = erinnertHeute(frisch);
            if (um) return send(res, 409, { ok: false, error: `Heute ist schon eine Zahlungserinnerung rausgegangen (um ${um} Uhr) – eine je Tag` });
          }
          // Vermerk an der Bestellung (Historie, mailsSent[key]) schreibt der Mailer über mailErgebnis — auch bei Fehlern
          const r = await mailer.send({ to: cust, subject: m.subject, text: m.text, html: m.html, attachments, kind: m.kind, ref: order.orderId, orderId: order.orderId, key: m.key });
          if (!r.ok && /nicht eingerichtet/.test(r.error || '')) r.error += ' – die Nachricht liegt im Versandprotokoll und kann nach der Einrichtung erneut gesendet werden';
          return send(res, 200, { ok: !!r.ok, id: r.id, error: r.error || '' });
        } finally { if (erinnerung) erinnerungLaeuft.delete(order.orderId); }
      } catch (err) {
        return send(res, err.httpCode || 500, { ok: false, error: err.message || 'Serverfehler' });
      }
    }
    if (req.method === 'POST' && p === '/api/admin/mail-test') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try {
        const body = await readJson(req, 64 * 1024);
        const to = String(body.to || '').trim();
        if (to && !isEmail(to)) return send(res, 400, { ok: false, error: 'Ungültige Empfängeradresse', log: [] });
        const override = {};
        if (body.settings && typeof body.settings === 'object') for (const k of MAIL_KEYS) if (body.settings[k] !== undefined) override[k] = body.settings[k];
        const r = await mailer.test(override, to);
        return send(res, 200, { ok: !!r.ok, error: r.error || '', log: r.log || [] });
      } catch (err) {
        return send(res, err.httpCode || 500, { ok: false, error: err.message || 'Serverfehler', log: [] });
      }
    }
    if (p === '/api/admin/mail-log') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try {
        const limit = parseInt(url.searchParams.get('limit'), 10) || 200;
        return send(res, 200, { ok: true, entries: await mailer.list({ limit }), config: mailer.config() });
      } catch (err) {
        return send(res, 500, { ok: false, error: err.message || 'Serverfehler' });
      }
    }
    // Übersicht: endgültig gescheiterte Mails (30 Tage, nicht ausgeblendet) + Zahl der Mails, die auf einen weiteren Versuch warten
    if (p === '/api/admin/mail-probleme') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try {
        return send(res, 200, { ok: true, ...(await mailer.problems()), aktiv: mailer.config().active });
      } catch (err) {
        return send(res, 500, { ok: false, error: err.message || 'Serverfehler' });
      }
    }
    if (req.method === 'POST' && p === '/api/admin/mail-quittieren') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try {
        const { id } = await readJson(req, 16 * 1024);
        if (typeof id !== 'string' || !(id === 'alle' || /^[a-z0-9]{6,40}$/.test(id))) return send(res, 400, { ok: false, error: 'Ungültige Protokoll-ID' });
        return send(res, 200, await mailer.quittieren(id));
      } catch (err) {
        return send(res, err.httpCode || 500, { ok: false, error: err.message || 'Serverfehler' });
      }
    }
    if (req.method === 'POST' && p === '/api/admin/mail-resend') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try {
        const { id } = await readJson(req, 16 * 1024);
        if (typeof id !== 'string' || !/^[a-z0-9]{6,40}$/.test(id)) return send(res, 400, { ok: false, error: 'Ungültige Protokoll-ID' });
        // „Erneut“ auf eine Zahlungserinnerung: die Bestellung für die Dauer des Versands reservieren (wie der Knopf im Drawer) —
        // der Mailer erzeugt sie frisch (frischBauen), also mit Zahlstand, Tagesgrenze und Frist von heute
        const e = await mailer.eintrag(id);
        const erinnerung = e?.kind === 'zahlungserinnerung' ? mailOrderId(e) : '';
        if (erinnerung) {
          if (erinnerungLaeuft.has(erinnerung)) return send(res, 409, { ok: false, error: 'Die Zahlungserinnerung wird gerade gesendet – eine je Tag' });
          erinnerungLaeuft.set(erinnerung, id);
        }
        try {
          const r = await mailer.resend(id);
          return send(res, 200, { ok: !!r.ok, error: r.error || '' });
        } finally { if (erinnerung && erinnerungLaeuft.get(erinnerung) === id) erinnerungLaeuft.delete(erinnerung); }
      } catch (err) {
        return send(res, err.httpCode || 500, { ok: false, error: err.message || 'Serverfehler' });
      }
    }
    // Druckzettel (Seite, A4) — nur mit Admin-Kopf (die Oberfläche lädt ihn per fetch; ein Passwort in der URL landet in Verlauf und Logs)
    const mZettel = p.match(/^\/admin\/druckzettel\/([A-Z0-9-]+)$/);
    if (req.method === 'GET' && mZettel) {
      if (!isAdmin(req)) return send(res, 401, 'Nicht angemeldet – bitte über den Admin-Bereich öffnen.', 'text/plain; charset=utf-8');
      let order;
      try { order = await readOrder(mZettel[1]); } catch { return send(res, 404, 'Bestellung unbekannt', 'text/plain; charset=utf-8'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(druckzettelHTML(order));
    }

    // --- Rechtsseiten (lib/legal.js) — /impressum /datenschutz /agb /widerruf /versand, mit oder ohne Slash am Ende
    const mLegal = p.match(/^\/([a-z]+)\/?$/);
    if (mLegal && LEGAL_ROUTES.includes(mLegal[1]) && (req.method === 'GET' || req.method === 'HEAD')) {
      const slug = mLegal[1];
      const mod = await legalModule();
      let html = null, code = 503;
      if (mod) {
        try {
          html = await mod.renderLegalPage(slug, { settings, baseUrl: baseUrlFor(settings) });
          code = typeof html === 'string' ? 200 : 404;
        } catch (err) { console.error(`Rechtsseite /${slug} fehlgeschlagen:`, err?.message || err); }
      }
      const out = code === 200 ? html : code === 503 ? legalFallbackHTML(slug) : 'Nicht gefunden';
      // gzip wie bei den statischen Dateien (die Seiten sind 40–60 KB, komprimiert etwa ein Viertel)
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && Buffer.byteLength(out) > 1024;
      res.writeHead(code, {
        'Content-Type': code === 404 ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding',
        ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
        ...(code === 503 ? { 'Retry-After': '300' } : {}),
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(gz ? gzipSync(out, { level: zc.Z_BEST_SPEED }) : out);
    }

    // --- robots.txt und sitemap.xml aus der öffentlichen Adresse (robots.txt ist auch im Wartungsmodus erreichbar: „Disallow: /“)
    if ((p === '/robots.txt' || p === '/sitemap.xml') && (req.method === 'GET' || req.method === 'HEAD')) {
      const txt = p === '/robots.txt' ? robotsTxt() : sitemapXml();
      // Wartung: „Disallow: /“ nur kurz gültig — Google hält robots.txt sonst bis zu 24 h, kürzt das aber nach max-age
      const cache = p === '/robots.txt' && wartungAktiv() ? 'max-age=300' : 'no-cache';
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)], 'Cache-Control': cache, 'Content-Length': Buffer.byteLength(txt) });
      return res.end(req.method === 'HEAD' ? undefined : txt);
    }
    // --- Startseite: Canonical und Vorschau-Adressen aus der öffentlichen Adresse (sonst wie eine statische HTML-Datei)
    if ((p === '/' || p === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      const sp = startseite();
      if (sp) {
        const headers = { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ETag: sp.etag, Vary: 'Accept-Encoding' };
        if (req.headers['if-none-match'] === sp.etag) { res.writeHead(304, headers); return res.end(); }
        const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
        const body = gz ? sp.gz : Buffer.from(sp.html);
        res.writeHead(200, { ...headers, ...(gz ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': body.length });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
    }

    // --- Unbekannte API-Adresse bzw. Methode: JSON statt Datei-Suche (405 nur für bekannte Nur-Lese-Adressen)
    if (p.startsWith('/api/')) {
      if (p === '/api/auth/me') { res.setHeader('Allow', 'GET, HEAD'); return send(res, 405, { ok: false, error: 'Methode nicht erlaubt' }); }
      return sendNichtGefunden(req, res, p, url);
    }

    // --- Seiten & Dateien: nur GET/HEAD (POST /__wartung beantwortet wartungTor vorher)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, 'Methode nicht erlaubt', 'text/plain; charset=utf-8');
    }
    if (p === '/favicon.ico') {
      const ico = path.join(PUBLIC, 'favicon.ico');
      if (!existsSync(ico)) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME['.ico'], 'Cache-Control': 'public, max-age=86400' });
      return createReadStream(ico).pipe(res);
    }
    if (p === '/admin' || p === '/admin/') p = '/admin.html';   // wie /admin.html ausliefern (gzip, ETag)

    // PDF-Fassung eines Belegs (/orders/<ID>/rechnung|gutschrift|storno.pdf) — Schlüssel wie bei der HTML-Fassung. Entsteht beim
    // ersten Abruf aus der gespeicherten HTML-Datei und bleibt danach unverändert; lässt sie sich nicht setzen → 302 auf die HTML-Fassung
    const mPdf = p.match(/^\/orders\/([^/]+)\/(rechnung|gutschrift|storno)\.pdf$/);
    if (mPdf) {
      let order = null;
      if (ORDER_ID_RE.test(mPdf[1])) { try { order = await readOrder(mPdf[1]); } catch { order = null; } }
      const z = orderZugriff(req, url, order, dateiOffen);
      if (z === 'gesperrt') return sendBelegFehler(res, 429);
      if (z !== 'ok' || !existsSync(path.join(ORDERS, mPdf[1], `${mPdf[2]}.html`))) return sendBelegFehler(res, 404);
      const kopf = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
      const pdf = await ensureBelegPdf(order, mPdf[2]);
      if (!pdf) {
        res.writeHead(302, { ...kopf, Location: `/orders/${encodeURIComponent(mPdf[1])}/${mPdf[2]}.html${url.search}` });
        return res.end();
      }
      res.writeHead(200, { ...kopf, 'Content-Type': PDF_TYP, 'Content-Length': pdf.buffer.length, 'Content-Disposition': `inline; filename="${pdf.filename}"` });
      return res.end(req.method === 'HEAD' ? undefined : pdf.buffer);
    }
    if (p.startsWith('/orders/')) {
      // Nur Rechnung/Gutschrift (Links in Mails/Konto) und Modelldateien — order.json mit Kundendaten, interner Notiz und
      // Historie wird nie ausgeliefert. Zugriff mit ?k=<accessKey>, Admin-Header oder (Altbestand ohne Schlüssel) allein
      // über die Bestellnummer; sonst 404 ohne Auskunft, zu viele Fehlgriffe je IP → 429 (siehe orderZugriff)
      const m = p.match(/^\/orders\/([^/]+)\/([^/]+)$/);
      const base = m ? m[2] : '';
      const allowed = base === 'rechnung.html' || base === 'gutschrift.html' || base === 'storno.html' || /\.(stl|3mf)$/i.test(base);
      let order = null;
      if (m && allowed && ORDER_ID_RE.test(m[1])) { try { order = await readOrder(m[1]); } catch { order = null; } }
      const z = orderZugriff(req, url, order, dateiOffen);
      // Fehlerseiten als kleine HTML-Seite im formsam-Look (der Link kommt aus einer Mail — kein rohes JSON), ohne jede
      // Auskunft über die Bestellung; Statuscode wie bisher
      if (z === 'gesperrt') return sendBelegFehler(res, 429);
      const file = order ? path.join(ORDERS, m[1], base) : '';
      if (z !== 'ok' || !file.startsWith(ORDERS + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
        return sendBelegFehler(res, 404);
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store',
        // Der Link trägt den Schlüssel: nie als Referrer weitergeben, nicht indexieren
        'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
      });
      return createReadStream(file).pipe(res);
    }

    // Statische Dateien — mit Browser-Cache & gzip für Text-Assets. Pfade mit „..“ (auch %2e%2e/%2f) gar nicht erst auflösen;
    // die Datei muss IN public/ liegen (mit Trenner geprüft — ein Nachbarordner wie public-alt/ ist kein Unterordner)
    if (p.includes('\0') || p.split(/[/\\]/).includes('..')) return send(res, 400, { ok: false, error: 'Ungültige URL' });
    let file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return send(res, 403, { ok: false, error: 'Verboten' });
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) return sendNichtGefunden(req, res, p, url);
    const ext = path.extname(file);
    const stat = statSync(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // vendor/fonts/env ändern sich praktisch nie → lange cachen;
    // eigene HTML/JS/CSS mit Revalidierung (ETag aus mtime+Größe, gzip-Fassung mit eigenem ETag)
    const isAsset = p.startsWith('/vendor/') || p.startsWith('/fonts/') || p.startsWith('/env/') || p.startsWith('/img/gallery/');
    headers['Cache-Control'] = isAsset ? 'public, max-age=2592000, immutable' : 'no-cache';
    const compressible = ['.html', '.css', '.js', '.json', '.svg'].includes(ext);
    const gz = compressible && /\bgzip\b/.test(String(req.headers['accept-encoding'] || '').slice(0, 500)) && stat.size > 1024;
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}${gz ? '-gz' : ''}"`;
    headers.ETag = etag;
    if (compressible) headers.Vary = 'Accept-Encoding';
    // If-None-Match tolerant: Liste, schwache ETags (W/ — z. B. von einem Proxy, der selbst komprimiert) und *
    const inm = String(req.headers['if-none-match'] || '').slice(0, 2000);
    if (inm && inm.split(',').some((t) => { const v = t.trim(); return v === '*' || v.replace(/^W\//, '') === etag; })) {
      res.writeHead(304, headers);
      return res.end();
    }
    if (gz) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      return createReadStream(file).pipe(createGzip({ level: zc.Z_BEST_SPEED })).pipe(res);
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  } catch (err) {
    // Eingabefehler (httpError 4xx: kaputtes JSON → 400, zu großer Body → 413) sind kein Serverfehler
    if (err?.httpCode >= 400 && err.httpCode < 500) return send(res, err.httpCode, { ok: false, error: err.message });
    console.error(err);
    send(res, 500, { ok: false, error: 'Serverfehler' });
  }
});

// Datendateien laden — eine vorhandene, aber unlesbare Datei bricht den Start ab (siehe ladeDatei), bevor irgendetwas geschrieben wird
try {
  loadSettings();
  loadDesigns();
  loadLists();
  loadUsers();
  loadCaptures();
} catch (err) {
  if (!err?.startAbbruch) throw err;
  console.error(`\n❌ Start abgebrochen: ${err.message}.\n   Der Shop startet nicht mit leeren oder Standard-Daten – sonst wären Konten, Codes oder Einstellungen beim nächsten Speichern überschrieben.\n   ${SICHERUNG_HINWEIS}\n`);
  process.exit(1);
}
loadPreisHistorie();
notePreisHistorie().catch((err) => console.error('Preis-Historie konnte nicht gespeichert werden:', err?.message || err));
// Sicherheitsnetz: ein einzelner Fehler außerhalb der try/catch-Pfade darf den Shop nicht beenden
process.on('unhandledRejection', (err) => console.error('Unbehandelte Promise-Ablehnung:', err));
process.on('uncaughtException', (err) => console.error('Unbehandelte Ausnahme:', err));
// Erst Guthaben-Einlösungen und vergebene Belegnummern aus den Bestellungen lesen, dann Anfragen annehmen — sonst könnte eine
// Bestellung direkt nach dem Start ein schon verbrauchtes Guthaben einlösen oder eine vergebene Nummer bekommen
server.requestTimeout = UPLOAD_ZEIT_MS;   // große Druckdateien über langsame Leitungen (sonst bricht Node nach 5 Minuten ab)
loadCouponUse().catch((err) => console.error('Gutschein-Einlösungen/Belegnummern konnten nicht gelesen werden:', err?.message || err)).then(() => server.listen(PORT, HOST, () => {
  console.log(`formsam Shop läuft → http://${HOST}:${PORT}  (Admin: /admin)`);
  // Abgebrochene Kassen aufräumen: gleich nach dem Start und dann stündlich (Druckdateien nach 48 h, Bestellung nach 14 Tagen)
  setTimeout(() => kassenAufraeumen(), 5000).unref();
  setInterval(() => kassenAufraeumen(), STUNDE_MS).unref();
  // Rechtsseiten früh laden, damit ein fehlendes/fehlerhaftes lib/legal.js gleich im Log steht (die Routen versuchen es erneut)
  legalModule().then((m) => {
    if (!m) return;
    console.log('Rechtsseiten: lib/legal.js geladen');
    try { for (const h of m.legalWarnings?.(settings) || []) console.warn(`⚠️  Rechtsseiten: ${h}`); } catch { /* nur Hinweise */ }
  });
  // PDF-Satz früh laden: ein fehlendes/fehlerhaftes lib/html-pdf.js steht gleich im Protokoll (dann Belege als Link, Rechtstexte als HTML)
  pdfModul().then((m) => { if (m) console.log('PDF-Belege: lib/html-pdf.js geladen'); });
  // Outbox laden: wartende Zustellungen aus der Zeit vor dem Neustart sofort weiterverarbeiten
  mailer.resume().catch((e) => console.error('✉️  Outbox konnte nicht geladen werden:', e?.message || e));
}));
