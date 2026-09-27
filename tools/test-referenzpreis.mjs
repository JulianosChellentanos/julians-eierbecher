// formsam — Unit-Test für den Bezugspreis nach § 11 PAngV (public/js/pricing.js: referenzpreis, aktionProzentGueltig, linePrice)
// und den Versandhinweis am Preis (§ 6 PAngV: versandText/versandHTML/ustText)
// Aufruf: node tools/test-referenzpreis.mjs   (ohne Server, ohne Abhängigkeiten — pricing.js ist reine Rechnung)
import {
  setPricing, setColors, referenzpreis, aktionProzentGueltig, linePrice, unitParts, referenzText, referenzTextZeile,
  versandText, versandHTML, ustText,
} from '../public/js/pricing.js';

const TAG = 864e5;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');   // feste „Server-Uhr“ (serverNow → Zeitversatz in pricing.js)
const S = NOW - 1 * TAG;                              // Beginn der laufenden Aktion (gestern)
const iso = (t) => new Date(t).toISOString();
let pass = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005;

// Aktueller Preisstand (wie /api/pricing) — Vase 24,90 €, Lamellen +3 €, Gravur 3 €, Farbschrift 2 €
const basePricing = () => ({
  currency: 'EUR',
  products: {
    vase: { single: 24.9, discounts: [{ qty: 2, off: 10 }, { qty: 3, off: 15 }] },
    eierbecher: { single: 9.9, untersetzer: 4.9, discounts: [{ qty: 2, off: 20 }] },
  },
  shipping: { flat: 4.9, freeFrom: 39 }, gravur: 3, farbschrift: 2, muster: { lamellen: 3 }, volumen: { prozent: 100, euro: 0 },
  normalHeight: { eierbecher: 58, vase: 150 }, produkte: { vase: true, eierbecher: false },
});
const COLORS = [{ id: 'weiss', name: 'Weiß', aufpreis: 0 }, { id: 'gold', name: 'Gold', aufpreis: 2 }];
/** Momentaufnahme wie in data/preis-historie.json (colors als Liste) — overrides ändern einzelne Preise;
 *  staffel = Mengenstaffel der Vase (seit der Erweiterung gespeichert), null = Eintrag von vorher (ohne discounts) */
const STAFFEL = [{ qty: 2, off: 10 }, { qty: 3, off: 15 }];
const snap = (at, { single = 24.9, muster = { lamellen: 3 }, gold = 2, aktionen = [], gravur = 3, staffel = STAFFEL } = {}) => ({
  at: iso(at),
  pricing: { products: { vase: { single, ...(staffel ? { discounts: staffel } : {}) }, eierbecher: { single: 9.9, untersetzer: 4.9, ...(staffel ? { discounts: [{ qty: 2, off: 20 }] } : {}) } }, gravur, farbschrift: 2, muster, volumen: { prozent: 100, euro: 0 } },
  colors: [{ id: 'weiss', aufpreis: 0 }, { id: 'gold', aufpreis: gold }],
  aktionen,
});
const aktion = (id, prozent, start, ende, extra = {}) => ({ id, name: id, prozent, start: iso(start), ende: iso(ende), produkte: 'alle', muster: [], mengenrabatt: false, hinweis: '', ...extra });
/** Szenario laden: laufende Aktionen (wie /api/pricing → aktionen) + Historie */
function szenario(laufende, historie, pricingPatch = {}) {
  setPricing({ ...basePricing(), ...pricingPatch, aktionen: laufende, aktion: laufende[0] || null, serverNow: iso(NOW), preisHistorie: historie });
  setColors(COLORS);
}
const vase = (pattern = 'glatt', extra = {}) => ({ product: 'vase', qty: 1, saucer: false, color: 'weiss', colorName: 'Weiß', config: { pattern, height: 150, width: 1 }, ...extra });

console.log('1) Keine Vor-Aktion → Tiefstpreis = Normalpreis, Prozent = Aktionsprozent');
{
  const A = aktion('ak-a', 15, S, NOW + 3 * TAG);
  szenario([A], [snap(NOW - 60 * TAG, { aktionen: [A] })]);
  const r = referenzpreis(vase());
  check(r && near(r.tiefst, 24.9) && r.prozent === 15, 'Vase glatt: tiefst 24,90, prozent 15', r);
  check(unitParts(vase()).unit === 21.17, 'Aktionspreis 21,17 (unverändert)', unitParts(vase()).unit);
  check(aktionProzentGueltig(A) === true, 'Banner darf „−15 %“ zeigen');
  check(referenzText(24.9).replace(/\s/g, ' ') === 'Niedrigster Preis der letzten 30 Tage: 24,90 €', 'Kennzeichnung „Niedrigster Preis der letzten 30 Tage: 24,90 €“', referenzText(24.9));
  // Warenkorb ab 2 Stück: Vergleich mit derselben Menge zum damaligen Preis MIT Mengenrabatt (24,90 × 2 × 0,9 = 44,82)
  const lp = linePrice(vase('glatt', { qty: 2 }));
  check(lp.off === 0 && near(lp.line, 42.34) && near(lp.lineRef, 44.82) && near(lp.ersparnisRef, 2.48) && lp.refProzent === 6,
    'Warenkorb ×2 (Aktion ohne Mengenrabatt): line 42,34, Streichpreis 44,82 (damals −10 %), Ersparnis 2,48, Badge −6 %', lp);
  check(near(lp.ersparnis, 2.48), 'Ersparnis gegenüber dem Normalpreis mit Staffel (wie order.aktionen auf dem Server): 2,48', lp.ersparnis);
  check(referenzTextZeile(44.82, 2).replace(/\s/g, ' ') === 'Niedrigster Preis der letzten 30 Tage für 2 Stück: 44,82 €', 'Kennzeichnung der Zeile „… für 2 Stück: 44,82 €“', referenzTextZeile(44.82, 2));
  // ×3: 24,90 × 3 × 0,85 = 63,49 < 63,51 (Aktion) → die Zeile ist teurer als vorher → kein Streichpreis, keine Ersparnis
  const l3 = linePrice(vase('glatt', { qty: 3 }));
  check(near(l3.line, 63.51) && l3.lineRef === null && l3.ersparnisRef === 0 && l3.refProzent === 0 && l3.ersparnis === 0,
    'Warenkorb ×3: 63,51 ≥ 63,49 (damals −15 %) → kein Streichpreis, kein Badge, keine Ersparnis', l3);
  const l1 = linePrice(vase('glatt'));
  check(near(l1.lineRef, 24.9) && l1.refProzent === 15 && near(l1.ersparnisRef, 3.73), '×1: Streichpreis 24,90, Badge −15 %, Ersparnis 3,73', l1);
  const lr = referenzpreis(vase('lamellen'));
  check(lr && near(lr.tiefst, 27.9) && lr.prozent === 15, 'Lamellen (+3 €): tiefst 27,90, prozent 15', lr);
}

console.log('2) Vor-Aktion −15 % endete vor 10 Tagen, neue −20 % → Tiefstpreis = 15-%-Preis, Prozent ≈ 6');
{
  const P = aktion('ak-p', 15, S - 17 * TAG, S - 10 * TAG);
  const N = aktion('ak-n', 20, S, NOW + 5 * TAG);
  szenario([N], [snap(NOW - 60 * TAG, { aktionen: [P] }), snap(S - 10 * TAG, { aktionen: [P] }), snap(S - 2 * TAG, { aktionen: [P, N] })]);
  const r = referenzpreis(vase());
  check(r && near(r.tiefst, 21.17) && r.prozent === 6, 'Vase glatt: tiefst 21,17 (Vor-Aktion), prozent 6', r);
  check(aktionProzentGueltig(N) === false, 'Banner ohne Prozentzahl (Vor-Aktion im Fenster)');
  // Vor-Aktion endete vor 31 Tagen → zählt nicht mehr
  const P2 = aktion('ak-p2', 15, S - 40 * TAG, S - 31 * TAG);
  szenario([N], [snap(NOW - 60 * TAG, { aktionen: [P2] }), snap(S - 2 * TAG, { aktionen: [P2, N] })]);
  const r2 = referenzpreis(vase());
  check(r2 && near(r2.tiefst, 24.9) && r2.prozent === 20 && aktionProzentGueltig(N), 'Vor-Aktion vor 31 Tagen beendet → tiefst 24,90, prozent 20, Banner mit Zahl', r2);
  // Vor-Aktion −25 % → neue −20 % ist teurer als der Tiefstpreis → kein Streichpreis
  const P3 = aktion('ak-p3', 25, S - 20 * TAG, S - 12 * TAG);
  szenario([N], [snap(NOW - 60 * TAG, { aktionen: [P3] })]);
  check(referenzpreis(vase()) === null, 'Vor-Aktion −25 %, neue −20 % → null (keine Ermäßigung bewerben)');
}

console.log('3) Grundpreis-Erhöhung vor 5 Tagen → Tiefstpreis = alter, niedrigerer Preis');
{
  const A = aktion('ak-a', 15, S, NOW + 3 * TAG);
  szenario([A], [snap(NOW - 60 * TAG, { single: 22.9 }), snap(S - 5 * TAG, { single: 24.9 }), snap(S - 1 * TAG, { aktionen: [A] })]);
  const r = referenzpreis(vase());
  check(r && near(r.tiefst, 22.9) && r.prozent === 8, 'Vase glatt: tiefst 22,90, prozent 8 (21,17 statt 22,90)', r);
  check(aktionProzentGueltig(A) === false, 'Banner ohne Prozentzahl (Grundpreis im Fenster niedriger)');
  // Preissenkung vor dem Fenster → zählt nicht; Erhöhung bereits vor 40 Tagen → tiefst = heutiger Preis
  szenario([A], [snap(NOW - 80 * TAG, { single: 22.9 }), snap(S - 40 * TAG, { single: 24.9 })]);
  const r2 = referenzpreis(vase());
  check(r2 && near(r2.tiefst, 24.9) && r2.prozent === 15 && aktionProzentGueltig(A), 'Erhöhung vor 40 Tagen → tiefst 24,90, prozent 15, Banner mit Zahl', r2);
  // Preis war im ganzen Fenster höher (Senkung genau zum Start) → tiefst höher, Banner-Zahl stimmt nicht
  szenario([A], [snap(NOW - 80 * TAG, { single: 29.9 }), snap(S, { single: 24.9, aktionen: [A] })]);
  const r3 = referenzpreis(vase());
  check(r3 && near(r3.tiefst, 29.9) && r3.prozent === 29 && aktionProzentGueltig(A) === false, 'Senkung zum Start: tiefst 29,90, prozent 29, Banner ohne Zahl', r3);
}

console.log('4) Aufpreise, Farben, Muster- und Produkt-Geltungsbereich');
{
  // a) Farbaufpreis Gold vor 5 Tagen von 0 auf 2 € erhöht, Aktion −10 % auf alles
  const A = aktion('ak-a', 10, S, NOW + 3 * TAG);
  szenario([A], [snap(NOW - 60 * TAG, { gold: 0 }), snap(S - 5 * TAG, { gold: 2 })]);
  const gold = referenzpreis(vase('glatt', { color: 'gold', colorName: 'Gold' }));
  check(gold && near(gold.tiefst, 24.9) && gold.prozent === 3, 'Gold (+2 € erst seit 5 Tagen): tiefst 24,90, prozent 3 (24,21)', gold);
  const weiss = referenzpreis(vase());
  check(weiss && near(weiss.tiefst, 24.9) && weiss.prozent === 10, 'Weiß (ohne Aufpreis): tiefst 24,90, prozent 10', weiss);
  const goldName = referenzpreis(vase('glatt', { color: '', colorName: 'Gold' }));
  check(goldName && near(goldName.tiefst, 24.9), 'Farbe nur über den Namen („Gold“) → gleiche Rechnung', goldName);
  check(aktionProzentGueltig(A) === false, 'Banner ohne Zahl (Farbaufpreis im Fenster niedriger)');

  // b) Vor-Aktion −20 % nur auf Gehämmert, neue −10 % auf alles
  const P = aktion('ak-p', 20, S - 15 * TAG, S - 8 * TAG, { muster: ['gehaemmert'] });
  const N = aktion('ak-n', 10, S, NOW + 3 * TAG);
  szenario([N], [snap(NOW - 60 * TAG, { aktionen: [P] })]);
  check(referenzpreis(vase('gehaemmert')) === null, 'Gehämmert: Vor-Aktion 19,92 < 22,41 → null (kein Streichpreis)');
  const rip = referenzpreis(vase('rippen'));
  check(rip && near(rip.tiefst, 24.9) && rip.prozent === 10, 'Rippen: Vor-Aktion betrifft es nicht → tiefst 24,90, prozent 10', rip);
  check(aktionProzentGueltig(N) === false, 'Banner der neuen Aktion „auf alles“ ohne Zahl (Überschneidung mit Gehämmert-Aktion)');
  const N2 = aktion('ak-n2', 10, S, NOW + 3 * TAG, { muster: ['rippen', 'wellen'] });
  szenario([N2], [snap(NOW - 60 * TAG, { aktionen: [P] })]);
  check(aktionProzentGueltig(N2) === true, 'Neue Aktion nur Rippen/Wellen: keine Überschneidung → Banner mit Zahl');

  // c) Lamellen-Aufpreis vor 5 Tagen von 2 auf 3 € erhöht, Aktion −10 %
  szenario([A], [snap(NOW - 60 * TAG, { muster: { lamellen: 2 } }), snap(S - 5 * TAG, { muster: { lamellen: 3 } })]);
  const lam = referenzpreis(vase('lamellen'));
  check(lam && near(lam.tiefst, 26.9) && lam.prozent === 7, 'Lamellen: tiefst 26,90 (alter Aufpreis), prozent 7 (25,11)', lam);
  const gl = referenzpreis(vase('glatt'));
  check(gl && near(gl.tiefst, 24.9) && gl.prozent === 10, 'Glatt: vom Lamellen-Aufpreis unberührt → prozent 10', gl);
  check(aktionProzentGueltig(A) === false, 'Aktion auf alles: Banner ohne Zahl (Lamellen im Fenster billiger)');
  const Ag = aktion('ak-g', 10, S, NOW + 3 * TAG, { muster: ['gehaemmert'] });
  szenario([Ag], [snap(NOW - 60 * TAG, { muster: { lamellen: 2 } }), snap(S - 5 * TAG, { muster: { lamellen: 3 } })]);
  check(aktionProzentGueltig(Ag) === true, 'Aktion nur Gehämmert: Lamellen-Änderung außerhalb des Bereichs → Banner mit Zahl');

  // d) Produkt-Geltungsbereich: Vor-Aktion nur auf Eierbecher, neue auf Vasen
  const Pe = aktion('ak-pe', 30, S - 10 * TAG, S - 3 * TAG, { produkte: 'eierbecher' });
  const Nv = aktion('ak-nv', 15, S, NOW + 3 * TAG, { produkte: 'vase' });
  szenario([Nv], [snap(NOW - 60 * TAG, { aktionen: [Pe] })]);
  const rv = referenzpreis(vase());
  check(rv && near(rv.tiefst, 24.9) && rv.prozent === 15 && aktionProzentGueltig(Nv), 'Eierbecher-Vor-Aktion zählt für Vasen nicht', rv);

  // e) Gravur-Aufpreis gesenkt vor 10 Tagen (war höher) → für Vasen mit Gravur zählt der heutige, niedrigere Stand
  szenario([A], [snap(NOW - 60 * TAG, { gravur: 4 }), snap(S - 10 * TAG, { gravur: 3 })]);
  const grav = referenzpreis(vase('glatt', { config: { pattern: 'glatt', height: 150, width: 1, text: 'Anna' } }));
  check(grav && near(grav.tiefst, 27.9) && grav.prozent === 10 && aktionProzentGueltig(A), 'Gravur früher teurer: tiefst 27,90 (heutiger Stand im Fenster), prozent 10, Banner mit Zahl', grav);
  // f) Größenaufschlag (XL): volumen im Fenster günstiger → tiefst mit altem Satz
  szenario([A], [snap(NOW - 60 * TAG), snap(S - 4 * TAG)].map((e, i) => (i === 0 ? { ...e, pricing: { ...e.pricing, volumen: { prozent: 50, euro: 0 } } } : e)));
  const xl = referenzpreis(vase('glatt', { config: { pattern: 'glatt', height: 180, width: 1 } }));
  // heute: 24,90 + 0,2·24,90 = 29,88 → Aktion 26,89; früher: 24,90 + 0,2·0,5·24,90 = 27,39 → prozent 2
  check(xl && near(xl.tiefst, 27.39) && xl.prozent === 2, 'XL 180 mm: tiefst 27,39 (alter Größenaufschlag), prozent 2', xl);
}

console.log('5) Vor dem ersten Eintrag gelten dessen Werte (Historie beginnt nach der Vor-Aktion)');
{
  // Server wurde erst vor 3 Tagen mit Historie gestartet; der erste Eintrag enthält die abgelaufene Aktion vom 19.09.
  const P = aktion('ak-p', 15, S - 9 * TAG, S - 4 * TAG);
  const N = aktion('ak-n', 20, S, NOW + 5 * TAG);
  szenario([N], [snap(S - 3 * TAG, { aktionen: [P] }), snap(S - 1 * TAG, { aktionen: [P, N] })]);
  const r = referenzpreis(vase());
  check(r && near(r.tiefst, 21.17) && r.prozent === 6, 'Aktion aus dem ersten Eintrag zählt für die Zeit davor → tiefst 21,17, prozent 6', r);
  // Geplant und vor dem Start wieder gelöscht → zählt nicht (Abschnitt endet vor ihrem Start)
  const X = aktion('ak-x', 30, S - 5 * TAG, S - 2 * TAG);
  szenario([N], [snap(S - 20 * TAG, { aktionen: [X] }), snap(S - 10 * TAG)]);
  const rx = referenzpreis(vase());
  check(rx && near(rx.tiefst, 24.9) && rx.prozent === 20, 'Geplante, vor dem Start gelöschte Aktion zählt nicht', rx);
  // Pausierte Aktion (nicht in der Momentaufnahme) zählt nicht; Abschnitt mit laufender Aktion bis zu ihrem Stopp schon
  const Y = aktion('ak-y', 25, S - 12 * TAG, S + 10 * TAG);
  szenario([N], [snap(S - 20 * TAG, { aktionen: [Y] }), snap(S - 11 * TAG)]);
  const ry = referenzpreis(vase());
  check(ry === null, 'Aktion −25 % lief einen Tag, dann pausiert → zählt (Tiefstpreis 18,68 < 19,92 → null)', ry);
}

console.log('6) Ohne Historie (älterer Server): aktueller Stand, laufende Aktionen zählen');
{
  const A = aktion('ak-a', 10, S - 10 * TAG, NOW + 3 * TAG);
  const B = aktion('ak-b', 20, S, NOW + 3 * TAG, { muster: ['gehaemmert'] });
  szenario([B, A], undefined);
  const g = referenzpreis(vase('gehaemmert'));
  check(g && near(g.tiefst, 22.41) && g.prozent === 11, 'Gehämmert (B −20 %): A lief schon im Fenster → tiefst 22,41, prozent 11', g);
  const gl = referenzpreis(vase('glatt'));
  check(gl && near(gl.tiefst, 24.9) && gl.prozent === 10, 'Glatt (A −10 %): tiefst 24,90, prozent 10', gl);
  check(aktionProzentGueltig(A) === true && aktionProzentGueltig(B) === false, 'Banner: A mit Zahl, B ohne Zahl');
  szenario([], undefined);
  check(referenzpreis(vase()) === null, 'Ohne Aktion → null');
}

console.log('7) Zeilen-Streichpreis ab 2 Stück: Aktion −5 % ohne / −15 % mit Mengenrabatt, Einträge ohne Staffel');
{
  // −5 % ohne Mengenrabatt: 2 Stück kosten 47,30 € (23,65 × 2) statt vorher 44,82 € → kein Zeilen-Streichpreis
  const A = aktion('ak-a', 5, S, NOW + 3 * TAG);
  szenario([A], [snap(NOW - 60 * TAG, { aktionen: [A] })]);
  const lp = linePrice(vase('glatt', { qty: 2 }));
  check(near(lp.line, 47.3) && lp.lineRef === null && lp.ersparnisRef === 0 && lp.ersparnis === 0, '−5 % ohne Mengenrabatt ×2: 47,30 > 44,82 → kein Streichpreis, keine Ersparnis', lp);
  check(lp.ref && lp.ref.prozent === 5, 'Stückpreis-Bezug bleibt (Konfigurator zeigt −5 % je Stück)', lp.ref);
  // −15 % MIT Mengenrabatt: 21,17 × 2 × 0,9 = 38,11 gegen 44,82 → Ersparnis 6,71, Badge −15 %
  const M = aktion('ak-m', 15, S, NOW + 3 * TAG, { mengenrabatt: true });
  szenario([M], [snap(NOW - 60 * TAG, { aktionen: [M] })]);
  const lm = linePrice(vase('glatt', { qty: 2 }));
  check(lm.off === 10 && near(lm.line, 38.11) && near(lm.lineRef, 44.82) && near(lm.ersparnisRef, 6.71) && lm.refProzent === 15, 'Aktion mit Mengenrabatt ×2: line 38,11, Streichpreis 44,82, Ersparnis 6,71, −15 %', lm);
  // Vor-Aktion −20 % mit Mengenrabatt im Fenster: damals 19,92 × 2 × 0,9 = 35,86 < 38,11 → kein Streichpreis
  const P = aktion('ak-p', 20, S - 12 * TAG, S - 5 * TAG, { mengenrabatt: true });
  szenario([M], [snap(NOW - 60 * TAG, { aktionen: [P] })]);
  check(linePrice(vase('glatt', { qty: 2 })).lineRef === null, 'Vor-Aktion −20 % mit Mengenrabatt → ×2 kein Streichpreis');
  // dieselbe Vor-Aktion OHNE Mengenrabatt: je Stück war es damals billiger (19,92 < 21,17) → kein Stückpreis-Bezug und damit auch
  // kein Zeilen-Streichpreis, obwohl 2 Stück damals 39,84 kosteten (wie im Konfigurator: ohne Bezugspreis kein Streichpreis)
  const P2 = aktion('ak-p2', 20, S - 12 * TAG, S - 5 * TAG, { mengenrabatt: false });
  szenario([M], [snap(NOW - 60 * TAG, { aktionen: [P2] })]);
  check(linePrice(vase('glatt', { qty: 2 })).lineRef === null, 'Vor-Aktion −20 % ohne Mengenrabatt → kein Stückpreis-Bezug, ×2 kein Streichpreis');
  // Vor-Aktion −10 % ohne Mengenrabatt: je Stück Bezug 22,41 (−6 %), 2 Stück kosteten damals höchstens 44,82 → Zeile −15 %
  const P3 = aktion('ak-p3', 10, S - 12 * TAG, S - 5 * TAG, { mengenrabatt: false });
  szenario([M], [snap(NOW - 60 * TAG, { aktionen: [P3] })]);
  const lp3 = linePrice(vase('glatt', { qty: 2 }));
  check(lp3.ref?.prozent === 6 && near(lp3.lineRef, 44.82) && lp3.refProzent === 15 && near(lp3.ersparnisRef, 6.71), 'Vor-Aktion −10 % ohne Mengenrabatt → je Stück −6 %, ×2 Streichpreis 44,82 (−15 %)', lp3);
  // Momentaufnahme ohne Staffel (von vor der Erweiterung) im Fenster → ab 2 Stück kein Zeilen-Streichpreis, 1 Stück wie bisher
  szenario([M], [snap(NOW - 60 * TAG, { staffel: null }), snap(S - 5 * TAG)]);
  check(linePrice(vase('glatt', { qty: 2 })).lineRef === null, 'Eintrag ohne Staffel im Fenster → ×2 kein Streichpreis (damaliger Zeilenpreis unbekannt)');
  const one = linePrice(vase('glatt'));
  check(near(one.lineRef, 24.9) && one.refProzent === 15, 'Eintrag ohne Staffel → ×1 weiter Streichpreis 24,90', one);
  // Staffel war im Fenster höher (−20 % ab 2) → Zeilen-Tiefstpreis 39,84
  szenario([M], [snap(NOW - 60 * TAG, { staffel: [{ qty: 2, off: 20 }] }), snap(S - 5 * TAG)]);
  const hs = linePrice(vase('glatt', { qty: 2 }));
  check(near(hs.lineRef, 39.84) && near(hs.ersparnisRef, 1.73), 'Staffel im Fenster höher (−20 %) → ×2 Streichpreis 39,84', hs);
}

console.log('8) Versandhinweis am Preis (§ 6 PAngV) und USt.-Hinweis (§ 19 UStG)');
{
  szenario([], undefined);
  const nb = (t) => t.replace(/\u00a0/g, ' ');
  check(nb(versandText()) === 'zzgl. 4,90 € Versand · ab 39 € versandfrei', 'versandText: „zzgl. 4,90 € Versand · ab 39 € versandfrei“', versandText());
  check(/^zzgl\. <a href="\/versand" target="_blank" rel="noopener">4,90.€ Versand<\/a> · ab 39.€ versandfrei$/.test(versandHTML()), 'versandHTML lang: Link auf /versand', versandHTML());
  check(/^zzgl\. <a href="\/versand"[^>]*>Versand<\/a>$/.test(versandHTML({ kurz: true })), 'versandHTML kurz: „zzgl. Versand“ mit Link', versandHTML({ kurz: true }));
  check(ustText() === '', 'ohne shop.kleinunternehmer kein USt.-Hinweis');
  szenario([], undefined, { shipping: { flat: 0, freeFrom: 0 }, shop: { kleinunternehmer: true } });
  check(versandText() === 'Versandkostenfrei' && /Versandkostenfrei/.test(versandHTML({ kurz: true })), 'Versand 0 € → „Versandkostenfrei“');
  check(ustText() === 'Endpreis, keine USt. nach § 19 UStG', 'Kleinunternehmer → „Endpreis, keine USt. nach § 19 UStG“');
  szenario([], undefined, { shipping: { flat: 5.5, freeFrom: 0 } });
  check(nb(versandText()) === 'zzgl. 5,50 € Versand', 'ohne Freigrenze: „zzgl. 5,50 € Versand“', versandText());
  setPricing(null);
  check(versandText() === '' && versandHTML() === '', 'ohne Preise leer');
}

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
