import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {tessellateTrimmedCylinderFace} from './3dm-cylinder-trim.mts';
import {repairFloat32Interior,collapsedFloat32Triangles} from './3dm-float32-interior-repair.mts';
import {evaluateSurface} from './3dm-nurbs-parameters.mjs';
const root=resolve(import.meta.dirname,'../..'),path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm');
assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),'a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31');
const native=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(native.status,0,native.stderr);
const ir=JSON.parse(native.stdout).objects.find((o:any)=>o.cadIr).cadIr;
const area=(points:number[][])=>(points[1][0]-points[0][0])*(points[2][1]-points[0][1])-(points[1][1]-points[0][1])*(points[2][0]-points[0][0]);

test('real two cylinder faces remove all Float32 collapses without losing any triangle or moving a source boundary',()=>{
  const source=JSON.stringify(ir);
  for(const face of [9,10]){
    const before=tessellateTrimmedCylinderFace(ir,face,.001),snapshot=JSON.stringify(before),result=repairFloat32Interior(ir,before,.001);
    assert.equal(collapsedFloat32Triangles(before.mesh).length,8);assert.equal(collapsedFloat32Triangles(result.mesh).length,0);
    assert.deepEqual(result.mesh.triangles,before.mesh.triangles);assert.deepEqual(result.mesh.normals,before.mesh.normals);
    assert.equal(result.mesh.positions.length,before.mesh.positions.length);assert.deepEqual(result.boundaryEdges,before.boundaryEdges);
    const protectedIds=new Set(before.boundaryEdges.flatMap((b:any)=>b.vertices)),record=result.audit.float32InteriorRepair;
    assert.equal(record.moves.length,4);assert(record.maxMovement<1e-7&&record.physicalBoundMm<=.01);
    for(const id of protectedIds){assert.deepEqual(result.mesh.positions[id],before.mesh.positions[id]);assert.deepEqual(result.audit.uv[id],before.audit.uv[id]);}
    for(const move of record.moves){assert(!protectedIds.has(move.vertex));assert.equal(move.from[before.audit.curvedAxis],move.to[before.audit.curvedAxis]);
      assert.deepEqual(result.mesh.positions[move.vertex],evaluateSurface(ir.surfaces[ir.faces[face].surface],move.to));}
    const sum=(part:any)=>part.mesh.triangles.reduce((n:number,t:number[])=>n+area(t.map(id=>part.audit.uv[id])),0);
    assert(Math.abs(sum(before)-sum(result))<1e-12);
    assert.equal(JSON.stringify(before),snapshot);assert.strictEqual(repairFloat32Interior(ir,result,.001),result);
  }
  assert.equal(JSON.stringify(ir),source);
});

test('exhausted budget, protected samples, source drift and unsupported profiles preserve the original mesh',()=>{
  for(const fault of ['budget','protected','source','profile','unit']){
    const part=tessellateTrimmedCylinderFace(ir,9,.001);
    if(fault==='budget')part.audit.physicalBoundMm=.01;
    if(fault==='protected')part.boundaryEdges.push({vertices:part.mesh.positions.map((_:any,i:number)=>i)} as any);
    if(fault==='source')part.mesh.positions[0][0]+=.01;
    if(fault==='profile')part.geometrySource='source-stored-mesh';
    const snapshot=JSON.stringify(part);assert.strictEqual(repairFloat32Interior(ir,part,fault==='unit'?0:.001),part,fault);assert.equal(JSON.stringify(part),snapshot);
  }
});
