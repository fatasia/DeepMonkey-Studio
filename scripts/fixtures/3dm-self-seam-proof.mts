import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
/** Two authored seam trims on opposite closed-axis boundaries; constant-weight linear sides prove the full C3. */
export function proveLinearSelfSeam(ir:any,edgeIndex:number,trims:number[]) {
  const edge=ir.edges[edgeIndex],curve=ir.curves3d[edge.curve3d],face=ir.loops[ir.trims[trims[0]].loop].face,s=ir.surfaces[ir.faces[face].surface];
  check(trims.length===2&&trims[0]!==trims[1]&&trims.every(i=>ir.trims[i].edge===edgeIndex&&ir.trims[i].type===3&&ir.loops[ir.trims[i].loop].face===face),
    'invalid-self-seam-identity');
  check(s.parameterMap?.kind==='identity'&&curve?.dimension===3&&curve.degree===1&&!curve.rational&&curve.controlPoints.length===2
    &&curve.parameterMap?.kind==='identity'&&curve.knots.length===4&&curve.knots.every((x:number,i:number)=>x===edge.sourceSubdomain[i<2?0:1]),'unsupported-self-seam-source');
  const sides=trims.map(trimIndex=>{
    const trim=ir.trims[trimIndex],c=ir.curves2d[trim.curve2d];
    check(c?.degree===1&&!c.rational&&c.controlPoints.length===2&&c.parameterMap?.kind==='identity'
      &&c.knots.length===4&&c.knots.every((x:number,i:number)=>x===trim.sourceSubdomain[i<2?0:1]),'unsupported-self-seam-trim');
    const [a,b]=c.controlPoints,axis=[0,1].find(i=>a[i]===b[i]&&s.closed?.[i]&&s.domain[i].includes(a[i]));
    check(axis!==undefined,'self-seam-not-opposite-periodic-boundary');const linear=1-axis;
    check(s.knots[axis].slice(0,s.degree[axis]+1).every((x:number)=>x===s.domain[axis][0])
      &&s.knots[axis].slice(-s.degree[axis]-1).every((x:number)=>x===s.domain[axis][1]),'unclamped-self-seam-boundary');
    check(s.degree[linear]===1&&s.controlPointCount[linear]===2&&s.knots[linear].length===4
      &&s.knots[linear].every((x:number,i:number)=>x===s.domain[linear][i<2?0:1])&&[a,b].every(p=>p[linear]>=s.domain[linear][0]&&p[linear]<=s.domain[linear][1]),'nonlinear-self-seam');
    const row=a[axis]===s.domain[axis][0]?0:s.controlPointCount[axis]-1;
    const control=[0,1].map(i=>s.controlPoints[axis===0?i*s.controlPointCount[0]+row:row*s.controlPointCount[0]+i]);
    check(control.every(p=>p.every(Number.isFinite))&&(!s.rational||control[0][3]>0&&control[0][3]===control[1][3]),'nonaffine-self-seam-weights');
    const reverse=Boolean(trim.reverse3d)!==Boolean(edge.curveReversed)!==Boolean(trim.curveReversed);
    const expected=reverse?[...curve.controlPoints].reverse():curve.controlPoints;
    const endpointBound=Math.max(...[a,b].map((uv,i)=>distance(evaluateSurface(s,uv),expected[i])));
    check(Number.isFinite(edge.tolerance)&&edge.tolerance>=0&&endpointBound<=Math.min(1e-10,edge.tolerance+1e-12),'self-seam-source-mismatch');
    return {trim:trimIndex,axis,side:a[axis]===s.domain[axis][0]?0:1,endpointBound};
  });
  check(sides[0].axis===sides[1].axis&&sides[0].side!==sides[1].side,'self-seam-not-opposite-periodic-boundary');
  return {kind:'constant-weight-affine-self-seam',face,closedAxis:sides[0].axis,continuousBound:Math.max(...sides.map(s=>s.endpointBound)),sides};
}
