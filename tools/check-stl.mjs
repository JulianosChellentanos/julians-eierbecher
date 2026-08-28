#!/usr/bin/env node
// check-stl.mjs — Validierung binärer STL-Dateien (Eierbecher-Konfigurator)
// Aufruf: node tools/check-stl.mjs <datei.stl>
// Exit-Code 0, wenn alle harten Checks bestehen, sonst 1.

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const HEADER_SIZE = 80;
const TRI_SIZE = 50;
const MAX_TRIANGLES = 2_000_000;

const OK = "✅";
const FAIL = "❌";
const WARN = "⚠️ ";

function fmt(n, digits = 2) {
  return Number(n.toFixed(digits)).toString();
}

function die(msg) {
  console.error(`${FAIL} ${msg}`);
  process.exit(1);
}

// ---------- Argumente & Datei laden ----------
const file = process.argv[2];
if (!file) {
  console.error("Aufruf: node tools/check-stl.mjs <datei.stl>");
  process.exit(1);
}

let buf;
try {
  buf = readFileSync(file);
} catch (e) {
  die(`Datei nicht lesbar: ${file} (${e.message})`);
}
const fileSize = statSync(file).size;

console.log(`STL-Check: ${basename(file)} (${fileSize} Bytes)`);
console.log("─".repeat(52));

// ---------- ASCII-STL erkennen ----------
// ASCII-STL beginnt mit "solid" und enthält "facet normal" im Text.
if (buf.length >= 5 && buf.toString("latin1", 0, 5).toLowerCase() === "solid") {
  const probe = buf.toString("latin1", 0, Math.min(buf.length, 4096));
  if (/facet\s+normal/i.test(probe)) {
    die("ASCII-STL erkannt — es werden nur binäre STL-Dateien unterstützt.");
  }
}

if (buf.length < HEADER_SIZE + 4) {
  die(`Datei zu klein für binäres STL (${buf.length} Bytes, mindestens 84 erwartet).`);
}

const triCount = buf.readUInt32LE(HEADER_SIZE);

const checks = []; // { name, ok, detail, hard }
const warnings = [];

// ---------- Check 1: Dateigröße ----------
const expectedSize = HEADER_SIZE + 4 + triCount * TRI_SIZE;
checks.push({
  name: "Dateigröße konsistent",
  ok: fileSize === expectedSize,
  detail: fileSize === expectedSize
    ? `84 + ${triCount}×50 = ${expectedSize} Bytes`
    : `erwartet ${expectedSize} Bytes (84 + ${triCount}×50), tatsächlich ${fileSize}`,
  hard: true,
});

// ---------- Check 2: Triangle-Count plausibel ----------
const countOk = triCount > 0 && triCount < MAX_TRIANGLES;
checks.push({
  name: "Triangle-Count plausibel",
  ok: countOk,
  detail: countOk
    ? `${triCount} Dreiecke`
    : `${triCount} Dreiecke (erwartet: > 0 und < ${MAX_TRIANGLES.toLocaleString("de-DE")})`,
  hard: true,
});

// Nur so viele Dreiecke parsen, wie tatsächlich in der Datei stehen.
const parsableTris = Math.min(triCount, Math.floor((buf.length - HEADER_SIZE - 4) / TRI_SIZE));

// ---------- Parsen + Checks 3–7 ----------
let degenerate = 0;
let nonFinite = 0;
let volume = 0; // signierte Tetraeder-Summe (mm³)
const bbox = {
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
};
const edges = new Map(); // gerichtete Kante "a|b" -> Anzahl

const keyDeg = (v) => v.map((c) => Math.round(c * 1e7)).join(","); // ~1e-7
const keyEdge = (v) => v.map((c) => Math.round(c * 1e5)).join(","); // 1e-5 mm

for (let i = 0; i < parsableTris; i++) {
  const off = HEADER_SIZE + 4 + i * TRI_SIZE;
  const v = [];
  let finite = true;
  for (let j = 0; j < 3; j++) {
    const p = [
      buf.readFloatLE(off + 12 + j * 12),
      buf.readFloatLE(off + 16 + j * 12),
      buf.readFloatLE(off + 20 + j * 12),
    ];
    if (!p.every(Number.isFinite)) finite = false;
    v.push(p);
  }

  if (!finite) {
    nonFinite++;
    continue; // Koordinaten unbrauchbar — nicht in Geometrie-Checks einbeziehen
  }

  for (const p of v) {
    for (let a = 0; a < 3; a++) {
      if (p[a] < bbox.min[a]) bbox.min[a] = p[a];
      if (p[a] > bbox.max[a]) bbox.max[a] = p[a];
    }
  }

  // Degeneriert: zwei (auf ~1e-7 gerundet) identische Eckpunkte
  const k = v.map(keyDeg);
  if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) {
    degenerate++;
    continue; // degenerierte Dreiecke nicht in Kanten/Volumen einrechnen
  }

  // Volumen: signiertes Tetraeder (Ursprung, v0, v1, v2) = dot(v0, cross(v1, v2)) / 6
  const [a, b, c] = v;
  volume +=
    (a[0] * (b[1] * c[2] - b[2] * c[1]) +
      a[1] * (b[2] * c[0] - b[0] * c[2]) +
      a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;

  // Gerichtete Kanten sammeln
  const ek = v.map(keyEdge);
  for (let e = 0; e < 3; e++) {
    const key = `${ek[e]}|${ek[(e + 1) % 3]}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
}

// ---------- Check 3: degenerierte Dreiecke ----------
checks.push({
  name: "Keine degenerierten Dreiecke",
  ok: degenerate === 0,
  detail: degenerate === 0 ? "alle Dreiecke haben 3 unterschiedliche Eckpunkte" : `${degenerate} degenerierte(s) Dreieck(e)`,
  hard: true,
});

// ---------- Check 4: NaN/Infinity ----------
checks.push({
  name: "Keine NaN/Infinity-Koordinaten",
  ok: nonFinite === 0,
  detail: nonFinite === 0 ? "alle Koordinaten endlich" : `${nonFinite} Dreieck(e) mit NaN/Infinity`,
  hard: true,
});

// ---------- Check 5: Bounding Box ----------
const hasBounds = bbox.min.every(Number.isFinite) && bbox.max.every(Number.isFinite);
let bboxDetail = "keine gültige Geometrie";
if (hasBounds) {
  const dims = bbox.max.map((m, i) => m - bbox.min[i]);
  bboxDetail =
    `X ${fmt(bbox.min[0])}..${fmt(bbox.max[0])}  ` +
    `Y ${fmt(bbox.min[1])}..${fmt(bbox.max[1])}  ` +
    `Z ${fmt(bbox.min[2])}..${fmt(bbox.max[2])} mm  ` +
    `(${dims.map((d) => fmt(d, 1)).join(" × ")} mm)`;
  const minDim = Math.min(...dims);
  const maxDim = Math.max(...dims);
  if (minDim < 20 || maxDim > 200) {
    warnings.push(
      `Maße unplausibel für einen Eierbecher (kleinste Ausdehnung ${fmt(minDim, 1)} mm, größte ${fmt(maxDim, 1)} mm; erwartet 20–200 mm).`
    );
  }
}
checks.push({ name: "Bounding Box", ok: hasBounds, detail: bboxDetail, hard: false });

// ---------- Check 6: Watertight/Manifold ----------
let open = 0; // Kante ohne Gegenkante
let nonManifold = 0; // Kante mehrfach in gleicher Richtung
for (const [key, count] of edges) {
  if (count > 1) nonManifold++;
  const [a, b] = key.split("|");
  const opp = edges.get(`${b}|${a}`) ?? 0;
  if (opp !== 1) open++;
}
const manifoldOk = open === 0 && nonManifold === 0 && edges.size > 0;
checks.push({
  name: "Watertight / Manifold",
  ok: manifoldOk,
  detail: manifoldOk
    ? `alle ${edges.size} gerichteten Kanten korrekt gepaart`
    : `${open} offene, ${nonManifold} nicht-manifold Kante(n) von ${edges.size}`,
  hard: true,
});

// ---------- Check 7: Volumen ----------
const volumeCm3 = volume / 1000;
const volumeOk = volume > 0;
checks.push({
  name: "Volumen > 0",
  ok: volumeOk,
  detail: `${fmt(volumeCm3, 3)} cm³`,
  hard: true,
});
if (!volumeOk) {
  warnings.push("Volumen <= 0 — Normalen/Winding vermutlich falsch herum (Flächen zeigen nach innen).");
}

// ---------- Report ----------
let hardFail = false;
for (const c of checks) {
  if (!c.ok && c.hard) hardFail = true;
  console.log(`${c.ok ? OK : FAIL} ${c.name.padEnd(32)} ${c.detail}`);
}
for (const w of warnings) console.log(`${WARN}${w}`);
console.log("─".repeat(52));
console.log(hardFail ? `${FAIL} STL NICHT in Ordnung` : `${OK} STL in Ordnung`);
process.exit(hardFail ? 1 : 0);
