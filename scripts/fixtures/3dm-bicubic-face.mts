import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { triangulateTrimGrid } from './3dm-trim-grid.mts';
import { polynomialDerivative as derivative,validatePolynomialBicubic } from './3dm-polynomial-surface.mts';
import { refineSurfaceWinding } from './3dm-refine-surface-winding.mts';
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
/** Nonrational single bicubic patch. Convex derivative nets bound the entire trimmed parameter domain. */
export function tessellateBicubicFace(ir:any,faceIndex:number,metersPerUnit:number) {
  return tessellatePolynomialFace(ir,faceIndex,metersPerUnit,false);
}
export function tessellateMultispanBicubicFace(ir:any,faceIndex:number,metersPerUnit:number) {
  return tessellatePolynomialFace(ir,faceIndex,metersPerUnit,true);
}
function tessellatePolynomialFace(ir:any,faceIndex:number,metersPerUnit:number,multispan:boolean) {
  const face=ir.faces[faceIndex],s=ir.surfaces[face?.surface];
  check(Number.isFinite(metersPerUnit)&&metersPerUnit>0,'missing-bicubic-physical-unit');
  validatePolynomialBicubic(s,multispan);
  const du=derivative(s,0),dv=derivative(s,1),duu=derivative(du,0),duv=derivative(du,1),dvv=derivative(dv,1);
  const bound=(net:any)=>Math.max(...net.controlPoints.map((p:number[])=>Math.hypot(...p)));
  const first=[bound(du),bound(dv)],second=[bound(duu),bound(duv),bound(dvv)],width=s.domain.map((d:number[])=>d[1]-d[0]);
  const lipschitz=first[0]+first[1],budget=.00001/metersPerUnit,trimBound=.1*budget;
  const numerator=second[0]*width[0]**2+2*second[1]*width[0]*width[1]+second[2]*width[1]**2;
  const divisions=Math.max(1,Math.ceil(Math.sqrt(numerator/(8*.7*budget))));
  check(Number.isFinite(lipschitz)&&lipschitz>0&&Number.isFinite(divisions)&&divisions<=256,'bicubic-subdivision-budget');
  const cuts=s.domain.map((d:number[],axis:number)=>({axis,parameters:[...new Set<number>([
    ...Array.from({length:divisions+1},(_,i)=>i===divisions?d[1]:d[0]+(d[1]-d[0])*i/divisions),...s.knots[axis]])].sort((a,b)=>a-b)}));
  const {uv,triangles:initial,boundaryEdges,mergeEpsilon,holeCount}=triangulateTrimGrid(ir,faceIndex,trimBound/lipschitz,cuts);
  const sourceNormal=(p:number[])=>{
    const normal=cross(evaluateSurface(du,p),evaluateSurface(dv,p)),length=Math.hypot(...normal);
    check(length>1e-12,'singular-bicubic-normal');return normal.map(x=>x/length*(face.reversed?-1:1));
  };
  const {positions,normals,triangles,inserted,passes}=refineSurfaceWinding(uv,initial,boundaryEdges,s.domain,p=>evaluateSurface(s,p),sourceNormal);
  const interpolationBound=numerator/(8*divisions**2),parameterMergeBound=mergeEpsilon*lipschitz;
  const quantization=Math.max(...positions.map(p=>Math.hypot(...p.map(x=>Math.fround(x)-x))));
  const physicalBoundMm=(trimBound+interpolationBound+parameterMergeBound+quantization)*metersPerUnit*1000;
  check(physicalBoundMm<=.01,'bicubic-physical-budget');
  return {face:faceIndex,geometrySource:multispan?'cad-ir-multispan-bicubic':'cad-ir-single-bicubic',boundaryEdges,
    mesh:{positions,triangles,normals,textureCoordinates:[],sourceFaceCount:triangles.length,quadCount:0},
    audit:{physicalBudgetMm:.01,physicalBoundMm,trimBound,interpolationBound,parameterMergeBound,quantization,
      derivativeBounds:{first,second},divisions,holeCount,uv,domain:s.domain,
      ...(multispan?{sourceKnots:s.knots,cutParameters:cuts.map((c:any)=>c.parameters),windingRefinement:{inserted,passes}}:{}),precisionSpace:'source-local-physical-before-instance-transform'}};
}
