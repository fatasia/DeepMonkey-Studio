import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { tessellatePlanarFace } from './3dm-planar-trim.mts';
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
    for(let j=1;j<=count;j++)parameters.push(unique[span]+(unique[span+1]-unique[span])*j/count);
    maxFirstDerivative=Math.max(maxFirstDerivative,first/(unique[span+1]-unique[span]));
    maxInterpolationBound=Math.max(maxInterpolationBound,second/(8*count*count));
  }
  return {parameters,translation,maxFirstDerivative,maxInterpolationBound,axisProof};
}
function clip(polygon:number[][],axis:number,bound:number,above:boolean) {
  const result:number[][]=[];
  for(let i=0;i<polygon.length;i++) {
    const a=polygon[i],b=polygon[(i+1)%polygon.length],ain=above?a[axis]>=bound:a[axis]<=bound,
      bin=above?b[axis]>=bound:b[axis]<=bound;
    if(ain)result.push(a);
    if(ain!==bin) {
      // Canonical direction makes the two users of an edge compute the same intersection.
      const [lo,hi]=a[axis]<b[axis]?[a,b]:[b,a],t=(bound-lo[axis])/(hi[axis]-lo[axis]);
      const p=lo.map((x,j)=>x+t*(hi[j]-x));p[axis]=bound;result.push(p);
    }
  }
  return result.filter((p,i)=>!i||Math.hypot(...sub(p,result[i-1]))>1e-12);
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
  const [u,v]=s.domain;
  const chart={dimension:3,degree:[1,1],controlPointCount:[2,2],rational:false,parameterMap:{kind:'identity'},
    domain:s.domain,knots:[[u[0],u[0],u[1],u[1]],[v[0],v[0],v[1],v[1]]],
    controlPoints:[[u[0],v[0],0],[u[1],v[0],0],[u[0],v[1],0],[u[1],v[1],0]]};
  const uvPart=tessellatePlanarFace({...ir,surfaces:ir.surfaces.map((p:any,i:number)=>i===face.surface?chart:p)},faceIndex,
    new Map(),trimBudget/lipschitz);
  const uv:number[][]=[],triangles:number[][]=[],index=new Map<string,number[]>(),mergeEpsilon=1e-11;
  const vertex=(p:number[])=>{
    check(p.slice(0,2).every((x,i)=>Number.isFinite(x)&&x>=s.domain[i][0]-1e-9&&x<=s.domain[i][1]+1e-9),'trim-outside-surface-domain');
    const cell=p.slice(0,2).map(x=>Math.floor(x/mergeEpsilon));
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const id of index.get(`${cell[0]+dx}:${cell[1]+dy}`)??[])
      if(Math.hypot(...uv[id].map((x,i)=>x-p[i]))<=mergeEpsilon)return id;
    check(uv.length<100000,'cylinder-trim-vertex-budget');const id=uv.length,key=cell.join(':');uv.push(p.slice(0,2));
    index.set(key,[...(index.get(key)??[]),id]);return id;
  };
  for(const triangle of uvPart.mesh.triangles) {
    const input=triangle.map(i=>uvPart.mesh.positions[i]),lo=Math.min(...input.map(p=>p[curved])),hi=Math.max(...input.map(p=>p[curved]));
    for(let j=0;j<strips.parameters.length-1;j++) {
      const a=strips.parameters[j],b=strips.parameters[j+1];if(b<=lo||a>=hi)continue;
      const polygon=clip(clip(input,curved,a,true),curved,b,false),ids=polygon.map(vertex);
      for(let k=1;k+1<ids.length;k++)if(new Set([ids[0],ids[k],ids[k+1]]).size===3)triangles.push([ids[0],ids[k],ids[k+1]]);
    }
  }
  // Earcut may omit collinear source trim junctions. Restore them on shared edges before export.
  for(const sourcePoint of uvPart.mesh.positions) {
    const before=uv.length,id=vertex(sourcePoint);if(id<before)continue;
    let splits=0;
    for(let i=triangles.length-1;i>=0;i--) {
      const t=triangles[i];
      for(let j=0;j<3;j++) {
        const a=uv[t[j]],b=uv[t[(j+1)%3]],d=sub(b,a),length=dot(d,d),q=sub(uv[id],a),f=dot(q,d)/length;
        if(f<=1e-10||f>=1-1e-10||Math.hypot(...q.map((x,k)=>x-f*d[k]))>1e-10)continue;
        const opposite=t[(j+2)%3];triangles[i]=[t[j],id,opposite];triangles.push([id,t[(j+1)%3],opposite]);splits++;break;
      }
    }
    check(splits>0,'unmatched-cylinder-trim-junction');
  }
  check(triangles.length>0&&triangles.length<=200000,'cylinder-trim-triangle-budget');
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
  const boundaryEdges=uvPart.boundaryEdges.map(edge=>({...edge,vertices:edge.vertices.slice(0,-1).flatMap((id,i)=>{
    const a=uvPart.mesh.positions[id],b=uvPart.mesh.positions[edge.vertices[i+1]],d=sub(b,a),length=dot(d,d);
    const points=uv.map((p,id)=>({id,t:dot(sub([...p,0],a),d)/length,p})).filter(q=>q.t>=-1e-10&&q.t<1-1e-10
      &&Math.hypot(...q.p.map((x,j)=>x-a[j]-q.t*d[j]))<1e-9).sort((a,b)=>a.t-b.t);
    return points.map(p=>p.id);
  }).concat(vertex(uvPart.mesh.positions[edge.vertices.at(-1)!]))}));
  check(positions.length===uv.length,'missing-cylinder-boundary-vertex');
  return {face:faceIndex,geometrySource:'cad-ir-trimmed-cylinder',boundaryEdges,
    mesh:{positions,triangles,normals,textureCoordinates:[],sourceFaceCount:triangles.length,quadCount:0},
    audit:{physicalBudgetMm:.01,physicalBoundMm:physicalBound,trimBound:trimBudget,interpolationBound:strips.maxInterpolationBound,
      quantization,parameterMergeBound,maxSupportResidual,curvedAxis:curved,uv,stripCount:strips.parameters.length-1,holeCount:uvPart.audit.holeCount,
      ...(strips.axisProof?{axisProof:strips.axisProof,axisEquivalenceBudget}:{}),
      domain:s.domain,precisionSpace:'source-local-physical-before-instance-transform'}};
}
