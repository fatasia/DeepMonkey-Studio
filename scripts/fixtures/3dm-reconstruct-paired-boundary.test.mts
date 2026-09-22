import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {completeBrepParts} from './3dm-brep-tessellation.mts';
import {reconstructPairedBoundaries} from './3dm-reconstruct-paired-boundary.mts';
import {auditBrepBoundaries} from './3dm-brep-boundary-audit.mts';
import {proveSourceBoundary} from './3dm-source-boundary-proof.mts';
import {evaluateCurve} from './3dm-nurbs-parameters.mjs';
import {export3dmGlb} from './3dm-glb-export.mts';
import {auditGlbGeometry} from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/paired-reconstruction-2026-09-18');
const sourcePath=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex'),sourceSha256='a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31';
assert.equal(sha(readFileSync(sourcePath)),sourceSha256);
const run=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[sourcePath,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(run.status,0,run.stderr);
const source=JSON.parse(run.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;
object.storedRenderMeshes=[];
// 显式保留上一阶段作为消融基线；默认链及全量GLB在下方独立验收。
const baseline=completeBrepParts(object,.001,{reconstructPairedBoundaries:false});
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));

test('real edge93 becomes conforming with all previous neighbours, seams and source identity preserved',()=>{
  const immutable=JSON.stringify(ir),before=JSON.stringify(baseline.parts),result=reconstructPairedBoundaries(ir,baseline.parts,.001);
  assert.deepEqual(result.records.map(r=>r.edge),[93]);
  const audit=auditBrepBoundaries(ir,result.parts),record=result.records[0];
  assert.equal(audit.shared.filter(e=>!e.conforming).length,48);assert.equal(result.parts.length,41);
  assert.equal(audit.seams.length,7);assert(audit.seams.every(s=>s.conforming));assert.equal(audit.unverified.length,0);
  assert(audit.shared.find(e=>e.edge===93).conforming);
  const quantized=result.parts.filter(p=>[39,40].includes(p.face)).map(p=>({...p,mesh:{...p.mesh,positions:p.mesh.positions.map((v:number[])=>v.map(Math.fround))}}));
  assert(auditBrepBoundaries(ir,quantized).shared.find(e=>e.edge===93).conforming,'Float32 output boundary must remain conforming');
  assert(baseline.boundaryAudit.shared.filter(e=>e.conforming).every(e=>audit.shared.find(a=>a.edge===e.edge).conforming));
  assert(record.maxMovement>0&&record.maxMovement<=record.sourceBound&&record.physicalBoundMm<=.01);
  assert(record.synchronization.proofs.every((p:any)=>p.physicalBoundMm<=.01));
  for(const old of baseline.parts){
    const part=result.parts.find(p=>p.face===old.face);
    if(![39,40].includes(old.face)){assert.deepEqual(part,old);continue;}
    const moved=new Set(record.source.map((v:any)=>v.vertex));
    for(let i=0;i<old.mesh.positions.length;i++){
      assert.deepEqual(part.mesh.normals[i],old.mesh.normals[i]);
      if(old.face!==39||!moved.has(i))assert.deepEqual(part.mesh.positions[i],old.mesh.positions[i]);
    }
    const proof=proveSourceBoundary(ir,part,93),c3=ir.curves3d[ir.edges[93].curve3d],domain=ir.edges[93].sourceSubdomain;
    for(let i=0;i<proof.boundary.vertices.length;i++){
      const t=domain[0]+proof.toBoundaryParameter(i)*(domain[1]-domain[0]);
      assert(distance(evaluateCurve(c3,t),part.mesh.positions[proof.boundary.vertices[i]])<1e-10);
    }
  }
  assert.equal(JSON.stringify(ir),immutable);assert.equal(JSON.stringify(baseline.parts),before);
  assert.equal(reconstructPairedBoundaries(ir,result.parts,.001).records.length,0);
  mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'reconstruction.json'),JSON.stringify({sourceSha256,record,audit},null,2));
});

test('source tampering, exhausted budget and inverted triangles roll back both faces',()=>{
  for(const fault of ['source','budget','winding','mesh']){
    const copy=structuredClone(ir),pair=baseline.parts.filter(p=>[39,40].includes(p.face)).map(p=>structuredClone(p));
    const curved=pair.find(p=>p.face===39);
    if(fault==='source')copy.curves3d[copy.edges[93].curve3d].controlPoints[1][0]+=.01;
    if(fault==='budget')curved.audit.physicalBoundMm=.01;
    if(fault==='winding')curved.mesh.triangles[0].reverse();
    if(fault==='mesh')curved.mesh.positions[curved.boundaryEdges.find((b:any)=>b.edge===93).vertices[1]][0]+=.01;
    const before=JSON.stringify(pair),result=reconstructPairedBoundaries(copy,pair,.001);
    assert.equal(result.records.length,0,fault);assert(result.failures.some(f=>f.edge===93));assert.equal(JSON.stringify(pair),before);
  }
});

test('default GLB export closes five certified edges and retains full geometry and preview quality',async()=>{
  const glb=await export3dmGlb(source,sourceSha256);assert(glb.bytes);
  assert.equal(glb.sidecar.status,'partial-geometry-preview');
  const boundary=glb.sidecar.boundaryAudits.find((a:any)=>a.objectId===object.id);
  assert.equal(boundary.shared.filter((e:any)=>!e.conforming).length,44);
  assert.deepEqual(boundary.pairedBoundaryReconstructions.map((r:any)=>r.edge),[69,71,79,81,93]);
  assert(boundary.shared.find((e:any)=>e.edge===93).conforming);
  assert(boundary.seams.every((e:any)=>e.conforming));assert.equal(boundary.seams.length,7);
  assert(baseline.boundaryAudit.shared.filter(e=>e.conforming).every(e=>boundary.shared.find((n:any)=>n.edge===e.edge)?.conforming));
  const {NodeIO}=createRequire(new URL('../../apps/api/package.json',import.meta.url))('@gltf-transform/core');
  const document=await new NodeIO().readBinary(glb.bytes),primitives=document.getRoot().listMeshes()[0].listPrimitives();
  const previousPath=resolve(out,'MechPartA.glb'),previousBytes=existsSync(previousPath)?readFileSync(previousPath):(await export3dmGlb(source,sourceSha256,{reconstructPairedBoundaries:false,repairFloat32:false})).bytes;
  assert(previousBytes);const comparisonGlbSha256=sha(previousBytes);
  assert(['e3d9efa7c1d967ea10b15a9a184a26acb1a2e0db5ea67fb1170a883d8995bc3a','82a84b95a08661260f3e2a42965b58698d70868245abe9a27efe6edb9a006523'].includes(comparisonGlbSha256));
  const previous=await new NodeIO().readBinary(previousBytes);
  const collapseCounts=(list:any[])=>list.map(primitive=>{const p=primitive.getAttribute('POSITION').getArray(),indices=primitive.getIndices().getArray();let count=0;
    for(let i=0;i<indices.length;i+=3){const ids=Array.from(indices.slice(i,i+3)) as number[],points=ids.map(id=>Array.from(p.slice(id*3,id*3+3)) as number[]),u=points[1].map((x,j)=>x-points[0][j]),v=points[2].map((x,j)=>x-points[0][j]);
      if(Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])===0)count++;}
    return {face:primitive.getExtras().brepFaceIndex,count};});
  const beforeCollapsed=collapseCounts(previous.getRoot().listMeshes()[0].listPrimitives()),afterCollapsed=collapseCounts(primitives);
  console.log(JSON.stringify({float32CollapsedBefore:beforeCollapsed.filter(p=>p.count),float32CollapsedAfter:afterCollapsed.filter(p=>p.count)}));
  for(const p of afterCollapsed)assert(p.count<=beforeCollapsed.find(b=>b.face===p.face)!.count,`Float32 collapse regression face ${p.face}`);
  assert(afterCollapsed.every(p=>p.count===0),'default output must have no Float32 collapsed triangles');
  const repaired=primitives.filter((p:any)=>p.getExtras().tessellationAudit.float32InteriorRepair);
  assert.deepEqual(repaired.map((p:any)=>p.getExtras().brepFaceIndex),[9,10]);
  const key=(p:number[])=>p.map(Math.fround).join(','),edgeKey=(a:string,b:string)=>a<b?`${a}|${b}`:`${b}|${a}`;
  const actual=new Map<number,Map<string,number>>();
  for(const primitive of primitives){
    const positions=primitive.getAttribute('POSITION').getArray(),indices=primitive.getIndices().getArray(),edges=new Map<string,number>();
    const at=(i:number)=>Array.from(positions.slice(i*3,i*3+3)) as number[];
    for(let i=0;i<indices.length;i+=3){const ids=Array.from(indices.slice(i,i+3)) as number[],p=ids.map(at);
      for(let j=0;j<3;j++){const k=edgeKey(key(p[j]),key(p[(j+1)%3]));edges.set(k,(edges.get(k)??0)+1);}
    }
    actual.set(primitive.getExtras().brepFaceIndex,edges);
    const bound=primitive.getExtras().tessellationAudit.physicalBoundMm;
    if(bound!==undefined)assert(bound<=.01);
  }
  for(const r of boundary.pairedBoundaryReconstructions){
    const curve=ir.curves3d[ir.edges[r.edge].curve3d],points=r.synchronization.parameters.map((t:number)=>key(evaluateCurve(curve,t)));
    for(const side of r.synchronization.proofs)for(let i=1;i<points.length;i++)
      assert.equal(actual.get(side.face)?.get(edgeKey(points[i-1],points[i])),1,`actual Float32 GLB edge ${r.edge}, face ${side.face}, segment ${i}`);
  }
  const groupOut=resolve(root,'test-output/industrial-3dm/float32-interior-2026-09-18');
  mkdirSync(groupOut,{recursive:true});const file=resolve(groupOut,'MechPartA.glb');writeFileSync(file,glb.bytes);
  const geometry=await auditGlbGeometry(file);assert.equal(geometry.primitiveCount,41);
  assert(geometry.vertexCount>=48067&&geometry.triangleCount>=85632);
  const evidence={sourceSha256,sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm',
    useBoundary:'official sample; local verification only; not redistributed',
    baselineGlbSha256:'82a84b95a08661260f3e2a42965b58698d70868245abe9a27efe6edb9a006523',comparisonGlbSha256,glbSha256:sha(glb.bytes),geometry,boundary,beforeCollapsed,afterCollapsed,status:glb.sidecar.status};
  writeFileSync(resolve(groupOut,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({hash:evidence.glbSha256,geometry,nonconforming:44,record:boundary.pairedBoundaryReconstructions.map((r:any)=>({edge:r.edge,maxMovement:r.maxMovement,
    prior:r.priorPhysicalBoundMm,reconstructed:r.physicalBoundMm,finalProofs:r.synchronization.proofs}))}));
});
