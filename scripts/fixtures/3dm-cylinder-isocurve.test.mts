import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {completeBrepParts} from './3dm-brep-tessellation.mts';
import {synchronizeSourceEdges} from './3dm-synchronize-source-edges.mts';
import {tessellatePlanarFace} from './3dm-planar-trim.mts';
import {tessellateTrimmedCylinderFace} from './3dm-cylinder-trim.mts';
import {proveSourceBoundary} from './3dm-source-boundary-proof.mts';
import {evaluateCurve,evaluateSurface} from './3dm-nurbs-parameters.mjs';
import {export3dmGlb} from './3dm-glb-export.mts';
import {auditGlbGeometry} from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/plane-reconstruction-2026-09-17-v1');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex'),hash='a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31';
assert.equal(sha(readFileSync(path)),hash);const run=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(run.status,0,run.stderr);const source=JSON.parse(run.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;object.storedRenderMeshes=[];
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]),cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function raw(face:number):any{return [0,9,10].includes(face)?tessellateTrimmedCylinderFace(ir,face,.001):tessellatePlanarFace(ir,face);}
test('five actual full and partial cylinder-plane curves share source chains without changing old points or normals',async()=>{
  const before=JSON.stringify(ir),result=completeBrepParts(object,.001,{reconstructPairedBoundaries:false}),records=result.sourceEdgeSynchronizations.filter(r=>[1,34,37,39,42].includes(r.edge));
  assert.deepEqual(records.map(r=>r.edge),[1,34,37,39,42]);assert.equal(result.parts.length,41);assert.equal(result.boundaryAudit.shared.filter(e=>!e.conforming).length,49);
  assert.equal(result.boundaryAudit.unverified.length,0);assert(result.boundaryAudit.seams.every(e=>e.conforming));
  let references=0,maxReferenceError=0,trimReferences=0,maxTrimReferenceError=0;
  for(const record of records){assert(record.proofs.every(p=>p.continuousBound<1e-12&&p.physicalBoundMm<=.01));const edge=ir.edges[record.edge],curve=ir.curves3d[edge.curve3d];
    for(const sample of curve.parameterEvidence){references++;maxReferenceError=Math.max(maxReferenceError,distance(evaluateCurve(curve,sample.source),sample.point));}
    for(const p of record.proofs){const part=result.parts.find(x=>x.face===p.face),old=raw(p.face),proof=proveSourceBoundary(ir,part,record.edge);
      if([34,39].includes(record.edge)&&part.geometrySource==='cad-ir-trimmed-cylinder'){
        assert.equal(edge.tolerance,0);const trim=ir.trims[proof.boundary.trim],c2=ir.curves2d[trim.curve2d];
        for(const sample of c2.parameterEvidence){trimReferences++;const uv=sample.point.slice(0,2),t=(proof as any).toParameter(uv),point=evaluateCurve(curve,edge.sourceSubdomain[0]+t*(edge.sourceSubdomain[1]-edge.sourceSubdomain[0]));
          maxTrimReferenceError=Math.max(maxTrimReferenceError,distance(evaluateSurface(proof.surface,uv),point));}
      }
      assert.deepEqual(part.mesh.positions.slice(0,old.mesh.positions.length),old.mesh.positions);assert.deepEqual(part.mesh.normals.slice(0,old.mesh.normals.length),old.mesh.normals);
      for(const t of record.parameters){const uv=proof.toUv((t-edge.sourceSubdomain[0])/(edge.sourceSubdomain[1]-edge.sourceSubdomain[0]));assert(distance(evaluateSurface(proof.surface,uv),evaluateCurve(curve,t))<1e-10);}
      for(const t of part.mesh.triangles){const [a,b,c]=t.map(i=>part.mesh.positions[i]),n=cross(sub(b,a),sub(c,a));assert(t.every(i=>n.reduce((sum,x,j)=>sum+x*part.mesh.normals[i][j],0)>0));}
    }
  }
  assert.equal(JSON.stringify(ir),before);assert(references>=190&&maxReferenceError<1e-10);assert(trimReferences>=76&&maxTrimReferenceError<1e-12);
  const glb=await export3dmGlb(source,hash,{reconstructPairedBoundaries:false,repairFloat32:false});assert(glb.bytes);assert.equal(glb.sidecar.status,'partial-geometry-preview');mkdirSync(out,{recursive:true});
  const path=resolve(out,'MechPartA.glb');writeFileSync(path,glb.bytes);const evidence={sourceSha256:hash,sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm',archiveVersion:4,metersPerUnit:.001,useBoundary:'official sample; local verification only; not redistributed',records,references,maxReferenceError,trimReferences,maxTrimReferenceError,boundaryAudit:result.boundaryAudit,glb:await auditGlbGeometry(path),glbSha256:sha(glb.bytes),status:glb.sidecar.status};
  writeFileSync(resolve(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({references,maxReferenceError,glb:evidence.glb,hash:evidence.glbSha256}));
});
test('cylinder source mismatch, absent UV, wrong winding and budget exhaustion retain both original sides',()=>{
  for(const fault of ['source','uv','winding','budget']){const copy=structuredClone(ir),pair=[0,11].map(raw);
    if(fault==='source')copy.curves3d[copy.edges[1].curve3d].controlPoints[1][0]+=.001;
    if(fault==='uv')delete pair[0].audit.uv;
    if(fault==='winding')pair[0].mesh.triangles.forEach(t=>[t[1],t[2]]=[t[2],t[1]]);
    if(fault==='budget')pair[0].audit.physicalBoundMm=.02;
    const before=JSON.stringify(pair),result=synchronizeSourceEdges(copy,pair,.001);assert.equal(result.records.length,0,fault);assert(result.failures.some(f=>f.edge===1));assert.equal(JSON.stringify(pair),before);
  }
  const tilted=structuredClone(ir),part=raw(9),trim=part.boundaryEdges.find(b=>b.edge===34).trim;
  tilted.curves2d[tilted.trims[trim].curve2d].controlPoints[1][1]+=1e-11;
  assert.throws(()=>proveSourceBoundary(tilted,part,34),/source-curve-control-mismatch/,'tiny nonzero tilt must still consume the zero-tolerance budget');
});
