import test from 'node:test';
import assert from 'node:assert/strict';
import {matchSourceCurve} from './3dm-source-curve-identity.mts';
import {evaluateCurve} from './3dm-nurbs-parameters.mjs';
const curve={dimension:3,degree:2,rational:true,parameterMap:{kind:'identity'},knots:[0,0,0,.5,.5,1,1,1],controlPoints:[[0,0,0,1],[1,2,0,2],[2,0,0,1],[3,-2,0,2],[4,0,0,1]]};
test('knot warp has an explicit continuous derivative bound rather than approximate identity',()=>{
  assert.equal(matchSourceCurve(curve,curve,0).bound,0);
  const other=structuredClone(curve);other.knots[3]+=1e-8;other.knots[4]+=1e-8;
  const proof=matchSourceCurve(curve,other,.001);assert(proof.bound>0);
  for(let i=0;i<=1000;i++){const a=evaluateCurve(curve,i/1000),b=evaluateCurve(other,i/1000);assert(Math.hypot(...a.map((x,j)=>x-b[j]))<=proof.bound);}
  assert.throws(()=>matchSourceCurve(curve,other,0),/mismatch/);
  const reverse={...curve,controlPoints:[...curve.controlPoints].reverse()};assert.equal(matchSourceCurve(curve,reverse,0).reverse,true);
  const weight=structuredClone(curve);weight.controlPoints[1][3]+=.01;assert.throws(()=>matchSourceCurve(curve,weight,.01),/mismatch/);
});
