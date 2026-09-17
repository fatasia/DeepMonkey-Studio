import {evaluateSurface} from './3dm-nurbs-parameters.mjs';
function check(v:unknown,m:string):asserts v {if(!v)throw Error(m);}
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
/** Common rational basis gives a convex control bound; C0 knot drift adds an explicit derivative bound. */
export function matchSourceCurve(a:any,b:any,limit:number){
  check(a.degree===b.degree&&a.controlPoints.length===b.controlPoints.length&&a.knots.length===b.knots.length,'source-curve-basis-mismatch');
  const normalize=(c:any)=>{const p=c.degree,d=[c.knots[p],c.knots[c.controlPoints.length]];
    check(Number.isInteger(p)&&p>0&&c.knots.length===c.controlPoints.length+p+1&&c.knots.every((x:number,i:number)=>Number.isFinite(x)&&(!i||x>=c.knots[i-1]))
      &&d[1]>d[0]&&c.knots.slice(0,p+1).every((x:number)=>x===d[0])&&c.knots.slice(-p-1).every((x:number)=>x===d[1]),'unclamped-source-curve');
    const points=c.controlPoints.map((v:number[])=>c.rational?v:[...v,1]);check(points.every((v:number[])=>v.length===4&&v.every(Number.isFinite)&&v[3]>0),'invalid-source-curve-weights');
    return {knots:c.knots.map((x:number)=>(x-d[0])/(d[1]-d[0])),points};};
  const aa=normalize(a),bb=normalize(b);let best:any;
  for(const reverse of [false,true]){const points=reverse?[...bb.points].reverse():bb.points,knots=reverse?[...bb.knots].reverse().map(x=>1-x):bb.knots;
    const delta=Math.max(...aa.knots.map((x:number,i:number)=>Math.abs(x-knots[i])));
    let knotBound=0;
    if(delta){
      // C0 Bezier chains differ only by a piecewise-affine knot warp. Bound its
      // parameter displacement with a rational first-derivative convex bound.
      const spans=[...new Set<number>(knots)],otherSpans=[...new Set<number>(aa.knots)];
      if(spans.length!==otherSpans.length||[knots,aa.knots].some(k=>[...new Set<number>(k)].slice(1,-1).some(x=>k.filter((v:number)=>v===x).length!==a.degree)))continue;
      const minSpan=Math.min(...spans.slice(1).map((x,i)=>x-spans[i]),...otherSpans.slice(1).map((x,i)=>x-otherSpans[i]));
      if(delta>=minSpan/4)continue;
      const origin=points[0].slice(0,3).map((x:number)=>x/points[0][3]);
      const radius=Math.max(...points.map((p:number[])=>distance(p.slice(0,3).map(x=>x/p[3]),origin))),weights=points.map((p:number[])=>p[3]);
      knotBound=3*a.degree*radius*Math.max(...weights)/Math.min(...weights)*2*delta/minSpan;
    }
    // Exact proportional weights only: no sampled or approximate rational identity.
    if(!aa.points.every((p:number[],i:number)=>p[3]/aa.points[0][3]===points[i][3]/points[0][3]))continue;
    const bound=knotBound+Math.max(...aa.points.map((p:number[],i:number)=>distance(p.slice(0,3).map(x=>x/p[3]),points[i].slice(0,3).map((x:number)=>x/points[i][3]))));
    if(!best||bound<best.bound)best={reverse,bound};
  }
  check(best&&best.bound<=limit,'source-curve-control-mismatch');return best as {reverse:boolean,bound:number};
}
export function provePlaneTrimIdentity(ir:any,face:number,edgeIndex:number){
  const edge=ir.edges[edgeIndex],s=ir.surfaces[ir.faces[face].surface],trimIndex=ir.trims.findIndex((t:any)=>t.edge===edgeIndex&&ir.loops[t.loop].face===face),trim=ir.trims[trimIndex],c=ir.curves2d[trim?.curve2d],c3=ir.curves3d[edge.curve3d];
  check(s.parameterMap?.kind==='identity'&&!s.rational&&s.degree.every((x:number)=>x===1)&&s.controlPointCount.every((x:number)=>x===2),'unsupported-source-plane');
  const cp=s.controlPoints,affineError=distance(cp[3],cp[1].map((x:number,i:number)=>x+cp[2][i]-cp[0][i]));
  check(affineError<=1e-12&&c?.parameterMap?.kind==='identity'&&c3?.parameterMap?.kind==='identity','unsupported-source-plane-map');
  check([c,c3].every((curve,i)=>curve.knots[curve.degree]===(i?edge:trim).sourceSubdomain[0]&&curve.knots[curve.controlPoints.length]===(i?edge:trim).sourceSubdomain[1]),'partial-source-plane-curve');
  const points=c.controlPoints.map((p:number[])=>{const w=c.rational?p[2]:1,uv=p.slice(0,2).map(x=>x/w);
    check(w>0&&uv.every((x,i)=>x>=s.domain[i][0]&&x<=s.domain[i][1]),'source-plane-control-outside-domain');
    return [...evaluateSurface(s,uv).map((x:number)=>x*w),w];});
  const match=matchSourceCurve({...c,rational:true,controlPoints:points},c3,Math.min(1e-10,edge.tolerance+1e-12)-affineError);
  return {trim:trimIndex,curve:c,surface:s,reverse:match.reverse,continuousBound:match.bound+affineError};
}
