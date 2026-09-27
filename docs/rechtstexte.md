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
11. **Produktsicherheit (GPSR)**: Du bist Hersteller deiner Vasen. Die Verordnung verlangt die Angaben an zwei Stellen:
    - **Online (Art. 19 GPSR):** Name, Post- und E-Mail-Adresse des Herstellers und die Sicherheits-/Pflegehinweise
      beim Angebot. Der Shop zeigt im Footer („Gut zu wissen“) die Zeile „Hersteller: …“ aus den Firmendaten
      (`/api/pricing → anbieter`). Die Pflegehinweise (nicht spülmaschinengeeignet, nicht über 50 °C) stehen im Footer
      („Gut zu wissen“), im Konfigurator (Vasen-Hinweis, `content.json → hinweise.vase`), in der Kasse
      (`hinweise.checkout`), in den FAQ, in § 13 AGB und auf der Rechnung.
    - **Im Paket (Art. 9 Abs. 6 und 7 GPSR):** Name, Post- und E-Mail-Adresse des Herstellers und die Sicherheits- und
      Pflegehinweise müssen auch auf der Vase, der Verpackung oder einem Begleitdokument stehen, das der Ware beiliegt.
      Das übernimmt der Paketbeileger aus dem Brand-Kit (`tmp-tests/brand-kit/druck/paketbeileger-a6*.pdf`). Er muss in
      **jedes** Paket. Die Rückseite trägt die Pflegehinweise und die Zeile „Hersteller: formsam · Julian Sendlhofer ·
      Anschrift · E-Mail“. Diese Zeile kommt beim Bauen aus den Firmendaten im Admin. Im Moment stehen dort noch
      Musteranschrift und Gmail-Adresse, und das Bau-Skript warnt deshalb. Die Rechnung mit Anschrift geht nur per E-Mail
      raus und ersetzt den Beileger nicht, solange sie nicht ausgedruckt beiliegt.

    Erledigt ist das erst, wenn die echte Anschrift und `hallo@formsam.de` eingetragen sind und der Beileger danach neu
    gebaut und gedruckt ist (`brandkit.mjs beileger`, siehe `docs/marke.md` → Offene To-dos). Mit der Anschrift im Admin
    allein ist es nicht getan. Lass beides bei der anwaltlichen Prüfung mit ansehen.
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
  Rechnungen, Gutschriften, Stornobelege und Druckdateien sind nur über Links mit geheimem Schlüssel (`?k=…`) abrufbar,
  nicht mehr allein über die Bestellnummer – so steht es auch im Abschnitt „Bestellung“. Ausnahme: Bestellungen von vor
  der Umstellung (ohne Schlüssel, Nummern `OV-…`) bleiben über die Nummer erreichbar; falsche Abrufe werden je IP
  gebremst. Auch das steht im Abschnitt „Bestellung“ (ohne den alten Namen, nur „Nummer beginnt mit OV-“), dazu das
  Angebot, eine solche Bestellung auf Wunsch nachträglich zu schützen. Fragt jemand danach: Server kurz anhalten (oder
  in einem ruhigen Moment), in `orders/<Nummer>/order.json` einen Schlüssel eintragen und den neuen Link aus dem Admin
  (Rechnung öffnen) per Mail schicken – der alte Link ohne `?k=` gibt danach 404:
  `node -e "const fs=require('fs'),f='orders/OV-…/order.json',o=JSON.parse(fs.readFileSync(f,'utf8'));o.accessKey??=require('crypto').randomBytes(16).toString('base64url');fs.writeFileSync(f,JSON.stringify(o,null,2))"`.
  Im Kundenkonto zeigt eine so geschützte Gastbestellung danach keinen Beleg-Link mehr (wie jede Gastbestellung mit
  Schlüssel), nur noch bei Bestellungen des Kontos selbst.
  Kundenkonto: Gastbestellungen mit derselben E-Mail-Adresse erscheinen erst nach Bestätigung der Adresse (Link per Mail,
  nur zusammen mit der Anmeldung im Konto) – so steht es im Abschnitt „Kundenkonto“. Bestehende Konten beginnen
  unbestätigt.
- **Aktionen und durchgestrichene Preise** (§ 11 PAngV, Art. 6a RL 98/6/EG, EuGH C-330/23): Bei jeder Bekanntgabe einer
  Preisermäßigung muss der niedrigste Gesamtpreis der letzten 30 Tage vor Beginn der Ermäßigung als Bezugspreis
  angegeben werden, und eine Prozentangabe muss sich auf diesen Bezugspreis beziehen. So setzt der Shop das um:
  - **Preis-Historie** `data/preis-historie.json`: Momentaufnahme der Grundpreise, Mengenstaffeln, Aufpreise (Muster,
    Gravur, Farbschrift, Größe, Farben) und aktiven Aktionen (mit „Mengenrabatt zusätzlich“) bei jedem Serverstart und
    jedem Admin-Speichern, das davon etwas ändert. Aufbewahrt werden 90 Tage (plus der Eintrag davor). Der erste Eintrag übernimmt auch schon abgelaufene
    Aktionen (z. B. die vom 19.09.2026), damit sie im 30-Tage-Fenster mitzählen.
  - **Streichpreis** (Konfigurator Desktop und Handy, Produktkarte, Detailblatt, Warenkorb, Kasse) = niedrigster
    Stückpreis der jeweiligen Konfiguration in den 30 Tagen vor dem Aktionsstart – auch zu Preisen einer früheren
    Aktion. Er steht nur dort, wo auch die Kennzeichnung „Niedrigster Preis der letzten 30 Tage: 24,90 €“ sichtbar
    daneben steht; in engen Zeilen (Hero-Hinweis, Preiszeile im Handy-Hero, Bestell-Pille) steht nur der Aktionspreis.
    Warenkorb und Kasse erklären den Streichpreis zusätzlich in einer Fußzeile. „UVP“ oder „Preis ohne Aktion“ steht
    nirgends mehr.
  - **Ab 2 Stück** vergleicht der Warenkorb die ganze Zeile mit dem niedrigsten Preis genau dieser Menge in den 30 Tagen
    – mit dem Mengenrabatt, der damals galt. Entfällt der Mengenrabatt während der Aktion und ist die Zeile dadurch
    nicht günstiger als vorher, gibt es dort keinen Streichpreis, kein Badge und kein „du sparst“. Momentaufnahmen
    von vor dieser Erweiterung kennen die Staffel nicht; solange eine davon im Fenster liegt, zeigt der Warenkorb ab
    2 Stück vorsichtshalber keinen Zeilen-Streichpreis.
  - **Prozent-Badges** rechnen gegen diesen Tiefstpreis (−6 % statt −20 %, wenn zehn Tage vorher −15 % liefen). Liegt
    der Aktionspreis nicht unter dem Tiefstpreis, zeigt der Shop nur den aktuellen Preis – ohne Streichpreis, Badge und
    „Aktionspreis“-Zeile; die Aktion rechnet trotzdem.
  - **Banner/Aktionsleiste** nennen „−15 %“ nur, wenn die Zahl für den ganzen Geltungsbereich stimmt (im Fenster keine
    andere Aktion auf dieselben Vasen, kein niedrigerer Grund- oder Aufpreis). Sonst: „Name: Aktionspreise auf … ·
    endet in …“. „Du sparst“ im Warenkorb rechnet ebenfalls gegen den Tiefstpreis.
  - **Admin → Aktionen** erklärt die Regel und warnt, wenn eine andere Aktion mit überschneidendem Geltungsbereich
    weniger als 30 Tage vor dem Start endet(e).
  - **Mail und Rechnung** bleiben informativ („Normalpreis … · Aktion −x %“) – sie sind keine Werbung, sondern
    Belege über den tatsächlich berechneten Preis.
  - **Versandkosten am Preis** (§ 6 PAngV): Unter dem Preis im Konfigurator steht „zzgl. 4,90 € Versand · ab 39 €
    versandfrei“ (bei Kleinunternehmern davor „Endpreis, keine USt. nach § 19 UStG“), in der Handy-Preisleiste, am
    Hero-Hinweis, auf der Produktkarte und in der Hero-Preiszeile kurz „zzgl. Versand“ mit Link zu „Versand & Zahlung“,
    in den Detailblättern der volle Satz – immer vor „In den Warenkorb“. Werte kommen aus den Einstellungen.
  - Nicht betroffen: individuelle Gutscheine, Mengenrabatte (außer beim Zeilenvergleich ab 2 Stück, siehe oben). Die Ausnahme für schrittweise erhöhte Ermäßigungen
    (§ 11 Abs. 3 PAngV) nutzt der Shop nicht – er rechnet immer mit dem strengeren Tiefstpreis.
  - Praxis-Tipp bleibt: zwischen zwei Aktionen auf dieselben Vasen mindestens 30 Tage Abstand lassen und Preise nicht
    kurz vor einer Aktion erhöhen – sonst schrumpfen Streichpreis und Prozentzahl.
- **Stand-Datum** steht zentral in `LEGAL_STAND` (`lib/legal.js`) und muss bei inhaltlichen Änderungen angepasst werden.

## Was du NICHT anpassen musst (läuft automatisch aus den Einstellungen)

| Änderung im Admin | wirkt sich automatisch aus auf |
|---|---|
| Kleinunternehmer an/aus | Preissätze in AGB § 6 und „Versand & Zahlung“, Hinweis im Impressum, USt.-Hinweis am Preis im Shop |
| PayPal an/aus (mit Client-ID) | AGB § 3 und § 8, Datenschutz (Kurzfassung, Zahlung, Bestellung, Empfänger), „Versand & Zahlung“, Lieferfristbeginn |
| Versandkosten / Freigrenze | AGB § 6, „Versand & Zahlung“ (auch „kostenlos“ oder „ohne Freigrenze“), Versandhinweis am Preis im Shop |
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
- Pflicht-Häkchen „Ich bin ausdrücklich einverstanden: … Wasserdichtigkeit nicht vereinbart … Standfestigkeit nicht
  vereinbart“ (ausdrückliche und gesonderte Vereinbarung nach § 476 Abs. 1 Satz 2 Nr. 2 BGB, verweist auf AGB § 13).
  Ohne das Häkchen nimmt der Server keine Bestellung an (auch nicht bei PayPal vor der Zahlung). Der Zeitpunkt steht als
  `beschaffenheitBestaetigt` in der Bestellung (`orders/<ID>/order.json`).
- Lieferfrist: Bestellbestätigung, Rechnung und der Hinweis nach dem Bestellen sagen wörtlich dasselbe wie AGB § 7 und
  die Versandseite (ohne „ca.“, Fristbeginn bei Vorkasse am Tag nach dem Überweisungsauftrag, bei PayPal am Tag nach
  Vertragsschluss) — eine Quelle: `lib/lieferfrist.js`.
- Preisangabe (§ 312j Abs. 2 BGB, AGB § 6 Abs. 1): Die Kasse schickt den angezeigten Gesamtbetrag mit; rechnet der
  Server inzwischen anders (Preis oder Aktion im Admin geändert), legt er keine Bestellung an, sondern die Kasse zeigt
  den neuen Betrag und lässt erneut bestätigen.
- PayPal (wenn aktiv): Der Knopf ist mit „Jetzt kaufen“ beschriftet (Button-Lösung, § 312j Abs. 3 BGB), und das
  PayPal-Skript lädt erst, wenn PayPal als Zahlungsart gewählt ist. Vor der Zahlung prüft die Kasse Adresse und
  Häkchen – sonst wäre bezahlt, aber die Bestellung nicht angelegt.
