import test from 'node:test';
import assert from 'node:assert/strict';
import {auditBrepBoundaries} from './3dm-brep-boundary-audit.mts';

function fixture(){
  const ir={edges:[{}],faces:[{},{}],loops:[{face:0},{face:1}],trims:[{edge:0,loop:0},{edge:0,loop:1}]};
  const parts=[0,1].map(face=>({face,mesh:{positions:[[0,0,0],[1,0,0],[0,1,face?1:0]],triangles:[face?[1,0,2]:[0,1,2]]},boundaryEdges:[{trim:face,vertices:[0,1]}]}));
  return {ir,parts};
}

test('a genuine shared boundary passes its directional topology check',()=>{
  const {ir,parts}=fixture();assert.equal(auditBrepBoundaries(ir,parts).status,'conforming-two-sided-boundary');
});

for(const fault of ['empty','singleton','missing-vertex','nonfinite','same-index','zero-length','duplicate-face']){
  test(`rejects ${fault} without treating an empty comparison as proof`,()=>{
    const {ir,parts}=fixture();
    if(fault==='empty')parts.forEach(p=>p.boundaryEdges[0].vertices=[]);
    if(fault==='singleton')parts.forEach(p=>p.boundaryEdges[0].vertices=[0]);
    if(fault==='missing-vertex')parts[0].boundaryEdges[0].vertices=[0,90];
    if(fault==='nonfinite')parts[0].mesh.positions[0][0]=NaN;
    if(fault==='same-index')parts.forEach(p=>p.boundaryEdges[0].vertices=[0,0]);
    if(fault==='zero-length')parts.forEach(p=>p.mesh.positions[1]=[0,0,0]);
    if(fault==='duplicate-face')parts.push(structuredClone(parts[0]));
    const audit=auditBrepBoundaries(ir,parts);
    assert.equal(audit.status,'unverified-or-nonconforming-boundary');
    if(fault==='duplicate-face')assert.equal(audit.allFacesPresent,false);
    else assert(audit.unverified.length>0||audit.shared.some(s=>!s.conforming));
  });
}
