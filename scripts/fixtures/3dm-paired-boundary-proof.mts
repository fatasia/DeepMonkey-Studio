import {evaluateCurve} from './3dm-nurbs-parameters.mjs';
import {sourceBezierInterval,sourceBezierChainInterval} from './3dm-source-bezier-interval.mts';
import {sourceCurveControlBound} from './3dm-plane-c3-map.mts';
import {provePlaneTrimIdentity} from './3dm-source-curve-identity.mts';
import {rationalBezierBounds} from './3dm-rational-bezier-bounds.mts';
import {proveSourceIsocurve} from './3dm-source-isocurve.mts';

function check(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
export type BoundaryMapSegment={source:number[];target:number[];bound:number};

/** 拟合只提出参数区间；每一区间必须由正权齐次控制凸包证明。 */
export function proveBezierCurveMap(source:any,target:any,limit:number,maxSegments=1024){
  check(Number.isFinite(limit)&&limit>0&&Number.isInteger(maxSegments)&&maxSegments>0&&maxSegments<=4096,'invalid-paired-map-budget');
  const homogeneous=(c:any)=>({...c,rational:true,controlPoints:c.controlPoints.map((p:number[])=>c.rational?[...p]:[...p,1])});
  const left=homogeneous(source),right=homogeneous(target);
  const a=[...new Set<number>(left.knots)],forward=[...new Set<number>(right.knots)];
  check(a.length>=forward.length&&forward.length>=2&&a.length<=65,'unsupported-paired-map-spans');
  // 区间提取器同时校验正权、次数、C0重数、端点夹持与有限值。
  sourceBezierChainInterval(left,[a[0],a.at(-1)!]);
  sourceBezierChainInterval(right,[forward[0],forward.at(-1)!]);
  const alternatives=[forward,[...forward].reverse()].flatMap(original=>{
    if(a.length===original.length)return [{b:original,error:Math.max(...a.map((t,i)=>distance(evaluateCurve(left,t),evaluateCurve(right,original[i]))))}];
    // Only split target spans after all authored target knots match source knots.
    // Nearest-point search proposes missing anchors; exact endpoint and continuous
    // interval proofs below remain mandatory, including for the split spans.
    const anchors=original.map(t=>({t,i:a.reduce((best,x,i)=>distance(evaluateCurve(left,x),evaluateCurve(right,t))<distance(evaluateCurve(left,a[best]),evaluateCurve(right,t))?i:best,0)}));
    if(anchors[0].i!==0||anchors.at(-1)!.i!==a.length-1||anchors.some((p,i)=>i>0&&p.i<=anchors[i-1].i)
      ||anchors.some(p=>distance(evaluateCurve(left,a[p.i]),evaluateCurve(right,p.t))>1e-10))return [];
    const b=a.map((t,i)=>{
      const exact=anchors.find(p=>p.i===i);if(exact)return exact.t;
      const k=anchors.findIndex(p=>p.i>i),x=anchors[k-1].t,y=anchors[k].t,point=evaluateCurve(left,t);let lo=0,hi=1;
      for(let n=0;n<70;n++){const f=lo+(hi-lo)/3,g=hi-(hi-lo)/3;if(distance(point,evaluateCurve(right,x+f*(y-x)))<distance(point,evaluateCurve(right,x+g*(y-x))))hi=g;else lo=f;}
      return x+(lo+hi)/2*(y-x);
    });
    const direction=Math.sign(original.at(-1)!-original[0]);
    if(b.some((t,i)=>i>0&&direction*(t-b[i-1])<=1e-14))return [];
    return [{b,error:Math.max(...a.map((t,i)=>distance(evaluateCurve(left,t),evaluateCurve(right,b[i]))))}];
  });
  check(alternatives.length,'paired-map-knot-endpoint-mismatch');
  alternatives.sort((x,y)=>x.error-y.error);
  const {b,error}=alternatives[0];check(error<=1e-10,'paired-map-knot-endpoint-mismatch');
  const segments:BoundaryMapSegment[]=[];
  const visit=(lo:number,hi:number,x:number,y:number,depth:number)=>{
    const controlA=sourceBezierInterval(left,[lo,hi]).controlPoints;
    const controlB=sourceBezierInterval(right,[Math.min(x,y),Math.max(x,y)]).controlPoints;
    if(x>y)controlB.reverse();
    const bound=sourceCurveControlBound(controlA,controlB)+1e-10;
    if(bound<=limit){check(segments.length<maxSegments,'paired-map-segment-budget');segments.push({source:[lo,hi],target:[x,y],bound});return;}
    check(depth<18&&segments.length<maxSegments,'paired-map-subdivision-budget');
    const middle=(lo+hi)/2,point=evaluateCurve(left,middle);let low=0,high=1;
    for(let i=0;i<60;i++){
      const f=low+(high-low)/3,g=high-(high-low)/3;
      if(distance(point,evaluateCurve(right,x+f*(y-x)))<distance(point,evaluateCurve(right,x+g*(y-x))))high=g;else low=f;
    }
    const m=x+(low+high)/2*(y-x);
    check(Math.abs(m-x)>1e-14&&Math.abs(y-m)>1e-14,'nonmonotonic-paired-map');
    // 一个内部点超预算即拒绝；不会把优化器找到的点当作曲线最近距离证明。
    check(distance(point,evaluateCurve(right,m))<=limit,'paired-map-proposal-exceeds-budget');
    visit(lo,middle,x,m,depth+1);visit(middle,hi,m,y,depth+1);
  };
  for(let i=1;i<a.length;i++)visit(a[i-1],a[i],b[i-1],b[i],0);
  return {segments,continuousBound:Math.max(...segments.map(s=>s.bound)),reverse:b[0]>b.at(-1)!};
}

/** 精确平面/曲面C3与二次×一次曲面等参trim的双侧连续距离证书；不是焊接。 */
export function provePairedBoundary(ir:any,edgeIndex:number,metersPerUnit:number){
  check(Number.isFinite(metersPerUnit)&&metersPerUnit>0,'invalid-paired-boundary-unit');
  const edge=ir.edges?.[edgeIndex],c3=ir.curves3d?.[edge?.curve3d];
  check(edge?.tolerance>0&&Number.isFinite(edge.tolerance)&&c3?.parameterMap?.kind==='identity','unsupported-paired-boundary-edge');
  const uses=ir.trims.flatMap((trim:any,index:number)=>trim.edge===edgeIndex?[{trim,index,face:ir.loops[trim.loop].face}]:[]);
  check(uses.length===2&&uses[0].face!==uses[1].face,'paired-boundary-not-two-faces');
  const plane=uses.find((use:any)=>ir.surfaces[ir.faces[use.face].surface].degree.every((d:number)=>d===1));
  const anchor=plane??uses.find((use:any)=>{const s=ir.surfaces[ir.faces[use.face].surface];return s.rational&&s.degree[0]===3&&s.degree[1]===2;});
  check(anchor,'paired-boundary-missing-plane');
  const planeProof=plane?provePlaneTrimIdentity(ir,plane.face,edgeIndex):proveSourceIsocurve(ir,{face:anchor.face,geometrySource:'cad-ir-rational-bezier-chain',boundaryEdges:[{edge:edgeIndex,trim:anchor.index,vertices:[]}],audit:{uv:[]}},edgeIndex);
  const curved=uses.find((u:any)=>u!==anchor)!;
  const surface=ir.surfaces[ir.faces[curved.face].surface],c2=ir.curves2d[curved.trim.curve2d];
  check(surface.parameterMap?.kind==='identity'&&surface.rational&&surface.degree[0]===2&&surface.degree[1]===1&&surface.controlPointCount[1]===2
    &&c2?.parameterMap?.kind==='identity'&&!c2.rational&&c2.degree===1&&c2.controlPoints.length>=2,'unsupported-paired-boundary-isocurve');
  const surfaceBounds=rationalBezierBounds(surface);
  const points=c2.controlPoints,level=points[0][1],drift=Math.max(...points.map((p:number[])=>Math.abs(p[1]-level)));
  check(c2.knots.length===points.length+2&&c2.knots.every((x:number,i:number)=>Number.isFinite(x)&&(!i||x>=c2.knots[i-1]))
    &&c2.knots[0]===c2.knots[1]&&c2.knots.at(-1)===c2.knots.at(-2)
    &&c2.knots.slice(2,-1).every((x:number,i:number)=>x>c2.knots[i+1]),'invalid-paired-boundary-trim-knots');
  check(points.every((p:number[])=>p.length===2&&p.every(Number.isFinite)&&p.every((x,i)=>x>=surface.domain[i][0]&&x<=surface.domain[i][1]))
    &&drift<=1e-10,'paired-boundary-not-isocurve');
  const direction=Math.sign(points.at(-1)![0]-points[0][0]);
  check(direction!==0&&points.every((p:number[],i:number)=>!i||direction*(p[0]-points[i-1][0])>0),'paired-boundary-nonmonotonic-trim');
  check(c2.knots[1]===curved.trim.sourceSubdomain[0]&&c2.knots[points.length]===curved.trim.sourceSubdomain[1],'paired-boundary-partial-trim');
  const t=(level-surface.domain[1][0])/(surface.domain[1][1]-surface.domain[1][0]),count=surface.controlPointCount[0];
  const iso={dimension:3,degree:2,rational:true,parameterMap:{kind:'identity'},knots:surface.knots[0],
    controlPoints:Array.from({length:count},(_,i)=>surface.controlPoints[i].map((x:number,j:number)=>(1-t)*x+t*surface.controlPoints[count+i][j]))};
  const interval=[Math.min(points[0][0],points.at(-1)![0]),Math.max(points[0][0],points.at(-1)![0])];
  const restricted={...iso,...sourceBezierChainInterval(iso,interval)};
  const driftBound=surfaceBounds.first[1]*drift;
  const physicalBudgetSource=.01/(metersPerUnit*1000),limit=Math.min(edge.tolerance,physicalBudgetSource)*(plane ? .05 : .2);
  const map=proveBezierCurveMap(c3,restricted,limit-planeProof.continuousBound-driftBound);
  const continuousBound=map.continuousBound+planeProof.continuousBound+driftBound;
  check(continuousBound<=edge.tolerance&&continuousBound<=physicalBudgetSource,'paired-boundary-total-budget');
  return {edge:edgeIndex,faces:[anchor.face,curved.face],trims:[anchor.index,curved.index],metersPerUnit,declaredTolerance:edge.tolerance,
    physicalBudgetMm:.01,sourceBound:continuousBound,physicalBoundMm:continuousBound*metersPerUnit*1000,
    planeIdentityBound:planeProof.continuousBound,curvedTrimDriftBound:driftBound,
    mapping:map,status:'continuous-source-pair-certified-mesh-not-welded',restrictedCurve:restricted};
}
