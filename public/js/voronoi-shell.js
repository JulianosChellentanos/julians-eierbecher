import * as THREE from 'three';

const fract=x=>x-Math.floor(x);
const hash=(i,j,s)=>fract(Math.sin(i*127.1+j*311.7+s*74.7)*43758.5453);
// Periodic jittered Voronoi cells. F2-F1 rounds the cell corners naturally.
export function cellDistance(theta,y,n,spacing){
 const u=theta/(2*Math.PI)*n,v=y/spacing,iu=Math.floor(u),iv=Math.floor(v);
 let a=Infinity,b=Infinity;
 for(let di=-1;di<=1;di++)for(let dj=-1;dj<=1;dj++){
  const i=iu+di,j=iv+dj,k=((i%n)+n)%n;
  const x=i+.5+(hash(k,j,1)-.5)*.65,z=j+.5+(hash(k,j,2)-.5)*.55;
  const d=(u-x)**2+(v-z)**2;
  if(d<a){b=a;a=d;}else if(d<b)b=d;
 }
 return (Math.sqrt(b)-Math.sqrt(a))*.5;
}

// Clip a shared UV triangle grid once, then give it an outer and inner skin.
// Every cut edge receives a side wall: the openings are real, the solid is manifold.
/** Zellen um den Umfang: aus dem Anzahl-Regler, aber Teilung ≤ ~25 mm (sonst waagerechte Zelldecken > 30 mm = unstützbare Brücken) */
export const cellCount=(ribs,rMax)=>Math.min(20,Math.max(Math.ceil(2*Math.PI*rMax/25),Math.round(ribs/4)));

export function buildVoronoiShell({H,R,rBase,rMax,ribs,amp,flowPhase,quality,surface,text,textSize,textPos}){
 const n=cellCount(ribs,rMax||R(.5));
 const nx=Math.round(Math.max(240,n*36)*quality),ny=Math.round(Math.max(160,H*1.65)*quality);
 const floor=3,spacing=Math.max(18,H/8);
 const verts=[],triangles=[],edgeCuts=new Map();
 const field=(theta,y)=>{
  const t=y/H,cellWidth=2*Math.PI*R(t)/n;
  const web=Math.min(.44,(1.35+amp*.55)/Math.max(3,cellWidth));
  let f=web-cellDistance(theta+flowPhase(t)*.18,y,n,spacing);
  // Stable unperforated foot and rim. No detached cells at either end.
  f=Math.max(f,(6-y)/spacing,(y-(H-5))/spacing);
  if(text){
   const angle=Math.atan2(Math.sin(theta),Math.cos(theta));
   const half=Math.min(Math.PI,(text.length*textSize*.38+5)/R(textPos));
   const patch=Math.min((half-Math.abs(angle))*.4,(textSize*.8+4-Math.abs(y-H*textPos))/spacing);
   f=Math.max(f,patch);
  }
  return Math.abs(f)<1e-7?1e-7:f;
 };
 for(let j=0;j<=ny;j++)for(let i=0;i<nx;i++){
  const theta=i/nx*2*Math.PI,y=floor+j/ny*(H-floor);
  verts.push({theta,y,f:field(theta,y)});
 }
 const cut=(ia,ib)=>{
  const key=ia<ib?`${ia}:${ib}`:`${ib}:${ia}`;
  if(edgeCuts.has(key))return edgeCuts.get(key);
  // Keep intersections clear of grid vertices at STL float32 precision.
  const a=verts[ia],b=verts[ib],t=Math.max(.001,Math.min(.999,a.f/(a.f-b.f)));
  let delta=b.theta-a.theta;if(delta>Math.PI)delta-=2*Math.PI;if(delta<-Math.PI)delta+=2*Math.PI;
  const id=verts.length;verts.push({theta:a.theta+delta*t,y:a.y+(b.y-a.y)*t,f:0});edgeCuts.set(key,id);return id;
 };
 const clip=(ids)=>{
  const out=[];
  for(let k=0;k<3;k++){const a=ids[k],b=ids[(k+1)%3];if(verts[a].f>=0)out.push(a);if((verts[a].f>=0)!==(verts[b].f>=0))out.push(cut(a,b));}
  for(let k=1;k<out.length-1;k++)triangles.push([out[0],out[k],out[k+1]]);
 };
 for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
  const a=j*nx+i,b=j*nx+(i+1)%nx,c=(j+1)*nx+i,d=(j+1)*nx+(i+1)%nx;
  clip([a,b,c]);clip([b,d,c]);
 }
 const positions=[],indices=[],used=new Map(),edges=new Map();
 const point=(theta,y,r)=>{const i=positions.length/3;positions.push(Math.sin(theta)*r,y,Math.cos(theta)*r);return i;};
 const pair=(id)=>{
  if(used.has(id))return used.get(id);
  const v=verts[id],t=v.y/H;
  const outer=point(v.theta,v.y,R(t)+surface(v.theta,t,v.y));
  const inner=point(v.theta,v.y,Math.max(1.4,R(t)-2.2-amp));
  const value=[outer,inner];used.set(id,value);return value;
 };
 for(const tri of triangles){
  const [a,b,c]=tri.map(pair);indices.push(a[0],b[0],c[0],c[1],b[1],a[1]);
  for(let k=0;k<3;k++){const u=tri[k],v=tri[(k+1)%3],key=u<v?`${u}:${v}`:`${v}:${u}`;if(edges.has(key))edges.delete(key);else edges.set(key,[u,v]);}
 }
 for(const [u,v] of edges.values()){
  if(verts[u].y===floor&&verts[v].y===floor)continue;
  const a=pair(u),b=pair(v);indices.push(b[0],a[0],a[1],b[0],a[1],b[1]);
 }
 // Join the perforated shell to a solid 3 mm floor and chamfered foot.
 const bottom=[],bevel=[];
 for(let i=0;i<nx;i++){const theta=i/nx*2*Math.PI;bottom.push(point(theta,0,rBase));bevel.push(point(theta,.8,R(.8/H)));}
 const under=point(0,0,0),inside=point(0,floor,0);
 for(let i=0;i<nx;i++){
  const k=(i+1)%nx,a=pair(i),b=pair(k);
  indices.push(under,bottom[k],bottom[i],bottom[i],bottom[k],bevel[i],bottom[k],bevel[k],bevel[i]);
  indices.push(bevel[i],bevel[k],a[0],bevel[k],b[0],a[0]);
  indices.push(a[1],b[1],inside);
 }
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();return geometry;
}
