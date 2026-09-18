import {provePlaneC3Map} from './3dm-plane-c3-map.mts';
import {proveSourceIsocurve} from './3dm-source-isocurve.mts';
import {synchronizeSourceEdges} from './3dm-synchronize-source-edges.mts';
import {auditBrepBoundaries} from './3dm-brep-boundary-audit.mts';
import {evaluateSurface} from './3dm-nurbs-parameters.mjs';
import {sourceEdgeChain} from './3dm-source-edge-chain.mts';
import {validatePlanarRings} from './3dm-planar-trim.mts';
function check(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
/** Only an authored plane boundary is moved; source geometry and unrelated vertices remain immutable. */
export function reconstructPlaneSourceEdges(ir:any,input:any[],metersPerUnit:number){
  check(Number.isFinite(metersPerUnit)&&metersPerUnit>0,'invalid-reconstruction-unit');let parts=[...input];const records:any[]=[],failures:any[]=[],initial=auditBrepBoundaries(ir,input);let currentAudit=initial;
  for(const candidate of initial.shared.filter(e=>!e.conforming)){
    const pair=candidate.faces.map(face=>parts.find(p=>p.face===face)),plane=pair.find(p=>p.geometrySource==='cad-ir-affine-plane-trim'),other=pair.find(p=>p!==plane);
    if(!plane||!other)continue;
    try{
      const otherProof=proveSourceIsocurve(ir,other,candidate.edge),proof=provePlaneC3Map(ir,plane.face,candidate.edge,metersPerUnit),copy=structuredClone(plane),boundary=copy.boundaryEdges.find((b:any)=>b.trim===proof.trim);
      check(boundary?.parameters?.length===boundary.vertices.length,'missing-original-plane-parameters');
      const source=boundary.vertices.map((id:number,i:number)=>({vertex:id,parameter:boundary.parameters[i],uv:[...copy.parameterUv[id]],position:[...copy.mesh.positions[id]]}));
      const d=ir.edges[candidate.edge].sourceSubdomain,anchors=[...sourceEdgeChain(ir,candidate.edge,metersPerUnit).parameters,...otherProof.boundary.vertices.map((id:number)=>d[0]+otherProof.toParameter(other.audit.uv[id])*(d[1]-d[0]))];
      let snapBound=0;const mapped=source.map((v:any)=>{const t=proof.toC3(v.parameter),p=evaluateSurface(proof.surface,proof.toUv(t));
        const nearest=anchors.map((t:number)=>({t,error:Math.hypot(...sub(evaluateSurface(proof.surface,proof.toUv(t)),p))})).sort((a:any,b:any)=>a.error-b.error)[0];
        if(nearest&&nearest.error<=1e-8/(metersPerUnit*1000)){snapBound=Math.max(snapBound,nearest.error);return nearest.t;}return t;});let maxMovement=0;
      for(let i=0;i<source.length;i++){const old=source[i],uv=proof.toUv(mapped[i]),position=evaluateSurface(proof.surface,uv),movement=Math.hypot(...sub(position,old.position));
        check(movement<=proof.continuousBound+snapBound+1e-10,'reconstructed-vertex-exceeds-proof');maxMovement=Math.max(maxMovement,movement);
        if(i===0||i===source.length-1)check(movement<=1e-10,'reconstructed-endpoint-moved');
        else{copy.parameterUv[old.vertex]=uv;copy.mesh.positions[old.vertex]=position;}}
      validatePlanarRings(ir.faces[plane.face].loops.map((i:number)=>ir.loops[i]).sort((a:any,b:any)=>a.type-b.type).map((loop:any)=>loop.trims.flatMap((trim:number)=>copy.boundaryEdges.find((b:any)=>b.trim===trim).vertices.slice(0,-1).map((id:number)=>copy.parameterUv[id]))));
      for(const t of copy.mesh.triangles){const [a,b,c]=t.map((i:number)=>copy.mesh.positions[i]),normal=cross(sub(b,a),sub(c,a));
        check(Math.hypot(...normal)>1e-14&&t.every((i:number)=>normal.reduce((s,x,j)=>s+x*copy.mesh.normals[i][j],0)>0),'inverted-plane-reconstruction');}
      boundary.parameters=mapped;
      const prior=copy.audit.physicalBoundMm??(copy.audit.trimChordTolerance+copy.audit.affineError)*metersPerUnit*1000;
      const physicalBoundMm=prior+(proof.continuousBound+snapBound)*metersPerUnit*1000;
      check(physicalBoundMm<=.01,'plane-reconstruction-physical-budget');
      const record={edge:candidate.edge,face:plane.face,metersPerUnit,source,segments:proof.segments,continuousBound:proof.continuousBound,snapBound,mapped,maxMovement,physicalBoundMm};
      copy.audit.physicalBoundMm=physicalBoundMm;copy.audit.sourceC3Reconstructions=[...(copy.audit.sourceC3Reconstructions??[]),record];
      const synchronized=synchronizeSourceEdges(ir,[copy,other],metersPerUnit),accepted=synchronized.records.find(r=>r.edge===candidate.edge);
      check(accepted,`reconstructed-source-synchronization-failed:${synchronized.failures.find(f=>f.edge===candidate.edge)?.code??'missing'}`);
      const trial=parts.map(p=>synchronized.parts.find(r=>r.face===p.face)??p),audit=auditBrepBoundaries(ir,trial),previous=currentAudit;
      check(audit.shared.find(e=>e.edge===candidate.edge)?.conforming&&previous.shared.filter(e=>e.conforming).every(e=>audit.shared.find(a=>a.edge===e.edge)?.conforming)
        &&previous.seams.filter(e=>e.conforming).every(e=>audit.seams.find(a=>a.edge===e.edge)?.conforming),'plane-reconstruction-topology-regression');
      parts=trial;currentAudit=audit;records.push({...record,synchronization:accepted});
    }catch(error){failures.push({edge:candidate.edge,code:error instanceof Error?error.message:'plane-reconstruction-failed'});}
  }
  return {parts,records,failures};
}
