import { sourceEdgeChain } from './3dm-source-edge-chain.mts';
import { proveSourceIsocurve } from './3dm-source-isocurve.mts';
import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { rationalBezierBounds } from './3dm-rational-bezier-bounds.mts';
import { auditBrepBoundaries } from './3dm-brep-boundary-audit.mts';
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a:number[],b:number[])=>a.reduce((sum,x,i)=>sum+x*b[i],0);
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
function splitBoundary(ir:any,part:any,edge:number,parameters:number[],metersPerUnit:number) {
  const proof=proveSourceIsocurve(ir,part,edge),boundary=proof.boundary,old=[...boundary.vertices],mesh=part.mesh,uv=part.audit.uv;
  const bounds=rationalBezierBounds(proof.surface),newBoundary:number[]=[];let inserted=0;
  for(let j=1;j<old.length;j++){
    const a=old[j-1],b=old[j],lo=proof.toParameter(uv[a]),hi=proof.toParameter(uv[b]),direction=Math.sign(hi-lo);
    check(direction!==0,'non-monotonic-isocurve-boundary');
    const additions=parameters.filter(t=>t>Math.min(lo,hi)+1e-12&&t<Math.max(lo,hi)-1e-12).sort((x,y)=>direction*(x-y)),ids=[a];
    for(const t of additions){const p=proof.toUv(t),position=evaluateSurface(proof.surface,p),[du,dv]=bounds.tangent(p),normal=cross(du,dv),length=Math.hypot(...normal);
      check(length>1e-12,'singular-isocurve-normal');const id=mesh.positions.length;uv.push(p);mesh.positions.push(position);
      mesh.normals.push(normal.map(x=>x/length*(ir.faces[part.face].reversed?-1:1)));ids.push(id);inserted++;}
    ids.push(b);newBoundary.push(...ids.slice(0,-1));if(!additions.length)continue;
    const hits=mesh.triangles.flatMap((t:number[],index:number)=>t.flatMap((x,k)=>x===a&&t[(k+1)%3]===b||x===b&&t[(k+1)%3]===a?[{index,k}]:[]));
    check(hits.length===1,'isocurve-not-single-triangle-boundary');const {index,k}=hits[0],triangle=mesh.triangles[index],order=triangle[k]===a?ids:[...ids].reverse(),opposite=triangle[(k+2)%3];
    const triangles=order.slice(1).map((id,i)=>[order[i],id,opposite]);
    for(const t of triangles){const [a,b,c]=t.map(i=>mesh.positions[i]),normal=cross(sub(b,a),sub(c,a));
      check(Math.hypot(...normal)>1e-14&&t.every(i=>dot(normal,mesh.normals[i])>0),'inverted-isocurve-refinement');}
    mesh.triangles.splice(index,1,...triangles);
  }
  boundary.vertices=[...newBoundary,old.at(-1)];mesh.sourceFaceCount=mesh.triangles.length;
  const quantization=Math.max(...mesh.positions.map((p:number[])=>Math.hypot(...p.map(x=>Math.fround(x)-x))));
  const physicalBoundMm=part.audit.physicalBoundMm+(Math.max(0,quantization-part.audit.quantization)+proof.continuousBound)*metersPerUnit*1000;
  check(physicalBoundMm<=.01&&mesh.positions.length<=100000&&mesh.triangles.length<=200000,'isocurve-refinement-budget');
  part.audit.quantization=quantization;part.audit.physicalBoundMm=physicalBoundMm;
  return {face:part.face,inserted,continuousBound:proof.continuousBound,physicalBoundMm};
}
/** Transactional, source-identified parameter union. Only subdivides the affected face boundary triangles. */
export function synchronizeSourceEdges(ir:any,input:any[],metersPerUnit:number) {
  check(Number.isFinite(metersPerUnit)&&metersPerUnit>0,'invalid-isocurve-unit');
  let parts=[...input];const records:any[]=[],failures:any[]=[];
  const initial=auditBrepBoundaries(ir,parts);
  for(const candidate of initial.shared.filter(e=>!e.conforming)){
    const pair=candidate.faces.map((face:number)=>parts.find(p=>p.face===face));
    if(pair.some((p:any)=>p.geometrySource!=='cad-ir-rational-bezier-chain'))continue;
    try{
      const chain=sourceEdgeChain(ir,candidate.edge,metersPerUnit),domain=ir.edges[candidate.edge].sourceSubdomain;
      const parameters=chain.parameters.map(t=>(t-domain[0])/(domain[1]-domain[0]));
      for(const p of pair){const proof=proveSourceIsocurve(ir,p,candidate.edge);parameters.push(...proof.boundary.vertices.map((id:number)=>proof.toParameter(p.audit.uv[id])));}
      parameters.sort((a,b)=>a-b);const union=parameters.filter((t,i)=>!i||t-parameters[i-1]>1e-12);
      check(union.length<=4096&&union.every(t=>Number.isFinite(t)&&t>=-1e-12&&t<=1+1e-12)
        &&Math.abs(union[0])<1e-10&&Math.abs(union.at(-1)!-1)<1e-10,'invalid-isocurve-parameter-union');
      const replacements=pair.map((p:any)=>structuredClone(p)),proofs=replacements.map((p:any)=>splitBoundary(ir,p,candidate.edge,union,metersPerUnit));
      const trial=parts.map(p=>replacements.find((r:any)=>r.face===p.face)??p),audit=auditBrepBoundaries(ir,trial),previous=auditBrepBoundaries(ir,parts);
      check(audit.shared.find(e=>e.edge===candidate.edge)?.conforming,'isocurve-refinement-not-conforming');
      check(previous.shared.filter(e=>e.conforming).every(e=>audit.shared.find(a=>a.edge===e.edge)?.conforming),'isocurve-topology-regression');
      const record={edge:candidate.edge,parameters:union.map(t=>domain[0]+t*(domain[1]-domain[0])),proofs};
      for(const p of replacements)p.audit.sourceIsocurveRefinements=[...(p.audit.sourceIsocurveRefinements??[]),record];
      parts=trial;records.push(record);
    }catch(error){failures.push({edge:candidate.edge,code:error instanceof Error?error.message:'source-isocurve-failed'});}
  }
  return {parts,records,failures};
}
