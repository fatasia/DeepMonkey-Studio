import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {completeBrepParts} from './3dm-brep-tessellation.mts';
import {synchronizeSourceEdges} from './3dm-synchronize-source-edges.mts';
import {tessellatePlanarFace} from './3dm-planar-trim.mts';
import {tessellateRationalBezierFace} from './3dm-rational-bezier-face.mts';
import {proveSourceBoundary} from './3dm-source-boundary-proof.mts';
import {evaluateCurve,evaluateSurface} from './3dm-nurbs-parameters.mjs';
import {export3dmGlb} from './3dm-glb-export.mts';
import {auditGlbGeometry} from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/plane-isocurve-2026-09-17-v1');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex'),hash='a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31';
assert.equal(sha(readFileSync(path)),hash);const run=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(run.status,0,run.stderr);const source=JSON.parse(run.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;object.storedRenderMeshes=[];
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
const fixed=[84,86,88,89,91];
function raw(face:number):any{return ir.surfaces[ir.faces[face].surface].degree.every((x:number)=>x===1)?tessellatePlanarFace(ir,face):tessellateRationalBezierFace(ir,face,.001);}
test('five plane/isocurve source identities produce common chains without moving old vertices',async()=>{
  const result=completeBrepParts(object,.001),records=result.sourceEdgeSynchronizations.filter(r=>fixed.includes(r.edge));
  assert.deepEqual(records.map(r=>r.edge),fixed);assert.equal(result.parts.length,41);assert.equal(result.boundaryAudit.shared.filter(e=>!e.conforming).length,60);
  assert.equal(result.boundaryAudit.unverified.length,0);assert(result.boundaryAudit.seams.every(e=>e.conforming));
  let references=0,maxReferenceError=0;
  for(const record of records){assert(record.proofs.every(p=>p.continuousBound<=1e-12&&p.physicalBoundMm<=.01));
    const c=ir.curves3d[ir.edges[record.edge].curve3d];
    for(const sample of c.parameterEvidence){references++;maxReferenceError=Math.max(maxReferenceError,distance(evaluateCurve(c,sample.source),sample.point));}
    for(const p of record.proofs){const part=result.parts.find(x=>x.face===p.face),before=raw(p.face),proof=proveSourceBoundary(ir,part,record.edge);
      assert.deepEqual(part.mesh.positions.slice(0,before.mesh.positions.length),before.mesh.positions);
      for(const t of record.parameters){const d=ir.edges[record.edge].sourceSubdomain,uv=proof.toUv((t-d[0])/(d[1]-d[0]));assert(distance(evaluateSurface(proof.surface,uv),evaluateCurve(c,t))<1e-10);}
      if(part.geometrySource==='cad-ir-affine-plane-trim')assert(Math.abs(part.audit.uvArea-part.audit.triangleUvArea)<1e-9);
    }
  }
  assert(references>=190&&maxReferenceError<1e-10);
  const glb=await export3dmGlb(source,hash);assert(glb.bytes);assert.equal(glb.sidecar.status,'partial-geometry-preview');
  mkdirSync(out,{recursive:true});const glbPath=resolve(out,'MechPartA.glb');writeFileSync(glbPath,glb.bytes);
  const evidence={sourceSha256:hash,sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm',archiveVersion:source.archiveVersion,metersPerUnit:.001,
    useBoundary:'official sample; local verification only; not redistributed',records,references,maxReferenceError,boundaryAudit:result.boundaryAudit,glb:await auditGlbGeometry(glbPath),glbSha256:sha(glb.bytes),status:glb.sidecar.status};
  writeFileSync(resolve(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({references,maxReferenceError,glb:evidence.glb,hash:evidence.glbSha256}));
});
test('source and mesh mutations reject transactionally; difficult inner circle remains explicit',()=>{
  for(const fault of ['source','weight','knot','mesh','parameters','budget']){const copy=structuredClone(ir),pair=[33,35].map(raw);
    if(fault==='source')copy.curves3d[copy.edges[86].curve3d].controlPoints[1][0]+=.00001;
    if(fault==='weight')copy.curves3d[copy.edges[86].curve3d].controlPoints[1][3]*=1.001;
    if(fault==='knot')copy.curves3d[copy.edges[86].curve3d].knots[3]+=1e-6;
    if(fault==='mesh')pair[0].mesh.positions[pair[0].boundaryEdges.find(b=>b.edge===86).vertices[1]][0]+=.001;
    if(fault==='parameters')delete pair[0].boundaryEdges.find(b=>b.edge===86).parameters;
    if(fault==='budget')pair[0].audit.physicalBoundMm=.02;
    const before=JSON.stringify(pair),result=synchronizeSourceEdges(copy,pair,.001);assert.equal(result.records.length,0,fault);assert.equal(JSON.stringify(pair),before);
  }
  const result=synchronizeSourceEdges(ir,[raw(24),raw(39)],.001);assert.equal(result.records.length,0);assert(result.failures.some(f=>f.edge===60&&f.code==='inverted-isocurve-refinement'));
});
