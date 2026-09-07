import { SURFACE_DESIGNS } from './surface-designs.js';
import { designConfig } from './studio-designs.js';
const $=s=>document.querySelector(s);
const finishes={copper:{color:'kupfer',name:'Kupfer',description:'PLA mit metallischem Schimmer in Kupfer-Optik.'},matt:{color:'elfenbein',name:'Elfenbein matt',description:'Mattes PLA in Elfenbein. Ruhig, weich und skulptural.'},silver:{color:'silber',name:'Silber',description:'PLA mit metallischem Schimmer in Silber-Optik.'}};
let selected='copper';
for(const button of document.querySelectorAll('[data-finish-preview]'))button.addEventListener('click',()=>{
 selected=button.dataset.finishPreview;const f=finishes[selected];const src=`/img/studio/fdm-hammer-${selected}.webp`;
 const img=$('#finish-image');img.src=src;img.alt=`3D-gedruckte Hammerschlag-Oberfläche in ${f.name} mit sichtbaren Filamentschichten`;img.closest('[data-view-image]').dataset.viewImage=src;
 $('#finish-description').textContent=f.description;
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
