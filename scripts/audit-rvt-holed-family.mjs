import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {decodeHoledPrism,matchHoledSourceProfile} from './lib/rvtHoledPrism.mjs';
const [sourcePath,profilesPath,linesPath,output]=process.argv.slice(2);
if(!output)throw Error('source.json profiles.json lines.json new-output-directory');
const sha=b=>createHash('sha256').update(b).digest('hex');
const inputs=await Promise.all([sourcePath,profilesPath,linesPath].map(p=>readFile(p))),[source,profiles,lines]=inputs.map(b=>JSON.parse(b));
if(source.sourceSha256!==profiles.sourceSha256||source.sourceSha256!==lines.sourceSha256)throw Error('source mismatch');
await mkdir(output);const results=[];
const ids=[...new Set(source.geometryRecords.filter(r=>r.recordBytes===22997).map(r=>r.element))].sort((a,b)=>a-b);
for(const element of ids){
  const metadata=source.metadata.filter(m=>m.element===element);if(!metadata.length||metadata.some(m=>!m.standalone))continue;
  const records=[...new Map(source.geometryRecords.filter(r=>r.element===element).map(r=>[r.sha256,r])).values()];
  if(records.length!==1){results.push({element,status:'conflicting-geometry-records'});continue;}
  const record=records[0],bytes=Buffer.from(record.hex,'hex');if(sha(bytes)!==record.sha256)throw Error('source record hash');
  let solid;
  try{solid=decodeHoledPrism(bytes,element);matchHoledSourceProfile(solid,profiles.profiles.find(p=>p.owner===element),lines.lines);}
  catch(error){results.push({element,status:'unsupported-source-profile',reason:error.message});continue;}
  const file=path.join(output,`source-${element}.json`),directory=path.join(output,`element-${element}`);
  await writeFile(file,JSON.stringify({sourceSha256:source.sourceSha256,element,metadata,geometryRecords:records}),{flag:'wx'});
  await promisify(execFile)(process.execPath,['scripts/audit-rvt-planar-prism.mjs',file,profilesPath,linesPath,directory],{windowsHide:true});
  const evidence=JSON.parse(await readFile(path.join(directory,'evidence.json')));
  results.push({element,status:'source-holed-planar-solid-preview',faces:solid.faces.length,vertices:solid.verticesFeet.length,triangles:solid.triangles.length,holes:1,
    volumeCubicFeet:solid.volumeCubicFeet,maxPairedResidualFeet:solid.maxPairedResidualFeet,maxQuantizationMm:evidence.maxQuantizationMm,
    glb:path.relative(output,path.join(directory,'source-solid.glb')),glbSha256:evidence.glbSha256});
}
const summary=results.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{});
await writeFile(path.join(output,'evidence.json'),JSON.stringify({sourceSha256:source.sourceSha256,inputSha256:inputs.map(sha),summary,results,
  scope:'22997-byte-single-hole-standalone-profile-only',productionProfilesCertified:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(summary));
