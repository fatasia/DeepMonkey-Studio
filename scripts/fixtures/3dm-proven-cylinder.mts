import { proveCylinderAxis } from './3dm-cylinder-axis-proof.mts';
import { tessellateTrimmedCylinderFace } from './3dm-cylinder-trim.mts';
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const dot=(a:number[],b:number[])=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
/** Single positive rational quadratic arc, certified by all five squared-radius Bernstein coefficients. */
export function proveCylinderSupport(surface:any) {
  const linear=surface?.degree?.findIndex((d:number)=>d===1),curved=1-linear;
  check(linear>=0&&surface.degree[curved]===2&&surface.rational&&surface.parameterMap?.kind==='identity'
    &&surface.controlPointCount[curved]===3,'unsupported-derived-cylinder');
  const axisProof=proveCylinderAxis(surface,linear),length=Math.hypot(...axisProof.translation);
  check(length>1e-9,'singular-derived-cylinder-axis');const axis=axisProof.translation.map(x=>x/length);
  const knots=surface.knots[curved],domain=surface.domain[curved];
  check(knots.length===6&&knots.slice(0,3).every((k:number)=>k===domain[0])
    &&knots.slice(3).every((k:number)=>k===domain[1])&&domain[1]>domain[0],'unsupported-derived-cylinder-knots');
  const control=[0,1,2].map(i=>surface.controlPoints[linear===1?i:i*surface.controlPointCount[0]] as number[]);
  const weights=control.map(p=>p[3]);check(weights.every(w=>Number.isFinite(w)&&w>0),'invalid-derived-cylinder-weights');
  const points=control.map((p,i)=>p.slice(0,3).map(x=>x/weights[i]));
  const middle=[0,1,2].map(j=>(control[0][j]+2*control[1][j]+control[2][j])/(weights[0]+2*weights[1]+weights[2]));
  const b=sub(middle,points[0]),c=sub(points[2],points[0]),normal=cross(b,c),denominator=2*dot(normal,normal);
  check(denominator>1e-20,'singular-derived-cylinder-circle');
  const x=cross(c,normal),y=cross(normal,b),center=points[0].map((v,i)=>v+(dot(b,b)*x[i]+dot(c,c)*y[i])/denominator);
  const radius=Math.hypot(...sub(points[0],center));check(Number.isFinite(radius)&&radius>1e-9,'invalid-derived-cylinder-radius');
  const planeBound=Math.max(...points.map(p=>Math.abs(dot(sub(p,center),axis))));
  check(planeBound<=1e-9,'nonplanar-derived-cylinder-arc');
  const q=control.map((p,i)=>p.slice(0,3).map((v,j)=>v-center[j]*weights[i]));
  const choose2=[1,2,1],choose4=[1,4,6,4,1];
  const coefficients=Array.from({length:5},(_,k)=>{
    let value=0;for(let i=0;i<3;i++){const j=k-i;if(j>=0&&j<3)value+=choose2[i]*choose2[j]/choose4[k]
      *(dot(q[i],q[j])-radius*radius*weights[i]*weights[j]);}return value;
  });
  const arithmeticGuard=128*Number.EPSILON*Math.max(1,radius*radius);
  const radialBound=(Math.max(...coefficients.map(Math.abs))+arithmeticGuard)/(Math.min(...weights)**2*radius);
  check(Number.isFinite(radialBound)&&radialBound<=1e-9,'noncircular-derived-cylinder-arc');
  return {support:{kind:'cylinder',center,axis,radius},proof:{kind:'positive-quadratic-radius-identity',coefficients,
    planeBound,radialBound,axisEquivalenceBound:axisProof.equivalenceBound,sourceAnalyticSupport:surface.analyticSupport??null}};
}
export function tessellateProvenCylinderFace(ir:any,faceIndex:number,metersPerUnit:number) {
  const face=ir.faces[faceIndex],surface=ir.surfaces[face?.surface],derived=proveCylinderSupport(surface);
  const next={...ir,surfaces:ir.surfaces.map((s:any,i:number)=>i===face.surface?{...s,analyticSupport:derived.support}:s)};
  const part=tessellateTrimmedCylinderFace(next,faceIndex,metersPerUnit);
  const derivedAxisBudget=part.audit.axisProof?0:4*derived.proof.axisEquivalenceBound;
  const physicalBoundMm=part.audit.physicalBoundMm+derivedAxisBudget*metersPerUnit*1000;
  check(physicalBoundMm<=.01,'derived-cylinder-physical-budget');
  return {...part,geometrySource:'cad-ir-proven-cylinder',audit:{...part.audit,physicalBoundMm,derivedAxisBudget,derivedSupport:derived}};
}
