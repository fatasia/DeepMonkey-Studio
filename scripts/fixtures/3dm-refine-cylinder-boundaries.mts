import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { tessellateCylinderFace } from './3dm-cylinder-tessellation.mts';
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
/** Refine, never snap: adjacent planar boundary vertices must lie on the original cylinder. */
export function refineCylinderBoundaries(ir:any,parts:any[]){
  const records:any[]=[],failures:any[]=[],byEdge=new Map<number,any[]>();
  for(const part of parts)for(const boundary of part.boundaryEdges??[]){
    if(!Number.isInteger(boundary.edge)||boundary.edge<0)continue;
    const uses=byEdge.get(boundary.edge)??[];uses.push({part,boundary});byEdge.set(boundary.edge,uses);
  }
  return {parts:parts.map(part=>{
    if(part.geometrySource!=='cad-ir-natural-cylinder')return part;
    try {
    const parameters:number[]=[],surface=ir.surfaces[ir.faces[part.face].surface],a=part.audit,n=a.parameters.length;
    let residual=0,evaluations=0;
    for(const boundary of part.boundaryEdges){
      const uses=byEdge.get(boundary.edge)??[];
      if(uses.length!==2)continue;
      const other=uses.find(use=>use.part!==part);if(other?.part.geometrySource!=='cad-ir-affine-plane-trim')continue;
      const rows=boundary.vertices.map((i:number)=>Math.floor(i/n));if(!rows.every((row:number)=>row===rows[0]))continue;
      const row=rows[0],at=(t:number)=>evaluateSurface(surface,a.domain.map((d:number[],axis:number)=>axis===a.curvedAxis?t:d[row]));
      const ends=[...a.parameters];if(a.closedSeam)ends.push(a.domain[a.curvedAxis][1]);
      for(const index of other.boundary.vertices){
        const target=other.part.mesh.positions[index];let best=Infinity,parameter=ends[0];
        for(let i=1;i<ends.length;i++){
          let lo=ends[i-1],hi=ends[i];
          for(let iteration=0;iteration<60;iteration++){
            if((evaluations+=2)>1000000)throw new Error('cylinder-boundary-refinement-budget');
            const left=lo+(hi-lo)/3,right=hi-(hi-lo)/3;
            if(distance(at(left),target)<distance(at(right),target))hi=right;else lo=left;
          }
          for(const t of [ends[i-1],(lo+hi)/2,ends[i]]){const error=distance(at(t),target);if(error<best){best=error;parameter=t;}}
        }
        if(best>1e-8)throw new Error('adjacent-boundary-not-on-source-cylinder',{cause:{face:part.face,edge:boundary.edge,residual:best}});
        residual=Math.max(residual,best);
        const existing=ends.find(t=>Math.abs(t-parameter)<1e-9&&distance(at(t),target)<=1e-8);
        if(existing!==undefined)residual=Math.max(residual,distance(at(existing),target));parameters.push(existing??parameter);
      }
    }
    if(!parameters.length)return part;
    const refined=tessellateCylinderFace(ir,part.face,a.chordTolerance,parameters);
    records.push({face:part.face,parametersBefore:n,parametersAfter:refined.audit.parameters.length,maxSourceProjectionResidual:residual});return refined;
    }catch(error){failures.push({face:part.face,code:error instanceof Error?error.message:'boundary-refinement-failed',detail:error instanceof Error?error.cause:undefined});return part;}
  }),records,failures};
}
