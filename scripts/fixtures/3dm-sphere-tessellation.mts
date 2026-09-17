import { evaluateSurface, mapSurfaceParameter } from './3dm-nurbs-parameters.mjs';
import { requireNaturalBoundary } from './3dm-natural-boundary.mts';
function check(value:unknown,message:string):asserts value { if(!value) throw new Error(message); }
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a:number[],b:number[])=>a.reduce((sum,x,i)=>sum+x*b[i],0);
/** Full natural-boundary spheres only; positions always evaluate the source NURBS form. */
export function tessellateSphereFace(ir:any,faceIndex:number,chordTolerance=0.01) {
  const face=ir.faces[faceIndex],surface=ir.surfaces[face?.surface],support=surface?.analyticSupport;
  check(support?.kind==='sphere'&&Number.isFinite(support.radius)&&support.radius>0
    &&support.center?.length===3&&support.center.every(Number.isFinite),'unsupported-analytic-surface');
  check(Number.isFinite(chordTolerance)&&chordTolerance>0&&chordTolerance<support.radius,'invalid-sphere-tolerance');
  const axes=surface.parameterMap?.axes;
  check(surface.parameterMap?.kind==='separable'&&axes?.length===2&&axes.every((a:any)=>a.kind==='arc-angle'),'unsupported-sphere-parameter-map');
  const angularAxis=axes.findIndex((a:any)=>Math.abs(a.angleRadians-2*Math.PI)<1e-12),latitudeAxis=1-angularAxis;
  check(angularAxis>=0&&Math.abs(axes[latitudeAxis].angleRadians-Math.PI)<1e-12,'unsupported-sphere-domain');
  requireNaturalBoundary(ir,face,surface);
  const maxAngle=Math.sqrt(2*chordTolerance/support.radius);
  const around=Math.max(8,Math.ceil(2*Math.PI/maxAngle)),vertical=Math.max(4,Math.ceil(Math.PI/maxAngle));
  check(around*(vertical-1)+2<=300000,'sphere-vertex-budget');
  const parameters=(u:number,v:number)=>surface.domain.map((d:number[],axis:number)=>d[0]+(d[1]-d[0])*(axis===angularAxis?u:v));
  const evaluate=(u:number,v:number)=>evaluateSurface(surface,mapSurfaceParameter(surface,parameters(u,v)));
  const middle=evaluate(.37,.41),du=sub(evaluate(.3701,.41),middle),dv=sub(evaluate(.37,.4101),middle);
  const sourceOrientation=Math.sign(dot(cross(du,dv),sub(middle,support.center)))*(angularAxis===0?1:-1);
  check(sourceOrientation!==0,'singular-sphere-parameter-map');
  const sign=sourceOrientation*(face.reversed?-1:1),positions:number[][]=[],normals:number[][]=[];
  let maxSupportResidual=0;
  const add=(u:number,v:number)=>{
    const p=evaluate(u,v),radial=sub(p,support.center),radius=Math.hypot(...radial);
    maxSupportResidual=Math.max(maxSupportResidual,Math.abs(radius-support.radius));
    check(Math.abs(radius-support.radius)<=Math.max(1e-9,support.radius*1e-10),'sphere-support-mismatch');
    positions.push(p); normals.push(radial.map(x=>x/radius*sign));
  };
  add(0,0);
  for(let j=1;j<vertical;j++) for(let i=0;i<around;i++) add(i/around,j/vertical);
  add(0,1);
  const index=(j:number,i:number)=>j===0?0:j===vertical?positions.length-1:1+(j-1)*around+(i+around)%around;
  const triangles:number[][]=[];
  const append=(a:number,b:number,c:number)=>{
    const n=cross(sub(positions[b],positions[a]),sub(positions[c],positions[a]));
    check(Math.hypot(...n)>1e-20,'degenerate-sphere-triangle');
    if(dot(n,normals[a])<0) [b,c]=[c,b]; triangles.push([a,b,c]);
  };
  for(let i=0;i<around;i++) {
    append(index(0,i),index(1,i),index(1,i+1));
    for(let j=1;j<vertical-1;j++) {
      append(index(j,i),index(j+1,i),index(j,i+1));
      append(index(j,i+1),index(j+1,i),index(j+1,i+1));
    }
    append(index(vertical-1,i),index(vertical,i),index(vertical-1,i+1));
  }
  // Taylor remainder and barycentric variance <= interval²/4 bound pointwise interpolation error.
  // Sphere angular second derivatives have norm <= R, including the mixed derivative.
  const angularErrorBound=support.radius/8*(2*Math.PI/around+Math.PI/vertical)**2;
  check(angularErrorBound<=chordTolerance,'sphere-chord-budget');
  return {face:faceIndex,geometrySource:'cad-ir-natural-sphere',mesh:{positions,triangles,normals,textureCoordinates:[],
    sourceFaceCount:triangles.length,quadCount:0},audit:{chordTolerance,angularErrorBound,maxSupportResidual,
    around,vertical,angularAxis,sourceOrientation,closedSeam:true,weldedPoles:true}};
}
