// formsam — Kundenkonto: Registrieren, Anmelden, Passwort vergessen/zurücksetzen, Bestellhistorie, Standard-Adresse
const $ = (s) => document.querySelector(s);

let currentUser = null;
let myOrders = [];
let resetToken = '';   // aus ?reset=TOKEN (Link aus der „Passwort vergessen“-Mail)
let verifyToken = '';  // aus ?verify=TOKEN (Link aus der Willkommens-/Bestätigungsmail) — gilt nur zusammen mit der Anmeldung

const token = () => localStorage.getItem('ovju-auth') || '';
export const getAuthHeaders = () => token() ? { 'x-auth': token() } : {};
export const getUser = () => currentUser;

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
  const rechnung = o.invoiceUrl
    ? `<a href="${esc(o.invoiceUrl)}" target="_blank" rel="noopener">🧾 Rechnung</a>`
    : `<small title="Den Link zu deiner Rechnung ${esc(o.invoiceNo)} findest du in deiner Bestellbestätigung per E-Mail (Knopf „Rechnung ansehen“)">🧾 Rechnung per Mail</small>`;   // kurz: passt in die Zeile, Erklärung im title
  // Storniert mit ausgestellter Rechnung: Stornorechnung (Link wie bei der Rechnung, sonst nur die Nummer)
  const storno = !o.stornoNo ? ''
    : o.stornoUrl ? ` <a href="${esc(o.stornoUrl)}" target="_blank" rel="noopener">↩ Storno</a>` : ` <small>↩ Storno ${esc(o.stornoNo)}</small>`;
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
    : r.gutschriftUrl ? ` · <a href="${esc(r.gutschriftUrl)}" target="_blank" rel="noopener">🧾 Gutschrift ${esc(r.gutschriftNo)}</a>`
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
/** Die letzten Schritte der Bestellung (Historie vom Server: at/status/note), kompakt in einer Zeile */
function stepsHtml(o) {
  const steps = (o.history || []).slice(-3);
  if (!steps.length) return '';
  return `<div class="ao-steps" style="flex-basis:100%;font-size:.74rem;line-height:1.4;color:var(--ink-soft)">` +
    steps.map((h) => `${fmtDay(h.at)} ${esc(h.note || STATUS_LABEL[h.status] || h.status || '')}`).join(' · ') + '</div>';
}

function renderButton() {
  const btn = $('#account-btn');
  btn.innerHTML = `👤 <span class="ab-txt">${currentUser ? currentUser.name.split(' ')[0] : 'Anmelden'}</span>`;
  btn.classList.toggle('logged-in', !!currentUser);
}

async function refreshMe() {
  if (!token()) { currentUser = null; renderButton(); return; }
  try {
    const r = await (await fetch('/api/auth/me', { headers: getAuthHeaders() })).json();
    if (r.ok) { currentUser = r.user; myOrders = r.orders; }
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
    ? `✉️ <b>Bitte bestätige deine E-Mail-Adresse.</b> Erst danach zeige ich dir hier auch Bestellungen, die du ohne Anmeldung mit dieser Adresse aufgegeben hast. Den Link hast du nach der Registrierung per E-Mail bekommen.
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
  if (pw.length < 6) { showErr('Passwort: mindestens 6 Zeichen'); return; }
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
  $('#acc-email').textContent = currentUser.email + (currentUser.emailVerified ? ' ✓' : '');
  verifyBox();
  const a = currentUser.address || {};
  $('#acc-street').value = a.street || '';
  $('#acc-zip').value = a.zip || '';
  $('#acc-city').value = a.city || '';
  $('#acc-orders').innerHTML = myOrders.length ? myOrders.map((o) => `
    <div class="acc-order" style="flex-wrap:wrap">
      <div><b>${esc(o.orderId)}</b><br><small>${new Date(o.createdAt).toLocaleDateString('de-DE')} · ${o.pieces} Stück</small></div>
      <div class="ao-mid"><span class="ao-status">${STATUS_LABEL[o.status] || esc(o.status)}</span>
        ${trackingHtml(o)}</div>
      <div class="ao-right"><b>${o.total ? money(o.total) : '—'}</b>
        ${invoiceHtml(o)}
        ${widerrufHtml(o)}</div>
      ${stepsHtml(o)}
      ${reklaHtml(o)}
    </div>`).join('')
    : `<p class="tiny" style="text-align:left">${currentUser.emailVerified ? 'Noch keine Bestellungen – dein erstes Unikat wartet im Konfigurator! 🎨' : 'Noch keine Bestellungen mit diesem Konto. Hast du ohne Anmeldung bestellt? Dann bestätige oben deine E-Mail-Adresse.'}</p>`;
  $('#account-modal').showModal();
}

async function saveAddress() {
  await fetch('/api/auth/address', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ street: $('#acc-street').value, zip: $('#acc-zip').value, city: $('#acc-city').value }),
  });
  currentUser.address = { street: $('#acc-street').value, zip: $('#acc-zip').value, city: $('#acc-city').value };
  $('#acc-addr-msg').textContent = '✅ Gespeichert';
  setTimeout(() => $('#acc-addr-msg').textContent = '', 2000);
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', headers: getAuthHeaders() });
  localStorage.removeItem('ovju-auth');
  currentUser = null; myOrders = [];
  renderButton();
  $('#account-modal').close();
}

/** Nach einer Bestellung die Historie aktualisieren */
export function refreshOrders() { if (currentUser) refreshMe(); }

// ---------------------------------------------------------------------------
export async function initAuth() {
  $('#account-btn').addEventListener('click', openAccount);
  $('#at-login').addEventListener('click', () => showAuthTab('login'));
  $('#at-register').addEventListener('click', () => showAuthTab('register'));
  $('#auth-close').addEventListener('click', () => $('#auth-modal').close());
  $('#account-close').addEventListener('click', () => $('#account-modal').close());
  $('#acc-logout').addEventListener('click', logout);
  $('#acc-addr-save').addEventListener('click', saveAddress);
  $('#auth-login').addEventListener('submit', (e) => {
    e.preventDefault();
    doAuth('/api/auth/login', { email: $('#al-email').value, password: $('#al-pw').value });
  });
  $('#auth-register').addEventListener('submit', (e) => {
    e.preventDefault();
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
}
