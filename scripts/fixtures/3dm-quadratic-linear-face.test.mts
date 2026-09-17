import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tessellateRationalBezierFace } from './3dm-rational-bezier-face.mts';
import { rationalBezierBounds } from './3dm-rational-bezier-bounds.mts';
import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { completeBrepParts } from './3dm-brep-tessellation.mts';
import { export3dmGlb } from './3dm-glb-export.mts';
import { auditGlbGeometry } from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/common-knot-2026-09-17-v1/quadratic');
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),{Triangle,Vector3}=require('three');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex'),sourceSha256='a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31';
assert.equal(sha(readFileSync(path)),sourceSha256);
const run=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(run.status,0,run.stderr);const source=JSON.parse(run.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;
const faces=[25,26,29,30,34,35,37,39];
const orient=(a:number[],b:number[],c:number[])=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const contains=(part:any,p:number[])=>part.mesh.triangles.some((t:number[])=>{const [a,b,c]=t.map(i=>part.audit.uv[i]),signs=[orient(a,b,p),orient(b,c,p),orient(c,a,p)];
  return signs.every(x=>x>=-1e-12)||signs.every(x=>x<=1e-12);});
test('eight real quadratic-linear faces preserve original PointAt, source knots, boundary topology and whole-model preview',async()=>{
  const before=JSON.stringify(ir),records:any[]=[];
  for(const face of faces){
    const part=tessellateRationalBezierFace(ir,face,.001),mesh=part.mesh,s=ir.surfaces[ir.faces[face].surface];
    const triangles=mesh.triangles.map(t=>new Triangle(...t.map(i=>new Vector3(...mesh.positions[i]))));let count=0,error=0;
    for(const sample of s.parameterEvidence){if(!contains(part,sample.source))continue;count++;
      const p=new Vector3(...sample.point),near=new Vector3();let distance=Infinity;
      for(const triangle of triangles)distance=Math.min(distance,p.distanceTo(triangle.closestPointToPoint(p,near)));error=Math.max(error,distance);}
    assert(count>=100);assert(error<=part.audit.physicalBoundMm);assert(part.audit.physicalBoundMm<=.01);
    const edges=new Map<string,number>(),boundary=new Set<string>(),key=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`;
    for(let i=0;i<mesh.triangles.length;i++){const t=mesh.triangles[i];for(const id of t)assert(triangles[i].getNormal(new Vector3()).dot(new Vector3(...mesh.normals[id]))>0);
      for(let j=0;j<3;j++){const k=key(t[j],t[(j+1)%3]);edges.set(k,(edges.get(k)??0)+1);}
      for(let axis=0;axis<2;axis++)for(const knot of s.knots[axis]){const a=t.map(id=>part.audit.uv[id][axis]);assert(!(Math.min(...a)<knot-1e-11&&Math.max(...a)>knot+1e-11));}}
    for(const b of part.boundaryEdges)for(let i=1;i<b.vertices.length;i++){const k=key(b.vertices[i-1],b.vertices[i]);boundary.add(k);assert.equal(edges.get(k),1);}
    assert([...edges].every(([k,n])=>n===2||n===1&&boundary.has(k)));assert.equal(mesh.positions.length-edges.size+triangles.length,1);
    records.push({face,vertices:mesh.positions.length,triangles:triangles.length,references:count,maxPointAtDistanceMm:error,physicalBoundMm:part.audit.physicalBoundMm,
      patches:part.audit.patches,divisions:part.audit.divisions,windingRefinement:part.audit.windingRefinement});
  }
  assert.equal(JSON.stringify(ir),before);const noCache=structuredClone(source);for(const o of noCache.objects)if(o.kind==='brep')o.storedRenderMeshes=[];
  const parts=completeBrepParts(noCache.objects.find((o:any)=>o.cadIr),.001);assert.equal(parts.parts.length,41);
  assert.equal(parts.boundaryAudit.allFacesPresent,true);assert.notEqual(parts.boundaryAudit.status,'conforming-two-sided-boundary');
  const glb=await export3dmGlb(noCache,sourceSha256);assert(glb.bytes);assert.equal(glb.sidecar.status,'partial-geometry-preview');
  mkdirSync(out,{recursive:true});const glbPath=resolve(out,'MechPartA.glb');writeFileSync(glbPath,glb.bytes);
  const bytes=Buffer.from(glb.bytes),json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
  assert.deepEqual(json.meshes.flatMap((m:any)=>m.primitives).filter((p:any)=>p.extras.geometrySource==='cad-ir-rational-bezier-chain'&&faces.includes(p.extras.brepFaceIndex)).map((p:any)=>p.extras.brepFaceIndex),faces);
  const evidence={sourceSha256,sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm',
    archiveVersion:source.archiveVersion,metersPerUnit:.001,useBoundary:'official sample; local verification only; not redistributed',records,
    audit:await auditGlbGeometry(glbPath),boundaryAudit:parts.boundaryAudit,glbSha256:sha(glb.bytes),status:glb.sidecar.status};
  writeFileSync(resolve(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({records:records.map(({patches,...r})=>r),audit:evidence.audit}));
});
test('quotient-rule tangents match finite differences on every source span and weight scaling is invariant',()=>{
  for(const face of [25,34,39]){const s=ir.surfaces[ir.faces[face].surface],b=rationalBezierBounds(s);
    for(const patch of b.patches){const uv=patch.domain.map(d=>(d[0]+d[1])/2),tangents=b.tangent(uv);
      for(let axis=0;axis<2;axis++){const h=(patch.domain[axis][1]-patch.domain[axis][0])*1e-5,a=[...uv],c=[...uv];a[axis]-=h;c[axis]+=h;
        const p=evaluateSurface(s,a),q=evaluateSurface(s,c);assert(Math.hypot(...p.map((x:number,i:number)=>(q[i]-x)/(2*h)-tangents[axis][i]))<1e-6);}}
    const scaled=structuredClone(s);scaled.controlPoints=scaled.controlPoints.map((p:number[])=>p.map(x=>x*7));const other=rationalBezierBounds(scaled);
    assert(b.first.every((x,i)=>Math.abs(x-other.first[i])<1e-9));assert(b.second.every((x,i)=>Math.abs(x-other.second[i])<1e-8));}
});
test('holes, reversal and refusal cases preserve source geometry and physical limits',()=>{
  const before=tessellateRationalBezierFace(ir,34,.001),copy=structuredClone(ir);copy.faces[34].reversed=!copy.faces[34].reversed;
  const reversed=tessellateRationalBezierFace(copy,34,.001);assert.equal(reversed.mesh.positions.length,before.mesh.positions.length);
  for(let i=0;i<reversed.mesh.positions.length;i++){const p=reversed.mesh.positions[i],j=before.mesh.positions.findIndex(q=>Math.hypot(...p.map((x,k)=>x-q[k]))<1e-10);
    assert(j>=0);assert(reversed.mesh.normals[i].every((x,k)=>Math.abs(x+before.mesh.normals[j][k])<1e-10));}
  const hole=structuredClone(ir),face=hole.faces[34],s=hole.surfaces[face.surface],center=s.domain.map((d:number[])=>(d[0]+d[1])/2),r=.01;
  const corners=[[-r,-r],[r,-r],[r,r],[-r,r]].map(p=>p.map((x,i)=>x+center[i])),loop=hole.loops.length,trims:number[]=[];
  for(let i=0;i<4;i++){const curve=hole.curves2d.length;hole.curves2d.push({dimension:2,degree:1,rational:false,parameterMap:{kind:'identity'},knots:[0,0,1,1],controlPoints:[corners[i],corners[(i+1)%4]]});
    trims.push(hole.trims.length);hole.trims.push({curve2d:curve,edge:-1,loop,sourceSubdomain:[0,1],curveReversed:false});}
  hole.loops.push({face:34,type:2,trims});face.loops.push(loop);const part=tessellateRationalBezierFace(hole,34,.001);
  assert.equal(part.audit.holeCount,1);assert.equal(contains(part,center),false);
  assert.throws(()=>tessellateRationalBezierFace(ir,34,0),/unit/);assert.throws(()=>tessellateRationalBezierFace(ir,34,10000),/budget/);
  for(const change of [(s:any)=>s.controlPoints[0][3]=0,(s:any)=>s.controlPoints[0][0]=NaN,(s:any)=>s.knots[0][4]+=.001,(s:any)=>s.parameterMap.kind='unknown']){
    const bad=structuredClone(ir);change(bad.surfaces[bad.faces[34].surface]);assert.throws(()=>tessellateRationalBezierFace(bad,34,.001));}
});
