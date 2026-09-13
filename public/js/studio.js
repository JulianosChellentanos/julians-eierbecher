import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { buildModel } from './geometry.js';
import { STUDIO_DESIGNS, designConfig, designImage } from './studio-designs.js';
import { makeStudio, makeObject } from './studio-scene.js';
const $=s=>document.querySelector(s);
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const SMALL=matchMedia('(max-width:700px)').matches; // Handy-Layout: Cover + Formenwelt-Karte; Desktop bleibt unverändert
const go=config=>window.dispatchEvent(new CustomEvent('ovju:studio-design',{detail:config}));
const observer=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');observer.unobserve(e.target);}}),{threshold:.06});
for(const el of document.querySelectorAll('.collection-heading,.lab-copy,.editorial-copy,.studio-heading')){if(!motion.matches){el.classList.add('reveal');observer.observe(el);}}
$('#design-grid').innerHTML=STUDIO_DESIGNS.map((d,i)=>`<button class="design-card" data-design="${i}" aria-label="${d.name} im Konfigurator weitergestalten"><div class="design-image"><img src="${designImage(d)}" alt="${d.description}, KI-Produktfotografie auf Basis des 3D-Modells" loading="${SMALL&&i<2?'eager':'lazy'}" width="800" height="900"><span class="design-number">0${i+1}</span><span class="design-arrow">↗</span></div><div class="design-title"><h3>${d.name}</h3><span>${d.config.height/10} cm</span></div><p>${d.description}</p></button>`).join('');
document.querySelectorAll('[data-design]').forEach(b=>b.addEventListener('click',()=>go(designConfig(STUDIO_DESIGNS[+b.dataset.design]))));
// Handy-Wischreihen: Text nur auf der eingerasteten Karte (≥ 70 % sichtbar) – die angeschnittene Nachbarkarte blitzt nur mit ihrem Bild an, kein mitten im Wort abgeschnittener Fließtext
if(SMALL)for(const row of document.querySelectorAll('.pattern-pair,.scene-journal-grid')){row.classList.add('rail-js');const io=new IntersectionObserver(es=>es.forEach(e=>e.target.classList.toggle('rail-current',e.intersectionRatio>=.7)),{root:row,threshold:[.7]});for(const c of row.children)io.observe(c);}
// Formenreihe (#formen): Karten sind schmaler (58 %), also sind oft zwei zu ≥ 70 % sichtbar – „aktuell“ ist die eingerastete Karte am linken Rand;
// die Nachbarkarten bleiben lesbar (Text nur abgedunkelt), darunter zählt „1 / 9“ mit.
if(SMALL){const row=$('#design-grid'),count=$('#design-count');row.classList.add('rail-js');let cur=-1,tick=false;const sync=()=>{tick=false;const cards=row.children;if(!cards.length)return;const x0=row.getBoundingClientRect().left+parseFloat(getComputedStyle(row).scrollPaddingLeft||0);let best=0,bd=1e9;for(let i=0;i<cards.length;i++){const d=Math.abs(cards[i].getBoundingClientRect().left-x0);if(d<bd){bd=d;best=i;}}if(best===cur)return;cur=best;for(let i=0;i<cards.length;i++)cards[i].classList.toggle('rail-current',i===cur);if(count)count.textContent=`${cur+1} / ${cards.length}`;};row.addEventListener('scroll',()=>{if(!tick){tick=true;requestAnimationFrame(sync);}},{passive:true});sync();}
$('#hero-shapes').innerHTML=STUDIO_DESIGNS.map((d,i)=>`<button data-shape="${i}" aria-pressed="${i===0}" class="${i===0?'active':''}">${d.name}</button>`).join('');
let index=0,paused=motion.matches,chooseScene=()=>{};
function select(i){index=(i+STUDIO_DESIGNS.length)%STUDIO_DESIGNS.length;const d=STUDIO_DESIGNS[index];$('#hero-index').textContent=`${String(index+1).padStart(2,'0')} / ${String(STUDIO_DESIGNS.length).padStart(2,'0')}`;$('#hero-design-name').textContent=d.name;$('#hero-design-detail').textContent=d.description;document.querySelectorAll('[data-shape]').forEach(b=>{const on=+b.dataset.shape===index;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});chooseScene();window.dispatchEvent(new CustomEvent('ovju:hero-select',{detail:STUDIO_DESIGNS[index]}));}
$('#hero-prev').addEventListener('click',()=>select(index-1));$('#hero-next').addEventListener('click',()=>select(index+1));document.querySelectorAll('[data-shape]').forEach(b=>b.addEventListener('click',()=>select(+b.dataset.shape)));
$('#hero-use').addEventListener('click',()=>go(designConfig(STUDIO_DESIGNS[index])));
function syncPause(){const b=$('#motion-toggle');b.textContent=SMALL?(paused?'▷':'Ⅱ'):(paused?'▷ Bewegung starten':'Ⅱ Bewegung pausieren');b.setAttribute('aria-label',paused?'Automatische Bewegung starten':'Automatische Bewegung pausieren');b.setAttribute('aria-pressed',String(paused));}
$('#motion-toggle').addEventListener('click',()=>{paused=!paused;syncPause();});motion.addEventListener('change',()=>{paused=motion.matches;syncPause();});syncPause();
window.dispatchEvent(new CustomEvent('ovju:hero-select',{detail:STUDIO_DESIGNS[index]})); // Startzustand für den Live-Preis im Formenwelt-Knopf
const art=$('#hero-art');
// Handy: Das Fallback-Foto der Formenwelt soll nicht mit dem Cover um den ersten Paint konkurrieren – der Preload-Scanner sieht nur die Mini-<source>;
// erst jetzt (Cover-Anfrage läuft bereits) wird die <source> entfernt und das Foto mit niedriger Priorität geladen. Desktop: <source> greift nicht, alles wie bisher.
if(SMALL){const fb=$('.hero-fallback');fb.fetchPriority='low';fb.parentElement.querySelector('source')?.remove();}
// Formenwelt-3D: auf dem Handy erst erzeugen, wenn die Karte zu ≥ 25 % sichtbar ist (bis dahin Fallback-Foto); Desktop sofort wie bisher
function initWorld(){
try{
 const studio=makeStudio($('#hero-viewer'),{transparent:true,shadowSize:SMALL?512:1024});const {renderer,scene,camera}=studio;
 renderer.setPixelRatio(Math.min(devicePixelRatio,SMALL?1.25:1.5));
 const controls=new OrbitControls(camera,$('#hero-viewer'));$('#hero-viewer').style.touchAction='pan-y'; // vertikales Wischen scrollt die Seite, horizontales dreht
 controls.enableZoom=false;controls.enablePan=false;controls.enableDamping=true; // Rad/Pinch zoomen nicht (sonst hängt das Scrollen über der Bühne); Kameraziel und Drehgrenzen am Desktop bewusst wie bisher
 if(SMALL){controls.enableZoom=false;controls.enablePan=false;controls.enableDamping=true;controls.minAzimuthAngle=-.45;controls.maxAzimuthAngle=.45;controls.minPolarAngle=.95;controls.maxPolarAngle=1.45;} // Handy: kein Zoom/Pan, begrenzte Drehwinkel (Bildausschnitt bleibt)
 camera.position.set(0,190,650);controls.update();
 if(SMALL){camera.position.y=150;controls.update();} // Handy: etwas flacherer Blick auf die Karte
 const meshes=new Array(STUDIO_DESIGNS.length).fill(null);let target=[],inView=true,started=false,last=performance.now(),phase=0,dirty=true;
 // Mesh erst bauen, wenn es gebraucht wird (Handy: 3 beim Start, Rest im Leerlauf) – Position sofort aus target, sonst sichtbares Lerp von 0/0/0
 const ensure=i=>{i=(i+meshes.length)%meshes.length;if(meshes[i])return;const m=makeObject(STUDIO_DESIGNS[i],SMALL?.45:.55);const t=target[i];if(t){m.position.set(t.x,0,t.z);m.scale.setScalar(t.s);m.visible=t.s>.005;}scene.add(m);meshes[i]=m;dirty=true;};
 chooseScene=()=>{target=meshes.map((m,i)=>{const delta=(i-index+meshes.length)%meshes.length;return delta===0?{x:0,z:45,s:1,r:0}:delta===1?{x:153,z:-35,s:.85,r:-.3}:delta===meshes.length-1?{x:-153,z:-35,s:.85,r:.3}:{x:0,z:-150,s:0,r:0};});if(SMALL){ensure(index-1);ensure(index);ensure(index+1);}if(!started||motion.matches){meshes.forEach((m,i)=>{if(!m)return;const t=target[i];m.position.set(t.x,0,t.z);m.scale.setScalar(t.s);});started=true;}};
 if(!SMALL)STUDIO_DESIGNS.forEach((_,i)=>ensure(i));
 chooseScene();
 if(SMALL){const idle=window.requestIdleCallback||(f=>setTimeout(f,300));let k=0;const fill=()=>{while(k<meshes.length&&meshes[k])k++;if(k<meshes.length){ensure(k);idle(fill);}};idle(fill);}
 // Maßquelle: auf dem Handy der Canvas (die Karte ist höher als der Canvas), sonst die ganze Bühne
 const resize=()=>{const box=SMALL?$('#hero-viewer'):art;const w=box.clientWidth,h=box.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;const flat=SMALL&&h/w<1.05;camera.fov=flat?32:(w<650?43:33);camera.position.z=flat?598:(w<650?760:650);if(flat)camera.setViewOffset(w,h,0,-Math.round(h*.13),w,h); /* Handy-Karte: Kamera etwas näher (Vasen ≈ 60 % der Canvas-Höhe), Bildfenster nach oben verschoben, damit die Vasen mittig im kurzen Canvas stehen (Blickziel bleibt wie am Desktop) */camera.updateProjectionMatrix();dirty=true;};new ResizeObserver(resize).observe(art);resize();
 new IntersectionObserver(([e])=>inView=e.isIntersecting).observe(art);
 controls.addEventListener('change',()=>{dirty=true;});new ResizeObserver(()=>{dirty=true;}).observe(art);renderer.setAnimationLoop(now=>{const dt=Math.min((now-last)/1000,.04);last=now;if(!inView||document.hidden)return;const animating=!paused&&!motion.matches;if(animating)phase+=dt;const blend=motion.matches?1:1-Math.exp(-dt*8);let settling=false;meshes.forEach((m,i)=>{if(!m)return;const t=target[i];m.position.x=THREE.MathUtils.lerp(m.position.x,t.x,blend);m.position.z=THREE.MathUtils.lerp(m.position.z,t.z,blend);const sc=THREE.MathUtils.lerp(m.scale.x,t.s,blend);m.scale.setScalar(sc);m.visible=sc>.005;m.rotation.y=t.r+Math.sin(phase*.34+i)*.25;m.position.y=0;if(Math.abs(m.position.x-t.x)>.05||Math.abs(m.position.z-t.z)>.05||Math.abs(sc-t.s)>.001)settling=true;});const moved=controls.update();if(animating||moved||settling||dirty){dirty=false;renderer.render(scene,camera);}});
 renderer.render(scene,camera);art.classList.add('ready');
 $('#hero-viewer').addEventListener('webglcontextlost',()=>art.classList.remove('ready'));
 $('#hero-viewer').addEventListener('webglcontextrestored',()=>art.classList.add('ready'));
}catch(error){console.warn('3D collection unavailable; using AI campaign images.',error);art.classList.add('fallback');$('#hero-viewer').hidden=true;$('#motion-toggle').hidden=true;$('.world-meta>span').textContent='KI-PRODUKTFOTO · AUF BASIS UNSERER KONFIGURATOR-MODELLE';chooseScene=()=>{const d=STUDIO_DESIGNS[index],img=$('.hero-fallback');img.src=designImage(d);img.alt=`${d.description}, KI-Produktfotografie auf Basis des 3D-Modells`;};chooseScene();}
}
if(SMALL){new IntersectionObserver(([e],o)=>{if(e.intersectionRatio>=.25){o.disconnect();initWorld();}},{threshold:[0,.25,.5]}).observe(art);}else initWorld();

// The mini profile editor uses the exact same control points as the printable model.
const own=structuredClone(STUDIO_DESIGNS[5]);let points=own.config.customPoints;
let updateMesh=()=>{};
function updateProfile(){
 const path=points.map(([t,r],i)=>`${i?'L':'M'} ${80+r*65} ${220-t*200}`).join(' ');
 $('#lab-profile').innerHTML=`<line x1="80" y1="15" x2="80" y2="225" class="profile-axis"/><path d="${path} L80 20 L80 220Z" class="profile-fill"/><path d="${path}" class="profile-line"/>`+points.map(([t,r],i)=>`<circle cx="${80+r*65}" cy="${220-t*200}" r="6" data-point="${i}" class="profile-point"/>`).join('');
 $('#lab-value').textContent=`${Math.round(points[4][1]*100)} %`;$('#lab-waist').value=Math.round(points[4][1]*100);updateMesh();
}
$('#lab-waist').addEventListener('input',e=>{points[4][1]=+e.target.value/100;updateProfile();});
let drag=null;
$('#lab-profile').addEventListener('pointerdown',e=>{const n=e.target.dataset.point;if(n===undefined)return;drag=+n;e.currentTarget.setPointerCapture(e.pointerId);e.preventDefault();});
$('#lab-profile').addEventListener('pointermove',e=>{if(drag===null)return;const svg=e.currentTarget;const pt=new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM().inverse());points[drag][1]=Math.min(1,Math.max(.55,(pt.x-80)/65));updateProfile();});
for(const type of ['pointerup','pointercancel','lostpointercapture'])$('#lab-profile').addEventListener(type,()=>drag=null);
$('#lab-use').addEventListener('click',()=>go(designConfig(own)));
function startLab(){
try{
 const canvas=$('#lab-viewer');const {renderer,scene,camera}=makeStudio(canvas,{transparent:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));camera.position.set(210,175,420);camera.lookAt(0,90,0);
 const mesh=makeObject(own);scene.add(mesh);let pending=false,visible=false;
 updateMesh=()=>{if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;const next=buildModel({...own.config,quality:.4});mesh.geometry.dispose();mesh.geometry=next.geometry;renderer.render(scene,camera);});};
 const resize=()=>{const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();renderer.render(scene,camera);};new ResizeObserver(resize).observe(canvas);resize();
 new IntersectionObserver(([e])=>visible=e.isIntersecting).observe(canvas);let last=performance.now();renderer.setAnimationLoop(now=>{const dt=Math.min((now-last)/1000,.04);last=now;if(!visible||document.hidden)return;if(!motion.matches&&!paused)mesh.rotation.y+=dt*.12;renderer.render(scene,camera);});
}catch(e){console.warn('Live profile preview unavailable.',e);$('#lab-viewer').hidden=true;const r=$('#lab-reference');r.src=r.dataset.src;r.hidden=false;$('.lab-help').textContent='Profil gestalten und im Konfigurator öffnen';}
}
// Labor-3D auf dem Handy erst kurz vor dem Sichtbarwerden starten (300 px Vorlauf); Desktop sofort
if(SMALL){new IntersectionObserver(([e],o)=>{if(e.isIntersecting){o.disconnect();startLab();updateProfile();}},{rootMargin:'300px 0px'}).observe($('.lab-demo'));}else startLab();
updateProfile();
