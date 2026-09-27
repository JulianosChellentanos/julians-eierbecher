// formsam — Lieferzeit und Beginn der Lieferfrist: eine Quelle für AGB § 7 und Versandseite (lib/legal.js), Bestellbestätigung
// (lib/mail-templates.js), Rechnung und /api/pricing → shop.fristBeginn (server.js, daraus der Hinweis nach dem Bestellen in der Kasse).
// Bewusst ein eigenes kleines Modul ohne Importe: server.js lädt lib/legal.js dynamisch (ein Fehler dort darf den Shop nicht
// stoppen), die Mail-Vorlagen dagegen fest — so hängen beide an derselben Formulierung, ohne voneinander abzuhängen.

/** Standard-Lieferzeit, wenn in den Einstellungen (settings.shop.lieferzeit) nichts steht */
export const LIEFERZEIT_STANDARD = '5–8 Werktage';

/**
 * Lieferzeit wie in den Einstellungen („5–8 Werktage“) — ohne „ca.“: Die AGB nennen die Frist verbindlich, Bestätigung und
 * Rechnung dürfen nicht unbestimmter formulieren.
 */
export function lieferzeitText(settings) {
  return String(settings?.shop?.lieferzeit || '').trim() || LIEFERZEIT_STANDARD;
}

/** Fristbeginn je Zahlungsart (Satzteil) — der Wortlaut der AGB § 7 (Vertragsschluss mit der Bestellbestätigung, AGB § 3) */
export const FRIST_BEGINN = {
  vorkasse: 'am Tag nach deinem Überweisungsauftrag an deine Bank',
  paypal: 'am Tag nach Vertragsschluss',
};

/**
 * Ein Satz zum Fristbeginn für eine Bestellung (Bestätigung, Rechnung, Kasse):
 * Vorkasse → „Die Frist beginnt am Tag nach deinem Überweisungsauftrag an deine Bank.“
 * PayPal   → „Die Frist beginnt am Tag nach Vertragsschluss, also am Tag nach deiner Bestellung.“
 */
export function fristBeginnKurz(payment) {
  return payment === 'paypal'
    ? `Die Frist beginnt ${FRIST_BEGINN.paypal}, also am Tag nach deiner Bestellung.`
    : `Die Frist beginnt ${FRIST_BEGINN.vorkasse}.`;
}

/**
 * Fristbeginn für AGB § 7 und die Versandseite (alle angebotenen Zahlungsarten in einem Satz + Werktagsregel):
 * „Bei Vorkasse beginnt die Frist am Tag nach …, bei Zahlung mit PayPal am Tag nach Vertragsschluss. Fällt das Fristende …“
 */
export function fristBeginnAgb({ paypal = false } = {}) {
  return `Bei Vorkasse beginnt die Frist ${FRIST_BEGINN.vorkasse}${paypal ? `, bei Zahlung mit PayPal ${FRIST_BEGINN.paypal}` : ''}. ` +
    'Fällt das Fristende auf einen Samstag, Sonntag oder gesetzlichen Feiertag am Lieferort, endet die Frist am nächsten Werktag.';
}
