# OVJU — Form follows you

The landing page presents five available vase presets plus a custom silhouette. Every design is defined in `public/js/studio-designs.js` and built with the same `buildModel` geometry used by the configurator and STL export.

## Interactive experiences

- Three actual models on an animated 3D stage, six selectable designs, orbit controls, explicit motion pause.
- Six design cards with generated photographs based on production model renders. Each card loads the corresponding shape, dimensions, pattern and color into the configurator.
- Live silhouette editor with draggable points and an accessible waist slider. Transfers the current custom points to the full configurator.
- The primary hero action opens the custom shape editor.
- Offscreen/hidden scenes pause, reduced motion disables automatic rotation, generated model photographs provide a WebGL fallback.

## Product images

The fifteen active marketing assets use imagegen with production model renders as geometry references. Every prompt requires visible horizontal FDM layer lines on matte, glossy and silk PLA. The originals are `public/img/studio/fdm-*.png`; the website serves compressed WebP equivalents. All outputs were inspected for shape and manufacturing texture. See [generated-scenes.md](generated-scenes.md) for every asset and exact prompt. These are clearly identified as AI product photographs; the live model is authoritative.

Deterministic source renders remain at `real-*.jpg` and `scene-*.jpg`, generated with `studio-scene.js` and `editorial-scenes.js`. They are reference assets, not the current campaign photography. Admin-uploaded photographs remain under the existing gallery controls.

## Verification

`node tools/check-studio-designs.mjs` generates each marketed model through the production STL generator and validates manifoldness and printability. It removes only its own temporary test directory. Physical print calibration and arbitrary user edits still require the configurator's printability assessment.

Browser checks pass at 1440 px and 390 px: all fifteen campaign assets load, both pattern actions select the correct configuration, depth stays synchronized when switching patterns, the custom editor and engraving remain available, all sixteen colors are present, the egg-cup saucer works, all three finish images switch, and the lightbox closes with Escape. No JavaScript errors or horizontal overflow were found. Earlier checks also covered custom profile transfer and cart behavior.

## Surface stories

The hammered feature switches between copper-silk, matte ivory and silver-silk material macro photographs. Its action transfers the corresponding available filament color to the configurator. Native dialogs enlarge all campaign and feature images.

Two independently implemented parametric patterns were added (IDs `skelett` and `koralle`):

- Voronoi (`skelett`): a periodic jittered cell field cuts actual holes through the vase wall. A shared triangulated grid is clipped once and extruded into outer/inner skins, joined along every hole edge. Stable foot/rim and a text support patch keep it one connected solid. Egg cups retain a closed cellular relief. Depth adjusts relief and web width; count adjusts cell density. The live print badge asks for slicer bridge/support checks.
- Fjordwelle (`koralle`): broad travelling radial waves carry fine curved ribs. The ring phase tracks the ribs to avoid sampling artifacts. Vase amplitude is capped at 6 mm and egg-cup amplitude at 1 mm. Bottom/rim fade preserves the base and opening.

The visual references supplied by the user were inspected via their publicly linked preview images: [Voronoi vase by Chua](https://makerworld.com/de/models/1531566-voronoi-vase) and [Fjord Wave by Ikigaiform](https://makerworld.com/de/models/2970473-the-fjord-wave-flower-vase-modern-japandi-design). No third-party STL is included; the new models are independently parameterized interpretations.

`check-skeleton.mjs` and `check-coral.mjs` each validate thirteen configurations, including custom profiles, extreme flows and egg cups. `check-voronoi-topology.mjs` checks orientation, manifoldness, connectedness and actual through-holes at three preview/export resolutions, three densities and with all engraving styles. The original seven patterns were compared against HEAD: position/index arrays match exactly in fourteen vase/egg configurations. These are digital tests; physical test prints remain necessary. In particular, manifold describes a closed solid boundary, not a water-holding Voronoi vase.

## Creative configurator UI

`public/css/configurator-studio.css` unifies the preview and panel, adds numbered tabs, larger silhouette controls, clearer sliders and revised purchase controls. All existing control IDs, ranges (except ranges for newly added patterns), features and model settings remain available. The presentation change does not replace the printing or checkout engine.

