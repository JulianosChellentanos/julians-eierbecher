// Validate every marketed design through the production STL generator and validators.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {STUDIO_DESIGNS} from '../public/js/studio-designs.js';
const dir=mkdtempSync(join(tmpdir(),'ovju-studio-'));
try{
 for(const design of STUDIO_DESIGNS){
  const file=join(dir,design.id+'.stl');
  for(const args of [['tools/generate-stl.mjs',file,JSON.stringify(design.config)],['tools/check-stl.mjs',file],['tools/check-printability.mjs',file]]){
   const result=spawnSync(process.execPath,args,{encoding:'utf8'});
   if(result.status!==0)throw new Error(`${design.id}: ${result.stdout}\n${result.stderr}`);
   if(args[0].includes('generate-stl') && statSync(file).size < 1000) throw new Error('Missing STL output');
   if(args[0].includes('printability'))console.log(`${design.name}: validated (${Math.round(statSync(file).size/1024)} KB STL)`);
  }
 }
 console.log('All six studio designs: valid manifold STL and printability checks passed.');
}finally{rmSync(dir,{recursive:true,force:true});}
