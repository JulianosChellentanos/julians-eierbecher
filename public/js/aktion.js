// OVJU — Aktionsleiste & Countdown: zeigt die laufende Aktion als Leiste über dem Header (statt der
// .announcement-Zeile), hält alle Countdown-Stellen (.aktion-countdown) aktuell und beendet die Aktion
// clientseitig, sobald die Restzeit abgelaufen ist (pricing.js → expireAktion → Preise neu rendern).
// Der Server bleibt beim Checkout die Wahrheit — hier geht es nur um die Anzeige.
import { aktionCurrent, aktionRemaining, aktionText, aktionTextKurz, expireAktion, notifyAktionChange, onAktionEnde, setPricing } from './pricing.js';

const $ = (s) => document.querySelector(s);
const PRODUKTE_LABEL = { alle: 'auf alles', vase: 'auf Vasen', eierbecher: 'auf Eierbecher' };
const H = 3600e3;
let timer = null;
let started = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** „auf alles“ / „auf Vasen“ / „auf Eierbecher“ */
export function aktionScope(a) { return PRODUKTE_LABEL[a?.produkte] || PRODUKTE_LABEL.alle; }

/** Leiste über dem Header rendern (oder ausblenden, wenn keine Aktion läuft) */
function renderBar() {
  const bar = $('#aktion-bar');
  const ann = $('.announcement');
  const a = aktionCurrent();
  if (!bar) return;
  if (!a) {
    bar.hidden = true; bar.innerHTML = '';
    if (ann) ann.hidden = false;
    document.body.classList.remove('has-aktion');
    return;
  }
  bar.innerHTML = `<span class="ab-fire" aria-hidden="true">🔥</span>` +
    `<span class="ab-text"><b>${esc(a.name)}</b>: <span class="ab-num">−${Math.round(a.prozent)} %</span> ${aktionScope(a)}</span>` +
    `<span class="ab-sep" aria-hidden="true">·</span><span class="ab-count aktion-countdown">${aktionText()}</span>` +
    (a.hinweis ? `<span class="ab-hint">${esc(a.hinweis)}</span>` : '');
  bar.hidden = false;
  if (ann) ann.hidden = true;
  document.body.classList.add('has-aktion');
}

/** Alle Countdown-Stellen auf der Seite auffrischen (data-kurz → Kurzform „noch 1 Tag 4 Std“, z. B. Mobile-Leiste) */
function paintCountdown() {
  const txt = aktionText(), kurz = aktionTextKurz();
  document.querySelectorAll('.aktion-countdown').forEach((el) => {
    const t = 'kurz' in el.dataset ? kurz : txt;
    if (el.textContent !== t) el.textContent = t;
  });
}

function stop() { clearTimeout(timer); timer = null; }

/** Nächsten Tick planen: sekündlich unter einer Stunde, sonst minütlich (aber rechtzeitig zum Wechsel) */
function schedule(rest) {
  stop();
  const delay = rest <= H ? 1000 : Math.min(60e3, Math.max(1000, rest - H + 200));
  timer = setTimeout(tick, delay);
}

function tick() {
  if (!aktionCurrent()) { ended(); return; }
  paintCountdown();
  schedule(aktionRemaining());
}

/** Aktion ist vorbei: Leiste weg, Preise ohne Aktion, kurz darauf nachsehen, ob eine neue Aktion begonnen hat */
function ended() {
  stop();
  expireAktion(); // ruft alle onAktionEnde-Callbacks (inkl. renderBar)
  setTimeout(refresh, 2500);
}

/** Preise neu vom Server holen — beginnt direkt eine Folgeaktion, erscheint sie ohne Neuladen */
async function refresh() {
  try {
    const fresh = await (await fetch('/api/pricing', { cache: 'no-store' })).json();
    if (!fresh || !fresh.products) return;
    setPricing(fresh);
    if (aktionCurrent()) { start(); notifyAktionChange(); }
  } catch { /* offline — die Seite rechnet ohne Aktion weiter */ }
}

function start() {
  renderBar();
  if (aktionCurrent()) schedule(aktionRemaining());
}

/** Einmal nach dem Laden der Preise aufrufen (app.js) */
export function initAktionBar() {
  if (started) { start(); return; }
  started = true;
  onAktionEnde(renderBar);
  // Hintergrund-Tabs drosseln Timer — beim Zurückkehren sofort nachziehen
  document.addEventListener('visibilitychange', () => { if (!document.hidden && aktionCurrent()) tick(); });
  start();
}
