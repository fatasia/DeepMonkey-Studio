import { createRequire } from 'node:module';
import { evaluateSurface } from './3dm-nurbs-parameters.mjs';
import { trimPolyline } from './3dm-trim-polyline.mts';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { ShapeUtils, Vector2 } = require('three');
const EPS = 1e-9;
const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
const length = (a: number[]) => Math.hypot(...a);
const cross = (a: number[], b: number[]) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const orient = (a: number[], b: number[], c: number[]) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export const polygonArea = (ring: number[][]) => ring.reduce((sum, p, i) => {
  const q = ring[(i+1)%ring.length]; return sum+p[0]*q[1]-q[0]*p[1];
}, 0)/2;
export function insideRing(point: number[], ring: number[][]) {
  let inside = false;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[j],b=ring[i];
    if ((a[1]>point[1]) !== (b[1]>point[1]) && point[0] < (b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
  }
  return inside;
}
function touches(a: number[], b: number[], c: number[], d: number[]) {
  const o=[orient(a,b,c),orient(a,b,d),orient(c,d,a),orient(c,d,b)];
  return Math.min(a[0],b[0])<=Math.max(c[0],d[0])+EPS && Math.min(c[0],d[0])<=Math.max(a[0],b[0])+EPS
    && Math.min(a[1],b[1])<=Math.max(c[1],d[1])+EPS && Math.min(c[1],d[1])<=Math.max(a[1],b[1])+EPS
    && o[0]*o[1]<=EPS*EPS && o[2]*o[3]<=EPS*EPS;
}
export function validatePlanarRings(rings: number[][][]) {
  check(rings.flat().length<=2048, 'trim-vertex-budget');
  for(let r=0;r<rings.length;r++) {
    const ring=rings[r]; check(ring.length>=3 && Math.abs(polygonArea(ring))>EPS, 'degenerate-trim-loop');
    for(let i=0;i<ring.length;i++) for(let s=r;s<rings.length;s++) for(let j=0;j<rings[s].length;j++) {
      if(r===s && (j<=i || j===i+1 || (i===0 && j===ring.length-1))) continue;
      check(!touches(ring[i],ring[(i+1)%ring.length],rings[s][j],rings[s][(j+1)%rings[s].length]), 'intersecting-trim-loops');
    }
    if(r) {
      check(insideRing(ring[0],rings[0]), 'hole-outside-outer-loop');
      for(let s=1;s<r;s++) check(!insideRing(ring[0],rings[s]) && !insideRing(rings[s][0],ring), 'nested-trim-holes');
    }
  }
}
function trimLoop(ir: any, loop: any, tolerance: number, overrides:Map<number,number[][]>) {
  check(loop && Array.isArray(loop.trims) && loop.trims.length>=1 && loop.trims.length<=2048, 'unsupported-trim-loop');
  const ring: number[][]=[];
  const boundaries:{edge:number,trim:number,vertices:number[],parameters?:number[]}[]=[];
  let previous: number[] | undefined;
  for(const index of loop.trims) {
    const trim=ir.trims[index], curve=ir.curves2d[trim?.curve2d];
    const parsed=overrides.has(index)?null:trimPolyline(curve,trim.sourceSubdomain,Boolean(trim.curveReversed),tolerance);
    const polyline=overrides.get(index)??parsed!.points;
    const ends=[polyline[0],polyline.at(-1)!];
    check(ends.flat().every(Number.isFinite), 'nonfinite-trim');
    if(previous) check(length(sub(previous,ends[0]))<=EPS, 'open-trim-loop');
    check(polyline.length>2 || length(sub(ends[0],ends[1]))>EPS, 'degenerate-trim-edge');
    boundaries.push({edge:trim.edge,trim:index,vertices:polyline.map((_:number[],i:number)=>ring.length+i),...(parsed?{parameters:parsed.parameters}:{})});
    ring.push(...polyline.slice(0,-1)); previous=ends[1];
  }
  check(length(sub(previous!,ring[0]))<=EPS, 'open-trim-loop');
  for(const boundary of boundaries) boundary.vertices=boundary.vertices.map(i=>i%ring.length);
  return {ring,boundaries};
}
/** Affine planes with positive-weight NURBS trims, under an explicit source-unit chord budget. */
export function tessellatePlanarFace(ir: any, faceIndex: number, overrides=new Map<number,number[][]>(), trimChordTolerance=0.001) {
  check(Number.isFinite(trimChordTolerance)&&trimChordTolerance>0,'invalid-trim-tolerance');
  const face=ir.faces[faceIndex], surface=ir.surfaces[face?.surface];
  check(surface?.degree?.every((d: number)=>d===1) && surface.controlPointCount?.every((n: number)=>n===2)
    && !surface.rational && surface.parameterMap?.kind==='identity', 'unsupported-trimmed-surface');
  const cp=surface.controlPoints;
  check(cp.length===4 && cp.every((p: any)=>p.length===3 && p.every(Number.isFinite)), 'invalid-plane-control-points');
  const u=sub(cp[1],cp[0]),v=sub(cp[2],cp[0]),normal=cross(u,v),normalLength=length(normal);
  check(normalLength>EPS, 'singular-plane');
  const affineError=length(cp[3].map((x: number,i: number)=>x-cp[1][i]-cp[2][i]+cp[0][i]));
  check(affineError<=EPS, 'non-affine-bilinear-surface');
  check(face.loops.length>0 && face.loops.length<=128, 'trim-loop-budget');
  const loops=face.loops.map((i: number)=>ir.loops[i]);
  check(loops.filter((l: any)=>l?.type===1).length===1 && loops.every((l: any)=>[1,2].includes(l?.type)), 'unsupported-trim-loop-type');
  check(loops.reduce((count: number,l: any)=>count+(l.trims?.length??2049),0)<=2048, 'trim-vertex-budget');
  loops.sort((a: any,b: any)=>a.type-b.type);
  const uvToSourceBound=length(u)/(surface.domain[0][1]-surface.domain[0][0])+length(v)/(surface.domain[1][1]-surface.domain[1][0]);
  const parsed=loops.map((loop: any)=>trimLoop(ir,loop,trimChordTolerance/uvToSourceBound,overrides)),rings=parsed.map(p=>p.ring); validatePlanarRings(rings);
  let offset=0;const boundaryEdges=parsed.flatMap(p=>{const edges=p.boundaries.map(b=>({...b,vertices:b.vertices.map(i=>i+offset)}));offset+=p.ring.length;return edges;});
  const uv: number[][]=rings.flat();
  const positions=uv.map(point=>evaluateSurface(surface,point));
  const triangles: number[][]=ShapeUtils.triangulateShape(rings[0].map((p: number[])=>new Vector2(...p)),
    rings.slice(1).map((ring: number[][])=>ring.map(p=>new Vector2(...p))));
  const targetArea=Math.abs(polygonArea(rings[0]))-rings.slice(1).reduce((sum: number,r: number[][])=>sum+Math.abs(polygonArea(r)),0);
  let triangleArea=0;
  for(const triangle of triangles) {
    const [a,b,c]=triangle.map(i=>uv[i]),area=orient(a,b,c)/2;
    check(Math.abs(area)>EPS, 'degenerate-triangulation'); triangleArea+=Math.abs(area);
    const center=[(a[0]+b[0]+c[0])/3,(a[1]+b[1]+c[1])/3];
    check(insideRing(center,rings[0]) && !rings.slice(1).some((r: number[][])=>insideRing(center,r)), 'triangle-outside-trim');
    for(const [p,q] of [[a,b],[b,c],[c,a]]) for(const ring of rings) for(let i=0;i<ring.length;i++) {
      const r=ring[i],s=ring[(i+1)%ring.length];
      check(!(orient(p,q,r)*orient(p,q,s)<-EPS*EPS && orient(r,s,p)*orient(r,s,q)<-EPS*EPS), 'triangle-crosses-trim');
    }
    if((area<0)!==Boolean(face.reversed)) [triangle[1],triangle[2]]=[triangle[2],triangle[1]];
  }
  check(triangles.length>0 && Math.abs(triangleArea-targetArea)<=EPS*Math.max(1,targetArea), 'trim-area-mismatch');
  const normals=positions.map(()=>normal.map(x=>x/normalLength*(face.reversed?-1:1)));
  return { face: faceIndex, geometrySource: 'cad-ir-affine-plane-trim', boundaryEdges, parameterUv:uv, mesh: { positions, triangles, normals,
    sourceFaceCount: triangles.length, quadCount: 0, textureCoordinates: [] },
    audit: { uvArea: targetArea, triangleUvArea: triangleArea, affineError, trimChordTolerance, loopCount: rings.length,
      holeCount: rings.length-1, sourcePlaneArea: targetArea*normalLength/((surface.domain[0][1]-surface.domain[0][0])*(surface.domain[1][1]-surface.domain[1][0])) } };
}
