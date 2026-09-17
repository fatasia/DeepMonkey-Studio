import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tessellatePlanarFace } from './3dm-planar-trim.mts';
import { tessellateCylinderFace } from './3dm-cylinder-tessellation.mts';
import { completeBrepParts } from './3dm-brep-tessellation.mts';
import { auditBrepBoundaries } from './3dm-brep-boundary-audit.mts';
import { export3dmGlb } from './3dm-glb-export.mts';
import { auditGlbGeometry } from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/3dm-source-audit');
const evidenceOut=resolve(root,'test-output/industrial-3dm/self-seam-2026-09-17-v1/boundaries');mkdirSync(evidenceOut,{recursive:true});
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),{Triangle,Vector3}=require('three');
const sha=(bytes:any)=>createHash('sha256').update(bytes).digest('hex');
function load(relative:string,hash:string){
  const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files',relative);
  assert.equal(sha(readFileSync(path)),hash);const run=spawnSync(resolve(out,'3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
  assert.equal(run.status,0,run.stderr);return JSON.parse(run.stdout);
}
test('real MechPartB diagnoses independent boundary sampling and refines only source-consistent cylinder',async()=>{
  const hash='848271e98cf83a72c6d0fa134dc7a430d2f4d938a4c38765dcc6da0bff8d8978',source=load('V4/v4_MechPartB.3dm',hash);
  const object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;object.storedRenderMeshes=[];
  const raw:any[]=[];for(let face=0;face<ir.faces.length;face++)try{
    const kind=ir.surfaces[ir.faces[face].surface].analyticSupport?.kind;raw.push(kind==='cylinder'?tessellateCylinderFace(ir,face):tessellatePlanarFace(ir,face));
  }catch{}
  const before=auditBrepBoundaries(ir,raw),completed=completeBrepParts(object),after=completed.boundaryAudit!;
  assert.equal(before.shared.length,19);assert.deepEqual(before.shared.filter(e=>!e.conforming).map(e=>e.edge),[13,16]);
  assert.deepEqual(before.shared.find(e=>e.edge===13).segmentCounts,[8,32]);
  assert.deepEqual(after.shared.filter(e=>!e.conforming).map(e=>e.edge),[16]);
  assert.deepEqual(after.shared.find(e=>e.edge===13).segmentCounts,[32,32]);assert(after.shared.find(e=>e.edge===13).maxSampledDeviation<1e-8);
  assert.equal(after.allFacesPresent,false);assert.equal(completed.refinements?.length,1);
  assert.deepEqual(completed.parts.find(p=>p.face===5),raw.find(p=>p.face===5),'source-inconsistent face remains unchanged');
  assert(completed.diagnostics.some(d=>d.code==='adjacent-boundary-not-on-source-cylinder'));
  const refined=completed.parts.find(p=>p.face===4),surface=ir.surfaces[ir.faces[4].surface];
  const triangles=refined.mesh.triangles.map((t:number[])=>new Triangle(...t.map(i=>new Vector3(...refined.mesh.positions[i]))));
  let maxOriginalPointAtDistance=0;
  for(const sample of surface.parameterEvidence){
    if(sample.source.some((x:number,a:number)=>x<refined.audit.domain[a][0]||x>refined.audit.domain[a][1]))continue;
    const p=new Vector3(...sample.point),q=new Vector3();let error=Infinity;
    for(const triangle of triangles)error=Math.min(error,p.distanceTo(triangle.closestPointToPoint(p,q)));
    maxOriginalPointAtDistance=Math.max(maxOriginalPointAtDistance,error);
  }
  assert(maxOriginalPointAtDistance<refined.audit.controlHullBound);assert.equal(refined.mesh.positions.length,66);
  const glb=await export3dmGlb(source,hash);assert(glb.bytes);assert.equal(glb.sidecar.status,'partial-geometry-preview');
  assert(glb.sidecar.boundaryAudits.some((a:any)=>a.objectId===object.id&&a.shared.some((e:any)=>e.edge===16&&!e.conforming)));
  const path=resolve(evidenceOut,'v4_MechPartB.boundaries.glb');writeFileSync(path,glb.bytes);const glbAudit=await auditGlbGeometry(path);
  const evidence={sourceSha256:hash,sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm',
    useBoundary:'official sample; local verification only; not redistributed',before,after,refinements:completed.refinements,
    sourceEdge16Tolerance:ir.edges[16].tolerance,diagnostics:completed.diagnostics,maxOriginalPointAtDistance,glbAudit,glbSha256:sha(glb.bytes)};
  writeFileSync(resolve(evidenceOut,'boundary-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({refinements:completed.refinements,maxOriginalPointAtDistance,glbAudit}));
});
let boxIr:any,boxParts:any[],boxSource:any;
test('actual V4 six-face box has shared source edges and independently welded closed-shell topology',async()=>{
  const hash='da90b35d40b7df1b9150b6f754f0448a6208f27fc7eca1b0547a8d0f165ad10d',source=load('V4/v4_example_file.3dm',hash);
  const object=source.objects.find((o:any)=>o.faceCount===6);object.storedRenderMeshes=[];object.definitionMember=false;
  const result=completeBrepParts(object);boxIr=object.cadIr;boxParts=result.parts;
  assert.equal(result.boundaryAudit?.status,'conforming-two-sided-boundary');assert.equal(result.boundaryAudit.shared.length,12);
  const points:number[][]=[],edges=new Map<string,{count:number,balance:number}>();let volume=0,faceCount=0;
  for(const part of result.parts){
    const indices=part.mesh.positions.map((p:number[])=>{let i=points.findIndex(q=>Math.hypot(...p.map((x,j)=>x-q[j]))<1e-8);if(i<0){i=points.length;points.push(p);}return i;});
    for(const t of part.mesh.triangles){faceCount++;const [a,b,c]=t.map((i:number)=>part.mesh.positions[i]);
      volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
      for(let i=0;i<3;i++){const u=indices[t[i]],v=indices[t[(i+1)%3]],key=u<v?`${u}:${v}`:`${v}:${u}`,e=edges.get(key)??{count:0,balance:0};e.count++;e.balance+=u<v?1:-1;edges.set(key,e);}
    }
  }
  assert.equal(points.length,8);assert.equal(faceCount,12);assert.equal(edges.size,18);assert.equal(points.length-edges.size+faceCount,2);
  assert([...edges.values()].every(e=>e.count===2&&e.balance===0));assert(Math.abs(volume)>1e-6);
  boxSource={...source,objects:[object],definitions:[]};
  const glb=await export3dmGlb(boxSource,hash);assert(glb.bytes);assert.equal(glb.sidecar.status,'geometry-preview');
  const evidence={sourceSha256:hash,sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_example_file.3dm',
    useBoundary:'official sample; local verification only; not redistributed',objectId:object.id,boundaryAudit:result.boundaryAudit,
    weldedVertices:points.length,edges:edges.size,triangles:faceCount,euler:2,signedVolume:volume,glbSha256:sha(glb.bytes)};
  writeFileSync(resolve(evidenceOut,'closed-box-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({objectId:object.id,volume}));
});
test('missing faces, altered winding and omitted triangle boundaries cannot pass seam evidence',()=>{
  assert.equal(auditBrepBoundaries(boxIr,boxParts.slice(1)).allFacesPresent,false);
  const reversed=structuredClone(boxParts);reversed[0].mesh.triangles.forEach((t:number[])=>[t[1],t[2]]=[t[2],t[1]]);
  assert(auditBrepBoundaries(boxIr,reversed).shared.some(e=>e.orientationErrors>0));
  const missing=structuredClone(boxParts);missing[0].mesh.triangles.pop();assert(auditBrepBoundaries(boxIr,missing).shared.some(e=>e.invalidBoundarySegments>0));
});
test('all faces present with a displaced source plane stays partial preview rather than hiding the seam',async()=>{
  const source=structuredClone(boxSource),ir=source.objects[0].cadIr,surface=ir.surfaces[ir.faces[0].surface];
  for(const point of surface.controlPoints)point[2]+=.001;
  const result=await export3dmGlb(source,'a'.repeat(64));assert(result.bytes);assert.equal(result.sidecar.status,'partial-geometry-preview');
  assert(result.sidecar.diagnostics.some((d:any)=>d.code==='nonconforming-brep-boundary'));
  assert.equal(result.sidecar.boundaryAudits[0].allFacesPresent,true);
});
