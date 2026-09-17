import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tessellateTrimmedCylinderFace } from './3dm-cylinder-trim.mts';
import { completeBrepParts } from './3dm-brep-tessellation.mts';
import { export3dmGlb } from './3dm-glb-export.mts';
import { auditGlbGeometry } from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/plane-isocurve-2026-09-17-v1/nonrect');
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),{Triangle,Vector3}=require('three');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(readFileSync(path)),'a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31');
const run=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(run.status,0,run.stderr);const source=JSON.parse(run.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;
const orient=(a:number[],b:number[],c:number[])=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function contains(p:number[],part:any) {
  return part.mesh.triangles.some((t:number[])=>{const [a,b,c]=t.map(i=>part.audit.uv[i]);
    const o=[orient(a,b,p),orient(b,c,p),orient(c,a,p)];return o.every(x=>x>=-1e-12)||o.every(x=>x<=1e-12);});
}
test('four actual nonrectangular cylinder trims preserve source PointAt and GLB identity',async()=>{
  const records=[];
  for(const face of [0,4,9,10]) {
    const part=tessellateTrimmedCylinderFace(ir,face,source.metersPerUnit),mesh=part.mesh;
    const triangles=mesh.triangles.map(t=>new Triangle(...t.map(i=>new Vector3(...mesh.positions[i]))));
    assert(triangles.every(t=>t.getArea()>1e-14),'no degenerate triangles');
    let references=0,error=0;
    for(const sample of ir.surfaces[ir.faces[face].surface].parameterEvidence) {
      if(!contains(sample.source,part))continue;references++;
      const p=new Vector3(...sample.point),nearest=new Vector3();let distance=Infinity;
      for(const triangle of triangles)distance=Math.min(distance,p.distanceTo(triangle.closestPointToPoint(p,nearest)));
      error=Math.max(error,distance);
    }
    assert(references>0);assert(error*source.metersPerUnit*1000<=part.audit.physicalBoundMm);
    const edges=new Map<string,number>();
    for(const t of mesh.triangles)for(let i=0;i<3;i++){const [a,b]=[t[i],t[(i+1)%3]].sort((a,b)=>a-b),k=`${a}:${b}`;edges.set(k,(edges.get(k)??0)+1);}
    assert([...edges.values()].every(n=>n<=2));
    const sourceBoundary=new Set<string>();
    for(const boundary of part.boundaryEdges)for(let i=1;i<boundary.vertices.length;i++) {
      const [a,b]=[boundary.vertices[i-1],boundary.vertices[i]].sort((a,b)=>a-b);
      sourceBoundary.add(`${a}:${b}`);
      assert.equal(edges.get(`${a}:${b}`),1,`face ${face} trim ${boundary.trim} missing boundary ${a}:${b}`);
    }
    assert([...edges].every(([edge,count])=>count===2||sourceBoundary.has(edge)),'no interior T junctions');
    records.push({face,vertices:mesh.positions.length,triangles:mesh.triangles.length,references,maxPointAtToMeshMm:error*source.metersPerUnit*1000,
      physicalBoundMm:part.audit.physicalBoundMm,strips:part.audit.stripCount});
  }
  const noCache=structuredClone(source);for(const o of noCache.objects)if(o.kind==='brep')o.storedRenderMeshes=[];
  const completed=completeBrepParts(noCache.objects.find((o:any)=>o.cadIr),source.metersPerUnit);assert.equal(completed.parts.length,41);
  const result=await export3dmGlb(noCache,sha(readFileSync(path)));assert(result.bytes);
  mkdirSync(out,{recursive:true});const glb=resolve(out,'MechPartA.glb');writeFileSync(glb,result.bytes);
  const audit=await auditGlbGeometry(glb),bytes=Buffer.from(result.bytes),json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
  assert.deepEqual(json.meshes.flatMap((m:any)=>m.primitives).filter((p:any)=>p.extras.geometrySource==='cad-ir-trimmed-cylinder').map((p:any)=>p.extras.brepFaceIndex),[0,4,9,10]);
  writeFileSync(resolve(out,'evidence.json'),JSON.stringify({sourceSha256:sha(readFileSync(path)),records,audit,glbSha256:sha(result.bytes),
    sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm',
    useBoundary:'official sample; local verification only; not redistributed',archiveVersion:source.archiveVersion,metersPerUnit:source.metersPerUnit,
    status:result.sidecar.status,remainingFaces:41-completed.parts.length,scope:'source-local; nonrectangular cylinders; no production or closed-shell claim'},null,2));
  console.log(JSON.stringify(records));
});
test('controlled hole on a real cylindrical support stays empty and reversed faces keep opposite normals',()=>{
  const copy=structuredClone(ir),face=copy.faces[4],base=tessellateTrimmedCylinderFace(ir,4,.001);
  const triangle=base.mesh.triangles.reduce((best,t)=>{
    const area=(ids:number[])=>Math.abs(orient(...ids.map(i=>base.audit.uv[i]) as [number[],number[],number[]]));
    return area(t)>area(best)?t:best;
  });
  const points=triangle.map(i=>base.audit.uv[i]),center=[0,1].map(a=>points.reduce((s,p)=>s+p[a],0)/3),r=.001;
  const corners=[[-r,-r],[r,-r],[r,r],[-r,r]].map(p=>p.map((x,i)=>x+center[i]));
  const loop=copy.loops.length,trims:number[]=[];
  for(let i=0;i<4;i++) {
    const curve=copy.curves2d.length;copy.curves2d.push({dimension:2,degree:1,rational:false,parameterMap:{kind:'identity'},
      knots:[0,0,1,1],controlPoints:[corners[i],corners[(i+1)%4]]});
    trims.push(copy.trims.length);copy.trims.push({curve2d:curve,edge:-1,loop,sourceSubdomain:[0,1],curveReversed:false});
  }
  copy.loops.push({face:4,type:2,trims});face.loops.push(loop);
  const hole=tessellateTrimmedCylinderFace(copy,4,.001);assert.equal(hole.audit.holeCount,1);assert.equal(contains(center,hole),false);
  face.reversed=!face.reversed;const reverse=tessellateTrimmedCylinderFace(copy,4,.001);
  assert.equal(reverse.mesh.positions.length,hole.mesh.positions.length);
  const normals=new Map(hole.mesh.positions.map((p,i)=>[p.join(','),hole.mesh.normals[i]]));
  for(let i=0;i<reverse.mesh.positions.length;i++) {
    const previous=normals.get(reverse.mesh.positions[i].join(','));assert(previous);
    assert(reverse.mesh.normals[i].every((x,j)=>Math.abs(x+previous[j])<1e-10));
  }
});
test('unsupported, malformed and tight physical budgets refuse without source mutation',()=>{
  const before=JSON.stringify(ir);
  for(const unit of [NaN,0,-1])assert.throws(()=>tessellateTrimmedCylinderFace(ir,4,unit),/physical-unit/);
  assert.throws(()=>tessellateTrimmedCylinderFace(ir,4,100000),/budget/);
  const copy=structuredClone(ir),surface=copy.surfaces[copy.faces[4].surface];surface.analyticSupport.radius*=2;
  assert.throws(()=>tessellateTrimmedCylinderFace(copy,4,.001),/support-mismatch/);
  copy.loops[copy.faces[4].loops[0]].trims.pop();assert.throws(()=>tessellateTrimmedCylinderFace(copy,4,.001),/open-trim-loop/);
  assert.equal(JSON.stringify(ir),before);
});
