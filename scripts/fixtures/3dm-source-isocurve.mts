import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
/** Match the full boundary control net to C3 under an affine parameter map, never closest-point fitting. */
export function proveSourceIsocurve(ir:any,part:any,edgeIndex:number) {
  const edge=ir.edges[edgeIndex],curve=ir.curves3d[edge.curve3d],s=ir.surfaces[ir.faces[part.face].surface];
  check(part.geometrySource==='cad-ir-rational-bezier-chain'&&s.parameterMap?.kind==='identity'&&curve.parameterMap?.kind==='identity'
    &&curve.rational&&curve.controlPoints.length===curve.degree+1,'unsupported-source-isocurve');
  const boundary=part.boundaryEdges.find((b:any)=>b.edge===edgeIndex),trim=ir.trims[boundary?.trim],c2=ir.curves2d[trim?.curve2d];
  check(c2?.degree===1&&!c2.rational&&c2.controlPoints.length===2&&c2.parameterMap?.kind==='identity','unsupported-source-isocurve-trim');
  const [a,b]=c2.controlPoints,fixed=[0,1].find(axis=>a[axis]===b[axis]&&s.domain[axis].includes(a[axis]));
  check(fixed!==undefined,'non-boundary-source-isocurve');const variable=1-fixed;
  check(s.degree[variable]===curve.degree&&s.controlPointCount[variable]===curve.degree+1
    &&Math.min(a[variable],b[variable])===s.domain[variable][0]&&Math.max(a[variable],b[variable])===s.domain[variable][1],
    'partial-source-isocurve');
  const n=curve.degree+1,domain=edge.sourceSubdomain;
  check(curve.knots.length===2*n&&curve.knots.every((k:number,i:number)=>k===domain[i<n?0:1])
    &&s.knots[variable].every((k:number,i:number)=>k===s.domain[variable][i<n?0:1]),'non-bezier-source-isocurve');
  const row=a[fixed]===s.domain[fixed][0]?0:s.controlPointCount[fixed]-1;
  const points=Array.from({length:n},(_,i)=>s.controlPoints[fixed===0?i*s.controlPointCount[0]+row:row*s.controlPointCount[0]+i]);
  let match:any;
  for(const reverse of [false,true]){
    const other=reverse?[...curve.controlPoints].reverse():curve.controlPoints;
    if(!points.every((p:number[],i:number)=>p[3]>0&&p[3]===other[i][3]))continue;
    const bound=Math.max(...points.map((p:number[],i:number)=>distance(p.slice(0,3).map(x=>x/p[3]),other[i].slice(0,3).map((x:number)=>x/other[i][3]))));
    if(!match||bound<match.bound)match={reverse,bound};
  }
  check(match&&match.bound<=1e-10&&match.bound<=edge.tolerance+1e-10,'source-isocurve-control-mismatch');
  for(const id of boundary.vertices){const uv=part.audit.uv[id];
    check(uv?.length===2&&Math.abs(uv[fixed]-a[fixed])<=1e-11&&uv[variable]>=s.domain[variable][0]&&uv[variable]<=s.domain[variable][1]
      &&distance(part.mesh.positions[id],evaluateSurface(s,uv))<=1e-10,'source-isocurve-mesh-mismatch');}
  const toParameter=(uv:number[])=>{const d=s.domain[variable],f=(uv[variable]-d[0])/(d[1]-d[0]);return match.reverse?1-f:f;};
  const toUv=(t:number)=>{const uv=[...a],d=s.domain[variable];uv[variable]=d[0]+(match.reverse?1-t:t)*(d[1]-d[0]);return uv;};
  return {boundary,surface:s,variable,toParameter,toUv,continuousBound:match.bound};
}
