# 🥚 OVJU — Julians Eierbecher

**Dein Ei. Dein Design.** — Web-Konfigurator für individuell designte, 3D-gedruckte Eierbecher.

![Konfigurator](docs/screenshot-configurator.png)

## Features

- **Live-3D-Konfigurator** (Three.js): Form (Kelch / Schale / Tulpe), Höhe & Breite frei ziehbar
- **Oberflächen**: Glatt, Wellen, Rippen — mit Anzahl, Tiefe und **Drall** (→ Spiralen)
- **Gravur**: Text wird plastisch um die Becherwand gebogen (automatische Größenanpassung)
- **10 matte PLA-Farben** (Bambu-Lab-Palette, definiert in `public/content.json`)
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
- Becher steht flach auf dem Bett — einfach STL öffnen, Farbe wählen, slicen
