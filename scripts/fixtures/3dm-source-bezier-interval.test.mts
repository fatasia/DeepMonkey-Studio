import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceBezierInterval} from './3dm-source-bezier-interval.mts';
import {evaluateCurve} from './3dm-nurbs-parameters.mjs';
const curve={dimension:3,degree:2,rational:true,parameterMap:{kind:'identity'},knots:[0,0,0,1,1,2,2,2],controlPoints:[[0,0,0,1],[1,2,0,2],[2,0,0,1],[3,-2,0,2],[4,0,0,1]]};
test('exact homogeneous restriction preserves the source parameter interval and original curve',()=>{
  const before=JSON.stringify(curve);for(const d of [[0,1],[.2,.8],[1.2,1.9]]){const part=sourceBezierInterval(curve,d);assert.equal(part.controlPoints.length,3);
    for(let i=0;i<=100;i++){const t=d[0]+(d[1]-d[0])*i/100,a=evaluateCurve(curve,t),b=evaluateCurve(part,t);assert(Math.hypot(...a.map((x,j)=>x-b[j]))<1e-12);}}
  assert.equal(JSON.stringify(curve),before);
});
test('cross-knot, empty and non-Bezier intervals fail instead of approximating',()=>{
  assert.throws(()=>sourceBezierInterval(curve,[.2,1.2]),/crosses-knot/);assert.throws(()=>sourceBezierInterval(curve,[.2,.2]),/unsupported/);
  const invalid={...curve,knots:[0,0,0,.5,1,2,2,2]};assert.throws(()=>sourceBezierInterval(invalid,[.2,.4]),/non-bezier/);
});
