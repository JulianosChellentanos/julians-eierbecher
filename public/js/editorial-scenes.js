// Photographic compositions using production geometry and locally available HDRIs.
import * as THREE from 'three';
import { RGBELoader } from '../vendor/RGBELoader.js';
import { makeStudio,makeObject } from './studio-scene.js';
import { makeGrass } from './scenes.js';
import { STUDIO_DESIGNS } from './studio-designs.js';
import { SURFACE_DESIGNS } from './surface-designs.js';
export async function renderEditorial(canvas,kind){
 const studio=makeStudio(canvas,{width:1400,height:1100,capture:true,shadowSize:2048});const {scene,camera,renderer}=studio;
 const originalEnv=scene.environment;
 renderer.toneMappingExposure=.85;
 scene.children.filter(o=>o.isHemisphereLight).forEach(o=>o.intensity=.4);
 const hdr=await new RGBELoader().loadAsync('/env/'+(kind==='evening'?'warm_restaurant_night_1k.hdr':'lythwood_room_1k.hdr'));
 const pmrem=new THREE.PMREMGenerator(renderer);const env=pmrem.fromEquirectangular(hdr);scene.environment=env.texture;hdr.dispose();pmrem.dispose();
 const box=(w,h,d,x,y,z,color)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshStandardMaterial({color,roughness:.95}));m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;scene.add(m);return m;};
 const object=(design,x=0,z=0,finish='matt')=>{const mesh=makeObject(design,.9);mesh.position.set(x,0,z);mesh.material.envMapIntensity=.5;if(finish==='metall'){mesh.material.metalness=.92;mesh.material.roughness=.28;}scene.add(mesh);return mesh;};
 const key=scene.children.find(o=>o.isDirectionalLight&&o.castShadow);
 if(kind==='window'){
  scene.background=new THREE.Color('#dedace');box(1800,650,20,0,250,-210,'#dedace');
  const table=box(1000,28,650,0,-14,0,'#d5c3a1');
  const wood=await new THREE.TextureLoader().loadAsync('/env/wood_table_001_diff_1k.jpg');wood.colorSpace=THREE.SRGBColorSpace;wood.wrapS=wood.wrapT=THREE.RepeatWrapping;wood.repeat.set(2,2);table.material.map=wood;table.material.needsUpdate=true;
  object(STUDIO_DESIGNS[1],-62,10);object(STUDIO_DESIGNS[2],80,-30);
  const grass=makeGrass(16,180);grass.position.set(80,0,-30);scene.add(grass);
  box(120,14,85,-175,7,20,'#d0c4af');box(105,10,78,-170,19,20,'#eee9dd');
  // Off-camera lintel casts a soft architectural shadow.
  box(600,18,25,-300,380,80,'#dedace');
  key.position.set(-330,420,300);key.intensity=1.8;
  camera.position.set(250,225,620);camera.lookAt(0,105,0);
 }else if(kind==='evening'){
  scene.background=new THREE.Color('#292822');box(1600,650,20,0,260,-160,'#393a31');box(900,20,500,0,-10,0,'#4c4034');
  object(SURFACE_DESIGNS.hammered,0,0,'metall');object({...STUDIO_DESIGNS[3],hex:'#3a3b3c'},130,-45);
  key.color.set('#ffcc85');key.intensity=2;key.position.set(-160,220,150);
  const rim=new THREE.PointLight('#ffa647',14000,450,2);rim.position.set(-100,100,-75);scene.add(rim);
  camera.position.set(180,150,355);camera.lookAt(15,88,0);renderer.toneMappingExposure=.8;
 }else if((kind==='skeleton'||kind==='coral')){
  scene.background=new THREE.Color('#c9c7bb');box(1500,650,20,0,280,-180,'#c9c7bb');
  const mesh=object(kind==='coral'?SURFACE_DESIGNS.coral:SURFACE_DESIGNS.skeleton);mesh.position.y=40;box(135,40,135,0,20,0,'#9fa28c');
  box(100,140,100,-170,70,-80,'#b2b5a0');object({...STUDIO_DESIGNS[1],hex:'#717b5e'},-170,-80).position.y=140;
  key.position.set(-260,400,200);key.intensity=2;camera.position.set(260,230,530);camera.lookAt(-35,120,0);
 }else{
  const d={...SURFACE_DESIGNS.hammered,hex:kind==='hammer-matt'?'#efe9dc':kind==='hammer-silver'?'#c7c9cc':'#b87333'};
  const mesh=object(d,0,0,kind==='hammer-matt'?'matt':'metall');
  mesh.rotation.y=.25;camera.position.set(110,115,190);camera.lookAt(0,90,0);
  scene.background=new THREE.Color(kind==='hammer-matt'?'#dedbd1':'#30342e');
  renderer.toneMappingExposure=kind==='hammer-matt'?.8:.8;
  key.intensity=1.5;
 }
 renderer.render(scene,camera);const data=canvas.toDataURL('image/jpeg',.93);
 // The temporary renderer owns all scene resources, including photographic textures.
 scene.traverse(o=>{if(o.material?.map)o.material.map.dispose();});scene.environment=originalEnv;env.dispose();studio.dispose();return data;
}
