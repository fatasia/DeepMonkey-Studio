import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceEdgeChain,auditSourceEdgeChain } from './3dm-source-edge-chain.mts';
import { completeBrepParts } from './3dm-brep-tessellation.mts';
import { export3dmGlb } from './3dm-glb-export.mts';
import { auditBrepBoundaries } from './3dm-brep-boundary-audit.mts';
import { auditGlbGeometry } from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/source-edge-chain-2026-09-17-v1');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex'),sourceSha256='848271e98cf83a72c6d0fa134dc7a430d2f4d938a4c38765dcc6da0bff8d8978';
assert.equal(sha(readFileSync(path)),sourceSha256);
const run=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(run.status,0,run.stderr);const source=JSON.parse(run.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;
const conflicts=[3,4,6,8,9,10,11,16,27];
const segmentDistance=(p:number[],a:number[],b:number[])=>{
  const d=b.map((x,i)=>x-a[i]),length=d.reduce((s,x)=>s+x*x,0),t=length?Math.max(0,Math.min(1,d.reduce((s,x,i)=>s+x*(p[i]-a[i]),0)/length)):0;
  return Math.hypot(...p.map((x,i)=>x-a[i]-t*d[i]));
};
test('all nine actual seams have certified source budget conflicts and retain their fourteen faces',async()=>{
  const before=JSON.stringify(ir),records=conflicts.map(e=>auditSourceEdgeChain(ir,e,.001));
  assert(records.every(r=>r.status==='source-budget-conflict'));
  assert.deepEqual(records.filter(r=>r.uses.some((u:any)=>u.exceedsPhysicalBudget)).map(r=>r.edge),[3,10]);
  assert.deepEqual(records.filter(r=>r.uses.some((u:any)=>u.exceedsDeclaredTolerance)).map(r=>r.edge),[4,6,8,9,11,16,27]);
  let references=0,maxPointAtToChain=0;
  for(const record of records){assert(record.parameters.every((x,i)=>!i||x>record.parameters[i-1]));
    const curve=ir.curves3d[ir.edges[record.edge].curve3d];
    for(const sample of curve.parameterEvidence){let d=Infinity;references++;
      for(let i=1;i<record.points.length;i++)d=Math.min(d,segmentDistance(sample.point,record.points[i-1],record.points[i]));
      assert(d<=record.chordBound+1e-10);maxPointAtToChain=Math.max(maxPointAtToChain,d);}}
  assert(references>=333);assert.equal(JSON.stringify(ir),before);
  const noCache=structuredClone(source);for(const o of noCache.objects)if(o.kind==='brep')o.storedRenderMeshes=[];
  const reconstructed=completeBrepParts(noCache.objects.find((o:any)=>o.cadIr),.001);assert.equal(reconstructed.parts.length,14);
  const boundary=auditBrepBoundaries(ir,reconstructed.parts);assert.deepEqual(boundary.shared.filter((e:any)=>!e.conforming).map((e:any)=>e.edge),conflicts);
  const glb=await export3dmGlb(noCache,sourceSha256);assert(glb.bytes);assert.equal(glb.sidecar.status,'partial-geometry-preview');
  assert.equal(sha(glb.bytes),'367949d8126ef2ae0a0d0e0e1eb9c97951f4db0054492a9df475322fa73d619a');
  mkdirSync(out,{recursive:true});const glbPath=resolve(out,'MechPartB.glb');writeFileSync(glbPath,glb.bytes);
  const evidence={sourceSha256,sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm',
    archiveVersion:source.archiveVersion,metersPerUnit:.001,useBoundary:'official sample; local verification only; not redistributed',
    references,maxPointAtToChain,records,boundary,glb:await auditGlbGeometry(glbPath),glbSha256:sha(glb.bytes),status:glb.sidecar.status};
  writeFileSync(resolve(out,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(records.map(r=>({edge:r.edge,tolerance:r.declaredTolerance,lowerBounds:r.uses.map((u:any)=>({face:u.face,bound:u.witness.lowerBound}))}))));
});
test('source edge direction references share one chain without moving points or mutating source',()=>{
  const a=sourceEdgeChain(ir,8,.001),copy=structuredClone(ir);copy.trims[a.uses[0].trim].reverse3d=!copy.trims[a.uses[0].trim].reverse3d;
  const b=sourceEdgeChain(copy,8,.001);assert.deepEqual(a.points,b.points);assert.deepEqual(a.parameters,b.parameters);
  assert.equal(a.uses[0].direction,-b.uses[0].direction);assert.equal(a.uses[1].direction,b.uses[1].direction);
  copy.edges[8].curveReversed=!copy.edges[8].curveReversed;const c=sourceEdgeChain(copy,8,.001);
  assert(c.uses.every((u:any,i:number)=>u.direction===-b.uses[i].direction));
});
test('an exact shared line is not falsely rejected or promoted to a certified repair',()=>{
  const line={dimension:3,degree:1,rational:false,parameterMap:{kind:'identity'},knots:[0,0,1,1],controlPoints:[[0,0,0],[1,0,0]]};
  const plane={dimension:3,degree:[1,1],controlPointCount:[2,2],rational:false,parameterMap:{kind:'identity'},domain:[[0,1],[0,1]],
    knots:[[0,0,1,1],[0,0,1,1]],controlPoints:[[0,0,0],[1,0,0],[0,1,0],[1,1,0]]};
  const fixture={edges:[{curve3d:0,vertices:[0,1],sourceSubdomain:[0,1],tolerance:.001}],curves3d:[line],
    curves2d:[{...line,dimension:2,controlPoints:[[0,0],[1,0]]}],surfaces:[plane,structuredClone(plane)],
    faces:[{surface:0},{surface:1}],loops:[{face:0},{face:1}],trims:[0,1].map(loop=>({edge:0,loop,curve2d:0,sourceSubdomain:[0,1],reverse3d:!!loop}))};
  const exact=auditSourceEdgeChain(fixture,0,.001);assert.equal(exact.status,'not-certified-for-repair');
  assert(exact.uses.every((u:any)=>u.witness.lowerBound===0));
  fixture.surfaces[1].controlPoints.forEach(p=>p[2]=.002);const gap=auditSourceEdgeChain(fixture,0,.001);
  assert.equal(gap.status,'source-budget-conflict');assert(gap.uses[1].witness.lowerBound>.0019);
});
test('unknown units, unsupported topology and impossible proof resolution fail without partial mutations',()=>{
  assert.throws(()=>sourceEdgeChain(ir,8,0),/unit/);assert.throws(()=>auditSourceEdgeChain(ir,8,.001,1),/samples/);
  const copy=structuredClone(ir),use=sourceEdgeChain(copy,8,.001).uses[0];copy.trims[use.trim].edge=-1;
  assert.throws(()=>sourceEdgeChain(copy,8,.001),/topology/);
  const tiny=structuredClone(ir);tiny.edges[8].tolerance=1e-30;const before=JSON.stringify(tiny);
  assert.throws(()=>auditSourceEdgeChain(tiny,8,.001),/budget/);assert.equal(JSON.stringify(tiny),before);
});
