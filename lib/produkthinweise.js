// formsam — Produkthinweise und gesonderte Vereinbarung (Wasser/Standfestigkeit) aus einer Quelle
//
//   import { produktHinweise, BESCHAFFENHEIT_FASSUNG, BESCHAFFENHEIT_TEXTE } from './lib/produkthinweise.js';
//
// Rechnung (server.js invoiceHTML) und Bestellung (order.beschaffenheitFassung) nehmen die Texte von hier. Die Kasse zeigt
// dieselben Sätze aus public/content.json (hinweise.checkout) und das Häkchen aus public/index.html (#co-beschaffenheit) —
// tools/test-recht.mjs prüft, dass beide wörtlich zu diesem Modul passen. Wird der Häkchentext geändert: neue Fassung
// (Datum) in BESCHAFFENHEIT_TEXTE ergänzen, alte stehen lassen — order.json verweist mit beschaffenheitFassung darauf.

/** Einzelsätze (Ich-Form wie im Shop) — Reihenfolge = Reihenfolge auf der Rechnung */
export const HINWEIS = {
  material: 'Jede Vase besteht aus PLA, einem Kunststoff auf Pflanzenbasis. Nicht spülmaschinengeeignet und keinen Temperaturen über 50\u00a0°C aussetzen (heißes Wasser, Heizung, Auto im Sommer).',
  wasser: 'Vasen sind für Trockenblumen gedacht (imprägniert, in der Regel wasserfest – eine Wasserdichtigkeit sage ich aber nicht zu).',
  voronoi: 'Offene Muster (Voronoi) halten kein Wasser – nur mit passendem Einsatz.',
  standfest: 'Für frei gestaltete Formen sage ich keine Standfestigkeit zu.',
};

/**
 * Wortlaut des Pflicht-Häkchens in der Kasse je Fassung (Schlüssel = gültig ab). Die jüngste Fassung steht im Shop;
 * die Bestellung speichert ihren Schlüssel als beschaffenheitFassung (Nachweis nach § 476 Abs. 1 Satz 2 BGB).
 */
export const BESCHAFFENHEIT_TEXTE = {
  '2026-09-27': 'Ich bin ausdrücklich einverstanden: Meine Vase ist für Trockenblumen gedacht, ihre Wasserdichtigkeit ist nicht vereinbart, und offene Muster (Voronoi) halten kein Wasser. Bei einer frei gestalteten Form ist die Standfestigkeit nicht vereinbart (AGB § 13).',
};
export const BESCHAFFENHEIT_FASSUNG = Object.keys(BESCHAFFENHEIT_TEXTE).sort().at(-1);

const istVoronoi = (l) => l?.config?.pattern === 'skelett';
const istEigeneForm = (l) => l?.config?.preset === 'eigene';
/** „Pos. 1, 3“ für die Zeilen, auf die eine Bedingung zutrifft (Nummern wie auf der Rechnung, ab 1) */
const positionen = (lines, test) => lines.map((l, i) => (test(l) ? i + 1 : 0)).filter(Boolean);

/**
 * Produkthinweise zu einer Bestellung als Sätze (Text, nicht maskiert). Immer: Material, Wasser, Standfestigkeit;
 * der Voronoi-Satz nur, wenn eine Position ein offenes Muster hat — dann mit den Positionsnummern, ebenso die freie Form.
 * Ohne Positionen (z. B. Kurzfassung für eine Mail) stehen alle vier Sätze ohne Nummern da.
 */
export function produktHinweise(lines) {
  const ls = Array.isArray(lines) ? lines : null;
  if (!ls) return [HINWEIS.material, HINWEIS.wasser, HINWEIS.voronoi, HINWEIS.standfest];
  const vor = positionen(ls, istVoronoi), eig = positionen(ls, istEigeneForm);
  return [
    HINWEIS.material,
    HINWEIS.wasser,
    vor.length ? HINWEIS.voronoi.replace('(Voronoi)', `(Voronoi, Pos. ${vor.join(', ')})`) : '',
    eig.length ? HINWEIS.standfest.replace('Formen', `Formen (Pos. ${eig.join(', ')})`) : HINWEIS.standfest,
  ].filter(Boolean);
}
