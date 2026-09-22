import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import {matchSourceCurve} from './3dm-source-curve-identity.mts';
import {sourceBezierChainInterval} from './3dm-source-bezier-interval.mts';
import {rationalBezierBounds} from './3dm-rational-bezier-bounds.mts';
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
/** Match an authored full/restricted C0-chain isocurve to C3; bound trim-axis drift in source UV. */
export function proveSourceIsocurve(ir:any,part:any,edgeIndex:number) {
  const edge=ir.edges[edgeIndex],curve=ir.curves3d[edge.curve3d],s=ir.surfaces[ir.faces[part.face].surface];
  check(['cad-ir-rational-bezier-chain','cad-ir-trimmed-cylinder','cad-ir-proven-cylinder'].includes(part.geometrySource)&&s.parameterMap?.kind==='identity'&&curve.parameterMap?.kind==='identity'
    &&curve.rational,'unsupported-source-isocurve');
  const boundary=part.boundaryEdges.find((b:any)=>b.edge===edgeIndex),trim=ir.trims[boundary?.trim],c2=ir.curves2d[trim?.curve2d];
  check(Array.isArray(part.audit?.uv),'missing-source-isocurve-uv');
  check(c2?.degree===1&&!c2.rational&&c2.controlPoints.length===2&&c2.parameterMap?.kind==='identity','unsupported-source-isocurve-trim');
  check(c2.knots.length===4&&c2.knots.every((x:number,i:number)=>x===trim.sourceSubdomain[i<2?0:1]),'partial-source-isocurve-trim');
  const [a,b]=c2.controlPoints,fixed=[0,1].find(axis=>Math.abs(a[axis]-b[axis])<=1e-10&&[a,b].every(p=>p[axis]>=s.domain[axis][0]&&p[axis]<=s.domain[axis][1])
    &&(s.domain[axis].includes(a[axis])||s.degree[axis]===1&&s.controlPointCount[axis]===2));
  check(fixed!==undefined,'non-boundary-source-isocurve');const variable=1-fixed;
  const interval=[Math.min(a[variable],b[variable]),Math.max(a[variable],b[variable])];
  check(s.degree[variable]===curve.degree&&interval[0]>=s.domain[variable][0]&&interval[1]<=s.domain[variable][1]&&interval[0]<interval[1],
    'partial-source-isocurve');
  const n=s.controlPointCount[variable],domain=edge.sourceSubdomain;
  check(curve.knots[curve.degree]===domain[0]&&curve.knots[curve.controlPoints.length]===domain[1]
    &&s.knots[fixed].slice(0,s.degree[fixed]+1).every((k:number)=>k===s.domain[fixed][0])
    &&s.knots[fixed].slice(-s.degree[fixed]-1).every((k:number)=>k===s.domain[fixed][1]),'non-clamped-source-isocurve');
  const row=a[fixed]===s.domain[fixed][0]?0:s.controlPointCount[fixed]-1;
  const points=Array.from({length:n},(_,i)=>{
    if(s.domain[fixed].includes(a[fixed]))return s.controlPoints[fixed===0?i*s.controlPointCount[0]+row:row*s.controlPointCount[0]+i];
    const t=(a[fixed]-s.domain[fixed][0])/(s.domain[fixed][1]-s.domain[fixed][0]);
    const start=s.controlPoints[fixed===0?i*s.controlPointCount[0]:i],end=s.controlPoints[fixed===0?i*s.controlPointCount[0]+1:s.controlPointCount[0]+i];
    return start.map((x:number,k:number)=>x===end[k]?x:(1-t)*x+t*end[k]);
  });
  let iso={degree:s.degree[variable],rational:s.rational,knots:s.knots[variable],controlPoints:points};
  if(interval.some((x,i)=>x!==s.domain[variable][i]))iso=sourceBezierChainInterval(iso,interval);
  const drift=Math.abs(a[fixed]-b[fixed]),driftBound=drift?rationalBezierBounds(s).first[fixed]*drift:0;
  const match=matchSourceCurve(iso,curve,Math.min(1e-10,edge.tolerance+1e-12)-driftBound);
  for(const id of boundary.vertices){const uv=part.audit.uv[id];
    check(uv?.length===2&&Math.abs(uv[fixed]-a[fixed])<=drift+1e-11&&uv[variable]>=interval[0]-1e-12&&uv[variable]<=interval[1]+1e-12
      &&distance(part.mesh.positions[id],evaluateSurface(s,uv))<=1e-10,'source-isocurve-mesh-mismatch');}
  const toParameter=(uv:number[])=>{const f=(uv[variable]-interval[0])/(interval[1]-interval[0]);return match.reverse?1-f:f;};
  const toUv=(t:number)=>{const uv=[...a];uv[variable]=interval[0]+(match.reverse?1-t:t)*(interval[1]-interval[0]);
    if(drift)uv[fixed]=a[fixed]+(b[fixed]-a[fixed])*(uv[variable]-a[variable])/(b[variable]-a[variable]);return uv;};
  for(const id of boundary.vertices)check(distance(part.mesh.positions[id],evaluateSurface(s,toUv(toParameter(part.audit.uv[id]))))<=Math.min(1e-10,edge.tolerance+1e-12),'source-isocurve-trim-mesh-mismatch');
  return {boundary,surface:s,variable,toParameter,toUv,continuousBound:match.bound+driftBound};
}
