// OVJU — Produktschalter (reines Modul ohne DOM/three, auch aus Node-Tests importierbar).
//
// Eierbecher sind vorerst deaktiviert — Produktcode, Bestellungen und Designs bleiben erhalten, damit das Produkt
// später wieder aktiviert werden kann. Den Stand liefert der Server unter /api/pricing als
// produkte { vase: true, eierbecher: bool } (Admin → System → „Eierbecher als Produkt anbieten“).
// Solange die Preise nicht geladen sind oder das Feld fehlt, gilt: nur Vasen.

export const EIERBECHER_HINWEIS = 'Eierbecher sind derzeit nicht bestellbar — vielleicht bald wieder.';

/** Ist das Produkt gerade bestellbar? Vasen immer; alles andere nur mit ausdrücklichem true aus /api/pricing. */
export function produktAktiv(id, pricing) {
  if (id === 'vase') return true;
  return pricing?.produkte?.[id] === true;
}

/** Produkt einer Warenkorb- oder Listenzeile ('vase' | 'eierbecher') */
export function zeilenProdukt(it) {
  return it?.product || it?.config?.product || 'vase';
}

/**
 * Warenkorb-Migration: Zeilen deaktivierter Produkte (z. B. Eierbecher aus einem älteren Besuch im localStorage)
 * entfernen — der Server lehnt sie beim Checkout ohnehin ab. → { items, entfernt }
 */
export function filterBestellbar(items, pricing) {
  const list = Array.isArray(items) ? items : [];
  const ok = list.filter((it) => produktAktiv(zeilenProdukt(it), pricing));
  return { items: ok, entfernt: list.length - ok.length };
}
