// formsam — Rechtstexte: Impressum, Datenschutz, AGB, Widerruf (mit elektronischer Widerrufsfunktion), Versand & Zahlung
//
//   import { LEGAL_SLUGS, renderLegalPage } from './lib/legal.js';
//   const html = renderLegalPage('impressum', { settings, baseUrl });   // → komplettes HTML (string) oder null
//
// Alle veränderlichen Angaben kommen aus den Einstellungen und werden HTML-maskiert:
//   settings.company (Anbieter, Kontakt, USt-IdNr., Kleinunternehmer), settings.shop (Lieferzeit, Liefergebiet),
//   settings.legal (Hoster, Serverstandort), settings.pricing.shipping (Versandkosten, Freigrenze),
//   settings.paypal (PayPal wird genannt, sobald der Shop es anbietet: enabled + clientId wie /api/pricing).
// Die Seiten sind eigenständig: eigene Hülle im formsam-Look, Schriften aus /fonts, keine externen Ressourcen.
// Die Widerrufsseite enthält den Abschnitt #widerrufen („Vertrag widerrufen“ → Formular → „Widerruf bestätigen“),
// der POST /api/widerruf aufruft. Optional { forMail: true }: ohne Skripte und Formular, Links absolut (für Mail-Anhänge).
// Annahmen und offene Punkte für den Betreiber: docs/rechtstexte.md — keine Rechtsberatung.
// Lieferzeit-Fristbeginn kommt aus lib/lieferfrist.js — dieselbe Formulierung steht in Bestellbestätigung und Rechnung.
import { fristBeginnAgb } from './lieferfrist.js';

export const LEGAL_SLUGS = ['impressum', 'datenschutz', 'agb', 'widerruf', 'versand'];

/** Stand aller Texte — bei inhaltlichen Änderungen hier anpassen */
export const LEGAL_STAND = '2026-09-27';
const STAND_TEXT = '27. September 2026';

const DEFAULT_SHOP = { lieferzeit: '5–8 Werktage', liefergebiet: 'Deutschland' };
const DEFAULT_LEGAL = { hoster: 'IONOS SE, Elgendorfer Str. 57, 56410 Montabaur', serverOrt: 'Berlin (Deutschland)' };
const PAYPAL_FIRMA = 'PayPal (Europe) S.à r.l. et Cie, S.C.A., 22–24 Boulevard Royal, L-2449 Luxemburg';
const PAYPAL_DATENSCHUTZ = 'https://www.paypal.com/de/webapps/mpp/ua/privacy-full';
const EMAIL_RE = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;
// typische Platzhalter aus den Standard-Einstellungen (nur für legalWarnings — angezeigt wird immer der echte Wert)
const PLATZHALTER_RE = /musterstra(ß|ss)e|^0{5}$|musterstadt/i;

const PAGES = {
  impressum: { nav: 'Impressum', title: 'Impressum', h1: 'Impressum', desc: 'Impressum von formsam: Anbieter, Kontakt und Pflichtangaben nach § 5 DDG.' },
  datenschutz: { nav: 'Datenschutz', title: 'Datenschutz', h1: 'Datenschutzerklärung', desc: 'Welche Daten formsam verarbeitet, wofür und wie lange – und welche Rechte du hast.' },
  agb: { nav: 'AGB', title: 'AGB', h1: 'Allgemeine Geschäftsbedingungen', desc: 'Allgemeine Geschäftsbedingungen von formsam für individuell gestaltete, 3D-gedruckte Vasen.' },
  widerruf: { nav: 'Widerruf', title: 'Widerruf', h1: 'Widerruf', desc: 'Widerrufsbelehrung, Muster-Widerrufsformular und die Funktion „Vertrag widerrufen“ bei formsam.' },
  versand: { nav: 'Versand & Zahlung', title: 'Versand & Zahlung', h1: 'Versand & Zahlung', desc: 'Liefergebiet, Lieferzeit, Versandkosten und Zahlungsarten bei formsam.' },
};

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** Text aus den Einstellungen: Steuerzeichen raus, getrimmt, Länge begrenzt */
const str = (v, n = 300) => String(v ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n);
/** Geschützte Leerzeichen in Paragrafen- und Abkürzungsangaben („§ 312g“, „Art. 6“, „z. B.“) — nur für Fließtext */
const nbsp = (html) => html
  .replace(/(§§?|Art\.|Abs\.|lit\.|Nr\.|S\.) (?=[0-9a-z])/g, '$1&nbsp;')
  .replace(/\bz\. B\./g, 'z.&nbsp;B.').replace(/\bi\. d\. R\./g, 'i.&nbsp;d.&nbsp;R.').replace(/\bd\. h\./g, 'd.&nbsp;h.');

/**
 * Einstellungen → Werte für die Texte (mit Standardwerten, falls die Migration in server.js noch nicht gelaufen ist).
 * Die alte Marke wird nie angezeigt: enthält company.name noch „OVJU“/„Eierbecher“, heißt der Anbieter „formsam“.
 */
function context(settings, baseUrl) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const co = s.company && typeof s.company === 'object' ? s.company : {};
  const rawName = str(co.name, 120);
  let ustId = str(co.ustId, 40), wIdNr = str(co.wIdNr, 40);
  // Wirtschafts-Identifikationsnummer (DE123456789-00001) im USt-IdNr.-Feld → als W-IdNr. ausweisen
  if (!wIdNr && /^DE\d{9}-\d{5}$/i.test(ustId.replace(/\s+/g, ''))) { wIdNr = ustId; ustId = ''; }
  const ship = s.pricing?.shipping || {};
  const currency = /^[A-Z]{3}$/.test(String(s.pricing?.currency || '')) ? s.pricing.currency : 'EUR';
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const httpBase = /^https?:\/\/[^\s"'<>]+$/i.test(base) ? base : '';
  // Öffentliche Adresse nur, wenn sie nicht auf den eigenen Rechner zeigt (Standard ohne publicUrl: http://localhost:4488)
  const publicBase = httpBase && !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(httpBase) ? httpBase : '';
  const hoster = str(s.legal?.hoster, 200) || DEFAULT_LEGAL.hoster;
  return {
    brand: rawName && !/ovju|eierbecher/i.test(rawName) ? rawName : 'formsam',
    owner: str(co.owner, 120),
    street: str(co.street, 200), zip: str(co.zip, 20), city: str(co.city, 120),
    country: str(co.country, 80) || 'Deutschland',
    email: str(co.email, 254), phone: str(co.phone, 60),
    ustId, wIdNr,
    klein: co.kleinunternehmer !== false,   // Standard in DEFAULT_SETTINGS: true
    lieferzeit: str(s.shop?.lieferzeit, 80) || DEFAULT_SHOP.lieferzeit,
    liefergebiet: str(s.shop?.liefergebiet, 120) || DEFAULT_SHOP.liefergebiet,
    hoster, hosterName: hoster.split(',')[0].trim() || hoster,
    serverOrt: str(s.legal?.serverOrt, 120) || DEFAULT_LEGAL.serverOrt,
    flat: Number(ship.flat), freeFrom: Number(ship.freeFrom), currency,
    // PayPal gilt als angeboten, wenn der Shop die Knöpfe zeigt (Spiegel von /api/pricing: enabled && clientId)
    paypal: !!(s.paypal?.enabled && s.paypal?.clientId),
    httpBase, publicBase, https: /^https:\/\//i.test(publicBase),
  };
}
function money(v, c) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: c.currency }).format(Math.round(Number(v) * 100) / 100);
}
/** Anschrift als Zeilen (HTML, maskiert) */
function anschrift(c, { marke = true } = {}) {
  const lines = [];
  if (marke) lines.push(`<strong>${esc(c.brand)}</strong>`);
  if (c.owner) lines.push(esc(c.owner));
  if (c.street) lines.push(esc(c.street));
  if (c.zip || c.city) lines.push(esc([c.zip, c.city].filter(Boolean).join(' ')));
  if (c.country) lines.push(esc(c.country));
  return lines.join('<br>');
}
/** Anschrift in einer Zeile (für Fließtext) */
const anschriftZeile = (c) => esc([c.brand, c.owner, c.street, [c.zip, c.city].filter(Boolean).join(' '), c.country].filter(Boolean).join(', '));
const mailLink = (c) => (c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '<em>E-Mail-Adresse folgt</em>');
const telLink = (c) => (c.phone ? `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a>` : '');
/** „ich“ mit Namen: „Julian Sendlhofer“, ohne Inhaber die Marke */
const wer = (c) => esc(c.owner || c.brand);

/** Versandkosten in Worten — dieselbe Regel wie computeTotals(): Versand frei, wenn Bestellwert ≥ freeFrom */
function versandText(c) {
  if (!(c.flat > 0) || (Number.isFinite(c.freeFrom) && c.freeFrom <= 0)) {
    return { kurz: 'kostenlos', satz: 'Der Versand ist für dich kostenlos.' };
  }
  const je = `Der Versand kostet ${money(c.flat, c)} je Bestellung – egal, wie viele Vasen darin sind.`;
  if (!Number.isFinite(c.freeFrom)) return { kurz: `${money(c.flat, c)} je Bestellung`, satz: je };
  return {
    kurz: `${money(c.flat, c)} · ab ${money(c.freeFrom, c)} kostenlos`,
    satz: `${je} Ab einem Bestellwert von ${money(c.freeFrom, c)} verschicke ich versandkostenfrei. Bestellwert ist die Summe deiner Vasen nach allen Rabatten und Gutscheinen.`,
  };
}
/** Umsatzsteuer-Satz für Preisangaben (Kleinunternehmer vs. Regelbesteuerung) */
const ustSatz = (c) => (c.klein
  ? 'Als Kleinunternehmer nach § 19 UStG bin ich von der Umsatzsteuer befreit. Meine Preise enthalten deshalb keine Umsatzsteuer, und die Rechnung weist keine aus.'
  : 'Alle Preise enthalten die gesetzliche Umsatzsteuer.');
/** Beginn der Lieferfrist je Zahlungsart (Wortlaut aus lib/lieferfrist.js — Bestätigung und Rechnung sagen dasselbe) */
const fristBeginn = (c) => fristBeginnAgb({ paypal: c.paypal });

/** Abschnitt mit Überschrift und Anker */
const section = (id, title, html) => ({ id, title, html });
function renderSections(list) {
  return list.map((s) => `<section id="${s.id}" aria-labelledby="${s.id}-h"><h2 id="${s.id}-h">${s.title}</h2>${s.html}</section>`).join('\n');
}
function toc(list, { open = false, nummern = true } = {}) {
  return `<details class="toc"${open ? ' open' : ''}><summary>Inhalt dieser Seite</summary><ol${nummern ? '' : ' class="plain"'}>${list.map((s) => `<li><a href="#${s.id}">${s.title}</a></li>`).join('')}</ol></details>`;
}
/** Nummerierte Absätze „(1) …“ */
const absaetze = (items) => `<ol class="abs">${items.filter(Boolean).map((t) => `<li>${t}</li>`).join('')}</ol>`;

// ---------------------------------------------------------------------------
// Impressum (§ 5 DDG)
// ---------------------------------------------------------------------------
function impressum(c) {
  const steuer = [
    c.ustId ? `<p>Umsatzsteuer-Identifikationsnummer nach § 27a UStG: ${esc(c.ustId)}</p>` : '',
    c.wIdNr ? `<p>Wirtschafts-Identifikationsnummer nach § 139c AO: ${esc(c.wIdNr)}</p>` : '',
    c.klein ? '<p>Kleinunternehmer nach § 19 UStG.</p>' : '',
  ].join('');
  return `
<p class="lead">Angaben nach § 5 DDG.</p>
<section id="anbieter" aria-labelledby="anbieter-h"><h2 id="anbieter-h">Anbieter</h2>
<p class="addr">${anschrift(c)}</p></section>
<section id="kontakt" aria-labelledby="kontakt-h"><h2 id="kontakt-h">Kontakt</h2>
<p>E-Mail: ${mailLink(c)}${c.phone ? `<br>Telefon: ${telLink(c)}` : ''}</p></section>
${steuer ? `<section id="steuer" aria-labelledby="steuer-h"><h2 id="steuer-h">Umsatzsteuer</h2>${steuer}</section>` : ''}
<section id="inhalt-verantwortlich" aria-labelledby="inhalt-verantwortlich-h"><h2 id="inhalt-verantwortlich-h">Verantwortlich für den Inhalt</h2>
<p>${wer(c)}, Anschrift wie oben (§ 18 Abs. 2 MStV).</p></section>
<section id="streitbeilegung" aria-labelledby="streitbeilegung-h"><h2 id="streitbeilegung-h">Verbraucherstreitbeilegung</h2>
<p>Ich bin nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen (§ 36 VSBG).</p>
<p>Wenn etwas nicht passt, schreib mir einfach. Meistens lässt es sich direkt klären.</p></section>
<section id="bilder" aria-labelledby="bilder-h"><h2 id="bilder-h">Bilder</h2>
<p>Die Raum- und Produktbilder im Shop sind KI-Inszenierungen auf Basis der 3D-Modelle aus dem Konfigurator und dort als solche gekennzeichnet. Wie deine Vase aussieht, zeigt die Live-Vorschau im Konfigurator.</p></section>`;
}

// ---------------------------------------------------------------------------
// Datenschutzerklärung (DSGVO) — beschreibt, was server.js, lib/mailer.js und public/js/* tatsächlich tun
// ---------------------------------------------------------------------------
function datenschutzSections(c) {
  const pp = c.paypal;
  return [
    section('kurz', 'Das Wichtigste in Kürze', `
<div class="box"><ul>
<li>Der Shop setzt keine Cookies. Es gibt kein Tracking, keine Analyse-Tools, keine Werbung und keinen Newsletter.</li>
<li>Schriften, Bilder und Programmteile kommen von meinem eigenen Server.${pp ? ' Einzige Ausnahme: In der Kasse lädt dein Browser die Zahlungsknöpfe von PayPal (siehe „Zahlung“).' : ''}</li>
<li>Ich verarbeite nur, was für Konfigurator, Bestellung, Kundenkonto und Versand nötig ist.</li>
<li>Der Server steht in ${esc(c.serverOrt)}.</li>
</ul></div>`),

    section('verantwortlicher', 'Verantwortlicher', `
<p>Verantwortlich für die Datenverarbeitung auf dieser Website ist:</p>
<p class="addr">${anschrift(c)}</p>
<p>E-Mail: ${mailLink(c)}${c.phone ? `<br>Telefon: ${telLink(c)}` : ''}</p>
<p>Ich betreibe ${esc(c.brand)} allein. Einen Datenschutzbeauftragten muss ich nicht benennen. Bei Fragen zum Datenschutz schreib mir direkt.</p>`),

    section('hosting', 'Hosting und Server', `
<p>Der Shop läuft auf einem Server, den ich bei ${esc(c.hoster)} miete. Der Server steht in ${esc(c.serverOrt)}. Dort liegen alle Daten des Shops: Bestellungen, Kundenkonten, Design-Codes und Listen.</p>
<p>${esc(c.hosterName)} verarbeitet diese Daten nur in meinem Auftrag und nach meinen Weisungen. Dafür habe ich einen Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO geschlossen.</p>
${c.https ? '<p>Die Verbindung zwischen deinem Browser und dem Shop ist verschlüsselt (HTTPS).</p>' : ''}
<p>Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO, soweit es um deine Bestellung oder dein Konto geht, sonst Art. 6 Abs. 1 lit. f DSGVO. Mein berechtigtes Interesse ist ein sicherer und zuverlässiger Betrieb des Shops.</p>`),

    section('aufruf', 'Wenn du die Website aufrufst', `
<p>Damit der Server dir eine Seite schicken kann, verarbeitet er technisch notwendig deine IP-Adresse, Datum und Uhrzeit, die aufgerufene Adresse, die übertragene Datenmenge und die Kennung deines Browsers.</p>
<p><strong>Zugriffsprotokolle:</strong> Die Shop-Software selbst schreibt keine Zugriffsprotokolle. Der vorgeschaltete Webserver, der die verschlüsselte Verbindung herstellt, protokolliert Zugriffe mit den genannten Daten und der zuvor besuchten Seite, falls dein Browser sie mitschickt. Ich brauche die Protokolle, um Fehler zu finden und Angriffe abzuwehren, und lösche sie nach spätestens 14 Tagen.</p>
<p><strong>Betriebsmeldungen:</strong> Der Server notiert kurze Meldungen, etwa bei Fehlern, wenn eine Bestellung eingeht (Bestellnummer, Betrag, Name) oder eine E-Mail verschickt wurde (Empfänger, Betreff). Auch sie dienen der Fehlersuche und werden nach spätestens 14 Tagen gelöscht.</p>
<p><strong>Schutz vor Missbrauch:</strong> Bei „Passwort vergessen“ und bei der Widerrufsfunktion zählt der Server kurzzeitig, wie oft eine IP-Adresse oder E-Mail-Adresse die Funktion nutzt. Genauso zählt er, wie oft eine IP-Adresse Rechnungen oder Bestellungen mit falscher Adresse oder falschem Schlüssel abruft, und sperrt sie danach für kurze Zeit. Diese Zähler liegen nur im Arbeitsspeicher und verfallen nach kurzer Zeit. Sie werden nicht dauerhaft gespeichert.</p>
<p>Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO. Mein berechtigtes Interesse ist ein stabiler und sicherer Betrieb.</p>`),

    section('browser', 'Speicherung in deinem Browser', `
<p>Der Shop setzt keine Cookies. Damit Warenkorb, Anmeldung und Einstellungen funktionieren, legt er einige Einträge im lokalen Speicher deines Browsers ab (<span class="nohy">localStorage</span> bzw. <span class="nohy">sessionStorage</span>). Sie bleiben auf deinem Gerät. An meinen Server gehen sie nur, wenn du eine Funktion nutzt, die sie braucht, zum Beispiel die Anmeldung.</p>
<dl class="facts">
<dt>Warenkorb</dt><dd>Deine Designs mit Vorschaubild, Farbe und Menge. Bleibt, bis du bestellst oder den Warenkorb leerst.</dd>
<dt>Anmeldung</dt><dd>Eine zufällige Sitzungskennung, solange du im Kundenkonto angemeldet bist. Wird beim Abmelden gelöscht.</dd>
<dt>Hell oder dunkel</dt><dd>Deine Wahl des Erscheinungsbilds – nur, wenn du sie selbst triffst.</dd>
<dt>Eigene Listen</dt><dd>Codes und Bearbeitungsschlüssel deiner Design-Listen, damit nur du sie ändern kannst.</dd>
<dt>Handy-Ansicht</dt><dd>Im <span class="nohy">sessionStorage</span>: berechnete Vorschaubilder der Oberflächen und zwei Merker (Wisch-Hinweis gesehen, 3D-Ansicht auf diesem Gerät ausgefallen). Dein Browser löscht sie, wenn du den Tab schließt.</dd>
</dl>
<p><strong>Service Worker:</strong> Beim Besuch des Shops registriert dein Browser einen sogenannten Service Worker. Er legt Programmdateien, Schriften und Bilder des Shops im Browser-Cache ab. So lädt der Shop schneller und kann ohne Internetverbindung einen Hinweis zeigen. Bestellungen, Rechnungen, Kontodaten und Antworten auf deine Eingaben speichert er dort nicht.</p>
<p>Das Speichern und Auslesen dieser Einträge ist unbedingt erforderlich, damit ich dir die Funktionen bereitstellen kann, die du ausdrücklich nutzt (§ 25 Abs. 2 Nr. 2 TDDDG). Eine Einwilligung ist dafür nicht nötig. Für die weitere Verarbeitung gilt Art. 6 Abs. 1 lit. b DSGVO (Warenkorb, Konto) bzw. lit. f DSGVO (Darstellung des Shops).</p>
<p>Du kannst alle Einträge jederzeit in den Einstellungen deines Browsers löschen (Websitedaten).</p>`),

    section('designs', 'Konfigurator, Design-Codes und Listen', `
<p>Der Konfigurator läuft in deinem Browser. Solange du nur gestaltest, geht dein Design nicht an meinen Server.</p>
<h3>Design-Codes</h3>
<p>Wenn du ein Design in den Warenkorb legst, einen Design-Code erzeugst oder es zu einer Liste hinzufügst, speichert der Server die Gestaltung unter einem kurzen Code: Form, Maße, Oberfläche, Farbe und – falls vorhanden – den Gravurtext. Dazu kommen ein Vorschaubild, der Zeitpunkt der Erstellung und wie oft und wann der Code zuletzt geladen wurde. Name, E-Mail-Adresse oder IP-Adresse speichere ich dazu nicht.</p>
<p>Jeder, der den Code kennt, kann das Design laden. Gib ihn also nur weiter, wenn das für dich passt – besonders, wenn deine Gravur einen Namen enthält.</p>
<h3>Design-Listen</h3>
<p>Legst du eine Liste an, speichert der Server Name, Anlass und Notiz der Liste, die enthaltenen Design-Codes mit Menge und einen Bearbeitungsschlüssel. Lesen kann die Liste jeder, der den Listen-Code oder -Link hat. Ändern oder löschen kann sie nur, wer den Bearbeitungsschlüssel hat. Er liegt in deinem Browser.</p>
<h3>Druckdatei herunterladen</h3>
<p>Die STL- bzw. 3MF-Datei zum Herunterladen entsteht in deinem Browser. Dafür wird nichts an den Server geschickt.</p>
<p>Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO, weil du die Funktion nutzt, und Art. 6 Abs. 1 lit. f DSGVO. Mein berechtigtes Interesse ist, dass Codes und Listen dauerhaft funktionieren.</p>
<p>Speicherdauer: Design-Codes und Vorschaubilder bleiben gespeichert, damit ein Code auch später noch funktioniert, zum Beispiel für eine Nachbestellung. Enthält deine Gravur einen Namen und du möchtest den Code löschen lassen, schreib mir. Listen bleiben, bis du sie löschst.</p>`),

    section('bestellung', 'Bestellung', `
<p>Für eine Bestellung verarbeite ich: Name, E-Mail-Adresse, Lieferadresse, deine Anmerkung (falls du eine schreibst), die bestellten Designs samt Gravur, Preise, Gutschein, Zahlungsart und Zahlungsstatus${pp ? ', bei PayPal die Transaktionsnummer' : ''}, den Zeitpunkt, zu dem du der Vereinbarung zu Wasser und Standfestigkeit zugestimmt hast, und den Bearbeitungsverlauf (zum Beispiel „bezahlt“, „versendet“, Sendungsnummer). Bist du angemeldet, ordne ich die Bestellung deinem Kundenkonto zu.</p>
<p>Die Druckdateien (STL/3MF) erzeugt dein Browser und lädt sie mit der Bestellung hoch. Sie enthalten nur die Form deiner Vase, samt Gravur.</p>
<p>Ich nutze diese Daten, um deine Vase zu drucken, zu verschicken und abzurechnen und um Fragen und Reklamationen zu bearbeiten. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO. Für die Aufbewahrung von Rechnungen und Buchungsbelegen gilt Art. 6 Abs. 1 lit. c DSGVO in Verbindung mit § 147 AO und § 257 HGB.</p>
<p>Deine Rechnung liegt als Seite auf dem Server, eine Gutschrift oder ein Stornobeleg ebenso. Abrufen kann sie nur, wer den Link kennt. Er steht in der Bestellbestätigung, nach dem Bestellen in der Kasse und bei Bestellungen mit Kundenkonto unter „Mein Konto“. Neben deiner Bestellnummer enthält er einen zufälligen, geheimen Schlüssel – die Bestellnummer allein reicht nicht. Gib den Link deshalb nur weiter, wenn das für dich passt. Die Druckdateien deiner Bestellung sind genauso geschützt.</p>
<p>Ausnahme sind ältere Bestellungen, deren Nummer mit „OV-“ beginnt: Ihr Link enthält noch keinen Schlüssel. Belege und Druckdateien einer solchen Bestellung kann abrufen, wer die Bestellnummer kennt. Das Durchprobieren von Bestellnummern bremst der Server (siehe „Schutz vor Missbrauch“). Möchtest du das für deine Bestellung nicht, schreib mir – dann bekommt sie nachträglich einen Schlüssel und du einen neuen Link.</p>
<p>Für eine Bestellung brauche ich Name, E-Mail-Adresse und Lieferadresse. Ohne diese Angaben kann ich den Vertrag nicht erfüllen. Alles andere ist freiwillig.</p>`),

    section('zahlung', 'Zahlung', `
<h3>Vorkasse</h3>
<p>Du überweist den Betrag auf mein Konto. Dabei erhalte ich über meine Bank die Angaben deiner Überweisung: Name, IBAN, Betrag und Verwendungszweck. Rechtsgrundlage: Art. 6 Abs. 1 lit. b und lit. c DSGVO.</p>
${pp ? `<h3>PayPal</h3>
<p>Wenn du mit PayPal bezahlst, wickelt ${esc(PAYPAL_FIRMA)} die Zahlung ab.</p>
<p>Sobald du in der Kasse PayPal als Zahlungsart wählst, lädt dein Browser die Zahlungsknöpfe von www.paypal.com. Dabei erhält PayPal technisch bedingt deine IP-Adresse und Angaben zu deinem Browser und kann eigene Cookies oder ähnliche Techniken einsetzen. Die Anmeldung bei PayPal und die Zahlung selbst laufen direkt bei PayPal.</p>
<p>Mein Server schickt PayPal nur Betrag, Währung und eine kurze Beschreibung. Von PayPal bekomme ich die Bestätigung der Zahlung mit Transaktionsnummer, Betrag und Zeitpunkt. Zur Prüfung speichere ich diese Angaben für die letzten 500 Zahlungen und bei deiner Bestellung. Bei einer Erstattung schicke ich PayPal Betrag und Bestellnummer.</p>
<p>PayPal ist für die Verarbeitung in seinem Bereich selbst verantwortlich und kann Daten auch außerhalb der EU verarbeiten. Näheres steht in der <a href="${PAYPAL_DATENSCHUTZ}" rel="noopener">Datenschutzerklärung von PayPal</a>.</p>
<p>Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO für die Zahlung und Art. 6 Abs. 1 lit. f DSGVO für das Laden der Zahlungsknöpfe. Mein berechtigtes Interesse ist, dir PayPal als Zahlungsart anzubieten.</p>` : ''}
<h3>Erstattungen</h3>
<p>Erstatte ich dir Geld per Überweisung, zum Beispiel nach einer Reklamation, speichere ich dafür die IBAN, die du mir nennst, bei deiner Bestellung. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.</p>`),

    section('versand', 'Versand', `
<p>Damit dein Paket ankommt, gebe ich Name und Lieferadresse an das Versandunternehmen weiter, das es zustellt (zum Beispiel DHL, Deutsche Post, Hermes, DPD oder GLS). Deine E-Mail-Adresse gebe ich dafür nicht weiter. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.</p>
<p>Die Sendungsverfolgung in deinem Kundenkonto verlinkt auf die Website des Versandunternehmens. Öffnest du den Link, gilt dort dessen Datenschutzerklärung.</p>`),

    section('konto', 'Kundenkonto', `
<p>Ein Kundenkonto ist freiwillig. Du kannst auch ohne Konto bestellen.</p>
<p>Für das Konto speichere ich Name, E-Mail-Adresse, den Zeitpunkt der Registrierung, auf Wunsch deine Standard-Lieferadresse und dein Passwort. Das Passwort liegt nur als Hash vor (scrypt mit zufälligem Salt), also nie im Klartext. Im Konto siehst du deine Bestellungen. Dazu ordne ich Bestellungen zu, die du angemeldet aufgibst. Bestellungen, die ohne Anmeldung mit deiner E-Mail-Adresse aufgegeben wurden, zeige ich dort erst, wenn du die Adresse bestätigt hast.</p>
<p><strong>E-Mail-Adresse bestätigen:</strong> Nach der Registrierung schicke ich dir eine E-Mail mit einem Bestätigungslink. Er gilt 7 Tage und funktioniert nur, während du in deinem Konto angemeldet bist. Auf dem Server liegt davon nur ein Hash; nach dem Klick speichere ich den Zeitpunkt der Bestätigung. So kann niemand, der sich mit deiner Adresse registriert, deine Bestellungen sehen.</p>
<p><strong>Anmeldung:</strong> Beim Anmelden erzeugt der Server eine zufällige Sitzungskennung. Sie liegt auf dem Server und in deinem Browser. Beim Abmelden wird sie gelöscht. Sitzungen, die älter als 90 Tage sind, entfernt der Server automatisch.</p>
<p><strong>Passwort vergessen:</strong> Du bekommst einen Link per E-Mail. Er gilt 60 Minuten. Auf dem Server liegt davon nur ein Hash.</p>
<p><strong>Konto löschen:</strong> Schreib mir eine E-Mail, dann lösche ich dein Konto. Bestellungen, die ich aus rechtlichen Gründen aufbewahren muss, bleiben bis zum Ende der Frist gespeichert.</p>
<p>Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.</p>`),

    section('email', 'E-Mails', `
<p>Ich schicke dir E-Mails, die zu deiner Bestellung oder deinem Konto gehören: die Bestellbestätigung mit Rechnung, Nachrichten zum Stand deiner Bestellung (zum Beispiel bezahlt, im Druck, versendet), Nachrichten zu Reklamationen, die Willkommensmail bei der Registrierung und den Link bei „Passwort vergessen“. Werbung oder Newsletter verschicke ich nicht. Bei jeder Bestellung und jedem Widerruf bekomme ich selbst eine Benachrichtigung.</p>
<p>Die Mails gehen über den Postausgangsserver (SMTP) meines E-Mail-Anbieters. Er verarbeitet sie in meinem Auftrag (Art. 28 DSGVO). Das Logo in den Mails lädt dein Mailprogramm von meinem Server; ich werte das nicht aus. Zählpixel oder Link-Tracking gibt es nicht.</p>
<p><strong>Versandprotokoll:</strong> Für jede Mail speichert der Server Empfänger, Betreff, Art, Zeitpunkt und Zustellstatus – für die letzten 500 Mails. Den Inhalt behält er nur, bis die Mail zugestellt ist, damit er sie bei einer Störung erneut senden kann.</p>
<p><strong>Wenn du mir schreibst:</strong> Ich verarbeite deine E-Mail-Adresse und den Inhalt, um dir zu antworten. Ich lösche solche E-Mails, wenn die Sache erledigt ist und keine Aufbewahrungspflicht besteht. Geht es um eine Bestellung, bewahre ich sie als Geschäftsbrief sechs Jahre auf.</p>
<p>Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO; für das Versandprotokoll Art. 6 Abs. 1 lit. f DSGVO. Mein berechtigtes Interesse ist, Zustellprobleme zu erkennen und nachweisen zu können, dass eine Mail verschickt wurde.</p>`),

    section('widerrufsfunktion', 'Widerrufsfunktion', `
<p>Wenn du über „Vertrag widerrufen“ einen Widerruf absendest, speichere ich Name, E-Mail-Adresse, Bestellnummer (falls angegeben), deine Nachricht, Datum und Uhrzeit des Eingangs und eine Referenznummer. Passt die Angabe zu einer Bestellung, vermerke ich den Widerruf dort. Du bekommst eine Eingangsbestätigung per E-Mail, und ich bekomme eine Benachrichtigung. Die Funktion kannst du ohne Anmeldung nutzen.</p>
<p>Rechtsgrundlage: Art. 6 Abs. 1 lit. c DSGVO, weil ich gesetzlich verpflichtet bin, den Widerruf online zu ermöglichen und den Eingang zu bestätigen, und Art. 6 Abs. 1 lit. b DSGVO für die Abwicklung.</p>
<p>Speicherdauer: drei Jahre ab dem Ende des Jahres, in dem der Widerruf eingegangen ist. Gehört er zu einer Bestellung, bewahre ich ihn so lange auf wie die Bestellung.</p>`),

    section('speicherdauer', 'Wie lange ich Daten speichere', `
<p>Ich speichere Daten nur so lange, wie ich sie für den jeweiligen Zweck brauche oder gesetzlich aufbewahren muss. Danach lösche ich sie.</p>
<dl class="facts">
<dt>Bestellungen und Rechnungen</dt><dd>Acht Jahre (Buchungsbelege, § 147 AO), gerechnet ab dem Ende des Kalenderjahres. Druckdateien lösche ich, wenn ich sie für Nachdrucke oder Reklamationen nicht mehr brauche, spätestens mit der Bestellung.</dd>
<dt>E-Mails zu Bestellungen</dt><dd>Sechs Jahre (Geschäftsbriefe, § 147 AO), gerechnet ab dem Ende des Kalenderjahres.</dd>
<dt>Kundenkonto</dt><dd>Bis du es löschen lässt.</dd>
<dt>Anmelde-Sitzungen</dt><dd>Bis zum Abmelden, höchstens 90 Tage.</dd>
<dt>Design-Codes und Vorschaubilder</dt><dd>Dauerhaft, damit Codes funktionieren. Auf Wunsch lösche ich einen Code, wenn er zu keiner Bestellung gehört.</dd>
<dt>Design-Listen</dt><dd>Bis du die Liste löschst.</dd>
<dt>Widerrufe</dt><dd>Drei Jahre ab dem Ende des Eingangsjahres, bei einer Bestellung so lange wie diese.</dd>
<dt>Versandprotokoll der E-Mails</dt><dd>Die letzten 500 Einträge; den Inhalt einer Mail nur bis zur Zustellung.</dd>
<dt>Zugriffsprotokolle und Betriebsmeldungen</dt><dd>Höchstens 14 Tage.</dd>
<dt>Missbrauchszähler</dt><dd>Nur kurz im Arbeitsspeicher, nicht dauerhaft.</dd>
</dl>`),

    section('empfaenger', 'Wer Daten bekommt', `
<p>Deine Daten bekommen nur die Stellen, die ich oben nenne: ${esc(c.hosterName)} (Hosting), mein E-Mail-Anbieter (Versand der Mails)${pp ? ', PayPal (Zahlung)' : ''}, das Versandunternehmen (Zustellung) und meine Bank (Zahlungseingang). Soweit gesetzlich nötig, gebe ich Daten an Steuerberatung und Finanzbehörden weiter. Ich verkaufe keine Daten und gebe sie nicht für Werbung weiter.</p>
<p>Ich selbst übermittle keine Daten in Länder außerhalb der EU oder des Europäischen Wirtschaftsraums.${pp ? ' PayPal kann Daten in eigener Verantwortung auch außerhalb der EU verarbeiten (siehe „Zahlung“).' : ''}</p>`),

    section('rechte', 'Deine Rechte', `
<p>Du hast das Recht auf</p>
<ul>
<li>Auskunft über deine Daten (Art. 15 DSGVO),</li>
<li>Berichtigung falscher Daten (Art. 16 DSGVO),</li>
<li>Löschung (Art. 17 DSGVO),</li>
<li>Einschränkung der Verarbeitung (Art. 18 DSGVO),</li>
<li>Datenübertragbarkeit (Art. 20 DSGVO) und</li>
<li>Widerspruch (Art. 21 DSGVO).</li>
</ul>
<p>Schreib mir dafür einfach eine E-Mail an ${mailLink(c)}.</p>
<div class="box box-strong"><h3>Widerspruchsrecht</h3>
<p>Verarbeite ich Daten auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse), kannst du aus Gründen, die sich aus deiner besonderen Situation ergeben, jederzeit widersprechen. Ich verarbeite die Daten dann nicht mehr, es sei denn, ich kann zwingende schutzwürdige Gründe nachweisen, die deine Interessen überwiegen, oder die Verarbeitung dient der Geltendmachung, Ausübung oder Verteidigung von Rechtsansprüchen.</p></div>
<p><strong>Beschwerde:</strong> Du kannst dich bei einer Datenschutz-Aufsichtsbehörde beschweren (Art. 77 DSGVO), insbesondere in dem Land, in dem du wohnst oder arbeitest oder in dem der mutmaßliche Verstoß stattfand. Für mich zuständig ist die Datenschutz-Aufsichtsbehörde des Bundeslandes, in dem ich meinen Sitz habe.</p>`),

    section('entscheidungen', 'Keine automatisierten Entscheidungen', `
<p>Ich treffe keine automatisierten Entscheidungen im Sinne von Art. 22 DSGVO und erstelle keine Profile.</p>`),

    section('aenderungen', 'Änderungen', `
<p>Ich passe diese Datenschutzerklärung an, wenn sich der Shop oder die Rechtslage ändert. Es gilt die Fassung, die hier veröffentlicht ist.</p>`),
  ];
}

// ---------------------------------------------------------------------------
// AGB — Vertragsschluss nach dem tatsächlichen Ablauf (Kasse → /api/checkout → /complete: Rechnung + Bestellbestätigung)
// ---------------------------------------------------------------------------
function agbSections(c) {
  const pp = c.paypal;
  const v = versandText(c);
  return [
    section('geltung', '§ 1 Geltungsbereich', absaetze([
      `Diese Allgemeinen Geschäftsbedingungen gelten für alle Bestellungen im Online-Shop ${esc(c.brand)}${c.publicBase ? ` unter ${esc(c.publicBase.replace(/^https?:\/\//i, ''))}` : ''}.`,
      'Verbraucher ist jede natürliche Person, die ein Rechtsgeschäft zu Zwecken abschließt, die überwiegend weder ihrer gewerblichen noch ihrer selbständigen beruflichen Tätigkeit zugerechnet werden können (§ 13 BGB). Regeln, die nur für Verbraucher gelten, sind unten gekennzeichnet.',
      'Abweichende Bedingungen gelten nur, wenn ich ihnen ausdrücklich zustimme.',
    ])),

    section('vertragspartner', '§ 2 Vertragspartner und Kontakt', `
<p>Dein Vertragspartner ist ${wer(c)}${c.owner ? `, handelnd unter „${esc(c.brand)}“` : ''}, ${esc([c.street, [c.zip, c.city].filter(Boolean).join(' '), c.country].filter(Boolean).join(', '))}.</p>
<p>Fragen, Reklamationen und Beschwerden erreichen mich per E-Mail an ${mailLink(c)}${c.phone ? ` oder telefonisch unter ${telLink(c)}` : ''}.</p>`),

    section('vertragsschluss', '§ 3 Vertragsschluss', absaetze([
      'Die Darstellung der Vasen im Shop und im Konfigurator ist kein bindendes Angebot, sondern eine Einladung, eine Vase nach deinen Vorgaben zu bestellen.',
      'So bestellst du: Du gestaltest deine Vase im Konfigurator (Form, Größe, Oberfläche, Farbe, auf Wunsch eine Gravur) und legst sie in den Warenkorb. Dort kannst du Mengen ändern und Positionen entfernen. Über „Zur Kasse“ gibst du Name, E-Mail-Adresse und Lieferadresse ein, kannst einen Gutscheincode einlösen, wählst die Zahlungsart und stimmst der gesonderten Vereinbarung zu Wasser und Standfestigkeit zu (§ 13). Vor dem Absenden siehst du alle Positionen mit Preisen, die Versandkosten und den Gesamtbetrag.',
      'Bis zum Absenden kannst du alle Angaben in den Feldern der Kasse korrigieren, über „Warenkorb“ zurückgehen und dort Änderungen vornehmen oder die Kasse schließen. Dann wird nichts bestellt.',
      `Mit einem Klick auf „Zahlungspflichtig bestellen“ gibst du ein verbindliches Angebot zum Kauf der Vasen in deinem Warenkorb ab.${pp ? ' Wählst du PayPal, erscheint statt dieses Knopfes der Knopf von PayPal. Du meldest dich dann bei PayPal an und bestätigst dort die Zahlung. Damit gibst du dein verbindliches Angebot ab, und PayPal belastet den Betrag.' : ''}`,
      'Direkt danach legt der Shop deine Bestellung an, zeigt dir Bestellnummer und Rechnung und schickt dir eine Bestellbestätigung per E-Mail mit allen Angaben und dem Link zur Rechnung. Mit dieser Bestätigung nehme ich dein Angebot an. Damit ist der Vertrag geschlossen.',
      'Die Vertragssprache ist Deutsch.',
    ])),

    section('vertragstext', '§ 4 Vertragstext', `
<p>Ich speichere den Vertragstext, also deine Bestelldaten, und schicke ihn dir mit der Bestellbestätigung per E-Mail. Die Rechnung kannst du über den Link darin abrufen und speichern. Mit Kundenkonto siehst du deine Bestellungen auch unter „Mein Konto“. Diese AGB kannst du hier jederzeit aufrufen, speichern und drucken.</p>`),

    section('design', '§ 5 Dein Design', absaetze([
      'Ich drucke deine Vase nach dem Design, das du im Konfigurator festgelegt hast. Maßgeblich ist die Live-Vorschau im Konfigurator. Die Raum- und Produktbilder im Shop sind KI-Inszenierungen und zeigen Beispiele.',
      'Die Druck-Ampel im Konfigurator zeigt dir, ob sich eine Form gut drucken lässt. Stellt sich ein Design trotzdem als technisch nicht druckbar heraus, melde ich mich vor dem Druck bei dir. Du kannst es dann anpassen. Findet sich keine passende Änderung, können wir beide vom Vertrag zurücktreten. Was du schon bezahlt hast, erstatte ich dir dann unverzüglich und vollständig.',
      'Für den Text deiner Gravur bist du verantwortlich. Er darf keine Rechte anderer verletzen, etwa Marken- oder Namensrechte, und nicht gegen Gesetze verstoßen. Gravuren mit rechtswidrigem, beleidigendem oder diskriminierendem Inhalt drucke ich nicht. In diesem Fall melde ich mich bei dir und kann vom Vertrag zurücktreten. Was du schon bezahlt hast, erstatte ich dir unverzüglich und vollständig.',
      'Im Konfigurator kannst du dein Design kostenlos als STL- bzw. 3MF-Datei herunterladen. Die Datei ist für deinen privaten, nicht gewerblichen Gebrauch gedacht. Ob sie sich auf deinem Drucker gut drucken lässt, hängt von Drucker, Material und Einstellungen ab. Dafür kann ich keine Zusage geben.',
    ])),

    section('preise', '§ 6 Preise und Versandkosten', absaetze([
      `Es gelten die Preise, die du beim Absenden der Bestellung in der Kasse siehst. Alle Preise sind Endpreise in Euro. ${ustSatz(c)}`,
      'Der Preis einer Vase setzt sich aus dem Grundpreis und den Aufpreisen für die gewählten Optionen zusammen, zum Beispiel für Größe, Oberfläche, Farbe oder Gravur. Der Konfigurator zeigt dir den Preis laufend an. Mengenrabatte und laufende Aktionen rechnet der Shop automatisch ein.',
      `${v.satz} Die Versandkosten siehst du im Warenkorb und in der Kasse, bevor du bestellst.`,
    ])),

    section('lieferung', '§ 7 Lieferung', absaetze([
      `Ich liefere an Adressen in ${esc(c.liefergebiet)}.`,
      `Gedruckt wird erst, wenn du bestellst. Die Lieferzeit beträgt ${esc(c.lieferzeit)}. ${fristBeginn(c)}`,
      'Bist du Verbraucher, trage ich das Risiko, dass die Ware auf dem Versandweg verloren geht oder beschädigt wird, bis sie dir übergeben ist.',
    ])),

    section('zahlung', '§ 8 Zahlung', absaetze([
      `Du kannst per Vorkasse (Überweisung)${pp ? ' oder mit PayPal' : ''} bezahlen.`,
      'Vorkasse: Die Bankverbindung steht in der Bestellbestätigung und auf der Rechnung. Bitte überweise den Gesamtbetrag innerhalb von 14 Tagen nach Vertragsschluss und gib als Verwendungszweck deine Bestellnummer an. Der Druck startet, sobald das Geld bei mir eingegangen ist. Geht die Zahlung auch nach einer Erinnerung mit Nachfrist nicht ein, kann ich vom Vertrag zurücktreten.',
      pp ? `PayPal: Die Zahlung wickelt ${esc(PAYPAL_FIRMA)} ab; dafür gelten die Nutzungsbedingungen von PayPal. Der Betrag wird sofort belastet, und der Druck kann direkt starten.` : '',
    ])),

    section('eigentum', '§ 9 Eigentumsvorbehalt', `
<p>Die Ware bleibt bis zur vollständigen Bezahlung mein Eigentum.</p>`),

    section('widerrufsrecht', '§ 10 Widerrufsrecht', absaetze([
      'Verbrauchern steht grundsätzlich ein gesetzliches Widerrufsrecht zu. Die Einzelheiten stehen in der <a href="/widerruf">Widerrufsbelehrung</a>.',
      'Das Widerrufsrecht besteht nicht bei Verträgen zur Lieferung von Waren, die nicht vorgefertigt sind und für deren Herstellung eine individuelle Auswahl oder Bestimmung durch den Verbraucher maßgeblich ist oder die eindeutig auf die persönlichen Bedürfnisse des Verbrauchers zugeschnitten sind (§ 312g Abs. 2 Nr. 1 BGB). Das trifft auf Vasen zu, die du im Konfigurator gestaltest und die erst nach deiner Bestellung für dich gedruckt werden.',
      'Einen Widerruf kannst du jederzeit über die Funktion <a href="/widerruf#widerrufen">„Vertrag widerrufen“</a> erklären. Ich prüfe dann, ob ein Widerrufsrecht besteht, und melde mich bei dir.',
    ])),

    section('transport', '§ 11 Transportschäden', `
<p>Kommt deine Vase mit einem sichtbaren Transportschaden an, reklamiere das bitte möglichst beim Zusteller und schick mir ein paar Fotos per E-Mail. Ich kümmere mich dann um Ersatz.</p>
<p>Meldest du den Schaden nicht beim Zusteller, hat das keine Folgen für deine gesetzlichen Rechte. Der Hinweis hilft mir nur, meine eigenen Ansprüche gegenüber dem Versandunternehmen durchzusetzen.</p>`),

    section('maengel', '§ 12 Mängel und Haftung', absaetze([
      'Es gilt das gesetzliche Mängelhaftungsrecht (§§ 434 ff. BGB).',
      'Ich hafte nach den gesetzlichen Vorschriften.',
      'Eine zusätzliche Garantie gebe ich nicht.',
    ])),

    section('beschaffenheit', '§ 13 Material, Eigenschaften und Pflege', `
<p>Die folgenden Angaben beschreiben, wie meine Vasen beschaffen sind und wie du sie am besten behandelst. Deine gesetzlichen Rechte bei Mängeln bleiben davon unberührt.</p>
<ul>
<li><strong>Material:</strong> Die Vasen bestehen aus PLA, einem Kunststoff auf Pflanzenbasis. Sie sind nicht spülmaschinengeeignet und vertragen keine Temperaturen über 50 °C, etwa heißes Wasser, eine Heizung oder ein Auto im Sommer. Sonst können sie sich verformen. Reinige sie am besten mit einem feuchten Tuch oder lauwarmem Wasser.</li>
<li><strong>Wasser:</strong> Die Vasen sind für Trockenblumen gedacht. Ich imprägniere sie; sie halten Wasser deshalb in der Regel. Eine Wasserdichtigkeit sage ich aber nicht zu. Für frische Blumen nimm am besten einen Einsatz aus Glas oder Kunststoff. Offene Muster (Voronoi) haben Durchbrüche und halten kein Wasser.</li>
<li><strong>Standfestigkeit:</strong> Bei frei gestalteten Formen hängt die Standfestigkeit von deinem Design ab, etwa bei einem sehr schmalen Fuß oder einem starken Überhang. Die Druck-Ampel warnt vor kritischen Formen. Für frei gestaltete Formen sage ich keine Standfestigkeit zu.</li>
<li><strong>Druckbild:</strong> Jede Vase entsteht Schicht für Schicht. Feine Schichtlinien und kleine Nahtstellen gehören zum 3D-Druck. Farben können zwischen Bildschirm und Filament und zwischen Filament-Chargen leicht abweichen.</li>
</ul>
<p>Dass die Wasserdichtigkeit nicht zugesagt ist und es bei frei gestalteten Formen keine Zusage zur Standfestigkeit gibt, vereinbarst du mit mir vor der Bestellung in der Kasse ausdrücklich und gesondert (§ 476 Abs. 1 Satz 2 BGB). Ohne diese Zustimmung nimmt die Kasse keine Bestellung an.</p>`),

    section('gutscheine', '§ 14 Gutscheine und Aktionen', absaetze([
      'Gutscheincodes löst du in der Kasse ein. Je Bestellung gilt ein Gutscheincode. Bedingungen wie einen Mindestbestellwert nenne ich dort, wo ich den Gutschein bekannt gebe.',
      'Aktionen sind zeitlich begrenzte Rabatte auf den Stückpreis. Zeitraum und Umfang zeigt der Shop an, ebenso, ob der Mengenrabatt während der Aktion zusätzlich gilt.',
      'Gutscheine lassen sich mit einer laufenden Aktion nur kombinieren, wenn das beim Gutschein so angegeben ist. Sonst zeigt dir die Kasse einen Hinweis.',
      'Rabattgutscheine kann ich nicht bar auszahlen.',
      'Eine Gutschrift als Gutschein-Code (zum Beispiel nach einer Reklamation) ist ein Guthaben: Du kannst sie ohne Mindestbestellwert und auch während einer Aktion einlösen. Ist deine Bestellung kleiner, bleibt der Rest auf dem Code für die nächste Bestellung.',
    ])),

    section('streit', '§ 15 Streitbeilegung', `
<p>Ich bin nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen. Wenn etwas nicht passt, schreib mir. Meistens lässt es sich direkt klären.</p>`),

    section('schluss', '§ 16 Schlussbestimmungen', absaetze([
      'Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts. Bist du Verbraucher, gilt diese Rechtswahl nur, soweit dir dadurch nicht der Schutz zwingender Vorschriften des Staates entzogen wird, in dem du deinen gewöhnlichen Aufenthalt hast.',
      'Ist eine Bestimmung dieser AGB unwirksam, bleibt der Vertrag im Übrigen wirksam (§ 306 BGB).',
    ])),
  ];
}

// ---------------------------------------------------------------------------
// Widerruf — Muster-Widerrufsbelehrung (Anlage 1 zu Art. 246a § 1 Abs. 2 EGBGB, Kaufvertrag über Waren) im gesetzlichen
// Wortlaut, Hinweis auf den Ausschluss (§ 312g Abs. 2 Nr. 1 BGB), Muster-Widerrufsformular (Anlage 2) und #widerrufen
// ---------------------------------------------------------------------------
function widerruf(c, { forMail }) {
  const kontakt = [anschriftZeile(c), c.phone ? `Telefon: ${esc(c.phone)}` : '', c.email ? `E-Mail: ${esc(c.email)}` : ''].filter(Boolean).join(', ');
  const online = c.publicBase ? `${c.publicBase}/widerruf#widerrufen` : '';
  const onlineHtml = online ? `<a class="bare" href="${esc(online)}">${esc(online.replace(/^https?:\/\//i, ''))}</a>` : '(auf dieser Seite unter „Vertrag widerrufen“)';
  const funktion = forMail
    ? `<section id="widerrufen" class="wr" aria-labelledby="wr-h"><h2 id="wr-h">Vertrag widerrufen</h2>
<p>Du kannst deinen Vertrag auch online widerrufen, ohne Anmeldung: ${online ? `<a href="${esc(online)}">${esc(online.replace(/^https?:\/\//i, ''))}</a>` : 'auf der Seite „Widerruf“ im Shop unter „Vertrag widerrufen“'}.</p></section>`
    : `<section id="widerrufen" class="wr" data-mail="${esc(c.email)}" aria-labelledby="wr-h">
<h2 id="wr-h">Vertrag widerrufen</h2>
<p>Hier kannst du deinen Vertrag online widerrufen, ohne Anmeldung. Das geht in zwei Schritten: Tippe auf „Vertrag widerrufen“, trag deine Angaben ein und schick sie mit „Widerruf bestätigen“ ab. Danach bekommst du sofort eine Bestätigung per E-Mail mit Inhalt, Datum und Uhrzeit des Eingangs.</p>
<button type="button" class="btn btn-accent" data-wr-start aria-controls="wr-form" aria-expanded="false">Vertrag widerrufen</button>
<noscript><p class="wr-msg">Für die Widerrufsfunktion braucht dein Browser JavaScript. Du kannst deinen Widerruf auch per E-Mail an ${mailLink(c)} schicken.</p></noscript>
<form id="wr-form" class="wr-form" hidden novalidate>
<p class="wr-step">Deine Angaben</p>
<div class="field"><label for="wr-orderId">Bestellnummer <span class="opt">(falls zur Hand)</span></label>
<input id="wr-orderId" name="orderId" type="text" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="FS-260927-A1B2C3" aria-describedby="wr-orderId-hint wr-orderId-err">
<p class="hint" id="wr-orderId-hint">Steht in deiner Bestellbestätigung. Ohne Nummer geht es auch.</p><p class="err" id="wr-orderId-err" hidden></p></div>
<div class="field"><label for="wr-name">Name</label>
<input id="wr-name" name="name" type="text" maxlength="120" autocomplete="name" required aria-describedby="wr-name-err">
<p class="err" id="wr-name-err" hidden></p></div>
<div class="field"><label for="wr-email">E-Mail-Adresse</label>
<input id="wr-email" name="email" type="email" maxlength="254" autocomplete="email" inputmode="email" required aria-describedby="wr-email-hint wr-email-err">
<p class="hint" id="wr-email-hint">Am besten die Adresse, mit der du bestellt hast. Dorthin geht die Bestätigung.</p><p class="err" id="wr-email-err" hidden></p></div>
<div class="field"><label for="wr-nachricht">Nachricht <span class="opt">(optional)</span></label>
<textarea id="wr-nachricht" name="nachricht" rows="4" maxlength="2000" aria-describedby="wr-nachricht-hint wr-nachricht-err"></textarea>
<p class="hint" id="wr-nachricht-hint">Zum Beispiel, welche Vasen du zurückgeben möchtest.</p><p class="err" id="wr-nachricht-err" hidden></p></div>
<p class="wr-note">Mit „Widerruf bestätigen“ schickst du deinen Widerruf verbindlich ab.</p>
<div class="wr-actions"><button type="submit" class="btn btn-accent" data-wr-send>Widerruf bestätigen</button><button type="button" class="btn btn-ghost" data-wr-cancel>Abbrechen</button></div>
<p class="wr-msg" data-wr-msg role="alert" hidden></p>
</form>
<div class="wr-ok" data-wr-ok role="status" tabindex="-1" hidden></div>
</section>`;

  return `
<p class="lead">Hier findest du die Funktion „Vertrag widerrufen“, die Widerrufsbelehrung und das Muster-Widerrufsformular.</p>
<div class="box"><h2 class="box-h">Kurz gesagt</h2><ul>
<li>Deine Vase entsteht erst nach deiner Bestellung, genau nach deinem Design aus dem Konfigurator. Für solche Waren gibt es nach § 312g Abs. 2 Nr. 1 BGB kein Widerrufsrecht. Eine Vase mit deiner Form, deiner Farbe und deiner Gravur kann ich nicht an jemand anderen verkaufen.</li>
<li>Möchtest du trotzdem widerrufen oder bist du unsicher, ob das für deine Bestellung gilt? Nutze die Funktion „Vertrag widerrufen“. Ich prüfe jeden Widerruf und melde mich bei dir.</li>
<li>Kommt deine Vase beschädigt oder mit einem Mangel an, hast du ganz unabhängig davon deine gesetzlichen Rechte. Schreib mir einfach an ${mailLink(c)}.</li>
</ul></div>
${funktion}
<section id="belehrung" aria-labelledby="belehrung-h">
<h2 id="belehrung-h">Widerrufsbelehrung</h2>
<p class="note">Die Belehrung steht hier im gesetzlichen Wortlaut, deshalb ausnahmsweise per Sie. „Wir“ bin in diesem Fall ich.</p>
<div class="muster">
<h3>Widerrufsrecht</h3>
<p>Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen.</p>
<p>Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag, an dem Sie oder ein von Ihnen benannter Dritter, der nicht der Beförderer ist, die Waren in Besitz genommen haben bzw. hat.</p>
<p>Um Ihr Widerrufsrecht auszuüben, müssen Sie uns (${kontakt}) mittels einer eindeutigen Erklärung (z. B. ein mit der Post versandter Brief oder E-Mail) über Ihren Entschluss, diesen Vertrag zu widerrufen, informieren. Sie können dafür das beigefügte Muster-Widerrufsformular verwenden, das jedoch nicht vorgeschrieben ist.</p>
<p>Sie können das Muster-Widerrufsformular oder eine andere eindeutige Erklärung auch auf unserer Webseite ${onlineHtml} elektronisch ausfüllen und übermitteln. Machen Sie von dieser Möglichkeit Gebrauch, so werden wir Ihnen unverzüglich (z. B. per E-Mail) eine Bestätigung über den Eingang eines solchen Widerrufs übermitteln.</p>
<p>Zur Wahrung der Widerrufsfrist reicht es aus, dass Sie die Mitteilung über die Ausübung des Widerrufsrechts vor Ablauf der Widerrufsfrist absenden.</p>
<h3>Folgen des Widerrufs</h3>
<p>Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die wir von Ihnen erhalten haben, einschließlich der Lieferkosten (mit Ausnahme der zusätzlichen Kosten, die sich daraus ergeben, dass Sie eine andere Art der Lieferung als die von uns angebotene, günstigste Standardlieferung gewählt haben), unverzüglich und spätestens binnen vierzehn Tagen ab dem Tag zurückzuzahlen, an dem die Mitteilung über Ihren Widerruf dieses Vertrags bei uns eingegangen ist. Für diese Rückzahlung verwenden wir dasselbe Zahlungsmittel, das Sie bei der ursprünglichen Transaktion eingesetzt haben, es sei denn, mit Ihnen wurde ausdrücklich etwas anderes vereinbart; in keinem Fall werden Ihnen wegen dieser Rückzahlung Entgelte berechnet.</p>
<p>Wir können die Rückzahlung verweigern, bis wir die Waren wieder zurückerhalten haben oder bis Sie den Nachweis erbracht haben, dass Sie die Waren zurückgesandt haben, je nachdem, welches der frühere Zeitpunkt ist.</p>
<p>Sie haben die Waren unverzüglich und in jedem Fall spätestens binnen vierzehn Tagen ab dem Tag, an dem Sie uns über den Widerruf dieses Vertrags unterrichten, an uns zurückzusenden oder zu übergeben. Die Frist ist gewahrt, wenn Sie die Waren vor Ablauf der Frist von vierzehn Tagen absenden.</p>
<p>Sie tragen die unmittelbaren Kosten der Rücksendung der Waren.</p>
<p>Sie müssen für einen etwaigen Wertverlust der Waren nur aufkommen, wenn dieser Wertverlust auf einen zur Prüfung der Beschaffenheit, Eigenschaften und Funktionsweise der Waren nicht notwendigen Umgang mit ihnen zurückzuführen ist.</p>
<h3>Ausschluss des Widerrufsrechts</h3>
<p>Das Widerrufsrecht besteht nicht bei Verträgen zur Lieferung von Waren, die nicht vorgefertigt sind und für deren Herstellung eine individuelle Auswahl oder Bestimmung durch den Verbraucher maßgeblich ist oder die eindeutig auf die persönlichen Bedürfnisse des Verbrauchers zugeschnitten sind (§ 312g Abs. 2 Nr. 1 BGB).</p>
<p class="end">Ende der Widerrufsbelehrung</p>
</div>
<p>Was das für dich heißt: Der Ausschluss betrifft Vasen, die du im Konfigurator gestaltest – mit Form, Größe, Oberfläche, Farbe und auf Wunsch einer Gravur – und die ich erst nach deiner Bestellung für dich drucke.</p>
</section>
<section id="formular" aria-labelledby="formular-h">
<h2 id="formular-h">Muster-Widerrufsformular</h2>
<div class="muster">
<p>(Wenn Sie den Vertrag widerrufen wollen, dann füllen Sie bitte dieses Formular aus und senden Sie es zurück.)</p>
<ul class="dash">
<li>An ${esc([c.brand, c.owner, c.street, [c.zip, c.city].filter(Boolean).join(' '), c.country].filter(Boolean).join(', '))}${c.email ? `, E-Mail: ${esc(c.email)}` : ''}:</li>
<li>Hiermit widerrufe(n) ich/wir (*) den von mir/uns (*) abgeschlossenen Vertrag über den Kauf der folgenden Waren (*)/die Erbringung der folgenden Dienstleistung (*)</li>
<li>Bestellt am (*)/erhalten am (*)</li>
<li>Name des/der Verbraucher(s)</li>
<li>Anschrift des/der Verbraucher(s)</li>
<li>Unterschrift des/der Verbraucher(s) (nur bei Mitteilung auf Papier)</li>
<li>Datum</li>
</ul>
<p>(*) Unzutreffendes streichen.</p>
</div>
</section>`;
}

// ---------------------------------------------------------------------------
// Versand & Zahlung
// ---------------------------------------------------------------------------
function versand(c) {
  const v = versandText(c);
  return `
<div class="box"><ul class="plain">
<li><strong>Gedruckt wird erst, wenn du bestellst.</strong></li>
<li>Lieferzeit: ${esc(c.lieferzeit)}</li>
<li>Liefergebiet: ${esc(c.liefergebiet)}</li>
<li>Versand: ${v.kurz}</li>
<li>Bezahlen: Vorkasse${c.paypal ? ' oder PayPal' : ''}</li>
</ul></div>
<section id="gebiet" aria-labelledby="gebiet-h"><h2 id="gebiet-h">Liefergebiet</h2>
<p>Ich verschicke an Adressen in ${esc(c.liefergebiet)}. An andere Adressen kann ich derzeit nicht liefern.</p></section>
<section id="lieferzeit" aria-labelledby="lieferzeit-h"><h2 id="lieferzeit-h">Lieferzeit</h2>
<p>Gedruckt wird erst, wenn du bestellst: einzeln, Schicht für Schicht. Bis deine Vase bei dir ist, dauert es ${esc(c.lieferzeit)}.</p>
<p>${fristBeginn(c)}</p>
<p>Ich verschicke gut gepolstert als Paket. Sobald es unterwegs ist, sage ich dir Bescheid.</p></section>
<section id="versandkosten" aria-labelledby="versandkosten-h"><h2 id="versandkosten-h">Versandkosten</h2>
<p>${v.satz}</p>
<p>Die Versandkosten siehst du im Warenkorb und in der Kasse, bevor du bestellst.</p></section>
<section id="zahlungsarten" aria-labelledby="zahlungsarten-h"><h2 id="zahlungsarten-h">Zahlungsarten</h2>
<h3>Vorkasse (Überweisung)</h3>
<p>Die Bankverbindung steht in der Bestellbestätigung und auf der Rechnung. Bitte überweise den Gesamtbetrag innerhalb von 14 Tagen und gib als Verwendungszweck deine Bestellnummer an. Der Druck startet, sobald das Geld bei mir eingegangen ist.</p>
${c.paypal ? `<h3>PayPal</h3>
<p>Du bezahlst direkt in der Kasse über PayPal. Die Zahlung ist sofort bestätigt, und der Druck kann direkt starten. Was dabei mit deinen Daten passiert, steht in der <a href="/datenschutz#zahlung">Datenschutzerklärung</a>.</p>` : ''}
<p>Andere Zahlungsarten wie Kauf auf Rechnung, Lastschrift oder Nachnahme biete ich derzeit nicht an.</p></section>
<section id="preise" aria-labelledby="preise-h"><h2 id="preise-h">Preise</h2>
<p>Alle Preise sind Endpreise in Euro. ${ustSatz(c)}</p></section>
<section id="transportschaden" aria-labelledby="transportschaden-h"><h2 id="transportschaden-h">Wenn beim Versand etwas kaputtgeht</h2>
<p>Kommt deine Vase mit einem sichtbaren Transportschaden an, reklamiere das bitte möglichst beim Zusteller und schick mir ein paar Fotos an ${mailLink(c)}. Ich kümmere mich dann um Ersatz.</p>
<p>Meldest du den Schaden nicht beim Zusteller, hat das keine Folgen für deine gesetzlichen Rechte. Der Hinweis hilft mir nur gegenüber dem Versandunternehmen.</p></section>
<section id="fragen" aria-labelledby="fragen-h"><h2 id="fragen-h">Fragen</h2>
<p>Schreib mir an ${mailLink(c)}${c.phone ? ` oder ruf an: ${telLink(c)}` : ''}. Alles Weitere steht in den <a href="/agb">AGB</a>.</p></section>`;
}

// ---------------------------------------------------------------------------
// Seitenhülle (formsam-Look): Kopf mit Wort-Bild-Marke, Navigation zwischen den fünf Seiten, Fußzeile
// ---------------------------------------------------------------------------
/** Darkmode früh setzen (wie die Startseite): Klasse 'dark' auf <html> bei 'ovju-theme' = dark oder Systemeinstellung */
function themeInit() {
  try {
    var t = localStorage.getItem('ovju-theme');
    if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
  } catch (e) { /* Speicher gesperrt → hell */ }
}
/** Inhaltsverzeichnis am Desktop aufgeklappt, am Handy zu */
function tocInit() {
  if (matchMedia('(min-width: 701px)').matches) document.querySelectorAll('details.toc').forEach(function (d) { d.open = true; });
}

/**
 * Elektronische Widerrufsfunktion (#widerrufen): „Vertrag widerrufen“ → Formular → „Widerruf bestätigen“ → POST /api/widerruf.
 * Erfolg: Referenz + Eingangszeitpunkt + Hinweis auf die Bestätigungsmail. Läuft ohne Anmeldung, ohne externe Ressourcen.
 * Wird per toString() in die Seite geschrieben — darf nichts aus dem Modul verwenden.
 */
function widerrufClient() {
  var sec = document.getElementById('widerrufen');
  var form = document.getElementById('wr-form');
  if (!sec || !form) return;
  var start = sec.querySelector('[data-wr-start]');
  var okBox = sec.querySelector('[data-wr-ok]');
  var msg = form.querySelector('[data-wr-msg]');
  var sendBtn = form.querySelector('[data-wr-send]');
  var cancelBtn = form.querySelector('[data-wr-cancel]');
  var mail = sec.getAttribute('data-mail') || '';
  var ORDER_RE = /^(OV|FS)-\d{6}-[A-F0-9]{4,6}$/i;
  var EMAIL_RE = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;
  var el = function (n) { return form.elements.namedItem(n); };

  function oeffnen() {
    start.hidden = true; start.setAttribute('aria-expanded', 'true');
    okBox.hidden = true; form.hidden = false;
    (el('orderId').value ? el('name') : el('orderId')).focus();
  }
  function schliessen() {
    form.hidden = true; msg.hidden = true;
    start.hidden = false; start.setAttribute('aria-expanded', 'false'); start.focus();
  }
  function feldFehler(name, text) {
    var input = el(name), err = document.getElementById('wr-' + name + '-err');
    if (!input || !err) return !text;
    err.textContent = text || ''; err.hidden = !text;
    if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    return !text;
  }
  function meldung(text, mitMail) {
    msg.textContent = text;
    if (mitMail && mail) {
      msg.appendChild(document.createTextNode(' Du kannst deinen Widerruf auch per E-Mail an '));
      var a = document.createElement('a'); a.href = 'mailto:' + mail; a.textContent = mail; msg.appendChild(a);
      msg.appendChild(document.createTextNode(' schicken.'));
    }
    msg.hidden = false;
  }
  function zeitpunkt(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) d = new Date();
    try { return d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' Uhr'; }
    catch (e) { return d.toLocaleString('de-DE') + ' Uhr'; }
  }
  function zeile(parent, tag, text) { var n = document.createElement(tag); n.textContent = text; parent.appendChild(n); return n; }
  function erfolg(j, email) {
    form.hidden = true;
    okBox.textContent = '';
    zeile(okBox, 'h3', 'Dein Widerruf ist eingegangen.');
    var dl = document.createElement('dl');
    zeile(dl, 'dt', 'Referenz'); zeile(dl, 'dd', String(j.ref));
    zeile(dl, 'dt', 'Eingegangen am'); zeile(dl, 'dd', zeitpunkt(j.at));
    okBox.appendChild(dl);
    zeile(okBox, 'p', 'Eine Bestätigung mit Inhalt, Datum und Uhrzeit des Eingangs geht an ' + email + '. Kommt keine E-Mail an, schau bitte im Spam-Ordner nach oder schreib mir.');
    zeile(okBox, 'p', 'Ich prüfe deinen Widerruf und melde mich bei dir.');
    okBox.hidden = false;
    okBox.focus();
  }

  start.addEventListener('click', oeffnen);
  cancelBtn.addEventListener('click', schliessen);
  // Bestellnummer aus dem Link übernehmen (…/widerruf?bestellung=FS-…#widerrufen bzw. ?order=FS-… aus dem Kundenkonto)
  try {
    var sp = new URLSearchParams(location.search);
    var q = sp.get('bestellung') || sp.get('order');
    if (q && ORDER_RE.test(q.trim())) el('orderId').value = q.trim().toUpperCase();
  } catch (e) { /* ohne Vorbelegung */ }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (sendBtn.disabled) return;
    msg.hidden = true;
    var d = {
      orderId: el('orderId').value.trim().toUpperCase(),
      name: el('name').value.trim(),
      email: el('email').value.trim(),
      nachricht: el('nachricht').value.trim(),
    };
    var ok = [
      feldFehler('orderId', d.orderId && !ORDER_RE.test(d.orderId) ? 'Die Bestellnummer sieht so aus: FS-260927-A1B2C3. Ohne Nummer geht es auch – lass das Feld dann leer.' : ''),
      feldFehler('name', d.name.length < 2 ? 'Bitte gib deinen Namen an.' : d.name.length > 120 ? 'Der Name ist zu lang (höchstens 120 Zeichen).' : ''),
      feldFehler('email', !EMAIL_RE.test(d.email) ? 'Bitte gib eine gültige E-Mail-Adresse an – dorthin geht die Bestätigung.' : ''),
      feldFehler('nachricht', d.nachricht.length > 2000 ? 'Die Nachricht ist zu lang (höchstens 2000 Zeichen).' : ''),
    ];
    var erstes = ['orderId', 'name', 'email', 'nachricht'].filter(function (n, i) { return !ok[i]; })[0];
    if (erstes) { el(erstes).focus(); return; }
    var body = { name: d.name, email: d.email };
    if (d.orderId) body.orderId = d.orderId;
    if (d.nachricht) body.nachricht = d.nachricht;
    sendBtn.disabled = true; sendBtn.textContent = 'Wird gesendet …'; form.setAttribute('aria-busy', 'true');
    fetch('/api/widerruf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j || {} }; }); })
      .then(function (res) {
        if (res.j.ok && res.j.ref) return erfolg(res.j, d.email);
        if (res.status === 429) return meldung('Gerade kamen zu viele Anfragen. Bitte warte ein paar Minuten und versuch es dann noch einmal.', true);
        if (res.status === 400 && res.j.error) return meldung(String(res.j.error), false);
        meldung('Das hat leider nicht geklappt – dein Widerruf ist noch nicht bei mir angekommen. Bitte versuch es gleich noch einmal.', true);
      })
      .catch(function () {
        meldung('Keine Verbindung zum Server – dein Widerruf ist noch nicht bei mir angekommen. Bitte prüf deine Internetverbindung und versuch es noch einmal.', true);
      })
      .then(function () { sendBtn.disabled = false; sendBtn.textContent = 'Widerruf bestätigen'; form.removeAttribute('aria-busy'); });
  });
}

/**
 * Wort-Bild-Marke als Inline-SVG: Zeichen + Grundlinie in Terrakotta, Schrift in currentColor (hell/dunkel).
 * Die Pfaddaten (~13 KB) stehen nur einmal auf der Seite: logoSvg({ def: true }) im Kopf definiert sie als <symbol id="fs-logo">,
 * jede weitere Stelle (Fußzeile) verweist per <use> darauf — currentColor gilt dort mit der Farbe der jeweiligen Stelle.
 */
function logoSvg({ def = false } = {}) {
  const symbol = def ? `<defs><symbol id="fs-logo" viewBox="0 0 ${LOGO_W} 100"><path fill-rule="evenodd" fill="#c86f4a" d="${LOGO_T}"/><path fill-rule="evenodd" fill="currentColor" d="${LOGO_I}"/></symbol></defs>` : '';
  return `<svg viewBox="0 0 ${LOGO_W} 100" width="${LOGO_W}" height="100" aria-hidden="true" focusable="false">${symbol}<use href="#fs-logo"/></svg>`;
}

const CSS = `
@font-face{font-family:'Fraunces';src:url('/fonts/fraunces-latin.woff2') format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:'Inter';src:url('/fonts/inter-latin.woff2') format('woff2');font-weight:100 900;font-display:swap}
:root{--bg:#f4efe7;--card:#fbf8f2;--ink:#211d18;--soft:#6b6257;--line:#ddd3c3;--terra:#c86f4a;--link:#9e4f2c;--sage:#9caf88;
  --btn:#9e4f2c;--btn-h:#86401f;--btn-ink:#fff;--err:#a3321c;--foot:#211d18;--foot-ink:#f4efe7;--foot-soft:#cfc5b6;color-scheme:light}
html.dark{--bg:#17130f;--card:#1f1a14;--ink:#f0e9dc;--soft:#a89d8c;--line:#3b332a;--terra:#d07650;--link:#e39a73;
  --btn:#c86f4a;--btn-h:#d98560;--btn-ink:#17130f;--err:#f08a6e;--foot:#0e0b08;--foot-ink:#f0e9dc;--foot-soft:#a89d8c;color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;scroll-padding-top:20px}
body{margin:0;background:var(--bg);color:var(--ink);font:400 1rem/1.65 Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:0 20px}
.skip{position:absolute;left:12px;top:-60px;background:var(--ink);color:var(--bg);padding:8px 14px;border-radius:999px;z-index:5;text-decoration:none}
.skip:focus{top:12px}
:focus-visible{outline:3px solid var(--terra);outline-offset:3px;border-radius:6px}
a{color:var(--link);text-decoration-thickness:1px;text-underline-offset:.16em}
a:hover{text-decoration-thickness:2px}
/* Kopf */
.top{border-bottom:1px solid var(--line)}
.top-in{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:max(18px,env(safe-area-inset-top));padding-bottom:14px}
.brand{display:inline-flex;color:var(--ink);line-height:0;border-radius:6px}
.brand svg{height:30px;width:auto}
.shop-link{color:var(--soft);text-decoration:none;font-size:.9rem;font-weight:500;white-space:nowrap}
.shop-link:hover{color:var(--ink)}
.legal-nav .wrap{display:flex;flex-wrap:wrap;gap:8px;padding-bottom:16px}
.legal-nav a{display:inline-block;padding:6px 13px;border:1px solid var(--line);border-radius:999px;color:var(--ink);text-decoration:none;font-size:.88rem;font-weight:500;line-height:1.35}
.legal-nav a:hover{border-color:var(--terra)}
.legal-nav a[aria-current=page]{background:var(--ink);border-color:var(--ink);color:var(--bg)}
/* Inhalt */
.doc{padding-top:38px;padding-bottom:72px}
.eyebrow{margin:0 0 10px;font-size:.74rem;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--link)}
h1,h2,.claim{font-family:Fraunces,Georgia,'Times New Roman',serif}
h1{margin:0 0 10px;font-size:clamp(2rem,6.4vw,2.8rem);font-weight:560;line-height:1.08;letter-spacing:-.01em}
h2{margin:46px 0 12px;font-size:1.45rem;font-weight:560;line-height:1.25}
h3{margin:26px 0 6px;font-size:1.02rem;font-weight:650;line-height:1.35}
p,li,dd{overflow-wrap:break-word;hyphens:auto;-webkit-hyphens:auto;hyphenate-limit-chars:10 4 4}
.nohy,a{hyphens:manual;-webkit-hyphens:manual}
p{margin:0 0 14px}
ul,ol{margin:0 0 14px;padding-left:1.25em}
li{margin:0 0 6px}
.stand{margin:0 0 28px;color:var(--soft);font-size:.92rem}
.lead{font-size:1.08rem}
.note{color:var(--soft);font-size:.94rem}
.addr{line-height:1.6}
.box{margin:26px 0;padding:18px 22px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--sage);border-radius:16px}
.box ul{margin:0}
.box li:last-child,.box p:last-child{margin-bottom:0}
.box .box-h,.box h3{margin:0 0 8px;font-size:1.12rem}
.box-strong{border-left-color:var(--terra)}
ul.plain{list-style:none;padding:0}
ol.abs{list-style:none;padding:0;counter-reset:abs}
ol.abs>li{counter-increment:abs;position:relative;padding-left:2.1em;margin-bottom:12px}
ol.abs>li::before{content:"(" counter(abs) ")";position:absolute;left:0;color:var(--soft);font-variant-numeric:tabular-nums}
dl.facts{display:grid;grid-template-columns:minmax(8rem,13rem) 1fr;gap:12px 20px;margin:18px 0 22px}
dl.facts dt{font-weight:600}
dl.facts dd{margin:0}
.toc{margin:0 0 8px;padding:14px 20px;background:var(--card);border:1px solid var(--line);border-radius:16px}
.toc summary{cursor:pointer;font-weight:600}
.toc ol{margin:12px 0 2px;padding-left:1.4em;columns:2;column-gap:28px}
.toc li{break-inside:avoid;margin-bottom:4px;font-size:.95rem}
.toc ol.plain{list-style:none;padding-left:0}
.toc a{text-decoration:none}
.toc a:hover{text-decoration:underline}
.muster{margin:14px 0 18px;padding:6px 22px 14px;background:var(--card);border:1px solid var(--line);border-radius:16px}
.muster h3{margin-top:18px}
.muster .end{margin-top:18px;color:var(--soft);font-style:normal;font-weight:600}
ul.dash{list-style:none;padding:0}
ul.dash li{position:relative;padding-left:1.1em}
ul.dash li::before{content:"–";position:absolute;left:0;color:var(--soft)}
/* Knöpfe & Widerrufsfunktion */
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 24px;border:1px solid transparent;border-radius:999px;font:600 1rem/1.2 Inter,system-ui,sans-serif;cursor:pointer;text-decoration:none}
.btn-accent{background:var(--btn);color:var(--btn-ink)}
.btn-accent:hover{background:var(--btn-h)}
.btn-accent:disabled{opacity:.65;cursor:progress}
.btn-ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.btn-ghost:hover{border-color:var(--terra)}
.wr{margin:30px 0 8px;padding:22px 24px 24px;background:var(--card);border:1px solid var(--line);border-top:4px solid var(--terra);border-radius:18px}
.wr h2{margin-top:0}
.wr-form{margin-top:6px}
.wr-step{margin:0 0 14px;font-size:.78rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--link)}
.field{margin:0 0 16px}
.field label{display:block;margin:0 0 6px;font-weight:600}
.opt{font-weight:400;color:var(--soft)}
.field input,.field textarea{display:block;width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink);font:400 1rem/1.4 Inter,system-ui,sans-serif}
.field textarea{resize:vertical;min-height:110px}
.field input:focus,.field textarea:focus{border-color:var(--terra);outline:2px solid var(--terra);outline-offset:0}
.field [aria-invalid=true]{border-color:var(--err)}
.hint{margin:6px 0 0;color:var(--soft);font-size:.9rem}
.err{margin:6px 0 0;color:var(--err);font-size:.92rem;font-weight:500}
.wr-note{color:var(--soft);font-size:.92rem}
.wr-actions{display:flex;flex-wrap:wrap;gap:10px}
.wr-msg{margin:16px 0 0;padding:12px 16px;border-radius:12px;border:1px solid var(--err);color:var(--ink)}
.wr-ok{margin-top:6px;padding:16px 20px;border-radius:14px;border:1px solid var(--line);border-left:4px solid var(--sage);background:var(--bg)}
.wr-ok h3{margin:0 0 10px;font-family:Fraunces,Georgia,serif;font-size:1.3rem;font-weight:560}
.wr-ok dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:0 0 12px}
.wr-ok dt{color:var(--soft)}
.wr-ok dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;hyphens:none}
.wr-ok p:last-child{margin-bottom:0}
/* Fußzeile */
.foot{background:var(--foot);color:var(--foot-ink);padding:44px 0 max(44px,calc(24px + env(safe-area-inset-bottom)))}
.foot a{color:var(--foot-ink)}
.foot .brand{color:var(--foot-ink)}
.foot .brand svg{height:28px}
.claim{margin:12px 0 26px;font-size:1.2rem;font-weight:500;line-height:1.3}
.foot-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:22px 32px;font-size:.92rem;color:var(--foot-soft)}
.foot-grid p{margin:0 0 8px}
.foot-links{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.foot-links a{text-decoration:none}
.foot-links a:hover{text-decoration:underline}
.revoke{display:inline-block;margin-top:8px;padding:8px 16px;border:1px solid var(--terra);border-radius:999px;font-weight:600;text-decoration:none!important}
.revoke:hover{background:var(--terra);color:var(--foot)}
@media (min-width:981px){
  body{font-size:1.0625rem}
  .brand svg{height:34px}
  .doc{padding-top:48px}
}
@media (max-width:700px){
  .toc ol{columns:1}
  .foot-grid{grid-template-columns:1fr}
}
@media (max-width:480px){
  .wrap{padding-left:16px;padding-right:16px}
  h2{margin-top:38px;font-size:1.3rem}
  .brand svg{height:27px}
  dl.facts{grid-template-columns:1fr;gap:2px}
  dl.facts dd{margin-bottom:12px}
  .box,.muster{padding-left:16px;padding-right:16px}
  .wr{padding:18px 16px 20px}
  .wr-actions .btn{flex:1 1 100%}
  .wr-ok dl{grid-template-columns:1fr;gap:0}
  .wr-ok dd{margin-bottom:8px}
}
@media print{
  :root,html.dark{--bg:#fff;--card:#fff;--ink:#000;--soft:#444;--line:#bbb;--link:#000;--terra:#c86f4a;--sage:#9caf88;--foot:#fff;--foot-ink:#000;--foot-soft:#333;color-scheme:light}
  @page{margin:16mm 16mm 18mm}
  body{font-size:10.5pt;line-height:1.45}
  .legal-nav,.shop-link,.skip,.toc,.wr,.foot-links,.revoke{display:none!important}
  .doc{padding:14pt 0 0}
  a{text-decoration:none}
  .doc a[href^="http"]:not(.bare)::after{content:" (" attr(href) ")";font-size:.85em}
  h2,h3{break-after:avoid}
  .box,.muster,dl.facts{break-inside:avoid}
  .foot{padding:12pt 0 0;border-top:1px solid #bbb}
}`;

function shell(slug, c, { body, forMail }) {
  const pg = PAGES[slug];
  // Links: im Shop relativ, als Mail-Anhang absolut (sonst zeigen sie ins Leere)
  const href = (p) => (forMail && c.httpBase ? c.httpBase + p : p);
  const navLinks = LEGAL_SLUGS.map((k) => `<a href="${esc(href('/' + k))}"${k === slug ? ' aria-current="page"' : ''}>${esc(PAGES[k].nav)}</a>`).join('');
  const footLinks = LEGAL_SLUGS.map((k) => `<a href="${esc(href('/' + k))}">${esc(PAGES[k].nav)}</a>`).join('');
  const meta = c.publicBase ? `
<link rel="canonical" href="${esc(c.publicBase)}/${slug}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="formsam">
<meta property="og:title" content="${esc(pg.title)} · formsam">
<meta property="og:description" content="${esc(pg.desc)}">
<meta property="og:image" content="${esc(c.publicBase)}/img/brand/og.jpg">` : '';
  const scripts = forMail ? '' : `<script>(${tocInit.toString()})();</script>${slug === 'widerruf' ? `\n<script>(${widerrufClient.toString()})();</script>` : ''}`;
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(pg.title)} · formsam</title>
<meta name="description" content="${esc(pg.desc)}">
<meta name="robots" content="index, follow">${meta}
<meta name="theme-color" content="#f4efe7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#17130f" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${esc(href('/img/brand/favicon.svg'))}" type="image/svg+xml">
<link rel="icon" href="${esc(href('/favicon.ico'))}" sizes="any">
<link rel="apple-touch-icon" href="${esc(href('/img/icons/apple-touch-icon.png'))}">
${forMail ? '' : `<script>(${themeInit.toString()})();</script>\n`}<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#inhalt">Zum Inhalt</a>
<header class="top">
<div class="wrap top-in">
<a class="brand" href="${esc(href('/'))}" aria-label="formsam – zur Startseite">${logoSvg({ def: true })}</a>
<a class="shop-link" href="${esc(href('/'))}">Zum Shop <span aria-hidden="true">→</span></a>
</div>
<nav class="legal-nav" aria-label="Rechtliches"><div class="wrap">${navLinks}</div></nav>
</header>
<main id="inhalt" class="wrap doc">
<p class="eyebrow">Rechtliches</p>
<h1>${esc(pg.h1)}</h1>
<p class="stand">Stand: <time datetime="${LEGAL_STAND}">${STAND_TEXT}</time></p>
${body}
</main>
<footer class="foot">
<div class="wrap">
<a class="brand" href="${esc(href('/'))}" aria-label="formsam – zur Startseite">${logoSvg()}</a>
<p class="claim">Sorgsam geformt. Auf dich zugeschnitten.</p>
<div class="foot-grid">
<div><p>${esc([c.brand, c.owner].filter(Boolean).join(' · '))}<br>${esc([c.street, [c.zip, c.city].filter(Boolean).join(' ')].filter(Boolean).join(' · '))}</p>
${c.email ? `<p><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>` : ''}</div>
<div><nav class="foot-links" aria-label="Rechtliches in der Fußzeile">${footLinks}<a class="revoke" href="${esc(href('/widerruf#widerrufen'))}">Vertrag widerrufen</a></nav></div>
</div>
</div>
</footer>
${scripts}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Öffentliche Funktionen
// ---------------------------------------------------------------------------
/**
 * Komplette HTML-Seite zu einem Slug (LEGAL_SLUGS) oder null.
 * @param {string} slug
 * @param {{ settings?: object, baseUrl?: string, forMail?: boolean }} [opts]
 *   forMail: ohne Skripte/Formular, Links absolut — z. B. als Anhang der Bestellbestätigung (AGB/Widerrufsbelehrung)
 */
export function renderLegalPage(slug, { settings, baseUrl, forMail = false } = {}) {
  const key = String(slug || '').toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!LEGAL_SLUGS.includes(key)) return null;
  const c = context(settings, baseUrl);
  let body;
  switch (key) {
    case 'impressum': body = impressum(c); break;
    case 'datenschutz': { const s = datenschutzSections(c); body = `<p class="lead">Hier steht, welche Daten der Shop verarbeitet, wofür und wie lange – und welche Rechte du hast.</p>${toc(s, { open: forMail })}${renderSections(s)}`; break; }
    case 'agb': { const s = agbSections(c); body = `<p class="lead">Die Regeln für deine Bestellung bei ${esc(c.brand)} – so kurz wie möglich, so genau wie nötig.</p>${toc(s, { open: forMail, nummern: false })}${renderSections(s)}`; break; }
    case 'widerruf': body = widerruf(c, { forMail }); break;
    case 'versand': body = versand(c); break;
    default: return null;
  }
  return shell(key, c, { body: nbsp(body), forMail });
}

/**
 * Hinweise für den Betreiber (z. B. im Admin anzeigen): fehlende oder offensichtlich vorläufige Pflichtangaben.
 * Die Seiten zeigen die Werte trotzdem an — hier steht nur, was noch zu ergänzen ist.
 */
export function legalWarnings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const c = context(s, '');
  const out = [];
  if (/ovju|eierbecher/i.test(String(s.company?.name || ''))) out.push('Firmenname enthält noch die alte Marke – angezeigt wird „formsam“.');
  if (!c.owner) out.push('Inhaber (Vor- und Nachname) fehlt – Pflichtangabe im Impressum (§ 5 DDG).');
  if (!c.street || !c.zip || !c.city) out.push('Anschrift unvollständig – Pflichtangabe im Impressum (§ 5 DDG).');
  else if (PLATZHALTER_RE.test(c.street) || PLATZHALTER_RE.test(c.zip) || PLATZHALTER_RE.test(c.city)) out.push('Anschrift sieht nach Platzhalter aus (Musterstraße / 00000 / Musterstadt).');
  if (!EMAIL_RE.test(c.email)) out.push('E-Mail-Adresse fehlt oder ist ungültig – Pflichtangabe im Impressum.');
  if (!c.phone) out.push('Telefonnummer fehlt – im Fernabsatz Pflichtinformation (Art. 246a § 1 Abs. 1 Nr. 2 EGBGB).');
  if (!s.shop?.lieferzeit) out.push('Lieferzeit fehlt in den Einstellungen – angezeigt wird der Standard (5–8 Werktage).');
  return out;
}


// ---------------------------------------------------------------------------
// Wort-Bild-Marke (Vektor aus den Entwürfen, viewBox-normiert auf Höhe 100) — Quelle: public/img/brand/formsam-logo.svg
//   LOGO_T = Zeichen (Vase aus fünf Druckschichten) + Grundlinie (Terrakotta), LOGO_I = Schriftzug (Tinte / currentColor)
// ---------------------------------------------------------------------------
const LOGO_W = 377.6;
const LOGO_T = 'M18.74 -0.13L65.53 -0.13C65.37 0.07 64.88 0.67 64.56 1.07C64.24 1.47 63.93 1.87 63.63 2.27C63.33 2.67 63.03 3.07 62.74 3.47C62.45 3.87 62.17 4.27 61.9 4.67C61.63 5.07 61.37 5.47 61.12 5.87C60.86 6.27 60.62 6.67 60.39 7.07C60.16 7.47 59.94 7.87 59.73 8.27C59.52 8.67 59.32 9.07 59.13 9.46C58.95 9.86 58.77 10.26 58.61 10.66C58.45 11.06 58.31 11.46 58.17 11.86C58.04 12.26 57.88 12.86 57.82 13.06L26.45 13.06C26.39 12.86 26.23 12.26 26.09 11.86C25.96 11.46 25.81 11.06 25.65 10.66C25.49 10.26 25.32 9.86 25.13 9.46C24.95 9.07 24.75 8.67 24.54 8.27C24.33 7.87 24.11 7.47 23.88 7.07C23.65 6.67 23.4 6.27 23.15 5.87C22.9 5.47 22.64 5.07 22.37 4.67C22.09 4.27 21.81 3.87 21.53 3.47C21.24 3.07 20.94 2.67 20.64 2.27C20.34 1.87 20.02 1.47 19.71 1.07C19.39 0.67 18.9 0.07 18.74 -0.13ZM27.09 16.99L57.18 16.99C57.19 17.19 57.21 17.78 57.24 18.18C57.27 18.57 57.32 18.97 57.37 19.36C57.43 19.76 57.49 20.15 57.57 20.55C57.66 20.94 57.75 21.34 57.86 21.73C57.96 22.13 58.08 22.52 58.22 22.92C58.35 23.31 58.5 23.71 58.67 24.1C58.83 24.5 59.01 24.89 59.21 25.29C59.41 25.68 59.62 26.08 59.85 26.47C60.08 26.87 60.32 27.27 60.58 27.66C60.85 28.06 61.13 28.45 61.42 28.85C61.72 29.24 62.04 29.64 62.37 30.03C62.71 30.43 63.06 30.82 63.43 31.22C63.81 31.61 64.42 32.2 64.61 32.4L19.66 32.4C19.85 32.2 20.46 31.61 20.83 31.22C21.21 30.82 21.56 30.43 21.9 30.03C22.23 29.64 22.55 29.24 22.84 28.85C23.14 28.45 23.42 28.06 23.68 27.66C23.95 27.27 24.19 26.87 24.42 26.47C24.65 26.08 24.86 25.68 25.06 25.29C25.25 24.89 25.43 24.5 25.6 24.1C25.76 23.71 25.91 23.31 26.05 22.92C26.18 22.52 26.3 22.13 26.41 21.73C26.52 21.34 26.61 20.94 26.69 20.55C26.77 20.15 26.84 19.76 26.9 19.36C26.95 18.97 26.99 18.57 27.03 18.18C27.06 17.78 27.08 17.19 27.09 16.99ZM14.85 36.33L69.42 36.33C69.65 36.52 70.39 37.1 70.85 37.48C71.31 37.86 71.75 38.25 72.18 38.63C72.61 39.01 73.02 39.4 73.42 39.78C73.82 40.16 74.2 40.55 74.57 40.93C74.94 41.31 75.29 41.7 75.63 42.08C75.97 42.46 76.3 42.84 76.61 43.23C76.93 43.61 77.23 43.99 77.52 44.38C77.81 44.76 78.09 45.14 78.35 45.53C78.62 45.91 78.87 46.29 79.12 46.68C79.36 47.06 79.6 47.44 79.82 47.83C80.05 48.21 80.26 48.59 80.47 48.98C80.68 49.36 80.87 49.74 81.06 50.12C81.25 50.51 81.44 50.89 81.61 51.27C81.78 51.66 82.03 52.23 82.11 52.42L2.16 52.42C2.24 52.23 2.48 51.66 2.66 51.27C2.83 50.89 3.01 50.51 3.2 50.12C3.39 49.74 3.59 49.36 3.8 48.98C4 48.59 4.22 48.21 4.44 47.83C4.67 47.44 4.9 47.06 5.15 46.68C5.39 46.29 5.65 45.91 5.92 45.53C6.18 45.14 6.46 44.76 6.75 44.38C7.04 43.99 7.34 43.61 7.66 43.23C7.97 42.84 8.3 42.46 8.64 42.08C8.98 41.7 9.33 41.31 9.7 40.93C10.07 40.55 10.45 40.16 10.85 39.78C11.25 39.4 11.66 39.01 12.09 38.63C12.52 38.25 12.96 37.86 13.42 37.48C13.88 37.1 14.61 36.52 14.85 36.33ZM0.96 56.36L83.31 56.36C83.35 56.56 83.48 57.15 83.55 57.55C83.62 57.95 83.69 58.34 83.74 58.74C83.8 59.13 83.84 59.53 83.88 59.93C83.91 60.32 83.94 60.72 83.96 61.12C83.98 61.51 83.99 61.91 83.99 62.3C83.98 62.7 83.97 63.1 83.95 63.49C83.93 63.89 83.9 64.29 83.86 64.68C83.83 65.08 83.78 65.47 83.72 65.87C83.66 66.27 83.59 66.66 83.51 67.06C83.43 67.45 83.34 67.85 83.24 68.25C83.13 68.64 83.02 69.04 82.9 69.44C82.78 69.83 82.65 70.23 82.5 70.62C82.36 71.02 82.21 71.42 82.04 71.81C81.88 72.21 81.7 72.61 81.51 73C81.32 73.4 81.12 73.79 80.91 74.19C80.7 74.59 80.48 74.98 80.25 75.38C80.01 75.77 79.77 76.17 79.51 76.57C79.26 76.96 78.99 77.36 78.71 77.76C78.43 78.15 78.13 78.55 77.83 78.94C77.52 79.34 77.03 79.93 76.88 80.13L7.39 80.13C7.23 79.93 6.74 79.34 6.44 78.94C6.13 78.55 5.84 78.15 5.56 77.76C5.28 77.36 5.01 76.96 4.75 76.57C4.5 76.17 4.25 75.77 4.02 75.38C3.79 74.98 3.56 74.59 3.35 74.19C3.14 73.79 2.94 73.4 2.76 73C2.57 72.61 2.39 72.21 2.23 71.81C2.06 71.42 1.91 71.02 1.76 70.62C1.62 70.23 1.49 69.83 1.37 69.44C1.24 69.04 1.13 68.64 1.03 68.25C0.93 67.85 0.84 67.45 0.76 67.06C0.68 66.66 0.61 66.27 0.55 65.87C0.49 65.47 0.44 65.08 0.4 64.68C0.36 64.29 0.33 63.89 0.31 63.49C0.29 63.1 0.28 62.7 0.28 62.3C0.28 61.91 0.29 61.51 0.31 61.12C0.33 60.72 0.35 60.32 0.39 59.93C0.43 59.53 0.47 59.13 0.53 58.74C0.58 58.34 0.64 57.95 0.72 57.55C0.79 57.15 0.92 56.56 0.96 56.36ZM10.74 84.07L73.52 84.07C73.48 84.14 73.34 84.37 73.25 84.52C73.16 84.67 73.08 84.82 72.99 84.97C72.9 85.12 72.81 85.27 72.72 85.42C72.64 85.57 72.55 85.72 72.46 85.87C72.38 86.02 72.29 86.17 72.21 86.32C72.12 86.48 72.04 86.63 71.96 86.78C71.87 86.93 71.79 87.08 71.71 87.23C71.63 87.38 71.54 87.53 71.46 87.68C71.38 87.83 71.3 87.98 71.22 88.13C71.14 88.28 71.07 88.43 70.99 88.58C70.91 88.73 70.83 88.88 70.75 89.03C70.68 89.18 70.6 89.33 70.52 89.48C70.45 89.64 70.37 89.79 70.3 89.94C70.23 90.09 70.11 90.31 70.08 90.39L377.68 90.39L377.68 99.91L17.98 99.91C17.93 99.76 17.81 99.36 17.7 99.02C17.59 98.68 17.44 98.26 17.31 97.87C17.18 97.49 17.04 97.11 16.9 96.72C16.76 96.34 16.61 95.96 16.46 95.57C16.31 95.19 16.16 94.81 16 94.42C15.84 94.04 15.68 93.65 15.52 93.27C15.35 92.89 15.18 92.5 15.01 92.12C14.83 91.74 14.65 91.35 14.47 90.97C14.29 90.59 14.1 90.2 13.91 89.82C13.72 89.44 13.53 89.05 13.33 88.67C13.13 88.29 12.92 87.9 12.72 87.52C12.51 87.14 12.3 86.75 12.08 86.37C11.87 85.99 11.65 85.6 11.43 85.22C11.2 84.83 10.86 84.26 10.74 84.07Z';
const LOGO_I = 'M110.72 22.28C105.83 23.38 102.36 26.04 100.24 30.31C98.72 33.38 98.21 35.8 98 40.97L97.88 43.93 95.59 43.98C92.77 44.04 92.68 44.11 92.58 46.01C92.48 47.98 92.59 48.06 95.52 48.1L97.88 48.13 97.88 62.01L97.88 75.9 97.44 76.68C96.88 77.67 95.96 78.19 94.37 78.42C92.95 78.62 92.55 78.97 92.55 80.02C92.55 81.48 91.86 81.4 103.69 81.4C115.68 81.4 114.91 81.5 114.91 79.91C114.91 78.71 114.63 78.51 112.72 78.37C110.16 78.18 108.91 77.43 108.41 75.77C108.23 75.19 108.18 72.07 108.18 61.58L108.18 48.13 112.68 48.08C116.97 48.04 117.18 48.02 117.36 47.68C117.54 47.34 117.46 44.51 117.26 44.18C117.2 44.09 115.21 44.02 112.72 44.02C110.29 44.02 108.25 43.96 108.2 43.88C108.15 43.8 108.1 41.15 108.08 37.98C108.04 31.58 108.15 30.56 109.15 28.53C110.6 25.58 113.6 25.6 114.21 28.57C114.74 31.15 115.57 32.42 117.25 33.22C120.6 34.8 124.25 32.55 124.22 28.92C124.19 26.1 121.79 23.61 118.05 22.5C116.5 22.04 112.32 21.91 110.72 22.28M135.01 43.15C126.37 44.36 120.29 50.02 118.28 58.72C117.86 60.54 117.87 65.22 118.3 67.25C119.62 73.49 123.71 78.56 129.23 80.8C133.6 82.58 139.31 82.81 143.59 81.39C152.09 78.56 157.25 70.71 156.77 61.34C156.29 52.15 150.27 45.09 141.5 43.43C139.71 43.09 136.44 42.95 135.01 43.15M166.17 44.14C164.15 44.76 161.48 45.58 160.24 45.96C157.74 46.72 157.75 46.71 157.55 47.44C157.25 48.53 157.72 49.2 159.02 49.53C160.74 49.97 161.43 50.67 161.72 52.27C161.84 52.93 161.89 57.2 161.85 64.58L161.8 75.9 161.4 76.72C160.91 77.71 160.23 78.16 158.85 78.41C158.28 78.52 157.79 78.6 157.77 78.6C157.47 78.6 157.17 79.3 157.17 79.99C157.17 81.49 156.52 81.4 167.24 81.4C178.07 81.4 177.43 81.49 177.43 79.93C177.43 78.78 177.33 78.69 175.69 78.44C173.92 78.17 172.92 77.66 172.47 76.77C171.9 75.68 171.82 57.42 172.37 55.43C173.18 52.46 174.83 50.44 176.21 50.75C176.8 50.88 177.07 51.16 177.73 52.37C179.15 54.94 181.61 55.96 183.9 54.91C187.38 53.32 187.96 47.65 184.92 44.78C181.58 41.61 176.21 43.01 172.97 47.89C172.53 48.55 172.1 49.09 172.01 49.09C171.92 49.09 171.85 47.92 171.85 46.39L171.85 43.7 171.39 43.34C170.72 42.81 170.23 42.88 166.17 44.14M194.46 44.81C188.02 46.78 187.91 46.83 187.91 48.05C187.91 48.78 188.52 49.43 189.2 49.44C190.27 49.45 191.57 50.46 191.91 51.55C192.22 52.49 192.24 75.31 191.94 76.25C191.52 77.55 190.62 78.22 188.92 78.51C188 78.66 187.74 79 187.74 80.01C187.74 81.51 187.27 81.44 197.36 81.38C207.34 81.31 206.78 81.4 206.78 79.91C206.78 78.84 206.63 78.69 205.36 78.5C203.78 78.26 202.75 77.44 202.41 76.14C202.29 75.71 202.24 71.74 202.27 64.77C202.33 52.57 202.2 53.57 203.94 51.69C207.17 48.2 212.26 48.99 213.5 53.17C213.94 54.64 213.88 75.63 213.44 76.6C213.03 77.5 212.19 78.21 211.36 78.35C209.34 78.7 209.27 78.75 209.11 79.88C209.02 80.53 209.07 80.72 209.38 81.03C209.74 81.4 209.81 81.4 218.7 81.4C228.94 81.4 228.43 81.47 228.43 80.02C228.43 78.97 228.15 78.7 226.8 78.45C225.44 78.2 224.72 77.73 224.31 76.82C224 76.12 223.98 75.53 223.98 65.07L223.98 54.06 224.41 53.19C226.32 49.29 232.2 48.24 234.34 51.41C235.53 53.18 235.59 53.83 235.59 64.88C235.6 74.78 235.51 76.1 234.83 77.16C234.38 77.85 233.38 78.36 232.14 78.52C231.05 78.66 230.71 79.04 230.71 80.1C230.71 81.47 230.21 81.4 240.19 81.4C250.29 81.4 249.74 81.48 249.74 79.94C249.74 79.08 249.43 78.7 248.61 78.52C247.13 78.19 246.38 77.68 245.92 76.68C245.67 76.14 245.63 74.58 245.54 63.5C245.44 51.47 245.42 50.88 245.09 49.87C243.57 45.37 240.18 43.07 235.07 43.08C230.86 43.09 227.2 44.81 224.38 48.1C223.79 48.79 223.25 49.37 223.17 49.4C223.1 49.44 222.75 48.89 222.39 48.18C219.93 43.3 213.36 41.54 207.87 44.3C206.22 45.13 203.97 46.91 203.05 48.1C202.79 48.45 202.49 48.74 202.4 48.74C202.31 48.74 202.24 47.76 202.24 46.39C202.24 43.73 202.2 43.58 201.52 43.23C200.82 42.86 200.96 42.83 194.46 44.81M263.03 43.15C257.91 43.86 253.89 46.94 252.5 51.18C251.99 52.77 251.87 55.91 252.27 57.47C253.32 61.52 255.84 63.92 261.71 66.46C265.78 68.23 268.22 69.48 269.02 70.22C271.23 72.25 271.12 75.92 268.8 77.58C266.82 79.01 263.33 78.99 260.79 77.53C258.58 76.27 257 74.39 255.33 71.03C254.1 68.56 253.75 68.22 252.77 68.57C251.84 68.9 251.64 69.43 251.84 71.09C252.21 74.29 252.53 77.55 252.64 79.22C252.78 81.31 253.04 81.75 254.16 81.75C254.71 81.75 255 81.62 255.53 81.14C256.4 80.35 256.74 80.36 259.3 81.21C262.3 82.2 263.14 82.33 266.11 82.23C272.66 82 277.25 79.02 279 73.86C279.64 71.96 279.81 68.83 279.36 67.07C278.27 62.8 275.93 60.67 269.22 57.82C261.68 54.63 260.75 53.89 260.75 51.12C260.75 49.2 261.42 48.1 263.09 47.28C267.02 45.36 271.65 47.97 274.22 53.56C274.52 54.22 274.89 54.9 275.04 55.07C275.37 55.47 276.59 55.48 277.15 55.09C277.62 54.76 277.61 54.25 277.1 49.44C276.96 48.14 276.79 46.38 276.72 45.54C276.62 44.31 276.52 43.93 276.24 43.66C275.66 43.12 274.83 43.22 274.04 43.93C273.24 44.66 272.78 44.7 271.31 44.18C268.74 43.28 265.25 42.84 263.03 43.15M297.6 43.16C291.74 43.91 286.44 46.99 284.7 50.66C284.1 51.92 283.97 53.98 284.41 55.14C285.86 58.92 291.26 58.93 293.27 55.16C293.63 54.49 293.67 54.18 293.67 51.97C293.67 49.95 293.72 49.41 293.99 48.88C295.18 46.5 299.53 46.07 301.47 48.15C302.61 49.37 303.04 51.85 302.88 56.21L302.8 58.18 301.96 58.61C301.5 58.84 299.72 59.55 298.01 60.18C290.4 62.99 287.92 64.17 285.85 65.94C281.37 69.75 280.81 75.8 284.58 79.59C288.65 83.67 296.25 83.14 301.84 78.38C302.82 77.54 303.36 77.4 303.36 77.99C303.36 78.15 303.52 78.58 303.72 78.97C305.9 83.24 311.82 83.41 315.95 79.32C318.22 77.07 318.67 75.97 317.72 75.06C317.05 74.42 316.79 74.46 315.76 75.37C314.82 76.21 314.34 76.33 313.71 75.89C312.87 75.3 312.89 75.5 312.78 63.41C312.68 50.79 312.7 50.99 311.52 48.65C309.57 44.73 303.63 42.39 297.6 43.16M330.35 43.26C329.87 43.4 328.3 43.9 326.85 44.36C325.41 44.82 323.25 45.5 322.05 45.86C319.46 46.65 319.08 46.92 319.08 47.98C319.08 48.9 319.46 49.34 320.4 49.51C321.64 49.75 322.4 50.26 322.81 51.15C323.18 51.96 323.19 52.04 323.19 63.76C323.19 72.81 323.13 75.72 322.96 76.28C322.59 77.52 321.75 78.14 319.96 78.5C318.83 78.73 318.29 80.26 319.06 81.03C319.43 81.4 319.49 81.4 328 81.4C337.75 81.39 337.25 81.47 337.25 79.94C337.25 79.02 336.91 78.67 335.91 78.51C334.71 78.32 333.89 77.75 333.4 76.77L332.97 75.9 332.97 65.07L332.97 54.24 333.46 53.24C335.79 48.48 341.93 48.25 343.35 52.86C343.7 53.97 343.71 54.43 343.71 64.75C343.71 72.16 343.65 75.72 343.51 76.27C343.19 77.55 342.43 78.13 340.56 78.5C339.71 78.67 339.46 79.01 339.44 79.99C339.42 81.48 338.9 81.4 348.55 81.4C358.17 81.4 357.68 81.48 357.68 79.94C357.68 78.97 357.38 78.7 355.97 78.38C354.68 78.08 353.92 77.46 353.67 76.51C353.38 75.46 353.42 54.52 353.71 53.69C354.53 51.33 356.89 49.61 359.38 49.58C361.24 49.55 362.45 50.22 363.36 51.79C364.14 53.14 364.17 53.76 364.11 65.33C364.06 75.55 364.04 76.29 363.73 76.9C363.33 77.71 362.53 78.22 361.42 78.37C360.28 78.53 359.78 79.04 359.78 80.05C359.78 81.47 359.31 81.4 368.73 81.4C378.2 81.4 377.59 81.5 377.59 79.92C377.59 78.88 377.47 78.72 376.46 78.45C375.45 78.18 374.69 77.66 374.33 77C374.03 76.46 374 75.52 373.92 63.93C373.81 50 373.87 50.66 372.53 47.94C369.32 41.37 359.48 41.38 353.96 47.95C353.4 48.63 352.87 49.17 352.79 49.17C352.7 49.17 352.39 48.71 352.08 48.13C349.31 42.94 342.38 41.39 337.25 44.81C336.13 45.56 333.95 47.58 333.45 48.34C332.99 49.04 332.88 48.59 332.88 46.12C332.88 43.71 332.88 43.7 332.42 43.34C331.88 42.92 331.54 42.9 330.35 43.26M135.05 47.18C132.22 48.27 130.1 52.18 129.39 57.59C129.08 59.97 129.28 66.5 129.72 68.66C131.1 75.31 133.67 78.52 137.61 78.52C141.43 78.52 143.93 75.49 145.04 69.52C146.87 59.66 144.18 48.95 139.43 47.17C138.17 46.7 136.29 46.71 135.05 47.18M301.53 62.74C295.24 65.18 292.38 68.23 292.79 72.04C293.33 76.92 299.21 77.8 302.34 73.47L302.84 72.79 302.84 67.57C302.84 63.51 302.79 62.37 302.62 62.38C302.5 62.39 302.01 62.55 301.53 62.74';
