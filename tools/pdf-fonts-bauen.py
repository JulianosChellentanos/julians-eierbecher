# Baut die sechs festen Schriftschnitte in lib/pdf-fonts/ aus den variablen Originalen neu.
#
# NUR nötig, wenn die Schriften neu erzeugt werden sollen (anderer Zeichenvorrat, neue Fassung
# der Originale). Braucht Python 3 mit fontTools (pip install fonttools) und läuft NIE auf dem
# Server – der Shop liest nur die fertigen Dateien in lib/pdf-fonts/.
#
# Originale (SIL OFL 1.1) aus github.com/google/fonts:
#   ofl/inter/Inter[opsz,wght].ttf                 → <quelle>/Inter-var.ttf
#   ofl/fraunces/Fraunces[SOFT,WONK,opsz,wght].ttf → <quelle>/Fraunces-var.ttf
# Benutzte Fassungen und Prüfsummen: lib/pdf-fonts/LIESMICH.md (Inter 4.001;git-66647c0bb, Fraunces 1.000;[b76b70a41])
#
# Aufruf: python3 tools/pdf-fonts-bauen.py <quelle-ordner> lib/pdf-fonts
# Danach: node tools/test-pdf.mjs
#
import sys, os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

quelle, ziel = sys.argv[1], sys.argv[2]
os.makedirs(ziel, exist_ok=True)

# Zeichenvorrat: Latein (inkl. erweitert), Griechisch, Kyrillisch, Satzzeichen, Währungen, gängige Symbole
BEREICHE = [(0x20, 0x7E), (0xA0, 0x24F), (0x250, 0x2AF), (0x2B0, 0x2FF), (0x370, 0x3FF), (0x400, 0x52F),
            (0x1E00, 0x1EFF), (0x2000, 0x206F), (0x2070, 0x209F), (0x20A0, 0x20BF), (0x2100, 0x214F),
            (0x2150, 0x218F), (0x2190, 0x21FF), (0x2200, 0x22FF), (0x2300, 0x23FF), (0x25A0, 0x25FF), (0x2600, 0x27BF)]
UNICODES = [c for a, b in BEREICHE for c in range(a, b + 1)]

SCHNITTE = [
    ('Inter-var.ttf',    'Inter-Regular.ttf',     {'wght': 400, 'opsz': 14}, 'Inter', 'Regular'),
    ('Inter-var.ttf',    'Inter-Medium.ttf',      {'wght': 500, 'opsz': 14}, 'Inter', 'Medium'),
    ('Inter-var.ttf',    'Inter-SemiBold.ttf',    {'wght': 600, 'opsz': 14}, 'Inter', 'SemiBold'),
    ('Inter-var.ttf',    'Inter-Bold.ttf',        {'wght': 700, 'opsz': 14}, 'Inter', 'Bold'),
    ('Fraunces-var.ttf', 'Fraunces-Medium.ttf',   {'wght': 500, 'opsz': 24, 'SOFT': 0, 'WONK': 0}, 'Fraunces', 'Medium'),
    ('Fraunces-var.ttf', 'Fraunces-SemiBold.ttf', {'wght': 600, 'opsz': 14, 'SOFT': 0, 'WONK': 0}, 'Fraunces', 'SemiBold'),
]

for src, dst, ort, familie, stil in SCHNITTE:
    f = TTFont(os.path.join(quelle, src))
    f = instancer.instantiateVariableFont(f, ort, inplace=False)
    opt = subset.Options()
    opt.layout_features = []          # keine OpenType-Ersetzungen/Kerning – der PDF-Schreiber setzt Zeichen für Zeichen
    opt.hinting = False
    opt.desubroutinize = True
    opt.notdef_outline = True
    opt.glyph_names = False
    opt.legacy_cmap = False
    opt.symbol_cmap = False
    opt.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    opt.name_languages = [0x409]
    opt.drop_tables += ['DSIG', 'GDEF', 'GPOS', 'GSUB', 'STAT', 'gasp', 'prep', 'fpgm', 'cvt ', 'MVAR', 'HVAR', 'avar', 'fvar', 'gvar', 'meta']
    s = subset.Subsetter(opt)
    s.populate(unicodes=UNICODES)
    s.subset(f)
    ps = f'{familie}-{stil}'
    for rec in f['name'].names:
        if rec.nameID == 1: rec.string = f'{familie} {stil}' if stil not in ('Regular', 'Bold') else familie
        elif rec.nameID == 2: rec.string = stil if stil in ('Regular', 'Bold') else 'Regular'
        elif rec.nameID == 4: rec.string = f'{familie} {stil}'
        elif rec.nameID == 6: rec.string = ps
    f['OS/2'].usWeightClass = int(ort['wght'])
    f['head'].macStyle = 1 if stil == 'Bold' else 0
    out = os.path.join(ziel, dst)
    f.save(out)
    g = TTFont(out)
    cm = g.getBestCmap()
    print(f"{dst:24s} {os.path.getsize(out):7d} B  glyphs {g['maxp'].numGlyphs:5d}  cmap {len(cm):5d}  upm {g['head'].unitsPerEm}  tables {' '.join(sorted(k for k in g.keys() if k != 'GlyphOrder'))}  cmapfmt {[ (t.platformID,t.platEncID,t.format) for t in g['cmap'].tables]}  locaFmt {g['head'].indexToLocFormat}")
