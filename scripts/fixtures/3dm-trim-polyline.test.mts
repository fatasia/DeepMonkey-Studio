import test from 'node:test';
import assert from 'node:assert/strict';
import { trimPolyline } from './3dm-trim-polyline.mts';
import { evaluateCurve } from './3dm-nurbs-parameters.mjs';

function nearest(point:number[],line:number[][]) {
  return Math.min(...line.slice(1).map((b,i)=>{
    const a=line[i],u=b.map((x,j)=>x-a[j]),d=u[0]**2+u[1]**2;
    const t=d?Math.max(0,Math.min(1,((point[0]-a[0])*u[0]+(point[1]-a[1])*u[1])/d)):0;
    return Math.hypot(...a.map((x,j)=>point[j]-x-t*u[j]));
  }));
}
test('rational knot insertion, partial spans and reverse preserve curve under convex-hull chord budget',()=>{
  const curve={dimension:2,degree:3,rational:true,parameterMap:{kind:'identity'},knots:[0,0,0,0,.3,.7,1,1,1,1],
    controlPoints:[[0,0,1],[2,4,2],[1,-2,.7],[4,1,1],[4,6,2],[5,0,1]]};
  for(const domain of [[0,1],[.13,.87],[.3,.7]]) {
    const actual=trimPolyline(curve,domain,false,.001);
    assert(actual.maxBound<=.001);
    for(let i=0;i<=2000;i++) assert(nearest(evaluateCurve(curve,domain[0]+(domain[1]-domain[0])*i/2000),actual.points)<=.001+1e-12);
    assert.deepEqual(trimPolyline(curve,domain,true,.001).points,actual.points.toReversed());
  }
});
test('invalid weights, discontinuities, domains and exhausted budgets are rejected',()=>{
  const base={dimension:2,degree:2,rational:true,parameterMap:{kind:'identity'},knots:[0,0,0,1,1,1],controlPoints:[[0,0,1],[1,10,1],[2,0,1]]};
  for(const curve of [{...base,controlPoints:[[0,0,1],[1,10,0],[2,0,1]]},
    {...base,parameterMap:{kind:'unsupported'}},{...base,knots:[0,0,0,1,0,1]}]) assert.throws(()=>trimPolyline(curve,[0,1],false,.001));
  assert.throws(()=>trimPolyline(base,[-1,1],false,.001));
  assert.throws(()=>trimPolyline(base,[0,1],false,1e-30),/budget/);
});
