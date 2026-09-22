import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {sourceProfiles} from './lib/rvtSourceProfiles.mjs';
const [input,output,glbOutput]=process.argv.slice(2);
if(!input||!output||!glbOutput)throw Error('line-evidence.json new-profiles.json new-wire.glb');
const bytes=await readFile(input),report=JSON.parse(bytes),profiles=sourceProfiles(report);
const closed=profiles.filter(p=>p.status==='closed-source-wire'),byElement=new Map(report.lines.map(l=>[l.element,l]));
const document={asset:{version:'2.0',generator:'DeepMonkey source-curve research'},scene:0,scenes:[{nodes:[]}],nodes:[],meshes:[],buffers:[{byteLength:0}],bufferViews:[],accessors:[],
  extras:{quality:'source-curve-preview',buildingSolidGeometry:'missing',sourceSha256:report.sourceSha256}};
const chunks=[];let offset=0,maxQuantizationMm=0,totalLines=0;
for(const profile of closed){
  const ids=profile.loops.flatMap(l=>l.elements),points=ids.flatMap(id=>byElement.get(id).endpointsFeet);
  const origin=points[0].map(v=>v*0.3048),buffer=Buffer.alloc(points.length*12),min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  points.forEach((p,i)=>p.forEach((v,k)=>{
    const local=v*0.3048-origin[k];buffer.writeFloatLE(local,i*12+k*4);
    const quantized=buffer.readFloatLE(i*12+k*4);maxQuantizationMm=Math.max(maxQuantizationMm,Math.abs(local-quantized)*1000);
    min[k]=Math.min(min[k],quantized);max[k]=Math.max(max[k],quantized);
  }));
  const n=document.nodes.length;document.scenes[0].nodes.push(n);
  document.nodes.push({name:`Source sketch ${profile.owner}`,mesh:n,translation:origin,extras:{sourceOwner:profile.owner}});
  document.meshes.push({primitives:[{mode:1,attributes:{POSITION:n},extras:{sourceElements:ids}}]});
  document.bufferViews.push({buffer:0,byteOffset:offset,byteLength:buffer.length,target:34962});
  document.accessors.push({bufferView:n,componentType:5126,count:points.length,type:'VEC3',min,max});
  chunks.push(buffer);offset+=buffer.length;totalLines+=ids.length;
}
if(!closed.length||maxQuantizationMm>0.01)throw Error('No source profiles or quantization exceeds 0.01 mm');
document.buffers[0].byteLength=offset;
const json=Buffer.from(JSON.stringify(document)),padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);
const glb=Buffer.alloc(12+8+padded.length+8+offset);glb.writeUInt32LE(0x46546c67);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);
glb.writeUInt32LE(padded.length,12);glb.writeUInt32LE(0x4e4f534a,16);padded.copy(glb,20);
const bin=20+padded.length;glb.writeUInt32LE(offset,bin);glb.writeUInt32LE(0x004e4942,bin+4);Buffer.concat(chunks).copy(glb,bin+8);
const sha=b=>createHash('sha256').update(b).digest('hex');
await writeFile(glbOutput,glb,{flag:'wx'});
const summary={owners:profiles.length,closed:closed.length,sourceLinesInGlb:totalLines,maxQuantizationMm};
await writeFile(output,JSON.stringify({schemaVersion:1,sourceSha256:report.sourceSha256,lineEvidenceSha256:sha(bytes),wireGlbSha256:sha(glb),
  quality:'source-curve-preview',buildingSolidGeometry:'missing',summary,profiles},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(summary));
