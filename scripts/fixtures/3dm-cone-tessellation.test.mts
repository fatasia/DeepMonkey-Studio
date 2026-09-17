import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tessellateConeFace } from './3dm-cone-tessellation.mts';
import { evaluateSurface,mapSurfaceParameter } from './3dm-nurbs-parameters.mjs';
import { export3dmGlb } from './3dm-glb-export.mts';
import { auditGlbGeometry } from '../../apps/api/src/converterOutputAudit.ts';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/3dm-source-audit');
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),{Triangle,Vector3}=require('three');
const relative='example_files/V4/v4_Wheel_PG.3dm',sourceSha256='c116ce1873e6388acbaeb3ccbe08841ed08966db079cd91d492fe621ec127ff9';
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001',relative);
const sha=(bytes:any)=>createHash('sha256').update(bytes).digest('hex');
let supportedIr:any,supportedFace=18,original:any;
test('real wheel cone faces preserve original PointAt, rectangular trim, topology and GLB source map',async()=>{
  assert.equal(sha(readFileSync(path)),sourceSha256);
  const run=spawnSync(resolve(out,'3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
  assert.equal(run.status,0,run.stderr);const source=original=JSON.parse(run.stdout),results:any[]=[],rejected:any[]=[];
  for(const object of source.objects.filter((o:any)=>o.cadIr))for(let face=0;face<object.cadIr.faces.length;face++){
    const ir=object.cadIr,surface=ir.surfaces[ir.faces[face].surface];if(surface.analyticSupport?.kind!=='cone')continue;
    let part;try{part=tessellateConeFace(ir,face);}catch(error){rejected.push({face,reason:String(error)});continue;}
    supportedIr=ir;const mesh=part.mesh,edges=new Map<string,number>(),vectors=mesh.positions.map(p=>new Vector3(...p));
    const triangles=mesh.triangles.map(t=>new Triangle(...t.map(i=>vectors[i])));
    let maxSourceToMeshDistance=0,maxMappingError=0,minNormalDot=1,sourceReferenceCount=0;
    for(const sample of surface.parameterEvidence){
      const mapped=mapSurfaceParameter(surface,sample.source),point=evaluateSurface(surface,mapped);
      assert(Math.hypot(...mapped.map((x:number,i:number)=>x-sample.mapped[i]))<1e-9);
      maxMappingError=Math.max(maxMappingError,Math.hypot(...point.map((x:number,i:number)=>x-sample.point[i])));
      if(sample.source.some((x:number,a:number)=>x<part.audit.domain[a][0]||x>part.audit.domain[a][1]))continue;
      sourceReferenceCount++;const p=new Vector3(...sample.point),closest=new Vector3();let distance=Infinity;
      for(const triangle of triangles)distance=Math.min(distance,p.distanceTo(triangle.closestPointToPoint(p,closest)));
      maxSourceToMeshDistance=Math.max(maxSourceToMeshDistance,distance);
    }
    const n=part.audit.parameters.length,axis=part.audit.curvedAxis;
    for(let i=0;i<mesh.positions.length;i++){
      const uv=part.audit.domain.map((d:number[],a:number)=>a===axis?part.audit.parameters[i%n]:d[Math.floor(i/n)]);
      assert(uv.every((x:number,a:number)=>x>=part.audit.domain[a][0]&&x<=part.audit.domain[a][1]));
      const expected=evaluateSurface(surface,mapSurfaceParameter(surface,uv));assert(Math.hypot(...expected.map((x:number,a:number)=>x-mesh.positions[i][a]))<1e-10);
    }
    mesh.triangles.forEach((t,i)=>{minNormalDot=Math.min(minNormalDot,triangles[i].getNormal(new Vector3()).dot(new Vector3(...mesh.normals[t[0]])));
      assert(triangles[i].getArea()>1e-12);for(let j=0;j<3;j++){const a=t[j],b=t[(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;edges.set(key,(edges.get(key)??0)+1);}});
    assert(sourceReferenceCount>=100);assert(maxMappingError<1e-9);assert(maxSourceToMeshDistance<=part.audit.controlHullBound+1e-9);assert(minNormalDot>.99);
    assert([...edges.values()].every(n=>n===1||n===2));assert.equal(mesh.positions.length-edges.size+mesh.triangles.length,0);
    assert.equal([...edges.values()].filter(n=>n===1).length,mesh.positions.length);
    results.push({objectId:object.id,face,vertices:mesh.positions.length,triangles:mesh.triangles.length,sourceReferenceCount,maxMappingError,maxSourceToMeshDistance,minNormalDot,...part.audit});
  }
  assert.deepEqual(results.map(r=>r.face),[18,22,24,29,32,35,40,42,46]);
  const noCache=structuredClone(source);for(const object of noCache.objects)if(object.kind==='brep')object.storedRenderMeshes=[];
  const result=await export3dmGlb(noCache,sourceSha256);assert(result.bytes);const b=Buffer.from(result.bytes),json=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());
  const primitives=json.meshes.flatMap((m:any)=>m.primitives).filter((p:any)=>p.extras.geometrySource==='cad-ir-natural-cone');
  assert.deepEqual(primitives.map((p:any)=>p.extras.brepFaceIndex),results.map(r=>r.face));
  for(const p of primitives){assert.equal(p.extras.sourceSha256,sourceSha256);assert.equal(p.extras.objectId,results[0].objectId);}
  const glbPath=resolve(out,'v4_Wheel_PG.cones.glb');writeFileSync(glbPath,result.bytes);const audit=await auditGlbGeometry(glbPath);
  const evidence={schemaVersion:1,sourceSha256,sourceUrl:`https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/${relative}`,
    useBoundary:'official sample; local verification only; not redistributed',archiveVersion:source.archiveVersion,metersPerUnit:source.metersPerUnit,
    results,rejected,audit,status:result.sidecar.status,glbSha256:sha(result.bytes)};
  writeFileSync(resolve(out,'cone-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({faces:results.map(r=>r.face),rejected,maxError:Math.max(...results.map(r=>r.maxSourceToMeshDistance)),maxMappingError:Math.max(...results.map(r=>r.maxMappingError)),audit}));
});
test('cone reversal and transposed parameter axes retain normals and source geometry',()=>{
  const ir=structuredClone(supportedIr),face=ir.faces[supportedFace],s=ir.surfaces[face.surface],before=tessellateConeFace(ir,supportedFace);
  face.reversed=!face.reversed;const reversed=tessellateConeFace(ir,supportedFace);
  assert.deepEqual(reversed.mesh.positions,before.mesh.positions);assert(reversed.mesh.normals[0].every((x,i)=>Math.abs(x+before.mesh.normals[0][i])<1e-12));
  face.reversed=!face.reversed;const [nu,nv]=s.controlPointCount;
  s.controlPoints=Array.from({length:nu},(_,u)=>Array.from({length:nv},(_,v)=>s.controlPoints[v*nu+u])).flat();
  for(const key of ['degree','controlPointCount','domain','knots','closed','periodic'])s[key].reverse();s.parameterMap.axes.reverse();
  for(const li of face.loops)for(const ti of ir.loops[li].trims)for(const p of ir.curves2d[ir.trims[ti].curve2d].controlPoints)[p[0],p[1]]=[p[1],p[0]];
  const transposed=tessellateConeFace(ir,supportedFace);assert.equal(transposed.audit.sourceOrientation,-before.audit.sourceOrientation);
  assert.deepEqual(transposed.mesh.positions,before.mesh.positions);
});
test('cone failures retain explicit trim, apex, support and budget diagnostics',()=>{
  assert.throws(()=>tessellateConeFace(supportedIr,supportedFace,1e-30),/budget/);
  const ir=structuredClone(supportedIr),surface=ir.surfaces[ir.faces[supportedFace].surface];
  surface.analyticSupport.slope*=2;assert.throws(()=>tessellateConeFace(ir,supportedFace),/support-mismatch/);
  const cut=structuredClone(supportedIr);cut.loops[cut.faces[supportedFace].loops[0]].trims.pop();assert.throws(()=>tessellateConeFace(cut,supportedFace),/trim/);
  const apex=structuredClone(supportedIr),s=apex.surfaces[apex.faces[supportedFace].surface];
  for(let i=0;i<s.controlPointCount[0];i++){const w=s.controlPoints[i][3];s.controlPoints[i]=[...s.analyticSupport.apex.map((x:number)=>x*w),w];}
  assert.throws(()=>tessellateConeFace(apex,supportedFace),/apex/);
});
test('controlled mirrored and nonuniform instances share the real cone mesh and retain transforms',async()=>{
  const prototype=structuredClone(original.objects.find((o:any)=>o.cadIr===supportedIr));prototype.storedRenderMeshes=[];prototype.definitionMember=true;
  const definitionId='00000000-0000-0000-0000-000000000100',matrices=[[-2,0,0,10,0,3,0,20,0,0,.5,30,0,0,0,1],[1,0,0,-5,0,2,0,4,0,0,4,3,0,0,0,1]];
  const source={...original,definitions:[{id:definitionId,members:[prototype.id]}],objects:[prototype,...matrices.map((matrixRowMajor,i)=>({
    id:`00000000-0000-0000-0000-00000000010${i+1}`,kind:'instance',definitionMember:false,layerIndex:prototype.layerIndex,definitionId,matrixRowMajor}))]};
  const result=await export3dmGlb(source,sourceSha256);assert(result.bytes);const b=Buffer.from(result.bytes),json=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());
  assert.equal(json.meshes.length,1);const nodes=json.nodes.filter((n:any)=>n.extras?.definitionId===definitionId);assert.equal(nodes.length,2);
  nodes.forEach((node:any,i:number)=>{
    const actual=node.matrix??[node.scale[0],0,0,0,0,node.scale[1],0,0,0,0,node.scale[2],0,...node.translation,1];
    for(let r=0;r<4;r++)for(let c=0;c<4;c++)assert(Math.abs(actual[c*4+r]-matrices[i][r*4+c])<1e-10);
  });
});
test('real gear identity-parameter cones preserve small open rectangular trim bands',()=>{
  const gearPath=path.replace('v4_Wheel_PG','v4_Gear');assert.equal(sha(readFileSync(gearPath)),'595cb7511020c44e75f93c18f714c71c5b1d36995eab805f5724b4da619b7630');
  const run=spawnSync(resolve(out,'3dm-source-audit.exe'),[gearPath,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
  assert.equal(run.status,0,run.stderr);let count=0,referenceCount=0,maxError=0;
  for(const object of JSON.parse(run.stdout).objects.filter((o:any)=>o.cadIr))for(let face=0;face<object.cadIr.faces.length;face++){
    const s=object.cadIr.surfaces[object.cadIr.faces[face].surface];if(s.analyticSupport?.kind!=='cone')continue;
    let part;try{part=tessellateConeFace(object.cadIr,face);}catch{continue;}
    assert.equal(s.parameterMap.kind,'identity');assert.equal(part.audit.closedSeam,false);count++;
    const triangles=part.mesh.triangles.map(t=>new Triangle(...t.map(i=>new Vector3(...part.mesh.positions[i]))));
    for(const sample of s.parameterEvidence){
      assert(Math.hypot(...evaluateSurface(s,sample.source).map((x:number,i:number)=>x-sample.point[i]))<1e-9);
      if(sample.source.some((x:number,a:number)=>x<part.audit.domain[a][0]||x>part.audit.domain[a][1]))continue;
      referenceCount++;const p=new Vector3(...sample.point),closest=new Vector3();let error=Infinity;
      for(const triangle of triangles)error=Math.min(error,p.distanceTo(triangle.closestPointToPoint(p,closest)));
      maxError=Math.max(maxError,error);assert(error<=part.audit.controlHullBound+1e-9);
    }
  }
  assert.equal(count,25);assert(referenceCount>0);
  const evidence={sourceSha256:sha(readFileSync(gearPath)),sourceUrl:`https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/${relative.replace('v4_Wheel_PG','v4_Gear')}`,
    useBoundary:'official sample; local verification only; not redistributed',gearFaces:count,referenceCount,maxError};
  writeFileSync(resolve(out,'cone-gear-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
});
