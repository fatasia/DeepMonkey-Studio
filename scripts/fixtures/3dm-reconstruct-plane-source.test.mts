import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {completeBrepParts} from './3dm-brep-tessellation.mts';
import {reconstructPlaneSourceEdges} from './3dm-reconstruct-plane-source.mts';
import {provePlaneC3Map} from './3dm-plane-c3-map.mts';
import {evaluateCurve,evaluateSurface} from './3dm-nurbs-parameters.mjs';
import {export3dmGlb} from './3dm-glb-export.mts';
import {auditGlbGeometry} from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/plane-reconstruction-2026-09-17-v1');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex'),sourceSha256='a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31';
assert.equal(sha(readFileSync(path)),sourceSha256);const native=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(native.status,0,native.stderr);const source=JSON.parse(native.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;object.storedRenderMeshes=[];
const sourceBefore=JSON.stringify(ir),baseline=completeBrepParts(object,.001,{reconstructPlaneBoundaries:false}),edges=[62,65,74,76],distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
test('four real plane boundaries reconstruct within continuous source budgets and preserve unrelated vertices',async()=>{
  const complete=completeBrepParts(object,.001),records=complete.planeSourceReconstructions;assert.deepEqual(records.map(r=>r.edge),edges);
  assert.equal(complete.parts.length,41);assert.equal(complete.boundaryAudit.shared.filter(e=>!e.conforming).length,49);assert(complete.boundaryAudit.seams.every(s=>s.conforming));assert.equal(complete.boundaryAudit.unverified.length,0);
  let references=0,maxReferenceError=0,maxMappedError=0;
  for(const record of records){const proof=provePlaneC3Map(ir,record.face,record.edge,.001),c2=ir.curves2d[ir.trims[proof.trim].curve2d],c3=proof.curve;
    assert(record.continuousBound<=.0005&&record.maxMovement<=record.continuousBound+record.snapBound&&record.physicalBoundMm<=.01);
    for(const c of [c2,c3])for(const sample of c.parameterEvidence){references++;maxReferenceError=Math.max(maxReferenceError,distance(evaluateCurve(c,sample.source),sample.point.slice(0,c.dimension)));}
    for(const segment of proof.segments)for(let i=0;i<=32;i++){const f=i/32,t=segment.source[0]+f*(segment.source[1]-segment.source[0]),q=segment.target[0]+f*(segment.target[1]-segment.target[0]);
      const error=distance(evaluateSurface(proof.surface,evaluateCurve(c2,t)),evaluateCurve(c3,q));assert(error<=segment.bound);maxMappedError=Math.max(maxMappedError,error);}
    assert(complete.boundaryAudit.shared.find(e=>e.edge===record.edge).conforming);
  }
  for(const old of baseline.parts){const part=complete.parts.find(p=>p.face===old.face),moved=new Set(records.filter(r=>r.face===old.face).flatMap(r=>r.source.map((v:any)=>v.vertex)));
    for(let i=0;i<old.mesh.positions.length;i++){assert.deepEqual(part.mesh.normals[i],old.mesh.normals[i]);if(!moved.has(i))assert.deepEqual(part.mesh.positions[i],old.mesh.positions[i]);}
    if(![25,26,29,30,33].includes(old.face))assert.deepEqual(part,old);
  }
  assert.equal(JSON.stringify(ir),sourceBefore);assert(references>=304&&maxReferenceError<1e-10);
  const glb=await export3dmGlb(source,sourceSha256);assert(glb.bytes);assert.equal(glb.sidecar.status,'partial-geometry-preview');mkdirSync(out,{recursive:true});const glbPath=resolve(out,'MechPartA.glb');writeFileSync(glbPath,glb.bytes);
  const evidence={sourceSha256,sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm',archiveVersion:source.archiveVersion,metersPerUnit:.001,useBoundary:'official sample; local verification only; not redistributed',
    records,references,maxReferenceError,maxMappedError,boundaryAudit:complete.boundaryAudit,glb:await auditGlbGeometry(glbPath),glbSha256:sha(glb.bytes),status:glb.sidecar.status};writeFileSync(resolve(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({references,maxReferenceError,maxMappedError,glb:evidence.glb,hash:evidence.glbSha256}));
});
test('source, winding and exhausted physical budgets reject without partial mesh changes',()=>{
  for(const fault of ['source','winding','budget']){const copy=structuredClone(ir),pair=baseline.parts.filter(p=>[25,33].includes(p.face)).map(p=>structuredClone(p)),plane=pair.find(p=>p.face===33);
    if(fault==='source')copy.curves3d[copy.edges[62].curve3d].controlPoints[2][2]+=.001;
    if(fault==='winding')plane.mesh.triangles[0].reverse();if(fault==='budget')plane.audit.physicalBoundMm=.01;
    const before=JSON.stringify(pair),result=reconstructPlaneSourceEdges(copy,pair,.001);assert.equal(result.records.length,0,fault);assert(result.failures.some(f=>f.edge===62));assert.equal(JSON.stringify(pair),before);
  }
});
