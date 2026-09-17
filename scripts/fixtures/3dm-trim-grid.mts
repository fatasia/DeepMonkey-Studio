import { tessellatePlanarFace } from './3dm-planar-trim.mts';
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const dot=(a:number[],b:number[])=>a.reduce((s,x,i)=>s+x*b[i],0);
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
function clip(polygon:number[][],axis:number,bound:number,above:boolean) {
  const result:number[][]=[];
  for(let i=0;i<polygon.length;i++) {
    const a=polygon[i],b=polygon[(i+1)%polygon.length],ain=above?a[axis]>=bound:a[axis]<=bound,bin=above?b[axis]>=bound:b[axis]<=bound;
    if(ain)result.push(a);
    if(ain!==bin){const [lo,hi]=a[axis]<b[axis]?[a,b]:[b,a],t=(bound-lo[axis])/(hi[axis]-lo[axis]);
      const p=lo.map((x,j)=>x+t*(hi[j]-x));p[axis]=bound;result.push(p);}
  }
  return result.filter((p,i)=>!i||Math.hypot(...sub(p,result[i-1]))>1e-12);
}
/** Parameter-space clipping only: consumers must evaluate all positions on their original source surface. */
export function triangulateTrimGrid(ir:any,faceIndex:number,trimTolerance:number,cuts:{axis:number,parameters:number[]}[]) {
  const face=ir.faces[faceIndex],s=ir.surfaces[face.surface],[u,v]=s.domain;
  const chart={dimension:3,degree:[1,1],controlPointCount:[2,2],rational:false,parameterMap:{kind:'identity'},domain:s.domain,
    knots:[[u[0],u[0],u[1],u[1]],[v[0],v[0],v[1],v[1]]],controlPoints:[[u[0],v[0],0],[u[1],v[0],0],[u[0],v[1],0],[u[1],v[1],0]]};
  const uvPart=tessellatePlanarFace({...ir,surfaces:ir.surfaces.map((p:any,i:number)=>i===face.surface?chart:p)},faceIndex,new Map(),trimTolerance);
  check(cuts.length>=1&&cuts.length<=2&&new Set(cuts.map(c=>c.axis)).size===cuts.length,'invalid-trim-grid-axes');
  for(const c of cuts)check([0,1].includes(c.axis)&&c.parameters.length>=2&&c.parameters.length<=4096
    &&c.parameters[0]===s.domain[c.axis][0]&&c.parameters.at(-1)===s.domain[c.axis][1]
    &&c.parameters.every((x,i)=>Number.isFinite(x)&&(!i||x>c.parameters[i-1])),'invalid-trim-grid-cuts');
  const uv:number[][]=[],triangles:number[][]=[],index=new Map<string,number[]>(),mergeEpsilon=1e-11;
  const vertex=(p:number[])=>{
    check(p.slice(0,2).every((x,i)=>Number.isFinite(x)&&x>=s.domain[i][0]-1e-9&&x<=s.domain[i][1]+1e-9),'trim-outside-surface-domain');
    const cell=p.slice(0,2).map(x=>Math.floor(x/mergeEpsilon));
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const id of index.get(`${cell[0]+dx}:${cell[1]+dy}`)??[])
      if(Math.hypot(...uv[id].map((x,i)=>x-p[i]))<=mergeEpsilon)return id;
    check(uv.length<100000,'trim-grid-vertex-budget');const id=uv.length,key=cell.join(':');uv.push(p.slice(0,2));
    index.set(key,[...(index.get(key)??[]),id]);return id;
  };
  const partition=(input:number[][],level:number)=>{
    if(level===cuts.length){const ids=input.map(vertex);for(let k=1;k+1<ids.length;k++)
      if(new Set([ids[0],ids[k],ids[k+1]]).size===3)triangles.push([ids[0],ids[k],ids[k+1]]);return;}
    const {axis,parameters}=cuts[level],lo=Math.min(...input.map(p=>p[axis])),hi=Math.max(...input.map(p=>p[axis]));
    for(let j=0;j<parameters.length-1;j++){
      const a=parameters[j],b=parameters[j+1];if(b<=lo||a>=hi)continue;
      const polygon=clip(clip(input,axis,a,true),axis,b,false);if(polygon.length>=3)partition(polygon,level+1);
    }
  };
  for(const t of uvPart.mesh.triangles)partition(t.map(i=>uvPart.mesh.positions[i]),0);
  // Retain collinear author trim junctions that the polygon triangulator may omit.
  for(const sourcePoint of uvPart.mesh.positions){
    const before=uv.length,id=vertex(sourcePoint);if(id<before)continue;let splits=0;
    for(let i=triangles.length-1;i>=0;i--){const t=triangles[i];for(let j=0;j<3;j++){
      const a=uv[t[j]],b=uv[t[(j+1)%3]],d=sub(b,a),length=dot(d,d),q=sub(uv[id],a),f=dot(q,d)/length;
      if(f<=1e-10||f>=1-1e-10||Math.hypot(...q.map((x,k)=>x-f*d[k]))>1e-10)continue;
      const opposite=t[(j+2)%3];triangles[i]=[t[j],id,opposite];triangles.push([id,t[(j+1)%3],opposite]);splits++;break;
    }}check(splits>0,'unmatched-trim-grid-junction');
  }
  check(triangles.length>0&&triangles.length<=200000,'trim-grid-triangle-budget');const count=uv.length;
  const boundaryEdges=uvPart.boundaryEdges.map(edge=>({...edge,vertices:edge.vertices.slice(0,-1).flatMap((id,i)=>{
    const a=uvPart.mesh.positions[id],b=uvPart.mesh.positions[edge.vertices[i+1]],d=sub(b,a),length=dot(d,d);
    return uv.map((p,id)=>({id,t:dot(sub([...p,0],a),d)/length,p})).filter(q=>q.t>=-1e-10&&q.t<1-1e-10
      &&Math.hypot(...q.p.map((x,j)=>x-a[j]-q.t*d[j]))<1e-9).sort((a,b)=>a.t-b.t).map(p=>p.id);
  }).concat(vertex(uvPart.mesh.positions[edge.vertices.at(-1)!]))}));
  check(count===uv.length,'missing-trim-grid-boundary-vertex');
  return {uv,triangles,boundaryEdges,mergeEpsilon,holeCount:uvPart.audit.holeCount};
}
