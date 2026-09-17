const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a:number[],b:number[])=>a.reduce((sum,x,i)=>sum+x*b[i],0);
const key=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`;
/** Split shared UV edges, never flip a source-oriented triangle to conceal a curved sliver. */
export function refineSurfaceWinding(uv:number[][],initial:number[][],boundaryEdges:any[],domain:number[][],
  position:(p:number[])=>number[],normal:(p:number[])=>number[]) {
  const positions=uv.map(position),normals=uv.map(normal);let triangles=initial,inserted=0;
  for(let pass=0;pass<16;pass++) {
    const split=new Map<string,[number,number]>();
    for(const t of triangles){
      const [a,b,c]=t.map(i=>positions[i]),area=cross(sub(b,a),sub(c,a));
      if(Math.hypot(...area)>1e-14&&t.every(i=>dot(area,normals[i])>0))continue;
      const edges=t.map((a,i)=>[a,t[(i+1)%3]] as [number,number]);
      const length=([a,b]:number[])=>Math.hypot(...uv[a].map((x,i)=>(x-uv[b][i])/(domain[i][1]-domain[i][0])));
      const [edgeA,edgeB]=edges.reduce((best,e)=>length(e)>length(best)?e:best);split.set(key(edgeA,edgeB),[edgeA,edgeB]);
    }
    if(!split.size)return {positions,normals,triangles,inserted,passes:pass};
    if(uv.length+split.size>100000)throw new Error('surface-winding-vertex-budget');
    const mid=new Map<string,number>();
    for(const [edge,[a,b]] of split){const p=uv[a].map((x,i)=>(x+uv[b][i])/2),id=uv.length;
      uv.push(p);positions.push(position(p));normals.push(normal(p));mid.set(edge,id);inserted++;}
    const next:number[][]=[];
    for(const t of triangles){let pieces=[t];
      for(let j=0;j<3;j++){const a=t[j],b=t[(j+1)%3],id=mid.get(key(a,b));if(id===undefined)continue;
        pieces=pieces.flatMap(p=>{for(let i=0;i<3;i++)if(key(p[i],p[(i+1)%3])===key(a,b))
          return [[p[i],id,p[(i+2)%3]],[id,p[(i+1)%3],p[(i+2)%3]]];return [p];});}
      next.push(...pieces);
    }
    if(next.length>200000)throw new Error('surface-winding-triangle-budget');triangles=next;
    for(const boundary of boundaryEdges)boundary.vertices=boundary.vertices.flatMap((a:number,i:number,list:number[])=>{
      const id=i+1<list.length?mid.get(key(a,list[i+1])):undefined;return id===undefined?[a]:[a,id];});
  }
  throw new Error('surface-winding-subdivision-budget');
}
