import test from 'node:test';
import assert from 'node:assert/strict';
import {refineLocalPlanePatch} from './3dm-local-plane-patch.mts';
import {triangulateLocalPlane} from './3dm-local-plane-triangulation.mts';
import {polygonArea} from './3dm-planar-trim.mts';
test('a constrained cavity repairs a concave insertion without losing existing vertices',()=>{
  const uv=[[0,0],[1,0],[1,1],[0,1],[.5,.75]],part={mesh:{triangles:[[0,1,2],[0,2,3]]},boundaryEdges:[{vertices:[0,1,2,3,0]}]},before=JSON.stringify(part);
  const result=refineLocalPlanePatch(part,uv,0,1,[0,4,1],0);
  assert.deepEqual(result.removed,[1,0]);assert.equal(result.passes,2);assert.equal(result.triangles.length,3);
  assert.deepEqual([...new Set(result.triangles.flat())].sort(),[0,1,2,3,4]);
  assert(Math.abs(result.triangles.reduce((sum,t)=>sum+polygonArea(t.map(i=>uv[i])),0)-.625)<1e-12);
  assert.equal(JSON.stringify(part),before);
  part.boundaryEdges.push({vertices:[0,2]});assert.throws(()=>refineLocalPlanePatch(part,uv,0,1,[0,4,1],0),/source-boundary/);
});
test('crossing, duplicate and oversized polygons fail instead of dropping boundary vertices',()=>{
  assert.throws(()=>triangulateLocalPlane([[0,0],[1,1],[0,1],[1,0]],[0,1,2],3),/degenerate|intersect/);
  assert.throws(()=>triangulateLocalPlane([[0,0],[1,0],[0,1]],[0,1,0],2),/invalid/);
  assert.throws(()=>triangulateLocalPlane(Array.from({length:257},(_,i)=>[i,i*i]),Array.from({length:256},(_,i)=>i),256),/invalid/);
});
