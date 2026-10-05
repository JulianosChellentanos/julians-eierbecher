// formsam — Druckbarkeits-Kennzahlen für die Ampel im Konfigurator (rein rechnerisch, ohne DOM — läuft auch im Hintergrund-Thread).

// Analysiert die echten Flächennormalen des Meshes (Überhangwinkel: 0° = senkrechte Wand, 90° = horizontale Unterseite)
export function overhangStats(geometry) {
  const pos = geometry.getAttribute('position').array;
  const idx = geometry.index ? geometry.index.array : null; // Facetten-Muster kommen nicht-indiziert (Crease-Normalen)
  const nIdx = idx ? idx.length : pos.length / 3;
  let worst = 0, total = 0, over55 = 0;
  for (let i = 0; i < nIdx; i += 3) {
    const a = (idx ? idx[i] : i) * 3, b = (idx ? idx[i + 1] : i + 1) * 3, c = (idx ? idx[i + 2] : i + 2) * 3;
    const cy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    total += len;
    if (cy < 0.4) continue; // Bodenfläche liegt auf dem Druckbett
    const nyN = ny / len;
    if (nyN < -1e-6) {
      const al = Math.asin(Math.min(1, -nyN)) * 180 / Math.PI;
      if (al > worst) worst = al;
      if (al > 55) over55 += len;
    }
  }
  return { worst, frac55: total ? over55 / total : 0 };
}

// Silhouetten-Überhang: max. Auskrag-Winkel der glatten Außenkontur (analytisch).
// Das ist beim FDM-Druck das harte Kriterium — Mustertiefen ≤ 1,6 mm sind dagegen
// selbsttragende Mikro-Features (Faustregel: < 2 mm horizontale Ausdehnung).
export function silhouetteOverhang(info) {
  let worst = 0;
  const N = 160;
  let prev = info.radiusAt(0);
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    const r = info.radiusAt(t);
    const drdy = (r - prev) / (info.height / N);
    if (drdy > 0) worst = Math.max(worst, Math.atan(drdy) * 180 / Math.PI);
    prev = r;
  }
  return worst;
}

/** Alle Kennzahlen der Ampel auf einmal: { sil, worst, frac55 } */
export function printStats(geometry, info) {
  return { sil: silhouetteOverhang(info), ...overhangStats(geometry) };
}
