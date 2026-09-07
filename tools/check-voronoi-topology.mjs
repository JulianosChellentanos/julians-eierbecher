import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Font} from '../public/vendor/FontLoader.js';
import {buildModel} from '../public/js/geometry.js';
const font=new Font(JSON.parse(readFileSync(new URL('../public/fonts/helvetiker_bold.typeface.json',import.meta.url),'utf8')));
const cases=[
 ...[.4,.65,1].flatMap(quality=>[8,48,90].map(ribs=>({name:`quality-${quality}-cells-${ribs}`,quality,ribs}))),
 ...['gepraegt','gehaemmert','gestanzt'].map(textStyle=>({name:`text-${textStyle}`,text:'OVJU',textStyle,textSize:8,textPos:.5,textFont:font,quality:.65})),
 {name:'egg-solid',product:'eierbecher',preset:'kelch',height:58,quality:.65},
];
for(const c of cases){
 const {geometry,info}=buildModel({product:'vase',preset:'flasche',height:180,pattern:'skelett',ribs:48,depth:1.4,...c});
 const pos=geometry.attributes.position.array,idx=geometry.index.array,edges=new Map(),vertices=new Set(),parents=new Map();
 const root=x=>{let y=x;while(parents.get(y)!==y)y=parents.get(y);while(x!==y){const next=parents.get(x);parents.set(x,y);x=next;}return y;};
 for(let i=0;i<idx.length;i+=3){
  const [a,b,c]=idx.slice(i,i+3);assert.ok(a!==b&&b!==c&&c!==a,'collapsed indexed triangle');
  for(const v of [a,b,c]){vertices.add(v);if(!parents.has(v))parents.set(v,v);assert.ok(Number.isFinite(pos[v*3]+pos[v*3+1]+pos[v*3+2]));}
  for(const [u,v] of [[a,b],[b,c],[c,a]]){const key=u<v?`${u}:${v}`:`${v}:${u}`,e=edges.get(key)||{count:0,balance:0};e.count++;e.balance+=u<v?1:-1;edges.set(key,e);parents.set(root(v),root(u));}
 }
 for(const e of edges.values()){assert.equal(e.count,2,'non-manifold boundary');assert.equal(e.balance,0,'inconsistent face winding');}
 assert.equal(new Set([...vertices].map(root)).size,1,'detached shell component');
 const chi=vertices.size-edges.size+idx.length/3;
 if(info.openCells)assert.ok(chi<0,'vase must have real through-holes');else assert.equal(chi,2,'egg cup must retain a closed cavity surface');
 console.log(`PASS ${c.name}: one connected manifold, ${info.openCells?(2-chi)/2+' through-holes':'closed egg cup'}`);geometry.dispose();
}
