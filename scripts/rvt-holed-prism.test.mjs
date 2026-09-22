import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodeHoledPrism,matchHoledSourceProfile,validatePlanarLoops} from './lib/rvtHoledPrism.mjs';
for(const key of ['RVT_HOLED_OUTPUT','RVT_PRISM_PROFILES','RVT_PRISM_LINES'])assert.ok(process.env[key],`Set ${key}`);
const root=process.env.RVT_HOLED_OUTPUT,json=p=>JSON.parse(readFileSync(p)),evidence=json(path.join(root,'evidence.json'));
const source=id=>json(path.join(root,`source-${id}.json`));
const raw=id=>Buffer.from(source(id).geometryRecords[0].hex,'hex');
const sub=(a,b)=>a.map((x,k)=>x-b[k]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dot=(a,b)=>a.reduce((s,x,k)=>s+x*b[k],0);
const orient=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const inTriangle=(p,t)=>{const signs=t.map((a,i)=>orient(a,t[(i+1)%3],p));return signs.every(x=>x>=-1e-8)||signs.every(x=>x<=1e-8);};
test('real nonrectangular cap retains one hole and all source boundaries independently of bbox',()=>{
  const b=raw(20311),s=decodeHoledPrism(b,20311);
  assert.equal(s.verticesFeet.length,62);assert.equal(s.sourceEdges.length,93);assert.equal(s.faces.length,33);assert.equal(s.triangles.length,124);
  assert.ok(Math.abs(s.faces.find(f=>f.id===4).areaSquareFeet-3305)<1e-7);
  assert.ok(Math.abs(s.volumeCubicFeet-3305/6)<1e-7);
  const cleared=Buffer.from(b);cleared.fill(0,48,144);assert.deepEqual(decodeHoledPrism(cleared,20311).verticesFeet,s.verticesFeet);
  const profiles=json(process.env.RVT_PRISM_PROFILES),lines=json(process.env.RVT_PRISM_LINES),profile=profiles.profiles.find(p=>p.owner===20311);
  assert.equal(matchHoledSourceProfile(s,profile,lines.lines).sourceLineIds.length,31);
  assert.throws(()=>matchHoledSourceProfile(s,{...profile,loops:profile.loops.slice(0,1)},lines.lines),/two-loop/);
  const moved=structuredClone(lines.lines);moved.find(l=>l.element===20339).endpointsFeet[0][0]+=.1;
  assert.throws(()=>matchHoledSourceProfile(s,profile,moved),/mismatch/);
});
test('outside, nested, touching and crossing holes reject; malformed source bytes reject',()=>{
  const outer=[[0,0],[10,0],[10,10],[0,10]],hole=[[2,2],[2,4],[4,4],[4,2]];
  assert.equal(validatePlanarLoops([outer,hole]),0);assert.equal(validatePlanarLoops([[...hole].reverse(),[...outer].reverse()]),1);
  assert.throws(()=>validatePlanarLoops([outer,hole.map(p=>[p[0]+20,p[1]])]),/outside/);
  assert.throws(()=>validatePlanarLoops([outer,hole,[[2.5,2.5],[3,2.5],[3,3],[2.5,3]]]),/nested/);
  assert.throws(()=>validatePlanarLoops([outer,[[0,2],[2,2],[2,4],[0,4]]]),/touching/);
  assert.throws(()=>validatePlanarLoops([outer,[[9,2],[12,2],[12,4],[9,4]]]),/crossing/);
  const b=raw(20311);for(const at of [0,12,16,26,144,176,180,398,3010+20,13788,22993]){const bad=Buffer.from(b);bad[at]^=1;assert.throws(()=>decodeHoledPrism(bad,20311),undefined,`byte ${at}`);}
  const side=Buffer.from(b);side.writeDoubleLE(side.readDoubleLE(3010+48)+.01,3010+48);assert.throws(()=>decodeHoledPrism(side,20311),/residual|domain/);
  assert.throws(()=>decodeHoledPrism(b.subarray(0,b.length-1),20311));
});
test('42 actual GLBs preserve genus-one closed shells, empty holes and Float32 budget',()=>{
  assert.deepEqual(evidence.summary,{'source-holed-planar-solid-preview':42});let maxErrorMm=0,minDoubleArea=Infinity;
  for(const row of evidence.results){
    const s=decodeHoledPrism(raw(row.element),row.element),b=readFileSync(path.join(root,row.glb));
    assert.equal(createHash('sha256').update(b).digest('hex'),row.glbSha256);
    const n=b.readUInt32LE(12),g=JSON.parse(b.subarray(20,20+n)),bin=b.subarray(28+n),a=g.accessors[0],v=g.bufferViews[a.bufferView];
    assert.equal(a.count,62);assert.equal(g.meshes[0].primitives.length,33);
    const points=Array.from({length:a.count},(_,i)=>[0,1,2].map(k=>(bin.readFloatLE(v.byteOffset+i*12+k*4)+g.nodes[0].translation[k])/0.3048));
    points.forEach((p,i)=>{const error=Math.hypot(...sub(p,s.verticesFeet[i]))*304.8;maxErrorMm=Math.max(maxErrorMm,error);assert.ok(error<=.01);});
    const center=[0,1,2].map(k=>points.reduce((sum,p)=>sum+p[k],0)/points.length),incidence=new Map();let volume=0,count=0;
    for(const primitive of g.meshes[0].primitives){
      assert.equal(primitive.extras.sourceElement,row.element);const accessor=g.accessors[primitive.indices],view=g.bufferViews[accessor.bufferView];
      for(let i=0;i<accessor.count;i+=3){
        const ids=[0,1,2].map(k=>bin.readUInt16LE(view.byteOffset+accessor.byteOffset+(i+k)*2)),p=ids.map(i=>points[i]),[a,b,c]=p.map(p=>sub(p,center));
        const normal=cross(sub(b,a),sub(c,a)),doubleArea=Math.hypot(...normal);assert.ok(doubleArea>1e-8);minDoubleArea=Math.min(minDoubleArea,doubleArea);volume+=dot(a,cross(b,c))/6;count++;
        for(let k=0;k<3;k++){const x=ids[k],y=ids[(k+1)%3],key=[x,y].sort((a,b)=>a-b).join('/'),values=incidence.get(key)??[];values.push([x,y]);incidence.set(key,values);}
        if([4,5].includes(primitive.extras.sourceFace)){
          const centroid=[0,1].map(k=>p.reduce((sum,v)=>sum+v[k],0)/3);
          assert.ok(!(centroid[0]>20+1e-5&&centroid[0]<167-1e-5&&centroid[1]>25+1e-5&&centroid[1]<114-1e-5),'cap triangle fills source hole');
          for(const holePoint of [[93.5,69.5],[21,26],[166,113],[21,113],[166,26]])assert.ok(!inTriangle(holePoint,p),'source opening is covered');
        }
      }
    }
    assert.equal(count,124);assert.equal(points.length-incidence.size+count,0,'genus-one Euler characteristic');
    for(const sides of incidence.values()){assert.equal(sides.length,2);assert.deepEqual(sides[0],[...sides[1]].reverse());}
    assert.ok(volume>0&&Math.abs(volume-s.volumeCubicFeet)/s.volumeCubicFeet<1e-5);
  }
  console.log(JSON.stringify({solids:42,triangles:42*124,maxErrorMm,minDoubleAreaSquareFeet:minDoubleArea}));
});
