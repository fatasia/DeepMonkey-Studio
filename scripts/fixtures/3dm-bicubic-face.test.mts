import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tessellateBicubicFace } from './3dm-bicubic-face.mts';
import { completeBrepParts } from './3dm-brep-tessellation.mts';
import { export3dmGlb } from './3dm-glb-export.mts';
import { auditGlbGeometry } from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/single-bicubic-2026-09-17-v1');
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),{Triangle,Vector3}=require('three');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(readFileSync(path)),'848271e98cf83a72c6d0fa134dc7a430d2f4d938a4c38765dcc6da0bff8d8978');
const run=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(run.status,0,run.stderr);const source=JSON.parse(run.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;
const orient=(a:number[],b:number[],c:number[])=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const contains=(part:any,p:number[])=>part.mesh.triangles.some((t:number[])=>{const [a,b,c]=t.map(i=>part.audit.uv[i]),signs=[orient(a,b,p),orient(b,c,p),orient(c,a,p)];
  return signs.every(x=>x>=-1e-12)||signs.every(x=>x<=1e-12);});
test('actual single bicubic face preserves original PointAt, topology, orientation and GLB',async()=>{
  const part=tessellateBicubicFace(ir,3,.001),mesh=part.mesh,surface=ir.surfaces[ir.faces[3].surface];
  const triangles=mesh.triangles.map(t=>new Triangle(...t.map(i=>new Vector3(...mesh.positions[i]))));let count=0,error=0;
  for(const sample of surface.parameterEvidence){if(!contains(part,sample.source))continue;count++;
    const p=new Vector3(...sample.point),near=new Vector3();let distance=Infinity;
    for(const triangle of triangles)distance=Math.min(distance,p.distanceTo(triangle.closestPointToPoint(p,near)));error=Math.max(error,distance);}
  assert(count>=200);assert(error<=part.audit.physicalBoundMm);
  const edges=new Map<string,number>(),boundaries=new Set<string>(),key=(a:number,b:number)=>[a,b].sort((a,b)=>a-b).join(':');
  for(const t of mesh.triangles)for(let i=0;i<3;i++){const k=key(t[i],t[(i+1)%3]);edges.set(k,(edges.get(k)??0)+1);}
  for(const b of part.boundaryEdges)for(let i=1;i<b.vertices.length;i++){const k=key(b.vertices[i-1],b.vertices[i]);boundaries.add(k);assert.equal(edges.get(k),1);}
  assert([...edges].every(([k,n])=>n===2||n===1&&boundaries.has(k)));assert.equal(mesh.positions.length-edges.size+triangles.length,1);
  for(let i=0;i<triangles.length;i++)assert(triangles[i].getNormal(new Vector3()).dot(new Vector3(...mesh.normals[mesh.triangles[i][0]]))>.95);
  const noCache=structuredClone(source);for(const o of noCache.objects)if(o.kind==='brep')o.storedRenderMeshes=[];
  assert.equal(completeBrepParts(noCache.objects.find((o:any)=>o.cadIr),.001).parts.length,13);
  const glb=await export3dmGlb(noCache,sha(readFileSync(path)));assert(glb.bytes);mkdirSync(out,{recursive:true});
  const glbPath=resolve(out,'MechPartB.glb');writeFileSync(glbPath,glb.bytes);const audit=await auditGlbGeometry(glbPath);
  const bytes=Buffer.from(glb.bytes),json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
  assert.equal(json.meshes.flatMap((m:any)=>m.primitives).find((p:any)=>p.extras.brepFaceIndex===3).extras.geometrySource,'cad-ir-single-bicubic');
  const evidence={sourceSha256:sha(readFileSync(path)),sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm',
    archiveVersion:source.archiveVersion,metersPerUnit:source.metersPerUnit,useBoundary:'official sample; local verification only; not redistributed',
    face:3,vertices:mesh.positions.length,triangles:triangles.length,referenceCount:count,maxPointAtDistanceMm:error,
    physicalBoundMm:part.audit.physicalBoundMm,derivativeBounds:part.audit.derivativeBounds,divisions:part.audit.divisions,audit,glbSha256:sha(glb.bytes),status:glb.sidecar.status};
  writeFileSync(resolve(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
});
test('controlled hole stays empty and face reversal flips exact source normals',()=>{
  const copy=structuredClone(ir),face=copy.faces[3],surface=copy.surfaces[face.surface],center=surface.domain.map((d:number[])=>(d[0]+d[1])/2),r=.01;
  const corners=[[-r,-r],[r,-r],[r,r],[-r,r]].map(p=>p.map((x,i)=>x+center[i])),loop=copy.loops.length,trims:number[]=[];
  for(let i=0;i<4;i++){const curve=copy.curves2d.length;copy.curves2d.push({dimension:2,degree:1,rational:false,parameterMap:{kind:'identity'},knots:[0,0,1,1],controlPoints:[corners[i],corners[(i+1)%4]]});
    trims.push(copy.trims.length);copy.trims.push({curve2d:curve,edge:-1,loop,sourceSubdomain:[0,1],curveReversed:false});}
  copy.loops.push({face:3,type:2,trims});face.loops.push(loop);const part=tessellateBicubicFace(copy,3,.001);
  assert.equal(part.audit.holeCount,1);assert.equal(contains(part,center),false);
  const before=tessellateBicubicFace(ir,3,.001);const reversed=structuredClone(ir);reversed.faces[3].reversed=!reversed.faces[3].reversed;
  const after=tessellateBicubicFace(reversed,3,.001);
  for(let i=0;i<after.mesh.positions.length;i++){const p=after.mesh.positions[i],index=before.mesh.positions.findIndex(q=>Math.hypot(...p.map((x,j)=>x-q[j]))<1e-9);
    assert(index>=0);assert(after.mesh.normals[i].every((x,j)=>Math.abs(x+before.mesh.normals[index][j])<1e-10));}
});
test('multispan, rational, invalid knots, singular normal and unbounded precision refuse',()=>{
  assert.throws(()=>tessellateBicubicFace(ir,1,.001),/unsupported-single-bicubic/);
  assert.throws(()=>tessellateBicubicFace(ir,3,0),/physical-unit/);
  assert.throws(()=>tessellateBicubicFace(ir,3,10000),/budget/);
  for(const change of [(s:any)=>s.rational=true,(s:any)=>s.knots[0][2]+=.01,(s:any)=>s.controlPoints=s.controlPoints.map(()=>[0,0,0])]){
    const copy=structuredClone(ir);change(copy.surfaces[copy.faces[3].surface]);assert.throws(()=>tessellateBicubicFace(copy,3,.001));}
});
