import { evaluateCurve } from './3dm-nurbs-parameters.mjs';
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
function check(value:unknown,message:string):asserts value { if(!value) throw new Error(message); }
/** Require exactly one complete, axis-aligned rectangular trim in original parameter space. */
export function requireNaturalBoundary(ir:any,face:any,surface:any,allowSubdomain=false) {
  check(face.loops.length===1,'unsupported-natural-trim');
  const loop=ir.loops[face.loops[0]]; check(loop?.type===1&&loop.trims.length===4,'unsupported-natural-trim');
  const ring:number[][]=[];
  for(const ti of loop.trims) {
    const trim=ir.trims[ti],curve=ir.curves2d[trim?.curve2d];
    check(curve?.degree===1&&curve.controlPoints.length===2&&!curve.rational&&curve.parameterMap?.kind==='identity','unsupported-natural-trim');
    const ends=trim.sourceSubdomain.map((t:number)=>evaluateCurve(curve,t)); if(trim.curveReversed) ends.reverse();
    check(ends.every((p:number[])=>p.every((value,axis)=>Number.isFinite(value)&&value>=surface.domain[axis][0]-1e-9&&value<=surface.domain[axis][1]+1e-9)),'trim-outside-surface-domain');
    check(distance(ends[0],ends[1])>1e-9&&(Math.abs(ends[0][0]-ends[1][0])<1e-9||Math.abs(ends[0][1]-ends[1][1])<1e-9),'non-isoparametric-trim');
    if(ring.length) check(distance(ring.at(-1)!,ends[0])<1e-9,'open-natural-trim');
    ring.push(...ends);
  }
  const domain=allowSubdomain?[0,1].map(axis=>[Math.min(...ring.map(p=>p[axis])),Math.max(...ring.map(p=>p[axis]))]):surface.domain;
  const corners=domain[0].flatMap((u:number)=>domain[1].map((v:number)=>[u,v]));
  check(ring.every(p=>corners.some((q:number[])=>distance(p,q)<1e-9)),'unsupported-natural-trim');
  check(distance(ring[0],ring.at(-1)!)<1e-9,'open-natural-trim');
  check(corners.every((q:number[])=>ring.some(p=>distance(p,q)<1e-9)),'incomplete-natural-domain');
  return domain;
}
