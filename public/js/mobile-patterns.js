// OVJU Mobil — Katalog „Oberflächen“: die neun Muster als Kacheln (Signatur Hammerschlag, Voronoi/Fjordwelle neu, sechs Swatches).
// Reine Daten + Konfig-Helfer; legt nichts an. Sheet-Texte leben hier (kein content.json-Schlüssel nötig):
// view = Überschreibungen der Vorschau-Ansicht (mobile-preview.js SWATCH_VIEW: Makro breiter bzw. ohne Makro)
// form/size/colorName = Spezifikation des gezeigten Stücks (Sheet-Zeile „Flasche · 15 cm · Salbei“, genau einmal), extra = Muster-Aufpreis, text = Charakter/Nutzen.
// Die sechs Swatches sind bewusst KEINE Ausschnitte der Formenfotos darüber: alle sechs zeigen dieselbe Vasenform (Flasche 15 cm, ganze
// Silhouette mit Schulter und Hals) in derselben Ansicht unter Streiflicht (SWATCH_VIEW) — Muster und Markenfarbe wechseln, die Form nicht.
// Gerendert einmal aus dem echten Konfigurator-Modell (mobile-home.js ↔ studio.js über ovju:world-snapshot, ohne 3D-Hero über
// mobile-preview.js); bis dahin bzw. wenn beides scheitert, steht ein Muster-Symbol in der Musterfarbe. Der Sheet-CTA öffnet genau diese Vase.
import { designConfig } from './studio-designs.js';
import { SURFACE_DESIGNS } from './surface-designs.js';

const sym = (d) => `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Muster-Symbole (Platzhalter bis zur 3D-Vorschau): Querschnitt bzw. Verlauf des Reliefs
const SVG = {
  rippen: sym('M16 84 34 16M29 84 47 16M42 84 60 16M55 84 73 16M68 84 86 16'),
  wellen: sym('M8 50q10.5-18 21 0t21 0 21 0 21 0'),
  lamellen: sym('M8 40h9v22h7V40h9v22h7V40h9v22h7V40h9v22h7V40h9'),
  zickzack: sym('m8 60 10.5-20 10.5 20 10.5-20 10.5 20 10.5-20 10.5 20 10.5-20 10.5 20'),
  querwellen: sym('M10 25q10-6 20 0t20 0 20 0 20 0M10 40q10-6 20 0t20 0 20 0 20 0M10 55q10-6 20 0t20 0 20 0 20 0M10 70q10-6 20 0t20 0 20 0 20 0'),
  glatt: sym('M38 14h24c-2 10 0 16 6 22 8 8 10 20 8 34-2 14-12 18-26 18S26 84 24 70c-2-14 0-26 8-34 6-6 8-12 6-22z'),
};
/** Gemeinsame Grundform aller Swatches: Flasche, 15 cm (Normalhöhe → kein Größenaufschlag), matt — Muster, Parameter und Farbe wechseln.
 *  Parameter bewusst kräftig (weniger, tiefere Rippen als die Formen darüber), damit sich die Muster schon in der 110-px-Kachel unterscheiden. */
const SWATCH_BASE = { product:'vase', preset:'flasche', height:150, width:1 };
const swatch = (key, name, color, colorName, hex, params, rest) => ({ key, name, tier:'swatch', svg:SVG[key], color, hex, colorName,
  size:15, form:'Flasche', config:{ ...SWATCH_BASE, pattern:key, ...params }, ...rest });

export const MOBILE_PATTERNS = [
  { key:'gehaemmert', name:'Hammerschlag', tier:'lead', image:'/img/studio/fdm-hammer-copper.webp', pos:'50% 35%', design:SURFACE_DESIGNS.hammered, size:17, colorName:'Kupfer',
    alt:'Gehämmerte Vase aus Kupfer-Silk-PLA, 3D-gedruckt mit sichtbaren Schichten',
    form:'Flasche', text:'Winzige Mulden brechen das Licht bei jedem Schritt anders — wirkt wie von Hand getrieben, fühlt sich so an.',
    chips:[
      { id:'copper', label:'Kupfer', hex:'#b87333', color:'kupfer', image:'/img/studio/fdm-hammer-copper.webp' },
      { id:'matt', label:'Matt', hex:'#efe9dc', color:'elfenbein', image:'/img/studio/fdm-hammer-matt.webp' },
      { id:'silver', label:'Silber', hex:'#c7c9cc', color:'silber', image:'/img/studio/fdm-hammer-silver.webp' },
    ] },
  { key:'skelett', name:'Voronoi', tier:'new', image:'/img/studio/fdm-voronoi.webp', design:SURFACE_DESIGNS.skeleton, sub:'Offene Zellen', size:18, colorName:'Elfenbein',
    alt:'Elfenbeinfarbene 3D-gedruckte Voronoi-Vase mit echten Zellöffnungen',
    form:'Flasche', text:'Offene Zellen und verbundene Stege — ein Schattenspiel, das mit dem Licht wandert. Für Trockenblumen und Gräser.',
    note:'Für Trockenblumen — offene Zellen halten kein Wasser' },
  { key:'koralle', name:'Fjordwelle', tier:'new', image:'/img/studio/fdm-fjord.webp', design:SURFACE_DESIGNS.coral, sub:'Fließende Rippen', size:20, colorName:'Salbei',
    alt:'Salbeifarbene 3D-gedruckte Fjordwelle-Vase mit fließenden Rippen',
    form:'Zylinder', text:'Feine Rippen folgen weiten Wellen wie Strömung im Wasser. Skulptural, aber ruhig — die Bewegung bleibt.' },
  // Eine Markenfarbe je Kachel (wie die Formen-Kacheln darüber): Terrakotta, Salbei, Elfenbein, Senf, Staubblau, Lavendel — alle ohne Farbaufpreis
  swatch('rippen', 'Rippen', 'terrakotta', 'Terrakotta', '#c86f4a', { ribs:36, depth:1.4, twist:.35 },
    { text:'Der Klassiker: feine Grate, gerade oder gedreht. Fängt Streiflicht ein und passt zu jeder Form.' }),
  swatch('wellen', 'Wellen', 'salbei', 'Salbei', '#9caf88', { ribs:14, depth:1.6, twist:0 },
    { view:{ macro:{ span:.55 } }, text:'Weiche, runde Wellen statt scharfer Grate — sanft, freundlich, angenehm in der Hand.' }),
  swatch('lamellen', 'Lamellen', 'elfenbein', 'Elfenbein', '#efe9dc', { ribs:26, depth:3, twist:0 },
    { extra:'+ 3 €', text:'Tiefe Plissee-Schlitze wie bei Design-Vasen aus dem Laden — mit Schatten, die die Silhouette betonen.' }),
  swatch('zickzack', 'Zickzack', 'senf', 'Senf', '#d4a940', { ribs:24, depth:1.6, twist:0 },
    { text:'Scharfe Facetten, klare Kanten — grafisch und architektonisch. Wirkt besonders in kräftigen Farben.' }),
  swatch('querwellen', 'Querwellen', 'staubblau', 'Staubblau', '#7d9bb0', { ribs:40, depth:1.6, twist:0 },
    { text:'Ruhige, weiche Ringe — wirkt wie gedrechselt und passt zu runden Formen. Kein Grat, nur Rhythmus.' }),
  swatch('glatt', 'Glatt', 'lavendel', 'Lavendel', '#a58fb8', {},
    { view:{ macro:false }, text:'Ganz ohne Struktur — die reine Silhouette und feine Druckschichten. Am besten mit Gravur oder in Seidenglanz.' }),
];

/** Vollständige Konfigurator-Vorgabe eines Musters (preset, pattern, ribs, depth, twist, color, studioTab) — optional mit anderer Farbe (Finish-Chip) */
export function patternConfig(p, color) {
  const base = p.design ? designConfig(p.design) : { ...p.config, color:p.color, text:'', saucer:false };
  return { ...base, color: color || base.color, studioTab:'muster' };
}

export const patternByKey = (key) => MOBILE_PATTERNS.find((p) => p.key === key);
