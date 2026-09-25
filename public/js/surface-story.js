import { SURFACE_DESIGNS } from './surface-designs.js';
import { designConfig } from './studio-designs.js';
const $=s=>document.querySelector(s);
const finishes={copper:{color:'kupfer',name:'Kupfer',description:'PLA mit metallischem Schimmer in Kupfer-Optik.'},matt:{color:'elfenbein',name:'Elfenbein matt',description:'Mattes PLA in Elfenbein. Ruhig, weich und skulptural.'},silver:{color:'silber',name:'Silber',description:'PLA mit metallischem Schimmer in Silber-Optik.'}};
let selected='copper';
// Handy (≤ 700 px): Das Kupfer-Close-up ist schon das Cover – hier zeigt „Kupfer“ die Abendlicht-Szene (gehämmerte Kupfervase neben Graphit),
// Matt/Silber bleiben die Nahaufnahmen. Desktop: unverändert fdm-hammer-copper. Die <source> im HTML liefert den Startzustand ohne JS.
const SMALL=matchMedia('(max-width:700px)').matches;
const SCENE_ALT='Gehämmerte Vase aus Kupfer-Silk-PLA neben einer gerippten Graphitvase im Abendlicht, beide 3D-gedruckt';
function showFinish(){
 const f=finishes[selected];const scene=SMALL&&selected==='copper';const src=scene?'/img/studio/fdm-evening.webp':`/img/studio/fdm-hammer-${selected}.webp`;
 const img=$('#finish-image'),source=$('#finish-source');if(source)source.srcset=src;img.src=scene?'/img/studio/fdm-hammer-copper.webp':src;
 img.alt=scene?SCENE_ALT:`3D-gedruckte Hammerschlag-Oberfläche in ${f.name} mit sichtbaren Filamentschichten`;img.closest('[data-view-image]').dataset.viewImage=src;
 img.closest('.surface-visual').dataset.shot=scene?'scene':'detail';
}
if(SMALL&&getComputedStyle($('#oberflaechen')).display!=='none')showFinish(); // Alt-Text + Lightbox-Bild passend zur <source> — nicht, wenn die Story auf dem Handy ausgeblendet ist (mobile.css)
for(const button of document.querySelectorAll('[data-finish-preview]'))button.addEventListener('click',()=>{
 selected=button.dataset.finishPreview;showFinish();
 $('#finish-description').textContent=finishes[selected].description;
 document.querySelectorAll('[data-finish-preview]').forEach(b=>{const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
});
function use(design){window.dispatchEvent(new CustomEvent('ovju:studio-design',{detail:{...designConfig(design),studioTab:'muster'}}));}
$('#hammer-use').addEventListener('click',()=>use({...SURFACE_DESIGNS.hammered,color:finishes[selected].color}));
$('#skeleton-use').addEventListener('click',()=>use(SURFACE_DESIGNS.skeleton));
$('#coral-use').addEventListener('click',()=>use(SURFACE_DESIGNS.coral));
const dialog=$('#scene-lightbox');
for(const button of document.querySelectorAll('[data-view-image]'))button.addEventListener('click',()=>{const image=button.querySelector('img');dialog.querySelector('img').src=button.dataset.viewImage;dialog.querySelector('img').alt=image.alt;dialog.querySelector('p').textContent=image.alt;dialog.showModal();});
dialog.querySelector('button').addEventListener('click',()=>dialog.close());
dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
// Kupfer bleibt auf allen Geräten der Start-Finish (gleiche Stimmung wie Cover und Desktop).
