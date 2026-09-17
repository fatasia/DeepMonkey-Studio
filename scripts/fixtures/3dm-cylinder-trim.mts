import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { triangulateTrimGrid } from './3dm-trim-grid.mts';
import { proveCylinderAxis } from './3dm-cylinder-axis-proof.mts';
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const dot=(a:number[],b:number[])=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
/** Positive rational quadratic Bézier derivative bounds; coordinates are rebased before bounding. */
function stripParameters(s:any,curved:number,tolerance:number) {
  const linear=1-curved,n=s.controlPointCount[curved],width=s.controlPointCount[0];
  const cv=(row:number,i:number)=>s.controlPoints[linear===1?row*width+i:i*width+row];
  const decode=(p:number[])=>p.slice(0,3).map(x=>x/(s.rational?p[3]:1));
  const axisProof=s.controlPointCount[linear]>2?proveCylinderAxis(s,linear):null;
  const origin=decode(cv(0,0)),translation=axisProof?.translation??sub(decode(cv(1,0)),origin);
  if(!axisProof)for(let i=0;i<n;i++)check(Math.hypot(...sub(sub(decode(cv(1,i)),decode(cv(0,i))),translation))<1e-9
    &&(!s.rational||Math.abs(cv(0,i)[3]-cv(1,i)[3])<1e-12),'non-translated-cylinder-control-net');
  const knots:number[]=s.knots[curved],unique=[...new Set(knots)];
  check(n===2*(unique.length-1)+1&&unique.slice(1,-1).every(k=>knots.filter(t=>t===k).length===2),
    'unsupported-cylinder-bezier-spans');
  const parameters=[unique[0]];let maxFirstDerivative=0,maxInterpolationBound=0;
  for(let span=0;span<unique.length-1;span++) {
    const points=[0,1,2].map(i=>cv(0,span*2+i));
    const weights=points.map(p=>s.rational?p[3]:1);
    check(weights.every(w=>Number.isFinite(w)&&w>0),'invalid-cylinder-weights');
    const a=points.map((p,i)=>sub(decode(p),origin).map(x=>x*weights[i]));
    const w0=Math.min(...weights),r=Math.max(...points.map(p=>Math.hypot(...sub(decode(p),origin))));
    const w1=2*Math.max(Math.abs(weights[1]-weights[0]),Math.abs(weights[2]-weights[1]));
    const w2=2*Math.abs(weights[2]-2*weights[1]+weights[0]);
    const a1=2*Math.max(Math.hypot(...sub(a[1],a[0])),Math.hypot(...sub(a[2],a[1])));
    const a2=2*Math.hypot(...a[2].map((x,i)=>x-2*a[1][i]+a[0][i]));
    const first=(a1+r*w1)/w0,second=(a2+r*w2+2*first*w1)/w0;
    const count=Math.max(1,Math.ceil(Math.sqrt(second/(8*tolerance))));
    check(parameters.length+count<=4096,'cylinder-trim-strip-budget');
    for(let j=1;j<=count;j++)parameters.push(j===count?unique[span+1]:unique[span]+(unique[span+1]-unique[span])*j/count);
    maxFirstDerivative=Math.max(maxFirstDerivative,first/(unique[span+1]-unique[span]));
    maxInterpolationBound=Math.max(maxInterpolationBound,second/(8*count*count));
  }
  return {parameters,translation,maxFirstDerivative,maxInterpolationBound,axisProof};
}
/** An internal UV chart only triangulates trims; every exported position comes from the source surface. */
export function tessellateTrimmedCylinderFace(ir:any,faceIndex:number,metersPerUnit:number) {
  check(Number.isFinite(metersPerUnit)&&metersPerUnit>0,'missing-cylinder-physical-unit');
  const face=ir.faces[faceIndex],s=ir.surfaces[face?.surface],support=s?.analyticSupport;
  check(support?.kind==='cylinder'&&support.radius>0&&Number.isFinite(support.radius)
    &&[support.axis,support.center].every(a=>a?.length===3&&a.every(Number.isFinite))
    &&Math.abs(Math.hypot(...support.axis)-1)<1e-10,'unsupported-cylinder-support');
  check(s.parameterMap?.kind==='identity','unsupported-cylinder-parameter-map');
  const linear=s.degree.findIndex((d:number,i:number)=>d===1&&s.controlPointCount[i]>=2),curved=1-linear;
  check(linear>=0&&s.degree[curved]===2,'unsupported-cylinder-nurbs');
  const budget=0.00001/metersPerUnit,trimBudget=budget*.1,meshBudget=budget*.7;
  const strips=stripParameters(s,curved,meshBudget),height=s.domain[linear][1]-s.domain[linear][0];
  check(height>0&&Math.hypot(...cross(strips.translation,support.axis))<1e-9,'cylinder-axis-mismatch');
  const lipschitz=strips.maxFirstDerivative+Math.hypot(...strips.translation)/height;
  check(Number.isFinite(lipschitz)&&lipschitz>0,'invalid-cylinder-derivative-bound');
  const {uv,triangles,boundaryEdges,mergeEpsilon,holeCount}=triangulateTrimGrid(ir,faceIndex,trimBudget/lipschitz,[{axis:curved,parameters:strips.parameters}]);
  const positions=uv.map(p=>evaluateSurface(s,p)),radial=(p:number[])=>{const d=sub(p,support.center),h=dot(d,support.axis);return d.map((x,i)=>x-h*support.axis[i]);};
  const middle=s.domain.map((d:number[])=>(d[0]+d[1])/2),delta=(s.domain[curved][1]-s.domain[curved][0])*1e-6;
  const p=evaluateSurface(s,middle),next=[...middle];next[curved]+=delta;
  const orientation=Math.sign(dot(cross(sub(evaluateSurface(s,next),p),strips.translation),radial(p)))*(curved===0?1:-1)*(face.reversed?-1:1);
  check(orientation!==0,'singular-cylinder-orientation');
  let maxSupportResidual=0,quantization=0;
  const normals=positions.map(p=>{const r=radial(p),length=Math.hypot(...r);maxSupportResidual=Math.max(maxSupportResidual,Math.abs(length-support.radius));
    quantization=Math.max(quantization,Math.hypot(...p.map(x=>Math.fround(x)-x)));return r.map(x=>orientation*x/length);});
  check(maxSupportResidual<1e-8,'cylinder-support-mismatch');
  const parameterMergeBound=mergeEpsilon*lipschitz;
  const axisEquivalenceBudget=4*(strips.axisProof?.equivalenceBound??0);
  const physicalBound=(trimBudget+strips.maxInterpolationBound+quantization+parameterMergeBound+axisEquivalenceBudget)*metersPerUnit*1000;
  check(physicalBound<=.01,'cylinder-trim-physical-budget');
  for(const t of triangles)if(dot(cross(sub(positions[t[1]],positions[t[0]]),sub(positions[t[2]],positions[t[0]])),normals[t[0]])<0)[t[1],t[2]]=[t[2],t[1]];
  return {face:faceIndex,geometrySource:'cad-ir-trimmed-cylinder',boundaryEdges,
    mesh:{positions,triangles,normals,textureCoordinates:[],sourceFaceCount:triangles.length,quadCount:0},
    audit:{physicalBudgetMm:.01,physicalBoundMm:physicalBound,trimBound:trimBudget,interpolationBound:strips.maxInterpolationBound,
      quantization,parameterMergeBound,maxSupportResidual,curvedAxis:curved,uv,stripCount:strips.parameters.length-1,holeCount,
      ...(strips.axisProof?{axisProof:strips.axisProof,axisEquivalenceBudget}:{}),
      domain:s.domain,precisionSpace:'source-local-physical-before-instance-transform'}};
}
