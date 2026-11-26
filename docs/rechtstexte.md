# formsam – Rechtstexte: Notiz für Julian

Stand: 26.11.2026 · Code: `lib/legal.js`, `lib/produkthinweise.js` · Seiten: `/impressum`, `/datenschutz`, `/agb`, `/widerruf`, `/versand`

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
3. **E-Mail-Adresse** auf die eigene Domain umstellen: `hallo@formsam.com` (Postfach auf dem eigenen Mailserver).
   Bleibt Gmail der Posteingang, landen Kundenmails bei Google – dann „E-Mails“ in der Datenschutzerklärung um
   Google ergänzen.
4. **Öffentliche Adresse** im Admin (✉️ E-Mail → „Öffentliche Shop-Adresse“) auf `https://www.formsam.com` setzen.
   Davon hängen ab: die Internet-Adresse der Widerrufsfunktion in der Belehrung (Pflichtangabe nach dem Muster),
   der Hinweis „Verbindung ist verschlüsselt (HTTPS)“, Canonical und Vorschau-Adressen von Startseite und
   Rechtsseiten, robots.txt/sitemap.xml und die Nennung der Adresse in den AGB. Solange dort nichts oder `localhost`
   steht, nennt die Belehrung nur „den Punkt „Vertrag widerrufen“ auf der Seite „Widerruf““ – die Admin-Übersicht
   warnt dann.
5. **Hoster und AV-Vertrag – je Server** (Admin → Mein Unternehmen → Rechtstexte). Es gibt keinen Standard mehr:
   ohne Eintrag nennt die Datenschutzerklärung nur „einen Hosting-Anbieter“, und die Übersicht warnt. Den Satz
   „Dafür habe ich einen Vertrag zur Auftragsverarbeitung … geschlossen“ zeigt sie nur, wenn das Häkchen
   „AV-Vertrag … abgeschlossen“ gesetzt ist (wird der Hoster geändert, ist das Häkchen wieder weg).
   - Produktivserver: **1blu** (laut Betreibernotiz; Firma und Anschrift aus dem 1blu-Kundenkonto übernehmen,
     Serverstandort laut Vertrag). Die Einstellungen wurden vom Testserver übernommen – dort steht womöglich noch IONOS.
     Bitte im Prod-Admin prüfen und den AV-Vertrag mit 1blu im Kundenkonto abschließen, dann das Häkchen setzen.
   - Testserver: IONOS (AV-Vertrag im IONOS-Kundenkonto, Bereich Datenschutz).
   Bestehende Installationen mit eingetragenem Hoster gelten nach dem Update einmalig als bestätigt (der Text
   ändert sich dort nicht) – also bewusst prüfen. Ausnahme ist der frühere Standardwert „IONOS SE, Elgendorfer
   Str. 57, 56410 Montabaur“: Den hat der alte Code auf jedem Server ungefragt gespeichert, er ist also kein Beleg
   für einen echten Eintrag. Steht er noch drin, ist das Häkchen nach dem Update aus, der AV-Satz fehlt, und
   Übersicht und Karte bitten um Prüfung. Auf dem Testserver (wirklich IONOS) genügt das Häkchen, auf dem
   Produktivserver den richtigen Hoster eintragen.
6. **Mail-Versand** (Rechtstexte → „Mail-Versand“): Auf dem Produktivserver „Eigener Mailserver auf diesem Server“
   (Stalwart, mx.formsam.com) einstellen. Dann beschreibt die Datenschutzerklärung den eigenen Mailserver beim
   Hoster mit Postfächern, Spamprüfung, Mailserver-Protokollen (14 Tage) und den Sicherungen der Postfächer und
   nennt keinen E-Mail-Anbieter. Läuft der Versand über einen Anbieter (z. B. Testserver), „Über einen
   E-Mail-Anbieter“ wählen, Namen eintragen und mit ihm einen AV-Vertrag schließen. Bestehende Installationen
   stehen nach dem Update auf „Anbieter“ (wie der bisherige Text).
7. **Protokolle und Sicherungen** auf 14 Tage begrenzen – so steht es in der Datenschutzerklärung (Zugriffs- und
   Betriebsprotokolle, Mailserver-Protokolle, Sicherungen). Die Dateien liegen unter `deploy/`
   (`journald-formsam.conf`, `logrotate-formsam-nginx`, `nginx-formsam-log.conf`; die Sicherungsskripte löschen nach
   14 Tagen); einspielen laut README „Protokolle und Sicherungen“, prüfen mit
   `bash /srv/formsam/deploy/prod-update.sh --pruefen`. Eine zusätzliche Sicherung außer Haus bei einem weiteren
   Anbieter ist ein weiterer Empfänger: dann AV-Vertrag schließen und die Datenschutzerklärung (Abschnitt
   „Hosting und Server“ → Sicherungen, „Wer Daten bekommt“) in `lib/legal.js` ergänzen.
8. **Wirtschafts-Identifikationsnummer**: Sobald das BZSt dir eine W-IdNr. zuteilt (Format `DE123456789-00001`),
   muss sie ins Impressum (§ 5 Abs. 1 Nr. 6 DDG). Dafür gibt es ein eigenes Feld: Admin → Mein Unternehmen →
   Steuer & Belege → „W-IdNr.“. (Ältere Einträge im Feld „USt-IdNr.“ im W-IdNr.-Format erkennt das Impressum weiter.)
9. **Steuernummer** gehört auf jede Rechnung – auch als Kleinunternehmer (§ 34a UStDV; ausgenommen nur
   Kleinbetragsrechnungen bis 250 €), es sei denn, die USt-IdNr. steht darauf. Die Admin-Übersicht warnt, solange
   beides fehlt. Im Impressum steht die Steuernummer absichtlich nicht (keine Pflicht, und sie gehört nicht
   öffentlich ins Netz). Ebenso warnt der Admin bei der Platzhalter-IBAN „DE00 …“ – die echte IBAN eintragen.
10. **Verpackungsregister LUCID**: Wer Pakete an Privatleute verschickt, muss sich vor dem ersten Verkauf bei der
    Zentralen Stelle Verpackungsregister registrieren und die Versandverpackungen bei einem dualen System
    lizenzieren. Ohne das droht ein Vertriebsverbot – bitte vor dem Start erledigen.
11. **Produktsicherheit (GPSR)**: Du bist Hersteller deiner Vasen. Die Verordnung verlangt die Angaben an zwei Stellen:
    - **Online (Art. 19 GPSR):** Name, Post- und E-Mail-Adresse des Herstellers und die Sicherheits-/Pflegehinweise
      beim Angebot. Der Shop zeigt im Footer („Gut zu wissen“) und in der Kasse (unter dem Hinweis zu AGB und
      Widerruf) die Zeile „Hersteller: …“ aus den Firmendaten (`/api/pricing → anbieter`). Die Pflegehinweise (nicht spülmaschinengeeignet, nicht über 50 °C) stehen im Footer
      („Gut zu wissen“), im Konfigurator (Vasen-Hinweis, `content.json → hinweise.vase`), in der Kasse
      (`hinweise.checkout`), in den FAQ, in § 13 AGB und auf der Rechnung.
    - **Im Paket (Art. 9 Abs. 6 und 7 GPSR):** Name, Post- und E-Mail-Adresse des Herstellers und die Sicherheits- und
      Pflegehinweise müssen auch auf der Vase, der Verpackung oder einem Begleitdokument stehen, das der Ware beiliegt.
      Das übernimmt der Paketbeileger aus dem Brand-Kit (`tmp-tests/brand-kit/druck/paketbeileger-a6*.pdf`). Er muss in
      **jedes** Paket. Die Rückseite trägt die Pflegehinweise und die Zeile „Hersteller: formsam · Julian Sendlhofer ·
      Anschrift · E-Mail“. Diese Zeile kommt beim Bauen aus den Firmendaten im Admin. Im Moment stehen dort noch
      Musteranschrift und Gmail-Adresse, und das Bau-Skript warnt deshalb. Die Rechnung mit Anschrift geht nur per E-Mail
      raus und ersetzt den Beileger nicht, solange sie nicht ausgedruckt beiliegt.

    Erledigt ist das erst, wenn die echte Anschrift und `hallo@formsam.com` eingetragen sind und der Beileger danach neu
    gebaut und gedruckt ist (`brandkit.mjs beileger`, siehe `docs/marke.md` → Offene To-dos). Mit der Anschrift im Admin
    allein ist es nicht getan. Lass beides bei der anwaltlichen Prüfung mit ansehen.
12. **Aufsichtsbehörde** (optional): In „Deine Rechte“ steht allgemein die Behörde deines Bundeslandes. Wenn du magst,
    nenn sie konkret (z. B. BayLDA in Bayern).

## Getroffene Annahmen – bitte prüfen

- **Liefergebiet nur Deutschland** (`settings.shop.liefergebiet`). Kasse, Konto-Adresse und Server verlangen dann eine
  5-stellige PLZ (`plzFehler`); steht im Liefergebiet mehr als „Deutschland“, sind 4–5 Ziffern erlaubt (Österreich/Schweiz).
  Lieferst du ins Ausland, Liefergebiet und Versandkosten anpassen.
- **Rücksendekosten trägt die Kundschaft** („Sie tragen die unmittelbaren Kosten der Rücksendung der Waren.“).
  Willst du sie übernehmen, den Satz in `widerruf()` gegen „Wir tragen die Kosten der Rücksendung der Waren.“ tauschen.
- **Alle Vasen gelten als individuell angefertigt** (§ 312g Abs. 2 Nr. 1 BGB – kein Widerrufsrecht). Das ist
  gut vertretbar, weil jede Vase erst nach der Bestellung aus deinen Konfigurator-Vorgaben entsteht. Bei einer Vase,
  die jemand völlig unverändert aus einer Vorlage bestellt, ist es nicht ganz sicher. Deshalb bleibt die volle
  Widerrufsbelehrung stehen, und die Funktion „Vertrag widerrufen“ nimmt jeden Widerruf an – du entscheidest dann
  im Einzelfall.
- **Widerrufsbelehrung nach dem gesetzlichen Muster (per Sie, „wir“)** in der seit 19.06.2026 geltenden Fassung
  (Anlage 1 zu Art. 246a § 1 Abs. 2 Satz 2 EGBGB; abgeglichen am 25.11.2026 mit gesetze-im-internet.de). Weil der
  Shop zur Widerrufsfunktion verpflichtet ist (§ 356a BGB), steht der Baustein aus Gestaltungshinweis 3 für diesen
  Fall darin: „Sie können Ihr Widerrufsrecht auch online unter <Adresse>/widerruf#widerrufen ausüben. Wenn Sie diese
  Online-Funktion nutzen, übermitteln wir Ihnen auf einem dauerhaften Datenträger (z. B. durch eine E-Mail)
  unverzüglich eine Eingangsbestätigung …“ – nicht mehr der Baustein für ein freiwilliges Webformular. Nur das
  unveränderte Muster schützt dich (Gesetzlichkeitsfiktion, Art. 246a § 1 Abs. 2 EGBGB). Deshalb steht im Kasten nur
  das Muster bis „Ende der Widerrufsbelehrung“; der **Ausschluss** (§ 312g Abs. 2 Nr. 1 BGB) folgt getrennt darunter,
  zusammen mit „Was das für dich heißt“. Die Internetadresse kommt aus der öffentlichen Shop-Adresse (Punkt 4).
  Ändert der Gesetzgeber das Muster, `widerruf()` in `lib/legal.js` und `LEGAL_STAND` anpassen.
- **Aussagen zum Widerrufsrecht** sind überall gleich: Für Vasen nach deinem Design ist es *in der Regel*
  ausgeschlossen, jeder Widerruf wird geprüft (Kasse, FAQ, AGB § 10, Seite „Widerruf“; die Eingangsbestätigung per
  Mail kündigt keine Rücksendung/Erstattung an, sondern die Prüfung).
- **Vertragsschluss** so, wie der Shop arbeitet: „Zahlungspflichtig bestellen“ (bzw. Zahlung bei PayPal) = Angebot,
  die sofortige Bestellbestätigung mit Rechnung = Annahme. Sie bringt Rechnung, AGB und Widerrufsbelehrung (mit
  Muster-Widerrufsformular) als PDF-Anhang mit – die Vertragsbestätigung auf einem dauerhaften Datenträger (§ 312f Abs. 2
  BGB); Einzelheiten und Rückfälle unter „Hilfen im Code“.
- **Kein Widerrufsrecht von dir** außer in zwei klaren Fällen: Design technisch nicht druckbar, Gravur rechtswidrig.
- **Haftung und Gewährleistung** rein gesetzlich, keine Einschränkung, keine Garantie.
- **Produkteigenschaften** (PLA, 50 °C, Trockenblumen, Voronoi, Standfestigkeit, Schichtlinien) stehen als
  Beschreibung in § 13 AGB, ausdrücklich ohne Einschränkung der Mängelrechte.
- **Datenschutz**: keine Cookies (außer dem Zugangs-Cookie `fs_zugang`, 30 Tage, nur wenn jemand im Wartungsmodus
  das Zugangskennwort eingibt), kein Tracking, keine externen Ressourcen außer PayPal (nur wenn aktiv). Tägliche
  Sicherungen (Shop und Postfächer) werden nach 14 Tagen gelöscht – auch gelöschte Daten liegen so lange noch darin;
  das steht in „Hosting und Server“.
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
- **Versandkostenfreiheit, Mengenrabatt, Gutscheine** (AGB § 6 und § 14, „Versand & Zahlung“ – gleiche Regel wie
  `computeTotals` im Server und `summen` in `public/js/pricing.js`): Die Freigrenze misst den Warenwert nach Aktions-
  und Mengenrabatt, aber **vor** Gutschein und Guthaben – ein Gutschein macht eine Bestellung also nie teurer.
  Mengenrabatte gelten je Design (mehrere Stück derselben Gestaltung); während einer Aktion ohne zusätzlichen
  Mengenrabatt gilt der normale Preis mit Mengenrabatt, wenn er günstiger ist. Ein Guthaben (Gutschrift-Code) ist
  ein Zahlungsmittel: Es deckt auch den Versand und lässt die Versandkostenfreiheit unberührt. Gutscheine können ein
  Ablaufdatum und eine Höchstzahl an Einlösungen haben – solche Bedingungen bei der Bekanntgabe des Gutscheins nennen.
  Ändert sich eine dieser Regeln im Code, AGB § 6/§ 14 und Versandseite mitziehen.
- **Zahlungsfrist** 14 Tage nach Vertragsschluss (AGB § 8, Versandseite, Bestätigung, Rechnung, Zahlungserinnerung)
  kommt aus `ZAHLUNGSFRIST_TAGE` in `lib/lieferfrist.js`; die Nachfrist der Erinnerung aus `NACHFRIST_TAGE`.
- **Datenschutz – Speicherdauer im Betrieb:** Inhalte nicht zugestellter Mails löscht der Shop spätestens nach 90 Tagen
  (Abschnitt „E-Mails“). Nie abgeschlossene Kassen: Druckdateien nach 48 Stunden (bei knappem Speicher nach 1 Stunde),
  die angefangene Bestellung nach 14 Tagen (Abschnitt „Bestellung“). Das gilt für unbearbeitete Kassen; eine im Admin
  stornierte oder bearbeitete räumt der Shop nicht auf – deshalb rät der Admin davon ab (ein Storno ginge ohne Kundenmail). Missbrauchsbremsen zählen IP-Adressen (IPv6 als
  /64-Netz) nur im Arbeitsspeicher, höchstens einen Tag (Abschnitt „Wenn du die Website aufrufst“). Das Konto lässt sich
  unter „Mein Konto“ selbst löschen; eine Datenauskunft erstellst du im Admin unter Kunden (Datenexport als JSON) und
  schickst sie per Mail (Abschnitt „Kundenkonto“).
- **Lieferzeit je Farbe** (AGB § 7, Versandseite): Die allgemeine Lieferzeit gilt, soweit bei der gewählten Farbe keine andere
  angegeben ist; bei mehreren Positionen gilt für die ganze Bestellung die längste (bei Farbschrift zählt die Schriftfarbe mit). Die
  Bestellung hält ihre Lieferzeit beim Anlegen fest (`order.lieferzeit`), Bestätigung und Rechnung nennen genau diese. Sie ist nie länger
  als die in der Kasse angezeigte (§ 312d Abs. 1 BGB – die Angabe wird Vertragsinhalt): Ändert sich eine Farbe, während die Kasse offen
  ist, lehnt der Shop ab und zeigt die neue Lieferzeit. Annahme: Es wird gemeinsam verschickt (keine Teillieferung) – wer Teillieferungen
  möchte, muss AGB § 7 anpassen.
- **Allgemeine Lieferzeit auf der Startseite** (Trust-Zeile, „So geht’s“, FAQ): Braucht eine bestellbare Farbe länger, steht dort
  „5–8 Werktage, einzelne Farben länger“ (in den kleinen Kacheln auf dem Handy die ganze Spanne, z. B. „5–14 Werktage“), damit die
  Werbeaussage nicht pauschal zu kurz ist.
- **Farben „auf Anfrage“ und individuelle Angebote:** Solche Farben sind im Shop nicht bestellbar (die Kasse lehnt sie ab), nur
  anzufragen. Ein Angebot per E-Mail ist ein Vertrag außerhalb der Shop-Kasse: Annahme, Preis, Lieferzeit und ob die Vase nach
  deinen Vorgaben gefertigt wird (Ausschluss des Widerrufsrechts nach § 312g Abs. 2 Nr. 1 BGB) gehören ausdrücklich ins Angebot;
  Widerrufsbelehrung, AGB und eine Bestätigung auf dauerhaftem Datenträger schickst du dann selbst mit. AGB § 3 beschreibt nur
  die Shop-Bestellung – **bitte prüfen**, ob du für Angebote einen eigenen Satz in den AGB möchtest.
- **Datenschutz – Anfrageformular** (Abschnitt `#anfrage`): Name, E-Mail, Nachricht, Anlass, Farbe, Benachrichtigungswunsch,
  Design-Code (entsteht erst beim Absenden und nur mit Häkchen – nur das Öffnen speichert nichts), Eingangszeit; Art. 6 Abs. 1 lit. b bzw. f DSGVO; Zustellung als Mail an dich über den eingestellten Mailserver, keine
  automatische Mail an die Kundin; Anfrageliste bis zur Erledigung, höchstens 12 Monate (der Shop löscht ältere selbst). Erledigte
  Anfragen im Admin löschen, sobald du sie nicht mehr brauchst – so steht es in der Erklärung.
- **Stand-Datum** steht zentral in `LEGAL_STAND` (`lib/legal.js`) und muss bei inhaltlichen Änderungen angepasst werden.

## Was du NICHT anpassen musst (läuft automatisch aus den Einstellungen)

| Änderung im Admin | wirkt sich automatisch aus auf |
|---|---|
| Kleinunternehmer an/aus | Preissätze in AGB § 6 und „Versand & Zahlung“, Hinweis im Impressum, USt.-Hinweis am Preis im Shop, in Warenkorb, Kasse und Bestellbestätigung („inkl. MwSt.“ bzw. „keine USt. nach § 19 UStG“) – Rechnung, Gutschrift und Storno folgen dem Steuerstatus der Bestellung (`order.steuer`) |
| PayPal an/aus (mit Client-ID) | AGB § 3 und § 8, Datenschutz (Kurzfassung, Zahlung, Bestellung, Empfänger), „Versand & Zahlung“, Lieferfristbeginn |
| Versandkosten / Freigrenze | AGB § 6, „Versand & Zahlung“ (auch „kostenlos“ oder „ohne Freigrenze“), Versandhinweis am Preis im Shop |
| Lieferzeit / Liefergebiet | AGB § 7, „Versand & Zahlung“, PLZ-Prüfung in Kasse und Konto (Deutschland: 5 Ziffern) |
| Farben: Lieferzeit je Farbe, „auf Anfrage“ | „Versand & Zahlung“ (Liste der Farben mit abweichender Lieferzeit und der Farben auf Anfrage), Konfigurator, Warenkorb, Kasse, Bestätigung und Rechnung neuer Bestellungen |
| Antwort-Adresse (✉️ E-Mail) bzw. Firmen-E-Mail | Kontaktadresse bei „Individuelles Angebot“ (Konfigurator, FAQ, Fußzeile) und in der Erfolgsmeldung des Anfrageformulars |
| Firmendaten, Telefon, USt-IdNr. | Impressum, Datenschutz, AGB § 2, Widerrufsbelehrung, Muster-Formular, Fußzeile, PDF-Anhänge der Bestätigung (als PDF erst mit Inhaber, vollständiger Anschrift und E-Mail, sonst HTML) |
| Hoster / Serverstandort / AV-Vertrag (Häkchen) | Datenschutz (Hosting, Kurzfassung, Empfänger; ohne Hoster neutraler Text + Admin-Warnung) |
| Mail-Versand (eigener Mailserver / Anbieter + Name) | Datenschutz (E-Mails, Speicherdauer, Sicherungen, Empfänger) |
| Öffentliche Shop-URL | Adresse der Widerrufsfunktion, HTTPS-Hinweis, Canonical/og der Startseite und Rechtsseiten, robots.txt, sitemap.xml, AGB § 1 |

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
  Links (auch im Text, z. B. AGB § 10 → Widerrufsfunktion). Rückfall-Anhang der Bestellbestätigung (`formsam-AGB.html`,
  `formsam-Widerrufsbelehrung.html`), wenn die PDF-Fassung nicht entstehen kann (z. B. unvollständige Firmendaten).
- `renderLegalPage(slug, { settings, baseUrl, forPdf: true, logoHtml })` – schlichte Druckfassung (A4, Text wie `forMail`,
  absolute Links, `logoHtml` = fertiges Inline-SVG) als Vorlage für den eigenen PDF-Satz (`legalPdf` in `lib/html-pdf.js`).
  Die Bestellbestätigung verschickt AGB und Widerrufsbelehrung (mit Muster-Widerrufsformular) so als PDF (`formsam-AGB.pdf`,
  `formsam-Widerrufsbelehrung.pdf`), dazu die Rechnung (`formsam-Rechnung-<Nummer>.pdf`) – „dauerhafter Datenträger“ nach
  § 312f Abs. 2 BGB. Der verschickte Stand der Rechtstexte liegt je Bestellung in `orders/<ID>/agb.pdf` und `widerruf.pdf`
  (nicht öffentlich abrufbar); „Erneut“ im Versandprotokoll schickt genau diesen damaligen Stand, auch wenn sich Texte oder
  Firmendaten seither geändert haben. Rückfälle: Fehlen Pflichtangaben unter „Mein Unternehmen“ (Inhaber, vollständige Anschrift
  ohne Platzhalter Musterstraße/00000/Musterstadt, gültige E-Mail), gehen AGB und Widerrufsbelehrung als HTML mit (`forMail`),
  die Rechnung trotzdem als PDF. Scheitert der PDF-Satz einer Datei (z. B. ein Zeichen ohne Glyphe), geht der Rechtstext als
  HTML mit bzw. fehlt die Rechnungs-PDF (dann bleibt der Knopf „Rechnung ansehen“). Der Mailtext nennt nur, was wirklich anhängt. Im Startprotokoll steht „PDF-Belege: lib/html-pdf.js geladen“; „📄 PDF … nicht erzeugt“ heißt
  Rückfall (README „Rechnungen und Rechtstexte als PDF“). Wer die Rechtstexte ändert, muss an den PDFs nichts tun: Neue
  Bestellungen bekommen automatisch die neue Fassung.
- `legalWarnings(settings)` – Liste fehlender oder vorläufiger Pflichtangaben (Platzhalter-Anschrift, fehlende
  Telefonnummer, Hoster/Serverstandort fehlt, AV-Vertrag nicht bestätigt, öffentliche Adresse fehlt …); steht im
  Startlog und als Hinweis in der Admin-Übersicht.
- `lib/produkthinweise.js` – Produkthinweise (Material, Wasser, Voronoi, Standfestigkeit) und der Wortlaut des
  Kassen-Häkchens je Fassung. Die Rechnung nimmt die Sätze von dort (Voronoi- und Formen-Satz mit Positionsnummern),
  die Kasse zeigt dieselben Sätze aus `content.json`; `node tools/test-recht.mjs` prüft die Wortgleichheit.
- Kundenkonto und Mails können direkt auf das Formular verlinken: `/widerruf?order=FS-…#widerrufen`
  (auch `?bestellung=`) – die Bestellnummer ist dann schon eingetragen.

## Kasse (Stand der Umsetzung)

- Über „Zahlungspflichtig bestellen“ stehen Links zu AGB, Widerrufsbelehrung und Datenschutz und der Hinweis,
  dass nach deinem Design gefertigte Vasen in der Regel vom Widerrufsrecht ausgenommen sind (§ 312g Abs. 2 Nr. 1 BGB).
- Pflicht-Häkchen „Ich bin ausdrücklich einverstanden: … Wasserdichtigkeit nicht vereinbart … Standfestigkeit nicht
  vereinbart“ (ausdrückliche und gesonderte Vereinbarung nach § 476 Abs. 1 Satz 2 Nr. 2 BGB, verweist auf AGB § 13).
  Ohne das Häkchen nimmt der Server keine Bestellung an (auch nicht bei PayPal vor der Zahlung). Der Zeitpunkt steht als
  `beschaffenheitBestaetigt`, die Fassung des Wortlauts als `beschaffenheitFassung` (z. B. `2026-09-27`, Text in
  `lib/produkthinweise.js` → `BESCHAFFENHEIT_TEXTE`) in der Bestellung (`orders/<ID>/order.json`). Bestellungen vor dem
  Update (mit `beschaffenheitBestaetigt`, ohne Fassung) haben dem Wortlaut `2026-09-27` zugestimmt. Wer den Häkchentext ändert, legt dort eine neue Fassung an.
- Lieferfrist: Bestellbestätigung, Rechnung und der Hinweis nach dem Bestellen sagen wörtlich dasselbe wie AGB § 7 und
  die Versandseite (ohne „ca.“, Fristbeginn bei Vorkasse am Tag nach dem Überweisungsauftrag, bei PayPal am Tag nach
  Vertragsschluss) — eine Quelle: `lib/lieferfrist.js`.
- Preisangabe (§ 312j Abs. 2 BGB, AGB § 6 Abs. 1): Die Kasse schickt den angezeigten Gesamtbetrag mit; rechnet der
  Server inzwischen anders (Preis oder Aktion im Admin geändert), legt er keine Bestellung an, sondern die Kasse zeigt
  den neuen Betrag und lässt erneut bestätigen.
- PayPal (wenn aktiv): Der Knopf ist mit „Jetzt kaufen“ beschriftet (Button-Lösung, § 312j Abs. 3 BGB), und das
  PayPal-Skript lädt erst, wenn PayPal als Zahlungsart gewählt ist. Vor der Zahlung prüft die Kasse Adresse und
  Häkchen – sonst wäre bezahlt, aber die Bestellung nicht angelegt.
