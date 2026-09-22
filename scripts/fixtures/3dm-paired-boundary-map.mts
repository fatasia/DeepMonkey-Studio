import {evaluateCurve,evaluateSurface} from './3dm-nurbs-parameters.mjs';
import {provePairedBoundary} from './3dm-paired-boundary-proof.mts';
function check(value:unknown,message:string):asserts value{if(!value)throw Error(message);}

export function pairedCurveParameter(proof:any,value:number,inverse=false){
  check(Number.isFinite(value),'invalid-paired-parameter');
  const from=inverse?'target':'source',to=inverse?'source':'target';
  const segment=proof.mapping.segments.find((s:any)=>value>=Math.min(...s[from])-1e-12&&value<=Math.max(...s[from])+1e-12);
  check(segment,'paired-parameter-outside');
  const fraction=Math.max(0,Math.min(1,(value-segment[from][0])/(segment[from][1]-segment[from][0])));
  return segment[to][0]+fraction*(segment[to][1]-segment[to][0]);
}

/** 重建边保留源曲面UV用于法向和内部网格；位置来自已获双侧误差证书的C3。 */
export function proveReconstructedPairedBoundary(ir:any,part:any,edgeIndex:number){
  const record=part.audit.sourcePairReconstructions.find((r:any)=>r.edge===edgeIndex);
  const proof=provePairedBoundary(ir,edgeIndex,record.metersPerUnit);
  check(proof.faces[1]===part.face,'paired-reconstruction-face-mismatch');
  const surface=ir.surfaces[ir.faces[part.face].surface],curve=ir.curves3d[ir.edges[edgeIndex].curve3d];
  const domain=ir.edges[edgeIndex].sourceSubdomain,boundary=part.boundaryEdges.find((b:any)=>b.edge===edgeIndex);
  const level=ir.curves2d[ir.trims[proof.trims[1]].curve2d].controlPoints[0][1];
  check(boundary?.parameters?.length===boundary.vertices.length,'missing-paired-boundary-parameters');
  const sourceParameter=(t:number)=>domain[0]+t*(domain[1]-domain[0]);
  const toUv=(t:number)=>[pairedCurveParameter(proof,sourceParameter(t)),level];
  const positionAt=(t:number)=>evaluateCurve(curve,sourceParameter(t));
  for(let i=0;i<boundary.vertices.length;i++){
    const id=boundary.vertices[i],t=(boundary.parameters[i]-domain[0])/(domain[1]-domain[0]);
    check(Number.isFinite(t)&&t>=-1e-12&&t<=1+1e-12,'invalid-paired-boundary-parameter');
    const point=positionAt(t),uv=toUv(t),support=evaluateSurface(surface,uv);
    check(Math.hypot(...point.map((x:number,j:number)=>x-part.mesh.positions[id][j]))<=1e-10
      &&Math.hypot(...uv.map((x:number,j:number)=>x-part.audit.uv[id][j]))<=1e-10
      &&Math.hypot(...point.map((x:number,j:number)=>x-support[j]))<=proof.sourceBound+1e-10,'paired-reconstruction-mesh-mismatch');
  }
  return {boundary,surface,toUv,positionAt,sourceParameter,continuousBound:proof.sourceBound,
    toBoundaryParameter:(i:number)=>(boundary.parameters[i]-domain[0])/(domain[1]-domain[0])};
}
