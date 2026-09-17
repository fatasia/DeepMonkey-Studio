import test from 'node:test';
import assert from 'node:assert/strict';
import {commonKnotBasis} from './3dm-common-knot-basis.mts';
import {matchSourceCurve} from './3dm-source-curve-identity.mts';
import {evaluateCurve} from './3dm-nurbs-parameters.mjs';
const base={dimension:3,degree:2,rational:true,parameterMap:{kind:'identity'},knots:[0,0,0,1,1,1],controlPoints:[[0,0,0,1],[1,2,0,2],[2,0,0,1]]};
const inserted={...base,knots:[0,0,0,.3,1,1,1],controlPoints:[[0,0,0,1],[.3,.6,0,1.3],[1.3,1.4,0,1.7],[2,0,0,1]]};
const net=(c:any)=>({knots:c.knots,points:c.controlPoints});
test('homogeneous knot insertion preserves the full source curve and matches differing bases',()=>{
  const before=JSON.stringify([base,inserted]),[a,b]=commonKnotBasis(2,net(base),net(inserted));assert.deepEqual(a.knots,b.knots);
  const proof=matchSourceCurve(base,inserted,1e-12);assert(proof.bound<1e-12);
  for(let i=0;i<=1000;i++){const t=i/1000,p=evaluateCurve(base,t),q=evaluateCurve({...base,knots:a.knots,controlPoints:a.points},t);assert(Math.hypot(...p.map((x,j)=>x-q[j]))<1e-12);}
  const reverse={...inserted,knots:[...inserted.knots].reverse().map(x=>1-x),controlPoints:[...inserted.controlPoints].reverse()};assert.equal(matchSourceCurve(base,reverse,1e-12).reverse,true);
  assert.equal(JSON.stringify([base,inserted]),before);
});
test('weight changes consume an explicit continuous quotient bound and cannot pass zero tolerance',()=>{
  const changed=structuredClone(inserted);changed.controlPoints[1]=changed.controlPoints[1].map(x=>x*(1+1e-8));const proof=matchSourceCurve(base,changed,1e-5);assert(proof.bound>0);
  for(let i=0;i<=1000;i++){const p=evaluateCurve(base,i/1000),q=evaluateCurve(changed,i/1000);assert(Math.hypot(...p.map((x,j)=>x-q[j]))<=proof.bound);}
  assert.throws(()=>matchSourceCurve(base,changed,0),/mismatch/);
  const invalid=net(structuredClone(inserted));invalid.points[1][3]=0;assert.throws(()=>commonKnotBasis(2,net(base),invalid),/invalid/);
  assert.throws(()=>commonKnotBasis(0,net(base),net(inserted)),/invalid/);
});
