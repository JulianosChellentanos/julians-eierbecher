# 🥚 OVJU — Julians Eierbecher

**Dein Ei. Dein Design.** — Web-Konfigurator für individuell designte, 3D-gedruckte **Eierbecher und Vasen**.

![Konfigurator](docs/screenshot-configurator.png)
![Vase](docs/screenshot-vase.png)
![Formen-Editor](docs/screenshot-editor.png)

## Features

- **Zwei Produktwelten**: Eierbecher (Kelch/Schale/Tulpe) und Vasen (Flasche/Kugel/Tropfen/Zylinder/Kurve), Höhe & Breite frei ziehbar
- **Formen-Editor „Eigene"**: Silhouetten-Punkte per Drag ziehen — komplett eigene Formen
- **Oberflächen**: Glatt, Rippen, Wellen, Zickzack (Facetten), Querwellen — mit Anzahl, Tiefe und **Drall** (→ Spiralen / diagonale Wellen)
- **Gravur**: 5 Schriftarten, Größe & Höhen-Position einstellbar; der Text folgt der Silhouette (Taille/Bauch) und wird um die Wand gebogen
- **10 matte PLA-Farben** (Bambu-Lab-Palette, definiert in `public/content.json`)
- **Szenen-Vorschau**: Studio, Frühstückstisch & Abendlicht (prozedural, kein Bildmaterial) — mit Ei im Becher bzw. Trockengräsern in der Vase
- **📸 Foto-Shooting**: rendert das aktuelle Design in 4 Szenen als speicherbare PNGs
- **Untersetzer-Extra** (+4,90 €): Schale mit Sitz-Mulde für den Becher, fängt Eierschalen auf; wandert als zweites Teil mit in die STL (nebeneinander auf dem Bett)
- **STL-Export** direkt im Browser: binär, Millimeter, **wasserdicht/manifold** — slicebar in Bambu Studio, PrusaSlicer & Co.
- **Bestellsystem**: Bestellung inkl. druckfertiger STL landet in `orders/<ID>/`, Admin-Übersicht mit Download
- Kein Build-Schritt, keine Runtime-Dependencies — alles lokal gevendort (Three.js, Fonts)

## Starten

```bash
node server.js          # → http://localhost:4488
```

| Route | Zweck |
|---|---|
| `/` | Landingpage + Konfigurator |
| `/admin` | Bestellübersicht + STL-Downloads (für den Betreiber) |
| `/api/order` (POST) | Bestellung annehmen (JSON + STL als base64) |
| `/api/orders` | Bestellungen als JSON |

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

## Druck-Empfehlung (Bambu Studio)

- Material: **PLA matt**, Schichthöhe 0.16–0.20 mm
- 3 Wandlinien, 10–15 % Infill, kein Support nötig (Mulde ≤ 45°)
- Becher/Vase stehen flach auf dem Bett — einfach STL öffnen, Farbe wählen, slicen
- Vasen sind geschlossene Hohlkörper (2,2 mm Wand + Boden) — normal slicen, kein Vasenmodus nötig
