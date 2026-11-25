// formsam — Kundenkonto: Registrieren, Anmelden, Passwort vergessen/zurücksetzen, Bestellhistorie, Standard-Adresse
import { getPricing } from './pricing.js';
const $ = (s) => document.querySelector(s);

let currentUser = null;
let myOrders = [];
let meStand = 0;   // Zeitpunkt des letzten erfolgreichen refreshMe() (openAccount lädt nur nach, wenn der Stand älter ist)
let resetToken = '';   // aus ?reset=TOKEN (Link aus der „Passwort vergessen“-Mail)
let verifyToken = '';  // aus ?verify=TOKEN (Link aus der Willkommens-/Bestätigungsmail) — gilt nur zusammen mit der Anmeldung

const token = () => localStorage.getItem('ovju-auth') || '';
export const getAuthHeaders = () => token() ? { 'x-auth': token() } : {};

// E-Mail-Adresse für Kasse und Registrierung: vor dem @ nur ASCII, wie der Server (lib/eingaben.js EMAIL_LOKAL_FEHLER — Text
// wörtlich gleich, tools/test-eingaben.mjs prüft das). Umlaute in der Domain sind erlaubt.
export const EMAIL_LOKAL_FEHLER = 'Vor dem @ gehen leider keine Umlaute, kein ß und keine anderen Sonderzeichen – solche Adressen erreichen meine E-Mails nicht zuverlässig. Bitte gib eine E-Mail-Adresse ohne sie an (in der Domain nach dem @ sind Umlaute in Ordnung).';
export function emailLokalFehler(v) {
  const s = String(v ?? '').trim().slice(0, 255);
  const at = s.lastIndexOf('@');
  return at > 0 && /[^\x21-\x7e]/.test(s.slice(0, at)) ? EMAIL_LOKAL_FEHLER : '';
}
/** Feld mit der Browser-Prüfung verbinden: die Meldung erscheint wie „Pflichtfeld“ direkt am Feld (setCustomValidity) */
export function emailFeldPruefen(input) {
  if (!input) return;
  const pruefen = () => input.setCustomValidity(emailLokalFehler(input.value));
  input.addEventListener('input', pruefen);
  input.addEventListener('change', pruefen);
  pruefen();
}
export const getUser = () => currentUser;

/**
 * Postleitzahl (Kasse und Konto-Adresse) → '' oder Meldung — Spiegel von plzFehler() in server.js (derselbe Wortlaut). Liefergebiet
 * nur Deutschland (/api/pricing → shop.liefergebiet, Standard): genau 5 Ziffern (nicht mit 00), bei 4 Ziffern der Hinweis auf die führende 0;
 * steht dort mehr (z. B. „Deutschland und Österreich“), auch 4 Ziffern.
 */
const nurDeutschland = () => /^deutschland$/i.test(String(getPricing()?.shop?.liefergebiet || '').trim() || 'Deutschland');
export function plzFehler(zip) {
  const v = String(zip ?? '').trim();
  const de = nurDeutschland();
  if (de ? /^(?!00)[0-9]{5}$/.test(v) : /^[0-9]{4,5}$/.test(v)) return '';   // deutsche PLZ beginnen nie mit 00
  if (de && /^[0-9]{4}$/.test(v)) return 'Postleitzahlen in Deutschland haben 5 Ziffern – fehlt vorne eine 0 (z. B. 01067)?';
  return de ? 'Bitte gib deine Postleitzahl mit 5 Ziffern an – ich liefere nach Deutschland.' : 'Bitte gib eine gültige Postleitzahl an (4 oder 5 Ziffern).';
}
/** PLZ-Feld nach dem Liefergebiet einstellen (pattern, title) und seine Meldung setzen — leer bleibt Sache von required */
export function plzFeldPruefen(input) {
  if (!input) return;
  input.pattern = nurDeutschland() ? '[0-9]{5}' : '[0-9]{4,5}';
  input.title = nurDeutschland() ? 'Postleitzahl mit 5 Ziffern (Lieferung nach Deutschland)' : 'Postleitzahl mit 4 oder 5 Ziffern';
  input.setCustomValidity(input.value.trim() ? plzFehler(input.value) : '');
}

const STATUS_LABEL = {
  neu: '⏳ eingegangen', bezahlt: '💶 bezahlt', 'im-druck': '🖨️ im Druck', gedruckt: '✅ gedruckt',
  versendet: '📦 versendet', abgeschlossen: '🎉 abgeschlossen', storniert: '✖️ storniert',
};
// Paketverfolgung je Versender (Spiegel von lib/mail-templates.js — das Server-Modul ist im Browser nicht ladbar)
const CARRIER_LABEL = { dhl: 'DHL', hermes: 'Hermes', dpd: 'DPD', gls: 'GLS', post: 'Deutsche Post', sonstige: '' };
const TRACKING_URL = {
  dhl: (n) => `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${encodeURIComponent(n)}`,
  hermes: (n) => `https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#${encodeURIComponent(n)}`,
  dpd: (n) => `https://tracking.dpd.de/status/de_DE/parcel/${encodeURIComponent(n)}`,
  gls: (n) => `https://gls-group.eu/DE/de/paketverfolgung?match=${encodeURIComponent(n)}`,
  post: (n) => `https://www.deutschepost.de/de/s/sendungsverfolgung.html?piececode=${encodeURIComponent(n)}`,
};
// Reklamation (Spiegel von REKLA_STATUS/REKLA_ART in lib/mail-templates.js) — /api/auth/me liefert je Bestellung
// reklamation { status, art, betrag, gutscheinCode, gutschriftNo, createdAt, resolvedAt } oder null
const REKLA_STATUS = { offen: 'Reklamation offen', ruecksendung: 'Rücksendung erwartet', eingegangen: 'Ware eingegangen', erledigt: 'Erledigt', abgelehnt: 'Abgelehnt' };
const REKLA_ART = { nachdruck: 'Nachdruck', gutschein: 'Gutschrift als Gutschein-Code', ueberweisung: 'Erstattung per Überweisung', paypal: 'Erstattung per PayPal' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '');
/** Sendungsnummer mit Link zur Paketverfolgung (wenn der Versender bekannt ist) */
function trackingHtml(o) {
  const n = String(o.trackingNo || '').trim();
  if (!n) return '';
  const label = CARRIER_LABEL[o.carrier] || '';
  const url = TRACKING_URL[o.carrier]?.(n);
  return url
    ? `<small><a href="${esc(url)}" target="_blank" rel="noopener">📮 ${esc(label)} ${esc(n)} → verfolgen</a></small>`
    : `<small>📮 ${label ? esc(label) + ' ' : ''}${esc(n)}</small>`;
}
/**
 * Rechnungslink — die Adresse kommt fertig vom Server (mit Zugriffsschlüssel ?k=). Fehlt sie (Gastbestellung, die nur über
 * die E-Mail-Adresse zugeordnet ist), steht der Link in der Bestellbestätigung.
 */
function invoiceHtml(o) {
  if (!o.invoiceNo) return '';
  // PDF-Fassung (Server ab Dezember 2026; ältere Antworten ohne …PdfUrl zeigen nur den HTML-Beleg)
  // je Beleg eine Zeile (span = ein Eintrag der rechten Spalte): „🧾 Rechnung · PDF“
  const pdf = (u, was) => (u ? ` · <a href="${esc(u)}" target="_blank" rel="noopener" title="${was} als PDF">PDF</a>` : '');
  const rechnung = o.invoiceUrl
    ? `<span><a href="${esc(o.invoiceUrl)}" target="_blank" rel="noopener">🧾 Rechnung</a>${pdf(o.invoicePdfUrl, 'Rechnung')}</span>`
    : `<small title="Den Link zu deiner Rechnung ${esc(o.invoiceNo)} findest du in deiner Bestellbestätigung per E-Mail (Knopf „Rechnung ansehen“)">🧾 Rechnung per Mail</small>`;   // kurz: passt in die Zeile, Erklärung im title
  // Storniert mit ausgestellter Rechnung: Stornorechnung (Link wie bei der Rechnung, sonst nur die Nummer)
  const storno = !o.stornoNo ? ''
    : o.stornoUrl ? ` <span><a href="${esc(o.stornoUrl)}" target="_blank" rel="noopener">↩ Storno</a>${pdf(o.stornoPdfUrl, 'Stornorechnung')}</span>` : ` <small>↩ Storno ${esc(o.stornoNo)}</small>`;
  return rechnung + storno;
}
/** Zeile „↩️ Reklamation: Status · Art · Betrag“ — bei erledigtem Gutschein der Code (zum Kopieren), Link zur Gutschrift */
function reklaHtml(o) {
  const r = o.reklamation;
  if (!r || !r.status) return '';
  const parts = [REKLA_STATUS[r.status] || r.status, REKLA_ART[r.art] || r.art];
  if (r.art !== 'nachdruck' && r.betrag > 0) parts.push(money(r.betrag));
  // Link kommt fertig vom Server (mit Zugriffsschlüssel ?k=); ohne Link nur die Nummer — der Link steht dann in der Mail
  const link = !r.gutschriftNo ? ''
    : r.gutschriftUrl ? ` · <a href="${esc(r.gutschriftUrl)}" target="_blank" rel="noopener">🧾 Gutschrift ${esc(r.gutschriftNo)}</a>${r.gutschriftPdfUrl ? ` · <a href="${esc(r.gutschriftPdfUrl)}" target="_blank" rel="noopener" title="Gutschrift als PDF">PDF</a>` : ''}`
      : ` · 🧾 Gutschrift ${esc(r.gutschriftNo)} <small>(Link in meiner Mail an dich)</small>`;
  // Code nur bei Bestellungen dieses Kontos — bei Bestellungen, die über die E-Mail-Adresse zugeordnet sind, steht er in meiner Mail
  const code = r.status === 'erledigt' && r.art === 'gutschein' && r.gutscheinCode
    ? `<div class="ao-code" style="margin-top:4px">🎟️ Dein Gutschein-Code: <code style="font-size:.92rem;letter-spacing:.06em;font-weight:700;user-select:all">${esc(r.gutscheinCode)}</code> <small>– markieren, kopieren und bei deiner nächsten Bestellung in der Kasse im Feld „Gutscheincode“ einlösen</small></div>`
    : r.status === 'erledigt' && r.art === 'gutschein' && r.gutscheinPerMail ? '<div class="ao-code" style="margin-top:4px"><small>🎟️ Den Gutschein-Code findest du in meiner Mail an dich.</small></div>' : '';
  return `<div class="ao-rekla" style="flex-basis:100%;font-size:.76rem;line-height:1.45;color:var(--ink-soft)">↩️ Reklamation: ${parts.map(esc).join(' · ')}${link}${code}</div>`;
}
/**
 * Link „Vertrag widerrufen“ je Bestellung → Widerrufsfunktion auf /widerruf (Abschnitt #widerrufen) mit vorbefüllter Bestellnummer.
 * Die Nummer steht als ?order=… (lib/legal.js liest ?order= und ?bestellung=).
 * Stornierte Bestellungen brauchen keinen Widerruf mehr.
 */
function widerrufHtml(o) {
  if (o.status === 'storniert') return '';
  const id = encodeURIComponent(o.orderId);
  return `<a class="ao-widerruf" href="/widerruf?order=${id}#widerrufen" target="_blank" rel="noopener">Vertrag widerrufen</a>`;
}
/** Eingegangene Widerrufe zur Bestellung (/api/auth/me → widerrufe [{ ref, at }]) — „Ist mein Widerruf angekommen?“ */
function widerrufEingangHtml(o) {
  const w = Array.isArray(o.widerrufe) ? o.widerrufe : [];
  if (!w.length) return '';
  const datum = (iso) => (iso ? new Date(iso).toLocaleDateString('de-DE') : '');
  return `<div class="ao-widerruf-eingang" style="flex-basis:100%;font-size:.76rem;line-height:1.45;color:var(--ink-soft)">↩️ ${w.length > 1 ? 'Widerrufe' : 'Widerruf'} eingegangen: ` +
    w.map((x) => `${esc(datum(x.at))} (${esc(x.ref)})`).join(', ') + '</div>';
}
/** Die letzten Schritte der Bestellung (Historie vom Server: at/status/note), kompakt in einer Zeile */
function stepsHtml(o) {
  const steps = (o.history || []).slice(-3);
  if (!steps.length) return '';
  return `<div class="ao-steps" style="flex-basis:100%;font-size:.74rem;line-height:1.4;color:var(--ink-soft)">` +
    steps.map((h) => `${fmtDay(h.at)} ${esc(h.note || STATUS_LABEL[h.status] || h.status || '')}`).join(' · ') + '</div>';
}

function renderButton() {
  const btn = $('#account-btn');
  // Name kommt vom Konto (frei eingegeben) → maskiert; ältere Konten können noch < > im Namen haben
  btn.innerHTML = `👤 <span class="ab-txt">${esc(currentUser ? String(currentUser.name || '').trim().split(/\s+/)[0] : 'Anmelden')}</span>`;
  btn.classList.toggle('logged-in', !!currentUser);
}

async function refreshMe() {
  if (!token()) { currentUser = null; renderButton(); return; }
  try {
    const r = await (await fetch('/api/auth/me', { headers: getAuthHeaders() })).json();
    if (r.ok) { currentUser = r.user; myOrders = r.orders; meStand = Date.now(); }
    else { localStorage.removeItem('ovju-auth'); currentUser = null; }
  } catch { /* offline etc. */ }
  renderButton();
}

// ---------------------------------------------------------------------------
// Auth-Modal (Login / Registrieren / Passwort vergessen / neues Passwort)
// ---------------------------------------------------------------------------
const AUTH_TITLE = { login: 'Mein Konto', register: 'Mein Konto', forgot: 'Passwort vergessen', reset: 'Neues Passwort' };

function showAuthTab(tab) {
  for (const t of ['login', 'register', 'forgot', 'reset']) $(`#auth-${t}`).hidden = tab !== t;
  $('#auth-tabs').hidden = tab === 'reset';
  $('#at-login').classList.toggle('active', tab === 'login');
  $('#at-register').classList.toggle('active', tab === 'register');
  $('#auth-title').textContent = AUTH_TITLE[tab] || 'Mein Konto';
  showErr(''); showInfo('');
}
function showErr(msg) { $('#auth-err').textContent = msg || ''; }
function showInfo(msg) { const el = $('#auth-info'); el.textContent = msg || ''; el.hidden = !msg; }

/** POST mit JSON-Antwort — liefert bei 404/Netzfehler/kaputter Antwort immer { ok:false, error } */
async function api(path, body, fallback = 'Das hat gerade nicht geklappt – bitte später noch einmal versuchen.') {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const r = await res.json().catch(() => null);
    if (r && typeof r.ok === 'boolean') return r.ok ? r : { ok: false, error: r.error || fallback };
    return { ok: false, error: fallback };
  } catch {
    return { ok: false, error: 'Keine Verbindung zum Shop – bitte Internetverbindung prüfen.' };
  }
}

/** Session übernehmen (Antwort von login/register/reset: { ok, token, user }) */
async function startSession(r) {
  localStorage.setItem('ovju-auth', r.token);
  await refreshMe();
  $('#auth-modal').close();
  if (verifyToken) await confirmEmail();
  openAccount();
}

// --- E-Mail-Adresse bestätigen: Link ?verify=TOKEN — der Server nimmt ihn nur zusammen mit der Anmeldung in genau diesem Konto
/** Hinweis im Konto (über den Bestellungen): unbestätigt → Bitte + „Link erneut senden“; Ergebnis einer Bestätigung */
let verifyMsg = '';
let ohneWillkommen = false;   // Registrierung ohne Willkommensmail (Server: ohneMail) — Link über „Link erneut senden“
function verifyBox() {
  let box = $('#acc-verify');
  if (!box) {
    box = document.createElement('div');
    box.id = 'acc-verify';
    box.className = 'tiny';
    box.style.cssText = 'text-align:left;margin:6px 0 10px;padding:10px 12px;border-radius:12px;background:var(--bg-soft, rgba(200,111,74,.08))';
    $('#acc-email').after(box);
  }
  const offen = currentUser && !currentUser.emailVerified;
  box.hidden = !offen && !verifyMsg;
  box.innerHTML = offen
    ? `✉️ <b>Bitte bestätige deine E-Mail-Adresse.</b> Erst danach zeige ich dir hier auch Bestellungen, die du ohne Anmeldung mit dieser Adresse aufgegeben hast.${ohneWillkommen ? '' : ' Den Link hast du nach der Registrierung per E-Mail bekommen.'}
       <br><button type="button" class="linkbtn" id="acc-verify-send">Link erneut senden</button> <span id="acc-verify-msg">${esc(verifyMsg)}</span>`
    : esc(verifyMsg);
  $('#acc-verify-send')?.addEventListener('click', resendVerify);
}
async function resendVerify() {
  const btn = $('#acc-verify-send');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/auth/verify-resend', { method: 'POST', headers: getAuthHeaders() });
    const r = await res.json().catch(() => ({}));
    verifyMsg = r.ok ? (r.schon ? '✅ Deine Adresse ist schon bestätigt.' : '📬 Unterwegs – bitte auch im Spam-Ordner nachsehen.') : (r.error || 'Das hat gerade nicht geklappt.');
    if (r.ok && r.schon) await refreshMe();
  } catch { verifyMsg = 'Keine Verbindung zum Shop.'; }
  verifyBox();
}
/** Gemerkten Bestätigungslink einlösen (angemeldet) → Konto neu laden */
async function confirmEmail() {
  const t = verifyToken;
  verifyToken = '';
  clearParam('verify');
  try {
    const res = await fetch('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify({ token: t }) });
    const r = await res.json().catch(() => ({}));
    verifyMsg = r.ok ? '✅ Danke – deine E-Mail-Adresse ist bestätigt.' : `⚠️ ${r.error || 'Der Bestätigungslink hat nicht geklappt.'}`;
  } catch { verifyMsg = '⚠️ Keine Verbindung zum Shop – bitte öffne den Link gleich noch einmal.'; }
  await refreshMe();
}

async function doAuth(path, body) {
  showErr('');
  const r = await api(path, body);
  if (!r.ok) { showErr(r.error); return; }
  // Konto angelegt, Willkommensmail aber gerade gedeckelt (viele Registrierungen): Link im Konto anfordern
  if (r.ohneMail) { ohneWillkommen = true; verifyMsg = 'Die Mail mit dem Bestätigungslink konnte ich gerade nicht verschicken – fordere sie bitte mit „Link erneut senden“ an.'; }
  await startSession(r);
}

// --- Passwort vergessen: Link anfordern
async function requestReset() {
  showErr(''); showInfo('');
  const btn = $('#af-submit');
  btn.disabled = true;
  const r = await api('/api/auth/forgot', { email: $('#af-email').value.trim() },
    'Passwort-Zurücksetzen ist gerade nicht verfügbar – schreib mir einfach kurz eine E-Mail.');
  btn.disabled = false;
  if (!r.ok) { showErr(r.error); return; }
  $('#auth-forgot').hidden = true;
  showInfo('📬 Falls ein Konto mit dieser E-Mail existiert, ist eine E-Mail mit dem Link unterwegs (60 Minuten gültig) – bitte auch im Spam-Ordner nachsehen.');
}

// --- Neues Passwort setzen (Token aus der E-Mail)
async function submitReset() {
  showErr('');
  const pw = $('#ap-pw').value, pw2 = $('#ap-pw2').value;
  if (pw.length < 8) { showErr('Passwort: mindestens 8 Zeichen'); return; }
  if (pw !== pw2) { showErr('Die beiden Passwörter stimmen nicht überein'); return; }
  const btn = $('#ap-submit');
  btn.disabled = true;
  const r = await api('/api/auth/reset', { token: resetToken, password: pw },
    'Der Link ist ungültig oder abgelaufen – bitte fordere einen neuen an.');
  btn.disabled = false;
  if (!r.ok) { clearResetParam(); showErr(r.error); return; } // Token bleibt im Speicher (erneuter Versuch), URL nicht
  clearResetParam();
  resetToken = '';
  $('#ap-pw').value = ''; $('#ap-pw2').value = '';
  await startSession(r);
}

/** ?reset=TOKEN bzw. ?verify=TOKEN aus der Adresszeile entfernen (ohne Neuladen) */
function clearParam(name) {
  const u = new URL(location.href);
  if (!u.searchParams.has(name)) return;
  u.searchParams.delete(name);
  history.replaceState(null, '', u.pathname + u.search + u.hash);
}
const clearResetParam = () => clearParam('reset');

// ---------------------------------------------------------------------------
// Konto-Modal
// ---------------------------------------------------------------------------
function money(v) {
  return (v ?? 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

export function openAccount() {
  if (!currentUser) { showAuthTab('login'); $('#auth-modal').showModal(); return; }
  $('#acc-greeting').textContent = `Hallo, ${currentUser.name}! 👋`;
  const a = currentUser.address || {};
  $('#acc-street').value = a.street || '';
  $('#acc-zip').value = a.zip || '';
  $('#acc-city').value = a.city || '';
  addrMsg('');
  plzFeldPruefen($('#acc-zip'));
  sicherZuruecksetzen();
  renderAccountOrders();
  $('#account-modal').showModal();
  // Bestellungen von einem anderen Gerät/Tab: gleich mit dem gemerkten Stand öffnen, frisch vom Server nachziehen
  if (Date.now() - meStand > 3000) {
    refreshMe().then(() => { if (currentUser && $('#account-modal').open) renderAccountOrders(); });
  }
}
/** E-Mail-Zeile, Bestätigungs-Hinweis und Bestellungen im Konto (Adressfelder bleiben, wie sie gerade bearbeitet werden) */
function renderAccountOrders() {
  $('#acc-email').textContent = currentUser.email + (currentUser.emailVerified ? ' ✓' : '');
  verifyBox();
  $('#acc-orders').innerHTML = myOrders.length ? myOrders.map((o) => `
    <div class="acc-order" style="flex-wrap:wrap">
      <div><b>${esc(o.orderId)}</b><br><small>${new Date(o.createdAt).toLocaleDateString('de-DE')} · ${o.pieces} Stück</small></div>
      <div class="ao-mid"><span class="ao-status">${STATUS_LABEL[o.status] || esc(o.status)}</span>
        ${trackingHtml(o)}</div>
      <div class="ao-right"><b>${o.total ? money(o.total) : '—'}</b>
        ${invoiceHtml(o)}
        ${widerrufHtml(o)}</div>
      ${stepsHtml(o)}
      ${widerrufEingangHtml(o)}
      ${reklaHtml(o)}
    </div>`).join('')
    : `<p class="tiny" style="text-align:left">${currentUser.emailVerified ? 'Noch keine Bestellungen – dein erstes Unikat wartet im Konfigurator! 🎨' : 'Noch keine Bestellungen mit diesem Konto. Hast du ohne Anmeldung bestellt? Dann bestätige oben deine E-Mail-Adresse.'}</p>`;
}

let addrMsgTimer = 0;
/**
 * Rückmeldung zur Adresse: kurze Zustände („Speichere …“, „✅ Gespeichert“ — verschwindet nach 2,5 s) neben dem Knopf, Fehler (⚠️)
 * in einer eigenen Zeile darüber (#acc-addr-err; fehlt sie in einer älteren index.html, ebenfalls neben dem Knopf)
 */
function addrMsg(text, ok = false) {
  clearTimeout(addrMsgTimer);   // ein älteres „Gespeichert“ darf eine neue Meldung nicht wegräumen
  const inline = $('#acc-addr-msg'), err = $('#acc-addr-err');
  const fehler = !!text && text.startsWith('⚠️') && err;
  inline.textContent = fehler ? '' : (text || '');
  if (err) { err.textContent = fehler ? text : ''; err.hidden = !fehler; }
  if (ok) addrMsgTimer = setTimeout(() => { inline.textContent = ''; }, 2500);
}
async function saveAddress() {
  const felder = { street: $('#acc-street'), zip: $('#acc-zip'), city: $('#acc-city') };
  const address = Object.fromEntries(Object.entries(felder).map(([k, f]) => [k, f.value.trim()]));
  // Wie die Kasse (sie übernimmt die Adresse): alle drei Felder oder keines (= Adresse entfernen), PLZ nach dem Liefergebiet
  plzFeldPruefen(felder.zip);
  const leer = Object.entries(address).find(([, v]) => !v);
  if (leer && Object.values(address).some(Boolean)) {
    addrMsg('⚠️ Bitte Straße, PLZ und Ort vollständig angeben – oder alle drei Felder leeren, um die Adresse zu entfernen.');
    felder[leer[0]].focus();
    return;
  }
  if (!felder.zip.checkValidity()) { addrMsg(`⚠️ ${felder.zip.validationMessage}`); felder.zip.reportValidity(); return; }
  const btn = $('#acc-addr-save');
  btn.disabled = true;
  addrMsg('Speichere …');
  let r = null, status = 0;
  try {
    const res = await fetch('/api/auth/address', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(address),
    });
    status = res.status;
    r = await res.json().catch(() => null);
  } catch { r = { ok: false, error: 'Keine Verbindung zum Shop – bitte Internetverbindung prüfen. Die Adresse ist noch nicht gespeichert.' }; }
  btn.disabled = false;
  // Anmeldung abgelaufen (z. B. auf einem anderen Gerät überall abgemeldet): neu anmelden, dann noch einmal speichern
  if (status === 401) {
    addrMsg('');
    abgemeldet();
    showAuthTab('login');
    showInfo('Deine Anmeldung ist abgelaufen – bitte melde dich neu an und speichere deine Adresse dann noch einmal.');
    $('#auth-modal').showModal();
    return;
  }
  // Server prüft wie hier (Längen, vollständig, PLZ) — seine Meldung statt „Gespeichert“; gespeichert wird lokal erst danach
  if (!r?.ok) {
    addrMsg(`⚠️ ${r?.error || 'Das hat gerade nicht geklappt – die Adresse ist noch nicht gespeichert.'}`);
    if (felder[r?.feld]) felder[r.feld].focus();
    return;
  }
  currentUser.address = address;
  addrMsg(Object.values(address).some(Boolean) ? '✅ Gespeichert' : '✅ Adresse entfernt', true);
}

/**
 * Abmelden: die Kasse leert daraufhin, was sie aus dem Konto vorbefüllt hat (Ereignis ovju:abgemeldet mit den bisherigen
 * Kontodaten — cart.js vergleicht und lässt selbst Getipptes stehen)
 */
function meldeAbgemeldet(u) {
  if (u) window.dispatchEvent(new CustomEvent('ovju:abgemeldet', { detail: { name: u.name, email: u.email, address: u.address || null } }));
}
async function logout() {
  const u = currentUser;
  try { await fetch('/api/auth/logout', { method: 'POST', headers: getAuthHeaders() }); } catch { /* offline: lokal trotzdem abmelden */ }
  localStorage.removeItem('ovju-auth');
  currentUser = null; myOrders = [];
  renderButton();
  $('#account-modal').close();
  meldeAbgemeldet(u);
}

// --- Passwort & Konto (Konto-Dialog): Passwort ändern (beendet die anderen Anmeldungen), überall abmelden, Konto löschen.
//     Elemente fehlen in einer älteren index.html → alles mit ?. (dann gibt es die Funktionen eben nicht)
function sicherMsg(t) { const el = $('#acc-sicher-msg'); if (el) el.textContent = t || ''; }
function sicherZuruecksetzen() {
  $('#acc-pw-form')?.reset();
  $('#acc-del-form')?.reset();
  if ($('#acc-del-form')) $('#acc-del-form').hidden = true;
  if ($('#acc-sicher')) $('#acc-sicher').open = false;
  sicherMsg('');
}
async function kontoPost(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(body || {}) });
    const r = await res.json().catch(() => null);
    if (r && typeof r.ok === 'boolean') return r.ok ? r : { ok: false, error: r.error || 'Das hat gerade nicht geklappt.' };
    return { ok: false, error: res.status === 404 ? 'Diese Funktion gibt es gerade nicht – bitte lade die Seite neu.' : 'Das hat gerade nicht geklappt – bitte später noch einmal versuchen.' };
  } catch {
    return { ok: false, error: 'Keine Verbindung zum Shop – bitte Internetverbindung prüfen.' };
  }
}
function abgemeldet() {
  const u = currentUser;
  localStorage.removeItem('ovju-auth');
  currentUser = null; myOrders = [];
  renderButton();
  $('#account-modal').close();
  meldeAbgemeldet(u);
}
async function changePassword() {
  const neu = $('#acc-pw-neu').value;
  if (neu.length < 8) return sicherMsg('⚠️ Neues Passwort: mindestens 8 Zeichen');
  if (neu !== $('#acc-pw-neu2').value) return sicherMsg('⚠️ Die beiden neuen Passwörter stimmen nicht überein');
  const r = await kontoPost('/api/auth/password', { altesPasswort: $('#acc-pw-alt').value, neuesPasswort: neu });
  if (!r.ok) return sicherMsg(`⚠️ ${r.error}`);
  $('#acc-pw-form').reset();
  sicherMsg(`✅ Passwort geändert${r.beendet ? ` – ${r.beendet === 1 ? 'eine andere Anmeldung' : `${r.beendet} andere Anmeldungen`} beendet` : ''}.`);
}
async function logoutAll() {
  if (!confirm('Auf allen Geräten abmelden – auch auf diesem?')) return;
  const r = await kontoPost('/api/auth/logout-all');
  if (!r.ok) return sicherMsg(`⚠️ ${r.error}`);
  abgemeldet();
}
async function deleteAccount() {
  if (!confirm('Dein Konto wirklich endgültig löschen?')) return;
  const r = await kontoPost('/api/auth/delete', { passwort: $('#acc-del-pw').value });
  if (!r.ok) return sicherMsg(`⚠️ ${r.error}`);
  abgemeldet();
  alert('Dein Konto ist gelöscht. Danke, dass du da warst!');
}

/** Nach einer Bestellung die Historie aktualisieren */
export function refreshOrders() { if (currentUser) refreshMe(); }

// ---------------------------------------------------------------------------
export async function initAuth() {
  $('#account-btn').addEventListener('click', openAccount);
  $('#at-login').addEventListener('click', () => showAuthTab('login'));
  $('#at-register').addEventListener('click', () => showAuthTab('register'));
  $('#auth-close').addEventListener('click', () => $('#auth-modal').close());
  // Eine alte Fehlermeldung (falsches Passwort, Adresse schon vergeben …) verschwindet, sobald wieder getippt wird
  $('#auth-modal').addEventListener('input', () => { if ($('#auth-err').textContent) showErr(''); });
  $('#account-close').addEventListener('click', () => $('#account-modal').close());
  $('#acc-logout').addEventListener('click', logout);
  $('#acc-addr-save').addEventListener('click', saveAddress);
  $('#acc-zip').addEventListener('input', (e) => plzFeldPruefen(e.target));
  // Enter in den Adressfeldern: weiter zum nächsten Feld, im Ort-Feld speichern
  for (const [id, weiter] of [['#acc-street', '#acc-zip'], ['#acc-zip', '#acc-city'], ['#acc-city', null]]) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (weiter) $(weiter).focus(); else saveAddress();
    });
  }
  $('#acc-pw-form')?.addEventListener('submit', (e) => { e.preventDefault(); changePassword(); });
  $('#acc-logout-all')?.addEventListener('click', logoutAll);
  $('#acc-del-start')?.addEventListener('click', () => { $('#acc-del-form').hidden = false; sicherMsg(''); $('#acc-del-pw').focus(); });
  $('#acc-del-form')?.addEventListener('submit', (e) => { e.preventDefault(); deleteAccount(); });
  $('#auth-login').addEventListener('submit', (e) => {
    e.preventDefault();
    doAuth('/api/auth/login', { email: $('#al-email').value, password: $('#al-pw').value });
  });
  emailFeldPruefen($('#ar-email'));
  $('#auth-register').addEventListener('submit', (e) => {
    e.preventDefault();
    const lokal = emailLokalFehler($('#ar-email').value);
    if (lokal) { showErr(lokal); return; }
    doAuth('/api/auth/register', { name: $('#ar-name').value, email: $('#ar-email').value, password: $('#ar-pw').value });
  });
  // Passwort vergessen / zurücksetzen
  $('#al-forgot').addEventListener('click', () => { $('#af-email').value = $('#al-email').value; showAuthTab('forgot'); });
  $('#af-back').addEventListener('click', () => showAuthTab('login'));
  $('#auth-forgot').addEventListener('submit', (e) => { e.preventDefault(); requestReset(); });
  $('#auth-reset').addEventListener('submit', (e) => { e.preventDefault(); submitReset(); });
  // Reset-Ansicht hat keine Tabs — bei ungültigem/abgelaufenem Link direkt zu „Passwort vergessen“
  $('#ap-forgot').addEventListener('click', () => { clearResetParam(); resetToken = ''; showAuthTab('forgot'); });
  $('#auth-modal').addEventListener('close', () => { if (resetToken) clearResetParam(); });
  await refreshMe();
  // Reset-Link aus der E-Mail: ?reset=TOKEN → direkt das Formular für das neue Passwort öffnen
  const token = new URLSearchParams(location.search).get('reset');
  if (token) {
    resetToken = token;
    showAuthTab('reset');
    $('#auth-modal').showModal();
    return;
  }
  // Bestätigungslink: angemeldet → gleich einlösen und das Konto zeigen; sonst erst anmelden (der Link wird danach eingelöst)
  const vt = new URLSearchParams(location.search).get('verify');
  if (vt) {
    verifyToken = vt;
    if (currentUser) { await confirmEmail(); openAccount(); return; }
    showAuthTab('login');
    showInfo('Melde dich an – dann bestätige ich deine E-Mail-Adresse.');
    $('#auth-modal').showModal();
  }
  // „Bestellung im Konto ansehen“ aus den Mails: ?konto öffnet das Konto (abgemeldet erst die Anmeldung)
  if (!vt && new URLSearchParams(location.search).has('konto')) { clearParam('konto'); openAccount(); }
}
