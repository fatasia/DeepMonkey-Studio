import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {closeSourceProfile,sourceProfiles} from './lib/rvtSourceProfiles.mjs';
const lines=points=>points.map((p,i)=>({element:i+1,endpointsFeet:[p,points[(i+1)%points.length]]}));
test('source directions close a slanted profile without bbox inference',()=>{
  const source=lines([[0,0,2],[4,3,2],[5,8,2],[1,5,2]]);
  const before=structuredClone(source),result=closeSourceProfile(source);
  assert.equal(result.status,'closed-source-wire');assert.equal(result.loops[0].signedAreaSquareFeet,17);
  assert.deepEqual(source,before);assert.equal(result.surfaceOrSolidCertified,false);
});
test('missing, branching, repeated and crossing source curves reject',()=>{
  const source=lines([[0,0,2],[4,0,2],[4,4,2],[0,4,2]]);
  assert.equal(closeSourceProfile(source,[{}]).status,'incomplete-source-curves');
  assert.notEqual(closeSourceProfile(source.slice(0,3)).status,'closed-source-wire');
  assert.equal(closeSourceProfile([...source,source[0]]).status,'duplicate-element');
  assert.notEqual(closeSourceProfile(lines([[0,0,0],[4,4,0],[0,4,0],[4,0,0]])).status,'closed-source-wire');
  assert.equal(closeSourceProfile(lines([[0,0,0],[4,0,0],[4,4,1],[0,4,0]])).status,'non-horizontal-profile');
});
test('real 2024 payload produces complete source wires, preserving diagonal direction',()=>{
  const path=process.env.RVT_LINE_EVIDENCE;
  assert.ok(path,'Set RVT_LINE_EVIDENCE to the generated real-source audit');
  const report=JSON.parse(readFileSync(path));
  assert.equal(report.sourceSha256,'c805df445d613b408e37337765572021265e3f5dfdc7d1fa53b22ba1600b8014');
  assert.equal(report.lines.length,2483);assert.equal(report.rejected.length,581);
  const diagonal=report.lines.find(x=>x.element===20955);
  const [a,b]=diagonal.endpointsFeet;
  assert.ok(Math.abs(a[0]-136.5)<1e-10&&Math.abs(a[1]-123)<1e-10);
  assert.ok(Math.abs(b[0]-161.5)<1e-10&&Math.abs(b[1]-115)<1e-10);
  assert.ok(diagonal.witnesses.length>=2);
  assert.equal(new Set(diagonal.witnesses.map(w=>w.recordSha256)).size,1);
  const profiles=sourceProfiles(report),closed=profiles.filter(p=>p.status==='closed-source-wire');
  assert.equal(closed.length,101);
  const rectangle=closed.find(p=>p.owner===16317);
  assert.equal(rectangle.sourceLineCount,4);assert.equal(rectangle.loops.length,1);
  assert.ok(Math.abs(Math.abs(rectangle.loops[0].signedAreaSquareFeet)-13083)<1e-8);
  for(const profile of closed)assert.equal(profile.loops.reduce((n,l)=>n+l.elements.length,0),profile.sourceLineCount);
});
test('real GLB contains only source line pairs with bounded Float32 error',()=>{
  assert.ok(process.env.RVT_WIRE_GLB,'Set RVT_WIRE_GLB to the generated source wire GLB');
  const report=JSON.parse(readFileSync(process.env.RVT_LINE_EVIDENCE)),linesById=new Map(report.lines.map(l=>[l.element,l]));
  const b=readFileSync(process.env.RVT_WIRE_GLB);
  assert.equal(b.readUInt32LE(0),0x46546c67);assert.equal(b.readUInt32LE(8),b.length);
  const size=b.readUInt32LE(12),g=JSON.parse(b.subarray(20,20+size)),bin=b.subarray(28+size);
  assert.equal(g.extras.buildingSolidGeometry,'missing');assert.equal(g.nodes.length,101);
  let count=0,maxError=0;
  for(const node of g.nodes){const primitive=g.meshes[node.mesh].primitives[0];assert.equal(primitive.mode,1);
    const accessor=g.accessors[primitive.attributes.POSITION],view=g.bufferViews[accessor.bufferView];
    assert.equal(accessor.count,primitive.extras.sourceElements.length*2);
    primitive.extras.sourceElements.forEach((id,i)=>{const line=linesById.get(id);assert.equal(line.owner,node.extras.sourceOwner);
      line.endpointsFeet.forEach((point,end)=>point.forEach((v,axis)=>{
        const actual=bin.readFloatLE(view.byteOffset+(2*i+end)*12+axis*4)+node.translation[axis];
        maxError=Math.max(maxError,Math.abs(actual-v*0.3048)*1000);
      }));count++;
    });
  }
  assert.equal(count,1781);assert.ok(maxError<=0.01);
});
