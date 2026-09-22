import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodePlanarPrism,matchSourceProfile} from './lib/rvtPlanarPrism.mjs';
const root=process.env.RVT_FAMILY_OUTPUT;
assert.ok(root,'Set RVT_FAMILY_OUTPUT');
const json=p=>JSON.parse(readFileSync(p));
const evidence=json(path.join(root,'evidence.json'));
const sha=b=>createHash('sha256').update(b).digest('hex');
test('all accepted real source identities retain closed, nondegenerate quantized geometry',()=>{
  const profiles=json(process.env.RVT_PRISM_PROFILES),lines=json(process.env.RVT_PRISM_LINES);
  let count=0,maxErrorMm=0;
  for(const row of evidence.results.filter(r=>r.status==='source-planar-solid-preview')){
    count++;
    const source=json(path.join(root,`source-${row.element}.json`));
    assert.ok(source.metadata.every(m=>m.standalone));
    const raw=Buffer.from(source.geometryRecords[0].hex,'hex');
    assert.equal(sha(raw),source.geometryRecords[0].sha256);
    const solid=decodePlanarPrism(raw,row.element);
    const cleared=Buffer.from(raw);cleared.fill(0,48,144);
    assert.deepEqual(decodePlanarPrism(cleared,row.element).verticesFeet,solid.verticesFeet);
    matchSourceProfile(solid,profiles.profiles.find(p=>p.owner===row.element),lines.lines);
    const b=readFileSync(path.join(root,row.glb));assert.equal(sha(b),row.glbSha256);
    const n=b.readUInt32LE(12),g=JSON.parse(b.subarray(20,20+n)),bin=b.subarray(28+n);
    const p=g.accessors[0],v=g.bufferViews[p.bufferView];assert.equal(p.count,8);
    const points=Array.from({length:8},(_,i)=>[0,1,2].map(k=>bin.readFloatLE(v.byteOffset+i*12+k*4)+g.nodes[0].translation[k]));
    points.forEach((p,i)=>{const error=Math.hypot(...p.map((x,k)=>x-solid.verticesFeet[i][k]*0.3048))*1000;maxErrorMm=Math.max(maxErrorMm,error);assert.ok(error<=0.01);});
    const incidence=new Map();let volume=0,triangles=0;
    const center=[0,1,2].map(k=>points.reduce((s,p)=>s+p[k],0)/8);
    const sub=(a,b)=>a.map((x,k)=>x-b[k]);
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const dot=(a,b)=>a.reduce((s,x,k)=>s+x*b[k],0);
    for(const primitive of g.meshes[0].primitives){
      assert.equal(primitive.extras.sourceElement,row.element);
      const accessor=g.accessors[primitive.indices],view=g.bufferViews[accessor.bufferView];
      for(let i=0;i<accessor.count;i+=3){
        const ids=[0,1,2].map(k=>bin.readUInt16LE(view.byteOffset+(accessor.byteOffset??0)+(i+k)*2));
        const [a,b,c]=ids.map(id=>sub(points[id],center));
        assert.ok(Math.hypot(...cross(sub(b,a),sub(c,a)))>0,'Float32 collapsed triangle');
        volume+=dot(a,cross(b,c))/6;triangles++;
        for(let k=0;k<3;k++){const x=ids[k],y=ids[(k+1)%3],key=[x,y].sort((a,b)=>a-b).join('/');const entries=incidence.get(key)??[];entries.push([x,y]);incidence.set(key,entries);}
      }
    }
    assert.equal(triangles,12);assert.ok(volume>0);
    for(const sides of incidence.values()){assert.equal(sides.length,2);assert.deepEqual(sides[0],[...sides[1]].reverse());}
    assert.ok(Math.abs(volume-solid.volumeCubicFeet*0.3048**3)/(solid.volumeCubicFeet*0.3048**3)<1e-5);
  }
  assert.equal(count,26);console.log(JSON.stringify({solids:count,triangles:count*12,maxErrorMm}));
});
test('partial aggregate preserves accepted identities and explicit rejected scope',()=>{
  assert.deepEqual(evidence.summary.reasons,{'container-placement-unresolved':26,'unsupported-profile':52,'source-planar-solid-preview':26,'conflicting-geometry-records':22});
  const b=readFileSync(path.join(root,'partial-source-solids.glb'));assert.equal(sha(b),evidence.aggregateGlbSha256);
  const g=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)));
  assert.equal(g.nodes.length,26);assert.equal(g.extras.sourceUpAxis,'Z');
  assert.equal(g.extras.quality,'partial-source-planar-solid-preview');
  const accepted=new Set(evidence.results.filter(r=>r.status==='source-planar-solid-preview').map(r=>r.element));
  const exported=new Set(g.meshes.flatMap(m=>m.primitives.map(p=>p.extras.sourceElement)));
  assert.deepEqual(exported,accepted);
});
