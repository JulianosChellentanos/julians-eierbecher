import * as THREE from 'three';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { buildModel } from './geometry.js';

export function makeStudio(canvas,{width=1000,height=850,transparent=false}={}) {
  const renderer=new THREE.WebGLRenderer({canvas,alpha:transparent,antialias:true,preserveDrawingBuffer:true});
  renderer.setPixelRatio(1); renderer.setSize(width,height,false);
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  const scene=new THREE.Scene();if(!transparent)scene.background=new THREE.Color('#e7e4d8');
  const camera=new THREE.PerspectiveCamera(33,width/height,1,2000);camera.position.set(260,205,470);camera.lookAt(0,80,0);
  const pmrem=new THREE.PMREMGenerator(renderer);const room=new RoomEnvironment();const env=pmrem.fromScene(room,.05);scene.environment=env.texture;room.dispose();pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xfff5e4,0x66694d,1.3));
  const key=new THREE.DirectionalLight(0xffefd9,3);key.position.set(-180,330,220);key.castShadow=true;
  key.shadow.mapSize.set(2048,2048);Object.assign(key.shadow.camera,{left:-370,right:370,top:370,bottom:-370,near:1,far:1000});key.shadow.bias=-.0002;key.shadow.normalBias=.1;key.shadow.radius=4;scene.add(key);
  const fill=new THREE.DirectionalLight(0xdce6fa,.6);fill.position.set(220,130,-180);scene.add(fill);
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(2400,2400),transparent?new THREE.ShadowMaterial({opacity:.15}):new THREE.MeshStandardMaterial({color:'#e7e4d8',roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.15;floor.receiveShadow=true;scene.add(floor);
  return {renderer,scene,camera,dispose(){scene.traverse(o=>{o.geometry?.dispose();if(o.material)for(const m of [o.material].flat())m.dispose();});env.dispose();renderer.dispose();}};
}
export function makeObject(design,quality=.55){
  const {geometry}=buildModel({...design.config,quality});
  // Finish wie im Konfigurator: matt / glänzend / metallic (Silk)
  const finish=design.finish||'matt';
  const material=new THREE.MeshStandardMaterial(finish==='metall'?{color:design.hex,roughness:.3,metalness:.85}:finish==='glanz'?{color:design.hex,roughness:.22,metalness:.05}:{color:design.hex,roughness:.68,metalness:0});
  const mesh=new THREE.Mesh(geometry,material);mesh.castShadow=true;mesh.receiveShadow=false;
  return mesh;
}
