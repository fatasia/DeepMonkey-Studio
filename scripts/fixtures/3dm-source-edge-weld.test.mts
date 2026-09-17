import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tessellatePlanarFace } from './3dm-planar-trim.mts';
import { tessellateCylinderFace } from './3dm-cylinder-tessellation.mts';
import { weldSourceEdges } from './3dm-source-edge-weld.mts';
import { auditBrepBoundaries } from './3dm-brep-boundary-audit.mts';
import { evaluateCurve,evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { export3dmGlb } from './3dm-glb-export.mts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/3dm-source-audit');
const evidenceOut=resolve(root,'test-output/industrial-3dm/multispan-cylinder-2026-09-17-v1/source-edge');mkdirSync(evidenceOut,{recursive:true});
const hash='848271e98cf83a72c6d0fa134dc7a430d2f4d938a4c38765dcc6da0bff8d8978';
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm');
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
let source:any,ir:any,raw:any[];
function verifySourceEdges(result:any,sourceIr:any){
  const observations:any[]=[];
  for(const record of result.records){
    const edge=sourceIr.edges[record.edge],curve=sourceIr.curves3d[edge.curve3d],plane=result.parts.find((p:any)=>p.face===record.planeFace);
    const boundary=plane.boundaryEdges.find((b:any)=>b.edge===record.edge),points=boundary.vertices.map((i:number)=>plane.mesh.positions[i]);
    let maxCurvePointAtError=0,maxSharedBoundaryResidual=0;
    for(const sample of curve.parameterEvidence)maxCurvePointAtError=Math.max(maxCurvePointAtError,distance(evaluateCurve(curve,sample.mapped),sample.point));
    for(let i=0;i<points.length;i++)maxSharedBoundaryResidual=Math.max(maxSharedBoundaryResidual,distance(points[i],evaluateCurve(curve,record.sourceEdgeParameters[i])));
    assert(maxCurvePointAtError<1e-10);assert(maxSharedBoundaryResidual<1e-8);
    assert(record.maxBoundaryCorrection<=record.declaredEdgeTolerance+1e-10);
    assert(Math.max(record.planeErrorBound,record.cylinderErrorBound,record.edgeErrorBound)<=record.totalBudgetSource);
    observations.push({edge:record.edge,maxCurvePointAtError,maxSharedBoundaryResidual});
  }return observations;
}
test('actual source C3 controls edge 13 while underestimated declared tolerance rejects edge 16',async()=>{
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),hash);
  const run=spawnSync(resolve(out,'3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
  assert.equal(run.status,0,run.stderr);source=JSON.parse(run.stdout);const object=source.objects.find((o:any)=>o.cadIr);ir=object.cadIr;object.storedRenderMeshes=[];raw=[];
  for(let face=0;face<ir.faces.length;face++)try{raw.push(ir.surfaces[ir.faces[face].surface].analyticSupport?.kind==='cylinder'?tessellateCylinderFace(ir,face):tessellatePlanarFace(ir,face));}catch{}
  const before=JSON.stringify(raw),result=weldSourceEdges(ir,raw,source.metersPerUnit);assert.equal(JSON.stringify(raw),before);
  assert.deepEqual(result.records.map(r=>r.edge),[13]);const failure=result.failures.find(f=>f.edge===16);
  assert.equal(failure?.code,'source-edge-declared-tolerance-exceeded');assert(failure.detail.maxBoundaryCorrection>failure.detail.declaredEdgeTolerance);
  const trim=ir.trims.find((t:any)=>t.edge===16&&ir.loops[t.loop].face===12),planeSurface=ir.surfaces[ir.faces[12].surface],support=ir.surfaces[ir.faces[5].surface].analyticSupport;
  const maxNativeTrimCylinderResidual=Math.max(...ir.curves2d[trim.curve2d].parameterEvidence.map((sample:any)=>{
    const p=evaluateSurface(planeSurface,sample.point.slice(0,2)),delta=p.map((x:number,i:number)=>x-support.center[i]);
    const h=delta.reduce((s:number,x:number,i:number)=>s+x*support.axis[i],0);
    return Math.abs(Math.hypot(...delta.map((x:number,i:number)=>x-h*support.axis[i]))-support.radius);
  }));assert(maxNativeTrimCylinderResidual>ir.edges[16].tolerance);
  const observed=verifySourceEdges(result,ir),glb=await export3dmGlb(source,hash);assert(glb.bytes);
  assert.equal(glb.sidecar.status,'partial-geometry-preview');assert(glb.sidecar.boundaryAudits.some((a:any)=>a.welds.some((w:any)=>w.edge===13)));
  const b=Buffer.from(glb.bytes),json=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());
  const primitive=json.meshes.flatMap((m:any)=>m.primitives).find((p:any)=>p.extras.brepFaceIndex===13);
  assert.equal(primitive.extras.sourceSha256,hash);assert.equal(primitive.extras.tessellationAudit.sourceEdgeWelds[0].edge,13);
  const evidence={sourceSha256:hash,sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm',
    useBoundary:'official sample; local verification only; not redistributed',records:result.records,failures:result.failures,observed,maxNativeTrimCylinderResidual,
    glbSha256:createHash('sha256').update(glb.bytes).digest('hex')};writeFileSync(resolve(evidenceOut,'source-edge-weld-evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({records:result.records.map(({sourceEdgeParameters,...r})=>r),failures:result.failures,observed}));
});
test('controlled larger declaration repairs real trim geometry without consuming geometry budget twice',()=>{
  const control=structuredClone(ir);control.edges[16].tolerance=.0002;
  const result=weldSourceEdges(control,raw,.001);assert.deepEqual(result.records.map(r=>r.edge),[13,16],JSON.stringify(result.failures));assert.equal(result.failures.length,0);
  verifySourceEdges(result,control);const audit=auditBrepBoundaries(control,result.parts);assert(audit.shared.every(e=>e.conforming));assert.equal(audit.allFacesPresent,false);
  const record=result.records.find(r=>r.edge===16)!;assert(record.maxBoundaryCorrection>.00013&&record.maxBoundaryCorrection<.0002);
  assert(record.maxPlaneResidual<1e-8&&record.maxCylinderResidual<1e-8);assert(record.planeErrorBound>.00113&&record.planeErrorBound<.01);
  // This altered tolerance is a controlled test, not an acceptance claim for the original file.
  writeFileSync(resolve(evidenceOut,'source-edge-weld-control.json'),JSON.stringify({scope:'controlled edge tolerance on real source geometry; not source-authored declaration',records:result.records},null,2));
});
test('units, total budget, monotonic topology and endpoint identity gate every proposed repair',()=>{
  assert.throws(()=>weldSourceEdges(ir,raw,.001,.02),/budget/);assert.throws(()=>weldSourceEdges(ir,raw,0),/budget/);
  const meterResult=weldSourceEdges(ir,raw,1);assert.equal(meterResult.records.length,0);assert(meterResult.failures.every(f=>f.code==='source-edge-total-budget-exceeded'));
  const tight=weldSourceEdges(ir,raw,.001,.0005);assert.equal(tight.records.length,0);
  const unproved=structuredClone(ir);unproved.edges[16].tolerance=.00014;
  assert(weldSourceEdges(unproved,raw,.001).failures.some(f=>f.edge===16&&f.code==='continuous-source-edge-tolerance-exceeded'));
  const wrong=structuredClone(raw),boundary=wrong.find((p:any)=>p.face===13).boundaryEdges.find((b:any)=>b.edge===13);
  [boundary.vertices[1],boundary.vertices[2]]=[boundary.vertices[2],boundary.vertices[1]];
  const topology=weldSourceEdges(ir,wrong,.001);assert(topology.failures.some(f=>f.code==='non-monotonic-source-edge-weld'));
  const endpoints=structuredClone(ir);endpoints.curves3d[endpoints.edges[13].curve3d].controlPoints[0][0]+=.001;
  assert(weldSourceEdges(endpoints,raw,.001).failures.some(f=>f.edge===13&&f.code==='source-edge-vertex-mismatch'));
});
