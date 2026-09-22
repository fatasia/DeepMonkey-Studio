import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodePlanarPrism,matchSourceProfile} from './lib/rvtPlanarPrism.mjs';
const source=()=>{assert.ok(process.env.RVT_PRISM_SOURCE,'Set RVT_PRISM_SOURCE');return JSON.parse(readFileSync(process.env.RVT_PRISM_SOURCE));};
test('real source planes and paired UV coedges form a closed solid independently of bbox',()=>{
  const r=source(),b=Buffer.from(r.geometryRecords[0].hex,'hex'),s=decodePlanarPrism(b,21975);
  assert.equal(r.sourceSha256,'c805df445d613b408e37337765572021265e3f5dfdc7d1fa53b22ba1600b8014');
  assert.equal(s.verticesFeet.length,8);assert.equal(s.faces.length,6);assert.equal(s.sourceEdges.length,12);
  assert.equal(s.lowerFeet,-43);assert.equal(s.upperFeet,-41.5);assert.ok(Math.abs(s.volumeCubicFeet-19624.5)<1e-8);
  assert.ok(s.maxPairedResidualFeet*304.8<0.01);
  const withoutBounds=Buffer.from(b);withoutBounds.fill(0,48,144);
  assert.deepEqual(decodePlanarPrism(withoutBounds,21975).verticesFeet,s.verticesFeet);
  const p=JSON.parse(readFileSync(process.env.RVT_PRISM_PROFILES)),l=JSON.parse(readFileSync(process.env.RVT_PRISM_LINES));
  const profile=p.profiles.find(p=>p.owner===21975),match=matchSourceProfile(s,profile,l.lines);
  assert.equal(match.holes,0);assert.equal(match.sketchElevationFeet,0);assert.equal(match.sketchPlacementResolved,false);
  const wrong=structuredClone(l.lines);wrong.find(x=>x.element===21976).endpointsFeet[0][0]+=1;
  assert.throws(()=>matchSourceProfile(s,profile,wrong),/disagree/);
  assert.throws(()=>matchSourceProfile(s,{...profile,loops:[...profile.loops,...profile.loops]},l.lines),/single/);
});
test('wrong source IDs, topology, finite domains, plane frames and one-sided edges reject',()=>{
  const b=Buffer.from(source().geometryRecords[0].hex,'hex');assert.throws(()=>decodePlanarPrism(b,21976),/ID/);
  for(const at of [0,12,16,26,144,176,180,236,3700,2044+24,2044+155,2044+203,688+20]){
    const bad=Buffer.from(b);bad[at]^=1;assert.throws(()=>decodePlanarPrism(bad,21975),undefined,`byte ${at}`);
  }
  const wrongUV=Buffer.from(b);wrongUV.writeDoubleLE(wrongUV.readDoubleLE(688+48)+0.01,688+48);assert.throws(()=>decodePlanarPrism(wrongUV,21975),/shared edge/);
  const invalidFrame=Buffer.from(b);invalidFrame.writeDoubleLE(NaN,2044+204);assert.throws(()=>decodePlanarPrism(invalidFrame,21975),/non-finite/);
  const shortened=Buffer.from(b);shortened.writeDoubleLE(-100,2044+171+16);assert.throws(()=>decodePlanarPrism(shortened,21975),/frame/);
  assert.throws(()=>decodePlanarPrism(b.subarray(0,b.length-1),21975),/layout/);
});
test('actual GLB has six source faces, manifold triangles and bounded world coordinates',()=>{
  assert.ok(process.env.RVT_PRISM_GLB,'Set RVT_PRISM_GLB');
  const s=decodePlanarPrism(Buffer.from(source().geometryRecords[0].hex,'hex'),21975),b=readFileSync(process.env.RVT_PRISM_GLB);
  assert.equal(b.readUInt32LE(0),0x46546c67);assert.equal(b.readUInt32LE(8),b.length);
  const n=b.readUInt32LE(12),g=JSON.parse(b.subarray(20,20+n)),bin=b.subarray(28+n),position=g.accessors[0],view=g.bufferViews[position.bufferView];
  assert.equal(g.meshes[0].primitives.length,6);assert.equal(position.count,8);
  const points=Array.from({length:8},(_,i)=>[0,1,2].map(k=>bin.readFloatLE(view.byteOffset+i*12+k*4)+g.nodes[0].translation[k]));
  points.forEach((p,i)=>p.forEach((v,k)=>assert.ok(Math.abs(v-s.verticesFeet[i][k]*0.3048)*1000<=0.01)));
  const incidence=new Map(),faceIds=new Set();let triangles=0;
  for(const primitive of g.meshes[0].primitives){faceIds.add(primitive.extras.sourceFace);assert.equal(primitive.mode,4);assert.equal(primitive.extras.sourceElement,21975);
    const a=g.accessors[primitive.indices],v=g.bufferViews[a.bufferView];assert.equal(a.count,6);
    const ids=Array.from({length:6},(_,i)=>bin.readUInt16LE(v.byteOffset+a.byteOffset+i*2));
    for(let i=0;i<6;i+=3){triangles++;const t=ids.slice(i,i+3);assert.equal(new Set(t).size,3);
      for(let k=0;k<3;k++){const x=t[k],y=t[(k+1)%3],key=[x,y].sort((a,b)=>a-b).join('/');const row=incidence.get(key)??[];row.push([x,y]);incidence.set(key,row);}
    }
  }
  assert.equal(faceIds.size,6);assert.equal(triangles,12);
  for(const sides of incidence.values()){assert.equal(sides.length,2);assert.deepEqual(sides[0],[...sides[1]].reverse());}
});
