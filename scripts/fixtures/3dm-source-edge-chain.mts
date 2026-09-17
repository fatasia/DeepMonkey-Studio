import { evaluateCurve,evaluateSurface,mapSurfaceParameter } from './3dm-nurbs-parameters.mjs';
import { trimPolyline } from './3dm-trim-polyline.mts';
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
function segmentDistance(p:number[],a:number[],b:number[]) {
  const d=b.map((x,i)=>x-a[i]),length=d.reduce((s,x)=>s+x*x,0);
  const t=length?Math.max(0,Math.min(1,d.reduce((s,x,i)=>s+x*(p[i]-a[i]),0)/length)):0;
  return distance(p,a.map((x,i)=>x+t*d[i]));
}
/** One C3 parameter chain per source edge. Trim references carry direction, not independent 3D samples. */
export function sourceEdgeChain(ir:any,edgeIndex:number,metersPerUnit:number) {
  check(Number.isFinite(metersPerUnit)&&metersPerUnit>0,'invalid-source-chain-unit');
  const edge=ir.edges[edgeIndex],curve=ir.curves3d[edge?.curve3d],budget=.00001/metersPerUnit;
  check(edge&&Number.isFinite(edge.tolerance)&&edge.tolerance>=0,'missing-source-edge-tolerance');
  const uses=ir.trims.flatMap((t:any,trim:number)=>t.edge===edgeIndex?[{trim,face:ir.loops[t.loop].face,
    direction:(Boolean(t.reverse3d)!==Boolean(edge.curveReversed)?-1:1)}]:[]);
  check(uses.length===2&&uses[0].face!==uses[1].face,'unsupported-source-chain-topology');
  const line=trimPolyline(curve,edge.sourceSubdomain,false,budget/8);
  return {edge:edgeIndex,sourceVertexIds:[...edge.vertices],parameters:line.parameters,points:line.points,chordBound:line.maxBound,uses,
    declaredTolerance:edge.tolerance,physicalBudget:budget,metersPerUnit};
}
/** A witness is a lower bound to the entire C3 curve, not a nearest-point optimizer's local residual. */
export function auditSourceEdgeChain(ir:any,edgeIndex:number,metersPerUnit:number,samples=257) {
  check(Number.isInteger(samples)&&samples>=2&&samples<=2049,'invalid-source-chain-samples');
  const chain=sourceEdgeChain(ir,edgeIndex,metersPerUnit),edge=ir.edges[edgeIndex],curve=ir.curves3d[edge.curve3d];
  const limit=Math.min(chain.declaredTolerance,chain.physicalBudget);
  check(limit>0,'zero-source-edge-tolerance-needs-identity-proof');
  let proofLine;
  try{proofLine=trimPolyline(curve,edge.sourceSubdomain,false,limit/1024);}
  catch(error){if(!(error instanceof Error)||error.message!=='trim-vertex-budget')throw error;
    proofLine=trimPolyline(curve,edge.sourceSubdomain,false,limit/128);}
  const roundoffAllowance=1e-10;
  const uses=chain.uses.map((use:any)=>{
    const trim=ir.trims[use.trim],c2=ir.curves2d[trim.curve2d],surface=ir.surfaces[ir.faces[use.face].surface];
    check(c2?.parameterMap?.kind==='identity','unsupported-source-trim-parameter-map');
    let witness:any;
    for(let i=0;i<samples;i++) {
      const t=i===samples-1?trim.sourceSubdomain[1]:trim.sourceSubdomain[0]+i/(samples-1)*(trim.sourceSubdomain[1]-trim.sourceSubdomain[0]);
      const uv=evaluateCurve(c2,t).slice(0,2).map((x:number,axis:number)=>{
        const d=surface.domain[axis];check(x>=d[0]-1e-10&&x<=d[1]+1e-10,'source-trim-outside-domain');return Math.max(d[0],Math.min(d[1],x));
      });
      const point=evaluateSurface(surface,mapSurfaceParameter(surface,uv));
      let polylineDistance=Infinity;
      for(let j=1;j<proofLine.points.length;j++)polylineDistance=Math.min(polylineDistance,segmentDistance(point,proofLine.points[j-1],proofLine.points[j]));
      const lowerBound=Math.max(0,polylineDistance-proofLine.maxBound-roundoffAllowance);
      if(!witness||lowerBound>witness.lowerBound)witness={trimParameter:t,uv,point,polylineDistance,lowerBound};
    }
    return {...use,witness,exceedsDeclaredTolerance:witness.lowerBound>chain.declaredTolerance,
      exceedsPhysicalBudget:witness.lowerBound>chain.physicalBudget};
  });
  return {...chain,proof:{kind:'positive-weight-c3-hull-distance-lower-bound',chordBound:proofLine.maxBound,
    curveVertices:proofLine.points.length,roundoffAllowance,samplesPerTrim:samples},uses,
    status:uses.some((u:any)=>u.exceedsDeclaredTolerance||u.exceedsPhysicalBudget)?'source-budget-conflict':'not-certified-for-repair'};
}
