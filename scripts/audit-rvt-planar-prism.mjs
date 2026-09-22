import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {decodePlanarPrism,matchSourceProfile} from './lib/rvtPlanarPrism.mjs';
import {resolveGroupReference,applyGroupReference} from './lib/rvtGroupGeometry.mjs';
import {decodeHoledPrism,matchHoledSourceProfile} from './lib/rvtHoledPrism.mjs';
const [sourcePath,profilesPath,linesPath,output]=process.argv.slice(2);
if(!output)throw Error('source-record.json profiles.json source-lines.json new-output-directory');
const sha=b=>createHash('sha256').update(b).digest('hex');
const inputs=await Promise.all([sourcePath,profilesPath,linesPath].map(p=>readFile(p))),[source,profiles,lines]=inputs.map(b=>JSON.parse(b));
if(source.sourceSha256!==profiles.sourceSha256||source.sourceSha256!==lines.sourceSha256)throw Error('source snapshot mismatch');
if(source.geometryRecords.length!==1||!source.metadata.length)throw Error('ambiguous geometry/metadata');
const record=source.geometryRecords[0],bytes=Buffer.from(record.hex,'hex');if(sha(bytes)!==record.sha256)throw Error('source record changed');
const holed=bytes.length===22997;
const decoded=(holed?decodeHoledPrism:decodePlanarPrism)(bytes,source.element);
const profile=(holed?matchHoledSourceProfile:matchSourceProfile)(decoded,profiles.profiles.find(p=>p.owner===source.element),lines.lines);
let solid=decoded;
if(source.metadata.some(m=>!m.standalone)){
  const placement=source.groupPlacement;
  if(!placement||placement.sourceSha256!==source.sourceSha256)throw Error('missing group source placement');
  if(sha(Buffer.from(placement.groupRecord.hex,'hex'))!==placement.groupRecord.sha256)throw Error('group source bytes changed');
  const references=resolveGroupReference({member:source.element,metadata:source.metadata,...placement});
  const reference=references.find(r=>r.referenceIndex===placement.referenceIndex);
  if(!reference)throw Error('missing group reference occurrence');
  solid=applyGroupReference(decoded,reference,reference.instance);
}else if(source.groupPlacement)throw Error('unexpected placement on standalone solid');
const origin=solid.verticesFeet[0].map(x=>x*0.3048),positions=Buffer.alloc(solid.verticesFeet.length*12),indices=Buffer.alloc(solid.triangles.length*3*2);
let maxQuantizationMm=0;const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
solid.verticesFeet.forEach((p,i)=>p.forEach((v,k)=>{const local=v*0.3048-origin[k];positions.writeFloatLE(local,i*12+k*4);const q=positions.readFloatLE(i*12+k*4);maxQuantizationMm=Math.max(maxQuantizationMm,Math.abs(q-local)*1000);min[k]=Math.min(min[k],q);max[k]=Math.max(max[k],q);}));
solid.triangles.flat().forEach((v,i)=>indices.writeUInt16LE(v,i*2));if(maxQuantizationMm>0.01)throw Error('Float32 budget');
const document={asset:{version:'2.0',generator:'DeepMonkey source-planar-solid research'},scene:0,scenes:[{nodes:[0]}],
  nodes:[{name:`Source ${source.element}`,mesh:0,translation:origin,extras:{sourceId:`rvt:${source.sourceSha256}:element:${source.element}`,...(solid.instancePath?{instancePath:solid.instancePath,placement:solid.placement}:{})}}],
  meshes:[{primitives:solid.faces.map((f,i)=>({attributes:{POSITION:0},indices:i+1,mode:4,extras:{sourceElement:source.element,sourceFace:f.id}}))}],
  buffers:[{byteLength:positions.length+indices.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.length,target:34962},{buffer:0,byteOffset:positions.length,byteLength:indices.length,target:34963}],
  accessors:[{bufferView:0,componentType:5126,count:solid.verticesFeet.length,type:'VEC3',min,max},...solid.faces.map((f,i)=>({bufferView:1,byteOffset:(f.triangleStart??i*2)*6,componentType:5123,count:(f.triangleCount??2)*3,type:'SCALAR'}))],
  extras:{quality:holed?'source-holed-planar-solid-preview':'source-planar-solid-preview',profile:holed?'rvt-2024-33-plane-single-hole':'rvt-2024-six-plane-twelve-edge',sourceSha256:source.sourceSha256,productionProfilesCertified:0}};
const json=Buffer.from(JSON.stringify(document)),padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);
const bin=Buffer.concat([positions,indices]),glb=Buffer.alloc(28+padded.length+bin.length);glb.writeUInt32LE(0x46546c67);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(padded.length,12);glb.writeUInt32LE(0x4e4f534a,16);padded.copy(glb,20);glb.writeUInt32LE(bin.length,20+padded.length);glb.writeUInt32LE(0x004e4942,24+padded.length);bin.copy(glb,28+padded.length);
await mkdir(output);await writeFile(path.join(output,'source-solid.glb'),glb,{flag:'wx'});
const report={schemaVersion:1,sourceSha256:source.sourceSha256,sourceRecord:{...record,hex:undefined},metadata:source.metadata,solid,profile,maxQuantizationMm,glbSha256:sha(glb),
  inputSha256:inputs.map(sha),limitations:['single-source-version-profile','sketch-placement-not-decoded','no-production-worker']};
await writeFile(path.join(output,'evidence.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({element:solid.element,sourceFaces:solid.faces.length,vertices:solid.verticesFeet.length,triangles:solid.triangles.length,lowerFeet:solid.lowerFeet,upperFeet:solid.upperFeet,volumeCubicFeet:solid.volumeCubicFeet,maxQuantizationMm}));
