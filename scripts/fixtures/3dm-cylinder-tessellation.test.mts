import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tessellateCylinderFace } from './3dm-cylinder-tessellation.mts';
import { export3dmGlb } from './3dm-glb-export.mts';
import { auditGlbGeometry } from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/3dm-source-audit');
const evidenceOut=resolve(root,'test-output/industrial-3dm/multispan-cylinder-2026-09-17-v1/natural');mkdirSync(evidenceOut,{recursive:true});
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const {Triangle,Vector3}=require('three');
const relative='example_files/V4/v4_MechPartB.3dm',sourceSha256='848271e98cf83a72c6d0fa134dc7a430d2f4d938a4c38765dcc6da0bff8d8978';
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001',relative);
const sha=(bytes:any)=>createHash('sha256').update(bytes).digest('hex');
const load=()=>{
  assert.equal(sha(readFileSync(path)),sourceSha256);
  const run=spawnSync(resolve(out,'3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
  assert.equal(run.status,0,run.stderr); assert.equal(run.stderr,''); return JSON.parse(run.stdout);
};
let supportedIr:any,supportedFace=0;
test('actual McNeel cylinder surfaces reconstruct with source point, topology and GLB evidence',async()=>{
  const source=load(),results:any[]=[],rejected:any[]=[];
  for(const object of source.objects.filter((o:any)=>o.cadIr)) {
    const ir=object.cadIr;
    for(let face=0;face<ir.faces.length;face++) {
      const surface=ir.surfaces[ir.faces[face].surface]; if(surface.analyticSupport?.kind!=='cylinder') continue;
      let part;try {part=tessellateCylinderFace(ir,face);} catch(error) {rejected.push({face,reason:String(error)});continue;}
      supportedIr=ir;supportedFace=face;
      const mesh=part.mesh,edges=new Map<string,number>(),vectors=mesh.positions.map(p=>new Vector3(...p));
      const triangles=mesh.triangles.map(t=>new Triangle(...t.map(i=>vectors[i])));
      let maxSourceToMeshDistance=0,minNormalDot=1,sourceReferenceCount=0;
      for(const sample of surface.parameterEvidence) {
        if(sample.source.some((x:number,axis:number)=>x<part.audit.domain[axis][0]||x>part.audit.domain[axis][1])) continue;
        sourceReferenceCount++;
        const point=new Vector3(...sample.point),closest=new Vector3();let distance=Infinity;
        for(const triangle of triangles) distance=Math.min(distance,point.distanceTo(triangle.closestPointToPoint(point,closest)));
        maxSourceToMeshDistance=Math.max(maxSourceToMeshDistance,distance);
      }
      mesh.triangles.forEach((t,i)=>{
        const normal=triangles[i].getNormal(new Vector3()); minNormalDot=Math.min(minNormalDot,normal.dot(new Vector3(...mesh.normals[t[0]])));
        for(let j=0;j<3;j++) {const a=t[j],b=t[(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;edges.set(key,(edges.get(key)??0)+1);}
      });
      assert(sourceReferenceCount>=100);assert(maxSourceToMeshDistance<=part.audit.chordTolerance+1e-10);assert(minNormalDot>.9);
      assert([...edges.values()].every(n=>n===1||n===2));assert.equal(mesh.positions.length-edges.size+mesh.triangles.length,part.audit.closedSeam?0:1);
      assert.equal([...edges.values()].filter(n=>n===1).length,mesh.positions.length,'only natural top/bottom or end boundaries may be open');
      results.push({objectId:object.id,face,vertices:mesh.positions.length,triangles:mesh.triangles.length,sourceReferenceCount,maxSourceToMeshDistance,minNormalDot,...part.audit});
    }
  }
  assert(results.length>0,`actual supported cylinder missing: ${JSON.stringify(rejected)}`);
  assert.deepEqual(results.map(r=>r.face),[4,5]);
  const noCache=structuredClone(source);for(const object of noCache.objects) if(object.kind==='brep') object.storedRenderMeshes=[];
  const result=await export3dmGlb(noCache,sourceSha256);assert(result.bytes);
  const b=Buffer.from(result.bytes),json=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());
  const cylinderPrimitives=json.meshes.flatMap((m:any)=>m.primitives).filter((p:any)=>p.extras.geometrySource==='cad-ir-natural-cylinder');
  assert.deepEqual(cylinderPrimitives.map((p:any)=>p.extras.brepFaceIndex),results.map(r=>r.face));
  const glbPath=resolve(evidenceOut,'v4_MechPartB.cylinders.glb');writeFileSync(glbPath,result.bytes);const audit=await auditGlbGeometry(glbPath);
  const evidence={schemaVersion:1,sourceSha256,sourceUrl:`https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/${relative}`,
    useBoundary:'official sample; local verification only; not redistributed',archiveVersion:source.archiveVersion,metersPerUnit:source.metersPerUnit,
    results,rejected,audit,status:result.sidecar.status,glbSha256:sha(result.bytes)};
  writeFileSync(resolve(evidenceOut,'cylinder-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({faces:results.map(r=>r.face),rejected,maxError:Math.max(...results.map(r=>r.maxSourceToMeshDistance)),audit}));
});
test('cylinder refusal preserves unsupported trim, support and budget boundaries',()=>{
  assert(supportedIr);
  assert.throws(()=>tessellateCylinderFace(supportedIr,supportedFace,1e-30),/budget/);
  const copy=structuredClone(supportedIr),face=copy.faces[supportedFace],surface=copy.surfaces[face.surface];
  surface.analyticSupport.radius*=2;assert.throws(()=>tessellateCylinderFace(copy,supportedFace),/support-mismatch/);
  surface.analyticSupport=null;assert.throws(()=>tessellateCylinderFace(copy,supportedFace),/support/);
  const cut=structuredClone(supportedIr);cut.loops[cut.faces[supportedFace].loops[0]].trims.pop();
  assert.throws(()=>tessellateCylinderFace(cut,supportedFace),/trim/);
});
test('face reversal and transposed cylindrical parameter axes preserve orientation',()=>{
  const ir=structuredClone(supportedIr),face=ir.faces[supportedFace],s=ir.surfaces[face.surface];
  const before=tessellateCylinderFace(ir,supportedFace);face.reversed=!face.reversed;
  const reversed=tessellateCylinderFace(ir,supportedFace);
  assert(reversed.mesh.normals[0].every((x,i)=>Math.abs(x+before.mesh.normals[0][i])<1e-12));
  face.reversed=!face.reversed;const [nu,nv]=s.controlPointCount;
  s.controlPoints=Array.from({length:nu},(_,u)=>Array.from({length:nv},(_,v)=>s.controlPoints[v*nu+u])).flat();
  for(const key of ['degree','controlPointCount','domain','knots','closed','periodic']) s[key].reverse();
  for(const li of face.loops) for(const ti of ir.loops[li].trims) for(const point of ir.curves2d[ir.trims[ti].curve2d].controlPoints) [point[0],point[1]]=[point[1],point[0]];
  const transposed=tessellateCylinderFace(ir,supportedFace);
  assert.equal(transposed.audit.curvedAxis,1-before.audit.curvedAxis);
  assert.equal(transposed.audit.sourceOrientation,-before.audit.sourceOrientation);
  assert.equal(transposed.mesh.triangles.length,before.mesh.triangles.length);
});
test('controlled natural trim of a real periodic source cylinder welds the seam without adding caps',()=>{
  const sourcePath=path.replace('v4_MechPartB.3dm','v4_MechPartA.3dm');
  assert.equal(sha(readFileSync(sourcePath)),'a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31');
  const run=spawnSync(resolve(out,'3dm-source-audit.exe'),[sourcePath],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
  assert.equal(run.status,0,run.stderr);const ir=JSON.parse(run.stdout).objects.find((o:any)=>o.cadIr).cadIr;
  const surface=ir.surfaces[ir.faces[0].surface],[u,v]=surface.domain,corners=[[u[0],v[0]],[u[1],v[0]],[u[1],v[1]],[u[0],v[1]]];
  // This is a control over the actual source surface; it does not represent MechPartA's authored trim.
  ir.curves2d=corners.map((a,i)=>({dimension:2,degree:1,rational:false,parameterMap:{kind:'identity'},knots:[0,0,1,1],controlPoints:[a,corners[(i+1)%4]]}));
  ir.trims=corners.map((_,i)=>({curve2d:i,sourceSubdomain:[0,1],curveReversed:false}));
  ir.loops=[{type:1,trims:[0,1,2,3]}];ir.faces[0].loops=[0];
  const part=tessellateCylinderFace(ir,0),edges=new Map<string,number>();assert.equal(part.audit.closedSeam,true);
  for(const triangle of part.mesh.triangles) for(let i=0;i<3;i++) {
    const a=triangle[i],b=triangle[(i+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;edges.set(key,(edges.get(key)??0)+1);
  }
  assert.equal(part.mesh.positions.length-edges.size+part.mesh.triangles.length,0);
  assert.equal([...edges.values()].filter(n=>n===1).length,part.mesh.positions.length);
  assert([...edges.values()].every(n=>n<=2));
});
