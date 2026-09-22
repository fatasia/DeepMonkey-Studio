import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodeGroupGeometry,resolveGroupReference,applyGroupReference} from './lib/rvtGroupGeometry.mjs';
import {decodePlanarPrism} from './lib/rvtPlanarPrism.mjs';
for(const key of ['RVT_GROUP_SOURCE','RVT_GROUP_OUTPUT','RVT_FAMILY_SOURCE'])assert.ok(process.env[key],`Set ${key}`);
const json=p=>JSON.parse(readFileSync(p)),groups=json(process.env.RVT_GROUP_SOURCE),family=json(process.env.RVT_FAMILY_SOURCE),proof=json(path.join(process.env.RVT_GROUP_OUTPUT,'evidence.json'));
const raw=id=>Buffer.from(groups.carriers.find(c=>c.element===id&&c.hex.slice(32,40)==='3f08ffff').hex,'hex');
const member=id=>decodePlanarPrism(Buffer.from(family.geometryRecords.find(r=>r.element===id&&r.hex).hex,'hex'),id);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],sub=(a,b)=>a.map((x,k)=>x-b[k]),dot=(a,b)=>a.reduce((s,x,k)=>s+x*b[k],0);
function volume(points,triangles){const center=[0,1,2].map(k=>points.reduce((s,p)=>s+p[k],0)/points.length);return triangles.reduce((sum,t)=>{const [a,b,c]=t.map(i=>sub(points[i],center));assert.ok(Math.hypot(...cross(sub(b,a),sub(c,a)))>0);return sum+dot(a,cross(b,c))/6;},0);}
test('nine actual geometry reference graphs parse, wrong framing and non-rigid matrices reject',()=>{
  const records=groups.carriers.filter(c=>c.hex.slice(32,40)==='3f08ffff');assert.equal(records.length,9);
  for(const record of records)assert.ok(decodeGroupGeometry(Buffer.from(record.hex,'hex'),record.element).references.length);
  const b=raw(21943),g=decodeGroupGeometry(b,21943),at=g.references[0].sourceOffset;
  for(const offset of [0,12,16,26,34,38,42,46,at-10,b.length-4]){const bad=Buffer.from(b);bad[offset]^=1;assert.throws(()=>decodeGroupGeometry(bad,21943));}
  for(const value of [NaN,Infinity,0,2]){const bad=Buffer.from(b);bad.writeDoubleLE(value,at);assert.throws(()=>decodeGroupGeometry(bad,21943));}
  for(const size of [0,32,b.length-1])assert.throws(()=>decodeGroupGeometry(b.subarray(0,size),21943));
});
test('source occurrence identity survives repeats and reflection reverses winding',()=>{
  const solid=member(21934),b=raw(21943),g=decodeGroupGeometry(b,21943),ref=g.references.find(r=>r.element===21934);
  const repeated=Buffer.from(b);repeated.writeBigUInt64LE(21934n,g.references[1].sourceOffset+96);
  const parsed=decodeGroupGeometry(repeated,21943).references.filter(r=>r.element===21934);assert.equal(parsed.length,2);
  assert.notEqual(applyGroupReference(solid,parsed[0],21943).instancePath,applyGroupReference(solid,parsed[1],21943).instancePath);
  const reflected={...ref,matrix:[-1,0,0,0,1,0,0,0,1,200,10,5]},placed=applyGroupReference(solid,reflected,21943);
  solid.verticesFeet.forEach((p,i)=>assert.deepEqual(placed.verticesFeet[i],[200-p[0],10+p[1],5+p[2]]));
  assert.ok(Math.abs(volume(placed.verticesFeet,placed.triangles)-solid.volumeCubicFeet)<1e-8);
  assert.equal(placed.placement.determinant,-1);
  const groupHeader=groups.headers.find(h=>h.element===21943),groupRecord=groups.carriers.find(c=>c.element===21943&&c.hex.slice(32,40)==='3f08ffff');
  assert.throws(()=>resolveGroupReference({member:21934,metadata:[{element:21934,standalone:false,containerRaw:'16229'}],groupHeader,groupRecord}),/owner/);
  const mirrored=Buffer.from(b);mirrored.writeDoubleLE(-1,ref.sourceOffset);
  assert.throws(()=>resolveGroupReference({member:21934,metadata:[{element:21934,standalone:false,containerRaw:'21920'}],groupHeader,groupRecord:{...groupRecord,hex:mirrored.toString('hex')}}),/source witness/);
});
test('eleven actual placed solids match source composition after GLB quantization',()=>{
  assert.deepEqual(proof.summary,{'group-geometry-reference-missing':1,'unsupported-or-conflicting-geometry':12,'source-group-solid-preview':11,'source-profile-crosscheck-unavailable':2});
  let maxErrorMm=0;const paths=new Set();
  for(const row of proof.results.filter(r=>r.status==='source-group-solid-preview')){
    const solid=member(row.element),ref=decodeGroupGeometry(raw(row.instance),row.instance).references[row.referenceIndex],placed=applyGroupReference(solid,ref,row.instance);
    assert.ok(!paths.has(placed.instancePath));paths.add(placed.instancePath);
    const b=readFileSync(path.join(process.env.RVT_GROUP_OUTPUT,row.glb));assert.equal(createHash('sha256').update(b).digest('hex'),row.glbSha256);
    const n=b.readUInt32LE(12),g=JSON.parse(b.subarray(20,20+n)),bin=b.subarray(28+n),node=g.nodes[0];
    assert.equal(node.extras.instancePath,placed.instancePath);assert.deepEqual(node.extras.placement.matrix,ref.matrix);
    const accessor=g.accessors[0],view=g.bufferViews[accessor.bufferView];
    const points=Array.from({length:8},(_,i)=>[0,1,2].map(k=>(bin.readFloatLE(view.byteOffset+i*12+k*4)+node.translation[k])/0.3048));
    points.forEach((p,i)=>{const error=Math.hypot(...sub(p,placed.verticesFeet[i]))*304.8;maxErrorMm=Math.max(maxErrorMm,error);assert.ok(error<=.01);});
    const triangles=[];for(const primitive of g.meshes[0].primitives){const a=g.accessors[primitive.indices],v=g.bufferViews[a.bufferView];for(let i=0;i<a.count;i+=3)triangles.push([0,1,2].map(k=>bin.readUInt16LE(v.byteOffset+(a.byteOffset??0)+(i+k)*2)));}
    assert.equal(triangles.length,12);assert.ok(Math.abs(volume(points,triangles)-solid.volumeCubicFeet)/solid.volumeCubicFeet<1e-5);
    const edges=new Map();for(const t of triangles)for(let k=0;k<3;k++){const a=t[k],b=t[(k+1)%3],key=[a,b].sort((a,b)=>a-b).join('/');const values=edges.get(key)??[];values.push([a,b]);edges.set(key,values);}
    for(const values of edges.values()){assert.equal(values.length,2);assert.deepEqual(values[0],[...values[1]].reverse());}
  }
  assert.equal(paths.size,11);console.log(JSON.stringify({placedSolids:11,triangles:132,maxErrorMm}));
  assert.equal(proof.defaultSceneMerge,'disabled-until-active-group-and-design-option-selection-is-proven');
  assert.equal(proof.overlaps.length,11);assert.ok(proof.overlaps.every(r=>r.coincidentBaselineElements.length>0));
});
