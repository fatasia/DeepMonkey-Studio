import { evaluateSurface, mapCurveParameter, mapSurfaceParameter } from './3dm-nurbs-parameters.mjs';
import { trimPolyline } from './3dm-trim-polyline.mts';
import { requireNaturalBoundary } from './3dm-natural-boundary.mts';
import { naturalBoundaryEdges } from './3dm-natural-boundary-edges.mts';
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const dot=(a:number[],b:number[])=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function check(value:unknown,message:string):asserts value {if(!value) throw new Error(message);}
/** Rectangular, positive-weight homothetic cone frusta. Apex and irregular trims remain unsupported. */
export function tessellateConeFace(ir:any,faceIndex:number,chordTolerance=0.01) {
  const face=ir.faces[faceIndex],surface=ir.surfaces[face?.surface],support=surface?.analyticSupport;
  check(support?.kind==='cone'&&Number.isFinite(support.slope)&&Math.abs(support.slope)>1e-12
    &&[support.apex,support.axis].every(a=>a?.length===3&&a.every(Number.isFinite))
    &&Math.abs(Math.hypot(...support.axis)-1)<1e-10,'unsupported-cone-support');
  check(Number.isFinite(chordTolerance)&&chordTolerance>0,'invalid-cone-tolerance');
  const linear=surface.degree.findIndex((d:number,a:number)=>d===1&&surface.controlPointCount[a]===2),curved=1-linear;
  check(linear>=0&&surface.degree[curved]===2,'unsupported-cone-nurbs');
  const maps=surface.parameterMap?.kind==='identity'?[surface.parameterMap,surface.parameterMap]:surface.parameterMap?.axes;
  check(maps?.length===2&&maps[linear]?.kind==='identity'&&['identity','arc-angle'].includes(maps[curved]?.kind),'unsupported-cone-parameter-map');
  const domain=requireNaturalBoundary(ir,face,surface,true),width=surface.controlPointCount[0],count=surface.controlPointCount[curved];
  const cv=(row:number,i:number)=>surface.controlPoints[linear===1?row*width+i:i*width+row];
  const decode=(p:number[])=>p.slice(0,3).map(x=>x/(surface.rational?p[3]:1));
  const heights=[0,1].map(row=>dot(sub(decode(cv(row,0)),support.apex),support.axis));
  check(heights[0]*heights[1]>1e-16&&Math.abs(heights[1]-heights[0])>1e-10,'unsupported-cone-apex');
  const scale=heights[1]/heights[0];
  for(let i=0;i<count;i++) {
    const a=sub(decode(cv(0,i)),support.apex),b=sub(decode(cv(1,i)),support.apex);
    check(Math.hypot(...sub(b,a.map(x=>x*scale)))<1e-8
      &&Math.abs(dot(a,support.axis)-heights[0])<1e-8
      &&(!surface.rational||Math.abs(cv(0,i)[3]-cv(1,i)[3])<1e-12),'non-homothetic-cone-control-net');
  }
  // The larger full row bounds every trimmed intermediate row by homothety.
  const outer=Math.abs(heights[1])>Math.abs(heights[0])?1:0;
  const curve={dimension:3,degree:2,rational:surface.rational,knots:surface.knots[curved],
    controlPoints:Array.from({length:count},(_,i)=>cv(outer,i)),parameterMap:{kind:'identity'}};
  const mappedDomain=domain[curved].map((t:number)=>mapCurveParameter(maps[curved],t,surface.domain[curved]));
  const polyline=trimPolyline(curve,mappedDomain,false,chordTolerance);
  const inverse=(t:number)=>{
    if(maps[curved].kind==='identity') return t;
    let [lo,hi]=domain[curved];
    if(t===mappedDomain[0]) return lo;if(t===mappedDomain[1]) return hi;
    for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(mapCurveParameter(maps[curved],mid,surface.domain[curved])<t)lo=mid;else hi=mid;}
    return (lo+hi)/2;
  };
  const closed=Boolean(surface.closed[curved])&&domain[curved].every((x:number,i:number)=>x===surface.domain[curved][i]);
  if(closed) check(Math.hypot(...sub(polyline.points[0],polyline.points.at(-1)!))<1e-8,'open-cone-seam');
  const parameters=(closed?polyline.parameters.slice(0,-1):polyline.parameters).map(inverse);
  check(parameters.length>=(closed?3:2),'insufficient-cone-segments');
  const at=(t:number,row:number)=>mapSurfaceParameter(surface,domain.map((d:number[],a:number)=>a===curved?t:d[row]));
  const normal=(p:number[])=>{const delta=sub(p,support.apex),h=dot(delta,support.axis),r=delta.map((x,i)=>x-h*support.axis[i]);
    const radius=Math.hypot(...r);check(radius>1e-10,'unsupported-cone-apex');
    const n=r.map((x,i)=>x/radius-Math.sign(h)*Math.abs(support.slope)*support.axis[i]);return n.map(x=>x/Math.hypot(...n));};
  const t=(domain[curved][0]+domain[curved][1])/2,dt=(domain[curved][1]-domain[curved][0])*1e-5;
  const p=evaluateSurface(surface,at(t,0)),d=sub(evaluateSurface(surface,at(t+dt,0)),p),along=sub(evaluateSurface(surface,at(t,1)),p);
  const sourceOrientation=Math.sign(dot(cross(d,along),normal(p)))*(curved===0?1:-1);
  check(sourceOrientation!==0,'singular-cone-orientation');
  const sign=sourceOrientation*(face.reversed?-1:1),positions:number[][]=[],normals:number[][]=[];let maxSupportResidual=0;
  for(let row=0;row<2;row++)for(const parameter of parameters){
    const point=evaluateSurface(surface,at(parameter,row)),delta=sub(point,support.apex),h=dot(delta,support.axis);
    const residual=Math.abs(Math.hypot(...delta.map((x,i)=>x-h*support.axis[i]))-Math.abs(h*support.slope));
    maxSupportResidual=Math.max(maxSupportResidual,residual);check(residual<1e-7,'cone-support-mismatch');
    positions.push(point);normals.push(normal(point).map(x=>x*sign));
  }
  const n=parameters.length,triangles:number[][]=[];
  for(let i=0;i<(closed?n:n-1);i++){const next=(i+1)%n;
    for(const triangle of [[i,i+n,next],[next,i+n,next+n]]){const [a,b,c]=triangle.map(j=>positions[j]);
      if(dot(cross(sub(b,a),sub(c,a)),normals[triangle[0]])<0)[triangle[1],triangle[2]]=[triangle[2],triangle[1]];
      triangles.push(triangle);
    }
  }
  return {face:faceIndex,geometrySource:'cad-ir-natural-cone',boundaryEdges:naturalBoundaryEdges(ir,face,domain,curved,parameters,closed),mesh:{positions,triangles,normals,textureCoordinates:[],sourceFaceCount:triangles.length,quadCount:0},
    audit:{chordTolerance,controlHullBound:polyline.maxBound,maxSupportResidual,closedSeam:closed,sourceOrientation,curvedAxis:curved,parameters,domain,heights}};
}
