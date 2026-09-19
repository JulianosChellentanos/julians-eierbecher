// OVJU — Aktionsleiste & Countdown: zeigt die primäre Aktion (höchster Rabatt) als Leiste über dem Header (statt der
// .announcement-Zeile) — läuft noch eine zweite, hängt der Desktop-Banner „· außerdem: Name −16 % auf alles“ an.
// Hält alle Countdown-Stellen (.aktion-countdown, optional data-aktion-id für eine bestimmte Aktion) aktuell und beendet
// jede Aktion clientseitig einzeln, sobald ihre Restzeit abgelaufen ist (pricing.js → expireAktion(id) → Preise neu
// rendern); die restlichen laufen weiter. Der Server bleibt beim Checkout die Wahrheit — hier geht es nur um die Anzeige.
import { aktionenActive, aktionNextEnde, aktionScopeLabel, aktionText, aktionTextKurz, expireAktion, notifyAktionChange, onAktionEnde, setPricing } from './pricing.js';

const $ = (s) => document.querySelector(s);
const H = 3600e3;
let timer = null;
let started = false;
let known = []; // IDs der zuletzt gesehenen laufenden Aktionen (zum Erkennen des Ablaufs)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** „auf alles“ / „auf Vasen“ / „auf Gehämmert“ / „auf Vasen mit Rippen oder Wellen“ (Kompatibilität — Logik in pricing.js) */
export function aktionScope(a) { return aktionScopeLabel(a); }

/** Leiste über dem Header rendern (oder ausblenden, wenn keine Aktion läuft) */
function renderBar() {
  const bar = $('#aktion-bar');
  const ann = $('.announcement');
  const list = aktionenActive();
  const a = list[0];
  if (!bar) return;
  if (!a) {
    bar.hidden = true; bar.innerHTML = '';
    if (ann) ann.hidden = false;
    document.body.classList.remove('has-aktion');
    return;
  }
  const more = list.slice(1);
  bar.innerHTML = `<span class="ab-fire" aria-hidden="true">🔥</span>` +
    `<span class="ab-text"><b>${esc(a.name)}</b>: <span class="ab-num">−${a.prozent} %</span> ${aktionScopeLabel(a)}</span>` +
    `<span class="ab-sep" aria-hidden="true">·</span><span class="ab-count aktion-countdown" data-aktion-id="${esc(a.id)}">${aktionText(a)}</span>` +
    (a.hinweis ? `<span class="ab-hint">${esc(a.hinweis)}</span>` : '') +
    // weitere laufende Aktionen nur auf dem Desktop (CSS blendet .ab-more auf Mobile aus)
    (more.length ? `<span class="ab-more">außerdem: ${more.map((m) => `<b>${esc(m.name)}</b> −${m.prozent} % ${aktionScopeLabel(m)}`).join(' · ')}</span>` : '');
  bar.hidden = false;
  if (ann) ann.hidden = true;
  document.body.classList.add('has-aktion');
}

/** Alle Countdown-Stellen auffrischen: data-aktion-id → Restzeit dieser Aktion, sonst der primären;
 *  data-kurz → Kurzform „noch 1 Tag 4 Std“ (z. B. Mobile-Leiste) */
function paintCountdown() {
  const list = aktionenActive();
  if (!list.length) return;
  document.querySelectorAll('.aktion-countdown').forEach((el) => {
    const id = el.dataset.aktionId;
    const a = (id ? list.find((x) => x.id === id) : null) || list[0];
    const t = 'kurz' in el.dataset ? aktionTextKurz(a) : aktionText(a);
    if (el.textContent !== t) el.textContent = t;
  });
}

function stop() { clearTimeout(timer); timer = null; }

/** Nächsten Tick planen: sekündlich unter einer Stunde, sonst minütlich (aber rechtzeitig zum Wechsel) —
 *  rest = Restzeit bis zum frühesten Ende aller laufenden Aktionen */
function schedule(rest) {
  stop();
  const delay = rest <= H ? 1000 : Math.min(60e3, Math.max(1000, rest - H + 200));
  timer = setTimeout(tick, delay);
}

function tick() {
  // Abgelaufene Aktionen einzeln beenden (Leiste + Preise neu über die onAktionEnde-Callbacks), mit den restlichen weiter
  const ids = aktionenActive().map((a) => a.id);
  const gone = known.filter((id) => !ids.includes(id));
  known = ids;
  if (gone.length) { for (const id of gone) expireAktion(id); setTimeout(refresh, 2500); }
  if (!ids.length) { stop(); return; }
  paintCountdown();
  schedule(aktionNextEnde());
}

/** Preise neu vom Server holen — beginnt direkt eine Folgeaktion, erscheint sie ohne Neuladen */
async function refresh() {
  try {
    const fresh = await (await fetch('/api/pricing', { cache: 'no-store' })).json();
    if (!fresh || !fresh.products) return;
    setPricing(fresh);
    start();
    notifyAktionChange();
  } catch { /* offline — die Seite rechnet mit dem bekannten Stand weiter */ }
}

function start() {
  known = aktionenActive().map((a) => a.id);
  renderBar();
  if (known.length) schedule(aktionNextEnde()); else stop();
}

/** Einmal nach dem Laden der Preise aufrufen (app.js) */
export function initAktionBar() {
  if (started) { start(); return; }
  started = true;
  onAktionEnde(renderBar);
  // Hintergrund-Tabs drosseln Timer — beim Zurückkehren sofort nachziehen
  document.addEventListener('visibilitychange', () => { if (!document.hidden && known.length) tick(); });
  start();
}
