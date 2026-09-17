import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tessellateTrimmedCylinderFace } from './3dm-cylinder-trim.mts';
import { proveCylinderAxis } from './3dm-cylinder-axis-proof.mts';
import { completeBrepParts } from './3dm-brep-tessellation.mts';
import { export3dmGlb } from './3dm-glb-export.mts';
import { auditGlbGeometry } from '../../apps/api/src/converterOutputAudit.ts';
import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/multispan-bicubic-2026-09-17-v1/axis');
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),{Triangle,Vector3}=require('three');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(readFileSync(path)),'848271e98cf83a72c6d0fa134dc7a430d2f4d938a4c38765dcc6da0bff8d8978');
const run=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(run.status,0,run.stderr);const source=JSON.parse(run.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;
const orient=(a:number[],b:number[],c:number[])=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
test('actual three-segment axis preserves PointAt, source boundaries and GLB face 11',async()=>{
  const part=tessellateTrimmedCylinderFace(ir,11,.001),mesh=part.mesh,surface=ir.surfaces[ir.faces[11].surface];
  assert.equal(part.audit.axisProof?.segments,3);assert(part.audit.axisProof!.equivalenceBound<1e-12);
  const triangles=mesh.triangles.map(t=>new Triangle(...t.map(i=>new Vector3(...mesh.positions[i]))));
  let references=0,maxPointAtDistance=0;
  for(const sample of surface.parameterEvidence) {
    const inside=mesh.triangles.some(t=>{const [a,b,c]=t.map(i=>part.audit.uv[i]),p=sample.source;
      const signs=[orient(a,b,p),orient(b,c,p),orient(c,a,p)];return signs.every(x=>x>=-1e-12)||signs.every(x=>x<=1e-12);});
    if(!inside)continue;references++;
    const p=new Vector3(...sample.point),near=new Vector3();let distance=Infinity;
    for(const triangle of triangles)distance=Math.min(distance,p.distanceTo(triangle.closestPointToPoint(p,near)));
    maxPointAtDistance=Math.max(maxPointAtDistance,distance);
  }
  assert(references>100);assert(maxPointAtDistance<part.audit.physicalBoundMm);
  const edges=new Map<string,number>(),boundary=new Set<string>(),key=(a:number,b:number)=>[a,b].sort((a,b)=>a-b).join(':');
  for(const t of mesh.triangles)for(let i=0;i<3;i++){const k=key(t[i],t[(i+1)%3]);edges.set(k,(edges.get(k)??0)+1);}
  for(const b of part.boundaryEdges)for(let i=1;i<b.vertices.length;i++){const k=key(b.vertices[i-1],b.vertices[i]);boundary.add(k);assert.equal(edges.get(k),1);}
  assert([...edges].every(([k,n])=>n===2||n===1&&boundary.has(k)));assert(triangles.every(t=>t.getArea()>1e-14));
  const noCache=structuredClone(source);for(const o of noCache.objects)if(o.kind==='brep')o.storedRenderMeshes=[];
  assert.equal(completeBrepParts(noCache.objects.find((o:any)=>o.cadIr),.001).parts.length,14);
  const result=await export3dmGlb(noCache,sha(readFileSync(path)));assert(result.bytes);mkdirSync(out,{recursive:true});
  const glb=resolve(out,'MechPartB.glb');writeFileSync(glb,result.bytes);const audit=await auditGlbGeometry(glb);
  const bytes=Buffer.from(result.bytes),json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
  const primitive=json.meshes.flatMap((m:any)=>m.primitives).find((p:any)=>p.extras.brepFaceIndex===11);
  assert.equal(primitive.extras.geometrySource,'cad-ir-trimmed-cylinder');
  const evidence={sourceSha256:sha(readFileSync(path)),sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm',
    useBoundary:'official sample; local verification only; not redistributed',archiveVersion:source.archiveVersion,metersPerUnit:source.metersPerUnit,
    face:11,vertices:mesh.positions.length,triangles:mesh.triangles.length,references,maxPointAtDistance,axisProof:part.audit.axisProof,
    physicalBoundMm:part.audit.physicalBoundMm,audit,glbSha256:sha(result.bytes),status:result.sidecar.status};
  writeFileSync(resolve(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
});
test('non-affine control positions, weight drift, discontinuity and reparameterization refuse',()=>{
  const s=ir.surfaces[ir.faces[11].surface],before=JSON.stringify(s);
  for(const change of [(c:any)=>c.controlPoints[1][0]+=.0001,(c:any)=>c.controlPoints[5][3]+=.0001,
    (c:any)=>c.knots[0][2]=c.knots[0][1],(c:any)=>c.knots[0][2]+=.01]) {
    const copy=structuredClone(s);change(copy);assert.throws(()=>proveCylinderAxis(copy,0),/cylinder-axis/);
  }
  assert.equal(JSON.stringify(s),before);
});
test('transposed axes preserve the same source geometry and opposite parameter orientation',()=>{
  const copy=structuredClone(ir),face=copy.faces[11],s=copy.surfaces[face.surface],before=tessellateTrimmedCylinderFace(ir,11,.001);
  const [nu,nv]=s.controlPointCount;s.controlPoints=Array.from({length:nu},(_,u)=>Array.from({length:nv},(_,v)=>s.controlPoints[v*nu+u])).flat();
  for(const key of ['degree','controlPointCount','domain','knots','closed','periodic'])s[key].reverse();
  for(const li of face.loops)for(const ti of copy.loops[li].trims)for(const p of copy.curves2d[copy.trims[ti].curve2d].controlPoints)[p[0],p[1]]=[p[1],p[0]];
  const after=tessellateTrimmedCylinderFace(copy,11,.001);assert.equal(after.audit.curvedAxis,1-before.audit.curvedAxis);
  assert.equal(after.audit.axisProof?.segments,3);
  const original=ir.surfaces[ir.faces[11].surface],support=original.analyticSupport;
  const radial=(p:number[])=>{const d=p.map((x,i)=>x-support.center[i]),h=d.reduce((s,x,i)=>s+x*support.axis[i],0);return d.map((x,i)=>x-h*support.axis[i]);};
  const sign=Math.sign(before.mesh.normals[0].reduce((sum,x,i)=>sum+x*radial(before.mesh.positions[0])[i],0));
  for(let i=0;i<after.mesh.positions.length;i++) {
    const p=after.mesh.positions[i],expected=evaluateSurface(original,[...after.audit.uv[i]].reverse());
    assert(Math.hypot(...p.map((x,j)=>x-expected[j]))<1e-9);
    assert.equal(Math.sign(after.mesh.normals[i].reduce((sum,x,j)=>sum+x*radial(p)[j],0)),-sign);
  }
});
