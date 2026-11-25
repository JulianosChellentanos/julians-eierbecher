# Schriften für die PDF-Belege

Diese sechs Dateien bettet `lib/pdf.js` (als Teilmenge) in die PDF-Belege ein.
Sie werden nur vom Server gelesen und nie an den Browser ausgeliefert.

| Datei | Schnitt |
|---|---|
| `Inter-Regular.ttf` | Inter 400, opsz 14 |
| `Inter-Medium.ttf` | Inter 500, opsz 14 |
| `Inter-SemiBold.ttf` | Inter 600, opsz 14 |
| `Inter-Bold.ttf` | Inter 700, opsz 14 |
| `Fraunces-Medium.ttf` | Fraunces 500, opsz 24, SOFT 0, WONK 0 |
| `Fraunces-SemiBold.ttf` | Fraunces 600, opsz 14, SOFT 0, WONK 0 |

**Herkunft:** die variablen Originalschriften aus github.com/google/fonts
(`ofl/inter` und `ofl/fraunces`). Daraus sind die festen Schnitte oben erzeugt –
mit `tools/pdf-fonts-bauen.py` (braucht Python + fontTools, läuft nie auf dem Server).

Benutzte Fassung der Originale (Versionsangabe aus der name-Tabelle, SHA-256 der Datei):

| Original | Fassung | SHA-256 |
|---|---|---|
| `Inter[opsz,wght].ttf` | Version 4.001;git-66647c0bb | `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031` |
| `Fraunces[SOFT,WONK,opsz,wght].ttf` | Version 1.000;[b76b70a41] | `177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb` |

**Zeichenvorrat:** Latein inkl. Erweiterungen, Griechisch, Kyrillisch, Satzzeichen,
Währungen und gängige Symbole (Pfeile, Mathematik, Formen) – jeweils so weit das
Original sie enthält. Fraunces hat kein Griechisch und kein Kyrillisch; dafür gibt
es in `lib/pdf.js` die Schriftkette (Fraunces → Inter).

**Bewusst weggelassen:** Hinting und OpenType-Layout (GSUB/GPOS/GDEF). Der
PDF-Schreiber setzt Zeichen für Zeichen, ohne Ligaturen und ohne Unterschneidung.

**Lizenz:** SIL Open Font License 1.1 – `OFL-Inter.txt` und `OFL-Fraunces.txt`.
Beide Schriften haben keinen „Reserved Font Name“; die Namen dürfen also auch für
die abgeleiteten Schnitte bleiben. Die Lizenztexte gehören zu den Dateien und
müssen bei einer Weitergabe mit.
