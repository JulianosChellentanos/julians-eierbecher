// formsam — Shop-Server: Statik + Pricing + Warenkorb-Checkout + Rechnungen + Admin + PayPal + Rechtsseiten + Widerruf
// Start: node server.js   →   http://<host>:4488   (Admin: /admin, Standard-Passwort bei Neuinstallation: formsam-admin)
import http from 'node:http';
import { createGzip, gzipSync, constants as zc } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync, statSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { mkdir, writeFile, readdir, readFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createMailer, baseUrlFor, mailSettings } from './lib/mailer.js';
import { orderConfirmation, orderStatus, statusMailAllowed, STATUS_MAIL, welcome, passwordReset, adminNewOrder, customMessage, surchargeList, surchargeText, aktionText,
  aktionSummary, aktionScopeLabel, orderAktionen, reklamationMail, REKLA_STATUS, REKLA_ART, REKLA_PHASES, RIM_LABELS,
  widerrufEingang, adminWiderruf, lieferzeitText, fristBeginnKurz, emailBestaetigung, VERIFY_TAGE, adminPaypalKasse } from './lib/mail-templates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
// ORDERS_DIR/DATA_DIR: abgeschottete Testinstanz (z. B. PORT=4490 DATA_DIR=tmp-tests/sandbox/data ORDERS_DIR=tmp-tests/sandbox/orders)
const ORDERS = path.resolve(process.env.ORDERS_DIR || path.join(__dirname, 'orders'));
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PORT = process.env.PORT || 4488;
const SERVER_STARTED = new Date().toISOString();
const MAX_JSON = 4 * 1024 * 1024;      // Checkout-JSON (ohne Modelle)
const MAX_STL = 90 * 1024 * 1024;      // pro Modell-Datei (binär)

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

const DEFAULT_SETTINGS = {
  adminKey: 'formsam-admin',
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
    ustId: '', steuerNr: '', kleinunternehmer: true,
    iban: 'DE00 0000 0000 0000 0000 00', bic: '', bank: '',
  },
  // Shop-Angaben für Kasse, Mails und Rechnung (Lieferzeit steht u. a. in der Bestellbestätigung)
  shop: { lieferzeit: '5–8 Werktage', liefergebiet: 'Deutschland' },
  // Angaben für die Rechtsseiten (lib/legal.js): Hoster und Serverstandort (Datenschutzerklärung)
  legal: { hoster: 'IONOS SE, Elgendorfer Str. 57, 56410 Montabaur', serverOrt: 'Berlin (Deutschland)' },
  paypal: { enabled: false, sandbox: true, clientId: '', secret: '' },
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
const COMPANY_TEXT = { name: 60, owner: 120, street: 120, zip: 10, city: 80, country: 60, email: 254, phone: 40, ustId: 20, steuerNr: 20, iban: 42, bic: 11, bank: 80 };
const SHOP_TEXT = { lieferzeit: 60, liefergebiet: 80 };
const LEGAL_TEXT = { hoster: 200, serverOrt: 120 };
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
 * USt-IdNr. „DE123456789“-Form, Steuernummer 10–13 Ziffern (mit / - Leerzeichen), IBAN über cleanIban (Vierergruppen).
 * Wirft httpError(400); liefert das vollständige company-Objekt.
 */
function sanitizeCompany(raw) {
  const src = plainObj(raw);
  const co = pickText(src, COMPANY_TEXT, { name: DEFAULT_SETTINGS.company.name, country: DEFAULT_SETTINGS.company.country });
  co.kleinunternehmer = src.kleinunternehmer === undefined ? true : !!src.kleinunternehmer;
  co.email = co.email.toLowerCase();
  if (co.email && !isEmail(co.email)) throw httpError(400, 'Firma: E-Mail-Adresse ungültig');
  co.ustId = co.ustId.toUpperCase().replace(/\s+/g, '');
  if (co.ustId && !/^[A-Z]{2}[0-9A-Z+*.]{2,12}$/.test(co.ustId)) throw httpError(400, 'Firma: USt-IdNr. ungültig (z. B. DE123456789)');
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
/** Rechtsangaben (Hoster, Serverstandort): Text, leer → Standard */
const sanitizeLegal = (raw) => pickText(plainObj(raw), LEGAL_TEXT, DEFAULT_SETTINGS.legal);
/**
 * Hinweise für den Admin (Übersicht): fehlende Pflichtangaben für Rechnungen mit Umsatzsteuer und — wenn lib/legal.js
 * geladen ist — dessen legalWarnings() (Impressum-Pflichtangaben, Platzhalter-Adresse, Telefon …)
 */
function settingsHinweise() {
  const co = settings.company || {};
  const out = [];
  if (!co.kleinunternehmer && !String(co.steuerNr || '').trim() && !String(co.ustId || '').trim()) {
    out.push('Rechnungen mit Umsatzsteuer brauchen eine Steuernummer oder USt-IdNr. – bitte unter Firma eintragen.');
  }
  if (historieDefekt) out.push(`Preis-Historie war beim Start unlesbar (gesichert als ${historieDefekt}) – die Streichpreise der nächsten 30 Tage (niedrigster Preis vor einer Aktion) bitte prüfen.`);
  if (historieGesperrt) out.push('Preis-Historie (data/preis-historie.json) ist nicht lesbar und wird nicht fortgeschrieben – bitte Datei prüfen und den Shop neu starten.');
  let legal = null;
  try { legal = typeof legalMod?.legalWarnings === 'function' ? legalMod.legalWarnings(settings) : null; } catch { legal = null; }
  if (Array.isArray(legal)) out.push(...legal.map(String));
  else if (!String(co.owner || '').trim()) out.push('Firma: Inhaber (voller Name) fehlt – er gehört auf Rechnungen und ins Impressum.');
  return out;
}

let settings;
function loadSettings() {
  mkdirSync(DATA, { recursive: true });
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    settings = structuredClone(DEFAULT_SETTINGS);
  }
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
  }
  // Aktionen: Array erzwingen, kaputte Einträge verwerfen (Meldung im Log)
  settings.aktionen = sanitizeAktionen(settings.aktionen, { lenient: true });
  // Ein leeres/ungültiges Admin-Passwort würde den Admin entweder für alle öffnen oder dauerhaft aussperren
  if (typeof settings.adminKey !== 'string' || !settings.adminKey.trim()) {
    console.warn('⚠️  settings.adminKey ungültig – Standard-Passwort wird verwendet');
    settings.adminKey = DEFAULT_SETTINGS.adminKey;
  }
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
  try { users = JSON.parse(readFileSync(USERS_FILE, 'utf8')).users || []; } catch { users = []; }
  try { sessions = JSON.parse(readFileSync(SESS_FILE, 'utf8')); } catch { sessions = {}; }
  // alte Sessions (> 90 Tage) aufräumen
  const cutoff = Date.now() - SESSION_TTL;
  for (const [t, s] of Object.entries(sessions)) if (s.createdAt < cutoff) delete sessions[t];
}
const SESSION_TTL = 90 * 864e5;   // Anmeldung gilt 90 Tage — danach wird sie beim nächsten Zugriff bzw. Serverstart entfernt
const saveUsers = () => writeFile(USERS_FILE, JSON.stringify({ users }, null, 2));

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
  try { designs = JSON.parse(readFileSync(DESIGNS_FILE, 'utf8')); } catch { designs = {}; }
}
const saveDesigns = () => writeFile(DESIGNS_FILE, JSON.stringify(designs));
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
function loadLists() { try { lists = JSON.parse(readFileSync(LISTS_FILE, 'utf8')); } catch { lists = {}; } }
const saveLists = () => writeFile(LISTS_FILE, JSON.stringify(lists));
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

const saveSessions = () => writeFile(SESS_FILE, JSON.stringify(sessions));
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { userId, createdAt: Date.now() };
  saveSessions();
  return token;
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

// --- Passwort vergessen: Token nur als SHA-256-Hash im Konto (user.reset = { hash, exp }), 60 Minuten gültig
const RESET_TTL = 60 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
/** Konto zu einem Mail-Token (field 'reset' = Passwort vergessen, 'verify' = E-Mail bestätigen) — nur gültige, nicht abgelaufene */
function userByToken(token, field) {
  const t = String(token || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
  const h = Buffer.from(sha256(t), 'hex');
  const now = Date.now();
  let found = null;
  for (const u of users) {   // alle Konten durchgehen (kein Abbruch → keine Zeitmessung möglich)
    const r = u[field];
    if (!r || !/^[0-9a-f]{64}$/.test(String(r.hash || ''))) continue;
    if (crypto.timingSafeEqual(h, Buffer.from(r.hash, 'hex')) && Number(r.exp) > now) found = u;
  }
  return found;
}
const userByResetToken = (token) => userByToken(token, 'reset');

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
// Rate-Limit für „Passwort vergessen“ (im Speicher): max. 3 Anfragen je E-Mail in 15 Minuten,
// je IP großzügiger (10), damit ein Proxy ohne X-Forwarded-For nicht alle Kunden gemeinsam sperrt.
// Der Speicher ist hart gedeckelt (FORGOT_MAX_KEYS) und wird höchstens einmal pro Minute durchgekehrt.
const FORGOT_IP_MAX = 10;
const FORGOT_MAX_KEYS = 5000;
const forgotHits = new Map();
let forgotSweep = 0;
function forgotLimited(key, max = 3, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const hits = (forgotHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { forgotHits.set(key, hits); return true; }
  hits.push(now);
  forgotHits.set(key, hits);
  if (forgotHits.size > FORGOT_MAX_KEYS && now - forgotSweep > 60_000) {
    forgotSweep = now;
    for (const [k, v] of forgotHits) if (!v.some((t) => now - t < windowMs)) forgotHits.delete(k);
  }
  // Map ist einfügegeordnet → bei Überlauf fliegen die ältesten Schlüssel raus
  while (forgotHits.size > FORGOT_MAX_KEYS) forgotHits.delete(forgotHits.keys().next().value);
  return false;
}
/** Nur nachsehen (ohne zu zählen): ist das Limit für key im Zeitfenster erreicht? — für Sperren, die nur Fehlgriffe zählen */
function rateLimitReached(key, max, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  return (forgotHits.get(key) || []).filter((t) => now - t < windowMs).length >= max;
}
// X-Forwarded-For ist clientgesteuert — nur hinter eigenem Reverse-Proxy auswerten (TRUST_PROXY=1 = ein Proxy,
// der seinen Wert hinten anhängt); ohne Proxy zählt die Socket-Adresse
const TRUST_PROXY = Math.max(0, parseInt(process.env.TRUST_PROXY || '0', 10) || 0);
function clientIp(req) {
  const ip = req.socket?.remoteAddress || '';
  if (!TRUST_PROXY) return ip;
  const list = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list[list.length - TRUST_PROXY] || ip;
}

// ---------------------------------------------------------------------------
// E-Mail-Versand (lib/mailer.js + lib/mail-templates.js) — Protokoll in data/mail-outbox.json
//   Hooks (unten): Bestellbestätigung + Admin-Kopie, Status-Mails, Willkommensmail.
//   Jede aus einer Bestellung heraus in den Versand gegebene Mail wird in order.mailsSent[key] = Zeitpunkt
//   vermerkt (key = 'bestaetigung' | Status) und in der Historie notiert (by 'mail') —
//   so gibt es je Status nur eine automatische Mail, auch wenn er erneut gesetzt wird.
//   Ist der Versand nicht eingerichtet, bleibt mailsSent frei (Historie sagt „nicht gesendet“),
//   damit die Automatik nach der Einrichtung greift; der Eintrag liegt im Versandprotokoll.
// ---------------------------------------------------------------------------
const mailer = createMailer({ dataDir: DATA, getSettings: () => settings, log: (m) => console.log('✉️ ', m) });
const MAIL_KEYS = ['enabled', 'host', 'port', 'secure', 'user', 'pass', 'from', 'fromName', 'replyTo', 'adminTo', 'adminCopy', 'autoStatusMails', 'publicUrl', 'allowSelfSigned'];
const EMAIL_RE = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;
const isEmail = (s) => EMAIL_RE.test(String(s || '').trim());
const customerAddress = (order) => ({ name: String(order.customer?.name || '').trim(), email: String(order.customer?.email || '').trim().toLowerCase() });
const httpError = (code, message) => Object.assign(new Error(message), { httpCode: code });
/** Einstellungen fürs Admin-UI/Export: Geheimnisse maskiert (leer + …Set) — SMTP-Passwort, PayPal-Secret und Admin-Passwort verlassen den Server nie. */
const adminSettingsView = () => {
  const { adminKey, ...rest } = settings;
  return {
    ...rest,
    mail: { ...settings.mail, pass: '', passSet: !!settings.mail?.pass },
    paypal: { ...settings.paypal, secret: '', secretSet: !!settings.paypal?.secret },
  };
};

/** Mail-Vermerk: Bestellung frisch lesen (unter Sperre), damit kein veraltetes Objekt zwischenzeitliche Änderungen überschreibt. */
async function noteMailSent(order, key, subject, to) {
  const release = await lockOrder(order.orderId);
  try {
    const o = await readOrder(order.orderId);
    o.mailsSent[key] = new Date().toISOString();
    addHistory(o, o.status, `E-Mail „${subject}“ → ${to}`, 'mail');
    await writeOrder(o);
  } finally { release(); }
}
/** Ehrlicher Vermerk ohne mailsSent, wenn die Mail nicht in den Versand ging (deaktiviert/fehler). */
async function noteMailSkipped(order, note) {
  const release = await lockOrder(order.orderId);
  try {
    const o = await readOrder(order.orderId);
    addHistory(o, o.status, note, 'mail');
    await writeOrder(o);
  } finally { release(); }
}
/** Ergebnis von mailer.queue() vermerken: eingereiht/gesendet → mailsSent[key], sonst Hinweis. */
async function noteQueued(order, key, subject, to, q) {
  if (q.status === 'wartet' || q.status === 'gesendet') return noteMailSent(order, key, subject, to);
  return noteMailSkipped(order, `E-Mail „${subject}“ an ${to} nicht gesendet: ${q.error || q.status} – liegt im Versandprotokoll`);
}
/**
 * AGB und Widerrufsbelehrung (mit Muster-Widerrufsformular) als HTML-Anhänge der Bestellbestätigung — so hat die Kundschaft
 * die Vertragsbedingungen auf einem dauerhaften Datenträger (§ 312f Abs. 2 BGB). Ohne lib/legal.js: keine Anhänge.
 */
async function legalAttachments() {
  const mod = await legalModule();
  if (!mod) return [];
  const out = [];
  for (const [slug, filename] of [['agb', 'formsam-AGB.html'], ['widerruf', 'formsam-Widerrufsbelehrung.html']]) {
    try {
      const html = await mod.renderLegalPage(slug, { settings, baseUrl: baseUrlFor(settings), forMail: true });
      if (typeof html === 'string') out.push({ filename, content: html, contentType: 'text/html; charset=utf-8' });
    } catch (err) { console.error(`Anhang ${filename} fehlgeschlagen:`, err?.message || err); }
  }
  return out;
}
/**
 * Mail zu einer Bestellung rendern (Admin: Vorschau & Versand). kind: bestaetigung | status | freitext | reklamation (+ phase)
 * anhaenge: Dateinamen der Rechtstexte, die mit der Bestätigung verschickt werden (nur Hinweistext in der Mail)
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
      return { key: `reklamation:${ph}`, kind: `reklamation:${ph}`, ...reklamationMail({ order, phase: ph, settings, baseUrl }) };
    }
    case 'bestaetigung':
      return { key: 'bestaetigung', kind, ...orderConfirmation({ order, settings, baseUrl, anhaenge }) };
    case 'status': {
      const st = String(status || order.status || '');
      if (!STATUSES.includes(st)) throw httpError(400, 'Ungültiger Status');
      if (!statusMailAllowed(st)) throw httpError(400, `Für den Status „${STATUS_LABELS[st] || st}“ gibt es keine Mail-Vorlage`);
      return { key: st, kind: `status:${st}`, ...orderStatus({ order, status: st, settings, baseUrl }) };
    }
    case 'freitext': {
      const subj = String(subject || '').trim().slice(0, 200);
      const body = String(text || '').trim().slice(0, 20000);
      if (!subj || !body) throw httpError(400, 'Bitte Betreff und Text ausfüllen');
      return { key: null, kind, ...customMessage({ order, subject: subj, text: body, settings, baseUrl }) };
    }
    default:
      throw httpError(400, 'Unbekannte Mail-Art (bestaetigung | status | freitext | reklamation)');
  }
}

// Bestellung abgeschlossen → Bestätigung an den Kunden, Kopie an den Shop (adminTo, sonst Firmen-Adresse)
hooks.orderCompleted = async (order) => {
  if (order.mailsSent?.bestaetigung) return;   // /complete wurde doppelt aufgerufen
  const baseUrl = baseUrlFor(settings);
  const mc = mailSettings(settings.mail);
  const cust = customerAddress(order);
  let customerMail = null;   // { subject, q } — nur wenn eine Kundenadresse vorliegt
  if (isEmail(cust.email)) {
    const attachments = await legalAttachments();   // AGB + Widerrufsbelehrung zum Aufbewahren
    const m = orderConfirmation({ order, settings, baseUrl, anhaenge: attachments.map((a) => a.filename) });
    const q = await mailer.queue({ to: cust, subject: m.subject, text: m.text, html: m.html, attachments, kind: 'bestaetigung', ref: order.orderId });
    customerMail = { subject: m.subject, q };
  }
  const adminTo = mc.adminTo || String(settings.company?.email || '').trim();
  if (mc.adminCopy && isEmail(adminTo)) {
    const m = adminNewOrder({ order, settings, baseUrl });
    await mailer.queue({ to: adminTo, subject: m.subject, text: m.text, html: m.html, kind: 'admin-neu', ref: order.orderId });
  }
  if (customerMail) await noteQueued(order, 'bestaetigung', customerMail.subject, cust.email, customerMail.q);
};
// Statuswechsel → Status-Mail (nur mit notify, aktivierter Automatik und passender Vorlage; je Status einmal)
hooks.statusChanged = async (order, prevStatus, { notify = true } = {}) => {
  const status = order.status;
  if (!notify || !mailSettings(settings.mail).autoStatusMails || !statusMailAllowed(status)) return;
  if (order.mailsSent?.[status]) return;
  const cust = customerAddress(order);
  if (!isEmail(cust.email)) return;
  const m = orderStatus({ order, status, settings, baseUrl: baseUrlFor(settings) });
  const q = await mailer.queue({ to: cust, subject: m.subject, text: m.text, html: m.html, kind: `status:${status}`, ref: order.orderId });
  await noteQueued(order, status, m.subject, cust.email, q);
};
// Reklamation angelegt/eingegangen/erledigt/abgelehnt → Kundenmail (je Phase einmal: mailsSent['reklamation:<phase>'])
hooks.reklamation = async (order, phase, { notify = true } = {}) => {
  if (!notify || !mailSettings(settings.mail).autoStatusMails || !order.reklamation || !REKLA_PHASES.includes(phase)) return;
  const key = `reklamation:${phase}`;
  if (order.mailsSent?.[key]) return;
  const cust = customerAddress(order);
  if (!isEmail(cust.email)) return;
  const m = reklamationMail({ order, phase, settings, baseUrl: baseUrlFor(settings) });
  const q = await mailer.queue({ to: cust, subject: m.subject, text: m.text, html: m.html, kind: key, ref: order.orderId });
  await noteQueued(order, key, m.subject, cust.email, q);
};
// Widerruf eingegangen → Eingangsbestätigung an die angegebene Adresse (sofort, mit Inhalt, Datum/Uhrzeit, Referenz) und
// Meldung an den Shop (adminTo, sonst Firmen-Adresse) — die Meldung geht unabhängig von „Kopie an den Shop“ raus,
// ein Widerruf darf nicht untergehen. Zugeordnete Bestellung: Mail-Vermerk in der Historie.
hooks.widerruf = async (w) => {
  const baseUrl = baseUrlFor(settings);
  const m = widerrufEingang({ widerruf: w, settings, baseUrl });
  const q = await mailer.queue({ to: { name: w.name, email: w.email }, subject: m.subject, text: m.text, html: m.html, kind: 'widerruf', ref: w.ref });
  const adminTo = mailSettings(settings.mail).adminTo || String(settings.company?.email || '').trim();
  if (isEmail(adminTo)) {
    const a = adminWiderruf({ widerruf: w, settings, baseUrl });
    await mailer.queue({ to: adminTo, subject: a.subject, text: a.text, html: a.html, kind: 'admin-widerruf', ref: w.ref });
  }
  if (w.orderMatched) await noteQueued({ orderId: w.orderId }, `widerruf:${w.ref}`, m.subject, w.email, q);
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
  const plain = raw.replace(/\s*(?:·\s*[^·()]*|\([^()]*\))\s*$/, '').trim();
  return cols.find((x) => x.name === raw) || (plain && cols.find((x) => x.name === plain)) || null;
}
/**
 * Stückpreis: uvp = Grundpreis + Untersetzer + Gravur + Farbschrift + Muster-Aufpreis + Farbaufpreis + Größe;
 * unit = uvp abzüglich Aktionsprozent (wenn eine Aktion für Produkt + Oberfläche gilt); dieselbe Formel rechnet der Client
 * in pricing.js (unitParts/unitPrice). parts = Aufschlüsselung in € (0 = nicht zutreffend).
 * Während einer Aktion ohne „mengenrabatt“ entfällt der Mengenrabatt (off = 0).
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
  // Erste laufende Aktion, die für Produkt und Oberfläche dieser Zeile gilt (null = voller Preis)
  const aktion = aktionFuer(item, aktionen);
  const aktionProzent = aktion ? aktion.prozent : 0;
  const unit = Math.round(uvp * (1 - aktionProzent / 100) * 100) / 100;
  const aktionBetrag = Math.round((uvp - unit) * 100) / 100;
  const off = aktionProzent > 0 && !aktion.mengenrabatt ? 0 : discountFor(item.product, qty);
  const lineFull = unit * qty;
  const line = Math.round(lineFull * (1 - off / 100) * 100) / 100;
  // color = aufgelöste Farb-ID (Fallback über den Namen), sonst die vom Client gesendete ID
  const color = col?.id || (typeof item.color === 'string' ? item.color.slice(0, 40) : null);
  return { qty, unit, off, lineFull: Math.round(lineFull * 100) / 100, line, parts, color, uvp, aktionProzent, aktionBetrag, aktionName: aktion ? aktion.name : null, aktionId: aktion ? aktion.id : null };
}
/**
 * Summen einer Bestellung: Zeilen (priceItem), Zwischensumme, Gutschein, Versand, Gesamt.
 * aktionen = [{ id, name, prozent, ersparnis, produkte, muster }] für jede Aktion, die mindestens eine Zeile reduziert hat
 * (Ersparnis = Σ je Zeile max(0, Normalpreis mit Staffel − Zeilenpreis), informativ; Mails und Beleg zeigen nur Ersparnis > 0),
 * sortiert nach Ersparnis absteigend; aktion = aktionen[0] || null.
 * Gutschein während einer Aktion: nur mit coupon.mitAktion — sonst coupon null und couponError mit lesbarer Meldung
 * (genannt wird die Aktion mit der größten Ersparnis); Mindestbestellwert nicht erreicht → coupon null mit couponError;
 * unbekannter/inaktiver Code → coupon null ohne couponError (allgemeine Meldung im Client).
 */
function computeTotals(items, couponCode) {
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
    .sort((x, y) => y.ersparnis - x.ersparnis);
  const aktion = aktionen[0] || null;
  // Gutschein
  let coupon = null;
  let couponError = null;
  let afterCoupon = subtotal;
  if (couponCode) {
    const c = settings.coupons.find((x) => x.active && String(x.code || '').trim().toLowerCase() === String(couponCode).trim().toLowerCase());
    // Mindestbestellwert nicht (mehr) erreicht — z. B. Menge im Warenkorb verringert: mit Meldung statt still ohne Gutschein
    // abrechnen (die Kasse zeigt sie, der Checkout lehnt mit 400 ab)
    if (c && subtotal < (c.minOrder || 0)) couponError = `Gutschein „${c.code}“ gilt erst ab einem Bestellwert von ${money(c.minOrder)}.`;
    else if (c) {
      // Guthaben-Gutschein (Gutschrift): höchstens der noch offene Restwert
      const rest = isGuthaben(c) ? couponRest(c) : null;
      if (rest !== null && rest <= 0) {
        couponError = `Gutschein „${c.code}“ ist bereits vollständig eingelöst.`;
      } else if (aktion && !c.mitAktion) {
        couponError = `Gutschein „${c.code}“ ist nicht mit der Aktion „${aktion.name}“ kombinierbar.`;
      } else {
        const off = c.type === 'fixed' ? Math.min(rest ?? c.value, c.value, subtotal) : subtotal * c.value / 100;
        // guthaben: Anrechnung eines Guthabens (Gutschrift) — die Rechnung weist das Entgelt dann ohne diesen Abzug aus (USt!)
        coupon = { code: c.code, type: c.type, value: c.value, off: Math.round(off * 100) / 100, ...(isGuthaben(c) ? { guthaben: true } : {}) };
        afterCoupon = Math.round((subtotal - coupon.off) * 100) / 100;
      }
    }
  }
  const ship = settings.pricing.shipping;
  const shipping = items.length === 0 ? 0 : (afterCoupon >= ship.freeFrom ? 0 : ship.flat);
  const total = Math.round((afterCoupon + shipping) * 100) / 100;
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
function readBody(req, limit = MAX_JSON) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Anfrage zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
/** Vergleich mit dem Admin-Passwort in konstanter Zeit; ein leeres/ungültiges Passwort passt nie. */
function adminKeyMatches(k) {
  const a = Buffer.from(typeof settings.adminKey === 'string' ? settings.adminKey : '');
  const s = Buffer.from(String(k ?? ''));
  return a.length > 0 && s.length === a.length && crypto.timingSafeEqual(s, a);
}
function isAdmin(req) {
  return adminKeyMatches(req.headers['x-admin-key']);
}

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
  const file = path.join(ORDERS, order.orderId, 'order.json');
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, JSON.stringify(order, null, 2));
  await rename(tmp, file);
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
    fest: !!order.completedAt || !!order.invoiceNo || order.paymentStatus === 'bezahlt',
    at: Date.parse(order.createdAt) || Date.now(),
  });
}
/** Einlösung aus couponUse entfernen (z. B. die Reservierung einer PayPal-Kasse, sobald die Bestellung sie übernimmt) */
const untrackCouponUse = (id) => { for (const m of couponUse.values()) m.delete(id); };
const isGuthaben = (c) => !!c?.guthaben && c.type === 'fixed';
/**
 * Gutschein-Liste aus dem Admin übernehmen, ohne Guthaben zu verlieren: Guthaben-Codes (guthaben: true) legt nur der Server an
 * (Reklamation „gutschein“ erledigen). Ein Admin-Tab, der vor der Gutschrift geladen wurde, kennt den neuen Code nicht — fehlt er
 * im Patch, bleibt er trotzdem stehen. Löschen nur ausdrücklich über loeschen (Codes aus dem 🗑 des Admins).
 * Kommt ein Guthaben-Code im Patch vor, bleiben die vom Server gesetzten Felder (Code, Art, Wert, Notiz) — nur aktiv,
 * Mindestbestellwert und „mit Aktion“ kommen aus dem Admin. Ein Eintrag mit guthaben: true, den der Server nicht als Guthaben
 * kennt (umbenannt, veralteter Tab nach dem Löschen), wird verworfen — sonst entstünde neues Guthaben ohne Gutschrift.
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
/** Öffentlicher Host für Fußzeilen: aus mail.publicUrl (wenn gesetzt), sonst formsam.de */
function publicHost() {
  const u = String(settings.mail?.publicUrl || '').trim();
  try { if (/^https?:\/\//i.test(u)) return new URL(u).host.replace(/^www\./, ''); } catch { /* ungültig → Standard */ }
  return 'formsam.de';
}
/** „00000 Musterstadt“ + Land (nur außerhalb Deutschlands) */
function companyOrt(co) {
  const land = String(co.country || '').trim();
  return [[co.zip, co.city].filter(Boolean).join(' '), land && land !== 'Deutschland' ? land : ''].filter(Boolean).join(', ');
}
/** Absenderblock rechts im Kopf (zweispaltig, damit der Kopf flach bleibt): Marke, Inhaber (voller Name), Anschrift | Kontakt, Steuernummer/USt-IdNr. */
function belegAbsender(co) {
  const adresse = [`<b>${esc(co.name || BRAND)}</b>`, esc(co.owner), esc(co.street), esc(companyOrt(co))].filter(Boolean);
  const kontakt = [
    co.email ? esc(co.email) : '', co.phone ? `Tel. ${esc(co.phone)}` : '',
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
    .ruecksende{font-size:9px;color:#6b6257;border-bottom:1px solid #e6ddd0;padding-bottom:2px;margin-bottom:7px;white-space:nowrap}
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
    @media (max-width:640px){.blatt{padding:18px}.kopf,.anschrift,.absender{flex-direction:column}.absender{gap:6px}.ruecksende{white-space:normal}.zahlung tr{display:flex;flex-wrap:wrap}}`;
/** Komplettes Beleg-Dokument: Knopfleiste (nur Bildschirm) + Blatt mit Kopf, Inhalt und Fußzeile */
function belegSeite({ title, co, body, css = '', leiste = '<button type="button" onclick="print()">Drucken / als PDF speichern</button>', logoHeight = 34 }) {
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
// Druckzettel (A4, schwarz/weiß-tauglich) — GET /admin/druckzettel/<ID>?k=<adminKey>
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
  const ku = !!co.kleinunternehmer;
  const vorkasse = order.payment !== 'paypal';
  const ausgestellt = order.completedAt || order.createdAt;
  // Hinweiszeile je Position: Aktion „Normalpreis 24,90 € · Aktion −16 % (Name)“ (Einzelpreis = reduzierter Preis, nur bei aktionProzent > 0)
  // und Aufpreise „inkl. Aufpreise: …“ (aus l.parts; ältere Bestellungen ohne parts zeigen keine) — Untersetzer/Größe stecken wie bisher im Einzelpreis
  const rows = order.lines.map((l, i) => {
    const note = [aktionText(l, settings), surchargeText(l, settings)].filter(Boolean).join(' · ');
    return `
    <tr><td class="muted">${i + 1}</td><td>${esc(itemLabel(l, { mitAufpreis: false }))}${note ? `<br><small class="muted">${esc(note)}</small>` : ''}</td><td class="r">${l.qty}</td><td class="r">${money(l.unit)}</td>
    <td class="r">${l.off ? '−' + l.off + ' %' : '—'}</td><td class="r">${money(l.line)}</td></tr>`;
  }).join('');
  // Ersparnis je betroffener Aktion („Aktion „Name“ −30 % auf Gehämmert: Ersparnis“) — informativ unter den Summen
  // (die Summen entstehen wie bisher aus den reduzierten Zeilen); ältere Bestellungen mit nur order.aktion: eine Zeile
  const aktionRow = aktionSummary(order, settings)
    .map((a) => `<tr class="fein"><td>${esc(a.label)}</td><td class="r">${esc(a.value)}</td></tr>`).join('');
  // Guthaben (Gutschrift aus einer Reklamation) ist eine Anrechnung, kein Rabatt: Die Gutschrift hat das Entgelt der ersten
  // Rechnung (samt USt) schon gemindert — hier zählt es als Zahlung. Entgelt und USt beziehen sich deshalb auf den Betrag vor
  // dem Guthaben, danach „abzüglich Guthaben“ und „Zu zahlen“ (= order.total). Ältere Bestellungen ohne Kennzeichen: über den Code.
  const guth = guthabenDerBestellung(order);
  const entgelt = guth ? Math.round((order.total + guth.off) * 100) / 100 : order.total;
  const ust = ku ? null : ustAus(entgelt);
  const ustRows = ust
    ? `<tr class="fein"><td>darin Nettobetrag</td><td class="r">${money(ust.netto)}</td></tr><tr class="fein"><td>darin Umsatzsteuer 19 %</td><td class="r">${money(ust.ust)}</td></tr>` : '';
  const guthRows = guth
    ? `<tr><td>abzüglich Guthaben „${esc(guth.code)}“${guth.gutschriftNo ? ` <small class="muted">(aus Gutschrift ${esc(guth.gutschriftNo)})</small>` : ''}</td><td class="r">−${money(guth.off)}</td></tr>
    <tr class="zahl"><td>Zu zahlen</td><td class="r">${money(order.total)}</td></tr>` : '';
  // § 34a UStDV (seit 2025): Hinweis, dass die Steuerbefreiung für Kleinunternehmer nach § 19 Abs. 1 UStG gilt
  const steuerNote = (ku
    ? 'Steuerbefreiung für Kleinunternehmer nach § 19 Abs. 1 UStG – es wird keine Umsatzsteuer berechnet.'
    : 'Alle Beträge in Euro inklusive 19 % Umsatzsteuer.') +
    (guth ? ' Dein Guthaben wird wie eine Zahlung angerechnet und mindert den Gesamtbetrag nicht.' : '');
  const bank = [['Kontoinhaber', co.owner || co.name], ['IBAN', co.iban], ['BIC', co.bic], ['Bank', co.bank], ['Verwendungszweck', order.orderId], ['Betrag', money(order.total)]]
    .filter(([, v]) => String(v || '').trim());
  const bankRows = [];
  for (let i = 0; i < bank.length; i += 2) bankRows.push(bank.slice(i, i + 2));
  const payNote = vorkasse
    ? `Bitte überweise ${guth ? 'den zu zahlenden Betrag' : 'den Gesamtbetrag'} innerhalb von 14 Tagen mit deiner Bestellnummer als Verwendungszweck:
       <table>${bankRows.map((row) => `<tr>${row.map(([k, v]) => `<th>${esc(k)}</th><td>${esc(v)}</td>`).join('')}</tr>`).join('')}</table>`
    : `Bezahlt per PayPal am ${esc(dateDE(order.paidAt || order.createdAt))}${guth ? ` (${money(order.total)}, der Rest über dein Guthaben)` : ''} – danke!`;
  const meta = [
    ['Rechnungsnummer', esc(order.invoiceNo)],
    ['Rechnungsdatum', esc(dateDE(ausgestellt))],
    ['Bestellnummer', esc(order.orderId)],
    ...(ku ? [] : [['Lieferdatum', `${esc(lieferMonat(ausgestellt, settings.shop?.lieferzeit))}<small>(Kalendermonat der Lieferung)</small>`]]),
  ];
  const cu = order.customer || {};
  const body = `
  <section class="anschrift">
    <div class="empfaenger"><div class="ruecksende">${belegRuecksende(co)}</div>
      <b>${esc(cu.name)}</b><br>${esc(cu.street)}<br>${esc(cu.zip)} ${esc(cu.city)}</div>
    <table class="meta">${meta.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
  </section>
  <h1>Rechnung</h1>
  <table class="pos"><tr><th>Pos.</th><th>Artikel (individuell 3D-gedruckt)</th><th class="r">Menge</th><th class="r">Einzelpreis</th><th class="r">Rabatt</th><th class="r">Summe</th></tr>${rows}</table>
  <table class="summen">
    <tr><td>Zwischensumme</td><td class="r">${money(order.subtotal)}</td></tr>
    ${order.coupon && !guth ? `<tr><td>Gutschein „${esc(order.coupon.code)}“</td><td class="r">−${money(order.coupon.off)}</td></tr>` : ''}
    <tr><td>Versand</td><td class="r">${order.shipping === 0 ? 'kostenlos' : money(order.shipping)}</td></tr>
    <tr class="grand"><td>Gesamtbetrag</td><td class="r">${money(entgelt)}</td></tr>
    ${ustRows}
    ${aktionRow}
    ${guthRows}
  </table>
  <p class="steuer">${steuerNote}</p>
  <div class="zahlung">${payNote}</div>
  <p class="dank">Danke für deine Bestellung! <span class="akzent">Gedruckt wird erst, wenn du bestellst</span> – jedes Stück entsteht individuell für dich.<br>Lieferzeit:&nbsp;${esc(lieferzeitText(settings))}. ${esc(fristBeginnKurz(order.payment))}</p>
  <p class="klein">Produkthinweise: Alle Artikel bestehen aus PLA, einem Kunststoff auf Pflanzenbasis (nicht spülmaschinengeeignet, keinen Temperaturen über 50 °C aussetzen, z. B. heißes Wasser, Heizung, Auto im Sommer).
  Vasen sind für Trockenblumen gedacht; das Material wird imprägniert und ist in der Regel wasserfest – eine Wasserdichtigkeit wird aber nicht zugesagt.
  Bei individuell gestalteten Formen (Formen-Editor) wird keine Standfestigkeit zugesagt.</p>`;
  return belegSeite({ title: `Rechnung ${order.invoiceNo} · ${BRAND}`, co, body });
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
  const ust = co.kleinunternehmer ? null : ustAus(betrag);
  const vatNote = co.kleinunternehmer
    ? 'Steuerbefreiung für Kleinunternehmer nach § 19 Abs. 1 UStG – es wird keine Umsatzsteuer berechnet.'
    : `Im Gutschriftbetrag enthaltene USt (19 %): ${money(ust.ust)} (netto ${money(ust.netto)}).`;
  const how = {
    gutschein: `Gutschrift als Gutschein-Code <b>${esc(r.gutscheinCode || '')}</b> – einlösbar in der Kasse des Shops im Feld „Gutscheincode“, ohne Mindestbestellwert und auch während einer Aktion. Ist die Bestellung kleiner, bleibt der Rest auf dem Code.`,
    ueberweisung: `Erstattung per Überweisung${r.iban ? ` auf IBAN ${esc(maskIban(r.iban))}` : ''} innerhalb von 5 Werktagen.`,
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
  <h1>Gutschrift</h1>
  <table class="pos"><tr><th>Position</th><th class="r">Betrag</th></tr>
    <tr><td>Gutschrift zu ${ref}<br><small class="muted">Grund: ${esc(r.grund || '—')}</small></td><td class="r">${money(betrag)}</td></tr></table>
  <table class="summen">
    <tr class="grand"><td>Gutschriftbetrag</td><td class="r">${money(betrag)}</td></tr>
  </table>
  <p class="steuer">${vatNote}</p>
  <div class="zahlung"><b>Art der Erstattung:</b> ${how}</div>
  <p class="dank">Diese Gutschrift bezieht sich auf die oben genannte Rechnung bzw. Bestellung${order.invoiceNo ? ' und mindert deren Betrag entsprechend' : ''}. Bei Fragen antworte einfach auf meine E-Mail.</p>`;
  return belegSeite({ title: `Gutschrift ${r.gutschriftNo || ''} · ${BRAND}`, co, body });
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
function stornoHTML(order) {
  const co = settings.company || {};
  const ku = !!co.kleinunternehmer;
  const st = order.storno || {};
  const { entgelt, gutschrift, betrag, guth } = stornoBetraege(order);
  const ust = ku ? null : ustAus(betrag);
  const rechnungVom = dateDE(order.completedAt || order.createdAt);
  const r = order.reklamation || {};
  const meta = [
    ['Stornonummer', esc(st.nr || '')],
    ['Datum', esc(dateDE(st.at))],
    ['zu Rechnung', `${esc(order.invoiceNo)}<small>vom ${esc(rechnungVom)}</small>`],
    ['Bestellnummer', esc(order.orderId)],
  ];
  const ustRows = ust
    ? `<tr class="fein"><td>darin Nettobetrag</td><td class="r">−${money(ust.netto)}</td></tr><tr class="fein"><td>darin Umsatzsteuer 19 %</td><td class="r">−${money(ust.ust)}</td></tr>` : '';
  const vatNote = ku
    ? 'Steuerbefreiung für Kleinunternehmer nach § 19 Abs. 1 UStG – es wird keine Umsatzsteuer berechnet.'
    : `Die in Rechnung ${esc(order.invoiceNo)} ausgewiesene Umsatzsteuer wird in dieser Höhe berichtigt.`;
  const bezahlt = order.paymentStatus === 'bezahlt';
  const zahlung = [
    bezahlt
      ? `Den bereits gezahlten Betrag${gutschrift ? ', soweit noch nicht erstattet,' : ''} erstatte ich dir ${order.payment === 'paypal' ? 'über PayPal' : 'per Überweisung'}.`
      : 'Du musst nichts überweisen. Hast du schon überwiesen, erstatte ich dir den Betrag.',
    guth ? `Dein Guthaben „${esc(guth.code)}“ über ${money(guth.off)} steht dir wieder zur Verfügung.` : '',
  ].filter(Boolean).join(' ');
  const cu = order.customer || {};
  const body = `
  <section class="anschrift">
    <div class="empfaenger"><div class="ruecksende">${belegRuecksende(co)}</div>
      <b>${esc(cu.name)}</b><br>${esc(cu.street)}<br>${esc(cu.zip)} ${esc(cu.city)}</div>
    <table class="meta">${meta.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
  </section>
  <h1>Stornorechnung</h1>
  <table class="pos"><tr><th>Position</th><th class="r">Betrag</th></tr>
    <tr><td>Stornierung der Rechnung ${esc(order.invoiceNo)} vom ${esc(rechnungVom)} · Bestellung ${esc(order.orderId)}<br><small class="muted">Die Bestellung wurde storniert.</small></td><td class="r">−${money(entgelt)}</td></tr>
    ${gutschrift ? `<tr><td>bereits gutgeschrieben mit Gutschrift ${esc(r.gutschriftNo)}</td><td class="r">${money(gutschrift)}</td></tr>` : ''}</table>
  <table class="summen">
    <tr class="grand"><td>Stornobetrag</td><td class="r">−${money(betrag)}</td></tr>
    ${ustRows}
  </table>
  <p class="steuer">${vatNote}</p>
  <div class="zahlung">${zahlung}</div>
  <p class="dank">Diese Stornorechnung hebt die Rechnung ${esc(order.invoiceNo)} auf. Bei Fragen antworte einfach auf meine E-Mail.</p>`;
  return belegSeite({ title: `Stornorechnung ${st.nr || ''} · ${BRAND}`, co, body });
}
/**
 * Beim Wechsel auf „storniert“ (unter der Bestellsperre, vor writeOrder): Stornorechnung zu einer ausgestellten Rechnung
 * anlegen — einmal je Bestellung (order.storno = { nr, at }). Ohne Rechnung (Kasse nie abgeschlossen) oder wenn schon alles
 * gutgeschrieben ist, gibt es nichts aufzuheben.
 */
async function stornoBeleg(order) {
  if (!order.invoiceNo || order.storno?.nr) return;
  if (stornoBetraege(order).betrag <= 0) {
    addHistory(order, order.status, `Keine Stornorechnung nötig: Rechnung ${order.invoiceNo} ist bereits vollständig gutgeschrieben`, 'system');
    return;
  }
  const nr = nextBelegNr('creditPrefix', 'nextCredit', DEFAULT_SETTINGS.creditPrefix);
  order.storno = { nr, at: new Date().toISOString() };
  await saveSettings();
  const file = path.join(ORDERS, order.orderId, 'storno.html');
  if (!existsSync(file)) await writeFileAtomic(file, stornoHTML(order));
  else console.warn(`⚠️  ${order.orderId}: storno.html existiert bereits – ${nr} nicht als Datei geschrieben`);
  addHistory(order, order.status, `Stornorechnung ${nr} zu Rechnung ${order.invoiceNo} ausgestellt`, 'system');
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
function loadCaptures() { try { paypalCaptures = JSON.parse(readFileSync(CAPTURES_FILE, 'utf8')) || {}; } catch { paypalCaptures = {}; } }
async function saveCaptures() {
  const ids = Object.keys(paypalCaptures);
  if (ids.length > CAPTURES_MAX) for (const id of ids.slice(0, ids.length - CAPTURES_MAX)) delete paypalCaptures[id];   // älteste zuerst (Einfügereihenfolge)
  await writeFile(CAPTURES_FILE, JSON.stringify(paypalCaptures, null, 2));
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
/** Kundendaten aus der Kasse: nur die bekannten Felder, ohne Steuerzeichen, mit Längengrenzen (Notiz darf Zeilenumbrüche haben) */
function kundeAus(raw) {
  const clip = (v, n, nl = false) => String(v ?? '').replace(nl ? /[^\S\n]+|[\x00-\x08\x0b-\x1f\x7f]+/g : /[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n);
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
  const items = data?.items;
  if (!Array.isArray(items) || !items.length) return { status: 400, error: 'Warenkorb ist leer', customer };
  if (items.length > MAX_POSITIONEN) return { status: 400, error: `Höchstens ${MAX_POSITIONEN} verschiedene Designs pro Bestellung – bitte teil deine Bestellung auf.`, customer };
  if (garantie) return { customer, items, totals: garantie.totals };
  // Produktschalter (derzeit Eierbecher) und aus dem Shop genommene Farben vor der Preisberechnung abweisen
  const sperre = produktSperre(items) || farbSperre(items);
  if (sperre) return { status: 400, error: sperre, customer };
  // Ohne die gesonderte Vereinbarung gälten die objektiven Anforderungen (§ 434 Abs. 3 BGB) — Kassen-Tabs von vor der
  // Umstellung schicken das Feld nicht und müssen neu laden
  if (data.beschaffenheit !== true) {
    return { status: 400, error: 'Bitte bestätige die Vereinbarung zu Wasser und Standfestigkeit (Häkchen in der Kasse) – fehlt das Häkchen, lade die Seite bitte neu.', customer };
  }
  const totals = computeTotals(items, data.couponCode);
  // Gutschein, der (inzwischen) nicht mehr gilt — laufende Aktion, Mindestbestellwert unterschritten, aufgebraucht: lieber abbrechen
  // als still ohne Gutschein abrechnen — der Kunde sieht die Meldung in der Kasse und kann den Code entfernen
  if (data.couponCode && totals.couponError) return { status: 400, error: totals.couponError, customer };
  const exp = data.expectedTotal === undefined || data.expectedTotal === null || data.expectedTotal === '' ? NaN : Number(data.expectedTotal);
  if (!Number.isFinite(exp)) {
    return { status: 409, code: 'preis', total: totals.total, customer, error: 'Die Kasse ist nicht mehr aktuell – bitte lade die Seite neu und prüf den Betrag.' };
  }
  if (Math.abs(exp - totals.total) > 0.005) {
    return { status: 409, code: 'preis', total: totals.total, customer, error: `Der Preis hat sich gerade geändert: Gesamt jetzt ${money(totals.total)}. Bitte prüf die Kasse und bestätige noch einmal.` };
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
    const adminTo = mailSettings(settings.mail).adminTo || String(settings.company?.email || '').trim();
    if (isEmail(adminTo)) {
      const m = adminPaypalKasse({ p: { id, amount: cap.amount, currency: cap.currency, capturedAt: cap.capturedAt, grund, erstattet: r.erstattet, fehler: r.fehler, customer: { name: kunde?.name, email: kunde?.email } }, settings, baseUrl: baseUrlFor(settings) });
      await mailer.queue({ to: adminTo, subject: m.subject, text: m.text, html: m.html, kind: 'admin-paypal', ref: id });
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
/** Eindeutiger Gutschein-Code GS-XXXX-XXXX (ohne verwechselbare Zeichen), geprüft gegen settings.coupons */
function newCouponCode() {
  const taken = new Set((settings.coupons || []).map((c) => String(c?.code || '').trim().toUpperCase()));
  for (;;) {
    let c = 'GS-';
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

// ---------------------------------------------------------------------------
// Bestellungen
// ---------------------------------------------------------------------------
async function listOrders() {
  if (!existsSync(ORDERS)) return [];
  const dirs = (await readdir(ORDERS, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
  const orders = [];
  for (const d of dirs) {
    try { orders.push(await readOrder(d)); } catch { /* unvollständig */ }
  }
  return orders;
}

async function handleCheckout(req, res) {
  let data;
  try { data = JSON.parse((await readBody(req)).toString('utf8')); } catch { data = null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { ok: false, error: 'Ungültige Anfrage' });
  const { payment, paypalOrderId } = data;
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
    return send(res, 400, { ok: false, error: `Gutschein „${gc.code}“ wurde inzwischen eingelöst – bitte prüf den Betrag in der Kasse.` });
  }
  const orderId = newOrderId();
  const createdAt = new Date().toISOString();
  if (paypalCap) untrackCouponUse(`paypal:${ppId}`);   // Reservierung aus /api/paypal/create geht auf die Bestellung über
  if (totals.coupon) trackCouponUse({ orderId, coupon: totals.coupon, status: 'neu', createdAt, paymentStatus: paypalCap ? 'bezahlt' : 'offen' });
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
      product: l.product, qty: l.qty, saucer: !!l.saucer, config: l.config,
      color: l.color, colorName: l.colorName, unit: l.unit, off: l.off, line: l.line, parts: l.parts,
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
    aktionen: totals.aktionen,   // [{ id, name, prozent, ersparnis, produkte, muster }] je betroffener Aktion (nach Ersparnis absteigend)
    aktion: totals.aktion,       // aktionen[0] | null (Kompatibilität)
    invoiceNo: null, filesComplete: false,
    trackingNo: '', adminNote: '',
  };
  await writeOrder(order);
  // accessKey: Upload und Abschluss schicken ihn als x-order-key mit (Links auf Rechnung/Modelle tragen ihn als ?k=)
  send(res, 200, { ok: true, orderId, accessKey: order.accessKey, itemCount: order.lines.length, total: order.total });
}

// Upload und Abschluss nur mit Schlüssel (x-order-key) — sonst 404 wie bei einer unbekannten Bestellung (siehe orderZugriff)
async function handleStlUpload(req, res, id, idx, url) {
  let order = null;
  try { order = await readOrder(id); } catch { order = null; }
  const z = orderZugriff(req, url, order, kasseOffen);
  if (z !== 'ok') return z === 'gesperrt' ? send(res, 429, TOO_MANY) : send(res, 404, { ok: false, error: 'Bestellung unbekannt' });
  if (order.filesComplete) return send(res, 400, { ok: false, error: 'Bestellung abgeschlossen' });
  const i = parseInt(idx, 10);
  if (!(i >= 0 && i < order.lines.length)) return send(res, 400, { ok: false, error: 'Ungültiger Index' });
  const file = path.join(ORDERS, id, order.lines[i].stlFile);
  const out = createWriteStream(file);
  let size = 0, aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_STL && !aborted) { aborted = true; out.destroy(); req.destroy(); send(res, 413, { ok: false, error: 'Datei zu groß' }); }
  });
  req.pipe(out);
  out.on('finish', () => { if (!aborted) send(res, 200, { ok: true, bytes: size }); });
  out.on('error', () => { if (!aborted) send(res, 500, { ok: false, error: 'Speicherfehler' }); });
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
    if (order.completedAt) return send(res, 200, { ok: true, invoiceUrl: orderFileUrl(order, 'rechnung.html'), invoiceNo: order.invoiceNo });
    // Guthaben: die Reservierung einer nicht abgeschlossenen Kasse gilt nur GUTHABEN_RESERVIERUNG_MS — wurde der Betrag seitdem
    // anderweitig eingelöst, wird diese Bestellung nicht mehr abgeschlossen (keine Rechnung), sondern als abgebrochen storniert
    const gc = order.coupon && order.paymentStatus !== 'bezahlt' && order.status !== 'storniert' ? couponByCode(order.coupon.code) : null;
    if (gc && isGuthaben(gc) && couponRest(gc, { ohne: order.orderId }) + 0.005 < euro(order.coupon.off)) {
      setOrderStatus(order, 'storniert', `Kasse abgebrochen: Guthaben „${gc.code}“ wurde inzwischen anderweitig eingelöst`, 'system');
      await writeOrder(order);
      return send(res, 409, { ok: false, code: 'guthaben', error: `Dein Guthaben „${gc.code}“ wurde inzwischen eingelöst – bitte starte die Kasse neu.` });
    }
    if (order.status === 'storniert') return send(res, 409, { ok: false, error: 'Diese Bestellung wurde storniert – bitte starte die Kasse neu.' });
    if (!order.invoiceNo) {
      order.invoiceNo = nextBelegNr('invoicePrefix', 'nextInvoice', DEFAULT_SETTINGS.invoicePrefix);
      await saveSettings();
    }
    order.filesComplete = order.lines.every((l) => existsSync(path.join(ORDERS, id, l.stlFile)));
    order.completedAt = new Date().toISOString();
    // Eine ausgestellte Rechnung wird nie neu geschrieben (GoBD) — ältere Bestellungen ohne completedAt behalten ihre Datei
    const invoiceFile = path.join(ORDERS, id, 'rechnung.html');
    if (!existsSync(invoiceFile)) await writeFileAtomic(invoiceFile, invoiceHTML(order));
    await writeOrder(order);
  } finally { release(); }
  console.log(`📦 Bestellung ${id} – ${order.lines.length} Position(en), ${money(order.total)}, ${order.payment} (${order.customer.name})`);
  send(res, 200, { ok: true, invoiceUrl: orderFileUrl(order, 'rechnung.html'), invoiceNo: order.invoiceNo });
  await runHook('orderCompleted', order);
}

// ---------------------------------------------------------------------------
// Admin-Seite (Login clientseitig, API mit x-admin-key)
// ---------------------------------------------------------------------------
function adminHTML() {
  return readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
}

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // URL-Parsen/Dekodieren geschützt: kaputte Prozentkodierung oder ein ungültiger Host-Header dürfen den
  // Prozess nicht beenden (400 statt unbehandelter Ausnahme). Der Host wird nirgends ausgewertet → feste Basis.
  let url, p;
  try {
    url = new URL(req.url, 'http://localhost');
    p = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, { ok: false, error: 'Ungültige URL' });
  }

  try {
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
      const { name, email, password } = JSON.parse((await readBody(req)).toString('utf8'));
      const mail = String(email || '').trim().toLowerCase();
      if (!name?.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return send(res, 400, { ok: false, error: 'Bitte Name und gültige E-Mail angeben' });
      if (String(password || '').length < 6) return send(res, 400, { ok: false, error: 'Passwort: mindestens 6 Zeichen' });
      if (users.some((u) => u.email === mail)) return send(res, 400, { ok: false, error: 'Für diese E-Mail existiert schon ein Konto – bitte anmelden' });
      const salt = crypto.randomBytes(16).toString('hex');
      const user = { id: crypto.randomUUID(), name: name.trim(), email: mail, salt, hash: hashPw(password, salt), address: null, createdAt: new Date().toISOString(), emailVerifiedAt: null };
      const verifyToken = newVerifyToken(user);   // Bestätigungslink kommt mit der Willkommensmail
      users.push(user);
      await saveUsers();
      send(res, 200, { ok: true, token: createSession(user.id), user: publicUser(user) });
      return runHook('userRegistered', { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt, verifyLink: verifyLinkFor(verifyToken) });
    }
    if (req.method === 'POST' && p === '/api/auth/login') {
      const { email, password } = JSON.parse((await readBody(req)).toString('utf8'));
      const u = users.find((x) => x.email === String(email || '').trim().toLowerCase());
      const ok = u && crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), Buffer.from(hashPw(password || '', u.salt), 'hex'));
      if (!ok) return send(res, 401, { ok: false, error: 'E-Mail oder Passwort falsch' });
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
      // IP-Limit zuerst und kurzschließend: eine gesperrte IP legt keine neuen Mail-Schlüssel mehr an
      if (forgotLimited(`ip:${clientIp(req)}`, FORGOT_IP_MAX) || forgotLimited(`mail:${mail}`)) {
        return send(res, 429, { ok: false, error: 'Zu viele Anfragen – bitte in 15 Minuten noch einmal versuchen.' });
      }
      send(res, 200, { ok: true });
      const u = users.find((x) => x.email === mail);
      if (!u) return;
      try {
        const token = crypto.randomBytes(24).toString('base64url');
        u.reset = { hash: sha256(token), exp: Date.now() + RESET_TTL };
        await saveUsers();
        const m = passwordReset({ user: { name: u.name, email: u.email }, link: `${baseUrlFor(settings)}/?reset=${token}`, settings });
        await mailer.queue({ to: { name: u.name, email: u.email }, subject: m.subject, text: m.text, html: m.html, kind: 'passwort-reset', ref: u.id });
      } catch (err) { console.error('Passwort-Reset-Mail fehlgeschlagen:', err?.message || err); }
      return;
    }
    // Neues Passwort mit Token aus der Mail; meldet alle bisherigen Sitzungen ab und startet eine neue
    if (req.method === 'POST' && p === '/api/auth/reset') {
      let body; try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch { body = {}; }
      const u = userByResetToken(body?.token);
      if (!u) return send(res, 400, { ok: false, error: 'Link ungültig oder abgelaufen' });
      if (String(body?.password || '').length < 6) return send(res, 400, { ok: false, error: 'Passwort: mindestens 6 Zeichen' });
      u.salt = crypto.randomBytes(16).toString('hex');
      u.hash = hashPw(body.password, u.salt);
      delete u.reset;
      // Der Reset-Link kam per Mail an diese Adresse → sie gehört der Person, die jetzt das Passwort setzt
      if (!u.emailVerifiedAt) u.emailVerifiedAt = new Date().toISOString();
      delete u.verify;
      for (const [t, s] of Object.entries(sessions)) if (s.userId === u.id) delete sessions[t];
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
        const m = emailBestaetigung({ user: { name: u.name, email: u.email }, link: verifyLinkFor(token), settings, baseUrl: baseUrlFor(settings) });
        await mailer.queue({ to: { name: u.name, email: u.email }, subject: m.subject, text: m.text, html: m.html, kind: 'email-bestaetigung', ref: u.id });
      } catch (err) { console.error('Bestätigungsmail fehlgeschlagen:', err?.message || err); }
      return;
    }
    if (p === '/api/auth/me') {
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
            // Stornobeleg (Rechnung aufgehoben) — Nummer immer, Link wie bei der Rechnung
            stornoNo: o.storno?.nr || '', stornoUrl: o.storno?.nr && links ? orderFileUrl(o, 'storno.html') : null,
            paidAt: o.paidAt || null, shippedAt: o.shippedAt || null,
            pieces: (o.lines || []).reduce((s, l) => s + (l.qty || 0), 0),
            reklamation: r ? {   // ohne IBAN/Grund/Notiz
              ...publicRekla(r), gutscheinCode: links ? (r.gutscheinCode || '') : '', gutscheinPerMail: !links && !!r.gutscheinCode,
              gutschriftUrl: r.gutschriftNo && links ? orderFileUrl(o, 'gutschrift.html') : null,
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
      const { street, zip, city } = JSON.parse((await readBody(req)).toString('utf8'));
      u.address = { street: street || '', zip: zip || '', city: city || '' };
      await saveUsers();
      return send(res, 200, { ok: true });
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
      const entry = await withWiderrufe((list) => {
        const w = { ref: newWiderrufRef(list), at: new Date().toISOString(), orderId: orderId || '', name, email, nachricht, orderMatched, status: 'offen', notiz: '' };
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
      console.log(`↩️  Widerruf ${entry.ref}${orderId ? ` zu ${orderId}` : ''} (${orderMatched ? 'zugeordnet' : 'nicht zugeordnet'})`);
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
      let cfg;
      try { cfg = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')).config; } catch { cfg = null; }
      if (!cfg || !['vase', 'eierbecher'].includes(cfg.product)) return send(res, 400, { ok: false, error: 'Ungültiges Design' });
      const { code, canon, isNew } = designCode(cfg);
      if (isNew) {
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
      saveDesigns();
      return send(res, 200, { ok: true, code, config: d.config });
    }

    // --- Vorschaubild eines Designs (PUT: data-URL JPEG vom Client, GET: Bild)
    const mThumb = p.match(/^\/api\/design\/([A-Za-z0-9-]{4,40})\/thumb$/);
    if (mThumb) {
      const code = normalizeCode(mThumb[1]);
      const file = path.join(THUMBS, `${code}.jpg`);
      if (req.method === 'PUT') {
        if (!designs[code]) return send(res, 404, { ok: false, error: 'Design unbekannt' });
        const raw = (await readBody(req, 120 * 1024)).toString('utf8');
        const m = raw.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return send(res, 400, { ok: false, error: 'Nur JPEG (data-URL)' });
        await mkdir(THUMBS, { recursive: true });
        await writeFile(file, Buffer.from(m[1], 'base64'));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET') {
        if (!existsSync(file)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
        return res.end(await readFile(file));
      }
    }

    // --- Design-Listen
    if (req.method === 'POST' && p === '/api/list') {
      let b; try { b = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch { b = {}; }
      const name = String(b.name || '').trim().slice(0, 60) || 'Meine Liste';
      const code = newListCode();
      const token = crypto.randomBytes(16).toString('hex');
      const l = {
        code, token, name, occasion: LIST_OCCASIONS.includes(b.occasion) ? b.occasion : 'sonstiges',
        note: String(b.note || '').slice(0, 300), items: cleanListItems(b.items),
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
      let b; try { b = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch { b = {}; }
      if (!b.token || b.token !== l.token) return send(res, 403, { ok: false, error: 'Nur der Besitzer kann diese Liste ändern.' });
      if (req.method === 'DELETE') { delete lists[code]; await saveLists(); return send(res, 200, { ok: true }); }
      if (req.method === 'PUT') {
        if (b.name !== undefined) l.name = String(b.name).trim().slice(0, 60) || l.name;
        if (b.occasion !== undefined && LIST_OCCASIONS.includes(b.occasion)) l.occasion = b.occasion;
        if (b.note !== undefined) l.note = String(b.note).slice(0, 300);
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
      const { items, couponCode } = JSON.parse((await readBody(req)).toString('utf8'));
      if (Array.isArray(items) && items.length > MAX_POSITIONEN) return send(res, 400, { ok: false, error: `Höchstens ${MAX_POSITIONEN} verschiedene Designs pro Bestellung – bitte teil deine Bestellung auf.` });
      const sperre = produktSperre(items) || farbSperre(items);
      if (sperre) return send(res, 400, { ok: false, error: sperre });
      const t = computeTotals(Array.isArray(items) ? items : [], couponCode);
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
      const t = k.totals;
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
      if (t.coupon?.guthaben) trackCouponUse({ orderId: `paypal:${j.id}`, coupon: t.coupon, status: 'neu', createdAt: at });
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
      const patch = JSON.parse((await readBody(req)).toString('utf8'));
      // Admin-Passwort: nur ein nicht-leerer String (≥ 8 Zeichen) — leer würde den Admin für alle öffnen, Nicht-Strings sperren aus
      if (patch.adminKey !== undefined) {
        if (typeof patch.adminKey !== 'string' || patch.adminKey.trim().length < 8) return send(res, 400, { ok: false, error: 'Admin-Passwort: mindestens 8 Zeichen' });
        settings.adminKey = patch.adminKey.trim();
      }
      if (patch.pricing !== undefined && (!patch.pricing || typeof patch.pricing !== 'object' || Array.isArray(patch.pricing))) {
        return send(res, 400, { ok: false, error: 'Preise: ungültiges Format' });
      }
      // Aktionen & Gutscheine vor jeder Änderung prüfen (400 mit Meldung, nichts wird übernommen)
      let aktionen;
      if (patch.aktionen !== undefined) {
        try { aktionen = sanitizeAktionen(patch.aktionen); } catch (err) { return send(res, err.httpCode || 400, { ok: false, error: err.message }); }
      }
      if (patch.coupons !== undefined && !Array.isArray(patch.coupons)) return send(res, 400, { ok: false, error: 'Gutscheine: Liste erwartet' });
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
      } catch (err) { return send(res, err.httpCode || 400, { ok: false, error: err.message }); }
      const prevPricing = settings.pricing;
      // Nur bekannte Wurzel-Schlüssel übernehmen (Gutscheine gesondert, siehe mergeCoupons)
      for (const k of ['pricing', 'colors', 'printing']) {
        if (patch[k] !== undefined) settings[k] = patch[k];
      }
      if (patch.coupons !== undefined) settings.coupons = mergeCoupons(settings.coupons, patch.coupons, patch.couponsLoeschen);
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
      if (patch.nextCredit !== undefined) settings.nextCredit = Math.max(1, Math.round(Number(patch.nextCredit)) || 1);
      // Aufpreise: Muster nur mit bekannten Keys, Zahlen ≥ 0; Farbschrift ≥ 0 — fehlen sie im Patch, bleiben die alten Werte
      if (patch.pricing !== undefined) {
        settings.pricing.muster = patch.pricing.muster !== undefined ? sanitizeMuster(patch.pricing.muster) : (prevPricing.muster || {});
        settings.pricing.farbschrift = patch.pricing.farbschrift !== undefined ? euro(patch.pricing.farbschrift) : (prevPricing.farbschrift ?? 0);
      }
      // Farbaufpreis je Farbe: Zahl ≥ 0 erzwingen
      if (Array.isArray(settings.colors)) for (const c of settings.colors) if (c && typeof c === 'object') c.aufpreis = euro(c.aufpreis);
      // PayPal: Secret-Maske wie beim SMTP-Passwort — leer = gespeichertes behalten, null = löschen
      if (patch.paypal && typeof patch.paypal === 'object') {
        const prev = settings.paypal || {};
        const next = { ...DEFAULT_SETTINGS.paypal, ...prev };
        for (const k of ['enabled', 'sandbox', 'clientId']) if (patch.paypal[k] !== undefined) next[k] = patch.paypal[k];
        if (patch.paypal.secret === null) next.secret = '';
        else if (String(patch.paypal.secret ?? '')) next.secret = String(patch.paypal.secret);
        settings.paypal = next;
      }
      settings.printing = { ...DEFAULT_SETTINGS.printing, ...(settings.printing || {}) };
      // E-Mail: nur bekannte Felder; Passwort-Maske — leer = gespeichertes behalten, null = löschen
      if (patch.mail && typeof patch.mail === 'object') {
        const prev = settings.mail || {};
        const next = { ...DEFAULT_SETTINGS.mail, ...prev };
        for (const k of MAIL_KEYS) if (patch.mail[k] !== undefined) next[k] = patch.mail[k];
        if (patch.mail.pass === null) next.pass = '';
        else if (!String(patch.mail.pass ?? '')) next.pass = prev.pass || '';
        settings.mail = mailSettings(next);
      } else settings.mail = { ...DEFAULT_SETTINGS.mail, ...(settings.mail || {}) };
      await saveSettings();
      // Preise, Farbaufpreise oder Aktionen geändert → Momentaufnahme für den 30-Tage-Tiefstpreis (§ 11 PAngV)
      await notePreisHistorie().catch((err) => console.error('Preis-Historie konnte nicht gespeichert werden:', err?.message || err));
      // hinweis: nicht übernommene Angaben (z. B. Präfix aus einem Tab von vor dem Jahreswechsel) — der Admin zeigt ihn an
      const hinweis = [invoicePrefix.hinweis, creditPrefix.hinweis].filter(Boolean).join(' ');
      // coupons: gespeicherter Stand (inkl. Guthaben-Codes, die der Tab noch nicht kannte) — der Admin übernimmt ihn
      return send(res, 200, { ok: true, coupons: settings.coupons, couponRest: guthabenRest(), ...(hinweis ? { hinweis } : {}) });
    }
    if (req.method === 'POST' && p === '/api/admin/order-update') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
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
          if (order.status === 'storniert' && prevStatus !== 'storniert') await stornoBeleg(order);
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
      const { orderId, idx, status, note } = JSON.parse((await readBody(req)).toString('utf8'));
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
            if (art === 'paypal' && !(order.payment === 'paypal' && order.paypalOrderId)) return bad('Erstattung per PayPal geht nur bei Bestellungen, die per PayPal bezahlt wurden');
            const total = euro(order.total);
            let betrag = total;
            if (body.betrag !== undefined && body.betrag !== null && body.betrag !== '') {
              const n = Number(body.betrag);
              if (!Number.isFinite(n) || n < 0 || n > total + 1e-9) return bad(`Betrag muss zwischen 0 und ${money(total)} (Bestellsumme) liegen`);
              betrag = Math.round(n * 100) / 100;
            }
            if (art !== 'nachdruck' && betrag <= 0) return bad('Für eine Gutschrift/Erstattung muss der Betrag größer als 0 sein');
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
              if (!r.gutschriftNo) r.gutschriftNo = nextBelegNr('creditPrefix', 'nextCredit', DEFAULT_SETTINGS.creditPrefix);
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
      const rows = [['Bestellung', 'Datum', 'Status', 'Zahlart', 'Rechnung', 'Name', 'E-Mail', 'Straße', 'PLZ', 'Ort', 'Positionen', 'Gutschein', 'Aktion', 'Summe', 'Tracking', 'Versender', 'Bezahlt am', 'Versendet am', 'Reklamation'].join(';')];
      for (const o of orders) {
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
        ].join(';'));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="formsam-bestellungen.csv"' });
      return res.end('﻿' + rows.join('\n'));
    }
    // Kompatibel: alter Kurz-Endpoint (nur Status)
    if (req.method === 'POST' && p === '/api/admin/order-status') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const { orderId, status } = JSON.parse((await readBody(req)).toString('utf8'));
      if (!orderIdOk(orderId)) return send(res, 400, { ok: false, error: 'Ungültige Bestellnummer' });
      if (!STATUSES.includes(status)) return send(res, 400, { ok: false, error: 'Ungültiger Status' });
      let order, prevStatus;
      const release = await lockOrder(orderId);
      try {
        try { order = await readOrder(orderId); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
        prevStatus = order.status;
        setOrderStatus(order, status, null, 'admin');
        if (order.status === 'storniert' && prevStatus !== 'storniert') await stornoBeleg(order);
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
        const body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8'));
        if (!orderIdOk(body.orderId)) return send(res, 400, { ok: false, error: 'Ungültige Bestellnummer' });
        let order;
        try { order = await readOrder(body.orderId); } catch { return send(res, 404, { ok: false, error: 'Bestellung unbekannt' }); }
        // Bestätigung erneut: wieder mit AGB + Widerrufsbelehrung als Anhang (Vorschau nennt sie nur)
        const attachments = body.kind === 'bestaetigung' ? await legalAttachments() : [];
        const m = renderOrderMail(order, { ...body, anhaenge: attachments.map((a) => a.filename) });
        const cust = customerAddress(order);
        if (p === '/api/admin/mail-preview') return send(res, 200, { ok: true, subject: m.subject, html: m.html, text: m.text, to: cust.email, kind: m.kind });
        if (!isEmail(cust.email)) return send(res, 400, { ok: false, error: 'Die Bestellung hat keine gültige Kunden-E-Mail' });
        const r = await mailer.send({ to: cust, subject: m.subject, text: m.text, html: m.html, attachments, kind: m.kind, ref: order.orderId });
        if (r.ok && m.key) await noteMailSent(order, m.key, m.subject, cust.email);
        if (!r.ok && /nicht eingerichtet/.test(r.error || '')) r.error += ' – die Nachricht liegt im Versandprotokoll und kann nach der Einrichtung erneut gesendet werden';
        return send(res, 200, { ok: !!r.ok, id: r.id, error: r.error || '' });
      } catch (err) {
        return send(res, err.httpCode || 500, { ok: false, error: err.message || 'Serverfehler' });
      }
    }
    if (req.method === 'POST' && p === '/api/admin/mail-test') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
        const to = String(body.to || '').trim();
        if (to && !isEmail(to)) return send(res, 400, { ok: false, error: 'Ungültige Empfängeradresse', log: [] });
        const override = {};
        if (body.settings && typeof body.settings === 'object') for (const k of MAIL_KEYS) if (body.settings[k] !== undefined) override[k] = body.settings[k];
        const r = await mailer.test(override, to);
        return send(res, 200, { ok: !!r.ok, error: r.error || '', log: r.log || [] });
      } catch (err) {
        return send(res, 500, { ok: false, error: err.message || 'Serverfehler', log: [] });
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
    if (req.method === 'POST' && p === '/api/admin/mail-resend') {
      if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'Nicht angemeldet' });
      try {
        const { id } = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
        if (typeof id !== 'string' || !/^[a-z0-9]{6,40}$/.test(id)) return send(res, 400, { ok: false, error: 'Ungültige Protokoll-ID' });
        const r = await mailer.resend(id);
        return send(res, 200, { ok: !!r.ok, error: r.error || '' });
      } catch (err) {
        return send(res, 500, { ok: false, error: err.message || 'Serverfehler' });
      }
    }
    // Druckzettel (Seite, A4) — Key per Header oder ?k=
    const mZettel = p.match(/^\/admin\/druckzettel\/([A-Z0-9-]+)$/);
    if (req.method === 'GET' && mZettel) {
      if (!isAdmin(req) && !adminKeyMatches(url.searchParams.get('k'))) return send(res, 401, 'Nicht angemeldet – bitte über den Admin-Bereich öffnen.', 'text/plain; charset=utf-8');
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

    // --- Seiten & Dateien
    if (p === '/favicon.ico') {
      const ico = path.join(PUBLIC, 'favicon.ico');
      if (!existsSync(ico)) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME['.ico'], 'Cache-Control': 'public, max-age=86400' });
      return createReadStream(ico).pipe(res);
    }
    if (p === '/admin' || p === '/admin/') return send(res, 200, adminHTML(), 'text/html; charset=utf-8');

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

    // Statische Dateien — mit Browser-Cache & gzip für Text-Assets
    let file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { ok: false, error: 'Verboten' });
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
    const ext = path.extname(file);
    const stat = statSync(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // vendor/fonts/env ändern sich praktisch nie → lange cachen;
    // eigene HTML/JS/CSS mit Revalidierung (ETag aus mtime+Größe)
    const isAsset = p.startsWith('/vendor/') || p.startsWith('/fonts/') || p.startsWith('/env/') || p.startsWith('/img/gallery/');
    headers['Cache-Control'] = isAsset ? 'public, max-age=2592000, immutable' : 'no-cache';
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const compressible = ['.html', '.css', '.js', '.json', '.svg'].includes(ext);
    if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && stat.size > 1024) {
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
      res.writeHead(200, headers);
      return createReadStream(file).pipe(createGzip({ level: zc.Z_BEST_SPEED })).pipe(res);
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    send(res, 500, { ok: false, error: 'Serverfehler' });
  }
});

loadSettings();
loadPreisHistorie();
notePreisHistorie().catch((err) => console.error('Preis-Historie konnte nicht gespeichert werden:', err?.message || err));
loadDesigns();
loadLists();
loadUsers();
loadCaptures();
// Sicherheitsnetz: ein einzelner Fehler außerhalb der try/catch-Pfade darf den Shop nicht beenden
process.on('unhandledRejection', (err) => console.error('Unbehandelte Promise-Ablehnung:', err));
process.on('uncaughtException', (err) => console.error('Unbehandelte Ausnahme:', err));
// Erst Guthaben-Einlösungen und vergebene Belegnummern aus den Bestellungen lesen, dann Anfragen annehmen — sonst könnte eine
// Bestellung direkt nach dem Start ein schon verbrauchtes Guthaben einlösen oder eine vergebene Nummer bekommen
loadCouponUse().catch((err) => console.error('Gutschein-Einlösungen/Belegnummern konnten nicht gelesen werden:', err?.message || err)).then(() => server.listen(PORT, '0.0.0.0', () => {
  console.log(`formsam Shop läuft → http://0.0.0.0:${PORT}  (Admin: /admin)`);
  // Rechtsseiten früh laden, damit ein fehlendes/fehlerhaftes lib/legal.js gleich im Log steht (die Routen versuchen es erneut)
  legalModule().then((m) => {
    if (!m) return;
    console.log('Rechtsseiten: lib/legal.js geladen');
    try { for (const h of m.legalWarnings?.(settings) || []) console.warn(`⚠️  Rechtsseiten: ${h}`); } catch { /* nur Hinweise */ }
  });
  // Outbox laden: wartende Zustellungen aus der Zeit vor dem Neustart sofort weiterverarbeiten
  mailer.resume().catch((e) => console.error('✉️  Outbox konnte nicht geladen werden:', e?.message || e));
}));
