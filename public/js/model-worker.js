// formsam — Hintergrund-Thread (Web Worker, Modul): rechnet Vasen-Modell, Druck-Ampel und Druckdateien, damit die Seite beim
// Ändern von Form, Muster oder Gravur bedienbar bleibt — vor allem auf Handys, wo eine Gravur-Vorschau 1–2 s Rechenzeit kostet.
// Gegenstück auf der Seite: model-builder.js (schickt immer nur einen Auftrag gleichzeitig, „neuester Stand gewinnt“).
// Nachrichten:  { id, type: 'ping' }            → { id, ok, ready: true }
//               { id, type: 'build', params }   → { id, ok, ms, geometry, inlay, saucer, info, stats }  (Geometrien als übertragbare Arrays)
//               { id, type: 'export', config }  → { id, ok, ms, ex: { buffer, ext, mime } }
import { buildModel, buildSaucer } from './geometry.js';
import { loadFont, makeExport } from './modelfactory.js';
import { printStats } from './printcheck.js';

// Geometrie → { attrs, index, groups, sphere, box } aus TypedArrays; deren Puffer wandern ohne Kopie zur Seite (transfer)
function pack(geometry, transfer) {
  const attrs = {};
  for (const [name, a] of Object.entries(geometry.attributes)) {
    attrs[name] = { array: a.array, itemSize: a.itemSize, normalized: a.normalized };
    transfer.add(a.array.buffer);
  }
  const index = geometry.index ? geometry.index.array : null;
  if (index) transfer.add(index.buffer);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  const s = geometry.boundingSphere, b = geometry.boundingBox;
  return {
    attrs, index,
    groups: geometry.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex })),
    sphere: { c: [s.center.x, s.center.y, s.center.z], r: s.radius },
    box: { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] },
  };
}

// Info ohne Funktionen (radiusAt …) und ohne Geometrien — nur reine Daten lassen sich übertragen
function plain(v, depth = 0) {
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  if (v.isBufferGeometry || depth > 6) return undefined;
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  if (ArrayBuffer.isView(v)) return v.slice();
  const out = {};
  for (const [k, x] of Object.entries(v)) { const p = plain(x, depth + 1); if (p !== undefined) out[k] = p; }
  return out;
}

async function build(params) {
  const txt = String(params.text || '').trim();
  const [textFont, fallbackFont] = txt ? await Promise.all([loadFont(params.font), loadFont('droid_sans')]) : [];
  const t0 = performance.now();
  const { geometry, info } = buildModel({ ...params, textFont, fallbackFont });
  const stats = printStats(geometry, info);
  let saucer = null;
  const transfer = new Set();
  if (params.product === 'eierbecher' && params.saucer) {
    const s = buildSaucer(params);
    saucer = { geometry: pack(s.geometry, transfer), info: plain(s.info) };
  }
  const res = {
    geometry: pack(geometry, transfer),
    inlay: info.inlay ? pack(info.inlay, transfer) : null,
    saucer, info: plain(info), stats,
    ms: Math.round(performance.now() - t0),
  };
  return { res, transfer: [...transfer] };
}

self.onmessage = async ({ data }) => {
  const { id, type } = data || {};
  try {
    if (type === 'ping') { self.postMessage({ id, ok: true, ready: true }); return; }
    if (type === 'build') {
      const { res, transfer } = await build(data.params);
      self.postMessage({ id, ok: true, ...res }, transfer);
      return;
    }
    if (type === 'export') {
      const t0 = performance.now();
      const ex = await makeExport(data.config);
      self.postMessage({ id, ok: true, ms: Math.round(performance.now() - t0), ex }, [ex.buffer]);
      return;
    }
    self.postMessage({ id, ok: false, error: `Unbekannter Auftrag ${type}` });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};

// Standardschriften vorwärmen (aus dem HTTP-Cache, kostet kaum etwas) — die erste Gravur startet dann ohne Ladezeit
loadFont('helvetiker').catch(() => {});
loadFont('droid_sans').catch(() => {});
