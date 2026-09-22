import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {decodePlanarPrism,matchSourceProfile} from './lib/rvtPlanarPrism.mjs';
const [sourcePath,profilesPath,linesPath,output]=process.argv.slice(2);
if(!output)throw Error('family-source.json profiles.json source-lines.json new-output-directory');
const sha=b=>createHash('sha256').update(b).digest('hex'),inputs=await Promise.all([sourcePath,profilesPath,linesPath].map(p=>readFile(p))),[source,profiles,lines]=inputs.map(b=>JSON.parse(b));
if(source.sourceSha256!==profiles.sourceSha256||source.sourceSha256!==lines.sourceSha256)throw Error('source mismatch');
await mkdir(output);const results=[];
for(const id of [...new Set(source.metadata.map(m=>m.element))].sort((a,b)=>a-b)){
  const metadata=source.metadata.filter(m=>m.element===id),records=source.geometryRecords.filter(g=>g.element===id);
  const row={element:id,metadataRecords:metadata.length,geometryRecords:records.length};
  if(metadata.some(m=>!m.standalone)){results.push({...row,status:'container-placement-unresolved'});continue;}
  const distinct=[...new Map(records.map(r=>[r.sha256,r])).values()];
  if(distinct.length!==1){results.push({...row,status:distinct.length?'conflicting-geometry-records':'geometry-carrier-missing'});continue;}
  const record=distinct[0];
  try{
    if(!record.hex)throw Error('unsupported record layout');
    const bytes=Buffer.from(record.hex,'hex');if(sha(bytes)!==record.sha256)throw Error('source bytes changed');
    const solid=decodePlanarPrism(bytes,id),profile=matchSourceProfile(solid,profiles.profiles.find(p=>p.owner===id),lines.lines);
    const selected={...source,element:id,metadata,geometryRecords:[record]};
    const selectedPath=path.join(output,`source-${id}.json`);await writeFile(selectedPath,JSON.stringify(selected),{flag:'wx'});
    const directory=path.join(output,`element-${id}`);
    await promisify(execFile)(process.execPath,['scripts/audit-rvt-planar-prism.mjs',selectedPath,profilesPath,linesPath,directory],{windowsHide:true});
    const evidence=JSON.parse(await readFile(path.join(directory,'evidence.json')));
    results.push({...row,status:'source-planar-solid-preview',faces:6,vertices:8,triangles:12,lowerFeet:solid.lowerFeet,upperFeet:solid.upperFeet,
      profileLineIds:profile.sourceLineIds,glb:path.relative(output,path.join(directory,'source-solid.glb')),glbSha256:evidence.glbSha256,maxQuantizationMm:evidence.maxQuantizationMm});
  }catch(error){results.push({...row,status:'unsupported-profile',reason:error.message});}
}
const summary={sourceIdentities:results.length,standalone:results.filter(r=>r.status!=='container-placement-unresolved').length,
  decodedSolids:results.filter(r=>r.status==='source-planar-solid-preview').length,reasons:results.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{})};
const combined={asset:{version:'2.0',generator:'DeepMonkey source-planar-solid research'},scene:0,scenes:[{nodes:[]}],nodes:[],meshes:[],accessors:[],bufferViews:[],buffers:[{byteLength:0}],
  extras:{quality:'partial-source-planar-solid-preview',sourceSha256:source.sourceSha256,decodedSolids:summary.decodedSolids,standaloneCandidates:summary.standalone,sourceUpAxis:'Z'}};
const chunks=[];let binOffset=0;
for(const row of results.filter(r=>r.status==='source-planar-solid-preview')){
  const bytes=await readFile(path.join(output,row.glb));if(sha(bytes)!==row.glbSha256)throw Error('generated GLB changed');
  const jsonSize=bytes.readUInt32LE(12),doc=JSON.parse(bytes.subarray(20,20+jsonSize)),bin=bytes.subarray(28+jsonSize);
  const meshBase=combined.meshes.length,accessorBase=combined.accessors.length,viewBase=combined.bufferViews.length;
  for(const node of doc.nodes){combined.scenes[0].nodes.push(combined.nodes.length);combined.nodes.push({...node,mesh:node.mesh+meshBase});}
  for(const mesh of doc.meshes)combined.meshes.push({...mesh,primitives:mesh.primitives.map(p=>({...p,indices:p.indices+accessorBase,attributes:{POSITION:p.attributes.POSITION+accessorBase}}))});
  combined.accessors.push(...doc.accessors.map(a=>({...a,bufferView:a.bufferView+viewBase})));
  combined.bufferViews.push(...doc.bufferViews.map(v=>({...v,byteOffset:v.byteOffset+binOffset})));
  chunks.push(bin);binOffset+=bin.length;
}
combined.buffers[0].byteLength=binOffset;
const encoded=Buffer.from(JSON.stringify(combined)),padding=Buffer.alloc(Math.ceil(encoded.length/4)*4,32);encoded.copy(padding);
const aggregate=Buffer.alloc(28+padding.length+binOffset);aggregate.writeUInt32LE(0x46546c67);aggregate.writeUInt32LE(2,4);aggregate.writeUInt32LE(aggregate.length,8);aggregate.writeUInt32LE(padding.length,12);aggregate.writeUInt32LE(0x4e4f534a,16);padding.copy(aggregate,20);aggregate.writeUInt32LE(binOffset,20+padding.length);aggregate.writeUInt32LE(0x004e4942,24+padding.length);Buffer.concat(chunks).copy(aggregate,28+padding.length);
await writeFile(path.join(output,'partial-source-solids.glb'),aggregate,{flag:'wx'});
await writeFile(path.join(output,'evidence.json'),JSON.stringify({schemaVersion:1,sourceSha256:source.sourceSha256,inputSha256:inputs.map(sha),
  scope:'standalone-floor-and-site-pad-narrow-profile-not-all-building-elements',summary,aggregateGlbSha256:sha(aggregate),results},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(summary));
