import { polynomialDerivative } from './3dm-polynomial-surface.mts';
import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
/** Exact source Bezier spans, positive weight quotient bounds, no sampled curvature estimate. */
export function rationalBezierBounds(s:any) {
  check(s?.dimension===3&&s.parameterMap?.kind==='identity'&&s.degree?.length===2
    &&(s.rational?s.degree[0]===3&&s.degree[1]===2||s.degree[0]===2&&s.degree[1]===1:s.degree.every((d:number)=>d===3))
    &&s.controlPointCount?.length===2,'unsupported-rational-cubic-quadratic');
  const breaks=s.degree.map((degree:number,axis:number)=>{
    const count=s.controlPointCount[axis],knots=s.knots?.[axis],domain=s.domain?.[axis];
    check(Number.isInteger(count)&&count>=degree+1&&count<=256&&domain?.length===2&&domain.every(Number.isFinite)&&domain[0]<domain[1]
      &&knots?.length===count+degree+1&&knots.every((x:number,i:number)=>Number.isFinite(x)&&(!i||x>=knots[i-1])),'invalid-rational-bezier-knots');
    const values=[...new Set<number>(knots)];
    check(values[0]===domain[0]&&values.at(-1)===domain[1]&&values.every((x,i)=>knots.filter((k:number)=>k===x).length===(i===0||i===values.length-1?degree+1:degree)),
      'unsupported-rational-bezier-knot-multiplicity');return values;
  });
  check(s.controlPoints?.length===s.controlPointCount[0]*s.controlPointCount[1]&&s.controlPoints.every((p:number[])=>p.length===(s.rational?4:3)&&p.every(Number.isFinite)&&(!s.rational||p[3]>0)),
    'invalid-rational-bezier-weights');
  const patches:any[]=[],first=[0,0],second=[0,0,0];
  for(let v=0;v<breaks[1].length-1;v++)for(let u=0;u<breaks[0].length-1;u++) {
    const points=Array.from({length:s.degree[1]+1},(_,j)=>Array.from({length:s.degree[0]+1},(_,i)=>{
      const p=s.controlPoints[(v*s.degree[1]+j)*s.controlPointCount[0]+u*s.degree[0]+i];return s.rational?p:[...p,1];})).flat();
    const origin=points[0].slice(0,3).map((x:number)=>x/points[0][3]),minWeight=Math.min(...points.map((p:number[])=>p[3]));
    const domain=[[breaks[0][u],breaks[0][u+1]],[breaks[1][v],breaks[1][v+1]]];
    const h={dimension:4,rational:false,degree:[...s.degree],controlPointCount:s.degree.map((d:number)=>d+1),domain,
      knots:domain.map((d,i)=>[...Array(s.degree[i]+1).fill(d[0]),...Array(s.degree[i]+1).fill(d[1])]),
      controlPoints:points.map((p:number[])=>[...p.slice(0,3).map((x,i)=>(x-origin[i]*p[3])/minWeight),p[3]/minWeight])};
    const derivative=(net:any,axis:number)=>net.degree[axis]===0?{...net,controlPoints:net.controlPoints.map((p:number[])=>p.map(()=>0))}:polynomialDerivative(net,axis);
    const du=derivative(h,0),dv=derivative(h,1),nets=[du,dv,derivative(du,0),derivative(du,1),derivative(dv,1)];
    const A=nets.map(n=>Math.max(...n.controlPoints.map(p=>Math.hypot(...p.slice(0,3))))),W=nets.map(n=>Math.max(...n.controlPoints.map(p=>Math.abs(p[3]))));
    const radius=Math.max(...h.controlPoints.map(p=>Math.hypot(...p.slice(0,3).map(x=>x/p[3]))));
    // Normalized w >= 1. R_i=(A_i-R*w_i)/w; differentiate once more, including mixed terms.
    const F=[A[0]+radius*W[0],A[1]+radius*W[1]];
    const S=[A[2]+radius*W[2]+2*F[0]*W[0],A[3]+radius*W[3]+F[0]*W[1]+F[1]*W[0],A[4]+radius*W[4]+2*F[1]*W[1]];
    check([...F,...S].every(Number.isFinite),'nonfinite-rational-derivative-bound');
    F.forEach((x,i)=>first[i]=Math.max(first[i],x));S.forEach((x,i)=>second[i]=Math.max(second[i],x));
    patches.push({domain,h,du,dv,first:F,second:S,minWeight});
  }
  const tangent=(uv:number[])=>{
    const patch=patches.find(p=>uv.every((x,i)=>x>=p.domain[i][0]&&(x<p.domain[i][1]||x===p.domain[i][1]&&x===s.domain[i][1])));
    check(patch,'rational-tangent-outside-domain');
    const H=evaluateSurface(patch.h,uv),R=H.slice(0,3).map((x:number)=>x/H[3]);
    return [patch.du,patch.dv].map(d=>{const D=evaluateSurface(d,uv);return R.map((x:number,i:number)=>(D[i]-x*D[3])/H[3]);});
  };
  return {first,second,breaks,tangent,patches:patches.map(({domain,first,second,minWeight})=>({domain,first,second,minWeight}))};
}
