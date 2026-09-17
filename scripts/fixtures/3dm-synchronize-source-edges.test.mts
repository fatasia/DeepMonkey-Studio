import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { synchronizeSourceEdges } from './3dm-synchronize-source-edges.mts';
import { tessellateRationalBezierFace } from './3dm-rational-bezier-face.mts';
import { completeBrepParts } from './3dm-brep-tessellation.mts';
import { auditBrepBoundaries } from './3dm-brep-boundary-audit.mts';
import { evaluateCurve } from './3dm-nurbs-parameters.mjs';
import { export3dmGlb } from './3dm-glb-export.mts';
import { auditGlbGeometry } from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/isocurve-sync-2026-09-17-v1');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex'),sourceSha256='a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31';
assert.equal(sha(readFileSync(path)),sourceSha256);
const run=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(run.status,0,run.stderr);const source=JSON.parse(run.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
const repairedEdges=[45,48,54,57],repairedFaces=[12,14,16,17,18,20,22,23];
test('four actual zero-tolerance source curves synchronize without moving existing vertices or losing any face',async()=>{
  const before=JSON.stringify(ir),noCache=structuredClone(source);for(const o of noCache.objects)if(o.kind==='brep')o.storedRenderMeshes=[];
  const complete=completeBrepParts(noCache.objects.find((o:any)=>o.cadIr),.001);
  assert.equal(complete.parts.length,41);assert.deepEqual(complete.sourceEdgeSynchronizations.map(r=>r.edge),repairedEdges);
  const baseline=complete.parts.map(p=>repairedFaces.includes(p.face)?tessellateRationalBezierFace(ir,p.face,.001):p),initial=auditBrepBoundaries(ir,baseline);
  assert.equal(initial.shared.filter(e=>!e.conforming).length,69);
  assert.equal(complete.boundaryAudit.shared.filter(e=>!e.conforming).length,65);assert.equal(complete.boundaryAudit.unverified.length,7);
  assert(complete.boundaryAudit.unverified.every(e=>e.reason==='self-seam-not-audited'));let references=0,maxReferenceError=0;
  for(const record of complete.sourceEdgeSynchronizations){const c=ir.curves3d[ir.edges[record.edge].curve3d];
    assert.equal(ir.edges[record.edge].tolerance,0);assert(record.proofs.every(p=>p.continuousBound===0&&p.physicalBoundMm<=.01));
    const sides=record.proofs.map(proof=>complete.parts.find(p=>p.face===proof.face));
    for(const side of sides){const old=baseline.find(p=>p.face===side.face);assert.deepEqual(side.mesh.positions.slice(0,old.mesh.positions.length),old.mesh.positions);
      const boundary=side.boundaryEdges.find(b=>b.edge===record.edge);assert.equal(boundary.vertices.length,record.parameters.length);
      for(const t of record.parameters){const point=evaluateCurve(c,t);assert(Math.min(...boundary.vertices.map(i=>distance(side.mesh.positions[i],point)))<1e-10);}
      const edges=new Map<string,number>();for(const t of side.mesh.triangles)for(let j=0;j<3;j++){const key=[t[j],t[(j+1)%3]].sort((a,b)=>a-b).join(':');edges.set(key,(edges.get(key)??0)+1);}
      assert.equal(side.mesh.positions.length-edges.size+side.mesh.triangles.length,1);
    }
    for(const sample of c.parameterEvidence){references++;const d=distance(evaluateCurve(c,sample.source),sample.point);maxReferenceError=Math.max(maxReferenceError,d);assert(d<1e-10);}
  }
  assert(references>=152);assert.equal(JSON.stringify(ir),before);
  assert.equal(synchronizeSourceEdges(ir,complete.parts,.001).records.length,0);
  const glb=await export3dmGlb(noCache,sourceSha256);assert(glb.bytes);assert.equal(glb.sidecar.status,'partial-geometry-preview');mkdirSync(out,{recursive:true});
  const glbPath=resolve(out,'MechPartA.glb');writeFileSync(glbPath,glb.bytes);
  const groups:Record<string,number[]>={};for(const e of initial.shared.filter(e=>!e.conforming)){const c=ir.curves3d[ir.edges[e.edge].curve3d],key=`degree${c.degree}-${c.rational?'rational':'polynomial'}-cv${c.controlPoints.length}`;(groups[key]??=[]).push(e.edge);}
  const evidence={sourceSha256,sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm',archiveVersion:source.archiveVersion,metersPerUnit:.001,
    useBoundary:'official sample; local verification only; not redistributed',groups,initialUnverified:initial.unverified,records:complete.sourceEdgeSynchronizations,
    references,maxReferenceError,boundaryAudit:complete.boundaryAudit,audit:await auditGlbGeometry(glbPath),glbSha256:sha(glb.bytes),status:glb.sidecar.status};
  writeFileSync(resolve(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({records:evidence.records,audit:evidence.audit,maxReferenceError}));
});
test('source mismatch, mesh displacement, reversed triangle and budget exhaustion leave the original pair untouched',()=>{
  for(const fault of ['source','mesh','orientation','budget']){
    const copy=structuredClone(ir),pair=[12,16].map(face=>tessellateRationalBezierFace(copy,face,.001));
    if(fault==='source')copy.curves3d[copy.edges[45].curve3d].controlPoints[1][0]+=.00001;
    if(fault==='mesh'){const id=pair[0].boundaryEdges.find(b=>b.edge===45).vertices[1];pair[0].mesh.positions[id][0]+=.001;}
    if(fault==='orientation')pair[0].mesh.triangles=pair[0].mesh.triangles.map(t=>[t[0],t[2],t[1]]);
    if(fault==='budget')pair[0].audit.physicalBoundMm=.02;
    const before=JSON.stringify(pair),result=synchronizeSourceEdges(copy,pair,.001);
    assert.equal(result.records.length,0,fault);assert(result.failures.some(f=>f.edge===45),fault);assert.equal(JSON.stringify(pair),before);
  }
  assert.throws(()=>synchronizeSourceEdges(ir,[],0),/unit/);
});
