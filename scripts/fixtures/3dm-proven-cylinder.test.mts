import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { proveCylinderSupport,tessellateProvenCylinderFace } from './3dm-proven-cylinder.mts';
import { completeBrepParts } from './3dm-brep-tessellation.mts';
import { export3dmGlb } from './3dm-glb-export.mts';
import { auditGlbGeometry } from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/rational-bezier-2026-09-17-v1/proven');
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),{Triangle,Vector3}=require('three');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex');
const orient=(a:number[],b:number[],c:number[])=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
let realSurface:any;
test('four uncached source faces prove circle identity and preserve PointAt, boundaries and GLB',async()=>{
  mkdirSync(out,{recursive:true});const records=[];
  for(const [name,faces,expected,hash] of [['A',[1,2,3],29,'a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31'],
    ['B',[2],14,'848271e98cf83a72c6d0fa134dc7a430d2f4d938a4c38765dcc6da0bff8d8978']] as const) {
    const path=resolve(root,`data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPart${name}.3dm`);
    assert.equal(sha(readFileSync(path)),hash);
    const run=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
    assert.equal(run.status,0,run.stderr);const source=JSON.parse(run.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;
    const results=[];
    for(const face of faces) {
      const surface=ir.surfaces[ir.faces[face].surface];assert.equal(surface.analyticSupport,null);realSurface=surface;
      const before=JSON.stringify(ir),part=tessellateProvenCylinderFace(ir,face,.001),mesh=part.mesh;assert.equal(JSON.stringify(ir),before);
      const triangles=mesh.triangles.map(t=>new Triangle(...t.map(i=>new Vector3(...mesh.positions[i]))));let count=0,error=0;
      for(const sample of surface.parameterEvidence) {
        const inside=mesh.triangles.some(t=>{const [a,b,c]=t.map(i=>part.audit.uv[i]),p=sample.source,signs=[orient(a,b,p),orient(b,c,p),orient(c,a,p)];
          return signs.every(x=>x>=-1e-12)||signs.every(x=>x<=1e-12);});if(!inside)continue;count++;
        const p=new Vector3(...sample.point),near=new Vector3();let distance=Infinity;
        for(const triangle of triangles)distance=Math.min(distance,p.distanceTo(triangle.closestPointToPoint(p,near)));error=Math.max(error,distance);
      }
      assert(count>0);assert(error<=part.audit.physicalBoundMm);assert(triangles.every(t=>t.getArea()>1e-14));
      const edges=new Map<string,number>(),boundaries=new Set<string>(),key=(a:number,b:number)=>[a,b].sort((a,b)=>a-b).join(':');
      for(const t of mesh.triangles)for(let i=0;i<3;i++){const k=key(t[i],t[(i+1)%3]);edges.set(k,(edges.get(k)??0)+1);}
      for(const b of part.boundaryEdges)for(let i=1;i<b.vertices.length;i++){const k=key(b.vertices[i-1],b.vertices[i]);boundaries.add(k);assert.equal(edges.get(k),1);}
      assert([...edges].every(([k,n])=>n===2||n===1&&boundaries.has(k)));
      results.push({face,vertices:mesh.positions.length,triangles:mesh.triangles.length,referenceCount:count,maxPointAtDistanceMm:error,
        physicalBoundMm:part.audit.physicalBoundMm,derivedSupport:part.audit.derivedSupport});
    }
    for(const o of source.objects)if(o.kind==='brep')o.storedRenderMeshes=[];
    assert.equal(completeBrepParts(object,.001).parts.length,expected);
    const glb=await export3dmGlb(source,hash);assert(glb.bytes);const pathOut=resolve(out,`MechPart${name}.glb`);writeFileSync(pathOut,glb.bytes);
    const audit=await auditGlbGeometry(pathOut),bytes=Buffer.from(glb.bytes),json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
    assert.deepEqual(json.meshes.flatMap((m:any)=>m.primitives).filter((p:any)=>p.extras.geometrySource==='cad-ir-proven-cylinder').map((p:any)=>p.extras.brepFaceIndex),faces);
    records.push({name,sourceSha256:hash,sourceUrl:`https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPart${name}.3dm`,
      archiveVersion:source.archiveVersion,metersPerUnit:source.metersPerUnit,useBoundary:'official samples; local verification only; not redistributed',
      results,audit,glbSha256:sha(glb.bytes),status:glb.sidecar.status});
  }
  writeFileSync(resolve(out,'evidence.json'),JSON.stringify(records,null,2));console.log(JSON.stringify(records));
});
test('noncircular arc cannot pass merely because three evaluated points define a circle',()=>{
  assert(realSurface);const copy=structuredClone(realSurface),linear=copy.degree.indexOf(1),n=copy.controlPointCount[linear];
  // Preserve exact translation while moving the middle rational row radially.
  for(let row=0;row<n;row++){const i=linear===0?n+row:row*3+1;copy.controlPoints[i][2]+=.01*copy.controlPoints[i][3];}
  assert.throws(()=>proveCylinderSupport(copy),/noncircular/);
  assert.throws(()=>proveCylinderSupport({...realSurface,rational:false}),/unsupported-derived-cylinder/);
});
