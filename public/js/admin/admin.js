// OVJU Studio — Admin-Oberfläche (klassisches Skript, wird von /admin geladen)
// Bereiche: Übersicht · Bestellungen (+ Drawer) · Druck · Kunden · Farben · Bilder · Preise · Firma · PayPal · E-Mail · System
'use strict';

const KEY = () => localStorage.getItem('ovju-admin-key') || '';
let DATA = null;          // { settings, orders, statuses, statusLabels, carriers, normalHeight, info }
let USERS = [];           // Kundenkonten (ohne Hash/Salt)
let tiers = { egg: [], vase: [] };
let colors = [];
let coupons = [];
let dirty = false;        // ungespeicherte Einstellungen
let CUR = null;           // geöffnete Bestellnummer (Drawer)
let HIST_ALL = false;     // Verlauf im Drawer komplett ausgeklappt
let PANE = 'dash';
const F = { q: '', status: '', pay: '', period: '', email: '' };   // Bestell-Filter
let pqColor = '';         // Filter der Druckwarteschlange

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = (v) => (+v || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—');
const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const ageDays = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
const ageText = (iso, short = false) => { const d = ageDays(iso); return d <= 0 ? 'heute' : short ? `${d} T` : d === 1 ? '1 Tag' : `${d} Tagen`; };   // „offen seit …“ / Kurzform
const fmtDur = (min) => (min >= 60 ? `${(Math.round(min / 60 * 10) / 10).toLocaleString('de-DE')} h` : `${Math.round(min)} min`);
const STATUS_FLOW = ['neu', 'bezahlt', 'im-druck', 'gedruckt', 'versendet', 'abgeschlossen'];
const CARRIERS = { dhl: 'DHL', hermes: 'Hermes', dpd: 'DPD', gls: 'GLS', post: 'Deutsche Post', sonstige: 'Sonstige' };
const PATTERNS = { glatt: 'Glatt', rippen: 'Rippen', wellen: 'Wellen', lamellen: 'Lamellen', zickzack: 'Zickzack', querwellen: 'Querwellen', gehaemmert: 'Gehämmert', skelett: 'Voronoi', koralle: 'Fjordwelle' };
const PRESETS = { flasche: 'Flasche', kugel: 'Kugel', tropfen: 'Tropfen', zylinder: 'Zylinder', kurve: 'Kurve', kelch: 'Kelch', schale: 'Schale', tulpe: 'Tulpe', eigene: 'Eigene Form' };
const FONTS = { helvetiker: 'Modern', optimer: 'Soft', gentilis: 'Fein', droid_sans: 'Kräftig', droid_serif: 'Klassisch', marcellus: 'Edel', greatvibes: 'Kalligrafie' };
const TEXT_STYLES = { gestanzt: 'Gestanzt', gepraegt: 'Geprägt', gehaemmert: 'Gehämmert', kissen: 'Kissen', farbe: 'Farbschrift' };
const FINISHES = { matt: 'Matt', glanz: 'Glänzend', metall: 'Metallic/Silk' };
const stLabel = (s) => DATA?.statusLabels?.[s] || s;
// Status, für die es eine Kunden-Mail-Vorlage gibt („neu“ bekommt die Bestellbestätigung); Wahrheit auf dem Server, Fallback = lib/mail-templates.js
const MAIL_STATUSES = ['bezahlt', 'im-druck', 'gedruckt', 'versendet', 'storniert', 'abgeschlossen'];
const canStatusMail = (s) => (DATA?.mailStatuses || MAIL_STATUSES).includes(s);

// ---------------------------------------------------------------------------
// API, Login, Toasts
// ---------------------------------------------------------------------------
/** Druckzettel per Header-Authentifizierung laden und als Blob-Seite öffnen — der Admin-Key landet so nicht in URL, Verlauf oder Proxy-Logs. */
async function openDruckzettel(orderId) {
  const win = window.open('', '_blank');   // synchron öffnen, sonst blockt der Popup-Blocker
  try {
    const r = await fetch(`/admin/druckzettel/${encodeURIComponent(orderId)}`, { headers: { 'x-admin-key': KEY() } });
    if (!r.ok) throw new Error(r.status === 401 ? 'Nicht angemeldet' : 'Druckzettel nicht verfügbar (' + r.status + ')');
    const html = await r.text();
    if (win) { win.document.open(); win.document.write(html); win.document.close(); }
  } catch (e) {
    if (win) win.close();
    toast('❌ ' + e.message, 'err');
  }
}

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'x-admin-key': KEY(), ...(opts.headers || {}) } });
  if (r.status === 401) { showLogin(); throw new Error('auth'); }
  // JSON-Antworten unverändert durchreichen (auch 404 „Bestellung unbekannt“); nur ein 404 ohne JSON heißt „Endpoint fehlt noch“
  const j = await r.json().catch(() => null);
  if (j && typeof j === 'object') return j;
  if (r.status === 404) return { ok: false, notReady: true, error: 'Noch nicht eingerichtet' };
  return { ok: false, error: `Serverantwort ungültig (${r.status})` };
}
function showLogin() { $('#login').hidden = false; $('#app').hidden = true; }
async function login() {
  localStorage.setItem('ovju-admin-key', $('#pw').value);
  $('#login-err').textContent = '';
  try { await load(); } catch { $('#login-err').textContent = 'Falsches Passwort'; }
}
function logout() { localStorage.removeItem('ovju-admin-key'); showLogin(); }
function toast(msg, type = '', ms = 3200) {
  const box = $('#toasts');
  // Gleicher Text ersetzt den alten Toast; höchstens drei gleichzeitig (der älteste weicht)
  [...box.children].filter((t) => t.textContent === msg).forEach((t) => t.remove());
  while (box.children.length >= 3) box.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}
const notReady = () => toast('E-Mail-Versand ist noch nicht eingerichtet (Bereich E-Mail).', 'info');

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const NAV = [
  ['dash', '📊', 'Übersicht'], ['orders', '📦', 'Bestellungen'], ['print', '🖨️', 'Druck'], ['customers', '👥', 'Kunden'],
  ['colors', '🎨', 'Farben'], ['images', '🖼️', 'Bilder'], ['pricing', '💰', 'Preise & Gutscheine'], ['company', '🏢', 'Firma'],
  ['paypal', '💙', 'PayPal'], ['mail', '✉️', 'E-Mail'], ['system', '⚙️', 'System'],
];
const SETTINGS_PANES = ['colors', 'pricing', 'company', 'paypal', 'mail', 'system'];
function renderNav() {
  $('#nav').innerHTML = NAV.map(([id, ic, l]) => `<button data-pane="${id}" onclick="show('${id}')"><span class="ic">${ic}</span>${l}<span class="cnt" id="nav-cnt-${id}"></span></button>`).join('');
  $('#tabbar').innerHTML = NAV.map(([id, ic, l]) => `<button data-pane="${id}" onclick="show('${id}')">${ic} ${l}</button>`).join('');
}
function show(pane) {
  if (!NAV.some(([id]) => id === pane)) pane = 'dash';
  PANE = pane;
  for (const [id] of NAV) $(`#pane-${id}`).hidden = id !== pane;
  $$('[data-pane]').forEach((b) => b.classList.toggle('on', b.dataset.pane === pane));
  $('#save-bar').hidden = !SETTINGS_PANES.includes(pane);
  if (pane === 'print') renderPrint();
  if (pane === 'customers') renderCustomers();
  if (pane === 'colors') renderColors();
  if (pane === 'mail') loadMailLog();
  if (location.hash.replace('#', '').split('/')[0] !== pane) history.replaceState(null, '', `#${pane}`);
  const tab = $(`#tabbar [data-pane="${pane}"]`);
  if (tab) tab.scrollIntoView({ block: 'nearest', inline: 'center' });
  window.scrollTo({ top: 0 });
}
function updateCounters() {
  const open = DATA.orders.filter((o) => ['neu', 'bezahlt', 'im-druck', 'gedruckt'].includes(st(o))).length;
  const q = queueItems().reduce((s, it) => s + it.l.qty, 0);
  $('#cnt-open').textContent = open;
  $('#cnt-queue').textContent = q;
  $('#nav-cnt-orders').textContent = open || '';
  $('#nav-cnt-print').textContent = q || '';
  const rev = DATA.orders.filter((o) => st(o) !== 'storniert').reduce((s, o) => s + (o.total || 0), 0);
  $('#subline').textContent = `${DATA.orders.length} Bestellungen · ${open} offen · ${money(rev)} Umsatz gesamt`;
}

// ---------------------------------------------------------------------------
// Bestell-Helfer
// ---------------------------------------------------------------------------
const st = (o) => o.status || 'neu';
const custName = (o) => o.customer?.name || o.name || '';
const custEmail = (o) => (o.customer?.email || o.email || '').trim().toLowerCase();
const isPaid = (o) => st(o) === 'bezahlt' || (st(o) === 'neu' && o.paymentStatus === 'bezahlt');
const inQueue = (o) => ['bezahlt', 'im-druck'].includes(st(o)) || (st(o) === 'neu' && o.paymentStatus === 'bezahlt');
const pieces = (o) => (o.lines || []).reduce((s, l) => s + (l.qty || 0), 0);
function progress(o) {
  const ls = o.lines || [];
  return { done: ls.filter((l) => l.print?.status === 'fertig').length, printing: ls.filter((l) => l.print?.status === 'druckt').length, total: ls.length };
}
function colorOf(id, name) {
  const cols = DATA.settings.colors || [];
  const plain = String(name || '').replace(/\s*\(.*\)$/, '').trim();   // „Gold (Metallic)“ → „Gold“
  return (id && cols.find((c) => c.id === id)) || (plain && cols.find((c) => c.name === plain)) || null;
}
const lineColor = (l) => colorOf(l.config?.color, l.colorName) || { id: l.config?.color || l.colorName || '?', name: l.colorName || '?', hex: l.config?.colorHex || '#cccccc' };
const textColorOf = (l) => (l.config?.textStyle === 'farbe'
  ? (colorOf(l.config.textColor, l.textColorName) || { name: l.textColorName || l.config.textColor || '?', hex: '#222222' }) : null);
const prodLabel = (l) => (l.product === 'vase' ? 'Vase' : 'Eierbecher');
const lineTitle = (l) => `${prodLabel(l)} „${PRESETS[l.config?.preset] || l.config?.preset || ''}“`;
function lineMeta(l) {
  const c = l.config || {};
  const patt = PATTERNS[c.pattern] || c.pattern || '';
  return `${patt}${c.pattern && c.pattern !== 'glatt' && c.depth != null ? ` ${String(c.depth).replace('.', ',')} mm` : ''} · ${c.height} mm${c.width && c.width !== 1 ? ` · Breite ${Math.round(c.width * 100)} %` : ''}${l.saucer ? ' · 🍽️ Untersetzer' : ''}`;
}
function gravurText(l) {
  const c = l.config || {};
  if (!String(c.text || '').trim()) return '';
  const tc = textColorOf(l);
  return `„${c.text}“ · ${TEXT_STYLES[c.textStyle] || 'Gestanzt'} · ${FONTS[c.font] || c.font || 'Modern'}${tc ? ` · Schrift ${tc.name}` : ''}`;
}
function estimate(l) {
  const pr = DATA.settings.printing || { minutesEgg: 75, minutesVase: 210, gramsEgg: 22, gramsVase: 110 };
  const h0 = DATA.normalHeight?.[l.product] || (l.product === 'vase' ? 150 : 58);
  const h = +l.config?.height || h0, w = +l.config?.width || 1;
  const k = Math.pow(h / h0, 1.5) * w * w;
  const isV = l.product === 'vase';
  let min = (isV ? pr.minutesVase : pr.minutesEgg) * k, g = (isV ? pr.gramsVase : pr.gramsEgg) * k;
  if (l.saucer && !isV) { min += pr.minutesEgg * 0.35; g += pr.gramsEgg * 0.4; }
  return { minutes: min * (l.qty || 1), grams: g * (l.qty || 1) };
}
function queueItems() {
  const items = [];
  for (const o of DATA.orders) {
    if (!inQueue(o)) continue;
    (o.lines || []).forEach((l, i) => { if (l.print?.status !== 'fertig') items.push({ o, l, i }); });
  }
  return items;
}
const fileLink = (o, l) => (l.stlFile
  ? `<a href="/orders/${esc(o.orderId)}/${encodeURIComponent(l.stlFile)}" download onclick="event.stopPropagation()">⬇ ${/\.3mf$/i.test(l.stlFile) ? '3MF (2 Filamente)' : 'STL'}</a>`
  : '<span class="muted">keine Datei</span>');
function applyOrder(order) {
  const i = DATA.orders.findIndex((o) => o.orderId === order.orderId);
  if (i >= 0) DATA.orders[i] = order; else DATA.orders.unshift(order);
  updateCounters();
  renderDash();
  renderOrders();
  if (PANE === 'print') renderPrint();
  if (PANE === 'customers') renderCustomers();
  if (PANE === 'colors') renderColors();
  if (CUR === order.orderId) renderDrawer();
}

// ---------------------------------------------------------------------------
// Übersicht
// ---------------------------------------------------------------------------
function renderDash() {
  const all = DATA.orders;
  const orders = all.filter((o) => st(o) !== 'storniert');
  const now = Date.now(), d30 = 30 * 864e5;
  const rev = orders.reduce((s, o) => s + (o.total || 0), 0);
  const rev30 = orders.filter((o) => now - new Date(o.createdAt) < d30).reduce((s, o) => s + (o.total || 0), 0);
  const open = all.filter((o) => ['neu', 'bezahlt', 'im-druck', 'gedruckt'].includes(st(o))).length;
  const printed = all.flatMap((o) => o.lines || []).filter((l) => l.print?.status === 'fertig').reduce((s, l) => s + (l.qty || 0), 0);
  const avg = orders.length ? rev / orders.length : 0;
  $('#kpis').innerHTML = `
    <div class="kpi"><span>Umsatz gesamt</span><b>${money(rev)}</b></div>
    <div class="kpi"><span>Umsatz 30 Tage</span><b>${money(rev30)}</b></div>
    <div class="kpi"><span>Bestellungen</span><b>${all.length}</b></div>
    <div class="kpi"><span>Offen</span><b>${open}</b></div>
    <div class="kpi"><span>Ø Bestellwert</span><b>${money(avg)}</b></div>
    <div class="kpi"><span>Gedruckte Stücke</span><b>${printed}</b></div>`;
  $('#dash-date').textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // Heute zu tun
  const item = (o, extra = '') => `<div class="todo-item"><a href="#orders/${esc(o.orderId)}" onclick="event.preventDefault();openOrder('${esc(o.orderId)}')"><b>${esc(o.orderId.replace(/^OV-/, ''))}</b></a><span class="who">${esc(custName(o))}</span>${extra}</div>`;
  const unpaid = all.filter((o) => st(o) === 'neu' && o.payment !== 'paypal' && o.paymentStatus !== 'bezahlt');
  const toPrint = all.filter((o) => inQueue(o) && progress(o).done === 0 && progress(o).printing === 0);
  const printing = all.filter((o) => st(o) === 'im-druck' || (inQueue(o) && progress(o).printing > 0));
  const toShip = all.filter((o) => st(o) === 'gedruckt');
  const col = (title, list, fn) => `<div class="todo-col"><h3>${title} <span class="badge">${list.length}</span></h3>${list.slice(0, 8).map(fn).join('') || '<p class="muted">Nichts offen.</p>'}${list.length > 8 ? `<p class="muted" style="margin-top:6px">+ ${list.length - 8} weitere</p>` : ''}</div>`;
  $('#todo').innerHTML =
    col('💶 Zahlung ausstehend', unpaid, (o) => item(o, `<span class="age ${ageDays(o.createdAt) > 7 ? 'old' : ''}">${ageText(o.createdAt, true)}</span><button class="mini acc" onclick="markPaid('${esc(o.orderId)}')" title="Zahlung eingegangen">✓ bezahlt</button>`)) +
    col('🧱 Zu drucken', toPrint, (o) => item(o, `<span class="age">${pieces(o)} Stk.</span>`)) +
    col('🔥 Im Druck', printing, (o) => { const p = progress(o); return item(o, `<span class="age">${p.done}/${p.total}</span>`); }) +
    col('📮 Zu versenden', toShip, (o) => item(o, `<button class="mini ghost" onclick="openOrder('${esc(o.orderId)}')">Versand</button>`));

  // Umsatz 30 Tage (Inline-SVG-Balken, eine Serie)
  const days = [];
  for (let i = 29; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); days.push({ d, sum: 0, n: 0 }); }
  for (const o of orders) {
    const t = new Date(o.createdAt); t.setHours(0, 0, 0, 0);
    const day = days.find((x) => x.d.getTime() === t.getTime());
    if (day) { day.sum += o.total || 0; day.n++; }
  }
  const W = 440, H = 160, padL = 44, padB = 22, padT = 10, bw = (W - padL - 6) / 30;
  const max = Math.max(10, ...days.map((x) => x.sum));
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Umsatz je Tag, letzte 30 Tage">
    ${ticks.map((t) => `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"></line><text x="${padL - 6}" y="${y(t) + 3}" text-anchor="end">${Math.round(t)} €</text>`).join('')}
    ${days.map((x, i) => {
      const h = Math.max(x.sum > 0 ? 3 : 0, y(0) - y(x.sum));
      const label = `${x.d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}: ${money(x.sum)} (${x.n} Best.)`;
      return `<rect class="bar" x="${padL + i * bw + 2}" y="${y(0) - h}" width="${bw - 4}" height="${h}" rx="3"><title>${esc(label)}</title></rect>` +
        (i % 5 === 4 ? `<text x="${padL + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${x.d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</text>` : '');
    }).join('')}
  </svg>`;
  $('#chart').innerHTML = svg;
  $('#chart-sum').textContent = `— ${money(rev30)} · ${days.reduce((s, x) => s + x.n, 0)} Bestellungen`;

  const count = (fn) => {
    const m = {};
    for (const o of orders) for (const l of (o.lines || [])) { const k = fn(l); if (k) m[k] = (m[k] || 0) + (l.qty || 0); }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6);
  };
  const toplist = (entries, swatch) => {
    const mx = entries[0]?.[1] || 1;
    return entries.map(([n, c]) => `<div><span class="n">${swatch ? `<span class="sw sm" style="background:${esc(colorOf(null, n)?.hex || '#ccc')}"></span>` : ''}${esc(n)}</span><div class="bar" style="width:${Math.round(c / mx * 130)}px"></div><b>${c}</b></div>`).join('') || '<p class="muted">Noch keine Daten.</p>';
  };
  $('#top-colors').innerHTML = toplist(count((l) => l.colorName), true);
  $('#top-products').innerHTML = toplist(count((l) => prodLabel(l)));
  $('#recent').innerHTML = all.slice(0, 6).map((o) => `
    <div onclick="openOrder('${esc(o.orderId)}')">
      <span><b>${esc(o.orderId)}</b> · ${esc(custName(o))}<br><small class="muted">${fmtDT(o.createdAt)}</small></span>
      <span style="text-align:right">${o.total != null ? money(o.total) : '—'}<br><span class="badge st-${st(o)}">${esc(stLabel(st(o)))}</span></span>
    </div>`).join('') || '<p class="muted">Noch keine Bestellungen.</p>';
}

// ---------------------------------------------------------------------------
// Bestellungen — Liste & Filter
// ---------------------------------------------------------------------------
function orderMatches(o) {
  if (F.status && st(o) !== F.status) return false;
  if (F.pay && (o.payment || 'vorkasse') !== F.pay) return false;
  if (F.email && custEmail(o) !== F.email) return false;
  if (F.period) {
    const t = new Date(o.createdAt).getTime();
    if (F.period === 'year') { if (new Date(o.createdAt).getFullYear() !== new Date().getFullYear()) return false; }
    else if (Date.now() - t > (+F.period) * 864e5) return false;
  }
  if (F.q) {
    const hay = [o.orderId, o.invoiceNo, custName(o), custEmail(o), o.customer?.city, o.customer?.zip, o.trackingNo, o.paypalOrderId,
      ...(o.lines || []).map((l) => `${l.colorName} ${l.config?.text || ''} ${PRESETS[l.config?.preset] || ''} ${PATTERNS[l.config?.pattern] || ''}`)].join(' ').toLowerCase();
    if (!hay.includes(F.q)) return false;
  }
  return true;
}
function renderOrders() {
  F.pay = $('#f-pay').value; F.period = $('#f-period').value;
  // Status-Chips mit Zählern (Zähler über alle anderen Filter)
  const base = DATA.orders.filter((o) => { const s = F.status; F.status = ''; const ok = orderMatches(o); F.status = s; return ok; });
  const counts = {};
  for (const o of base) counts[st(o)] = (counts[st(o)] || 0) + 1;
  $('#f-status').innerHTML = [['', 'Alle', base.length], ...DATA.statuses.map((s) => [s, stLabel(s), counts[s] || 0])]
    .filter(([s, , n]) => !s || n || s === F.status)
    .map(([s, l, n]) => `<button class="chip ${F.status === s ? 'on' : ''}" onclick="F.status='${s}';renderOrders()">${esc(l)}<span class="n">${n}</span></button>`).join('');
  const act = [];
  if (F.q) act.push(`Suche „${esc(F.q)}“`);
  if (F.email) act.push(`Kunde ${esc(F.email)}`);
  $('#f-active').innerHTML = act.length ? `<span class="active-q">${act.join(' · ')}<button class="link" onclick="clearFilters()">✕</button></span>` : '';

  const list = DATA.orders.filter(orderMatches);
  $('#orders-sub').textContent = `${list.length} von ${DATA.orders.length} Bestellungen`;
  $('#orders-table').innerHTML = `<thead><tr><th>Bestellung</th><th>Datum</th><th>Kunde</th><th>Positionen</th><th class="num">Summe</th><th>Status</th><th>Druck</th></tr></thead><tbody>` +
    (list.map((o) => {
      const p = progress(o);
      const lines = (o.lines || []).map((l) => `<span class="sw sm" style="background:${esc(lineColor(l).hex)}"></span> ${l.qty}× ${esc(lineTitle(l))}`).join('<br>') || '<span class="muted">—</span>';
      return `<tr class="click" onclick="openOrder('${esc(o.orderId)}')">
        <td data-l="Bestellung"><b class="nowrap">${esc(o.orderId)}</b>${o.invoiceNo ? `<br><small class="muted nowrap">🧾 ${esc(o.invoiceNo)}</small>` : ''}</td>
        <td data-l="Datum"><small class="nowrap">${fmtDate(o.createdAt)}</small><br><small class="muted">${new Date(o.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</small></td>
        <td data-l="Kunde">${esc(custName(o))}<br><small class="muted mail" title="${esc(custEmail(o))}">${esc(custEmail(o))}</small></td>
        <td data-l="Positionen"><span class="lines-short">${lines}</span></td>
        <td data-l="Summe" class="num">${o.total != null ? money(o.total) : '—'}<br><small class="muted">${o.payment === 'paypal' ? 'PayPal' : 'Vorkasse'} ${o.paymentStatus === 'bezahlt' ? '<span title="bezahlt">✅</span>' : '<span title="offen">⏳</span>'}</small>${o.coupon ? `<br><small class="muted">🎟️ ${esc(o.coupon.code)}</small>` : ''}</td>
        <td data-l="Status"><span class="badge st-${st(o)}">${esc(stLabel(st(o)))}</span>${o.trackingNo ? `<br><small class="muted trk">📮 ${esc(o.trackingNo)}</small>` : ''}</td>
        <td data-l="Druck">${p.total ? `<span class="prog"><i style="--w:${Math.round(p.done / p.total * 100)}%"></i>${p.done}/${p.total}</span>` : '—'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">Keine Treffer.</td></tr>') + '</tbody>';
}
function clearFilters() { F.q = ''; F.email = ''; $('#g-search').value = ''; renderOrders(); }
function filterByEmail(email) { F.email = email; F.q = ''; F.status = ''; $('#g-search').value = ''; show('orders'); renderOrders(); }

// ---------------------------------------------------------------------------
// Bestellung — Drawer
// ---------------------------------------------------------------------------
function openOrder(id) {
  if (!DATA.orders.some((o) => o.orderId === id)) return toast('Bestellung nicht gefunden', 'err');
  CUR = id;
  HIST_ALL = false;
  renderDrawer();
  $('#drawer').classList.add('open'); $('#drawer-bg').classList.add('open');
  document.body.style.overflow = 'hidden';
  history.replaceState(null, '', `#${PANE}/${id}`);
}
function closeOrder() {
  CUR = null;
  $('#drawer').classList.remove('open'); $('#drawer-bg').classList.remove('open');
  document.body.style.overflow = '';
  history.replaceState(null, '', `#${PANE}`);
}
function renderDrawer() {
  const o = DATA.orders.find((x) => x.orderId === CUR);
  if (!o) return closeOrder();
  const s = st(o), cu = o.customer || {};
  $('#drawer-title').innerHTML = `${esc(o.orderId)} <span class="badge st-${s}" style="vertical-align:middle;margin-left:6px">${esc(stLabel(s))}</span>`;

  // Status-Stepper
  const idx = STATUS_FLOW.indexOf(s);
  const stepper = s === 'storniert'
    ? `<span class="step cur">✕ Storniert</span><button class="ghost mini" onclick="setStatus('${esc(o.orderId)}','neu')">Storno aufheben → Neu</button>`
    : STATUS_FLOW.map((x, i) => {
      const cls = i < idx ? 'done' : i === idx ? 'cur' : i === idx + 1 ? 'next' : '';
      const click = cls === 'next' ? ` onclick="setStatus('${esc(o.orderId)}','${x}')" title="Weiter zu „${esc(stLabel(x))}“"` : '';
      return `<span class="step ${cls}"${click}>${i < idx ? '✓ ' : ''}${esc(stLabel(x))}</span>`;
    }).join('<span class="step-arrow">›</span>');
  const hist = [...(o.history || [])].reverse().map((h) => `<li class="${h.by === 'system' ? 'sys' : ''}"><time>${fmtDT(h.at)} · ${esc(h.by)}</time><span class="badge st-${esc(h.status)}" style="margin-right:6px">${esc(stLabel(h.status))}</span>${esc(h.note || '')}</li>`).join('');

  // Positionen
  const lines = (o.lines || []).map((l, i) => {
    const col = lineColor(l), tc = textColorOf(l), pr = l.print || { status: 'offen' }, g = gravurText(l), e = estimate(l);
    return `<div class="line-card">
      <div class="lc-head">
        <div class="lc-qty">${l.qty}×</div>
        <div class="lc-main"><b>${esc(lineTitle(l))}</b>${l.off ? ` <span class="badge">−${l.off} %</span>` : ''}
          <div class="lc-meta">${esc(lineMeta(l))}${l.code ? ` · Code ${esc(l.code)}` : ''} · ≈ ${fmtDur(e.minutes)} / ${Math.round(e.grams)} g</div>
          ${g ? `<div class="lc-meta">✒️ ${esc(g)}</div>` : ''}
          <div class="lc-color"><span><span class="sw" style="background:${esc(col.hex)}"></span>${esc(col.name)}${col.finish && col.finish !== 'matt' ? ` <small class="muted">(${FINISHES[col.finish] || col.finish})</small>` : ''}</span>
            ${tc ? `<span><span class="sw" style="background:${esc(tc.hex)}"></span>Schrift: ${esc(tc.name)}</span>` : ''}</div>
        </div>
        <div style="text-align:right">${l.unit != null ? `<b>${money(l.line)}</b><br><small class="muted">${money(l.unit)}/Stk.</small>` : ''}</div>
      </div>
      <div class="lc-actions">
        <span class="badge pr-${esc(pr.status)}">${{ offen: '⏳ offen', druckt: '🔥 druckt', fertig: '✅ gedruckt' }[pr.status] || pr.status}</span>
        ${pr.status !== 'druckt' && pr.status !== 'fertig' ? `<button class="mini" onclick="linePrint('${esc(o.orderId)}',${i},'druckt')">▶ Start</button>` : ''}
        ${pr.status !== 'fertig' ? `<button class="mini acc" onclick="linePrint('${esc(o.orderId)}',${i},'fertig')">✓ Fertig</button>` : ''}
        ${pr.status !== 'offen' ? `<button class="mini ghost" onclick="linePrint('${esc(o.orderId)}',${i},'offen')">↺ Zurücksetzen</button>` : ''}
        <span class="right">${fileLink(o, l)}</span>
      </div>
      ${pr.startedAt || pr.note ? `<div class="muted" style="margin-top:6px;font-size:.76rem">${pr.startedAt ? `Start ${fmtDT(pr.startedAt)}` : ''}${pr.doneAt ? ` · fertig ${fmtDT(pr.doneAt)}` : ''}${pr.note ? ` · ${esc(pr.note)}` : ''}</div>` : ''}
    </div>`;
  }).join('') || '<p class="muted">Keine Positionen.</p>';

  // Fehlklick auf „bezahlt“ rückgängig: solange kein Druck läuft, in einem Schritt zurück auf „Neu“ + Zahlung offen (ohne Storno-Umweg)
  const undoable = s === 'bezahlt' && !(o.lines || []).some((l) => l.print?.status && l.print.status !== 'offen');
  const payBlock = o.payment === 'paypal'
    ? `<dl class="kv"><dt>Zahlart</dt><dd>PayPal ${o.paymentStatus === 'bezahlt' ? '✅ bezahlt' : '⏳ offen'}</dd><dt>PayPal-ID</dt><dd><code>${esc(o.paypalOrderId || '—')}</code></dd>${o.paidAt ? `<dt>Bezahlt am</dt><dd>${fmtDT(o.paidAt)}</dd>` : ''}</dl>`
    : `<dl class="kv"><dt>Zahlart</dt><dd>Vorkasse (Überweisung)</dd><dt>Betrag</dt><dd><b>${o.total != null ? money(o.total) : '—'}</b></dd><dt>Verwendungszweck</dt><dd><code>${esc(o.invoiceNo || o.orderId)}</code></dd>
       <dt>Status</dt><dd>${o.paymentStatus === 'bezahlt' ? `✅ bezahlt${o.paidAt ? ' am ' + fmtDT(o.paidAt) : ''} ${undoable ? `<button class="link mini" onclick="undoPaid('${esc(o.orderId)}')">↩ zurück auf Neu (Zahlung offen)</button>` : `<button class="link mini" onclick="setPayment('${esc(o.orderId)}','offen')">zurücksetzen</button>`}` : `⏳ offen seit ${ageText(o.createdAt)} <button class="mini acc" style="margin-left:8px" onclick="markPaid('${esc(o.orderId)}')">✓ Zahlung eingegangen</button>${undoable ? ` <button class="link mini" onclick="undoPaid('${esc(o.orderId)}')">↩ zurück auf Neu</button>` : ''}`}</dd></dl>`;

  const account = o.userId ? '<span class="badge">👤 Kundenkonto</span>' : (USERS.some((u) => u.email === custEmail(o)) ? '<span class="badge">👤 hat Konto</span>' : '<span class="badge">Gast</span>');
  const tel = cu.phone ? `<br><a href="tel:${esc(cu.phone)}">${esc(cu.phone)}</a>` : '';
  $('#drawer-body').innerHTML = `
    <div class="sect">
      <h3>Status <span class="right">${fmtDT(o.createdAt)}${o.invoiceNo ? ` · <a href="/orders/${esc(o.orderId)}/rechnung.html" target="_blank">🧾 ${esc(o.invoiceNo)}</a>` : ''}</span></h3>
      <div class="stepper">${stepper}</div>
      <div class="row" style="margin-top:10px">
        <button class="ghost mini" onclick="openDruckzettel('${esc(o.orderId)}')">🖨️ Druckzettel</button>
        ${o.invoiceNo ? `<button class="ghost mini" onclick="window.open('/orders/${esc(o.orderId)}/rechnung.html','_blank')">🧾 Rechnung</button>` : ''}
        ${s !== 'storniert' && s !== 'abgeschlossen' ? `<button class="danger mini right" onclick="cancelOrder('${esc(o.orderId)}')">✕ Stornieren</button>` : ''}
      </div>
    </div>
    <div class="sect ${HIST_ALL ? 'all' : ''}"><h3>Verlauf</h3><ul class="tl">${hist || '<li class="muted">Keine Einträge.</li>'}</ul>
      ${(o.history || []).length > 3 ? `<button class="link mini" onclick="toggleHist()">${HIST_ALL ? 'Nur die letzten 3 zeigen' : `Alle ${o.history.length} Einträge zeigen`}</button>` : ''}</div>
    <div class="sect"><div class="grid2">
      <div><h3>Kunde ${account}</h3>
        <div class="addr"><b>${esc(cu.name)}</b><br>${esc(cu.street)}<br>${esc(cu.zip)} ${esc(cu.city)}<br>
        <a href="mailto:${esc(custEmail(o))}">${esc(custEmail(o))}</a>${tel}</div>
        ${cu.note ? `<p class="hint" style="margin-top:8px">📝 ${esc(cu.note)}</p>` : ''}
        <p style="margin-top:8px"><button class="link" data-act="filter-email" data-email="${esc(custEmail(o))}">Alle Bestellungen dieses Kunden</button></p>
      </div>
      <div><h3>Zahlung</h3>${payBlock}</div>
    </div></div>
    <div class="sect"><h3>Positionen <span class="right">${pieces(o)} Stück · ${o.total != null ? money(o.total) : '—'}${o.shipping != null ? ` (Versand ${o.shipping ? money(o.shipping) : 'frei'})` : ''}</span></h3>${lines}</div>
    <div class="sect"><h3>Versand</h3>
      <div class="row">
        <select id="d-carrier">${['', ...Object.keys(CARRIERS)].map((k) => `<option value="${k}" ${(o.carrier || '') === k ? 'selected' : ''}>${k ? CARRIERS[k] : 'Versender wählen'}</option>`).join('')}</select>
        <input type="text" id="d-tracking" placeholder="Sendungsnummer" value="${esc(o.trackingNo || '')}" style="flex:1;min-width:160px">
      </div>
      <div class="row" style="margin-top:8px">
        <button class="acc" onclick="ship('${esc(o.orderId)}')" ${s === 'storniert' ? 'disabled' : ''}>📮 Versendet &amp; Kunde benachrichtigen</button>
        <button class="ghost" onclick="saveShipping('${esc(o.orderId)}')">Nur speichern</button>
      </div>
      ${o.shippedAt ? `<p class="muted" style="margin-top:6px">Versendet am ${fmtDT(o.shippedAt)}${o.carrier ? ' mit ' + esc(CARRIERS[o.carrier] || o.carrier) : ''}</p>` : ''}
    </div>
    <div class="sect"><h3>Interne Notiz</h3>
      <textarea id="d-note" rows="2" placeholder="Nur für dich sichtbar …">${esc(o.adminNote || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="ghost mini" onclick="saveNote('${esc(o.orderId)}')">💾 Notiz speichern</button></div>
    </div>
    <div class="sect"><h3>E-Mail an ${esc(cu.name || 'Kunde')}</h3>
      <div class="row">
        <button class="ghost mini" onclick="mailAction('${esc(o.orderId)}','bestaetigung')">📧 Bestellbestätigung senden</button>
        ${canStatusMail(s) ? `<button class="ghost mini" onclick="mailAction('${esc(o.orderId)}','status')">📧 Status-Mail (${esc(stLabel(s))})</button>` : ''}
        <button class="ghost mini" onclick="openFreitext('${esc(o.orderId)}')">✍️ Freitext-Mail</button>
        ${canStatusMail(s)
          ? `<button class="ghost mini" onclick="mailPreview('${esc(o.orderId)}','status')">👁 Vorschau Status-Mail</button>`
          : `<button class="ghost mini" onclick="mailPreview('${esc(o.orderId)}','bestaetigung')">👁 Vorschau Bestellbestätigung</button>`}
      </div>
    </div>`;
}

function toggleHist() { HIST_ALL = !HIST_ALL; renderDrawer(); }

async function setStatus(id, status) {
  const o = DATA.orders.find((x) => x.orderId === id);
  if (!o) return;
  if (!confirm(`Bestellung ${id} auf „${stLabel(status)}“ setzen?`)) return;
  const r = await api('/api/admin/order-update', { method: 'POST', body: JSON.stringify({ orderId: id, status }) });
  if (!r.ok) return toast(r.error || 'Fehler', 'err');
  applyOrder(r.order);
  toast(`${id} → ${stLabel(status)}`, 'ok');
}
async function cancelOrder(id) {
  if (!confirm(`Bestellung ${id} wirklich stornieren?`)) return;
  const r = await api('/api/admin/order-update', { method: 'POST', body: JSON.stringify({ orderId: id, status: 'storniert' }) });
  if (!r.ok) return toast(r.error || 'Fehler', 'err');
  applyOrder(r.order);
  toast(`${id} storniert`, 'ok');
}
async function markPaid(id) {
  const o = DATA.orders.find((x) => x.orderId === id);
  if (!o) return;
  // Rückfrage wie bei setStatus/cancelOrder — bucht Zahlung + Status und stößt die Bezahlt-Mail an
  const mailHint = st(o) === 'neu' && DATA.settings.mail?.enabled && DATA.settings.mail?.autoStatusMails !== false ? ' Der Kunde erhält eine Status-Mail.' : '';
  if (!confirm(`Zahlung für ${id} (${o.total != null ? money(o.total) : '—'}) als eingegangen verbuchen?${mailHint}`)) return;
  const body = { orderId: id, paymentStatus: 'bezahlt' };
  if (st(o) === 'neu') body.status = 'bezahlt';
  const r = await api('/api/admin/order-update', { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) return toast(r.error || 'Fehler', 'err');
  applyOrder(r.order);
  toast(`Zahlung für ${id} verbucht`, 'ok');
}
async function setPayment(id, paymentStatus) {
  const r = await api('/api/admin/order-update', { method: 'POST', body: JSON.stringify({ orderId: id, paymentStatus }) });
  if (!r.ok) return toast(r.error || 'Fehler', 'err');
  applyOrder(r.order);
  toast('Zahlungsstatus aktualisiert', 'ok');
}
/** Fehlklick auf „bezahlt“ rückgängig: Zahlung offen + Status „Neu“ in einem Aufruf, ohne Status-Mail */
async function undoPaid(id) {
  if (!confirm(`Bestellung ${id} zurück auf „Neu“ setzen und die Zahlung wieder als offen führen?`)) return;
  const r = await api('/api/admin/order-update', { method: 'POST', body: JSON.stringify({ orderId: id, paymentStatus: 'offen', status: 'neu', notify: false }) });
  if (!r.ok) return toast(r.error || 'Fehler', 'err');
  applyOrder(r.order);
  toast(`${id} → Neu · Zahlung offen`, 'ok');
}
async function linePrint(id, idx, status) {
  const r = await api('/api/admin/line-print', { method: 'POST', body: JSON.stringify({ orderId: id, idx, status }) });
  if (!r.ok) return toast(r.error || 'Fehler', 'err');
  const before = DATA.orders.find((x) => x.orderId === id)?.status;
  applyOrder(r.order);
  const auto = r.order.status !== before ? ` · Bestellung jetzt „${stLabel(r.order.status)}“` : '';
  toast(`Position ${idx + 1}: ${{ offen: 'zurückgesetzt', druckt: 'Druck gestartet', fertig: 'gedruckt' }[status]}${auto}`, 'ok');
}
async function ship(id) {
  const carrier = $('#d-carrier').value, trackingNo = $('#d-tracking').value.trim();
  if (!trackingNo && !confirm('Ohne Sendungsnummer als versendet markieren?')) return;
  const r = await api('/api/admin/order-update', { method: 'POST', body: JSON.stringify({ orderId: id, status: 'versendet', carrier, trackingNo, notify: true }) });
  if (!r.ok) return toast(r.error || 'Fehler', 'err');
  applyOrder(r.order);
  toast(`${id} als versendet markiert`, 'ok');
  // Die Kunden-Mail verschickt der Server über hooks.statusChanged (E-Mail-Integration)
  if (!DATA.settings.mail?.enabled) toast('Hinweis: Der Kunde wird erst benachrichtigt, wenn der E-Mail-Versand eingerichtet ist (Bereich E-Mail).', 'info', 5000);
}
async function saveShipping(id) {
  const r = await api('/api/admin/order-update', { method: 'POST', body: JSON.stringify({ orderId: id, carrier: $('#d-carrier').value, trackingNo: $('#d-tracking').value.trim() }) });
  if (!r.ok) return toast(r.error || 'Fehler', 'err');
  applyOrder(r.order);
  toast('Versanddaten gespeichert', 'ok');
}
async function saveNote(id) {
  const r = await api('/api/admin/order-update', { method: 'POST', body: JSON.stringify({ orderId: id, adminNote: $('#d-note').value }) });
  if (!r.ok) return toast(r.error || 'Fehler', 'err');
  applyOrder(r.order);
  toast('Notiz gespeichert', 'ok');
}

// --- E-Mail-Aktionen (Endpoints kommen mit der E-Mail-Integration; bis dahin freundlicher Hinweis)
async function mailAction(id, kind) {
  const o = DATA.orders.find((x) => x.orderId === id);
  if (kind === 'status' && !canStatusMail(st(o))) return toast(`Für den Status „${stLabel(st(o))}“ gibt es keine Mail-Vorlage — dafür gibt es die Bestellbestätigung.`, 'info');
  if (!confirm(`${kind === 'bestaetigung' ? 'Bestellbestätigung' : `Status-Mail „${stLabel(st(o))}“`} an ${custEmail(o)} senden?`)) return;
  const r = await api('/api/admin/mail-send', { method: 'POST', body: JSON.stringify({ orderId: id, kind, status: st(o) }) });
  if (r.notReady) return notReady();
  if (!r.ok) return toast(r.error || 'Senden fehlgeschlagen', 'err', 5000);
  toast('E-Mail gesendet', 'ok');
}
async function mailPreview(id, kind, extra = {}) {
  const o = DATA.orders.find((x) => x.orderId === id);
  const r = await api('/api/admin/mail-preview', { method: 'POST', body: JSON.stringify({ orderId: id, kind, status: st(o), ...extra }) });
  if (r.notReady) return notReady();
  if (!r.ok) return toast(r.error || 'Vorschau fehlgeschlagen', 'err');
  $('#dlg-preview-title').textContent = `Vorschau · ${o.orderId}`;
  $('#dlg-preview-subject').textContent = `Betreff: ${r.subject || ''}`;
  $('#dlg-preview-frame').srcdoc = r.html || '';
  const sendBtn = $('#dlg-preview-send');
  sendBtn.hidden = false;
  sendBtn.onclick = async () => {
    const s = await api('/api/admin/mail-send', { method: 'POST', body: JSON.stringify({ orderId: id, kind, status: st(o), ...extra }) });
    if (s.notReady) return notReady();
    if (!s.ok) return toast(s.error || 'Senden fehlgeschlagen', 'err');
    $('#dlg-preview').close(); $('#dlg-mail').close();
    toast('E-Mail gesendet', 'ok');
  };
  $('#dlg-preview').showModal();
}
function openFreitext(id) {
  const o = DATA.orders.find((x) => x.orderId === id);
  $('#dlg-mail').dataset.order = id;
  $('#dlg-mail-to').textContent = `An: ${custName(o)} <${custEmail(o)}>`;
  $('#dlg-mail-subject').value = `Deine OVJU-Bestellung ${id}`;
  $('#dlg-mail-text').value = `Hallo ${custName(o).split(' ')[0]},\n\n\n\nLiebe Grüße\n${DATA.settings.company?.owner || 'OVJU'}`;
  $('#dlg-mail').showModal();
}
async function mailFreitext(mode) {
  const id = $('#dlg-mail').dataset.order;
  const subject = $('#dlg-mail-subject').value.trim(), text = $('#dlg-mail-text').value;
  if (!subject || !text.trim()) return toast('Bitte Betreff und Text ausfüllen', 'err');
  if (mode === 'preview') return mailPreview(id, 'freitext', { subject, text });
  const r = await api('/api/admin/mail-send', { method: 'POST', body: JSON.stringify({ orderId: id, kind: 'freitext', subject, text }) });
  if (r.notReady) return notReady();
  if (!r.ok) return toast(r.error || 'Senden fehlgeschlagen', 'err', 5000);
  $('#dlg-mail').close();
  toast('E-Mail gesendet', 'ok');
}

// ---------------------------------------------------------------------------
// Druckwarteschlange
// ---------------------------------------------------------------------------
function renderPrint() {
  const items = queueItems();
  const groups = {};
  for (const it of items) {
    const c = lineColor(it.l);
    const k = c.id || c.name;
    (groups[k] ||= { color: c, items: [], qty: 0, minutes: 0, grams: 0 });
    const e = estimate(it.l);
    groups[k].items.push(it); groups[k].qty += it.l.qty; groups[k].minutes += e.minutes; groups[k].grams += e.grams;
  }
  const tot = Object.values(groups).reduce((a, g) => ({ qty: a.qty + g.qty, minutes: a.minutes + g.minutes, grams: a.grams + g.grams }), { qty: 0, minutes: 0, grams: 0 });
  $('#pq-head').innerHTML = `<span><b>${tot.qty}</b> Stücke offen</span><span class="muted">·</span><span>≈ <b>${fmtDur(tot.minutes)}</b> Druckzeit</span><span class="muted">·</span><span>≈ <b>${Math.round(tot.grams)} g</b> Filament</span><span class="muted right">${items.length} Positionen aus ${new Set(items.map((i) => i.o.orderId)).size} Bestellungen</span>`;
  const keys = Object.keys(groups).sort((a, b) => groups[b].qty - groups[a].qty);
  if (pqColor && !groups[pqColor]) pqColor = '';
  // Der Farbschlüssel kann aus Kundendaten stammen (Fallback in lineColor) → nur als data-Attribut, Klick per Delegation
  $('#pq-filter').innerHTML = [`<button class="chip ${!pqColor ? 'on' : ''}" data-pq="">Alle Farben<span class="n">${tot.qty}</span></button>`,
    ...keys.map((k) => `<button class="chip ${pqColor === k ? 'on' : ''}" data-pq="${esc(k)}"><span class="sw sm" style="background:${esc(groups[k].color.hex)};margin-right:6px"></span>${esc(groups[k].color.name)}<span class="n">${groups[k].qty}</span></button>`)].join('');
  const itemHTML = (it, showState = true) => {
    const { o, l, i } = it, pr = l.print || { status: 'offen' }, tc = textColorOf(l), g = gravurText(l), e = estimate(l);
    return `<div class="pq-item">
      <div class="q">${l.qty}×</div>
      <div class="t"><b>${esc(lineTitle(l))} <button class="link" style="font-size:.8rem" onclick="openOrder('${esc(o.orderId)}')">${esc(o.orderId)}</button></b>
        ${esc(lineMeta(l))} · ≈ ${fmtDur(e.minutes)} / ${Math.round(e.grams)} g<br>
        <small>${esc(custName(o))}${g ? ` · ✒️ ${esc(g)}` : ''}${tc ? ` <span class="sw sm" style="background:${esc(tc.hex)}"></span>` : ''}${pr.startedAt ? ` · Start ${fmtDT(pr.startedAt)}` : ''}${pr.doneAt ? ` · fertig ${fmtDT(pr.doneAt)}` : ''}</small></div>
      <div class="a">${fileLink(o, l)}
        ${showState ? `<span class="badge pr-${esc(pr.status)}">${{ offen: '⏳ offen', druckt: '🔥 druckt', fertig: '✅ fertig' }[pr.status]}</span>` : ''}
        ${pr.status === 'offen' ? `<button class="mini" onclick="linePrint('${esc(o.orderId)}',${i},'druckt')">▶ Start</button>` : ''}
        ${pr.status !== 'fertig' ? `<button class="mini acc" onclick="linePrint('${esc(o.orderId)}',${i},'fertig')">✓ Fertig</button>` : `<button class="mini ghost" onclick="linePrint('${esc(o.orderId)}',${i},'offen')">↺</button>`}
      </div></div>`;
  };
  $('#pq-groups').innerHTML = keys.filter((k) => !pqColor || k === pqColor).map((k) => {
    const g = groups[k];
    return `<div class="card pq-group" style="--c:${esc(g.color.hex)}"><h2><span class="sw" style="background:${esc(g.color.hex)}"></span>${esc(g.color.name)}${g.color.finish && g.color.finish !== 'matt' ? ` <small>${FINISHES[g.color.finish] || ''}</small>` : ''}
      <span class="meta">${g.qty} Stück · ≈ ${fmtDur(g.minutes)} · ≈ ${Math.round(g.grams)} g${g.color.stock ? ` · Bestand ${g.color.stock} g${g.grams > g.color.stock ? ' ⚠️ reicht nicht' : ''}` : ''}</span></h2>
      ${g.items.map((it) => itemHTML(it)).join('')}</div>`;
  }).join('') || '<div class="card"><p class="empty">🎉 Nichts zu drucken — alle bezahlten Bestellungen sind fertig.</p></div>';

  const printing = [];
  const done = [];
  for (const o of DATA.orders) (o.lines || []).forEach((l, i) => {
    if (l.print?.status === 'druckt') printing.push({ o, l, i });
    if (l.print?.status === 'fertig') done.push({ o, l, i });
  });
  done.sort((a, b) => new Date(b.l.print.doneAt || 0) - new Date(a.l.print.doneAt || 0));
  $('#pq-printing').innerHTML = printing.map((it) => itemHTML(it, false)).join('') || '<p class="empty">Gerade läuft kein Druck.</p>';
  $('#pq-done').innerHTML = done.slice(0, 10).map((it) => itemHTML(it, false)).join('') || '<p class="empty">Noch nichts gedruckt.</p>';
}

// ---------------------------------------------------------------------------
// Kunden
// ---------------------------------------------------------------------------
function renderCustomers() {
  const m = {};
  for (const u of USERS) {
    m[u.email] = { name: u.name, email: u.email, city: u.address?.city || '', orders: 0, rev: 0, last: null, account: true, since: u.createdAt };
  }
  for (const o of DATA.orders) {
    const e = custEmail(o);
    if (!e) continue;
    const c = (m[e] ||= { name: custName(o), email: e, city: '', orders: 0, rev: 0, last: null, account: false });
    c.orders++;
    if (st(o) !== 'storniert') c.rev += o.total || 0;
    if (!c.last || o.createdAt > c.last) { c.last = o.createdAt; if (o.customer?.city) c.city = o.customer.city; if (!c.account) c.name = custName(o); }
  }
  const list = Object.values(m).sort((a, b) => (b.last || b.since || '').localeCompare(a.last || a.since || ''));
  $('#customers-table').innerHTML = `<thead><tr><th>Kunde</th><th>Ort</th><th class="num">Bestellungen</th><th class="num">Umsatz</th><th>Letzte Bestellung</th><th>Konto</th></tr></thead><tbody>` +
    list.map((c) => `<tr class="click" data-email="${esc(c.email)}">
      <td data-l="Kunde"><b>${esc(c.name)}</b><br><a href="mailto:${esc(c.email)}" onclick="event.stopPropagation()">${esc(c.email)}</a></td>
      <td data-l="Ort">${esc(c.city || '—')}</td>
      <td data-l="Bestellungen" class="num">${c.orders}</td>
      <td data-l="Umsatz" class="num">${money(c.rev)}</td>
      <td data-l="Zuletzt">${c.last ? fmtDate(c.last) : '—'}</td>
      <td data-l="Konto">${c.account ? '<span class="badge">👤 Konto</span>' : '<span class="muted">Gast</span>'}</td>
    </tr>`).join('') + '</tbody>';
}

// ---------------------------------------------------------------------------
// Farben (Filament-Verwaltung)
// ---------------------------------------------------------------------------
function renderColors() {
  const need = {};
  for (const it of queueItems()) { const c = lineColor(it.l); need[c.id || c.name] = (need[c.id || c.name] || 0) + estimate(it.l).grams; }
  const maxNeed = Math.max(1, ...Object.values(need));
  $('#colors-list').innerHTML = colors.map((c, i) => {
    const n = need[c.id] || need[c.name] || 0;
    const over = c.stock && n > c.stock;
    return `<div class="color-row">
      <label class="f-sw"><span class="sw" style="background:${esc(c.hex)}"></span><input type="color" value="${esc(c.hex)}" onchange="colors[${i}].hex=this.value;renderColors()" title="${esc(c.hex)}"></label>
      <label>Name<input type="text" value="${esc(c.name)}" onchange="colors[${i}].name=this.value" style="width:130px"></label>
      <label>Finish<select onchange="colors[${i}].finish=this.value">${Object.entries(FINISHES).map(([k, l]) => `<option value="${k}" ${(c.finish || 'matt') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="grow">Notiz<input type="text" value="${esc(c.note || '')}" onchange="colors[${i}].note=this.value" placeholder="z. B. Bambu PLA Silk"></label>
      <label>Bestand (g)<input type="number" min="0" step="10" value="${c.stock ?? ''}" placeholder="—" onchange="colors[${i}].stock=this.value===''?null:+this.value;renderColors()" style="width:88px"></label>
      <label>Offener Bedarf<div class="need-wrap"><div class="need ${over ? 'over' : ''}" style="width:80px"><i style="--w:${Math.round(n / maxNeed * 100)}%"></i></div><small>${n ? `${Math.round(n)} g${over ? ' ⚠️' : ''}` : '—'}</small></div></label>
      <label class="inline"><input type="checkbox" ${c.active ? 'checked' : ''} onchange="colors[${i}].active=this.checked"> Im Shop</label>
      <button class="ghost mini del" data-del-color="${i}" title="Farbe löschen">🗑</button>
    </div>`;
  }).join('') || '<p class="empty">Noch keine Farben angelegt.</p>';
}
function deleteColor(i) {
  if (!colors[i] || !confirm(`Farbe „${colors[i].name}“ löschen?`)) return;
  colors.splice(i, 1); setDirty(true); renderColors();
}
function addColor() {
  colors.push({ id: 'farbe-' + Date.now().toString(36), name: 'Neue Farbe', hex: '#a0a0a0', finish: 'matt', note: '', stock: null, active: true });
  setDirty(true); renderColors();
  show('colors');
}

// ---------------------------------------------------------------------------
// Bilder (Galerie & Produktfotos)
// ---------------------------------------------------------------------------
async function loadImages() {
  let imgs = [];
  try { imgs = await (await fetch('/api/gallery')).json(); } catch { imgs = []; }
  $('#img-list').innerHTML = imgs.map((g) => `
    <div class="it">
      <img src="${esc(g.file)}" alt="" loading="lazy">
      <div style="margin-top:6px"><span class="badge">${esc(g.cat)}</span>
        <button class="ghost mini" onclick="deleteImage('${esc(g.file.split('/').pop())}')">🗑</button></div>
    </div>`).join('') || '<p class="empty">Noch keine Fotos — lade deine Produktbilder hoch!</p>';
}
async function uploadImages() {
  const files = $('#img-file').files;
  if (!files.length) return toast('Bitte Datei(en) wählen', 'err');
  const cat = $('#img-cat').value;
  let done = 0;
  for (const f of files) {
    const r = await fetch(`/api/admin/gallery?cat=${cat}&name=${encodeURIComponent(f.name)}`, { method: 'PUT', headers: { 'x-admin-key': KEY(), 'Content-Type': f.type }, body: f });
    if (r.status === 401) return showLogin();
    if (r.ok) done++;
  }
  toast(`${done} Foto(s) hochgeladen — live auf der Seite`, 'ok');
  $('#img-file').value = '';
  loadImages();
}
async function deleteImage(name) {
  if (!confirm('Foto löschen?')) return;
  await fetch(`/api/admin/gallery/${name}`, { method: 'DELETE', headers: { 'x-admin-key': KEY() } });
  toast('Foto gelöscht', 'ok');
  loadImages();
}

// ---------------------------------------------------------------------------
// Preise, Rabatte, Gutscheine
// ---------------------------------------------------------------------------
function renderTiers() {
  for (const [k, sel] of [['egg', '#tiers-egg'], ['vase', '#tiers-vase']]) {
    $(sel).innerHTML = tiers[k].map((t, i) => `<div class="row" style="margin:6px 0;flex-wrap:nowrap">
      ab <input type="number" min="2" value="${t.qty}" onchange="tiers['${k}'][${i}].qty=+this.value" style="width:70px">
      Stück → <input type="number" min="0" max="90" value="${t.off}" onchange="tiers['${k}'][${i}].off=+this.value" style="width:70px"> %
      <button class="ghost mini" onclick="tiers['${k}'].splice(${i},1);setDirty(true);renderTiers()">✕</button></div>`).join('') || '<p class="muted" style="margin:6px 0">Keine Staffel.</p>';
  }
}
function addTier(k) { tiers[k].push({ qty: 2, off: 10 }); setDirty(true); renderTiers(); }
function renderCoupons() {
  $('#coupons-table').innerHTML = `<thead><tr><th>Code</th><th>Art</th><th>Wert</th><th>Mindestbestellwert (€)</th><th>Aktiv</th><th></th></tr></thead><tbody>` +
    coupons.map((c, i) => `<tr>
      <td data-l="Code"><input type="text" value="${esc(c.code)}" onchange="coupons[${i}].code=this.value.toUpperCase()" style="width:140px;text-transform:uppercase"></td>
      <td data-l="Art"><select onchange="coupons[${i}].type=this.value"><option value="percent" ${c.type === 'percent' ? 'selected' : ''}>% Rabatt</option><option value="fixed" ${c.type === 'fixed' ? 'selected' : ''}>€ Betrag</option></select></td>
      <td data-l="Wert"><input type="number" min="0" value="${c.value}" onchange="coupons[${i}].value=+this.value"></td>
      <td data-l="Mindestwert"><input type="number" min="0" value="${c.minOrder || 0}" onchange="coupons[${i}].minOrder=+this.value"></td>
      <td data-l="Aktiv" style="text-align:center"><input type="checkbox" ${c.active ? 'checked' : ''} onchange="coupons[${i}].active=this.checked"></td>
      <td><button class="ghost mini" onclick="coupons.splice(${i},1);setDirty(true);renderCoupons()">🗑</button></td>
    </tr>`).join('') + (coupons.length ? '' : '<tr><td colspan="6" class="empty">Noch keine Gutscheine.</td></tr>') + '</tbody>';
}
function addCoupon() { coupons.push({ code: 'OSTERN10', type: 'percent', value: 10, minOrder: 0, active: true }); setDirty(true); renderCoupons(); }

// ---------------------------------------------------------------------------
// E-Mail-Einstellungen
// ---------------------------------------------------------------------------
const MAIL_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 465, secure: 'ssl', hint: 'Gmail: Bitte ein <b>App-Passwort</b> verwenden (Google-Konto → Sicherheit → 2-Faktor → App-Passwörter), nicht das normale Konto-Passwort. Benutzername = deine Gmail-Adresse.' },
  strato: { host: 'smtp.strato.de', port: 465, secure: 'ssl', hint: 'Strato: Benutzername ist die vollständige E-Mail-Adresse.' },
  ionos: { host: 'smtp.ionos.de', port: 465, secure: 'ssl', hint: 'IONOS: Benutzername ist die vollständige E-Mail-Adresse.' },
  gmx: { host: 'mail.gmx.net', port: 587, secure: 'starttls', hint: 'GMX: In den GMX-Einstellungen muss „POP3/IMAP-Abruf“ aktiviert sein.' },
  webde: { host: 'smtp.web.de', port: 587, secure: 'starttls', hint: 'WEB.DE: In den Einstellungen muss „POP3/IMAP“ freigeschaltet sein.' },
  allinkl: { host: '', port: 465, secure: 'ssl', hint: 'All-Inkl: Host ist dein KAS-Server, z. B. <code>w01234ab.kasserver.com</code> — steht im KAS unter „E-Mail“. Benutzername = Postfachname (m01234ab) oder E-Mail-Adresse.' },
};
function mailPreset(k) {
  const p = MAIL_PRESETS[k];
  $('#m-host').value = p.host; $('#m-port').value = p.port; $('#m-secure').value = p.secure;
  $('#m-host').placeholder = k === 'allinkl' ? 'w01234ab.kasserver.com' : 'smtp.example.de';
  $('#m-hint').innerHTML = p.hint; $('#m-hint').hidden = false;
  setDirty(true);
}
function mailForm() {
  return {
    enabled: $('#m-enabled').checked, host: $('#m-host').value.trim(), port: +$('#m-port').value || 465, secure: $('#m-secure').value,
    user: $('#m-user').value.trim(), pass: $('#m-pass').value, from: $('#m-from').value.trim(), fromName: $('#m-fromname').value.trim(),
    replyTo: $('#m-replyto').value.trim(), adminTo: $('#m-adminto').value.trim(), adminCopy: $('#m-admincopy').checked,
    autoStatusMails: $('#m-autostatus').checked, publicUrl: $('#m-publicurl').value.trim().replace(/\/$/, ''),
  };
}
function fillMail(m = {}) {
  $('#m-enabled').checked = !!m.enabled; $('#m-host').value = m.host || ''; $('#m-port').value = m.port || 465;
  $('#m-secure').value = m.secure || 'ssl'; $('#m-user').value = m.user || ''; $('#m-pass').value = m.pass || '';
  // Der Server liefert das SMTP-Passwort nie aus (pass leer, passSet) — leer lassen = gespeichertes behalten
  $('#m-pass').placeholder = m.passSet ? '(gespeichert — leer lassen, um es zu behalten)' : '';
  $('#m-from').value = m.from || ''; $('#m-fromname').value = m.fromName || 'OVJU'; $('#m-replyto').value = m.replyTo || '';
  $('#m-adminto').value = m.adminTo || ''; $('#m-admincopy').checked = m.adminCopy !== false; $('#m-autostatus').checked = m.autoStatusMails !== false;
  $('#m-publicurl').value = m.publicUrl || '';
}
async function mailTest(btn) {
  const to = $('#m-testto').value.trim();
  if (!to) return toast('Bitte Empfänger-Adresse eingeben', 'err');
  // SMTP-Timeouts liegen bei 15 s (Verbinden) / 30 s (Befehl): Knopf sperren und beschriften, kein zweiter Versuch parallel
  btn = btn || $('#pane-mail button[onclick^="mailTest"]');
  if (btn?.disabled) return;
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Sende Testmail … (bis zu 30 s)'; }
  try {
    const r = await api('/api/admin/mail-test', { method: 'POST', body: JSON.stringify({ to, settings: mailForm() }) });
    if (r.notReady) { $('#mail-notready').hidden = false; return notReady(); }
    $('#dlg-log-title').textContent = 'Testmail — SMTP-Protokoll';
    $('#dlg-log-state').textContent = r.ok ? `✅ Testmail an ${to} gesendet` : `❌ Fehler: ${r.error || 'unbekannt'}`;
    $('#dlg-log-state').style.color = r.ok ? 'var(--green)' : 'var(--red)';
    $('#dlg-log-pre').textContent = (r.log || []).join('\n') || '(kein Protokoll)';
    if (!$('#dlg-log').open) $('#dlg-log').showModal();
  } catch (e) {
    if (e.message !== 'auth') toast(e.message || 'Senden fehlgeschlagen', 'err', 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}
async function loadMailLog() {
  const r = await api('/api/admin/mail-log');
  if (r.notReady) { $('#mail-notready').hidden = false; $('#mail-log').innerHTML = '<tr><td class="empty">Das Versandprotokoll ist verfügbar, sobald der E-Mail-Versand eingerichtet ist.</td></tr>'; return; }
  if (!r.ok) { $('#mail-log').innerHTML = `<tr><td class="empty">${esc(r.error || 'Fehler')}</td></tr>`; return; }
  $('#mail-notready').hidden = true;
  const entries = r.entries || [];
  const mailOn = r.config ? !!r.config.active : !!DATA.settings.mail?.enabled;
  // Zustände aus lib/mailer.js (gesendet/fehler/wartet/deaktiviert) — Fehler mit Meldung, Rest mit Erklärung
  const state = (e) => (e.status === 'failed' || e.status === 'fehler' ? `❌ ${esc(e.error || 'Fehler')}`
    : { sent: '✅ gesendet', gesendet: '✅ gesendet', wartet: '⏳ wird erneut versucht', deaktiviert: '⏸ nicht gesendet — Versand aus' }[e.status] || esc(e.status || ''));
  // „Erneut“ nicht, während ein Wiederholungsversuch läuft, und nicht bei deaktiviertem Versand (liefert nur denselben Fehler)
  const canResend = (e) => e.status !== 'wartet' && !(e.status === 'deaktiviert' && !mailOn);
  $('#mail-log').innerHTML = `<thead><tr><th>Zeit</th><th>An</th><th>Betreff</th><th>Art</th><th>Bezug</th><th>Status</th><th></th></tr></thead><tbody>` +
    entries.map((e) => `<tr>
      <td data-l="Zeit"><small>${fmtDT(e.sentAt || e.createdAt)}</small></td>
      <td data-l="An">${esc(e.to)}</td>
      <td data-l="Betreff">${esc(e.subject)}</td>
      <td data-l="Art"><span class="badge">${esc(e.kind || '')}</span></td>
      <td data-l="Bezug">${mailRef(e.ref)}</td>
      <td data-l="Status"><span title="${esc(e.error || '')}">${state(e)}</span>${e.attempts > 1 ? ` <small class="muted">(${e.attempts}×)</small>` : ''}</td>
      <td>${canResend(e) ? `<button class="ghost mini" onclick="mailResend('${esc(e.id)}')">↻ Erneut</button>` : ''}</td>
    </tr>`).join('') + '</tbody>' + (!entries.length ? '<tr><td colspan="7" class="empty">Noch keine E-Mails versendet.</td></tr>' : '');
}
/** Bezug eines Protokolleintrags: Bestellnummer (öffnet den Drawer) oder Kundenkonto (Willkommen/Passwort) */
function mailRef(ref) {
  if (!ref) return '—';
  if (DATA.orders.some((o) => o.orderId === ref)) return `<button class="link" onclick="openOrder('${esc(ref)}')">${esc(ref)}</button>`;
  const u = USERS.find((x) => x.id === ref);
  return u ? `<small>👤 ${esc(u.name)}</small>` : `<small class="muted">${esc(ref)}</small>`;
}
async function mailResend(id) {
  const r = await api('/api/admin/mail-resend', { method: 'POST', body: JSON.stringify({ id }) });
  if (r.notReady) return notReady();
  toast(r.ok ? 'E-Mail erneut gesendet' : (r.error || 'Fehler'), r.ok ? 'ok' : 'err');
  loadMailLog();
}

// ---------------------------------------------------------------------------
// Einstellungen befüllen & speichern
// ---------------------------------------------------------------------------
function fillSettings() {
  const s = DATA.settings;
  $('#s-egg-single').value = s.pricing.eierbecher.single;
  $('#s-egg-saucer').value = s.pricing.eierbecher.untersetzer;
  $('#s-vase-single').value = s.pricing.vase.single;
  $('#s-gravur').value = s.pricing.gravur ?? 3;
  $('#s-vol-pct').value = s.pricing.volumen?.prozent ?? 60;
  $('#s-vol-eur').value = s.pricing.volumen?.euro ?? 0;
  $('#s-ship-flat').value = s.pricing.shipping.flat;
  $('#s-ship-free').value = s.pricing.shipping.freeFrom;
  tiers.egg = structuredClone(s.pricing.eierbecher.discounts || []);
  tiers.vase = structuredClone(s.pricing.vase.discounts || []);
  colors = structuredClone(s.colors || []);
  coupons = structuredClone(s.coupons || []);
  renderTiers(); renderColors(); renderCoupons();
  const c = s.company || {};
  $('#c-name').value = c.name || ''; $('#c-owner').value = c.owner || ''; $('#c-street').value = c.street || '';
  $('#c-zip').value = c.zip || ''; $('#c-city').value = c.city || ''; $('#c-email').value = c.email || '';
  $('#c-phone').value = c.phone || ''; $('#c-ustid').value = c.ustId || ''; $('#c-iban').value = c.iban || '';
  $('#c-bic').value = c.bic || ''; $('#c-bank').value = c.bank || ''; $('#c-prefix').value = s.invoicePrefix || '';
  $('#c-klein').checked = !!c.kleinunternehmer;
  $('#pp-id').value = s.paypal?.clientId || ''; $('#pp-secret').value = s.paypal?.secret || '';
  $('#pp-enabled').checked = !!s.paypal?.enabled; $('#pp-sandbox').checked = !!s.paypal?.sandbox;
  fillMail(s.mail);
  const p = s.printing || {};
  $('#p-min-egg').value = p.minutesEgg ?? 75; $('#p-g-egg').value = p.gramsEgg ?? 22;
  $('#p-min-vase').value = p.minutesVase ?? 210; $('#p-g-vase').value = p.gramsVase ?? 110;
  $('#s-adminkey').value = '';
  const info = DATA.info || {};
  $('#sys-info').innerHTML = `<dt>Node</dt><dd>${esc(info.node || '—')}</dd><dt>Läuft seit</dt><dd>${info.startedAt ? fmtDT(info.startedAt) : '—'} (${info.uptime != null ? fmtDur(info.uptime / 60) : '—'})</dd><dt>Bestellungen</dt><dd>${DATA.orders.length}</dd><dt>Kundenkonten</dt><dd>${USERS.length}</dd><dt>Nächste Rechnung</dt><dd>${esc(s.invoicePrefix || '')}${String(s.nextInvoice || 1).padStart(4, '0')}</dd>`;
  $('#side-foot').textContent = `Node ${info.node || ''} · seit ${info.startedAt ? fmtDT(info.startedAt) : '—'}`;
  setDirty(false);
}
function setDirty(v) {
  dirty = v;
  const el = $('#save-state');
  el.textContent = v ? 'Ungespeicherte Änderungen' : 'Alles gespeichert';
  el.classList.toggle('dirty', v);
}
async function saveSettings() {
  const patch = {
    pricing: {
      currency: 'EUR',
      eierbecher: { single: +$('#s-egg-single').value, untersetzer: +$('#s-egg-saucer').value, discounts: tiers.egg },
      vase: { single: +$('#s-vase-single').value, discounts: tiers.vase },
      gravur: +$('#s-gravur').value,
      volumen: { prozent: +$('#s-vol-pct').value, euro: +$('#s-vol-eur').value },
      shipping: { flat: +$('#s-ship-flat').value, freeFrom: +$('#s-ship-free').value },
    },
    company: {
      name: $('#c-name').value, owner: $('#c-owner').value, street: $('#c-street').value,
      zip: $('#c-zip').value, city: $('#c-city').value, email: $('#c-email').value,
      phone: $('#c-phone').value, ustId: $('#c-ustid').value, kleinunternehmer: $('#c-klein').checked,
      iban: $('#c-iban').value, bic: $('#c-bic').value, bank: $('#c-bank').value,
    },
    paypal: { enabled: $('#pp-enabled').checked, sandbox: $('#pp-sandbox').checked, clientId: $('#pp-id').value, secret: $('#pp-secret').value },
    mail: mailForm(),
    printing: { minutesEgg: +$('#p-min-egg').value || 75, gramsEgg: +$('#p-g-egg').value || 22, minutesVase: +$('#p-min-vase').value || 210, gramsVase: +$('#p-g-vase').value || 110 },
    invoicePrefix: $('#c-prefix').value,
    colors, coupons,
  };
  if ($('#s-adminkey').value) patch.adminKey = $('#s-adminkey').value;
  $('#save-btn').disabled = true;
  try {
    const r = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify(patch) });
    if (!r.ok) throw new Error(r.error || 'Speichern fehlgeschlagen');
    if (patch.adminKey) { localStorage.setItem('ovju-admin-key', patch.adminKey); $('#s-adminkey').value = ''; }
    DATA.settings = { ...DATA.settings, ...patch, colors: structuredClone(colors), coupons: structuredClone(coupons) };
    setDirty(false);
    toast('Einstellungen gespeichert — wirken sofort im Shop', 'ok');
    if (PANE === 'colors') renderColors();
  } catch (e) {
    if (e.message !== 'auth') toast(e.message, 'err');
  } finally { $('#save-btn').disabled = false; }
}

// ---------------------------------------------------------------------------
// Export & Backup
// ---------------------------------------------------------------------------
async function downloadCSV() {
  const r = await fetch('/api/admin/orders.csv', { headers: { 'x-admin-key': KEY() } });
  if (r.status === 401) return showLogin();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob());
  a.download = 'ovju-bestellungen.csv';
  a.click();
  toast('CSV-Export gestartet', 'ok');
}
async function downloadBackup() {
  const data = await api('/api/admin/export');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `ovju-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast('Backup heruntergeladen', 'ok');
}

// ---------------------------------------------------------------------------
// Start, Tastatur, Routing
// ---------------------------------------------------------------------------
async function load() {
  const d = await api('/api/admin/data');
  if (!d.ok) throw new Error('auth');
  DATA = d;
  DATA.statuses ||= ['neu', 'bezahlt', 'im-druck', 'gedruckt', 'versendet', 'abgeschlossen', 'storniert'];
  try { USERS = (await api('/api/admin/users')).users || []; } catch { USERS = []; }
  $('#login').hidden = true;
  $('#app').hidden = false;
  renderNav();
  fillSettings();
  updateCounters();
  renderDash();
  renderOrders();
  loadImages();
  const [pane, id] = location.hash.replace('#', '').split('/');
  show(pane || 'dash');
  if (id) openOrder(id);
}
document.addEventListener('DOMContentLoaded', () => {
  $('#g-search').addEventListener('input', (e) => {
    F.q = e.target.value.trim().toLowerCase();
    if (F.q && PANE !== 'orders') show('orders');
    renderOrders();
  });
  // Klick-Delegation: Kundendaten (E-Mail, Farbschlüssel, Farbname) stehen nur in data-Attributen, nie in Inline-Handlern
  document.addEventListener('click', (e) => {
    const em = e.target.closest?.('[data-email]');
    if (em) { if (em.dataset.act === 'filter-email') closeOrder(); return filterByEmail(em.dataset.email); }
    const pq = e.target.closest?.('[data-pq]');
    if (pq) { pqColor = pq.dataset.pq; return renderPrint(); }
    const del = e.target.closest?.('[data-del-color]');
    if (del) deleteColor(+del.dataset.delColor);
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing && !$('#app').hidden) { e.preventDefault(); $('#g-search').focus(); $('#g-search').select(); }
    if (e.key === 'Escape' && CUR && !document.querySelector('dialog[open]')) closeOrder();
  });
  // Ungespeicherte Änderungen in Einstellungs-Bereichen erkennen
  for (const ev of ['input', 'change']) {
    document.addEventListener(ev, (e) => { if (e.target.closest?.('.pane[data-settings]') && !e.target.closest('#m-testto')) setDirty(true); });
  }
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('hashchange', () => {
    const [pane, id] = location.hash.replace('#', '').split('/');
    if (!DATA) return;
    if (pane && pane !== PANE) show(pane);
    if (id && id !== CUR) openOrder(id); else if (!id && CUR) closeOrder();
  });
  load().catch(() => showLogin());
});
