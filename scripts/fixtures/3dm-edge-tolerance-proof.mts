import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { trimPolyline } from './3dm-trim-polyline.mts';
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
const segmentDistance=(p:number[],a:number[],b:number[])=>{
  const d=b.map((x,i)=>x-a[i]),l=d.reduce((s,x)=>s+x*x,0),t=l?Math.max(0,Math.min(1,d.reduce((s,x,i)=>s+x*(p[i]-a[i]),0)/l)):0;
  return distance(p,a.map((x,i)=>x+t*d[i]));
};
/** Positive-weight convex hull certificates, in source units; no sample maximum masquerades as a bound. */
export function proveTrimEdgeTolerance(ir:any,trimIndex:number,surface:any,edge:any,curve:any,project:(p:number[])=>{parameter:number,point:number[]}){
  const trim=ir.trims[trimIndex],original=ir.curves2d[trim.curve2d];
  const world={...original,dimension:3,controlPoints:original.controlPoints.map((p:number[])=>{
    const w=original.rational?p[2]:1,point=evaluateSurface(surface,[p[0]/w,p[1]/w]).map((x:number)=>x*w);return original.rational?[...point,w]:point;
  })};
  // Equal normalized rational Bézier nets certify the exact-geometry case, including reversed proxies.
  if(world.parameterMap?.kind==='identity'&&world.degree===2&&world.controlPoints.length===3&&world.rational&&world.knots[2]===trim.sourceSubdomain[0]&&world.knots[3]===trim.sourceSubdomain[1]
    &&curve.knots[2]===edge.sourceSubdomain[0]&&curve.knots[3]===edge.sourceSubdomain[1]){
    for(const reverse of [false,true]){
      const other=reverse?[...curve.controlPoints].reverse():curve.controlPoints;
      if(world.controlPoints.every((p:number[],i:number)=>p[3]>0&&p[3]===other[i][3])){
        const bound=Math.max(...world.controlPoints.map((p:number[],i:number)=>distance(p.slice(0,3).map(x=>x/p[3]),other[i].slice(0,3).map((x:number)=>x/other[i][3]))));
        if(bound<=edge.tolerance+1e-10)return {kind:'matching-rational-bezier-hulls',continuousBound:bound,maxSampleResidual:bound};
      }
    }
  }
  if(!(edge.tolerance>0))throw new Error('zero-edge-tolerance-not-provable');
  const line=trimPolyline(world,trim.sourceSubdomain,Boolean(trim.curveReversed),edge.tolerance/16);
  const projected=line.points.map(project),direction=Math.sign(projected.at(-1)!.parameter-projected[0].parameter);
  if(!direction||projected.some((p,i)=>i>0&&direction*(p.parameter-projected[i-1].parameter)<=0))throw new Error('non-monotonic-tolerance-proof');
  const maxSampleResidual=Math.max(...line.points.map((p,i)=>distance(p,projected[i].point)));let edgeChordBound=0;
  for(let i=1;i<projected.length;i++){
    const a=projected[i-1],b=projected[i],edgeLine=trimPolyline(curve,[a.parameter,b.parameter].sort((x,y)=>x-y),false,edge.tolerance/16);
    edgeChordBound=Math.max(edgeChordBound,edgeLine.maxBound+Math.max(...edgeLine.points.map(p=>segmentDistance(p,a.point,b.point))));
  }
  const continuousBound=line.maxBound+maxSampleResidual+edgeChordBound;
  if(continuousBound>edge.tolerance)throw new Error('continuous-source-edge-tolerance-exceeded',{cause:{continuousBound,declaredEdgeTolerance:edge.tolerance}});
  return {kind:'paired-positive-weight-polyline-hulls',continuousBound,maxSampleResidual,trimChordBound:line.maxBound,edgeChordBound,samples:line.points.length};
}
