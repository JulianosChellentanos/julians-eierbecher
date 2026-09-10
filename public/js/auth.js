// OVJU — Kundenkonto: Registrieren, Anmelden, Passwort vergessen/zurücksetzen, Bestellhistorie, Standard-Adresse
const $ = (s) => document.querySelector(s);

let currentUser = null;
let myOrders = [];
let resetToken = '';   // aus ?reset=TOKEN (Link aus der „Passwort vergessen“-Mail)

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
async function api(path, body, fallback = 'Das hat gerade nicht geklappt — bitte später noch einmal versuchen.') {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const r = await res.json().catch(() => null);
    if (r && typeof r.ok === 'boolean') return r.ok ? r : { ok: false, error: r.error || fallback };
    return { ok: false, error: fallback };
  } catch {
    return { ok: false, error: 'Keine Verbindung zum Shop — bitte Internetverbindung prüfen.' };
  }
}

/** Session übernehmen (Antwort von login/register/reset: { ok, token, user }) */
async function startSession(r) {
  localStorage.setItem('ovju-auth', r.token);
  await refreshMe();
  $('#auth-modal').close();
  openAccount();
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
    'Passwort-Zurücksetzen ist gerade nicht verfügbar — schreib uns einfach kurz eine E-Mail.');
  btn.disabled = false;
  if (!r.ok) { showErr(r.error); return; }
  $('#auth-forgot').hidden = true;
  showInfo('📬 Falls ein Konto mit dieser E-Mail existiert, ist eine E-Mail mit dem Link unterwegs (60 Minuten gültig) — bitte auch im Spam-Ordner nachsehen.');
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
    'Der Link ist ungültig oder abgelaufen — bitte fordere einen neuen an.');
  btn.disabled = false;
  if (!r.ok) { clearResetParam(); showErr(r.error); return; } // Token bleibt im Speicher (erneuter Versuch), URL nicht
  clearResetParam();
  resetToken = '';
  $('#ap-pw').value = ''; $('#ap-pw2').value = '';
  await startSession(r);
}

/** ?reset=TOKEN aus der Adresszeile entfernen (ohne Neuladen) */
function clearResetParam() {
  const u = new URL(location.href);
  if (!u.searchParams.has('reset')) return;
  u.searchParams.delete('reset');
  history.replaceState(null, '', u.pathname + u.search + u.hash);
}

// ---------------------------------------------------------------------------
// Konto-Modal
// ---------------------------------------------------------------------------
function money(v) {
  return (v ?? 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

export function openAccount() {
  if (!currentUser) { showAuthTab('login'); $('#auth-modal').showModal(); return; }
  $('#acc-greeting').textContent = `Hallo, ${currentUser.name}! 👋`;
  $('#acc-email').textContent = currentUser.email;
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
        ${o.invoiceNo ? `<a href="/orders/${encodeURIComponent(o.orderId)}/rechnung.html" target="_blank">🧾 Rechnung</a>` : ''}</div>
      ${stepsHtml(o)}
    </div>`).join('')
    : '<p class="tiny" style="text-align:left">Noch keine Bestellungen — dein erstes Unikat wartet im Konfigurator! 🎨</p>';
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
  }
}
