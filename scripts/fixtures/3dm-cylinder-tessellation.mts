import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { trimPolyline } from './3dm-trim-polyline.mts';
import { requireNaturalBoundary } from './3dm-natural-boundary.mts';
import { naturalBoundaryEdges } from './3dm-natural-boundary-edges.mts';
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const dot=(a:number[],b:number[])=>a.reduce((sum,x,i)=>sum+x*b[i],0);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function check(value:unknown,message:string):asserts value { if(!value) throw new Error(message); }
/** Natural rectangular strips of exact translated, positive-weight NURBS cylinders. */
export function tessellateCylinderFace(ir:any,faceIndex:number,chordTolerance=0.01,additionalParameters:number[]=[]) {
  const face=ir.faces[faceIndex],surface=ir.surfaces[face?.surface],support=surface?.analyticSupport;
  check(support?.kind==='cylinder'&&Number.isFinite(support.radius)&&support.radius>0
    &&[support.center,support.axis].every(a=>a?.length===3&&a.every(Number.isFinite))
    &&Math.abs(Math.hypot(...support.axis)-1)<1e-10,'unsupported-cylinder-support');
  check(Number.isFinite(chordTolerance)&&chordTolerance>0&&chordTolerance<support.radius,'invalid-cylinder-tolerance');
  check(surface.parameterMap?.kind==='identity','unsupported-cylinder-parameter-map');
  const linear=surface.degree.findIndex((degree:number,axis:number)=>degree===1&&surface.controlPointCount[axis]===2),curved=1-linear;
  check(linear>=0&&surface.degree[curved]===2,'unsupported-cylinder-nurbs');
  const domain=requireNaturalBoundary(ir,face,surface,true);
  const count=surface.controlPointCount[curved],width=surface.controlPointCount[0];
  const cv=(row:number,i:number)=>surface.controlPoints[linear===1?row*width+i:i*width+row];
  const decode=(p:number[])=>p.slice(0,3).map(x=>x/(surface.rational?p[3]:1));
  const translation=sub(decode(cv(1,0)),decode(cv(0,0)));
  check(Math.hypot(...translation)>1e-10,'singular-cylinder-height');
  check(Math.hypot(...cross(translation,support.axis))<1e-9,'cylinder-axis-mismatch');
  for(let i=0;i<count;i++) {
    check(Math.hypot(...sub(sub(decode(cv(1,i)),decode(cv(0,i))),translation))<1e-9
      &&(!surface.rational||Math.abs(cv(0,i)[3]-cv(1,i)[3])<1e-12),'non-translated-cylinder-control-net');
  }
  const curve={dimension:3,degree:surface.degree[curved],rational:surface.rational,knots:surface.knots[curved],
    controlPoints:Array.from({length:count},(_,i)=>cv(0,i)),parameterMap:{kind:'identity'}};
  const polyline=trimPolyline(curve,domain[curved],false,chordTolerance);
  const closed=Boolean(surface.closed[curved])&&domain[curved].every((x:number,i:number)=>x===surface.domain[curved][i]);
  check(additionalParameters.length<=2048&&additionalParameters.every(t=>Number.isFinite(t)&&t>=domain[curved][0]&&t<=domain[curved][1]),'invalid-cylinder-boundary-parameters');
  const merged=[...polyline.parameters,...additionalParameters].sort((a,b)=>a-b).filter((t,i,a)=>!i||t-a[i-1]>1e-12);
  check(merged.length<=2048,'cylinder-boundary-budget');
  const parameters=closed?merged.slice(0,-1):merged;
  if(closed) check(Math.hypot(...sub(polyline.points[0],polyline.points.at(-1)!))<1e-9,'open-cylinder-seam');
  check(parameters.length>=3,'insufficient-cylinder-segments');
  const at=(t:number,row:number)=>domain.map((d:number[],axis:number)=>axis===curved?t:d[row]);
  const positions:number[][]=[],normals:number[][]=[]; let maxSupportResidual=0;
  const radial=(p:number[])=>{const delta=sub(p,support.center),height=dot(delta,support.axis);return delta.map((x,i)=>x-height*support.axis[i]);};
  const t=(domain[curved][0]+domain[curved][1])/2,dt=(domain[curved][1]-domain[curved][0])*1e-5;
  const p=evaluateSurface(surface,at(t,0)),d=sub(evaluateSurface(surface,at(t+dt,0)),p);
  const sourceOrientation=Math.sign(dot(cross(d,translation),radial(p)))*(curved===0?1:-1);
  check(sourceOrientation!==0,'singular-cylinder-orientation');
  const sign=sourceOrientation*(face.reversed?-1:1);
  for(let row=0;row<2;row++) for(const parameter of parameters) {
    const point=evaluateSurface(surface,at(parameter,row)),r=radial(point),radius=Math.hypot(...r);
    maxSupportResidual=Math.max(maxSupportResidual,Math.abs(radius-support.radius));
    check(Math.abs(radius-support.radius)<1e-8,'cylinder-support-mismatch');
    positions.push(point); normals.push(r.map(x=>sign*x/radius));
  }
  const n=parameters.length,triangles:number[][]=[];
  for(let i=0;i<(closed?n:n-1);i++) {
    const next=(i+1)%n;
    for(const triangle of [[i,i+n,next],[next,i+n,next+n]]) {
      const [a,b,c]=triangle.map(index=>positions[index]);
      if(dot(cross(sub(b,a),sub(c,a)),normals[triangle[0]])<0) [triangle[1],triangle[2]]=[triangle[2],triangle[1]];
      triangles.push(triangle);
    }
  }
  return {face:faceIndex,geometrySource:'cad-ir-natural-cylinder',boundaryEdges:naturalBoundaryEdges(ir,face,domain,curved,parameters,closed),mesh:{positions,triangles,normals,textureCoordinates:[],sourceFaceCount:triangles.length,quadCount:0},
    audit:{chordTolerance,controlHullBound:polyline.maxBound,maxSupportResidual,closedSeam:closed,sourceOrientation,
      curvedAxis:curved,parameters,domain,translation,height:Math.hypot(...translation)*(domain[linear][1]-domain[linear][0])/(surface.domain[linear][1]-surface.domain[linear][0])}};
}
