import {triangulateLocalPlane} from './3dm-local-plane-triangulation.mts';
const key=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`;
function check(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
/** Bounded boundary cavity. Never crosses another source trim or drops an old vertex. */
export function refineLocalPlanePatch(part:any,uv:number[][],a:number,b:number,chain:number[],seed:number,currentTrim?:number,currentBoundary?:number[]){
  const mesh=part.mesh,selected=new Set([seed]),protectedEdges=new Set<string>();
  for(const edge of part.boundaryEdges){const vertices=edge.trim===currentTrim&&currentBoundary?currentBoundary:edge.vertices;
    for(let j=1;j<vertices.length;j++)protectedEdges.add(key(vertices[j-1],vertices[j]));}
  const owners=new Map<string,number[]>();mesh.triangles.forEach((t:number[],i:number)=>{for(let j=0;j<3;j++){const k=key(t[j],t[(j+1)%3]);owners.set(k,[...(owners.get(k)??[]),i]);}});
  check([...owners.values()].every(indices=>indices.length<=2),'nonmanifold-local-plane-source');
  for(let pass=0;pass<5;pass++){
    check(selected.size<=64,'local-plane-cavity-budget');const edges=new Map<string,{a:number,b:number,count:number}>(),oldVertices=new Set<number>();
    for(const i of selected){const t=mesh.triangles[i];for(let j=0;j<3;j++){oldVertices.add(t[j]);const k=key(t[j],t[(j+1)%3]),e=edges.get(k);if(e)e.count++;else edges.set(k,{a:t[j],b:t[(j+1)%3],count:1});}}
    const boundary=[...edges.values()].filter(e=>e.count===1),next=new Map<number,number>();
    for(const e of boundary){check(!next.has(e.a),'branched-local-plane-cavity');next.set(e.a,e.b);}
    const polygon:number[]=[];let cursor=a;
    do{check(next.has(cursor)&&polygon.length<=boundary.length+chain.length,'open-local-plane-cavity');const end=next.get(cursor)!;
      if(key(cursor,end)===key(a,b))polygon.push(...(cursor===a?chain:[...chain].reverse()).slice(0,-1));else polygon.push(cursor);
      cursor=end;
    }while(cursor!==a);
    check(oldVertices.size<256&&[...oldVertices].every(i=>polygon.includes(i)),'local-plane-interior-vertex');
    try{const triangles=triangulateLocalPlane(uv,polygon.slice(0,-1),polygon.at(-1)!);return {removed:[...selected].sort((x,y)=>y-x),triangles,passes:pass+1};}catch(error){
      if(!(error instanceof Error)||!['self-intersecting-local-plane-polygon','outside-local-plane-triangle','incomplete-local-plane-triangulation','missing-local-plane-boundary'].includes(error.message))throw error;
    }
    const additions=boundary.flatMap(e=>protectedEdges.has(key(e.a,e.b))?[]:(owners.get(key(e.a,e.b))??[]).filter(i=>!selected.has(i)));
    check(additions.length>0,'local-plane-cavity-source-boundary');for(const i of additions)selected.add(i);
  }
  throw Error('local-plane-cavity-budget');
}
