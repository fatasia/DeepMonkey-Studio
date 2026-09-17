import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tessellatePlanarFace, completePlanarBrepParts, insideRing } from './3dm-planar-trim.mts';
import { export3dmGlb } from './3dm-glb-export.mts';

const out=new URL('../../test-output/3dm-source-audit/',import.meta.url);
const model=()=>JSON.parse(readFileSync(new URL('file3dm_stuff.3dm.json',out),'utf8'));
function fixture(rings: number[][][]) {
  const ir=structuredClone(model().objects.find((o: any)=>o.cadIr).cadIr);
  ir.surfaces[0]={...ir.surfaces[0], domain:[[0,10],[0,10]], knots:[[0,0,10,10],[0,0,10,10]],
    controlPoints:[[0,0,0],[10,0,0],[0,10,0],[10,10,0]]};
  ir.curves2d=[]; ir.trims=[]; ir.loops=[]; ir.faces=[{surface:0,reversed:false,loops:[]}];
  rings.forEach((ring,r)=>{
    const trims: number[]=[];
    ring.forEach((a,i)=>{
      const index=ir.trims.length; trims.push(index);
      ir.curves2d.push({dimension:2,degree:1,controlPoints:[a,ring[(i+1)%ring.length]],knots:[0,0,1,1],rational:false,parameterMap:{kind:'identity'}});
      ir.trims.push({curve2d:index,sourceSubdomain:[0,1],curveReversed:false});
    });
    ir.loops.push({type:r?2:1,trims}); ir.faces[0].loops.push(r);
  });
  return ir;
}
const outer=[[0,0],[10,0],[10,10],[0,10]], hole=[[3,3],[3,7],[7,7],[7,3]];
test('real uncached affine faces become source-indexed triangles with support-plane and area checks',async()=>{
  const source=model(); let added=0,triangles=0,maxResidual=0; const faces=[];
  for(const object of source.objects.filter((o: any)=>o.cadIr)) {
    const completed=completePlanarBrepParts(object); assert.deepEqual(completed.diagnostics,[]);
    for(const part of completed.parts.filter((p: any)=>p.geometrySource)) {
      added++; triangles+=part.mesh.triangles.length;
      const surface=object.cadIr.surfaces[object.cadIr.faces[part.face].surface];
      const origin=surface.controlPoints[0],normal=part.mesh.normals[0];
      let area=0;
      for(const p of part.mesh.positions) maxResidual=Math.max(maxResidual,Math.abs(p.reduce((sum:number,v:number,i:number)=>sum+(v-origin[i])*normal[i],0)));
      for(const t of part.mesh.triangles) {
        const [a,b,c]=t.map((i:number)=>part.mesh.positions[i]);
        const u=b.map((v:number,i:number)=>v-a[i]),v=c.map((v:number,i:number)=>v-a[i]);
        const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
        assert(n.reduce((sum,x,i)=>sum+x*normal[i],0)>0); area+=Math.hypot(...n)/2;
      }
      assert(Math.abs(area-part.audit.sourcePlaneArea)<1e-7*Math.max(1,area));
      faces.push({objectId:object.id,face:part.face,triangles:part.mesh.triangles.length,area,...part.audit});
    }
  }
  assert.equal(added,12); assert.equal(triangles,24); assert(maxResidual<1e-9);
  const result=await export3dmGlb(source,'a'.repeat(64)); assert.equal(result.sidecar.status,'geometry-preview'); assert(result.bytes);
  const b=Buffer.from(result.bytes),j=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());
  const generated=j.meshes.flatMap((m:any)=>m.primitives).filter((p:any)=>p.extras.geometrySource==='cad-ir-affine-plane-trim');
  assert.equal(generated.length,12); assert(generated.every((p:any)=>Number.isInteger(p.extras.brepFaceIndex)&&p.attributes.NORMAL!==undefined&&p.attributes.TEXCOORD_0===undefined));
  writeFileSync(new URL('planar-trim-evidence.json',out),JSON.stringify({schemaVersion:1,added,triangles,maxResidual,faces,
    sourceExtractionSha256:createHash('sha256').update(readFileSync(new URL('file3dm_stuff.3dm.json',out))).digest('hex')},null,2));
});
test('inner loop remains empty; reversed face flips normals and triangle winding',()=>{
  const ir=fixture([outer,hole]),part=tessellatePlanarFace(ir,0);
  assert.equal(part.audit.sourcePlaneArea,84); assert.equal(part.audit.holeCount,1);
  for(const triangle of part.mesh.triangles) {
    const p=triangle.map(i=>part.mesh.positions[i]);
    for(const weights of [[1/3,1/3,1/3],[.8,.1,.1],[.1,.8,.1],[.1,.1,.8]]) {
      const sample=[0,1].map(axis=>p.reduce((sum,q,i)=>sum+q[axis]*weights[i],0));
      assert(insideRing(sample,outer)); assert(!insideRing(sample,hole));
    }
  }
  ir.faces[0].reversed=true; const flipped=tessellatePlanarFace(ir,0);
  assert(flipped.mesh.normals[0].every((value,i)=>value===[0,0,-1][i]));
  assert.deepEqual(flipped.mesh.triangles,part.mesh.triangles.map(([a,b,c])=>[a,c,b]));
});
test('invalid trims and unsupported surfaces stay explicit diagnostics without proxy geometry',()=>{
  const cases=[fixture([[[0,0],[10,10],[0,10],[10,0]]]),fixture([outer,[[9,3],[9,7],[11,7],[11,3]]])];
  const curved=fixture([outer]); curved.surfaces[0].controlPoints[3][2]=1; cases.push(curved);
  const open=fixture([outer]); open.curves2d[0].controlPoints[1]=[9,0]; cases.push(open);
  const unsupported=fixture([outer]); unsupported.curves2d[0].degree=2; cases.push(unsupported);
  for(const ir of cases) {
    const result=completePlanarBrepParts({id:'test',kind:'brep',faceCount:1,cadIr:ir,storedRenderMeshes:[]});
    assert.equal(result.parts.length,0); assert.equal(result.diagnostics.length,1); assert.equal(result.diagnostics[0].face,0);
  }
});
