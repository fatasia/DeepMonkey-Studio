import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { rationalBezierBounds } from './3dm-rational-bezier-bounds.mts';
import { triangulateTrimGrid } from './3dm-trim-grid.mts';
import { refineSurfaceWinding } from './3dm-refine-surface-winding.mts';
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
/** Bounded positive-weight or polynomial Bezier chains, split at every source knot. */
export function tessellateRationalBezierFace(ir:any,faceIndex:number,metersPerUnit:number,meshBudgetMm=.01) {
  check(Number.isFinite(metersPerUnit)&&metersPerUnit>0,'invalid-rational-face-unit');
  check(Number.isFinite(meshBudgetMm)&&meshBudgetMm>0&&meshBudgetMm<=.01,'invalid-rational-face-budget');
  const face=ir.faces[faceIndex],s=ir.surfaces[face?.surface],bounds=rationalBezierBounds(s),{first,second}=bounds;
  const width=s.domain.map((d:number[])=>d[1]-d[0]),lipschitz=first[0]+first[1],budget=meshBudgetMm/(1000*metersPerUnit),trimBound=.1*budget;
  const numerator=second[0]*width[0]**2+2*second[1]*width[0]*width[1]+second[2]*width[1]**2;
  const divisions=Math.max(1,Math.ceil(Math.sqrt(numerator/(8*.7*budget))));
  check(Number.isFinite(lipschitz)&&lipschitz>0&&Number.isFinite(divisions)&&divisions<=256,'rational-face-subdivision-budget');
  const cuts=s.domain.map((d:number[],axis:number)=>({axis,parameters:[...new Set<number>([
    ...Array.from({length:divisions+1},(_,i)=>i===divisions?d[1]:d[0]+(d[1]-d[0])*i/divisions),...bounds.breaks[axis]])].sort((a,b)=>a-b)}));
  const {uv,triangles:initial,boundaryEdges,mergeEpsilon,holeCount}=triangulateTrimGrid(ir,faceIndex,trimBound/lipschitz,cuts);
  const normal=(p:number[])=>{const [du,dv]=bounds.tangent(p),n=cross(du,dv),length=Math.hypot(...n);
    check(length>1e-12,'singular-rational-face-normal');return n.map(x=>x/length*(face.reversed?-1:1));};
  const refined=refineSurfaceWinding(uv,initial,boundaryEdges,s.domain,p=>evaluateSurface(s,p),normal);
  const {positions,normals,triangles}=refined,interpolationBound=numerator/(8*divisions**2),parameterMergeBound=mergeEpsilon*lipschitz;
  const quantization=Math.max(...positions.map(p=>Math.hypot(...p.map(x=>Math.fround(x)-x))));
  const physicalBoundMm=(trimBound+interpolationBound+parameterMergeBound+quantization)*metersPerUnit*1000;
  check(physicalBoundMm<=.01,'rational-face-physical-budget');
  return {face:faceIndex,geometrySource:s.rational?'cad-ir-rational-bezier-chain':'cad-ir-polynomial-bezier-chain',boundaryEdges,
    mesh:{positions,triangles,normals,textureCoordinates:[],sourceFaceCount:triangles.length,quadCount:0},
    audit:{physicalBudgetMm:.01,physicalBoundMm,trimBound,interpolationBound,parameterMergeBound,quantization,
      derivativeBounds:{first,second},patches:bounds.patches,divisions,holeCount,uv,domain:s.domain,
      windingRefinement:{inserted:refined.inserted,passes:refined.passes},precisionSpace:'source-local-physical-before-instance-transform'}};
}
