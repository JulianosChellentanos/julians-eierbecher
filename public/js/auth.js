// OVJU — Kundenkonto: Registrieren, Anmelden, Bestellhistorie, Standard-Adresse
const $ = (s) => document.querySelector(s);

let currentUser = null;
let myOrders = [];

const token = () => localStorage.getItem('ovju-auth') || '';
export const getAuthHeaders = () => token() ? { 'x-auth': token() } : {};
export const getUser = () => currentUser;

const STATUS_LABEL = {
  neu: '⏳ eingegangen', bezahlt: '💶 bezahlt', 'im-druck': '🖨️ im Druck',
  versendet: '📦 versendet', storniert: '✖️ storniert',
};

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
// Auth-Modal (Login / Registrieren)
// ---------------------------------------------------------------------------
function showAuthTab(tab) {
  $('#auth-login').hidden = tab !== 'login';
  $('#auth-register').hidden = tab !== 'register';
  $('#at-login').classList.toggle('active', tab === 'login');
  $('#at-register').classList.toggle('active', tab === 'register');
  $('#auth-err').textContent = '';
}

async function doAuth(path, body) {
  $('#auth-err').textContent = '';
  const r = await (await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json();
  if (!r.ok) { $('#auth-err').textContent = r.error; return; }
  localStorage.setItem('ovju-auth', r.token);
  await refreshMe();
  $('#auth-modal').close();
  openAccount();
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
    <div class="acc-order">
      <div><b>${o.orderId}</b><br><small>${new Date(o.createdAt).toLocaleDateString('de-DE')} · ${o.pieces} Stück</small></div>
      <div class="ao-mid"><span class="ao-status">${STATUS_LABEL[o.status] || o.status}</span>
        ${o.trackingNo ? `<small>📮 ${o.trackingNo}</small>` : ''}</div>
      <div class="ao-right"><b>${o.total ? money(o.total) : '—'}</b>
        ${o.invoiceNo ? `<a href="/orders/${o.orderId}/rechnung.html" target="_blank">🧾 Rechnung</a>` : ''}</div>
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
  await refreshMe();
}
