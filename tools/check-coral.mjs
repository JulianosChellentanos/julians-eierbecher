import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {STUDIO_DESIGNS} from '../public/js/studio-designs.js';
const cases=[...STUDIO_DESIGNS.map(d=>({name:d.id,...d.config,pattern:'koralle',depth:4.5})),
 ...['spirale','gegen','fluss','zick'].map((flow,i)=>({name:`flow-${flow}`,product:'vase',preset:'zylinder',height:i%2?90:220,width:i%2?.85:1.15,pattern:'koralle',ribs:i%2?8:90,depth:6,twist:i%2?-2:2,flow,flowWaves:6})),
 ...['kelch','schale','tulpe'].map(preset=>({name:`egg-${preset}`,product:'eierbecher',preset,height:58,width:1,pattern:'koralle',ribs:48,depth:2.2,saucer:true}))];
const dir=mkdtempSync(join(tmpdir(),'ovju-coral-'));
try{for(const c of cases){const file=join(dir,c.name+'.stl');for(const args of [['tools/generate-stl.mjs',file,JSON.stringify(c)],['tools/check-stl.mjs',file],['tools/check-printability.mjs',file]]){const r=spawnSync(process.execPath,args,{encoding:'utf8'});if(r.status!==0)throw new Error(`${c.name}: ${args[0]}\n${r.stdout}\n${r.stderr}`);}if(statSync(file).size<1000)throw new Error('STL missing');console.log(`PASS ${c.name}`);}}finally{rmSync(dir,{recursive:true,force:true});}
