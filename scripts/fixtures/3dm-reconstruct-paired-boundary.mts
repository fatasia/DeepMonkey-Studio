import {provePairedBoundary} from './3dm-paired-boundary-proof.mts';
import {pairedCurveParameter} from './3dm-paired-boundary-map.mts';
import {evaluateCurve,evaluateSurface} from './3dm-nurbs-parameters.mjs';
import {synchronizeSourceEdges} from './3dm-synchronize-source-edges.mts';
import {auditBrepBoundaries} from './3dm-brep-boundary-audit.mts';
function check(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

/** 仅改变已有双侧连续证书的曲面边；提交前重新检查两面和所有邻边。 */
export function reconstructPairedBoundaries(ir:any,input:any[],metersPerUnit:number){
  check(Number.isFinite(metersPerUnit)&&metersPerUnit>0,'invalid-paired-reconstruction-unit');
  let parts=[...input],current=auditBrepBoundaries(ir,parts);const records:any[]=[],failures:any[]=[];
  for(const candidate of current.shared.filter(e=>!e.conforming))try{
    const proof=provePairedBoundary(ir,candidate.edge,metersPerUnit);
    const curved=parts.find(p=>p.face===proof.faces[1]),plane=parts.find(p=>p.face===proof.faces[0]);
    check(curved?.geometrySource==='cad-ir-rational-bezier-chain'&&['cad-ir-affine-plane-trim','cad-ir-rational-bezier-chain'].includes(plane?.geometrySource),'unsupported-paired-reconstruction-parts');
    const copy=structuredClone(curved),boundary=copy.boundaryEdges.find((b:any)=>b.edge===candidate.edge);
    check(boundary?.vertices?.length>=2&&Array.isArray(copy.audit?.uv),'missing-paired-reconstruction-boundary');
    const curve=ir.curves3d[ir.edges[candidate.edge].curve3d],surface=ir.surfaces[ir.faces[curved.face].surface];
    const source=boundary.vertices.map((id:number)=>({vertex:id,position:[...copy.mesh.positions[id]],uv:[...copy.audit.uv[id]]}));
    const level=ir.curves2d[ir.trims[proof.trims[1]].curve2d].controlPoints[0][1];
    let maxMovement=0;
    boundary.parameters=source.map((old:any,i:number)=>{
      check(distance(old.position,evaluateSurface(surface,old.uv))<=1e-10,'paired-reconstruction-not-on-source');
      const t=pairedCurveParameter(proof,old.uv[0],true),point=evaluateCurve(curve,t),movement=distance(point,old.position);
      check(movement<=proof.sourceBound+1e-10,'paired-reconstruction-exceeds-proof');
      // 共边端点同时属于邻边；不移动源拓扑顶点。
      if(i===0||i===source.length-1)check(movement<=1e-10,'paired-reconstruction-endpoint-moved');
      copy.mesh.positions[old.vertex]=point;copy.audit.uv[old.vertex]=[pairedCurveParameter(proof,t),level];
      maxMovement=Math.max(maxMovement,movement);return t;
    });
    for(const triangle of copy.mesh.triangles){
      const [a,b,c]=triangle.map((id:number)=>copy.mesh.positions[id]),normal=cross(sub(b,a),sub(c,a));
      check(Math.hypot(...normal)>1e-14&&triangle.every((id:number)=>normal.reduce((sum,x,j)=>sum+x*copy.mesh.normals[id][j],0)>0),'inverted-paired-reconstruction');
    }
    const prior=copy.audit.physicalBoundMm,quantization=Math.max(...copy.mesh.positions.map((p:number[])=>distance(p,p.map(Math.fround))));
    const quantizationDelta=Math.max(0,quantization-copy.audit.quantization);
    const physicalBoundMm=prior+(proof.sourceBound+quantizationDelta)*metersPerUnit*1000;
    check(Number.isFinite(physicalBoundMm)&&physicalBoundMm<=.01,'paired-reconstruction-physical-budget');
    const record={edge:candidate.edge,face:curved.face,metersPerUnit,source,sourceBound:proof.sourceBound,maxMovement,
      priorPhysicalBoundMm:prior,quantizationDelta,physicalBoundMm,segments:proof.mapping.segments};
    copy.audit.physicalBoundMm=physicalBoundMm;copy.audit.quantization=quantization;
    copy.audit.sourcePairReconstructions=[...(copy.audit.sourcePairReconstructions??[]),record];
    const synchronized=synchronizeSourceEdges(ir,[copy,plane],metersPerUnit),accepted=synchronized.records.find(r=>r.edge===candidate.edge);
    check(accepted,`paired-reconstruction-synchronization-failed:${synchronized.failures.find(f=>f.edge===candidate.edge)?.code??'missing'}`);
    const trial=parts.map(p=>synchronized.parts.find(r=>r.face===p.face)??p),audit=auditBrepBoundaries(ir,trial);
    check(audit.shared.find(e=>e.edge===candidate.edge)?.conforming
      &&current.shared.filter(e=>e.conforming).every(e=>audit.shared.find(a=>a.edge===e.edge)?.conforming)
      &&current.seams.filter(e=>e.conforming).every(e=>audit.seams.find(a=>a.edge===e.edge)?.conforming),'paired-reconstruction-topology-regression');
    parts=trial;current=audit;records.push({...record,synchronization:accepted});
  }catch(error){failures.push({edge:candidate.edge,code:error instanceof Error?error.message:'paired-reconstruction-failed'});}
  return {parts,records,failures};
}
