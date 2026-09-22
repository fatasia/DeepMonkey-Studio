import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {decodePlanarPrism,matchSourceProfile} from './lib/rvtPlanarPrism.mjs';
import {resolveGroupReference} from './lib/rvtGroupGeometry.mjs';
const [groupsPath,familyPath,profilesPath,linesPath,output,baselineDirectory]=process.argv.slice(2);
if(!output)throw Error('groups.json family.json profiles.json lines.json new-output-directory');
const sha=b=>createHash('sha256').update(b).digest('hex');
const inputs=await Promise.all([groupsPath,familyPath].map(p=>readFile(p))),[groups,family]=inputs.map(b=>JSON.parse(b));
if(groups.sourceSha256!==family.sourceSha256)throw Error('source mismatch');
const profiles=JSON.parse(await readFile(profilesPath)),lines=JSON.parse(await readFile(linesPath));
if(profiles.sourceSha256!==family.sourceSha256||lines.sourceSha256!==family.sourceSha256)throw Error('source profile mismatch');
await mkdir(output);const results=[];
for(const element of [...new Set(family.metadata.filter(m=>!m.standalone).map(m=>m.element))]){
  const metadata=family.metadata.filter(m=>m.element===element),records=[...new Map(family.geometryRecords.filter(r=>r.element===element).map(r=>[r.sha256,r])).values()];
  const row={element,container:metadata[0].containerRaw};
  if(records.length!==1||!records[0].hex){results.push({...row,status:'unsupported-or-conflicting-geometry'});continue;}
  let solid;
  try{solid=decodePlanarPrism(Buffer.from(records[0].hex,'hex'),element);}catch(error){results.push({...row,status:'unsupported-geometry',reason:error.message});continue;}
  const candidates=[];
  for(const groupRecord of groups.carriers.filter(r=>r.hex.slice(32,40)==='3f08ffff')){
    const groupHeader=groups.headers.find(h=>h.element===groupRecord.element);
    if(!groupHeader)continue;
    if(Buffer.from(groupHeader.hex,'hex').readBigUInt64LE(50).toString()!==row.container)continue;
    try{for(const reference of resolveGroupReference({member:element,metadata,groupHeader,groupRecord}))candidates.push({reference,groupHeader,groupRecord});}
    catch(error){if(error.message!=='member absent from group geometry')throw error;}
  }
  if(!candidates.length){results.push({...row,status:'group-geometry-reference-missing'});continue;}
  try{matchSourceProfile(solid,profiles.profiles.find(p=>p.owner===element),lines.lines);}catch(error){results.push({...row,status:'source-profile-crosscheck-unavailable',reason:error.message});continue;}
  for(const {reference,groupHeader,groupRecord} of candidates){
    const occurrence=`${reference.instance}-${reference.referenceIndex}-${element}`,file=path.join(output,`source-${occurrence}.json`);
    const selected={sourceSha256:family.sourceSha256,element,metadata,geometryRecords:records,
      groupPlacement:{sourceSha256:groups.sourceSha256,referenceIndex:reference.referenceIndex,groupHeader,groupRecord}};
    await writeFile(file,JSON.stringify(selected),{flag:'wx'});
    const directory=path.join(output,`element-${occurrence}`);
    await promisify(execFile)(process.execPath,['scripts/audit-rvt-planar-prism.mjs',file,profilesPath,linesPath,directory],{windowsHide:true});
    const proof=JSON.parse(await readFile(path.join(directory,'evidence.json')));
    const bounds=[0,1,2].map(k=>[Math.min(...proof.solid.verticesFeet.map(p=>p[k])),Math.max(...proof.solid.verticesFeet.map(p=>p[k]))]);
    const groupBox=Buffer.from(groupHeader.hex,'hex');
    const sourceGroupBounds=Array.from({length:6},(_,i)=>groupBox.readDoubleLE(88+i*8));
    if(bounds.some(([min,max],k)=>min<sourceGroupBounds[k]-1e-7||max>sourceGroupBounds[k+3]+1e-7))throw Error('placed member escapes source group diagnostic bounds');
    results.push({...row,status:'source-group-solid-preview',instance:reference.instance,referenceIndex:reference.referenceIndex,
      matrix:reference.matrix,sourceReferenceOffset:reference.sourceOffset,worldBoundsFeet:bounds,sourceGroupBoundsFeet:sourceGroupBounds,
      glb:path.relative(output,path.join(directory,'source-solid.glb')),glbSha256:proof.glbSha256,maxQuantizationMm:proof.maxQuantizationMm});
  }
}
const summary=results.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{});
const overlaps=[];let baselineSha256;
if(baselineDirectory){
  const baselineBytes=await readFile(path.join(baselineDirectory,'evidence.json')),baseline=JSON.parse(baselineBytes);
  if(baseline.sourceSha256!==family.sourceSha256)throw Error('baseline source mismatch');
  baselineSha256=sha(baselineBytes);
  const previous=[];
  for(const row of baseline.results.filter(r=>r.glb))previous.push({element:row.element,solid:JSON.parse(await readFile(path.join(baselineDirectory,path.dirname(row.glb),'evidence.json'))).solid});
  for(const row of results.filter(r=>r.glb)){
    const current=JSON.parse(await readFile(path.join(output,path.dirname(row.glb),'evidence.json'))).solid;
    const matches=previous.filter(p=>p.solid.verticesFeet.length===current.verticesFeet.length&&current.verticesFeet.every(v=>p.solid.verticesFeet.some(q=>Math.hypot(...v.map((x,k)=>x-q[k]))<=1e-7)));
    overlaps.push({element:row.element,instance:row.instance,coincidentBaselineElements:matches.map(p=>p.element)});
  }
}
await writeFile(path.join(output,'evidence.json'),JSON.stringify({sourceSha256:family.sourceSha256,inputSha256:inputs.map(sha),summary,results,baselineSha256,overlaps,
  defaultSceneMerge:'disabled-until-active-group-and-design-option-selection-is-proven'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(summary));
