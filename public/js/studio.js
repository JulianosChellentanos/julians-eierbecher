import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { buildModel } from './geometry.js';
import { STUDIO_DESIGNS, designConfig } from './studio-designs.js';
import { makeStudio, makeObject } from './studio-scene.js';
const $=s=>document.querySelector(s);
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const go=config=>window.dispatchEvent(new CustomEvent('ovju:studio-design',{detail:config}));
const observer=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');observer.unobserve(e.target);}}),{threshold:.06});
for(const el of document.querySelectorAll('.collection-heading,.lab-copy,.editorial-copy,.studio-heading')){if(!motion.matches){el.classList.add('reveal');observer.observe(el);}}
$('#design-grid').innerHTML=STUDIO_DESIGNS.map((d,i)=>`<button class="design-card" data-design="${i}" aria-label="${d.name} im Konfigurator weitergestalten"><div class="design-image"><img src="/img/studio/fdm-card-${d.id}.webp" alt="${d.description}, KI-Produktfotografie auf Basis des 3D-Modells" loading="lazy" width="800" height="900"><span class="design-number">0${i+1}</span><span class="design-arrow">↗</span></div><div class="design-title"><h3>${d.name}</h3><span>${d.config.height/10} cm</span></div><p>${d.description}</p></button>`).join('');
document.querySelectorAll('[data-design]').forEach(b=>b.addEventListener('click',()=>go(designConfig(STUDIO_DESIGNS[+b.dataset.design]))));
$('#hero-shapes').innerHTML=STUDIO_DESIGNS.map((d,i)=>`<button data-shape="${i}" aria-pressed="${i===0}" class="${i===0?'active':''}">${d.name}</button>`).join('');
let index=0,paused=motion.matches,chooseScene=()=>{};
function select(i){index=(i+STUDIO_DESIGNS.length)%STUDIO_DESIGNS.length;const d=STUDIO_DESIGNS[index];$('#hero-index').textContent=`0${index+1} / 06`;$('#hero-design-name').textContent=d.name;$('#hero-design-detail').textContent=d.description;document.querySelectorAll('[data-shape]').forEach(b=>{const on=+b.dataset.shape===index;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});chooseScene();}
$('#hero-prev').addEventListener('click',()=>select(index-1));$('#hero-next').addEventListener('click',()=>select(index+1));document.querySelectorAll('[data-shape]').forEach(b=>b.addEventListener('click',()=>select(+b.dataset.shape)));
$('#hero-use').addEventListener('click',()=>go(designConfig(STUDIO_DESIGNS[index])));
function syncPause(){const b=$('#motion-toggle');b.textContent=paused?'▷ Bewegung starten':'Ⅱ Bewegung pausieren';b.setAttribute('aria-label',paused?'Automatische Bewegung starten':'Automatische Bewegung pausieren');b.setAttribute('aria-pressed',String(paused));}
$('#motion-toggle').addEventListener('click',()=>{paused=!paused;syncPause();});motion.addEventListener('change',()=>{paused=motion.matches;syncPause();});syncPause();
const art=$('#hero-art');
try{
 const studio=makeStudio($('#hero-viewer'),{transparent:true});const {renderer,scene,camera}=studio;
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
 const controls=new OrbitControls(camera,$('#hero-viewer'));controls.target.set(0,80,0);controls.enableZoom=false;controls.enablePan=false;controls.enableDamping=true;controls.minAzimuthAngle=-.45;controls.maxAzimuthAngle=.45;controls.minPolarAngle=.95;controls.maxPolarAngle=1.45;
 camera.position.set(0,190,650);controls.update();
 const meshes=STUDIO_DESIGNS.map(d=>{const mesh=makeObject(d);scene.add(mesh);return mesh;});
 let target=[],inView=true,started=false,last=performance.now(),phase=0;
 chooseScene=()=>{target=meshes.map((m,i)=>{const delta=(i-index+meshes.length)%meshes.length;return delta===0?{x:0,z:45,s:1,r:0}:delta===1?{x:153,z:-35,s:.85,r:-.3}:delta===meshes.length-1?{x:-153,z:-35,s:.85,r:.3}:{x:0,z:-150,s:0,r:0};});if(!started||motion.matches){meshes.forEach((m,i)=>{const t=target[i];m.position.set(t.x,0,t.z);m.scale.setScalar(t.s);});started=true;}};chooseScene();
 const resize=()=>{const w=art.clientWidth,h=art.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.fov=w<650?43:33;camera.position.z=w<650?760:650;camera.updateProjectionMatrix();};new ResizeObserver(resize).observe(art);resize();
 new IntersectionObserver(([e])=>inView=e.isIntersecting).observe(art);
 renderer.setAnimationLoop(now=>{const dt=Math.min((now-last)/1000,.04);last=now;if(!inView||document.hidden)return;if(!paused&&!motion.matches)phase+=dt;const blend=motion.matches?1:1-Math.exp(-dt*8);meshes.forEach((m,i)=>{const t=target[i];m.position.x=THREE.MathUtils.lerp(m.position.x,t.x,blend);m.position.z=THREE.MathUtils.lerp(m.position.z,t.z,blend);const sc=THREE.MathUtils.lerp(m.scale.x,t.s,blend);m.scale.setScalar(sc);m.visible=sc>.005;m.rotation.y=t.r+Math.sin(phase*.34+i)*.25;m.position.y=0;});controls.update();renderer.render(scene,camera);});
 renderer.render(scene,camera);art.classList.add('ready');
 $('#hero-viewer').addEventListener('webglcontextlost',()=>art.classList.remove('ready'));
 $('#hero-viewer').addEventListener('webglcontextrestored',()=>art.classList.add('ready'));
}catch(error){console.warn('3D collection unavailable; using rendered models.',error);$('#hero-viewer').hidden=true;chooseScene=()=>{$('.hero-fallback').src=`/img/studio/fdm-card-${STUDIO_DESIGNS[index].id}.webp`;};$('#motion-toggle').hidden=true;}

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
try{
 const canvas=$('#lab-viewer');const {renderer,scene,camera}=makeStudio(canvas,{transparent:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));camera.position.set(210,175,420);camera.lookAt(0,90,0);
 const mesh=makeObject(own);scene.add(mesh);let pending=false,visible=false;
 updateMesh=()=>{if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;const next=buildModel({...own.config,quality:.4});mesh.geometry.dispose();mesh.geometry=next.geometry;renderer.render(scene,camera);});};
 const resize=()=>{const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();renderer.render(scene,camera);};new ResizeObserver(resize).observe(canvas);resize();
 new IntersectionObserver(([e])=>visible=e.isIntersecting).observe(canvas);let last=performance.now();renderer.setAnimationLoop(now=>{const dt=Math.min((now-last)/1000,.04);last=now;if(!visible||document.hidden)return;if(!motion.matches&&!paused)mesh.rotation.y+=dt*.12;renderer.render(scene,camera);});$('#lab-reference').hidden=true;
}catch(e){console.warn('Live profile preview unavailable.',e);$('#lab-viewer').hidden=true;$('.lab-help').textContent='Profil gestalten und im Designstudio öffnen';}
updateProfile();
