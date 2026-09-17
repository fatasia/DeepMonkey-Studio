import {trimPolyline} from './3dm-trim-polyline.mts';
import {evaluateSurface} from './3dm-nurbs-parameters.mjs';
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
/** An immutable mesh vertex can disprove C3 identity, but cannot establish a source-budget conflict. */
export function auditPreservedSourceVertices(ir:any,parts:any[],edgeIndex:number,metersPerUnit:number){
  const edge=ir.edges[edgeIndex],curve=ir.curves3d[edge?.curve3d];
  if(!(metersPerUnit>0&&Number.isFinite(metersPerUnit)&&edge?.tolerance>0))throw Error('unsupported-preserved-source-budget');
  const limit=Math.min(edge.tolerance,.00001/metersPerUnit),line=trimPolyline(curve,edge.sourceSubdomain,false,limit/1024),roundoffAllowance=1e-10;
  const uses=parts.flatMap(part=>part.boundaryEdges.filter((b:any)=>b.edge===edgeIndex).map((boundary:any)=>{
    const surface=ir.surfaces[ir.faces[part.face].surface],uv=part.audit?.uv??part.parameterUv;let witness:any;
    if(surface.parameterMap?.kind!=='identity'||!uv)throw Error('unsupported-preserved-source-map');
    for(const vertex of boundary.vertices){const point=part.mesh.positions[vertex];
      if(distance(point,evaluateSurface(surface,uv[vertex]))>roundoffAllowance)throw Error('preserved-vertex-not-on-source');
      let polylineDistance=Infinity;
      for(let j=1;j<line.points.length;j++){const a=line.points[j-1],b=line.points[j],d=b.map((x:number,i:number)=>x-a[i]),l=d.reduce((v:number,x:number)=>v+x*x,0);
        const t=l?Math.max(0,Math.min(1,d.reduce((v:number,x:number,i:number)=>v+x*(point[i]-a[i]),0)/l)):0;
        polylineDistance=Math.min(polylineDistance,distance(point,a.map((x:number,i:number)=>x+t*d[i])));}
      const lowerBound=Math.max(0,polylineDistance-line.maxBound-roundoffAllowance);
      if(!witness||lowerBound>witness.lowerBound)witness={vertex,point:[...point],uv:[...uv[vertex]],polylineDistance,lowerBound};
    }
    if(!witness)throw Error('empty-preserved-source-boundary');
    return {face:part.face,trim:boundary.trim,witness,disprovesCanonicalIdentity:witness.lowerBound>Math.min(1e-10,edge.tolerance+1e-12),
      disprovesExactCanonicalMesh:witness.lowerBound>1e-8};
  }));
  if(uses.length!==2)throw Error('unsupported-preserved-source-topology');
  return {edge:edgeIndex,declaredTolerance:edge.tolerance,physicalBudget:.00001/metersPerUnit,
    proof:{kind:'preserved-vertex-to-entire-c3-lower-bound',chordBound:line.maxBound,curveVertices:line.points.length,roundoffAllowance},uses,
    status:uses.some((u:any)=>u.disprovesExactCanonicalMesh)?'requires-boundary-reconstruction':'no-preserved-vertex-obstruction-found'};
}
