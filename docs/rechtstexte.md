# formsam – Rechtstexte: Notiz für Julian

Stand: 27.09.2026 · Code: `lib/legal.js` · Seiten: `/impressum`, `/datenschutz`, `/agb`, `/widerruf`, `/versand`

> **Keine Rechtsberatung.** Die Texte sind sorgfältig nach dem tatsächlichen Verhalten des Shops geschrieben
> (Code gelesen: `server.js`, `lib/mailer.js`, `lib/mail-templates.js`, `public/js/*`, `public/sw.js`),
> ersetzen aber keine anwaltliche Prüfung. Für echte Rechtssicherheit: einmal von einer Anwältin/einem Anwalt
> für IT-Recht prüfen lassen oder einen Abmahnschutz-Dienst mit gepflegten Texten nutzen
> (z. B. Händlerbund, IT-Recht Kanzlei, Trusted Shops).

## Vor dem Start erledigen

1. **Anschrift** im Admin (Einstellungen → Firma) eintragen. Im Moment steht dort noch
   „Musterstraße 1, 00000 Musterstadt“ – das erscheint so im Impressum, in der Widerrufsbelehrung und auf Rechnungen.
   Eine ladungsfähige Anschrift ist Pflicht (§ 5 DDG). Ein Postfach reicht nicht.
2. **Telefonnummer** eintragen. Für Fernabsatzverträge ist sie Pflichtinformation
   (Art. 246a § 1 Abs. 1 Nr. 2 EGBGB) und gehört auch in die Widerrufsbelehrung. Ohne Nummer fehlt sie überall.
3. **E-Mail-Adresse** auf die neue Domain umstellen, z. B. `hallo@formsam.de`. Bleibt Gmail der Posteingang,
   landen Kundenmails bei Google – dann „E-Mails“ in der Datenschutzerklärung um Google ergänzen.
4. **Öffentliche Adresse** im Admin (E-Mail → öffentliche Shop-URL) auf `https://formsam.de` setzen.
   Davon hängen ab: die Internet-Adresse der Widerrufsfunktion in der Belehrung, der Hinweis „Verbindung ist
   verschlüsselt (HTTPS)“, der Canonical-Link und die Nennung von „formsam.de“ in den AGB.
   Solange dort `localhost` steht, wird nichts davon angezeigt.
5. **Auftragsverarbeitungsvertrag mit IONOS** abschließen. Das geht online im IONOS-Kundenkonto
   (Bereich Datenschutz/„Vertrag zur Auftragsverarbeitung“). Die Datenschutzerklärung sagt, dass es ihn gibt.
6. **AV-Vertrag mit dem E-Mail-Anbieter**, falls der SMTP-Versand nicht ohnehin über IONOS läuft.
7. **Log-Aufbewahrung** am Server auf höchstens 14 Tage stellen – so steht es in der Datenschutzerklärung:
   nginx-Zugriffsprotokolle (logrotate z. B. `daily` + `rotate 14`) und das Systemprotokoll, in dem die
   Meldungen des Shops landen (journald: `MaxRetentionSec=14day`).
8. **Wirtschafts-Identifikationsnummer**: Sobald das BZSt dir eine W-IdNr. zuteilt (Format `DE123456789-00001`),
   muss sie ins Impressum (§ 5 Abs. 1 Nr. 6 DDG). Trag sie vorerst ins Feld „USt-IdNr.“ ein – das Impressum erkennt
   das Format und beschriftet sie richtig.
9. **Steuernummer** trägst du nur für Rechnungen ein. Im Impressum steht sie absichtlich nicht (keine Pflicht,
   und sie gehört nicht öffentlich ins Netz).
10. **Verpackungsregister LUCID**: Wer Pakete an Privatleute verschickt, muss sich vor dem ersten Verkauf bei der
    Zentralen Stelle Verpackungsregister registrieren und die Versandverpackungen bei einem dualen System
    lizenzieren. Ohne das droht ein Vertriebsverbot – bitte vor dem Start erledigen.
11. **Produktsicherheit (GPSR)**: Als Hersteller müssen auf den Produktseiten Name, Post- und E-Mail-Adresse des
    Herstellers und die Sicherheits-/Pflegehinweise stehen (z. B. „nicht über 50 °C“). Der Shop zeigt im Footer
    („Gut zu wissen“) die Zeile „Hersteller: …“ aus den Firmendaten (`/api/pricing → anbieter`); die Pflegehinweise
    stehen im Konfigurator, im Footer, in der Kasse und auf der Rechnung. Mit echter Anschrift ist das erledigt –
    lass es bei der anwaltlichen Prüfung mit ansehen.
12. **Aufsichtsbehörde** (optional): In „Deine Rechte“ steht allgemein die Behörde deines Bundeslandes. Wenn du magst,
    nenn sie konkret (z. B. BayLDA in Bayern).

## Getroffene Annahmen – bitte prüfen

- **Liefergebiet nur Deutschland** (`settings.shop.liefergebiet`). Achtung: Das PLZ-Feld der Kasse lässt auch
  4-stellige PLZ (Österreich/Schweiz) zu. Lieferst du ins Ausland, Liefergebiet und Versandkosten anpassen.
- **Rücksendekosten trägt die Kundschaft** („Sie tragen die unmittelbaren Kosten der Rücksendung der Waren.“).
  Willst du sie übernehmen, den Satz in `widerruf()` gegen „Wir tragen die Kosten der Rücksendung der Waren.“ tauschen.
- **Alle Vasen gelten als individuell angefertigt** (§ 312g Abs. 2 Nr. 1 BGB – kein Widerrufsrecht). Das ist
  gut vertretbar, weil jede Vase erst nach der Bestellung aus deinen Konfigurator-Vorgaben entsteht. Bei einer Vase,
  die jemand völlig unverändert aus einer Vorlage bestellt, ist es nicht ganz sicher. Deshalb bleibt die volle
  Widerrufsbelehrung stehen, und die Funktion „Vertrag widerrufen“ nimmt jeden Widerruf an – du entscheidest dann
  im Einzelfall.
- **Widerrufsbelehrung im gesetzlichen Wortlaut (per Sie, „wir“)**. Nur das unveränderte Muster schützt dich
  (Gesetzlichkeitsfiktion, Art. 246a § 1 Abs. 2 EGBGB). Die Seite erklärt das in einem Satz.
- **Vertragsschluss** so, wie der Shop arbeitet: „Zahlungspflichtig bestellen“ (bzw. Zahlung bei PayPal) = Angebot,
  die sofortige Bestellbestätigung mit Rechnung = Annahme.
- **Kein Widerrufsrecht von dir** außer in zwei klaren Fällen: Design technisch nicht druckbar, Gravur rechtswidrig.
- **Haftung und Gewährleistung** rein gesetzlich, keine Einschränkung, keine Garantie.
- **Produkteigenschaften** (PLA, 50 °C, Trockenblumen, Voronoi, Standfestigkeit, Schichtlinien) stehen als
  Beschreibung in § 13 AGB, ausdrücklich ohne Einschränkung der Mängelrechte.
- **Datenschutz**: keine Cookies, kein Tracking, keine externen Ressourcen außer PayPal (nur wenn aktiv).
  Aufbewahrung: Rechnungen/Buchungsbelege 8 Jahre (§ 147 AO seit 2025), Geschäftsbriefe 6 Jahre,
  Widerrufe 3 Jahre. Der Shop löscht nichts automatisch – das Löschen nach Fristablauf machst du von Hand.
- **Aktionen und durchgestrichene Preise** (§ 11 PAngV): Bei einer Preisermäßigung muss der durchgestrichene Preis der
  niedrigste Preis der letzten 30 Tage sein. Der Shop zeigt als Bezugspreis den Normalpreis (Mail/Rechnung:
  „Normalpreis … · Aktion −x %“, nicht mehr „UVP“ – eine unverbindliche Preisempfehlung Dritter gibt es bei eigenen
  Vasen nicht). Das stimmt nur, wenn zwischen zwei Aktionen auf dieselben Vasen mindestens 30 Tage liegen und du den
  Normalpreis nicht kurz vorher erhöhst. Aktionen also nicht direkt hintereinander setzen.
- **Stand-Datum** steht zentral in `LEGAL_STAND` (`lib/legal.js`) und muss bei inhaltlichen Änderungen angepasst werden.

## Was du NICHT anpassen musst (läuft automatisch aus den Einstellungen)

| Änderung im Admin | wirkt sich automatisch aus auf |
|---|---|
| Kleinunternehmer an/aus | Preissätze in AGB § 6 und „Versand & Zahlung“, Hinweis im Impressum |
| PayPal an/aus (mit Client-ID) | AGB § 3 und § 8, Datenschutz (Kurzfassung, Zahlung, Bestellung, Empfänger), „Versand & Zahlung“, Lieferfristbeginn |
| Versandkosten / Freigrenze | AGB § 6, „Versand & Zahlung“ (auch „kostenlos“ oder „ohne Freigrenze“) |
| Lieferzeit / Liefergebiet | AGB § 7, „Versand & Zahlung“ |
| Firmendaten, Telefon, USt-IdNr. | Impressum, Datenschutz, AGB § 2, Widerrufsbelehrung, Muster-Formular, Fußzeile |
| Hoster / Serverstandort | Datenschutz |
| Öffentliche Shop-URL | Adresse der Widerrufsfunktion, HTTPS-Hinweis, Canonical, AGB § 1 |

PayPal gilt – genau wie im Shop – erst als angeboten, wenn „aktiv“ **und** eine Client-ID gesetzt ist.

## Was du bei diesen Änderungen selbst anpassen musst (`lib/legal.js`)

- neue Zahlungsarten (Klarna, Kreditkarte …), Newsletter, Statistik/Tracking, eingebettete Inhalte (YouTube, Karten …)
- Eierbecher wieder anbieten (Texte sprechen nur von Vasen; Lebensmittelkontakt wäre neu zu beschreiben)
- E-Mail-Adresse an Versanddienstleister weitergeben (steht aktuell „gebe ich nicht weiter“)
- Lieferung ins Ausland (bei Regelbesteuerung auch Umsatzsteuer/OSS)
- andere Rücksendekosten-Regel

## Hilfen im Code

- `renderLegalPage(slug, { settings, baseUrl })` – die fünf Seiten.
- `renderLegalPage(slug, { settings, baseUrl, forMail: true })` – dieselbe Seite ohne Skript/Formular, mit absoluten
  Links. Die Bestellbestätigung verschickt AGB und Widerrufsbelehrung so als Anhang (`formsam-AGB.html`,
  `formsam-Widerrufsbelehrung.html`) – „dauerhafter Datenträger“ nach § 312f Abs. 2 BGB.
- `legalWarnings(settings)` – Liste fehlender oder vorläufiger Pflichtangaben (Platzhalter-Anschrift, fehlende
  Telefonnummer …); steht im Startlog und als Hinweis in der Admin-Übersicht.
- Kundenkonto und Mails können direkt auf das Formular verlinken: `/widerruf?order=FS-…#widerrufen`
  (auch `?bestellung=`) – die Bestellnummer ist dann schon eingetragen.

## Kasse (Stand der Umsetzung)

- Über „Zahlungspflichtig bestellen“ stehen Links zu AGB, Widerrufsbelehrung und Datenschutz und der Hinweis,
  dass individuell gestaltete Vasen vom Widerrufsrecht ausgenommen sind (§ 312g Abs. 2 Nr. 1 BGB).
- Pflicht-Häkchen „Ich weiß: … nicht zugesichert wasserdicht … keine Zusage zur Standfestigkeit“ (gesonderte
  Vereinbarung nach § 476 Abs. 1 Satz 2 BGB, verweist auf AGB § 13). Der Zeitpunkt steht als
  `beschaffenheitBestaetigt` in der Bestellung (`orders/<ID>/order.json`).
- PayPal (wenn aktiv): Der Knopf ist mit „Jetzt kaufen“ beschriftet (Button-Lösung, § 312j Abs. 3 BGB), und das
  PayPal-Skript lädt erst, wenn PayPal als Zahlungsart gewählt ist. Vor der Zahlung prüft die Kasse Adresse und
  Häkchen – sonst wäre bezahlt, aber die Bestellung nicht angelegt.
