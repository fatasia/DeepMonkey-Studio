import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {provePairedBoundary,proveBezierCurveMap} from './3dm-paired-boundary-proof.mts';
import {evaluateCurve,evaluateSurface} from './3dm-nurbs-parameters.mjs';
import {export3dmGlb} from './3dm-glb-export.mts';
import {auditGlbGeometry} from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/paired-boundary-2026-09-18');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex');
const sourceSha256='a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31';
assert.equal(sha(readFileSync(path)),sourceSha256);
const native=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(native.status,0,native.stderr);
const source=JSON.parse(native.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;
object.storedRenderMeshes=[];
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));

test('actual edge93 has a certified two-sided continuous gap without inventing a weld',()=>{
  const before=JSON.stringify(ir),proof=provePairedBoundary(ir,93,.001),c3=ir.curves3d[ir.edges[93].curve3d];
  assert.deepEqual(provePairedBoundary(ir,93,.001),proof);
  assert.deepEqual(proof.faces,[40,39]);
  assert(proof.sourceBound<.0005&&proof.physicalBoundMm<.01);
  assert.equal(proof.status,'continuous-source-pair-certified-mesh-not-welded');
  let maxMappedError=0,referenceCount=0,maxReferenceError=0;
  for(const s of proof.mapping.segments)for(let i=0;i<=32;i++){
    const f=i/32,a=s.source[0]+f*(s.source[1]-s.source[0]),b=s.target[0]+f*(s.target[1]-s.target[0]);
    const error=distance(evaluateCurve(c3,a),evaluateCurve(proof.restrictedCurve,b));
    assert(error<=s.bound+1e-12);maxMappedError=Math.max(maxMappedError,error);
  }
  for(const c of [c3,...proof.trims.map((t:number)=>ir.curves2d[ir.trims[t].curve2d])])for(const p of c.parameterEvidence){
    referenceCount++;maxReferenceError=Math.max(maxReferenceError,distance(evaluateCurve(c,p.source),p.point.slice(0,c.dimension)));
  }
  const cylinder=ir.surfaces[ir.faces[39].surface],trim=ir.curves2d[ir.trims[proof.trims[1]].curve2d];
  for(const ref of trim.parameterEvidence){const uv=evaluateCurve(trim,ref.source),actual=evaluateSurface(cylinder,uv);
    assert(distance(actual,evaluateCurve(proof.restrictedCurve,uv[0]))<1e-10);}
  assert(referenceCount>=114&&maxReferenceError<1e-10);assert.equal(JSON.stringify(ir),before);
  mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'pair-proof.json'),JSON.stringify({sourceSha256,
    sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm',
    useBoundary:'official sample; local verification only; not redistributed',proof,referenceCount,maxReferenceError,maxMappedError},null,2));
});

test('unequal authored knot partitions have certified monotone maps on four real adjacent edges',()=>{
  const line=(xs:number[])=>({dimension:3,degree:1,rational:false,knots:[0,...xs.map((_,i)=>i),xs.length-1],controlPoints:xs.map(x=>[x,0,0])});
  assert.throws(()=>proveBezierCurveMap(line([0,.8,.2,1]),line([0,1]),.01),/endpoint/,'proposed target knot correspondence must remain globally monotone');
  for(const edge of [69,71,79,81]){
    const proof=provePairedBoundary(ir,edge,.001),curve=ir.curves3d[ir.edges[edge].curve3d];
    assert.equal(new Set(curve.knots).size,4);assert.equal(new Set(proof.restrictedCurve.knots).size,3);
    assert(proof.sourceBound<.002&&proof.mapping.segments.length>3);
    for(const segment of proof.mapping.segments)for(let i=0;i<=32;i++){
      const f=i/32,a=segment.source[0]+f*(segment.source[1]-segment.source[0]),b=segment.target[0]+f*(segment.target[1]-segment.target[0]);
      assert(distance(evaluateCurve(curve,a),evaluateCurve(proof.restrictedCurve,b))<=segment.bound+1e-12);
    }
    assert.throws(()=>proveBezierCurveMap(curve,proof.restrictedCurve,.0005),/budget/);
    const wrong=structuredClone(curve);wrong.controlPoints[3][0]+=.01;
    assert.throws(()=>proveBezierCurveMap(wrong,proof.restrictedCurve,.002),/endpoint/);
    const backtrack=structuredClone(curve);[backtrack.controlPoints[3],backtrack.controlPoints[6]]=[backtrack.controlPoints[6],backtrack.controlPoints[3]];
    assert.throws(()=>proveBezierCurveMap(backtrack,proof.restrictedCurve,.002));
  }
});

test('budget, topology, source mutation and invalid NURBS reject without modifying input',()=>{
  for(const fault of ['budget','source','topology','backtrack','weights','knots']){
    const copy=structuredClone(ir),edge=copy.edges[93],trim=copy.trims.find((t:any)=>t.edge===93&&copy.loops[t.loop].face===39);
    if(fault==='budget')edge.tolerance=1e-6;
    if(fault==='source')copy.curves3d[edge.curve3d].controlPoints[1][0]+=.02;
    if(fault==='topology')trim.edge=-1;
    if(fault==='backtrack')copy.curves2d[trim.curve2d].controlPoints[1][0]=-1;
    if(fault==='weights')copy.surfaces[copy.faces[39].surface].controlPoints[0][3]=-1;
    if(fault==='knots')copy.curves2d[trim.curve2d].knots[3]=Infinity;
    const before=JSON.stringify(copy);assert.throws(()=>provePairedBoundary(copy,93,.001),undefined,fault);assert.equal(JSON.stringify(copy),before);
  }
  assert.throws(()=>provePairedBoundary(ir,93,0),/unit/);
  const proof=provePairedBoundary(ir,93,.001);
  assert.throws(()=>proveBezierCurveMap(ir.curves3d[ir.edges[93].curve3d],proof.restrictedCurve,.0005,1),/budget/);
});

test('real GLB preserves every vertex and triangle while adding the pair certificate to sidecar',async()=>{
  const glb=await export3dmGlb(source,sourceSha256,{reconstructPairedBoundaries:false,repairFloat32:false});assert(glb.bytes);
  assert.equal(sha(glb.bytes),'82a84b95a08661260f3e2a42965b58698d70868245abe9a27efe6edb9a006523');
  assert.equal(glb.sidecar.status,'partial-geometry-preview');
  const boundary=glb.sidecar.boundaryAudits.find((a:any)=>a.objectId===object.id);
  assert.equal(boundary.shared.filter((e:any)=>!e.conforming).length,49);
  assert.equal(boundary.seams.length,7);assert(boundary.seams.every((e:any)=>e.conforming));
  assert.equal(boundary.shared.find((e:any)=>e.edge===93).conforming,false);
  assert.deepEqual(boundary.sourceBoundaryPairProofs.map((p:any)=>p.edge),[69,71,79,81,93]);
  mkdirSync(out,{recursive:true});const file=resolve(out,'MechPartA.glb');writeFileSync(file,glb.bytes);
  const geometry=await auditGlbGeometry(file);
  writeFileSync(resolve(out,'evidence.json'),JSON.stringify({sourceSha256,glbSha256:sha(glb.bytes),geometry,boundary,status:glb.sidecar.status},null,2));
  console.log(JSON.stringify({glbSha256:sha(glb.bytes),geometry,certifiedEdges:boundary.sourceBoundaryPairProofs.map((p:any)=>p.edge)}));
});
