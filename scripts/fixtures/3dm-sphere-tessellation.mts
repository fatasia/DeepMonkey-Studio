import { evaluateCurve, evaluateSurface, mapSurfaceParameter } from './3dm-nurbs-parameters.mjs';
function check(value:unknown,message:string):asserts value { if(!value) throw new Error(message); }
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a:number[],b:number[])=>a.reduce((sum,x,i)=>sum+x*b[i],0);
function requireNaturalBoundary(ir:any,face:any,surface:any) {
  check(face.loops.length===1,'unsupported-sphere-trim');
  const loop=ir.loops[face.loops[0]]; check(loop?.type===1&&loop.trims.length===4,'unsupported-sphere-trim');
  const corners=surface.domain.flatMap((_:any,i:number)=>i?[]:surface.domain[0].flatMap((u:number)=>surface.domain[1].map((v:number)=>[u,v])));
  const ring:number[][]=[];
  for(const ti of loop.trims) {
    const trim=ir.trims[ti],curve=ir.curves2d[trim?.curve2d];
    check(curve?.degree===1&&curve.controlPoints.length===2&&!curve.rational&&curve.parameterMap?.kind==='identity','unsupported-sphere-trim');
    const ends=trim.sourceSubdomain.map((t:number)=>evaluateCurve(curve,t)); if(trim.curveReversed) ends.reverse();
    check(ends.every((p:number[])=>corners.some((q:number[])=>Math.hypot(...sub(p,q))<1e-9)),'unsupported-sphere-trim');
    check(Math.abs(ends[0][0]-ends[1][0])<1e-9||Math.abs(ends[0][1]-ends[1][1])<1e-9,'non-isoparametric-sphere-trim');
    if(ring.length) check(Math.hypot(...sub(ring.at(-1)!,ends[0]))<1e-9,'open-sphere-trim');
    ring.push(...ends);
  }
  check(Math.hypot(...sub(ring[0],ring.at(-1)!))<1e-9,'open-sphere-trim');
  check(corners.every((q:number[])=>ring.some(p=>Math.hypot(...sub(p,q))<1e-9)),'incomplete-sphere-domain');
}
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
