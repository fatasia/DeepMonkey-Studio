import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { tessellatePlanarFace } from './3dm-planar-trim.mts';
import { trimPolyline } from './3dm-trim-polyline.mts';
import { evaluateCurve, evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { export3dmGlb } from './3dm-glb-export.mts';
import { auditGlbGeometry } from '../../apps/api/src/converterOutputAudit.ts';

const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/3dm-source-audit');
const relative='example_files/V4/v4_MechPartA.3dm';
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001',relative);
const sha=(bytes:any)=>createHash('sha256').update(bytes).digest('hex');
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const {Matrix4,Vector3,Quaternion}=require('three');
const sourceSha256='a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31';
assert.equal(sha(readFileSync(path)),sourceSha256);
const run=()=>spawnSync(resolve(out,'3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
const actual=run(); assert.equal(actual.status,0,actual.stderr); assert.equal(actual.stderr,'');
assert.equal(run().stdout,actual.stdout,'nondeterministic source extraction');
const source=JSON.parse(actual.stdout); const results:any[]=[],rejected:any[]=[];
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
function distanceToPolyline(point:number[],polyline:number[][]) {
  return Math.min(...polyline.slice(1).map((b,i)=>{
    const a=polyline[i],u=b.map((x,j)=>x-a[j]),den=u.reduce((s,x)=>s+x*x,0);
    const t=den?Math.max(0,Math.min(1,u.reduce((s,x,j)=>s+x*(point[j]-a[j]),0)/den)):0;
    return distance(point,a.map((x,j)=>x+t*u[j]));
  }));
}
function circleReference(curve:any) {
  const samples=curve.parameterEvidence;
  if(!samples?.length || distance(samples[0].point,samples.at(-1).point)>1e-10) return null;
  const [a,b,c]=[samples[0],samples[12],samples[24]].map(s=>s.point);
  const d=2*(a[0]*(b[1]-c[1])+b[0]*(c[1]-a[1])+c[0]*(a[1]-b[1]));
  if(Math.abs(d)<1e-12) return null;
  const q=(p:number[])=>p[0]**2+p[1]**2;
  const center=[(q(a)*(b[1]-c[1])+q(b)*(c[1]-a[1])+q(c)*(a[1]-b[1]))/d,
    (q(a)*(c[0]-b[0])+q(b)*(a[0]-c[0])+q(c)*(b[0]-a[0]))/d];
  const radius=distance(center,a.slice(0,2));
  if(samples.some((s:any)=>Math.abs(distance(center,s.point.slice(0,2))-radius)>1e-10)) return null;
  return {area:Math.PI*radius*radius,perimeter:2*Math.PI*radius};
}
for(const object of source.objects.filter((o:any)=>o.cadIr)) {
  const ir=object.cadIr;
  for(let face=0;face<ir.faces.length;face++) {
    let part; try { part=tessellatePlanarFace(ir,face); } catch(error) { rejected.push({face,reason:String(error)}); continue; }
    let maxNurbsPointError=0,maxTrimChordError=0;
    const surface=ir.surfaces[ir.faces[face].surface];
    for(const sample of surface.parameterEvidence) maxNurbsPointError=Math.max(maxNurbsPointError,distance(evaluateSurface(surface,sample.source),sample.point));
    for(const li of ir.faces[face].loops) for(const ti of ir.loops[li].trims) {
      const trim=ir.trims[ti],curve=ir.curves2d[trim.curve2d];
      const polyline=trimPolyline(curve,trim.sourceSubdomain,trim.curveReversed,0.0005).points;
      for(const sample of curve.parameterEvidence) {
        if(sample.source<trim.sourceSubdomain[0]||sample.source>trim.sourceSubdomain[1]) continue;
        const original=sample.point.slice(0,2);
        maxNurbsPointError=Math.max(maxNurbsPointError,distance(evaluateCurve(curve,sample.source),original));
        maxTrimChordError=Math.max(maxTrimChordError,distanceToPolyline(original,polyline));
      }
    }
    assert(maxNurbsPointError<1e-10); assert(maxTrimChordError<=0.0005+1e-12);
    const circles=ir.faces[face].loops.map((li:number)=>{
      const loop=ir.loops[li]; if(loop.trims.length!==1) return null;
      const trim=ir.trims[loop.trims[0]],curve=ir.curves2d[trim.curve2d];
      if(trim.sourceSubdomain[0]!==curve.domain[0]||trim.sourceSubdomain[1]!==curve.domain[1]) return null;
      const circle=circleReference(curve); return circle?{...circle,sign:loop.type===1?1:-1}:null;
    });
    let circularAreaReference=null;
    if(circles.every(Boolean)) {
      const area=circles.reduce((sum:number,c:any)=>sum+c.sign*c.area,0);
      const error=Math.abs(area-part.audit.uvArea),bound=circles.reduce((sum:number,c:any)=>sum+c.perimeter*.001+Math.PI*.001**2,0);
      assert(error<=bound); circularAreaReference={area,error,bound};
    }
    results.push({face,objectId:object.id,triangles:part.mesh.triangles.length,vertices:part.mesh.positions.length,
      maxNurbsPointError,maxTrimChordError,circularAreaReference,...part.audit});
  }
}
assert(results.some(r=>r.holeCount>0),'real hole profile not exercised');
// Ignore saved meshes in this research run to prove reconstruction from actual source surfaces/trims.
const noCache=structuredClone(source); let savedMeshCount=0;
for(const object of noCache.objects) if(object.kind==='brep') { savedMeshCount+=object.storedRenderMeshes.length; object.storedRenderMeshes=[]; }
const result=await export3dmGlb(noCache,sourceSha256); assert(result.bytes);
const glb=resolve(out,'v4_MechPartA.rebuilt.glb'); writeFileSync(glb,result.bytes);
const audit=await auditGlbGeometry(glb);
assert.equal(audit.primitiveCount,results.length);
assert.equal(audit.triangleCount,results.reduce((sum,r)=>sum+r.triangles,0));
const definitionId='00000000-0000-0000-0000-000000000100';
const prototype=structuredClone(noCache.objects.find((o:any)=>o.cadIr)); prototype.definitionMember=true;
const matrices=[[-2,0,0,10,0,3,0,-4,0,0,.5,8,0,0,0,1],[1,0,0,0,0,2,0,0,0,0,4,0,0,0,0,1]];
const controls={...noCache,definitions:[{id:definitionId,members:[prototype.id]}],objects:[prototype,...matrices.map((matrixRowMajor,i)=>({
  id:`00000000-0000-0000-0000-00000000010${i+1}`,kind:'instance',definitionMember:false,
  layerIndex:prototype.layerIndex,definitionId,matrixRowMajor}))]};
const instanced=await export3dmGlb(controls,sourceSha256); assert(instanced.bytes);
const ib=Buffer.from(instanced.bytes),ij=JSON.parse(ib.subarray(20,20+ib.readUInt32LE(12)).toString());
const nodes=ij.nodes.filter((n:any)=>n.extras?.definitionId===definitionId);
assert.equal(nodes.length,2); assert.equal(ij.meshes.length,1,'instances must share reconstructed mesh');
nodes.forEach((node:any,i:number)=>{
  const actual=new Matrix4().compose(new Vector3(...(node.translation??[0,0,0])),new Quaternion(...(node.rotation??[0,0,0,1])),new Vector3(...(node.scale??[1,1,1])));
  actual.elements.forEach((value:number,j:number)=>assert(Math.abs(value-matrices[i][(j%4)*4+Math.floor(j/4)])<1e-12));
  assert.equal(Math.sign(actual.determinant()),i===0?-1:1);
});
const evidence={schemaVersion:1,sourceSha256,sourceUrl:`https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/${relative}`,
  useBoundary:'official sample; local verification only; redistribution audit pending; source not committed',
  archiveVersion:source.archiveVersion,metersPerUnit:source.metersPerUnit,savedMeshCount,results,rejected,
  status:result.sidecar.status,audit,glbSha256:sha(result.bytes),extractedSha256:sha(actual.stdout),
  derivedInstanceControls:{scope:'controlled transformations of real source geometry; not source-authored instances',matrices,sharedMeshCount:ij.meshes.length,glbSha256:sha(instanced.bytes)}};
writeFileSync(resolve(out,'real-trim-evidence.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
