import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { completeBrepParts } from './3dm-brep-tessellation.mts';
import { auditBrepBoundaries } from './3dm-brep-boundary-audit.mts';
import { evaluateCurve,evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { export3dmGlb } from './3dm-glb-export.mts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/plane-reconstruction-2026-09-17-v1/self-seam');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex'),sourceSha256='a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31';
assert.equal(sha(readFileSync(path)),sourceSha256);
const run=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(run.status,0,run.stderr);const source=JSON.parse(run.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;
object.storedRenderMeshes=[];const complete=completeBrepParts(object,.001),seamEdges=[0,38,43,85,87,90,92];
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
test('seven real periodic seams have independent source identities and matching oriented mesh sides',async()=>{
  const before=JSON.stringify(complete.parts),audit=auditBrepBoundaries(ir,complete.parts);
  assert.deepEqual(audit.seams.map(e=>e.edge),seamEdges);assert(audit.seams.every(e=>e.conforming));assert.equal(audit.unverified.length,0);
  assert.equal(audit.shared.filter(e=>!e.conforming).length,49);assert.equal(audit.allFacesPresent,true);
  let curveReferences=0,trimReferences=0,maxCurveError=0,maxTrimError=0;
  for(const seam of audit.seams){const edge=ir.edges[seam.edge],curve=ir.curves3d[edge.curve3d];
    for(const sample of curve.parameterEvidence){curveReferences++;maxCurveError=Math.max(maxCurveError,distance(evaluateCurve(curve,sample.source),sample.point));}
    for(const side of seam.seamProof.sides){const trim=ir.trims[side.trim],c2=ir.curves2d[trim.curve2d],surface=ir.surfaces[ir.faces[seam.faces[0]].surface];
      for(const sample of c2.parameterEvidence){trimReferences++;let t=(sample.source-trim.sourceSubdomain[0])/(trim.sourceSubdomain[1]-trim.sourceSubdomain[0]);
        if(Boolean(trim.reverse3d)!==Boolean(edge.curveReversed)!==Boolean(trim.curveReversed))t=1-t;
        maxTrimError=Math.max(maxTrimError,distance(evaluateSurface(surface,sample.point.slice(0,2)),evaluateCurve(curve,edge.sourceSubdomain[0]+t*(edge.sourceSubdomain[1]-edge.sourceSubdomain[0]))));}}
  }
  assert(curveReferences>=266&&trimReferences>=532);assert(maxCurveError<1e-10&&maxTrimError<1e-10);assert.equal(JSON.stringify(complete.parts),before);
  const glb=await export3dmGlb(source,sourceSha256);assert(glb.bytes);assert.equal(glb.sidecar.status,'partial-geometry-preview');
  assert.equal(sha(glb.bytes),'82a84b95a08661260f3e2a42965b58698d70868245abe9a27efe6edb9a006523');
  mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'MechPartA.glb'),glb.bytes);
  const evidence={sourceSha256,sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm',archiveVersion:source.archiveVersion,
    metersPerUnit:.001,useBoundary:'official sample; local verification only; not redistributed',curveReferences,trimReferences,maxCurveError,maxTrimError,
    seams:audit.seams,unverified:audit.unverified,nonconformingShared:49,glbSha256:sha(glb.bytes),status:glb.sidecar.status};
  writeFileSync(resolve(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({curveReferences,trimReferences,maxCurveError,maxTrimError}));
});
test('metadata alone cannot certify a seam and mesh defects remain explicit',()=>{
  for(const fault of ['type','closed','source','same-side','unclamped']){const copy=structuredClone(ir),trim=copy.trims[168],surface=copy.surfaces[copy.faces[34].surface];
    if(fault==='type')trim.type=2;if(fault==='closed')surface.closed[0]=false;
    if(fault==='source')copy.curves3d[copy.edges[85].curve3d].controlPoints[0][0]+=.001;
    if(fault==='unclamped')surface.knots[0][0]-=1;
    if(fault==='same-side'){const c=copy.curves2d[trim.curve2d];for(const p of c.controlPoints)p[0]=surface.domain[0][1];}
    assert(auditBrepBoundaries(copy,complete.parts).unverified.some(e=>e.edge===85),fault);
  }
  for(const fault of ['position','omit','winding','both-off-source']){const parts=structuredClone(complete.parts),part=parts.find(p=>p.face===34),boundary=part.boundaryEdges.find(b=>b.trim===168);
    if(fault==='both-off-source')for(const p of part.mesh.positions)p[0]+=.001;
    if(fault==='position')part.mesh.positions[boundary.vertices[1]][0]+=.001;
    if(fault==='omit')boundary.vertices.splice(1,1);
    if(fault==='winding'){const a=boundary.vertices[0],b=boundary.vertices[1],t=part.mesh.triangles.find(t=>t.includes(a)&&t.includes(b));[t[1],t[2]]=[t[2],t[1]];}
    const audit=auditBrepBoundaries(ir,parts);assert.equal(audit.seams.find(e=>e.edge===85).conforming,false,fault);assert.notEqual(audit.status,'conforming-two-sided-boundary');
  }
});
