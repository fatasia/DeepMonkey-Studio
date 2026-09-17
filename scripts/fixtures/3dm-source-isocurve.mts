import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import {matchSourceCurve} from './3dm-source-curve-identity.mts';
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
/** Match the full boundary control net to C3 under an affine parameter map, never closest-point fitting. */
export function proveSourceIsocurve(ir:any,part:any,edgeIndex:number) {
  const edge=ir.edges[edgeIndex],curve=ir.curves3d[edge.curve3d],s=ir.surfaces[ir.faces[part.face].surface];
  check(['cad-ir-rational-bezier-chain','cad-ir-trimmed-cylinder','cad-ir-proven-cylinder'].includes(part.geometrySource)&&s.parameterMap?.kind==='identity'&&curve.parameterMap?.kind==='identity'
    &&curve.rational,'unsupported-source-isocurve');
  const boundary=part.boundaryEdges.find((b:any)=>b.edge===edgeIndex),trim=ir.trims[boundary?.trim],c2=ir.curves2d[trim?.curve2d];
  check(Array.isArray(part.audit?.uv),'missing-source-isocurve-uv');
  check(c2?.degree===1&&!c2.rational&&c2.controlPoints.length===2&&c2.parameterMap?.kind==='identity','unsupported-source-isocurve-trim');
  check(c2.knots.length===4&&c2.knots.every((x:number,i:number)=>x===trim.sourceSubdomain[i<2?0:1]),'partial-source-isocurve-trim');
  const [a,b]=c2.controlPoints,fixed=[0,1].find(axis=>a[axis]===b[axis]&&a[axis]>=s.domain[axis][0]&&a[axis]<=s.domain[axis][1]
    &&(s.domain[axis].includes(a[axis])||s.degree[axis]===1&&s.controlPointCount[axis]===2));
  check(fixed!==undefined,'non-boundary-source-isocurve');const variable=1-fixed;
  check(s.degree[variable]===curve.degree&&s.controlPointCount[variable]===curve.controlPoints.length
    &&Math.min(a[variable],b[variable])===s.domain[variable][0]&&Math.max(a[variable],b[variable])===s.domain[variable][1],
    'partial-source-isocurve');
  const n=curve.controlPoints.length,domain=edge.sourceSubdomain;
  check(curve.knots[curve.degree]===domain[0]&&curve.knots[n]===domain[1]
    &&s.knots[fixed].slice(0,s.degree[fixed]+1).every((k:number)=>k===s.domain[fixed][0])
    &&s.knots[fixed].slice(-s.degree[fixed]-1).every((k:number)=>k===s.domain[fixed][1]),'non-clamped-source-isocurve');
  const row=a[fixed]===s.domain[fixed][0]?0:s.controlPointCount[fixed]-1;
  const points=Array.from({length:n},(_,i)=>{
    if(s.domain[fixed].includes(a[fixed]))return s.controlPoints[fixed===0?i*s.controlPointCount[0]+row:row*s.controlPointCount[0]+i];
    const t=(a[fixed]-s.domain[fixed][0])/(s.domain[fixed][1]-s.domain[fixed][0]);
    const start=s.controlPoints[fixed===0?i*s.controlPointCount[0]:i],end=s.controlPoints[fixed===0?i*s.controlPointCount[0]+1:s.controlPointCount[0]+i];
    return start.map((x:number,k:number)=>x===end[k]?x:(1-t)*x+t*end[k]);
  });
  const match=matchSourceCurve({degree:s.degree[variable],rational:s.rational,knots:s.knots[variable],controlPoints:points},curve,Math.min(1e-10,edge.tolerance+1e-12));
  for(const id of boundary.vertices){const uv=part.audit.uv[id];
    check(uv?.length===2&&Math.abs(uv[fixed]-a[fixed])<=1e-11&&uv[variable]>=s.domain[variable][0]&&uv[variable]<=s.domain[variable][1]
      &&distance(part.mesh.positions[id],evaluateSurface(s,uv))<=1e-10,'source-isocurve-mesh-mismatch');}
  const toParameter=(uv:number[])=>{const d=s.domain[variable],f=(uv[variable]-d[0])/(d[1]-d[0]);return match.reverse?1-f:f;};
  const toUv=(t:number)=>{const uv=[...a],d=s.domain[variable];uv[variable]=d[0]+(match.reverse?1-t:t)*(d[1]-d[0]);return uv;};
  return {boundary,surface:s,variable,toParameter,toUv,continuousBound:match.bound};
}
