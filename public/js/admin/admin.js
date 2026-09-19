// OVJU Studio — Admin-Oberfläche (klassisches Skript, wird von /admin geladen)
// Bereiche: Übersicht · Bestellungen (+ Drawer) · Druck · Kunden · Farben · Bilder · Preise · Aktionen · Firma · PayPal · E-Mail · System
'use strict';

const KEY = () => localStorage.getItem('ovju-admin-key') || '';
let DATA = null;          // { settings, orders, statuses, statusLabels, carriers, normalHeight, info, aktionen, aktion, serverNow }
let USERS = [];           // Kundenkonten (ohne Hash/Salt)
let tiers = { egg: [], vase: [] };
let colors = [];
let coupons = [];         // [{ code, type, value, minOrder, active, mitAktion }] — mitAktion: mit laufender Aktion kombinierbar
let aktionen = [];        // Vertrag „Aktionen“: [{ id, name, prozent, start, ende (ISO-UTC), produkte, muster [Muster-Keys, leer = alle Oberflächen], mengenrabatt, hinweis, aktiv }]
let dirty = false;        // ungespeicherte Einstellungen
let CUR = null;           // geöffnete Bestellnummer (Drawer)
let HIST_ALL = false;     // Verlauf im Drawer komplett ausgeklappt
let PANE = 'dash';
const F = { q: '', status: '', pay: '', period: '', email: '', rekla: false };   // Bestell-Filter (rekla = nur offene Reklamationen)
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
const MUSTER_KEYS = Object.keys(PATTERNS);   // Aufpreis-Felder #s-muster-<key> (Vertrag „Aufpreise“)
/** Betrag in € ≥ 0 auf 2 Nachkommastellen — leer/Unsinn/negativ wird 0 (gleiche Regel wie euro() im Server) */
const euro = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; };
/** Feldwert für Aufpreis-Eingaben: 0 bleibt leer (Platzhalter „0“), sonst der Betrag */
const euroField = (v) => (euro(v) > 0 ? euro(v) : '');
/** Kleines Badge „+3 €“ für Aufpreise > 0, sonst leer */
const plusBadge = (v) => (euro(v) > 0 ? `<span class="badge plus" title="Aufpreis je Stück">+${euro(v).toLocaleString('de-DE', { maximumFractionDigits: 2 })} €</span>` : '');
const PRESETS = { flasche: 'Flasche', kugel: 'Kugel', tropfen: 'Tropfen', zylinder: 'Zylinder', kurve: 'Kurve', kelch: 'Kelch', schale: 'Schale', tulpe: 'Tulpe', eigene: 'Eigene Form' };
const FONTS = { helvetiker: 'Modern', optimer: 'Soft', gentilis: 'Fein', droid_sans: 'Kräftig', droid_serif: 'Klassisch', marcellus: 'Edel', greatvibes: 'Kalligrafie' };
const TEXT_STYLES = { gestanzt: 'Gestanzt', gepraegt: 'Geprägt', gehaemmert: 'Gehämmert', kissen: 'Kissen', farbe: 'Farbschrift' };
const FINISHES = { matt: 'Matt', glanz: 'Glänzend', metall: 'Metallic/Silk' };
const RIM_LABELS = { glatt: 'Glatter Rand', muster: 'Musterkante', wulst: 'Wulstrand' };   // Oberer Rand (config.rim) — „glatt“ ist Standard und wird nicht genannt
// Reklamation (order.reklamation): Labels kommen mit /api/admin/data (reklaStatus/reklaArt), Fallback = lib/mail-templates.js
const REKLA_STATUS = { offen: 'Reklamation offen', ruecksendung: 'Rücksendung erwartet', eingegangen: 'Ware eingegangen', erledigt: 'Erledigt', abgelehnt: 'Abgelehnt' };
const REKLA_ART = { nachdruck: 'Nachdruck', gutschein: 'Gutschrift als Gutschein-Code', ueberweisung: 'Erstattung per Überweisung', paypal: 'Erstattung per PayPal' };
const REKLA_OPEN = ['offen', 'ruecksendung', 'eingegangen'];   // noch in Bearbeitung
const RK_PHASE_LABEL = { angelegt: 'Bestätigung', eingegangen: 'Ware eingegangen', erledigt: 'Erledigt', abgelehnt: 'Abgelehnt' };   // Mail-Phasen (kind 'reklamation')
const rkStLabel = (s) => DATA?.reklaStatus?.[s] || REKLA_STATUS[s] || s;
const rkArtLabel = (a) => DATA?.reklaArt?.[a] || REKLA_ART[a] || a;
const reklaOpen = (o) => REKLA_OPEN.includes(o.reklamation?.status);
/** Erstatteter Betrag (erledigte Gutschrift/Erstattung, kein Nachdruck) — gleiche Regel wie refundAmount() im Server */
const refundAmount = (o) => (o.reklamation?.status === 'erledigt' && o.reklamation.art !== 'nachdruck' ? euro(o.reklamation.betrag) : 0);
/** Mail-Phase zur aktuellen Reklamation: offen/ruecksendung → angelegt, sonst = Status */
const reklaPhase = (r) => ({ offen: 'angelegt', ruecksendung: 'angelegt', eingegangen: 'eingegangen', erledigt: 'erledigt', abgelehnt: 'abgelehnt' }[r?.status] || 'angelegt');
/** IBAN bis auf die letzten 4 Zeichen maskiert, in Vierergruppen */
const maskIban = (s) => { const c = String(s || '').replace(/\s+/g, ''); return c ? ('•'.repeat(Math.max(0, c.length - 4)) + c.slice(-4)).replace(/(.{4})/g, '$1 ').trim() : ''; };
let RK_NEW = false;       // Drawer: Formular „neue Reklamation“ trotz vorhandener (abgelehnter/erledigter Nachdruck-)Reklamation zeigen
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
  ['colors', '🎨', 'Farben'], ['images', '🖼️', 'Bilder'], ['pricing', '💰', 'Preise & Gutscheine'], ['aktionen', '🔥', 'Aktionen'], ['company', '🏢', 'Firma'],
  ['paypal', '💙', 'PayPal'], ['mail', '✉️', 'E-Mail'], ['system', '⚙️', 'System'],
];
const SETTINGS_PANES = ['colors', 'pricing', 'aktionen', 'company', 'paypal', 'mail', 'system'];
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
  if (pane === 'aktionen') aktionen.forEach((_, i) => akRefresh(i));   // Status-Chips/Countdown sofort frisch (Ticker läuft sonst nur sekündlich)
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
  const rev = DATA.orders.filter((o) => st(o) !== 'storniert').reduce((s, o) => s + (o.total || 0) - refundAmount(o), 0);   // netto: abzüglich erledigter Erstattungen
  const rk = DATA.orders.filter(reklaOpen).length;
  $('#subline').textContent = `${DATA.orders.length} Bestellungen · ${open} offen${rk ? ` · ${rk} Reklamation${rk === 1 ? '' : 'en'}` : ''} · ${money(rev)} Umsatz gesamt`;
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
  const rim = c.rim && c.rim !== 'glatt' && RIM_LABELS[c.rim] ? ` · ${RIM_LABELS[c.rim]}` : '';   // Vertrag „Oberer Rand“: nur ≠ glatt
  return `${patt}${c.pattern && c.pattern !== 'glatt' && c.depth != null ? ` ${String(c.depth).replace('.', ',')} mm` : ''}${rim} · ${c.height} mm${c.width && c.width !== 1 ? ` · Breite ${Math.round(c.width * 100)} %` : ''}${l.saucer ? ' · 🍽️ Untersetzer' : ''}`;
}
function gravurText(l) {
  const c = l.config || {};
  if (!String(c.text || '').trim()) return '';
  const tc = textColorOf(l);
  return `„${c.text}“ · ${TEXT_STYLES[c.textStyle] || 'Gestanzt'} · ${FONTS[c.font] || c.font || 'Modern'}${tc ? ` · Schrift ${tc.name}` : ''}`;
}
/** Aufpreise einer Bestellzeile aus der Server-Aufschlüsselung l.parts — nur Teile > 0; Grundpreis ist kein Aufpreis,
 *  Untersetzer steht schon in lineMeta (🍽️), Größe dagegen nirgends separat → mit aufführen. Ältere Zeilen ohne parts: leer. */
function surchargeLine(l) {
  const parts = l.parts;
  if (!parts || typeof parts !== 'object') return '';
  const c = l.config || {};
  const list = [['Gravur', parts.gravur], [PATTERNS[c.pattern] || 'Muster', parts.muster], ['Farbschrift', parts.farbschrift], ['Farbe', parts.farbe], ['Größe', parts.groesse]]
    .filter(([, v]) => euro(v) > 0);
  return list.length ? `Aufpreise: ${list.map(([k, v]) => `${k} ${money(v)}`).join(' · ')}` : '';
}
/** Aktionszeile einer Bestellposition „UVP 24,90 € · Aktion −16 % (Sommer)“ (wie aktionText() in lib/mail-templates.js) — leer ohne Aktion.
 *  Der Name kommt je Zeile aus l.aktionName: bei mehreren gleichzeitigen Aktionen (z. B. −30 % nur auf Gehämmert) gilt je Position eine andere. */
function aktionLine(l) {
  const p = Math.round(Number(l?.aktionProzent) || 0);
  if (p <= 0) return '';
  const name = String(l.aktionName || '').trim();
  return `${euro(l.uvp) > 0 ? `UVP ${money(l.uvp)} · ` : ''}Aktion −${p} %${name ? ` (${name})` : ''}`;
}
/** Alle Aktionen einer Bestellung [{ id, name, prozent, ersparnis, produkte?, muster? }] — order.aktionen, ältere Bestellungen nur order.aktion (wie orderAktionen() im Server) */
function orderAktionen(o) {
  if (Array.isArray(o?.aktionen) && o.aktionen.length) return o.aktionen.filter((a) => a && typeof a === 'object');
  return o?.aktion && typeof o.aktion === 'object' ? [o.aktion] : [];
}
/** Geltungsbereich einer Bestell-Aktion als Zusatz „ auf Gehämmert“ — nur wenn die Bestellung ihn kennt (neuere Bestellungen speichern produkte/muster mit) */
const orderAktionScope = (a) => (a.produkte !== undefined || a.muster !== undefined ? ` ${aktionScopeLabel(a)}` : '');
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
  // Erledigte Erstattungen/Gutschriften (kein Nachdruck) mindern den Umsatz — Server liefert dasselbe in DATA.kpi.erstattet
  const refunds = orders.reduce((s, o) => s + refundAmount(o), 0);
  const refunds30 = orders.filter((o) => now - new Date(o.createdAt) < d30).reduce((s, o) => s + refundAmount(o), 0);
  const refundLine = (v) => (v > 0 ? `<small class="kpi-sub">− ${money(v)} Erstattungen</small>` : '');
  const open = all.filter((o) => ['neu', 'bezahlt', 'im-druck', 'gedruckt'].includes(st(o))).length;
  const printed = all.flatMap((o) => o.lines || []).filter((l) => l.print?.status === 'fertig').reduce((s, l) => s + (l.qty || 0), 0);
  const avg = orders.length ? rev / orders.length : 0;
  $('#kpis').innerHTML = `
    <div class="kpi"><span>Umsatz gesamt</span><b>${money(rev - refunds)}</b>${refundLine(refunds)}</div>
    <div class="kpi"><span>Umsatz 30 Tage</span><b>${money(rev30 - refunds30)}</b>${refundLine(refunds30)}</div>
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
  const reklas = all.filter(reklaOpen).sort((a, b) => (b.reklamation.updatedAt || '').localeCompare(a.reklamation.updatedAt || ''));
  const col = (title, list, fn) => `<div class="todo-col"><h3>${title} <span class="badge">${list.length}</span></h3>${list.slice(0, 8).map(fn).join('') || '<p class="muted">Nichts offen.</p>'}${list.length > 8 ? `<p class="muted" style="margin-top:6px">+ ${list.length - 8} weitere</p>` : ''}</div>`;
  $('#todo').innerHTML =
    col('💶 Zahlung ausstehend', unpaid, (o) => item(o, `<span class="age ${ageDays(o.createdAt) > 7 ? 'old' : ''}">${ageText(o.createdAt, true)}</span><button class="mini acc" onclick="markPaid('${esc(o.orderId)}')" title="Zahlung eingegangen">✓ bezahlt</button>`)) +
    col('🧱 Zu drucken', toPrint, (o) => item(o, `<span class="age">${pieces(o)} Stk.</span>`)) +
    col('🔥 Im Druck', printing, (o) => { const p = progress(o); return item(o, `<span class="age">${p.done}/${p.total}</span>`); }) +
    col('📮 Zu versenden', toShip, (o) => item(o, `<button class="mini ghost" onclick="openOrder('${esc(o.orderId)}')">Versand</button>`)) +
    col('↩️ Reklamationen', reklas, (o) => item(o, `<span class="badge rk-${esc(o.reklamation.status)}" title="${esc(rkArtLabel(o.reklamation.art))}">${esc(rkStLabel(o.reklamation.status))}</span><button class="mini ghost" onclick="openOrder('${esc(o.orderId)}')">Öffnen</button>`));

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
  renderDashAktion();
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
  if (F.rekla && !reklaOpen(o)) return false;
  if (F.period) {
    const t = new Date(o.createdAt).getTime();
    if (F.period === 'year') { if (new Date(o.createdAt).getFullYear() !== new Date().getFullYear()) return false; }
    else if (Date.now() - t > (+F.period) * 864e5) return false;
  }
  if (F.q) {
    const hay = [o.orderId, o.invoiceNo, custName(o), custEmail(o), o.customer?.city, o.customer?.zip, o.trackingNo, o.paypalOrderId,
      o.reklamation?.gutscheinCode, o.reklamation?.gutschriftNo, o.reklamation?.refundId,   // Gutscheincode / Gutschriftnummer / PayPal-Erstattung
      ...orderAktionen(o).map((a) => a.name),   // Bestellungen aus einer Aktion („Sommer“) — auch mehrere je Bestellung
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
  // Reklamations-Chip zählt offene Reklamationen (offen/ruecksendung/eingegangen) über alle anderen Filter; „Alle“ hebt ihn mit auf
  const rkBase = DATA.orders.filter((o) => { const s = F.status, r = F.rekla; F.status = ''; F.rekla = false; const ok = orderMatches(o) && reklaOpen(o); F.status = s; F.rekla = r; return ok; }).length;
  $('#f-status').innerHTML = [['', 'Alle', base.length], ...DATA.statuses.map((s) => [s, stLabel(s), counts[s] || 0])]
    .filter(([s, , n]) => !s || n || s === F.status)
    .map(([s, l, n]) => `<button class="chip ${F.status === s ? 'on' : ''}" onclick="F.status='${s}';${s ? '' : 'F.rekla=false;'}renderOrders()">${esc(l)}<span class="n">${n}</span></button>`).join('') +
    (rkBase || F.rekla ? `<button class="chip rk ${F.rekla ? 'on' : ''}" id="f-rekla" onclick="F.rekla=!F.rekla;renderOrders()" title="Nur Bestellungen mit offener Reklamation">↩️ Reklamation<span class="n">${rkBase}</span></button>` : '');
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
        <td data-l="Summe" class="num">${o.total != null ? money(o.total) : '—'}<br><small class="muted">${o.payment === 'paypal' ? 'PayPal' : 'Vorkasse'} ${o.paymentStatus === 'bezahlt' ? '<span title="bezahlt">✅</span>' : '<span title="offen">⏳</span>'}</small>${o.coupon ? `<br><small class="muted">🎟️ ${esc(o.coupon.code)}</small>` : ''}${orderAktionen(o).map((a) => `<br><small class="muted" title="Aktion${esc(orderAktionScope(a))} · Ersparnis ${esc(money(a.ersparnis))}">🔥 ${esc(a.name)} −${esc(a.prozent)} %</small>`).join('')}</td>
        <td data-l="Status"><span class="badge st-${st(o)}">${esc(stLabel(st(o)))}</span>${o.reklamation ? `<br><span class="badge rk-${esc(o.reklamation.status)}" title="${esc(rkStLabel(o.reklamation.status))} · ${esc(rkArtLabel(o.reklamation.art))}">↩️ Reklamation</span>` : ''}${o.trackingNo ? `<br><small class="muted trk">📮 ${esc(o.trackingNo)}</small>` : ''}</td>
        <td data-l="Druck">${p.total ? `<span class="prog"><i style="--w:${Math.round(p.done / p.total * 100)}%"></i>${p.done}/${p.total}</span>` : '—'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">Keine Treffer.</td></tr>') + '</tbody>';
}
function clearFilters() { F.q = ''; F.email = ''; F.rekla = false; $('#g-search').value = ''; renderOrders(); }
function filterByEmail(email) { F.email = email; F.q = ''; F.status = ''; $('#g-search').value = ''; show('orders'); renderOrders(); }

// ---------------------------------------------------------------------------
// Bestellung — Drawer
// ---------------------------------------------------------------------------
function openOrder(id) {
  if (!DATA.orders.some((o) => o.orderId === id)) return toast('Bestellung nicht gefunden', 'err');
  CUR = id;
  HIST_ALL = false;
  RK_NEW = false;
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
    const col = lineColor(l), tc = textColorOf(l), pr = l.print || { status: 'offen' }, g = gravurText(l), e = estimate(l), sur = surchargeLine(l), ak = aktionLine(l);
    return `<div class="line-card">
      <div class="lc-head">
        <div class="lc-qty">${l.qty}×</div>
        <div class="lc-main"><b>${esc(lineTitle(l))}</b>${l.off ? ` <span class="badge">−${l.off} %</span>` : ''}
          <div class="lc-meta">${esc(lineMeta(l))}${l.code ? ` · Code ${esc(l.code)}` : ''} · ≈ ${fmtDur(e.minutes)} / ${Math.round(e.grams)} g</div>
          ${g ? `<div class="lc-meta">✒️ ${esc(g)}</div>` : ''}
          <div class="lc-color"><span><span class="sw" style="background:${esc(col.hex)}"></span>${esc(col.name)}${col.finish && col.finish !== 'matt' ? ` <small class="muted">(${FINISHES[col.finish] || col.finish})</small>` : ''}</span>
            ${tc ? `<span><span class="sw" style="background:${esc(tc.hex)}"></span>Schrift: ${esc(tc.name)}</span>` : ''}</div>
          ${sur ? `<div class="lc-sur">💶 ${esc(sur)}</div>` : ''}
          ${ak ? `<div class="lc-ak">🔥 ${esc(ak)}</div>` : ''}
        </div>
        <div style="text-align:right">${l.unit != null ? `<b>${money(l.line)}</b><br><small class="muted">${ak ? `<s class="uvp" title="UVP (Preis vor der Aktion)">${money(l.uvp)}</s>` : ''}${money(l.unit)}/Stk.</small>` : ''}</div>
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
    <div class="sect"><h3>Positionen <span class="right">${pieces(o)} Stück · ${o.total != null ? money(o.total) : '—'}${o.shipping != null ? ` (Versand ${o.shipping ? money(o.shipping) : 'frei'})` : ''}</span></h3>
      ${orderAktionen(o).map((a) => `<div class="row" style="margin-bottom:10px"><span class="badge ak">🔥 ${esc(a.name)} −${esc(a.prozent)} %${esc(orderAktionScope(a))}</span><small class="muted">Ersparnis ${money(a.ersparnis)} — Summen bereits aus den reduzierten Preisen</small></div>`).join('')}${lines}</div>
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
    ${reklaCard(o)}
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
// Reklamation & Rückversand (Drawer-Karte) — Endpoint POST /api/admin/reklamation { orderId, action, notify?, … } → { ok, order }
// ---------------------------------------------------------------------------
const RK_TILES = [
  ['nachdruck', '🖨️', 'Nachdruck', 'neu drucken & senden'], ['gutschein', '🎟️', 'Gutschein-Code', 'Gutschrift als Code'],
  ['ueberweisung', '🏦', 'Überweisung', 'Erstattung aufs Konto'], ['paypal', '💙', 'PayPal', 'Erstattung über PayPal'],
];
const RK_DONE_LABEL = { gutschein: 'Erledigen: Gutschrift + Gutschein-Code erstellen', ueberweisung: 'Erledigen: Gutschrift erstellen (Überweisung selbst ausführen)', paypal: 'Erledigen: PayPal-Erstattung auslösen', nachdruck: 'Erledigen: Nachdruck bestätigen' };
/** Kunde informieren? Default = Versand aktiv und Auto-Status-Mails an */
const rkNotifyDefault = () => !!DATA.settings.mail?.enabled && DATA.settings.mail?.autoStatusMails !== false;
const rkNotifyBox = () => `<label class="inline"><input type="checkbox" id="rk-notify" ${rkNotifyDefault() ? 'checked' : ''}> Kunde per E-Mail informieren</label>`;
/** Formular „Reklamation anlegen“ (Art als Radio-Kacheln; PayPal nur bei PayPal-Bestellungen) */
function reklaForm(o, cancel) {
  const id = esc(o.orderId), total = euro(o.total);
  const tiles = RK_TILES.map(([a, ic, tt, sub]) => {
    const off = a === 'paypal' && o.payment !== 'paypal';
    return `<label class="rk-tile ${off ? 'off' : ''} ${a === 'nachdruck' ? 'on' : ''}" ${off ? 'title="Nur bei Bestellungen, die per PayPal bezahlt wurden"' : ''}><input type="radio" name="rk-art" value="${a}" ${a === 'nachdruck' ? 'checked' : ''} ${off ? 'disabled' : ''} onchange="reklaFormSync()"><span class="ic">${ic}</span><span class="tt">${tt}</span><small>${sub}</small></label>`;
  }).join('');
  return `<div id="rk-form">
      <label>Grund der Reklamation<textarea id="rk-grund" rows="2" placeholder="z. B. Riss im Boden, falsche Farbe, Gravur unleserlich …"></textarea></label>
      <div class="rk-tiles" id="rk-tiles">${tiles}</div>
      <div class="row" style="margin-top:10px">
        <label id="rk-betrag-wrap" hidden>Betrag (€) <small>max. ${money(total)}</small><input type="number" id="rk-betrag" min="0" max="${total}" step="0.01" value="${total}" style="width:120px"></label>
        <label id="rk-iban-wrap" hidden>IBAN des Kunden <small>optional — spätestens beim Erledigen</small><input id="rk-iban" placeholder="DE00 0000 0000 0000 0000 00" autocomplete="off" style="min-width:260px"></label>
      </div>
      <div class="row" style="margin-top:8px;gap:18px">
        <label class="inline"><input type="checkbox" id="rk-ruecksendung"> Rücksendung der Ware nötig</label>
        ${rkNotifyBox()}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="acc" onclick="reklaAnlegen('${id}')">↩️ Reklamation anlegen</button>
        ${cancel ? '<button class="ghost" onclick="RK_NEW=false;renderDrawer()">Abbrechen</button>' : ''}
      </div>
    </div>`;
}
/** Sichtbarkeit von Betrag/IBAN je gewählter Art (Fallback zu :has() für die Kachel-Markierung) */
function reklaFormSync() {
  const art = $('input[name="rk-art"]:checked')?.value || 'nachdruck';
  $('#rk-betrag-wrap').hidden = art === 'nachdruck';
  $('#rk-iban-wrap').hidden = art !== 'ueberweisung';
  $$('#rk-tiles .rk-tile').forEach((t) => t.classList.toggle('on', t.querySelector('input')?.value === art));
}
/** Karte „↩️ Reklamation & Rückversand“: Formular (ohne Reklamation) oder Stepper + Details + Aktionen */
function reklaCard(o) {
  const r = o.reklamation, id = esc(o.orderId);
  const head = (extra = '') => `<div class="sect" id="rk-card"><h3>↩️ Reklamation &amp; Rückversand ${extra}</h3>`;
  if (!r) return head() + reklaForm(o, false) + '</div>';
  const open = REKLA_OPEN.includes(r.status);
  // Stepper: Angelegt → (Rücksendung erwartet → Ware eingegangen) → Erledigt; Abgelehnt separat
  const needRet = r.ruecksendung || r.status === 'ruecksendung';
  const flow = ['offen', ...(needRet ? ['ruecksendung'] : []), ...(needRet || r.status === 'eingegangen' ? ['eingegangen'] : []), 'erledigt'];
  const label = (s) => (s === 'offen' ? 'Angelegt' : rkStLabel(s));
  const idx = flow.indexOf(r.status);
  const stepper = r.status === 'abgelehnt'
    ? `<span class="step cur">✕ ${esc(rkStLabel('abgelehnt'))}</span>${r.note ? `<span class="muted" style="font-size:.8rem">${esc(r.note)}</span>` : ''}`
    : flow.map((s, i) => `<span class="step ${i < idx ? 'done' : i === idx ? 'cur' : ''}">${i < idx ? '✓ ' : ''}${esc(label(s))}</span>`).join('<span class="step-arrow">›</span>');
  const phase = reklaPhase(r), sentAt = o.mailsSent?.[`reklamation:${phase}`];
  const kv = [
    ['Art', esc(rkArtLabel(r.art))],
    r.art !== 'nachdruck' ? ['Betrag', `<b>${money(r.betrag)}</b>`] : null,
    ['Grund', esc(r.grund || '—')],
    ['Rücksendung', r.ruecksendung ? 'ja — Ware wird zurückgeschickt' : 'nein'],
    ['Angelegt', fmtDT(r.createdAt) + (r.resolvedAt ? ` · ${r.status === 'abgelehnt' ? 'abgelehnt' : 'erledigt'} ${fmtDT(r.resolvedAt)}` : '')],
    r.art === 'ueberweisung' ? ['IBAN', r.iban ? `<code title="nur die letzten 4 Zeichen sichtbar">${esc(maskIban(r.iban))}</code>` : (open ? '<input id="rk-iban" placeholder="IBAN des Kunden — nötig zum Erledigen" autocomplete="off" style="min-width:260px">' : '—')] : null,
    r.gutscheinCode ? ['Gutschein-Code', `<span class="rk-code"><code>${esc(r.gutscheinCode)}</code><button class="ghost mini" data-copy="${esc(r.gutscheinCode)}">📋 Kopieren</button></span>`] : null,
    r.gutschriftNo ? ['Gutschrift', `<a href="/orders/${id}/gutschrift.html" target="_blank">🧾 ${esc(r.gutschriftNo)}</a>`] : null,
    r.refundId ? ['PayPal-Erstattung', `<code>${esc(r.refundId)}</code>`] : null,
    r.note && r.status !== 'abgelehnt' ? ['Notiz', esc(r.note)] : null,
  ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const again = r.status === 'abgelehnt' || (r.status === 'erledigt' && r.art === 'nachdruck');   // Server erlaubt dann eine neue Reklamation
  const actions = open ? `
      ${['offen', 'ruecksendung'].includes(r.status) ? `<button class="mini" onclick="reklaEingegangen('${id}')">📥 Ware eingegangen</button>` : ''}
      <button class="mini acc" onclick="reklaErledigen('${id}')">✅ ${RK_DONE_LABEL[r.art] || 'Erledigen'}</button>
      <button class="danger mini" onclick="reklaAblehnen('${id}')">✕ Ablehnen</button>
      ${['offen', 'ruecksendung'].includes(r.status) ? `<button class="ghost mini" onclick="reklaZurueck('${id}')">↶ Zurücknehmen</button>` : ''}` :
    (again ? `<button class="ghost mini" onclick="RK_NEW=true;renderDrawer()">+ Neue Reklamation anlegen</button>` : '');
  return head(`<span class="badge rk-${esc(r.status)}">${esc(rkStLabel(r.status))}</span>`) + `
      <div class="stepper">${stepper}</div>
      <dl class="kv" style="margin-top:10px">${kv}</dl>
      ${open ? `<div class="row" style="margin-top:10px">${rkNotifyBox()}</div>` : ''}
      <div class="row" style="margin-top:8px">${actions}</div>
      <div class="row" style="margin-top:10px">
        <span class="muted">Mail „${esc(RK_PHASE_LABEL[phase])}“${sentAt ? ` · ✅ gesendet ${fmtDT(sentAt)}` : ''}</span>
        <button class="ghost mini" onclick="reklaMail('${id}','preview')">👁 Vorschau</button>
        <button class="ghost mini" onclick="reklaMail('${id}','send')">📧 Senden</button>
      </div>
      ${RK_NEW && again ? `<div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)"><b style="font-size:.9rem">Neue Reklamation</b>${reklaForm(o, true)}</div>` : ''}
    </div>`;
}
/** POST /api/admin/reklamation — Fehler lesbar (z. B. PayPal), 404 = Server noch ohne Endpoint */
async function reklaApi(body) {
  const r = await api('/api/admin/reklamation', { method: 'POST', body: JSON.stringify(body) });
  if (r.notReady) { toast('Reklamationen sind auf dem Server noch nicht eingerichtet — bitte später noch einmal versuchen.', 'info', 5000); return null; }
  if (!r.ok) { toast('❌ ' + (r.error || 'Fehler'), 'err', 7000); return null; }
  if (r.info) toast(r.info, 'info', 5000);
  return r;
}
const rkNotify = () => { const el = $('#rk-notify'); return el ? !!el.checked : rkNotifyDefault(); };
async function reklaAnlegen(id) {
  const o = DATA.orders.find((x) => x.orderId === id);
  if (!o) return;
  const grund = $('#rk-grund').value.trim();
  const art = $('input[name="rk-art"]:checked')?.value || 'nachdruck';
  if (!grund) return toast('Bitte einen Grund angeben', 'err');
  if (!REKLA_ART[art]) return toast('Bitte eine Art wählen', 'err');
  const total = euro(o.total);
  const betrag = art === 'nachdruck' ? undefined : euro($('#rk-betrag').value);
  if (betrag !== undefined && (betrag <= 0 || betrag > total + 1e-9)) return toast(`Betrag muss zwischen 0,01 € und ${money(total)} (Bestellsumme) liegen`, 'err');
  const ruecksendung = !!$('#rk-ruecksendung').checked, notify = rkNotify();
  const iban = art === 'ueberweisung' ? $('#rk-iban').value.trim() : '';
  const what = art === 'nachdruck' ? 'Nachdruck — alle Positionen gehen zurück in die Druckwarteschlange' : `${rkArtLabel(art)} über ${money(betrag)}`;
  if (!confirm(`Reklamation für ${id} anlegen?\n${what}${ruecksendung ? '\nRücksendung der Ware wird erwartet.' : ''}${notify ? '\nDer Kunde wird per E-Mail informiert.' : ''}`)) return;
  const body = { orderId: id, action: 'anlegen', art, grund, ruecksendung, notify };
  if (betrag !== undefined) body.betrag = betrag;
  if (iban) body.iban = iban;
  const r = await reklaApi(body);
  if (!r) return;
  RK_NEW = false;
  applyOrder(r.order);
  toast(`Reklamation für ${id} angelegt${art === 'nachdruck' ? ' — Positionen wieder in der Druckwarteschlange' : ''}`, 'ok');
}
async function reklaEingegangen(id) {
  const note = prompt('Ware eingegangen — Notiz zum Zustand (optional):', '');
  if (note === null) return;
  const r = await reklaApi({ orderId: id, action: 'eingegangen', note: note.trim(), notify: rkNotify() });
  if (!r) return;
  applyOrder(r.order);
  toast(`${id}: Ware eingegangen`, 'ok');
}
async function reklaErledigen(id) {
  const o = DATA.orders.find((x) => x.orderId === id), r0 = o?.reklamation;
  if (!r0) return;
  const body = { orderId: id, action: 'erledigen', notify: rkNotify() };
  if (r0.art === 'ueberweisung' && !r0.iban) {
    const iban = ($('#rk-iban')?.value || '').trim();
    if (!iban) return toast('Für die Erstattung per Überweisung fehlt die IBAN des Kunden', 'err');
    body.iban = iban;
  }
  const what = { gutschein: `Gutschrift über ${money(r0.betrag)} erstellen und einen Gutschein-Code anlegen`, ueberweisung: `Gutschrift über ${money(r0.betrag)} erstellen — die Überweisung führst du selbst aus`,
    paypal: `${money(r0.betrag)} über PayPal erstatten (Geld geht sofort raus)`, nachdruck: 'Nachdruck als erledigt bestätigen' }[r0.art] || 'Reklamation erledigen';
  if (!confirm(`${id}: ${what}?${body.notify ? '\nDer Kunde wird per E-Mail informiert.' : ''}`)) return;
  const r = await reklaApi(body);
  if (!r) return;
  applyOrder(r.order);
  const rr = r.order.reklamation || {};
  toast(`${id} erledigt${rr.gutscheinCode ? ` · Gutschein ${rr.gutscheinCode}` : ''}${rr.gutschriftNo ? ` · Gutschrift ${rr.gutschriftNo}` : ''}${rr.refundId ? ' · PayPal erstattet' : ''}`, 'ok', 6000);
}
async function reklaAblehnen(id) {
  const grund = prompt('Reklamation ablehnen — Begründung für den Kunden:', '');
  if (grund === null) return;
  if (!grund.trim()) return toast('Bitte eine Begründung angeben', 'err');
  const r = await reklaApi({ orderId: id, action: 'ablehnen', grund: grund.trim(), notify: rkNotify() });
  if (!r) return;
  applyOrder(r.order);
  toast(`${id}: Reklamation abgelehnt`, 'ok');
}
async function reklaZurueck(id) {
  if (!confirm(`Reklamation zu ${id} zurücknehmen? Sie wird gelöscht, als wäre sie nie angelegt worden.`)) return;
  const r = await reklaApi({ orderId: id, action: 'zuruecknehmen' });
  if (!r) return;
  applyOrder(r.order);
  toast(`${id}: Reklamation zurückgenommen`, 'ok');
}
/** Reklamations-Mail der aktuellen Phase: Vorschau (Dialog mit „Jetzt senden“) oder direkt senden */
async function reklaMail(id, mode) {
  const o = DATA.orders.find((x) => x.orderId === id);
  if (!o?.reklamation) return;
  const phase = reklaPhase(o.reklamation);
  if (mode === 'preview') return mailPreview(id, 'reklamation', { phase });
  if (!confirm(`Reklamations-Mail „${RK_PHASE_LABEL[phase]}“ an ${custEmail(o)} senden?`)) return;
  const r = await api('/api/admin/mail-send', { method: 'POST', body: JSON.stringify({ orderId: id, kind: 'reklamation', phase }) });
  if (r.notReady) return notReady();
  if (!r.ok) return toast(r.error || 'Senden fehlgeschlagen', 'err', 5000);
  toast('E-Mail gesendet', 'ok');
  const rr = await api(`/api/admin/order/${encodeURIComponent(id)}`);   // mailsSent nachladen („✅ gesendet …“)
  if (rr.ok && rr.order) applyOrder(rr.order);
}
/** Text in die Zwischenablage (Fallback execCommand für http://) */
async function copyText(text) {
  let ok = false;
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch { ok = false; }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    ($$('dialog[open]').pop() || document.body).appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  toast(ok ? `📋 Kopiert: ${text}` : 'Kopieren nicht möglich — bitte markieren und kopieren', ok ? 'ok' : 'err');
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
      <label class="f-sw"><span class="sw" style="background:${esc(c.hex)}"></span><input type="color" value="${esc(c.hex)}" onchange="colors[${i}].hex=this.value;renderColors()" title="${esc(c.hex)}">${plusBadge(c.aufpreis)}</label>
      <label>Name<input type="text" value="${esc(c.name)}" onchange="colors[${i}].name=this.value" style="width:130px"></label>
      <label>Finish<select onchange="colors[${i}].finish=this.value">${Object.entries(FINISHES).map(([k, l]) => `<option value="${k}" ${(c.finish || 'matt') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="grow">Notiz<input type="text" value="${esc(c.note || '')}" onchange="colors[${i}].note=this.value" placeholder="z. B. Bambu PLA Silk"></label>
      <label>Bestand (g)<input type="number" min="0" step="10" value="${c.stock ?? ''}" placeholder="—" onchange="colors[${i}].stock=this.value===''?null:+this.value;renderColors()" style="width:88px"></label>
      <label>Aufpreis (€)<input type="number" min="0" step="0.5" value="${euroField(c.aufpreis)}" placeholder="0" title="Aufpreis je Stück für diese Körperfarbe (leer = 0)" onchange="colors[${i}].aufpreis=euro(this.value);renderColors()" style="width:88px"></label>
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
  colors.push({ id: 'farbe-' + Date.now().toString(36), name: 'Neue Farbe', hex: '#a0a0a0', finish: 'matt', note: '', stock: null, aufpreis: 0, active: true });
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
  // Spalte „mit Aktion kombinierbar“ (coupons[i].mitAktion, Vertrag „Aktionen“): ohne Haken lehnt der Server den Code ab, solange eine Aktion läuft
  $('#coupons-table').innerHTML = `<thead><tr><th>Code</th><th>Art</th><th>Wert</th><th>Mindestbestellwert (€)</th><th>Aktiv</th><th title="Gilt der Gutschein auch, während eine Aktion läuft? Ohne Haken wird er dann abgelehnt.">mit Aktion kombinierbar</th><th></th></tr></thead><tbody>` +
    coupons.map((c, i) => `<tr>
      <td data-l="Code"><input type="text" value="${esc(c.code)}" onchange="coupons[${i}].code=this.value.toUpperCase()" style="width:140px;text-transform:uppercase"></td>
      <td data-l="Art"><select onchange="coupons[${i}].type=this.value"><option value="percent" ${c.type === 'percent' ? 'selected' : ''}>% Rabatt</option><option value="fixed" ${c.type === 'fixed' ? 'selected' : ''}>€ Betrag</option></select></td>
      <td data-l="Wert"><input type="number" min="0" value="${c.value}" onchange="coupons[${i}].value=+this.value"></td>
      <td data-l="Mindestwert"><input type="number" min="0" value="${c.minOrder || 0}" onchange="coupons[${i}].minOrder=+this.value"></td>
      <td data-l="Aktiv" style="text-align:center"><input type="checkbox" ${c.active ? 'checked' : ''} onchange="coupons[${i}].active=this.checked"></td>
      <td data-l="mit Aktion" style="text-align:center"><input type="checkbox" ${c.mitAktion ? 'checked' : ''} onchange="coupons[${i}].mitAktion=this.checked" title="Mit laufender Aktion kombinierbar"></td>
      <td><button class="ghost mini" onclick="coupons.splice(${i},1);setDirty(true);renderCoupons()">🗑</button></td>
    </tr>`).join('') + (coupons.length ? '' : '<tr><td colspan="7" class="empty">Noch keine Gutscheine.</td></tr>') + '</tbody>';
}
function addCoupon() { coupons.push({ code: 'OSTERN10', type: 'percent', value: 10, minOrder: 0, active: true, mitAktion: false }); setDirty(true); renderCoupons(); }

// ---------------------------------------------------------------------------
// Aktionen (Vertrag „Aktionen“, Punkt 8): Karten mit Formular, Status-Chip + Countdown, Schnellwahl der Dauer, Banner-Vorschau.
// Oberflächen (Vertrag „Aktionen auf Oberflächen“, Punkt 10): je Karte 9 Chips + Schalter „Alle Oberflächen“ → aktionen[i].muster
// (Array der Muster-Keys, [] = alle). Mehrere Aktionen dürfen gleichzeitig laufen; je Konfiguration gilt die erste passende
// der sortierten Liste (akLaufende: Prozent absteigend, dann engerer Bereich, dann früherer Start — wie aktiveAktionen() im Server).
// Zeit: akNow() = Rechnerzeit + Versatz zur Serverzeit (DATA.serverNow beim Laden) — der Server entscheidet, was im Shop gilt.
// datetime-local ↔ ISO-UTC: toLocalInput() zeigt Ortszeit, fromLocalInput() speichert new Date(local).toISOString().
// ---------------------------------------------------------------------------
const AK_PRODUKTE = { alle: 'Alle Produkte', eierbecher: 'Nur Eierbecher', vase: 'Nur Vasen' };
const AK_PRODUKT_LABEL = { vase: 'Vasen', eierbecher: 'Eierbecher' };   // Geltungsbereich „auf Vasen“ (wie AKTION_PRODUKT_LABEL in lib/mail-templates.js)
const AK_MUSTER = PATTERNS;   // Oberflächen-Chips: Muster-Key → Label (gleiche Tabelle wie die Aufpreise)
/**
 * Oberflächen einer Aktion wie sanitizeAktionMuster() im Server: nur bekannte Muster-Keys, ohne Duplikate, in der Reihenfolge
 * von MUSTER_KEYS; leer = alle Oberflächen — sind alle neun gewählt, ebenfalls []. Ein einzelner String zählt als ein Key.
 */
function akMusterNorm(v) {
  const raw = Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? v.split(',') : []);
  const set = new Set(raw.map((k) => String(k ?? '').trim()).filter((k) => k in AK_MUSTER));
  return set.size >= MUSTER_KEYS.length ? [] : MUSTER_KEYS.filter((k) => set.has(k));
}
/**
 * Geltungsbereich als Text — identisch mit aktionScopeLabel() in lib/mail-templates.js (Server: Rechnung, CSV, Mail; Client: pricing.js):
 * „auf alles“ · „auf Vasen“ · „auf Gehämmert“ · „auf Vasen mit Gehämmert“ · „auf Rippen, Wellen und Lamellen“
 * (bis 3 Oberflächen ausgeschrieben, ab 4: „auf 4 Oberflächen“; mit Produkt: „auf Eierbecher mit Rippen oder Wellen“).
 */
function aktionScopeLabel(a) {
  const prod = AK_PRODUKT_LABEL[a?.produkte] || '';
  const names = akMusterNorm(a?.muster).map((k) => AK_MUSTER[k]);
  let flaechen = '';
  if (names.length >= 4) flaechen = `${names.length} Oberflächen`;
  else if (names.length === 1) flaechen = names[0];
  else if (names.length) flaechen = `${names.slice(0, -1).join(', ')} ${prod ? 'oder' : 'und'} ${names[names.length - 1]}`;
  if (prod && flaechen) return `auf ${prod} mit ${flaechen}`;
  if (prod) return `auf ${prod}`;
  if (flaechen) return `auf ${flaechen}`;
  return 'auf alles';
}
const AK_STATUS_LABEL = { laeuft: 'läuft', geplant: 'geplant', beendet: 'beendet', pausiert: 'pausiert' };
const AK_QUICK = { '24h': '24 h', '3d': '3 Tage', '1w': '1 Woche', we: 'Wochenende (bis So 23:59)' };
let AK_OFFSET = 0;        // Serverzeit − Rechnerzeit (ms), aus DATA.serverNow
let AK_TIMER = null;      // sekündlicher Countdown-Ticker
const akNow = () => Date.now() + AK_OFFSET;
const newAktionId = () => `ak-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
/** ISO-UTC → Wert für <input type="datetime-local"> in Ortszeit („2026-09-14T08:00“), leer wenn ungültig */
function toLocalInput(iso) {
  const d = new Date(iso || NaN);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** datetime-local (Ortszeit) → ISO-UTC, null wenn leer/ungültig */
function fromLocalInput(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
/** Restzeit-Text (Vertrag Punkt 5): „1 Tag 3 Std“ · unter 24 h „3 Std 12 Min“ · unter 1 h „12:34 Min“ · unter 1 Min „gleich“ */
function restText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'gleich';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d >= 1) return `${d} ${d === 1 ? 'Tag' : 'Tage'} ${h} Std`;
  if (h >= 1) return `${h} Std ${m} Min`;
  return `${m}:${String(sec).padStart(2, '0')} Min`;
}
/** „endet in 3 Std 12 Min“ / „endet gleich“ (Präfix: endet · beginnt) */
const inText = (prefix, ms) => (ms < 60e3 ? `${prefix} gleich` : `${prefix} in ${restText(ms)}`);
/** Status einer Aktion zum Zeitpunkt now: pausiert (nicht aktiv/ungültige Zeiten) · geplant · läuft · beendet */
function akStatus(a, now = akNow()) {
  if (!a?.aktiv) return 'pausiert';
  const s = Date.parse(a.start), e = Date.parse(a.ende);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 'pausiert';
  if (now < s) return 'geplant';
  if (now >= e) return 'beendet';
  return 'laeuft';
}
/** Größe des Geltungsbereichs (Produkte × Oberflächen) — kleiner = enger; Reihenfolge bei gleichem Prozentsatz (wie aktionScopeSize() im Server) */
const akScopeSize = (a) => (a.produkte === 'alle' || !AK_PRODUKT_LABEL[a.produkte] ? 2 : 1) * (akMusterNorm(a.muster).length || MUSTER_KEYS.length);
/**
 * Alle gerade laufenden Aktionen in Shop-Reihenfolge (wie aktiveAktionen() im Server): Prozent absteigend, bei Gleichstand
 * engerer Geltungsbereich zuerst, dann frühere Startzeit. aktionen[0] ist die primäre (Banner); je Konfiguration gilt die erste passende.
 */
function akLaufende(list, now = akNow()) {
  return (list || []).filter((a) => akStatus(a, now) === 'laeuft')
    .sort((x, y) => (Number(y.prozent) || 0) - (Number(x.prozent) || 0) || akScopeSize(x) - akScopeSize(y) || Date.parse(x.start) - Date.parse(y.start));
}
/** Überschneiden sich die Geltungsbereiche zweier Aktionen (gemeinsames Produkt UND gemeinsame Oberfläche)? Dann gilt dort der höhere Rabatt. */
function akOverlap(a, b) {
  const pa = a.produkte || 'alle', pb = b.produkte || 'alle';
  if (pa !== 'alle' && pb !== 'alle' && pa !== pb) return false;
  const ma = akMusterNorm(a.muster), mb = akMusterNorm(b.muster);
  return !ma.length || !mb.length || ma.some((k) => mb.includes(k));
}
/** Formularprüfung (wie sanitizeAktion() im Server) — Meldung oder leer */
function akError(a) {
  if (!String(a.name || '').trim()) return 'Bitte einen Namen angeben.';
  const p = Number(a.prozent);
  if (!Number.isInteger(p) || p < 1 || p > 90) return 'Rabatt muss eine ganze Zahl zwischen 1 und 90 % sein.';
  const s = Date.parse(a.start), e = Date.parse(a.ende);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 'Bitte Start und Ende angeben.';
  if (e <= s) return 'Das Ende muss nach dem Start liegen.';
  if (a.musterWahl && !akMusterNorm(a.muster).length) return 'Bitte mindestens eine Oberfläche wählen — oder „Alle Oberflächen“ einschalten.';
  return '';
}
/** Zweite Zeile im Kartenkopf: Countdown bzw. Zeitraum je Status; bei laufenden Aktionen Platz im Banner und Überschneidungen mit anderen laufenden */
function akCdText(a, now = akNow()) {
  const stt = akStatus(a, now), s = Date.parse(a.start), e = Date.parse(a.ende);
  if (stt === 'laeuft') {
    const run = akLaufende(aktionen, now), rank = run.indexOf(a);
    let t = inText('endet', e - now);
    if (rank > 0) t += ` · im Banner hinter „${String(run[0].name || '').trim() || 'Aktion'}“`;
    // Überschneidung: gleiche Konfiguration von beiden erfasst — im Shop gilt dort die vordere der Liste (höherer Rabatt bzw. engerer Bereich)
    const ov = run.filter((o) => o !== a && akOverlap(a, o));
    for (const o of ov) t += run.indexOf(o) < rank ? ` · bei Überschneidung gilt „${String(o.name || '').trim() || 'Aktion'}“ (−${Math.round(Number(o.prozent) || 0)} %)` : ` · geht bei Überschneidung vor „${String(o.name || '').trim() || 'Aktion'}“`;
    return t;
  }
  if (stt === 'geplant') return `ab ${fmtDT(a.start)} · ${inText('beginnt', s - now)}`;
  if (stt === 'beendet') return `endete am ${fmtDT(a.ende)}`;
  return Number.isFinite(s) && Number.isFinite(e) ? `nicht im Shop · ${fmtDT(a.start)} – ${fmtDT(a.ende)}` : 'nicht im Shop';
}
/** Kurzform einer weiteren laufenden Aktion für den Desktop-Banner: „Winter −16 % auf alles“ */
const akKurz = (a) => `${esc(String(a.name || '').trim() || 'Aktion')} <b>−${Math.round(Number(a.prozent) || 0)} %</b> ${esc(aktionScopeLabel(a))}`;
/**
 * Bannerzeile wie im Shop (Vertrag 6a / Oberflächen 7): „🔥 Sommer: −30 % auf Gehämmert · endet in 1 Tag 3 Std · Hinweis“ — als HTML
 * mit Fraunces-Zahlen. Läuft die Aktion als primäre und noch eine zweite, hängt der Desktop-Banner „ · außerdem: Winter −16 % auf alles“ an.
 */
function akBannerHTML(a, now = akNow(), list = aktionen) {
  const s = Date.parse(a.start), e = Date.parse(a.ende);
  const ref = Number.isFinite(s) ? Math.max(now, s) : now;   // geplant: Countdown ab dem Start gerechnet
  const cd = Number.isFinite(e) ? inText('endet', e - ref) : 'endet —';
  const run = akLaufende(list, now);
  const zweite = run[0] === a ? run[1] : null;
  return `🔥 <b>${esc(String(a.name || '').trim() || 'Aktion')}</b>: <b>−${Math.round(Number(a.prozent) || 0)} %</b> ${esc(aktionScopeLabel(a))} · ${cd}${String(a.hinweis || '').trim() ? ` · ${esc(String(a.hinweis).trim())}` : ''}${zweite ? ` · außerdem: ${akKurz(zweite)}` : ''}`;
}
/** Oberflächen-Block einer Karte: Schalter „Alle Oberflächen“ (muster []) + 9 Chips (Mehrfachauswahl); Chips gedämpft, solange „Alle“ gilt */
function akMusterHTML(a, i) {
  const sel = akMusterNorm(a.muster), alle = !sel.length && !a.musterWahl;
  return `<div class="ak-muster${alle ? ' alle' : ''}" id="ak-muster-${i}">
        <div class="ak-muster-head"><span class="lbl">Oberflächen <small>Rabatt nur auf diese Muster, z. B. „nur Gehämmert“</small></span>
          <label class="inline"><span class="switch"><input type="checkbox" id="ak-alle-${i}" ${alle ? 'checked' : ''} onchange="akMusterAlle(${i},this.checked)"><span></span></span> Alle Oberflächen</label></div>
        <div class="ak-chips">${MUSTER_KEYS.map((k) => `<label class="ak-mchip${alle || sel.includes(k) ? ' on' : ''}" data-muster="${k}"><input type="checkbox" value="${k}" ${sel.includes(k) ? 'checked' : ''} onchange="akMusterToggle(${i},'${k}',this.checked)">${esc(AK_MUSTER[k])}</label>`).join('')}</div>
      </div>`;
}
function akCardHTML(a, i) {
  const id = esc(a.id);
  return `<div class="card ak-card" id="ak-card-${i}">
      <div class="ak-head">
        <span class="ak-title" id="ak-title-${i}">${esc(String(a.name || '').trim() || 'Aktion')}</span>
        <span class="ak-pct" id="ak-pct-${i}">−${Math.round(Number(a.prozent) || 0)} %</span>
        <span class="badge" id="ak-chip-${i}"></span>
        <span class="ak-cd" id="ak-cd-${i}"></span>
        <label class="inline right"><span class="switch"><input type="checkbox" ${a.aktiv ? 'checked' : ''} onchange="akSet(${i},'aktiv',this.checked)"><span></span></span> Aktiv</label>
      </div>
      <div class="grid">
        <label>Name <small>im Banner, ≤ 60 Zeichen</small><input type="text" id="ak-name-${i}" maxlength="60" value="${esc(a.name || '')}" placeholder="z. B. Sommeraktion" oninput="akSet(${i},'name',this.value)"></label>
        <label>Rabatt (%) <small>1–90, auf den Stückpreis</small><input type="number" min="1" max="90" step="1" value="${Number.isFinite(Number(a.prozent)) ? a.prozent : ''}" oninput="akSet(${i},'prozent',this.value)"></label>
        <label>Start <small>Ortszeit</small><input type="datetime-local" id="ak-start-${i}" value="${toLocalInput(a.start)}" onchange="akSet(${i},'start',this.value)"></label>
        <label>Ende <small>Ortszeit</small><input type="datetime-local" id="ak-ende-${i}" value="${toLocalInput(a.ende)}" onchange="akSet(${i},'ende',this.value)"></label>
        <label>Produkte<select onchange="akSet(${i},'produkte',this.value)">${Object.entries(AK_PRODUKTE).map(([k, l]) => `<option value="${k}" ${(a.produkte || 'alle') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Hinweis <small>optional, Zusatz im Banner, ≤ 120</small><input type="text" maxlength="120" value="${esc(a.hinweis || '')}" placeholder="z. B. nur solange der Vorrat reicht" oninput="akSet(${i},'hinweis',this.value)"></label>
      </div>
      ${akMusterHTML(a, i)}
      <div class="ak-quick"><span class="lbl">Dauer ab jetzt:</span>${Object.entries(AK_QUICK).map(([k, l]) => `<button class="ghost mini" onclick="akQuick(${i},'${k}')">${l}</button>`).join('')}</div>
      <label class="inline" style="margin-top:12px"><input type="checkbox" ${a.mengenrabatt ? 'checked' : ''} onchange="akSet(${i},'mengenrabatt',this.checked)"> Mengenrabatt zusätzlich gewähren <small class="muted">— sonst entfällt die Mengenstaffel, solange die Aktion läuft</small></label>
      <div class="ak-banner-l">Vorschau der Bannerzeile im Shop</div>
      <div class="ak-banner" id="ak-banner-${i}"></div>
      <div class="ak-err" id="ak-err-${i}"></div>
      <div class="ak-foot"><small class="muted">ID <code>${id}</code></small><button class="danger mini right" onclick="deleteAktion(${i})">🗑 Aktion löschen</button></div>
    </div>`;
}
function renderAktionen() {
  $('#aktionen-list').innerHTML = aktionen.map(akCardHTML).join('') || '<div class="card"><p class="empty">Noch keine Aktion — mit „+ Neue Aktion“ legst du einen zeitlich begrenzten Rabatt an, z. B. −15 % übers Wochenende.</p></div>';
  aktionen.forEach((_, i) => akRefresh(i));
}
/** Dynamische Teile einer Karte (Status-Chip, Countdown, Vorschau, Fehler) — ohne Formular-Neuaufbau, damit der Fokus bleibt */
function akRefresh(i) {
  const a = aktionen[i];
  const card = $(`#ak-card-${i}`);
  if (!a || !card) return;
  const now = akNow(), stt = akStatus(a, now), err = akError(a);
  card.className = `card ak-card ${stt}${err ? ' invalid' : ''}`;
  $(`#ak-title-${i}`).textContent = String(a.name || '').trim() || 'Aktion';
  $(`#ak-pct-${i}`).textContent = `−${Math.round(Number(a.prozent) || 0)} %`;
  const chip = $(`#ak-chip-${i}`);
  chip.className = `badge ak-${stt}`; chip.textContent = AK_STATUS_LABEL[stt];
  $(`#ak-cd-${i}`).textContent = akCdText(a, now);
  const banner = $(`#ak-banner-${i}`);
  const rank = stt === 'laeuft' ? akLaufende(aktionen, now).indexOf(a) : -1;
  banner.innerHTML = akBannerHTML(a, now); banner.className = `ak-banner${stt === 'laeuft' ? '' : ' off'}`;
  banner.title = stt === 'laeuft'
    ? (rank > 0 ? 'Läuft gerade — im Shop steht diese Zeile als „außerdem: …“ hinter der primären Aktion (auf dem Handy nur die primäre)' : 'So erscheint die Leiste gerade im Shop')
    : `Erscheint im Shop, sobald die Aktion läuft (${AK_STATUS_LABEL[stt]})`;
  $(`#ak-err-${i}`).textContent = err;
}
/** Oberflächen-Chips und „Alle“-Schalter einer Karte mit dem Zustand abgleichen (nach Klick; nie beim Sekunden-Ticker) */
function akMusterRefresh(i) {
  const a = aktionen[i], box = $(`#ak-muster-${i}`);
  if (!a || !box) return;
  const sel = akMusterNorm(a.muster), alle = !sel.length && !a.musterWahl;
  box.classList.toggle('alle', alle);
  const sw = $(`#ak-alle-${i}`);
  if (sw) sw.checked = alle;
  for (const chip of $$('.ak-mchip', box)) {
    const k = chip.dataset.muster, on = sel.includes(k);
    chip.classList.toggle('on', alle || on);
    const cb = $('input', chip);
    if (cb) cb.checked = on;
  }
}
/**
 * Chip an/aus. musterWahl (nur im Admin, nicht im Payload) = „Schalter aus, aber noch kein Chip gewählt“ — dann meldet akError,
 * bis eine Oberfläche gewählt ist. Sind alle neun gewählt (oder der letzte Chip abgewählt), wird muster [] gespeichert:
 * bei allen neun gilt wieder „Alle Oberflächen“, beim Abwählen des letzten bleibt die Auswahl offen (Fehlermeldung).
 */
function akMusterToggle(i, key, on) {
  const a = aktionen[i];
  if (!a || !(key in AK_MUSTER)) return;
  const set = new Set(akMusterNorm(a.muster));
  if (on) set.add(key); else set.delete(key);
  const alleNeun = set.size >= MUSTER_KEYS.length;
  a.muster = alleNeun ? [] : MUSTER_KEYS.filter((k) => set.has(k));
  a.musterWahl = !a.muster.length && !alleNeun;
  setDirty(true);
  akMusterRefresh(i); akRefresh(i);
}
/** Schalter „Alle Oberflächen“: an → muster [] (alle); aus → Auswahl beginnt leer, bis mindestens ein Chip gewählt ist (akError) */
function akMusterAlle(i, on) {
  const a = aktionen[i];
  if (!a) return;
  a.muster = [];
  a.musterWahl = !on;
  setDirty(true);
  akMusterRefresh(i); akRefresh(i);
}
/** Feldänderung aus dem Formular (Werte kommen aus this.value/this.checked, nie aus dem Markup) */
function akSet(i, field, value) {
  const a = aktionen[i];
  if (!a) return;
  if (field === 'prozent') a.prozent = value === '' ? NaN : Number(value);
  else if (field === 'start' || field === 'ende') a[field] = fromLocalInput(value);
  else if (field === 'aktiv' || field === 'mengenrabatt') a[field] = !!value;
  else if (field === 'produkte') a.produkte = AK_PRODUKTE[value] ? value : 'alle';
  else if (field === 'name' || field === 'hinweis') a[field] = String(value ?? '');
  else return;
  setDirty(true);
  akRefresh(i);
}
/** Schnellwahl der Dauer: Start = jetzt (volle Minute; ein noch nicht erreichter Start bleibt), Ende = Start + Dauer bzw. Sonntag 23:59 */
function akQuick(i, kind) {
  const a = aktionen[i];
  if (!a || !AK_QUICK[kind]) return;
  const now = akNow();
  const s = Date.parse(a.start);
  const start = Number.isFinite(s) && s > now ? s : Math.floor(now / 60e3) * 60e3;
  let end;
  if (kind === 'we') {
    const d = new Date(start);
    d.setDate(d.getDate() + (7 - d.getDay()) % 7);   // nächster Sonntag (heute, wenn Sonntag)
    d.setHours(23, 59, 0, 0);
    if (d.getTime() <= start) d.setDate(d.getDate() + 7);
    end = d.getTime();
  } else end = start + { '24h': 864e5, '3d': 3 * 864e5, '1w': 7 * 864e5 }[kind];
  a.start = new Date(start).toISOString(); a.ende = new Date(end).toISOString();
  const si = $(`#ak-start-${i}`), ei = $(`#ak-ende-${i}`);
  if (si) si.value = toLocalInput(a.start);
  if (ei) ei.value = toLocalInput(a.ende);
  setDirty(true);
  akRefresh(i);
}
function addAktion() {
  const start = Math.floor(akNow() / 60e3) * 60e3;
  aktionen.unshift({ id: newAktionId(), name: 'Neue Aktion', prozent: 15, start: new Date(start).toISOString(), ende: new Date(start + 3 * 864e5).toISOString(), produkte: 'alle', muster: [], mengenrabatt: false, hinweis: '', aktiv: true });
  setDirty(true); renderAktionen();
  show('aktionen');
  $('#ak-name-0')?.focus?.();
}
function deleteAktion(i) {
  const a = aktionen[i];
  if (!a) return;
  const stt = akStatus(a);
  if (!confirm(`Aktion „${String(a.name || '').trim() || 'Aktion'}“ löschen?${stt === 'laeuft' ? '\nSie läuft gerade — nach dem Speichern verschwinden Banner und Streichpreise im Shop.' : ''}`)) return;
  aktionen.splice(i, 1); setDirty(true); renderAktionen();
}
/**
 * Übersicht: ALLE laufenden Aktionen „🔥 2 Aktionen laufen: Sommer −30 % auf Gehämmert · endet in … | Winter −16 % auf alles · endet in …“
 * (Shop-Reihenfolge; Hinweis bei Überschneidung) bzw. „Aktion geplant: … ab …“ — aus den gespeicherten Aktionen (Server-Stand)
 */
function renderDashAktion() {
  const el = $('#dash-aktion');
  if (!el || !DATA) return;
  const now = akNow(), list = DATA.settings.aktionen || [];
  const run = akLaufende(list, now);
  const next = list.filter((a) => akStatus(a, now) === 'geplant').sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  let html = '';
  if (run.length) {
    const items = run.map((a) => `<span class="dash-ak-it">${esc(a.name)} <b class="ak-pct">−${Math.round(Number(a.prozent) || 0)} %</b> ${esc(aktionScopeLabel(a))} · ${esc(inText('endet', Date.parse(a.ende) - now))}${a.mengenrabatt ? '' : ' · ohne Mengenrabatt'}</span>`);
    const overlap = run.some((a, i) => run.slice(i + 1).some((b) => akOverlap(a, b)));
    html = `🔥 <b>${run.length === 1 ? 'Aktion läuft:' : `${run.length} Aktionen laufen:`}</b> ${items.join('<span class="dash-ak-sep">|</span>')}${overlap ? '<small class="dash-ak-note">Bei Überschneidung gilt je Konfiguration der höhere Rabatt</small>' : ''}`;
  } else if (next) html = `🔥 <b>Aktion geplant:</b> ${esc(next.name)} <b class="ak-pct">−${Math.round(Number(next.prozent) || 0)} %</b> ${esc(aktionScopeLabel(next))} · ab ${fmtDT(next.start)} (${esc(inText('beginnt', Date.parse(next.start) - now))})`;
  el.hidden = !html;
  el.classList.toggle('geplant', !run.length && !!next);
  if (html !== el.dataset.last) { el.innerHTML = html; el.dataset.last = html; }   // nur schreiben, wenn sich der Text ändert
}
/** Sekündlicher Ticker: Countdown in Karten (nur im Bereich Aktionen) und in der Übersicht */
function akTick() {
  if (!DATA || $('#app').hidden) return;
  if (PANE === 'aktionen') aktionen.forEach((_, i) => akRefresh(i));
  if (PANE === 'dash') renderDashAktion();
}
function akStartTicker() {
  if (AK_TIMER || typeof setInterval !== 'function') return;
  AK_TIMER = setInterval(akTick, 1000);
}

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
  // Aufpreise (Vertrag): Farbschrift zusätzlich zur Gravur, Muster je Key — fehlender Key = 0 (leeres Feld)
  $('#s-farbschrift').value = euroField(s.pricing.farbschrift ?? 0);
  for (const k of MUSTER_KEYS) $(`#s-muster-${k}`).value = euroField(s.pricing.muster?.[k] ?? 0);
  $('#s-vol-pct').value = s.pricing.volumen?.prozent ?? 60;
  $('#s-vol-eur').value = s.pricing.volumen?.euro ?? 0;
  $('#s-ship-flat').value = s.pricing.shipping.flat;
  $('#s-ship-free').value = s.pricing.shipping.freeFrom;
  tiers.egg = structuredClone(s.pricing.eierbecher.discounts || []);
  tiers.vase = structuredClone(s.pricing.vase.discounts || []);
  colors = structuredClone(s.colors || []);
  coupons = structuredClone(s.coupons || []);
  for (const c of coupons) c.mitAktion = !!c.mitAktion;   // Migration: fehlt → nicht mit Aktion kombinierbar
  aktionen = structuredClone(Array.isArray(s.aktionen) ? s.aktionen : []);
  for (const a of aktionen) a.muster = akMusterNorm(a.muster);   // Migration: fehlt/unbekannt → [] (= alle Oberflächen)
  AK_OFFSET = DATA.serverNow ? (Date.parse(DATA.serverNow) - Date.now()) || 0 : 0;   // Countdown nach Serverzeit
  renderTiers(); renderColors(); renderCoupons(); renderAktionen(); renderDashAktion();
  const c = s.company || {};
  $('#c-name').value = c.name || ''; $('#c-owner').value = c.owner || ''; $('#c-street').value = c.street || '';
  $('#c-zip').value = c.zip || ''; $('#c-city').value = c.city || ''; $('#c-email').value = c.email || '';
  $('#c-phone').value = c.phone || ''; $('#c-ustid').value = c.ustId || ''; $('#c-iban').value = c.iban || '';
  $('#c-bic').value = c.bic || ''; $('#c-bank').value = c.bank || ''; $('#c-prefix').value = s.invoicePrefix || '';
  $('#c-credit-prefix').value = s.creditPrefix || '';   // Gutschriftnummern (Reklamation): Präfix + nextCredit
  $('#c-klein').checked = !!c.kleinunternehmer;
  $('#pp-id').value = s.paypal?.clientId || ''; $('#pp-secret').value = s.paypal?.secret || '';
  $('#pp-enabled').checked = !!s.paypal?.enabled; $('#pp-sandbox').checked = !!s.paypal?.sandbox;
  fillMail(s.mail);
  const p = s.printing || {};
  $('#p-min-egg').value = p.minutesEgg ?? 75; $('#p-g-egg').value = p.gramsEgg ?? 22;
  $('#p-min-vase').value = p.minutesVase ?? 210; $('#p-g-vase').value = p.gramsVase ?? 110;
  $('#s-adminkey').value = '';
  const info = DATA.info || {};
  $('#sys-info').innerHTML = `<dt>Node</dt><dd>${esc(info.node || '—')}</dd><dt>Läuft seit</dt><dd>${info.startedAt ? fmtDT(info.startedAt) : '—'} (${info.uptime != null ? fmtDur(info.uptime / 60) : '—'})</dd><dt>Bestellungen</dt><dd>${DATA.orders.length}</dd><dt>Kundenkonten</dt><dd>${USERS.length}</dd><dt>Nächste Rechnung</dt><dd>${esc(s.invoicePrefix || '')}${String(s.nextInvoice || 1).padStart(4, '0')}</dd><dt>Nächste Gutschrift</dt><dd>${esc(s.creditPrefix || 'GS-2026-')}${String(s.nextCredit || 1).padStart(4, '0')}</dd>`;
  $('#side-foot').textContent = `Node ${info.node || ''} · seit ${info.startedAt ? fmtDT(info.startedAt) : '—'}`;
  setDirty(false);
}
function setDirty(v) {
  dirty = v;
  const el = $('#save-state');
  el.textContent = v ? 'Ungespeicherte Änderungen' : 'Alles gespeichert';
  el.classList.toggle('dirty', v);
}
/** Aktion so, wie der Server sie erwartet (Vertrag Punkt 1/8 + Oberflächen 1): getrimmte Texte, ganze Prozent, ISO-UTC, echte Booleans, muster als Key-Liste ([] = alle; musterWahl bleibt UI-intern) */
const akPayload = (a) => ({
  id: String(a.id || newAktionId()), name: String(a.name || '').trim().slice(0, 60), prozent: Math.round(Number(a.prozent)),
  start: a.start, ende: a.ende, produkte: AK_PRODUKTE[a.produkte] ? a.produkte : 'alle', muster: akMusterNorm(a.muster),
  mengenrabatt: !!a.mengenrabatt, hinweis: String(a.hinweis || '').trim().slice(0, 120), aktiv: !!a.aktiv,
});
async function saveSettings() {
  // Aktionen vor dem Senden prüfen (der Server lehnt mit 400 ab, ohne etwas zu übernehmen) — zur fehlerhaften Karte springen
  const bad = aktionen.findIndex((a) => akError(a));
  if (bad >= 0) {
    show('aktionen');
    akRefresh(bad);
    $(`#ak-card-${bad}`)?.scrollIntoView?.({ block: 'center' });
    return toast(`Aktion „${String(aktionen[bad].name || '').trim() || bad + 1}“: ${akError(aktionen[bad])}`, 'err', 5000);
  }
  // Farbaufpreis je Farbe immer als Zahl ≥ 0 mitschicken (ältere Farben ohne Feld → 0)
  for (const c of colors) c.aufpreis = euro(c.aufpreis);
  for (const c of coupons) c.mitAktion = !!c.mitAktion;   // Gutscheine: mitAktion als echter Boolean
  aktionen = aktionen.map(akPayload);
  const patch = {
    pricing: {
      currency: 'EUR',
      eierbecher: { single: +$('#s-egg-single').value, untersetzer: +$('#s-egg-saucer').value, discounts: tiers.egg },
      vase: { single: +$('#s-vase-single').value, discounts: tiers.vase },
      gravur: +$('#s-gravur').value,
      // Aufpreise: pricing wird serverseitig als Ganzes ersetzt → alle Muster-Keys explizit (0 = kein Aufpreis)
      farbschrift: euro($('#s-farbschrift').value),
      muster: Object.fromEntries(MUSTER_KEYS.map((k) => [k, euro($(`#s-muster-${k}`).value)])),
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
    creditPrefix: $('#c-credit-prefix').value,
    colors, coupons, aktionen,
  };
  if ($('#s-adminkey').value) patch.adminKey = $('#s-adminkey').value;
  $('#save-btn').disabled = true;
  try {
    const r = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify(patch) });
    if (!r.ok) throw new Error(r.error || 'Speichern fehlgeschlagen');
    if (patch.adminKey) { localStorage.setItem('ovju-admin-key', patch.adminKey); $('#s-adminkey').value = ''; }
    DATA.settings = { ...DATA.settings, ...patch, colors: structuredClone(colors), coupons: structuredClone(coupons), aktionen: structuredClone(aktionen) };
    setDirty(false);
    const run = akLaufende(aktionen);
    toast(run.length > 1 ? `Einstellungen gespeichert — ${run.length} Aktionen laufen jetzt im Shop (${run.map((a) => `„${a.name}“ −${a.prozent} % ${aktionScopeLabel(a)}`).join(', ')})`
      : run.length ? `Einstellungen gespeichert — Aktion „${run[0].name}“ (−${run[0].prozent} % ${aktionScopeLabel(run[0])}) läuft jetzt im Shop` : 'Einstellungen gespeichert — wirken sofort im Shop', 'ok');
    renderDashAktion();
    if (PANE === 'colors') renderColors();
    if (PANE === 'aktionen') aktionen.forEach((_, i) => akRefresh(i));
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
  akStartTicker();
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
    if (del) return deleteColor(+del.dataset.delColor);
    const cp = e.target.closest?.('[data-copy]');
    if (cp) copyText(cp.dataset.copy);
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
