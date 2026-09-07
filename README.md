# 🥚 OVJU — Julians Eierbecher

**Dein Ei. Dein Design.** — Web-Konfigurator für individuell designte, 3D-gedruckte **Eierbecher und Vasen**.

![Konfigurator](docs/screenshot-configurator.png)
![Vase](docs/screenshot-vase.png)
![Formen-Editor](docs/screenshot-editor.png)

## Studio-Redesign

Interaktive 3D-Formenwelt mit sechs direkt übernehmbaren Entwürfen, Live-Silhouetteneditor, KI-Produktfotos auf Basis der tatsächlichen Modelle, Scroll-Animationen, Darkmode und responsivem Layout. Die Szenen pausieren außerhalb des Sichtbereichs und respektieren reduzierte Bewegung. Gestaltung und Bildherkunft: [docs/studio-redesign.md](docs/studio-redesign.md).

## Oberflächen & Szenen

15 neu generierte FDM-Motive: sechs Formenkarten, vier Kampagnenszenen, drei Hammerschlag-Nahaufnahmen sowie Voronoi und Fjordwelle. Alle Materialien zeigen horizontale Druckschichten, auch glänzendes und metallisch schimmerndes PLA. Optimierte WebP-Dateien werden auf der Website verwendet; die PNG-Originale und exakten Prompts sind unter [Bilder und Prompts](docs/generated-scenes.md) dokumentiert.

**Voronoi** ersetzt Exoskelett: Vasen erhalten echte unregelmäßige Zellöffnungen mit verbundenen Stegen, stabilem Fuß und geschlossenem Rand. Eierbecher behalten eine geschlossene Ei-Mulde und zeigen das Muster als Relief. Gravuren erhalten eine geschlossene Auflage. Prüfung: `node tools/check-skeleton.mjs` und `node tools/check-voronoi-topology.mjs`.

**Fjordwelle** ersetzt Koralle: feine geschwungene Rippen auf weiten Wellen. Die Oberfläche bleibt geschlossen; Tiefe bis 6 mm bei Vasen, bis 1 mm bei Eierbechern. Prüfung: `node tools/check-coral.mjs`.

Die gespeicherten Muster-IDs `skelett` und `koralle` bleiben kompatibel, laden aber die neuen Geometrien. Alle bisherigen Konfigurator-Funktionen sind verfügbar. Die sieben ursprünglichen Muster bleiben geometrisch unverändert. Ein physischer Probedruck der neuen Muster steht aus; bei Voronoi sind Brücken und gegebenenfalls Stützen im Slicer zu prüfen.

## Features

- **Zwei Produktwelten, Vase zuerst**: Vasen (Flasche/Kugel/Tropfen/Zylinder/Kurve) als Hero-Produkt, Eierbecher (Kelch/Schale/Tulpe) als passendes Geschwisterstück; Höhe & Breite frei ziehbar
- **Formen-Editor „Eigene"**: Silhouetten-Punkte per Drag ziehen — komplett eigene Formen
- **Oberflächen**: Glatt, Rippen, Wellen, **Lamellen** (tiefe Plissee-Schlitze bis 6 mm, Iconic-Home-Look), Zickzack (Facetten), Querwellen, **Gehämmert** (gejittertes Kugelkalotten-Gitter mit Facettenkanten — wie handgehämmertes Metall, reproduzierbar) , **Voronoi** und **Fjordwelle** — mit Anzahl, Tiefe und **Verlauf**: Spirale, Gegenläufig (V-Optik), Wellenfluss (schlängelnde Rippen) oder Zickzack, jeweils mit Stärke und Anzahl Richtungswechsel. Ästhetik-Klemmen (aus einem Multi-Agent-Design-Review abgeleitet) halten jede Kombination kontrolliert: Rippenlinien-Neigung ≤ 55–62°, Tiefe an Rippenzahl gekoppelt, Wechselzahl an Rippendichte/Höhe gekoppelt, Muster laufen an den Rändern sauber aus. Mesh-Ringe drehen mit dem Verlauf mit und die Auflösung ist ein ganzzahliges Vielfaches der Rippenzahl → Gratspitzen liegen auf jedem Ring exakt auf einem Vertex (keine „Perlenketten“ bei Drall)
- **Größenaufschlag**: Preis wächst mit dem Volumen relativ zur Normalgröße (relVol = Höhe/Normalhöhe × Breite²; %- und €-Satz im Admin einstellbar, live im Konfigurator sichtbar, Server rechnet verbindlich)
- **Gravur**: zuschaltbares Extra (Aufpreis im Admin einstellbar, Standard 3 €), 7 Schriftarten (inkl. „Edel" Marcellus & „Kalligrafie" Great Vibes, OFL → Lizenzen in docs/LICENSES.md), Größe & Höhen-Position einstellbar; der Text folgt der Silhouette (Taille/Bauch) und wird um die Wand gebogen
- **16 PLA-Farben mit Finishes**: matt (Bambu-Matte-Palette), glänzend (Glossy) und metallic/Silk (Gold, Silber, Kupfer, Perlmutt) — Finish pro Farbe im Admin einstellbar, gerendert mit MeshPhysicalMaterial (Clearcoat/Metalness) + RoomEnvironment-Reflexionen im Studio
- **Galerie & Produktfotos**: Im Admin (🖼️ Bilder) hochgeladene Fotos erscheinen sofort in der „Zuhause bei OVJU“-Galerie; Fotos der Kategorie Eierbecher/Vase ersetzen die Render-Bilder der Produktkarten
- **Szenen-Vorschau**: Studio + 4 fotoreale CC0-HDRI-Szenen von Poly Haven (Esstisch mit echter Holztisch-Textur, Fensterbrett mit Ausblick, Café, Abend) — Environment-Beleuchtung, Ei im Becher bzw. Trockengräser in der Vase
- **📸 Foto-Shooting**: rendert das aktuelle Design in 4 Szenen als speicherbare PNGs
- **Untersetzer-Extra** (+4,90 €): Schale mit Sitz-Mulde für den Becher, fängt Eierschalen auf; wandert als zweites Teil mit in die STL (nebeneinander auf dem Bett)
- **STL-Export** direkt im Browser: binär, Millimeter, **wasserdicht/manifold** — slicebar in Bambu Studio, PrusaSlicer & Co.
- **Shop-System**: Warenkorb mit konfigurierbaren **Mengenrabatten** (gleiches Design mehrfach → z. B. −35 % ab 4 Stück), Checkout mit Lieferadresse, **Rechnungserstellung** (Firmendaten, § 19 UStG oder USt, fortlaufende Nummern), Vorkasse + **PayPal-Anbindung** (REST, Sandbox/Live — nur Zugangsdaten eintragen)
- **Admin-Zentrale** (`/admin`, Standard-Passwort `ovju-admin` — bitte ändern!):
  - 📊 Dashboard: Umsatz (gesamt/30 Tage), offene Drucke, Ø Bestellwert, meistbestellte Farben & Produkte
  - 📦 Bestellungen: Suche & Status-Filter, aufklappbare Details, Sendungsnummer, interne Notizen, E-Mail-Vorlagen (Zahlungserinnerung/Druckstart/Versand), CSV-Export
  - 🎨 Filament-Farben: einpflegen/deaktivieren/löschen mit Farbwähler & Bestandsnotiz — wirkt sofort auf die Farbauswahl im Konfigurator
  - 💰 Preise & Mengenrabatt-Stufen, 🎟️ Gutscheine (%- oder €-Codes, Mindestbestellwert)
  - 🏢 Firma (Rechnungsdaten), 💙 PayPal, ⚙️ Passwort & JSON-Backup — alles in `data/settings.json` (nicht im Git)
- **Kundenkonten**: Registrierung/Login (scrypt-gehashte Passwörter, Sessions in `data/`), Bestellhistorie mit Status & Rechnungen, Standard-Lieferadresse mit Checkout-Vorbefüllung
- **Mobile App-Shell** (≤ 980 px): klebende 3D-Bühne + Tab-Leiste (Form/Muster/Gravur/Farbe/Extras, mit 🎲) statt Endlos-Scroll, Swipe zwischen Tabs, angedockte Bottom-Bar mit Live-Preis & Warenkorb, Vollbild-3D, Bottom-Sheet-Dialoge, Toasts, Haptik, animierte Preise; Layout per Multi-Device-UX-Panel (4 Geräte × 8 Screens) geprüft
- **PWA**: Manifest, Service Worker (Cache-First für Assets, offline-Fallback), Install-Banner „OVJU als App installieren" (Android) bzw. iOS-Hinweis, Home-Screen-Icons, Theme-Color folgt dem Darkmode
- **Darkmode**: Umschalter im Header (🌙/☀️), merkt sich die Wahl, folgt sonst der Systemeinstellung
- **Druckbarkeits-Ampel**: analysiert live die Flächennormalen des Meshes (Überhangwinkel) — ✅/⚠️/🔶 direkt im Konfigurator; Querwellen werden serverseitig auf druckbare Wellenlängen/Tiefen geklemmt (`tools/check-printability.mjs` für Offline-Analysen)
- **Rechtliche Produkthinweise** an fünf Stellen (Konfigurator bei Vase & Eigener Form, Checkout, FAQ, Footer, Rechnung): Trockenblumen-Zweck, imprägniert/i. d. R. wasserfest ohne Gewähr, keine Standfestigkeits-Garantie bei freien Formen, pflanzenbasiertes PLA
- Kein Build-Schritt, keine Runtime-Dependencies — alles lokal gevendort (Three.js, Fonts)

## Starten

```bash
node server.js          # → http://localhost:4488
```

| Route | Zweck |
|---|---|
| `/` | Landingpage + Konfigurator |
| `/admin` | Admin: Bestellungen, Status, Einstellungen (Passwort: `ovju-admin`) |
| `/api/pricing`, `/api/quote` | Preise & Rabatte (Server = einzige Preisquelle) |
| `/api/checkout` + STL-Upload | Warenkorb-Bestellung anlegen, Modelle binär hochladen, Rechnung erzeugen |
| `/api/paypal/*` | PayPal-Order anlegen/einziehen (aktiv, sobald Zugangsdaten hinterlegt) |

## Struktur

```
server.js                  Node-HTTP-Server (Port 4488, keine Dependencies)
public/
  index.html               Landing + Konfigurator
  css/style.css            Design (warm-minimal, Fraunces/Inter lokal)
  js/geometry.js           Parametrische Becher-Geometrie (manifold, mm)
  js/exporter.js           Binärer STL-Export
  js/app.js                3D-Szene, UI, Bestellflow
  content.json             Texte, Farben, Preise (Marketing)
  vendor/, fonts/          Three.js r160 + Schriften, lokal
orders/                    Eingegangene Bestellungen (nicht im Git)
tools/
  check-stl.mjs            STL-Validator (watertight, Volumen, BBox …)
  generate-stl.mjs         STL per CLI erzeugen (Tests/Repro)
docs/marketing.md          Marketing-Plan (Positionierung, Pricing, Social)
```

## Qualitätssicherung

```bash
npm run setup   # einmalig: three-Symlink für die CLI-Tools
npm run check   # erzeugt Referenz-STL und validiert sie
node tools/check-stl.mjs orders/<ID>/<datei>.stl   # Bestellung prüfen
```

Der Validator prüft: Dateikonsistenz, degenerierte Dreiecke, NaN, Bounding Box,
Watertightness (jede Kante exakt gepaart) und positives Volumen.

## Druckbarkeit der Muster (gemessen mit tools/check-printability.mjs)

Bewertung (UI-Ampel und `tools/check-printability.mjs`): **Silhouette** (Grundform) streng — >50° ⚠️, >62° ❌;
**Muster-Flanken** sind selbsttragende Mikro-Features (Tiefe ≤ 1,6 mm < 2-mm-Faustregel) und höchstens ⚠️.
Querwellen werden zusätzlich serverseitig auf druckbare Wellenlänge/Amplitude geklemmt.

## Druck-Empfehlung (Bambu Studio)

- Material: **PLA matt**, Schichthöhe 0.16–0.20 mm
- Ausgangspunkt: 3 Wandlinien, 10–15 % Infill. Stützenbedarf hängt von der gewählten Form ab; Voronoi-Öffnungen separat prüfen.
- Becher/Vase stehen flach auf dem Bett — einfach STL öffnen, Farbe wählen, slicen
- Vasen außer Voronoi sind geschlossene Hohlkörper (2,2 mm Wand + Musterzugabe + Boden) — normal slicen, kein Vasenmodus nötig
- Voronoi ist offen: Trockenblumen oder passender Einsatz. Brücken und Stützen im Slicer prüfen.
