# formsam — Markenleitfaden

Kurz und praktisch: wie formsam geschrieben, gesagt, gezeigt und gesetzt wird.
Stand: 27.09.2026 · Logo-Dateien: `public/img/brand/` · Brand-Kit (PNG, PDF, Social, Signatur): siehe unten.

## Name & Schreibweise

- **formsam** — immer klein, immer ein Wort. Auch am Satzanfang, in Überschriften, Betreffzeilen und Titeln.
- Aussprache: **FORM-sahm**, betont auf der ersten Silbe, die zweite wie in „langsam“. Am Telefon: „Form, und sam wie langsam.“
- In Zeilen mit Versalien (`text-transform: uppercase`) bleibt der Name klein: im Code `<span class="nm">formsam</span>` mit `text-transform: none`.
- Nicht: ~~Formsam~~, ~~FormSam~~, ~~FORMSAM~~, ~~form sam~~, ~~form-sam~~, ~~formsam®~~ (solange nicht eingetragen).
- Die alte Marke „OVJU“ / „Julians Eierbecher“ taucht für Kundschaft nirgends mehr auf. Ausnahme: bereits ausgestellte Rechnungen und Gutschriften bleiben unverändert (GoBD).

## Bedeutung

**form + -sam** — wie sorg*sam*, acht*sam*, gemein*sam*. Eine Form, sorgsam gemacht und gemeinsam gestaltet:
Du entwirfst die Form, Julian druckt sie mit Sorgfalt. Das Wort klingt, als gäbe es es im Deutschen längst.

## Claim & Leitsätze

| Satz | Rolle | Wo |
|---|---|---|
| **Sorgsam geformt. Auf dich zugeschnitten.** | Claim | unter/neben dem Logo, Seitentitel, Kopf jeder E-Mail, Social-Vorschau, Profil-Bio |
| **Deine Idee. Deine Form.** | Shop-Headline | Startseite, direkt über dem Konfigurator |
| **Du entwirfst, ich drucke.** | Haltung | Story/Über formsam, Paketbeileger, Instagram |
| **Gedruckt wird erst, wenn du bestellst.** | Versprechen | neben der Lieferzeit, in der Bestellbestätigung, im Checkout |

Die Sätze werden wörtlich verwendet — nicht umformulieren, nicht mit Ausrufezeichen versehen.

## Tonalität

Ruhig, warm, klar. Kurze Sätze. Konkrete Wörter statt Superlativen. Die Kundschaft wird geduzt.
Julian spricht als **„ich“**, nie als „wir“. Ehrlich bis ins Kleingedruckte: lieber ein Versprechen weniger als eines zu viel.

| So | Nicht so |
|---|---|
| Deine Vase entsteht Schicht für Schicht, in 5–8 Werktagen bei dir. | Blitzschneller Premium-Versand! |
| Feine Rippen, matt, in Salbei. | Einzigartiges Designer-Meisterwerk der Extraklasse |
| Imprägniert und in der Regel wasserdicht — eine Garantie gebe ich darauf nicht. | 100 % wasserdicht! |
| Ich prüfe jede Datei vor dem Druck. | Wir garantieren höchste Qualität. |

Wortfeld: Form, Schicht, Linie, Rippe, Welle, Kupferton, matt, gedruckt, geprüft, sorgsam, deine.
Emojis sparsam — im Shop als Bedien-Symbole, in Texten der Marke nicht.

## Farben

| Name | HEX | Rolle | Kontrast |
|---|---|---|---|
| Creme | `#f4efe7` | Grund, Flächen, Schrift auf dunklem Grund | — |
| Tinte | `#211d18` | Text, Schriftzug im Logo, dunkle Flächen | 14,6 : 1 auf Creme |
| Terrakotta | `#c86f4a` | Zeichen, Grundlinie, Knöpfe, Flächen, große Schrift | 3,2 : 1 auf Creme — nur Flächen und große Schrift |
| Terrakotta dunkel | `#9e4f2c` | Akzent-**Text** auf Creme (Links, Hervorhebungen, Signatur) | 5,1 : 1 auf Creme |
| Salbei | `#9caf88` | ruhiger Nebenakzent: Flächen, Häkchen, „erledigt“ | nie als Text auf Creme (2,1 : 1); Tinte auf Salbei 7,1 : 1 |

Faustregel: Creme und Tinte tragen, Terrakotta setzt den Akzent, Salbei beruhigt. Keine weiteren Markenfarben.

## Schriften

- **Fraunces** — Überschriften, Claim, Zitate. Warm und weich (Achsen: `font-variation-settings: 'SOFT' 60, 'WONK' 0`), Gewicht 400–500, leicht enge Laufweite (−0,02 em).
- **Inter** — Fließtext, Preise, Konfigurator, Formulare. Gewicht 400–600.
- Selbst gehostet: `public/fonts/fraunces-latin.woff2`, `public/fonts/inter-latin.woff2` (SIL OFL 1.1). Keine Google Fonts, keine CDNs.
- Rückfall: Fraunces → Georgia, serif (E-Mails setzen immer Georgia ein); Inter → system-ui, sans-serif.
- Der Schriftzug im Logo ist eine Zeichnung, **kein Text** — er wird nie mit Fraunces oder einer anderen Schrift nachgesetzt.

## Logo-Dateien

Alle Pfade haben `fill-rule="evenodd"`; die Vektoren stammen aus den eigenen Entwürfen von Julian und werden nicht neu gezeichnet.

| Datei | Was | Wann |
|---|---|---|
| `public/img/brand/formsam-logo.svg` | Wort-Bild-Marke: Vasen-Zeichen + Schriftzug + Grundlinie, Schrift in Tinte | Standard auf hellem Grund (Creme, Weiß) |
| `public/img/brand/formsam-logo-hell.svg` | dieselbe Marke, Schrift in Creme | auf dunklem Grund (Tinte, Fotos mit dunkler Fläche) |
| `public/img/brand/formsam-zeichen.svg` | Bildzeichen: Vase aus 5 Druckschichten | Profilbild, Stempel, Aufkleber, Ecken — ab 32 px |
| `public/img/brand/favicon.svg` | Zeichen mit breiteren Fugen | Browser-Tab, Lesezeichen, alles unter 32 px |
| `public/img/brand/formsam-schriftzug.svg` | nur der Schriftzug | wenn das Zeichen daneben schon steht oder zu klein würde |
| `public/img/brand/favicon-32.png`, `public/favicon.ico` | Raster-Favicons | alte Browser |
| `public/img/brand/formsam-mail.png` | Logo für E-Mails, 440 px breit | in Mails mit `width="220"` (scharf auf Retina) |
| `public/img/brand/og.jpg` | Social-Vorschau 1200 × 630 | Open Graph / Twitter Card |
| `public/img/icons/*.png` | Home-Screen- und App-Icons | Manifest, `apple-touch-icon` |

Inline-SVG im Code: Pfaddaten (viewBox-normiert, Höhe 100) in `tmp-tests/logos/trace/geom.json` des Live-Ordners
(`comboW`, `cT` = Terrakotta-Teil, `cI` = Schrift-Teil, `symW`/`symD` = Zeichen, `favW`/`favD`, `wordW`/`wD`).
Auf dunklen Flächen den Schrift-Teil in `currentColor` bzw. `#f4efe7` füllen.

## Schutzraum & Mindestgrößen

- **Schutzraum:** rundum mindestens so viel frei, wie das breiteste Schicht-Band (der „Bauch“) des Zeichens hoch ist — etwa **¼ der Logohöhe**. Dort stehen keine Texte, Kanten oder Bildränder.
- **Wort-Bild-Marke:** mindestens **24 px** hoch (Bildschirm), im Druck mindestens 8 mm.
- **Zeichen allein:** mindestens **16 px**; unter 32 px immer `favicon.svg` verwenden (breitere Fugen, sonst laufen die Schichten zu).
- Wird es kleiner, nur den Namen als Text setzen: „formsam“ in Fraunces.

## Don'ts

- Nicht verzerren, stauchen, drehen oder schräg stellen — immer proportional skalieren.
- Keine anderen Farben: Zeichen und Grundlinie bleiben Terrakotta, die Schrift Tinte (hell: Creme). Keine Verläufe.
- Schriftzug nicht nachsetzen, nicht austauschen, keine Buchstaben verändern.
- Keine Schatten, Konturen, Glanz- oder 3D-Effekte.
- Zeichen und Schriftzug in der Wort-Bild-Marke nicht neu anordnen; die Grundlinie nicht verlängern oder weglassen.
- Nicht auf unruhige Fotos ohne ruhige Fläche stellen.

## Domain, E-Mail & Handles

- Hauptadresse: **formsam.de** → `https://formsam.de` (im Admin unter E-Mail → öffentliche Shop-URL eintragen).
- Weiterleitungen (301 auf formsam.de), sobald registriert: **formsam.com**, **form-sam.de**, **formsam.eu**.
- E-Mail: **hallo@formsam.de** (Kundschaft), Absendername „formsam“.
- Social: **@formsam** auf Instagram, Pinterest und TikTok — vor dem Start sichern.

## Offene To-dos

- [ ] **Markenrecherche** (Identität und Ähnlichkeit) in DPMA-Register, EUIPO eSearch und **TMview**, Nizza-Klassen **21** (Vasen, Haushaltsgefäße), **35** (Online-Einzelhandel) und **40** (Anfertigung auf Bestellung, 3D-Druck). Nächster bekannter Nachbar: **FORMANO** — Abstand prüfen (Klang, Waren).
- [ ] **DPMA-Anmeldung** online: 290 € für bis zu 3 Klassen (jede weitere Klasse 100 €). Erst nach der Recherche.
- [ ] Domains formsam.de (läuft), formsam.com, form-sam.de, formsam.eu registrieren und weiterleiten.
- [ ] Postfach hallo@formsam.de einrichten und im Admin (Mein Unternehmen → E-Mail) eintragen.
- [ ] Handles @formsam anlegen, Profilbild und Beiträge aus dem Brand-Kit hochladen.
- [ ] Paketbeileger drucken lassen (A6, beidseitig).

## Brand-Kit

Fertige Dateien für den Alltag (nicht im Git, liegen im Arbeitsordner unter `tmp-tests/brand-kit/`):
Logos als PNG (transparent, auf Creme, auf Dunkel) und SVG, Profilbild, Social-Beitrag und Story,
Paketbeileger A6 (PDF), dieser Leitfaden als PDF, E-Mail-Signatur. Eine `LIESMICH.txt` erklärt jede Datei.
