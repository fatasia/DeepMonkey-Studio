import { evaluateCurve } from './3dm-nurbs-parameters.mjs';
import { trimPolyline } from './3dm-trim-polyline.mts';
import { tessellatePlanarFace } from './3dm-planar-trim.mts';
import { refineCylinderBoundaries } from './3dm-refine-cylinder-boundaries.mts';
import { auditBrepBoundaries } from './3dm-brep-boundary-audit.mts';
import { proveTrimEdgeTolerance } from './3dm-edge-tolerance-proof.mts';
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const dot=(a:number[],b:number[])=>a.reduce((s,x,i)=>s+x*b[i],0);
const distance=(a:number[],b:number[])=>Math.hypot(...sub(a,b));
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
function project(curve:any,domain:number[],target:number[]){
  let [lo,hi]=domain;
  for(let i=0;i<70;i++){const a=lo+(hi-lo)/3,b=hi-(hi-lo)/3;
    if(distance(evaluateCurve(curve,a),target)<distance(evaluateCurve(curve,b),target))hi=b;else lo=a;
  }
  return [domain[0],(lo+hi)/2,domain[1]].map(parameter=>({parameter,point:evaluateCurve(curve,parameter)}))
    .sort((a,b)=>distance(a.point,target)-distance(b.point,target))[0];
}
function planeCoordinates(surface:any,p:number[]){
  const cp=surface.controlPoints,u=sub(cp[1],cp[0]),v=sub(cp[2],cp[0]),w=sub(p,cp[0]);
  const uu=dot(u,u),uv=dot(u,v),vv=dot(v,v),det=uu*vv-uv*uv;
  check(det>1e-20,'singular-weld-plane');const a=(dot(w,u)*vv-dot(w,v)*uv)/det,b=(dot(w,v)*uu-dot(w,u)*uv)/det;
  const projected=cp[0].map((x:number,i:number)=>x+a*u[i]+b*v[i]);
  return {uv:[a,b].map((x,i)=>surface.domain[i][0]+x*(surface.domain[i][1]-surface.domain[i][0])),residual:distance(p,projected)};
}
/** Source edge controls a bounded planar/cylinder repair; edge tolerance never replaces total budget. */
export function weldSourceEdges(ir:any,input:any[],metersPerUnit:number,totalBudgetMm=0.01){
  check(Number.isFinite(metersPerUnit)&&metersPerUnit>0&&Number.isFinite(totalBudgetMm)&&totalBudgetMm>0&&totalBudgetMm<=0.01,'invalid-weld-unit-budget');
  const totalBudget=totalBudgetMm/(1000*metersPerUnit),records:any[]=[],failures:any[]=[],overrides=new Map<number,Map<number,number[][]>>();
  let parts=[...input];const candidates=auditBrepBoundaries(ir,parts).shared.filter(e=>!e.conforming);
  for(const candidate of candidates)try{
    const pair=candidate.faces.map((face:number)=>parts.find(p=>p.face===face));
    const plane=pair.find((p:any)=>p.geometrySource==='cad-ir-affine-plane-trim'),cylinder=pair.find((p:any)=>p.geometrySource==='cad-ir-natural-cylinder');
    check(plane&&cylinder,'unsupported-source-edge-weld-pair');
    check(Math.max(plane.audit.trimChordTolerance,cylinder.audit.controlHullBound)<=totalBudget,'source-edge-total-budget-exceeded');
    const edge=ir.edges[candidate.edge],curve=ir.curves3d[edge.curve3d];
    check(Number.isFinite(edge.tolerance)&&edge.tolerance>=0,'missing-source-edge-tolerance');
    check(curve?.degree===2&&curve.controlPoints.length===3&&curve.rational&&curve.parameterMap?.kind==='identity','unsupported-weld-edge-curve');
    const boundary=plane.boundaryEdges.find((b:any)=>b.edge===candidate.edge),surface=ir.surfaces[ir.faces[plane.face].surface];
    const original=boundary.vertices.map((i:number)=>plane.mesh.positions[i]);let projected=original.map((p:number[])=>project(curve,edge.sourceSubdomain,p));
    const direction=Math.sign(projected.at(-1).parameter-projected[0].parameter);
    check(direction!==0&&projected.every((p:any,i:number)=>!i||direction*(p.parameter-projected[i-1].parameter)>1e-14),'non-monotonic-source-edge-weld');
    check(distance(original[0],projected[0].point)<1e-8&&distance(original.at(-1),projected.at(-1).point)<1e-8,'source-edge-vertex-mismatch');
    const maxBoundaryCorrection=Math.max(...original.map((p:number[],i:number)=>distance(p,projected[i].point)));
    if(maxBoundaryCorrection>edge.tolerance+1e-10)throw new Error('source-edge-declared-tolerance-exceeded',{cause:{maxBoundaryCorrection,declaredEdgeTolerance:edge.tolerance}});
    const toleranceProof=proveTrimEdgeTolerance(ir,boundary.trim,surface,edge,curve,p=>project(curve,edge.sourceSubdomain,p));
    const cylinderBoundary=cylinder.boundaryEdges.find((b:any)=>b.edge===candidate.edge);
    const retained=cylinderBoundary.vertices.map((i:number)=>{
      const point=cylinder.mesh.positions[i],p=project(curve,edge.sourceSubdomain,point);
      check(distance(point,p.point)<1e-8,'source-edge-not-on-cylinder');return p;
    });
    projected=[...projected,...retained].sort((a,b)=>direction*(a.parameter-b.parameter))
      .filter((p,i,a)=>!i||Math.abs(p.parameter-a[i-1].parameter)>1e-11);
    const uv=projected.map((p:any)=>planeCoordinates(surface,p.point)),maxPlaneResidual=Math.max(...uv.map((p:any)=>p.residual));
    check(maxPlaneResidual<1e-8,'source-edge-not-on-plane');
    let edgeChordBound=0;
    for(let i=1;i<projected.length;i++){
      const domain=[projected[i-1].parameter,projected[i].parameter].sort((a,b)=>a-b);
      const line=trimPolyline(curve,domain,false,totalBudget/4);
      check(line.points.length===2,'source-edge-needs-more-samples');edgeChordBound=Math.max(edgeChordBound,line.maxBound);
    }
    const faceOverrides=new Map(overrides.get(plane.face)??[]);faceOverrides.set(boundary.trim,uv.map((p:any)=>p.uv));
    const repairedPlane=tessellatePlanarFace(ir,plane.face,faceOverrides);
    const trial=parts.map(p=>p===plane?repairedPlane:p),refined=refineCylinderBoundaries(ir,trial);
    check(!refined.failures.some(f=>f.face===cylinder.face),'source-edge-not-on-cylinder');
    const finalCylinder=refined.parts.find(p=>p.face===cylinder.face),audit=auditBrepBoundaries(ir,refined.parts);
    check(audit.shared.find(e=>e.edge===candidate.edge)?.conforming,'source-edge-weld-not-conforming');
    // Retain all previously valid shared edges, including other neighbours of either changed face.
    const previous=auditBrepBoundaries(ir,parts);check(previous.shared.filter(e=>e.conforming).every(e=>audit.shared.find(a=>a.edge===e.edge)?.conforming),'source-edge-weld-topology-regression');
    const quantization=Math.max(...[repairedPlane,finalCylinder].flatMap(p=>p.mesh.positions.map((v:number[])=>distance(v,v.map(Math.fround)))));
    const priorCorrection=(plane.audit.sourceEdgeWelds??[]).reduce((s:number,r:any)=>s+r.maxBoundaryCorrection,0);
    const planeErrorBound=plane.audit.trimChordTolerance+priorCorrection+maxBoundaryCorrection+edgeChordBound+quantization;
    const cylinderErrorBound=finalCylinder.audit.controlHullBound+quantization;
    const edgeErrorBound=edgeChordBound+Math.max(maxPlaneResidual,finalCylinder.audit.maxSupportResidual)+quantization;
    check(Math.max(planeErrorBound,cylinderErrorBound,edgeErrorBound)<=totalBudget,'source-edge-total-budget-exceeded');
    const record={edge:candidate.edge,planeFace:plane.face,cylinderFace:cylinder.face,budgetSpace:'source-local-physical-before-instance-transform',metersPerUnit,totalBudgetMm,totalBudgetSource:totalBudget,
      declaredEdgeTolerance:edge.tolerance,toleranceProof,maxBoundaryCorrection,maxPlaneResidual,maxCylinderResidual:finalCylinder.audit.maxSupportResidual,
      edgeChordBound,float32Quantization:quantization,planeErrorBound,cylinderErrorBound,edgeErrorBound,sourceEdgeParameters:projected.map((p:any)=>p.parameter)};
    records.push(record);Object.assign(repairedPlane.audit,{sourceEdgeWelds:[...(plane.audit.sourceEdgeWelds??[]),record]});
    overrides.set(plane.face,faceOverrides);parts=refined.parts;
  }catch(error){failures.push({edge:candidate.edge,code:error instanceof Error?error.message:'source-edge-weld-failed',detail:error instanceof Error?error.cause:undefined});}
  return {parts,records,failures};
}
