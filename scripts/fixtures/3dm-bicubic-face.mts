import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { triangulateTrimGrid } from './3dm-trim-grid.mts';
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a:number[],b:number[])=>a.reduce((sum,x,i)=>sum+x*b[i],0);
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
function derivative(s:any,axis:number) {
  const degree=[...s.degree],counts=[...s.controlPointCount],scale=degree[axis]/(s.domain[axis][1]-s.domain[axis][0]);
  degree[axis]--;counts[axis]--;const controlPoints:number[][]=[];
  for(let v=0;v<counts[1];v++)for(let u=0;u<counts[0];u++) {
    const i=v*s.controlPointCount[0]+u,j=i+(axis===0?1:s.controlPointCount[0]);
    controlPoints.push(sub(s.controlPoints[j],s.controlPoints[i]).map(x=>x*scale));
  }
  return {...s,degree,controlPointCount:counts,controlPoints,knots:s.domain.map((d:number[],i:number)=>[...Array(degree[i]+1).fill(d[0]),...Array(degree[i]+1).fill(d[1])])};
}
/** Nonrational single bicubic patch. Convex derivative nets bound the entire trimmed parameter domain. */
export function tessellateBicubicFace(ir:any,faceIndex:number,metersPerUnit:number) {
  const face=ir.faces[faceIndex],s=ir.surfaces[face?.surface];
  check(Number.isFinite(metersPerUnit)&&metersPerUnit>0,'missing-bicubic-physical-unit');
  check(s?.dimension===3&&!s.rational&&s.degree?.every((d:number)=>d===3)
    &&s.controlPointCount?.every((n:number)=>n===4)&&s.parameterMap?.kind==='identity','unsupported-single-bicubic');
  check(s.domain?.length===2&&s.domain.every((d:number[])=>d.length===2&&d.every(Number.isFinite)&&d[1]>d[0])
    &&s.knots?.length===2&&s.knots.every((k:number[],axis:number)=>k.length===8&&k.every((x,i)=>x===s.domain[axis][i<4?0:1]))
    &&s.controlPoints?.length===16&&s.controlPoints.every((p:number[])=>p.length===3&&p.every(Number.isFinite)),'invalid-bicubic-control-net');
  const du=derivative(s,0),dv=derivative(s,1),duu=derivative(du,0),duv=derivative(du,1),dvv=derivative(dv,1);
  const bound=(net:any)=>Math.max(...net.controlPoints.map((p:number[])=>Math.hypot(...p)));
  const first=[bound(du),bound(dv)],second=[bound(duu),bound(duv),bound(dvv)],width=s.domain.map((d:number[])=>d[1]-d[0]);
  const lipschitz=first[0]+first[1],budget=.00001/metersPerUnit,trimBound=.1*budget;
  const numerator=second[0]*width[0]**2+2*second[1]*width[0]*width[1]+second[2]*width[1]**2;
  const divisions=Math.max(1,Math.ceil(Math.sqrt(numerator/(8*.7*budget))));
  check(Number.isFinite(lipschitz)&&lipschitz>0&&Number.isFinite(divisions)&&divisions<=256,'bicubic-subdivision-budget');
  const cuts=s.domain.map((d:number[],axis:number)=>({axis,parameters:Array.from({length:divisions+1},(_,i)=>i===divisions?d[1]:d[0]+(d[1]-d[0])*i/divisions)}));
  const {uv,triangles,boundaryEdges,mergeEpsilon,holeCount}=triangulateTrimGrid(ir,faceIndex,trimBound/lipschitz,cuts);
  const positions=uv.map(p=>evaluateSurface(s,p)),normals=uv.map(p=>{
    const normal=cross(evaluateSurface(du,p),evaluateSurface(dv,p)),length=Math.hypot(...normal);
    check(length>1e-12,'singular-bicubic-normal');return normal.map(x=>x/length*(face.reversed?-1:1));
  });
  for(const t of triangles){const [a,b,c]=t.map(i=>positions[i]),normal=cross(sub(b,a),sub(c,a));
    check(Math.hypot(...normal)>1e-14&&dot(normal,normals[t[0]])>0,'inverted-bicubic-triangle');}
  const interpolationBound=numerator/(8*divisions**2),parameterMergeBound=mergeEpsilon*lipschitz;
  const quantization=Math.max(...positions.map(p=>Math.hypot(...p.map(x=>Math.fround(x)-x))));
  const physicalBoundMm=(trimBound+interpolationBound+parameterMergeBound+quantization)*metersPerUnit*1000;
  check(physicalBoundMm<=.01,'bicubic-physical-budget');
  return {face:faceIndex,geometrySource:'cad-ir-single-bicubic',boundaryEdges,
    mesh:{positions,triangles,normals,textureCoordinates:[],sourceFaceCount:triangles.length,quadCount:0},
    audit:{physicalBudgetMm:.01,physicalBoundMm,trimBound,interpolationBound,parameterMergeBound,quantization,
      derivativeBounds:{first,second},divisions,holeCount,uv,domain:s.domain,precisionSpace:'source-local-physical-before-instance-transform'}};
}
