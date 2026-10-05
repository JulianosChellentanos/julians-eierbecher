// formsam — Modellberechnung im Hintergrund: schickt Aufträge an model-worker.js und baut aus den Antworten BufferGeometrien.
// „Neuester Stand gewinnt“: Es läuft immer höchstens ein Auftrag. Kommen während der Rechnung neue Vorschau-Wünsche (Tippen,
// Regler ziehen), bleibt nur der jüngste vorgemerkt; ältere fallen weg (Promise → null). Aufträge, die nie wegfallen dürfen
// (Druckdateien, Showcase-Bilder), stehen in einer eigenen Warteschlange hinter dem nächsten Vorschau-Wunsch.
// Ohne Worker (alte Browser, Fehler beim Laden, Absturz) rechnet derselbe Code wie bisher auf der Seite — vorher bekommt der
// Browser einen Frame, damit die Ladeanzeige sichtbar wird.
import * as THREE from '../vendor/three.module.js';
import { buildModel, buildSaucer } from './geometry.js';
import { loadFont, makeExport } from './modelfactory.js';
import { printStats } from './printcheck.js';

let worker = null;
let mode = 'start';               // 'start' (Worker meldet sich noch) | 'worker' | 'main'
let seq = 0;
const replies = new Map();        // Auftrags-ID → { resolve, reject }
let running = null;               // laufender Auftrag
let pendingLive = null;           // jüngster vorgemerkter Vorschau-Wunsch
const jobs = [];                  // Druckdateien & Co. (werden nie verworfen)
const idleWaiters = [];
const listeners = new Set();      // Statusmeldungen für die Ladeanzeige

function emit(ev) { for (const fn of listeners) { try { fn(ev); } catch (e) { console.error(e); } } }
/** Status abonnieren: { type: 'start', kind, params, expectedMs, live } | { type: 'done', kind, ms, live, more } | { type: 'idle' }
 *  (more = ein neuerer Vorschau-Wunsch wartet schon; live = Vorschau statt Druckdatei/Bild) */
export function onBuildStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const builderMode = () => mode;
export const isBusy = () => !!(running || pendingLive || jobs.length);
/** Promise, die erfüllt wird, sobald kein Vorschau-Auftrag mehr läuft oder wartet */
export function whenIdle() {
  if (!running && !pendingLive) return Promise.resolve();
  return new Promise((r) => idleWaiters.push(r));
}

// ---------------------------------------------------------------------------
// Worker starten (einmal); meldet er sich nicht binnen 8 s, rechnet die Seite selbst
// ---------------------------------------------------------------------------
function useMain(reason) {
  if (mode === 'main') return;
  if (reason) console.warn('Modell-Worker nicht verfügbar – rechne auf der Seite:', reason);
  mode = 'main';
  try { worker?.terminate(); } catch { /* egal */ }
  worker = null;
  // offene Antworten des Workers kommen nie mehr → laufenden Auftrag auf der Seite wiederholen
  for (const [, r] of replies) r.reject(Object.assign(new Error('worker-weg'), { retry: true }));
  replies.clear();
  pump();
}
function startWorker() {
  if (typeof Worker === 'undefined') { useMain('kein Worker im Browser'); return; }
  try {
    worker = new Worker(new URL('./model-worker.js', import.meta.url), { type: 'module', name: 'formsam-modell' });
  } catch (err) { useMain(err?.message || err); return; }
  const timer = setTimeout(() => useMain('keine Antwort'), 8000);
  worker.onmessage = ({ data }) => {
    const r = replies.get(data?.id);
    if (!r) return;
    replies.delete(data.id);
    if (data.ready) { clearTimeout(timer); mode = 'worker'; r.resolve(data); pump(); return; }
    if (data.ok) r.resolve(data); else r.reject(new Error(data.error || 'Berechnung fehlgeschlagen'));
  };
  // Lade- oder Laufzeitfehler (z. B. Browser ohne Modul-Worker, Speicher voll) → ab jetzt auf der Seite rechnen
  worker.onerror = (e) => { e.preventDefault?.(); clearTimeout(timer); useMain(e.message || 'Worker-Fehler'); };
  worker.onmessageerror = () => { clearTimeout(timer); useMain('Nachricht nicht lesbar'); };
  post({ type: 'ping' }).catch(() => {});
}
function post(msg) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    replies.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id });
  });
}

// ---------------------------------------------------------------------------
// Antworten des Workers → THREE.BufferGeometry
// ---------------------------------------------------------------------------
function unpack(p) {
  if (!p) return null;
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(p.attrs)) g.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  if (p.index) g.setIndex(new THREE.BufferAttribute(p.index, 1));
  for (const gr of p.groups || []) g.addGroup(gr.start, gr.count, gr.materialIndex);
  if (p.sphere) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(...p.sphere.c), p.sphere.r);
  if (p.box) g.boundingBox = new THREE.Box3(new THREE.Vector3(...p.box.min), new THREE.Vector3(...p.box.max));
  return g;
}

// Ein Frame Luft (Ladeanzeige zeichnen), bevor die Seite selbst lange rechnet
const breathe = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function buildOnPage(params) {
  const txt = String(params.text || '').trim();
  const [textFont, fallbackFont] = txt ? await Promise.all([loadFont(params.font), loadFont('droid_sans')]) : [];
  await breathe();
  const t0 = performance.now();
  const { geometry, info } = buildModel({ ...params, textFont, fallbackFont });
  const stats = printStats(geometry, info);
  const saucer = params.product === 'eierbecher' && params.saucer ? buildSaucer(params) : null;
  return { geometry, inlay: info.inlay || null, saucer, info, stats, ms: Math.round(performance.now() - t0) };
}

async function run(task) {
  if (task.type === 'build') {
    if (mode === 'worker') {
      const d = await post({ type: 'build', params: task.params });
      return {
        geometry: unpack(d.geometry), inlay: unpack(d.inlay),
        saucer: d.saucer ? { geometry: unpack(d.saucer.geometry), info: d.saucer.info } : null,
        info: d.info, stats: d.stats, ms: d.ms,
      };
    }
    return buildOnPage(task.params);
  }
  if (task.type === 'export') {
    if (mode === 'worker') return (await post({ type: 'export', config: task.config })).ex;
    await breathe();
    return makeExport(task.config);
  }
  throw new Error(`Unbekannter Auftrag ${task.type}`);
}

// ---------------------------------------------------------------------------
// Planung: höchstens ein Auftrag gleichzeitig; Vorschau vor Warteschlange
// ---------------------------------------------------------------------------
const est = new Map(); // Rechenzeit je Art (gleitendes Mittel) → Fortschrittsbalken
const estKey = (p) => `${p.product}|${p.pattern}|${String(p.text || '').trim() ? p.textStyle : '-'}|${p.quality}`;
function expectedMs(task) {
  if (task.type === 'export') return est.get('export') ?? 4000;
  const k = estKey(task.params);
  if (est.has(k)) return est.get(k);
  const txt = String(task.params.text || '').trim();
  return (txt ? 700 : 250) * (task.params.pattern === 'gehaemmert' || task.params.pattern === 'skelett' ? 1.8 : 1);
}
function learn(task, ms) {
  const k = task.type === 'export' ? 'export' : estKey(task.params);
  const old = est.get(k);
  est.set(k, old == null ? ms : old * 0.6 + ms * 0.4);
}

function pump() {
  if (running || mode === 'start') return;
  let task = null;
  if (pendingLive) { task = pendingLive; pendingLive = null; } else if (jobs.length) task = jobs.shift();
  if (!task) {
    while (idleWaiters.length) idleWaiters.shift()();
    emit({ type: 'idle' });
    return;
  }
  running = task;
  const t0 = performance.now();
  emit({ type: 'start', kind: task.kind, params: task.params, expectedMs: expectedMs(task), live: task.live });
  run(task).then(
    (res) => { learn(task, performance.now() - t0); task.resolve(res); },
    (err) => {
      if (!err?.retry) { task.reject(err); return; }
      // Worker ist weggefallen → derselbe Auftrag noch einmal auf der Seite (eine überholte Vorschau endet mit null)
      if (!task.live) jobs.unshift(task);
      else if (pendingLive) task.resolve(null);
      else pendingLive = task;
    },
  ).finally(() => {
    emit({ type: 'done', kind: task.kind, ms: performance.now() - t0, live: task.live, more: !!pendingLive });
    running = null;
    pump();
  });
}

/**
 * Vorschau-Modell anfordern (Konfigurator). Ergebnis: { geometry, inlay, saucer, info, stats, ms } —
 * oder null, wenn ein neuerer Wunsch diesen ersetzt hat, bevor er gerechnet wurde.
 * kind: wofür (Ladeanzeige: 'gravur' | 'form' | 'oberflaeche' | …)
 */
export function requestModel(params, kind = 'modell') {
  if (mode === 'start' && !worker) startWorker();
  return new Promise((resolve, reject) => {
    if (pendingLive) pendingLive.resolve(null); // überholt
    pendingLive = { type: 'build', params: JSON.parse(JSON.stringify(params)), kind, live: true, resolve, reject };
    pump();
  });
}

/** Einmaliges Modell, das nicht verworfen wird (z. B. Showcase-Bild) */
export function buildModelOnce(params, kind = 'bild') {
  if (mode === 'start' && !worker) startWorker();
  return new Promise((resolve, reject) => {
    jobs.push({ type: 'build', params: JSON.parse(JSON.stringify(params)), kind, live: false, resolve, reject });
    pump();
  });
}

/** Druckdatei (STL bzw. 3MF bei Farbschrift) im Hintergrund erzeugen → { buffer, ext, mime } */
export function exportModel(config) {
  if (mode === 'start' && !worker) startWorker();
  return new Promise((resolve, reject) => {
    jobs.push({ type: 'export', config: JSON.parse(JSON.stringify(config)), kind: 'export', live: false, resolve, reject });
    pump();
  });
}

/** Worker früh starten (lädt Geometrie-Code und Schriften, während die Seite noch aufbaut) */
export function warmUp() { if (mode === 'start' && !worker) startWorker(); }
