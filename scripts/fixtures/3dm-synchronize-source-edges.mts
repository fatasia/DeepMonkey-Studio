import { sourceEdgeChain } from './3dm-source-edge-chain.mts';
import { proveSourceBoundary } from './3dm-source-boundary-proof.mts';
import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { rationalBezierBounds } from './3dm-rational-bezier-bounds.mts';
import { auditBrepBoundaries } from './3dm-brep-boundary-audit.mts';
import {polygonArea} from './3dm-planar-trim.mts';
import {trimPolyline} from './3dm-trim-polyline.mts';
import {refineLocalPlanePatch} from './3dm-local-plane-patch.mts';
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a:number[],b:number[])=>a.reduce((sum,x,i)=>sum+x*b[i],0);
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
function splitBoundary(ir:any,part:any,edge:number,parameters:number[],metersPerUnit:number) {
  const proof=proveSourceBoundary(ir,part,edge),boundary=proof.boundary,old=[...boundary.vertices],mesh=part.mesh,uv=part.audit.uv??part.parameterUv;
  const plane=part.geometrySource==='cad-ir-affine-plane-trim',bounds=plane?null:rationalBezierBounds(proof.surface),newBoundary:number[]=[],newParameters:number[]=[],localRetriangulations:any[]=[];let inserted=0;
  for(let j=1;j<old.length;j++){
    const a=old[j-1],b=old[j],lo=proof.toBoundaryParameter(j-1),hi=proof.toBoundaryParameter(j),direction=Math.sign(hi-lo);
    check(direction!==0,'non-monotonic-isocurve-boundary');
    const additions=parameters.filter(t=>t>Math.min(lo,hi)+1e-12&&t<Math.max(lo,hi)-1e-12).sort((x,y)=>direction*(x-y)),ids=[a];
    for(const t of additions){const p=proof.toUv(t),position=evaluateSurface(proof.surface,p),normal=plane?[...mesh.normals[a]]:(()=>{const [du,dv]=bounds!.tangent(p);return cross(du,dv);})(),length=Math.hypot(...normal);
      check(length>1e-12,'singular-isocurve-normal');const id=mesh.positions.length;uv.push(p);mesh.positions.push(position);
      mesh.normals.push(normal.map(x=>x/length*(!plane&&ir.faces[part.face].reversed?-1:1)));ids.push(id);inserted++;}
    ids.push(b);newBoundary.push(...ids.slice(0,-1));newParameters.push(...[lo,...additions].map(proof.sourceParameter));if(!additions.length)continue;
    const hits=mesh.triangles.flatMap((t:number[],index:number)=>t.flatMap((x,k)=>x===a&&t[(k+1)%3]===b||x===b&&t[(k+1)%3]===a?[{index,k}]:[]));
    check(hits.length===1,'isocurve-not-single-triangle-boundary');const {index,k}=hits[0],triangle=mesh.triangles[index],order=triangle[k]===a?ids:[...ids].reverse(),opposite=triangle[(k+2)%3];
    let triangles=order.slice(1).map((id,i)=>[order[i],id,opposite]);
    const valid=(t:number[])=>{const [a,b,c]=t.map(i=>mesh.positions[i]),normal=cross(sub(b,a),sub(c,a));return Math.hypot(...normal)>1e-14&&t.every(i=>dot(normal,mesh.normals[i])>0);};
    let removed=[index];
    if(plane&&!triangles.every(valid)){const patch=refineLocalPlanePatch(part,uv,a,b,ids,index,boundary.trim,[...newBoundary,b,...old.slice(j+1)]);
      triangles=patch.triangles;removed=patch.removed;localRetriangulations.push({segment:j-1,removed:removed.length,triangles:triangles.length,passes:patch.passes});}
    for(const t of triangles){const [a,b,c]=t.map(i=>mesh.positions[i]),normal=cross(sub(b,a),sub(c,a));
      check(Math.hypot(...normal)>1e-14&&t.every(i=>dot(normal,mesh.normals[i])>0),'inverted-isocurve-refinement');}
    for(const i of removed)mesh.triangles.splice(i,1);mesh.triangles.splice(Math.min(...removed),0,...triangles);
  }
  boundary.vertices=[...newBoundary,old.at(-1)];mesh.sourceFaceCount=mesh.triangles.length;
  if(plane)boundary.parameters=[...newParameters,proof.sourceParameter(proof.toBoundaryParameter(old.length-1))];
  const quantization=Math.max(...mesh.positions.map((p:number[])=>Math.hypot(...p.map(x=>Math.fround(x)-x))));
  const baseBound=part.audit.physicalBoundMm??(part.audit.trimChordTolerance+part.audit.affineError)*metersPerUnit*1000;
  const physicalBoundMm=baseBound+(Math.max(0,quantization-(part.audit.quantization??0))+proof.continuousBound)*metersPerUnit*1000;
  check(physicalBoundMm<=.01&&mesh.positions.length<=100000&&mesh.triangles.length<=200000,'isocurve-refinement-budget');
  part.audit.quantization=quantization;part.audit.physicalBoundMm=physicalBoundMm;
  if(plane){
    const s=proof.surface,cp=s.controlPoints,scale=Math.hypot(...sub(cp[1],cp[0]))/(s.domain[0][1]-s.domain[0][0])
      +Math.hypot(...sub(cp[2],cp[0]))/(s.domain[1][1]-s.domain[1][0]);
    for(let i=1;i<boundary.parameters.length;i++){
      const domain=[boundary.parameters[i-1],boundary.parameters[i]].sort((a:number,b:number)=>a-b);
      const line=trimPolyline((proof as any).curve,domain,false,part.audit.trimChordTolerance/scale),a=line.points[0],b=line.points.at(-1)!,d=sub(b,a),length=dot(d,d);
      const deviation=Math.max(...line.points.map(p=>{const t=length?Math.max(0,Math.min(1,dot(sub(p,a),d)/length)):0;return Math.hypot(...p.map((x,j)=>x-a[j]-t*d[j]));}));
      check((line.maxBound+deviation)*scale<=part.audit.trimChordTolerance+1e-12,'isocurve-plane-chord-budget');
    }
    const area=ir.faces[part.face].loops.reduce((sum:number,loop:number)=>{
      const ring=ir.loops[loop].trims.flatMap((trim:number)=>part.boundaryEdges.find((b:any)=>b.trim===trim).vertices.slice(0,-1).map((id:number)=>uv[id]));
      return sum+(ir.loops[loop].type===1?1:-1)*Math.abs(polygonArea(ring));
    },0);
    const triangleArea=mesh.triangles.reduce((sum:number,t:number[])=>sum+Math.abs(polygonArea(t.map(i=>uv[i]))),0);
    check(area>0&&Math.abs(area-triangleArea)<1e-9*Math.max(1,area),'isocurve-plane-area-mismatch');
    part.audit.sourcePlaneArea*=area/part.audit.uvArea;part.audit.uvArea=area;part.audit.triangleUvArea=triangleArea;
  }
  return {face:part.face,inserted,continuousBound:proof.continuousBound,physicalBoundMm,...(localRetriangulations.length?{localRetriangulations}:{})};
}
/** Transactional, source-identified parameter union. Only subdivides the affected face boundary triangles. */
export function synchronizeSourceEdges(ir:any,input:any[],metersPerUnit:number) {
  check(Number.isFinite(metersPerUnit)&&metersPerUnit>0,'invalid-isocurve-unit');
  let parts=[...input];const records:any[]=[],failures:any[]=[];
  const initial=auditBrepBoundaries(ir,parts);
  for(const candidate of initial.shared.filter(e=>!e.conforming)){
    const pair=candidate.faces.map((face:number)=>parts.find(p=>p.face===face));
    if(pair.some((p:any)=>!['cad-ir-rational-bezier-chain','cad-ir-affine-plane-trim'].includes(p.geometrySource)))continue;
    try{
      const chain=sourceEdgeChain(ir,candidate.edge,metersPerUnit),domain=ir.edges[candidate.edge].sourceSubdomain;
      const parameters=chain.parameters.map(t=>(t-domain[0])/(domain[1]-domain[0]));
      for(const p of pair){const proof=proveSourceBoundary(ir,p,candidate.edge);parameters.push(...proof.boundary.vertices.map((_:number,i:number)=>proof.toBoundaryParameter(i)));}
      parameters.sort((a,b)=>a-b);const union=parameters.filter((t,i)=>!i||t-parameters[i-1]>1e-12);
      check(union.length<=4096&&union.every(t=>Number.isFinite(t)&&t>=-1e-12&&t<=1+1e-12)
        &&Math.abs(union[0])<1e-10&&Math.abs(union.at(-1)!-1)<1e-10,'invalid-isocurve-parameter-union');
      const replacements=pair.map((p:any)=>structuredClone(p)),proofs=replacements.map((p:any)=>splitBoundary(ir,p,candidate.edge,union,metersPerUnit));
      const trial=parts.map(p=>replacements.find((r:any)=>r.face===p.face)??p),audit=auditBrepBoundaries(ir,trial),previous=auditBrepBoundaries(ir,parts);
      check(audit.shared.find(e=>e.edge===candidate.edge)?.conforming,'isocurve-refinement-not-conforming');
      check(previous.shared.filter(e=>e.conforming).every(e=>audit.shared.find(a=>a.edge===e.edge)?.conforming),'isocurve-topology-regression');
      check(previous.seams.filter(e=>e.conforming).every(e=>audit.seams.find(a=>a.edge===e.edge)?.conforming),'isocurve-self-seam-regression');
      const record={edge:candidate.edge,parameters:union.map(t=>domain[0]+t*(domain[1]-domain[0])),proofs};
      for(const p of replacements)p.audit.sourceIsocurveRefinements=[...(p.audit.sourceIsocurveRefinements??[]),record];
      parts=trial;records.push(record);
    }catch(error){failures.push({edge:candidate.edge,code:error instanceof Error?error.message:'source-isocurve-failed'});}
  }
  return {parts,records,failures};
}
