import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tessellateSphereFace } from './3dm-sphere-tessellation.mts';
import { export3dmGlb } from './3dm-glb-export.mts';
const out=new URL('../../test-output/3dm-source-audit/',import.meta.url);
const evidence:any[]=[];
for(const name of ['blocks.3dm','sphereDecals.3dm']) test(`${name}: actual NURBS sphere, welded topology and independent chord residual`,async()=>{
  const bytes=readFileSync(new URL(`${name}.json`,out)),source=JSON.parse(bytes.toString());
  const object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr,surface=ir.surfaces[0],support=surface.analyticSupport;
  const part=tessellateSphereFace(ir,0),{positions,triangles,normals}=part.mesh;
  const edges=new Map<string,number>(); let maxChordResidual=0,minNormalDot=1;
  for(const triangle of triangles) {
    for(let i=0;i<3;i++) {
      const a=triangle[i],b=triangle[(i+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;
      edges.set(key,(edges.get(key)??0)+1);
    }
    const center=[0,1,2].map(axis=>triangle.reduce((sum,i)=>sum+positions[i][axis],0)/3);
    maxChordResidual=Math.max(maxChordResidual,support.radius-Math.hypot(...center.map((x,i)=>x-support.center[i])));
    const [a,b,c]=triangle.map(i=>positions[i]),u=b.map((x,i)=>x-a[i]),v=c.map((x,i)=>x-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],l=Math.hypot(...n);
    const dot=n.reduce((sum,x,i)=>sum+x/l*normals[triangle[0]][i],0); minNormalDot=Math.min(minNormalDot,dot);
  }
  assert([...edges.values()].every(n=>n===2),'seam/pole manifold must have exactly two incident faces');
  assert.equal(positions.length-edges.size+triangles.length,2,'sphere Euler characteristic');
  assert(maxChordResidual<part.audit.chordTolerance); assert(minNormalDot>.99);
  let maxSourcePointResidual=0,maxOriginalInterpolationError=0;
  const {around,vertical,angularAxis}=part.audit;
  const index=(j:number,i:number)=>j===0?0:j===vertical?positions.length-1:1+(j-1)*around+(i+around)%around;
  for(const sample of surface.parameterEvidence) {
    maxSourcePointResidual=Math.max(maxSourcePointResidual,Math.abs(Math.hypot(...sample.point.map((x:number,i:number)=>x-support.center[i]))-support.radius));
    const normalized=sample.source.map((value:number,axis:number)=>(value-surface.domain[axis][0])/(surface.domain[axis][1]-surface.domain[axis][0]));
    const u=normalized[angularAxis]*around,v=normalized[1-angularAxis]*vertical;
    const i=Math.min(around-1,Math.floor(u)),j=Math.min(vertical-1,Math.floor(v)),fx=u-i,fy=v-j;
    let ids:number[],weights:number[];
    if(j===0) { ids=[index(0,i),index(1,i),index(1,i+1)]; weights=[1-fy,fy*(1-fx),fy*fx]; }
    else if(j===vertical-1) { ids=[index(j,i),index(j,i+1),index(vertical,i)]; weights=[(1-fy)*(1-fx),(1-fy)*fx,fy]; }
    else if(fx+fy<=1) { ids=[index(j,i),index(j+1,i),index(j,i+1)]; weights=[1-fx-fy,fy,fx]; }
    else { ids=[index(j,i+1),index(j+1,i),index(j+1,i+1)]; weights=[1-fy,1-fx,fx+fy-1]; }
    const approximation=[0,1,2].map(axis=>ids.reduce((sum,id,k)=>sum+positions[id][axis]*weights[k],0));
    maxOriginalInterpolationError=Math.max(maxOriginalInterpolationError,Math.hypot(...approximation.map((x,axis)=>x-sample.point[axis])));
  }
  assert(maxSourcePointResidual<1e-9);
  assert(maxOriginalInterpolationError<=part.audit.angularErrorBound);
  if(name==='blocks.3dm') {
    const glb=await export3dmGlb(source,'a'.repeat(64)); assert(glb.bytes); assert.equal(glb.sidecar.status,'geometry-preview');
    const b=Buffer.from(glb.bytes),j=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());
    assert.equal(j.meshes.length,1); assert(j.nodes.filter((n:any)=>n.mesh!==undefined).length===2);
    assert.equal(j.meshes[0].primitives[0].extras.geometrySource,'cad-ir-natural-sphere');
  }
  evidence.push({name,extractedSha256:createHash('sha256').update(bytes).digest('hex'),vertices:positions.length,
    triangles:triangles.length,edges:edges.size,maxChordResidual,maxSourcePointResidual,maxOriginalInterpolationError,minNormalDot,...part.audit});
  writeFileSync(new URL('sphere-tessellation-evidence.json',out),JSON.stringify({schemaVersion:1,results:evidence},null,2));
});
test('partial sphere, missing analytic support, excessive precision and forged support are rejected',()=>{
  const model=JSON.parse(readFileSync(new URL('blocks.3dm.json',out),'utf8'));
  const ir=model.objects.find((o:any)=>o.cadIr).cadIr;
  assert.throws(()=>tessellateSphereFace(ir,0,1e-10),/budget/);
  const missing=structuredClone(ir); missing.surfaces[0].analyticSupport=null;
  assert.throws(()=>tessellateSphereFace(missing,0),/unsupported/);
  const partial=structuredClone(ir); partial.loops[0].trims.pop(); assert.throws(()=>tessellateSphereFace(partial,0),/trim/);
  const wrong=structuredClone(ir); wrong.surfaces[0].analyticSupport.radius*=2;
  assert.throws(()=>tessellateSphereFace(wrong,0),/support-mismatch/);
});
test('face reversal and transposed angular axis preserve source orientation',()=>{
  const model=JSON.parse(readFileSync(new URL('blocks.3dm.json',out),'utf8'));
  const ir=model.objects.find((o:any)=>o.cadIr).cadIr;
  const forward=tessellateSphereFace(ir,0); ir.faces[0].reversed=!ir.faces[0].reversed;
  const reversed=tessellateSphereFace(ir,0);
  assert.deepEqual(reversed.mesh.triangles[100],forward.mesh.triangles[100].map((x,i,a)=>i===0?x:a[3-i]));
  assert(reversed.mesh.normals[100].every((x,i)=>Math.abs(x+forward.mesh.normals[100][i])<1e-12));
  ir.faces[0].reversed=!ir.faces[0].reversed;
  const s=ir.surfaces[0],[nu,nv]=s.controlPointCount;
  s.controlPoints=Array.from({length:nu},(_,u)=>Array.from({length:nv},(_,v)=>s.controlPoints[v*nu+u])).flat();
  for(const key of ['degree','controlPointCount','domain','knots','closed','periodic']) s[key].reverse();
  s.parameterMap.axes.reverse(); for(const curve of ir.curves2d) for(const point of curve.controlPoints) [point[0],point[1]]=[point[1],point[0]];
  const transposed=tessellateSphereFace(ir,0);
  assert.equal(transposed.audit.angularAxis,1); assert.equal(transposed.audit.sourceOrientation,-forward.audit.sourceOrientation);
  assert.equal(transposed.mesh.triangles.length,forward.mesh.triangles.length);
});
