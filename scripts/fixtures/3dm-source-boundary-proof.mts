import {evaluateCurve,evaluateSurface} from './3dm-nurbs-parameters.mjs';
import {provePlaneTrimIdentity} from './3dm-source-curve-identity.mts';
import {proveSourceIsocurve} from './3dm-source-isocurve.mts';
import {provePlaneC3Map} from './3dm-plane-c3-map.mts';
export function proveSourceBoundary(ir:any,part:any,edge:number){
  if(part.geometrySource!=='cad-ir-affine-plane-trim'){
    const p=proveSourceIsocurve(ir,part,edge);return {...p,toBoundaryParameter:(i:number)=>p.toParameter(part.audit.uv[p.boundary.vertices[i]]),sourceParameter:(t:number)=>t};
  }
  const reconstructed=part.audit.sourceC3Reconstructions?.find((r:any)=>r.edge===edge);
  if(reconstructed){
    const p=provePlaneC3Map(ir,part.face,edge,reconstructed.metersPerUnit),boundary=part.boundaryEdges.find((b:any)=>b.trim===p.trim),d=ir.edges[edge].sourceSubdomain;
    if(!boundary?.parameters||boundary.parameters.length!==boundary.vertices.length)throw Error('missing-reconstructed-source-parameters');
    for(let i=0;i<boundary.vertices.length;i++){const id=boundary.vertices[i],point=evaluateSurface(p.surface,p.toUv(boundary.parameters[i]));
      if(Math.hypot(...point.map((x:number,j:number)=>x-part.mesh.positions[id][j]))>1e-10)throw Error('reconstructed-source-mesh-mismatch');}
    return {...p,curve:p.projectedCurve,boundary,continuousBound:p.planeBound,toUv:(t:number)=>p.toUv(d[0]+t*(d[1]-d[0])),sourceParameter:(t:number)=>d[0]+t*(d[1]-d[0]),
      toBoundaryParameter:(i:number)=>(boundary.parameters[i]-d[0])/(d[1]-d[0])};
  }
  const p=provePlaneTrimIdentity(ir,part.face,edge),boundary=part.boundaryEdges.find((b:any)=>b.trim===p.trim),d=ir.trims[p.trim].sourceSubdomain;
  if(!boundary?.parameters||boundary.parameters.length!==boundary.vertices.length||!part.parameterUv)throw Error('missing-plane-source-parameters');
  const sourceParameter=(t:number)=>d[0]+(p.reverse?1-t:t)*(d[1]-d[0]);
  for(let k=0;k<boundary.vertices.length;k++){
    const actual=part.mesh.positions[boundary.vertices[k]],uv=evaluateCurve(p.curve,boundary.parameters[k]).slice(0,2),expected=evaluateSurface(p.surface,uv);
    if(Math.hypot(...actual.map((x:number,i:number)=>x-expected[i]))>1e-10)throw Error('source-plane-mesh-mismatch');
  }
  return {...p,boundary,toUv:(t:number)=>evaluateCurve(p.curve,sourceParameter(t)).slice(0,2),sourceParameter,
    toBoundaryParameter:(i:number)=>{const t=(boundary.parameters[i]-d[0])/(d[1]-d[0]);return p.reverse?1-t:t;}};
}
