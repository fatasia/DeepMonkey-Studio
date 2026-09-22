// Closed planar wire profiles from persisted source curves. No bbox coordinates.
const distance = (a,b) => Math.hypot(...a.map((v,i)=>v-b[i]));
export const PROFILE_JOIN_FEET = 1e-7;
export function closeSourceProfile(lines, rejected = []) {
  if (rejected.length || lines.length < 3 || lines.length > 10000) return { status:'incomplete-source-curves' };
  const vertices=[],edges=[],ids=new Set();
  for (const line of lines) {
    if(ids.has(line.element)) return {status:'duplicate-element'};
    ids.add(line.element);
    if(!Array.isArray(line.endpointsFeet)||line.endpointsFeet.length!==2||line.endpointsFeet.some(p=>!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite))) return {status:'invalid-line'};
    const indices=[];
    for(const p of line.endpointsFeet){
      const near=vertices.map((q,i)=>distance(p,q)<=PROFILE_JOIN_FEET?i:-1).filter(i=>i>=0);
      if(near.length>1)return {status:'ambiguous-junction'};
      if(!near.length){indices.push(vertices.length);vertices.push(p);}else indices.push(near[0]);
    }
    if(indices[0]===indices[1])return {status:'zero-length-line'};
    edges.push({vertices:indices,element:line.element});
  }
  const neighbors=vertices.map(()=>[]);
  edges.forEach((edge,i)=>edge.vertices.forEach(v=>neighbors[v].push(i)));
  if(neighbors.some(n=>n.length!==2))return {status:'open-or-branching-profile'};
  const used=new Set(),loops=[];
  for(let first=0;first<edges.length;first++){
    if(used.has(first))continue;
    const start=edges[first].vertices[0],ordered=[],elements=[];let at=start,next=first;
    do{
      if(used.has(next))return {status:'repeated-edge'};
      used.add(next);ordered.push(vertices[at]);elements.push(edges[next].element);
      at=edges[next].vertices.find(v=>v!==at);
      next=neighbors[at].find(e=>!used.has(e));
    }while(at!==start&&next!==undefined);
    if(at!==start||ordered.length<3)return {status:'open-profile'};
    if(ordered.some(p=>Math.abs(p[2]-ordered[0][2])>PROFILE_JOIN_FEET))return {status:'non-horizontal-profile'};
    const area=ordered.reduce((a,p,i)=>{const q=ordered[(i+1)%ordered.length];return a+p[0]*q[1]-q[0]*p[1];},0)/2;
    if(Math.abs(area)<PROFILE_JOIN_FEET**2)return {status:'zero-area-profile'};
    // Crossings invalidate a simple profile, even when every vertex has degree 2.
    const orient=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    for(let i=0;i<ordered.length;i++)for(let j=i+2;j<ordered.length;j++){
      if(i===0&&j===ordered.length-1)continue;
      const a=ordered[i],b=ordered[(i+1)%ordered.length],c=ordered[j],d=ordered[(j+1)%ordered.length];
      if(orient(a,b,c)*orient(a,b,d)<=0&&orient(c,d,a)*orient(c,d,b)<=0
        &&Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0]))<=Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0]))
        &&Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1]))<=Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1])))return {status:'self-intersection'};
    }
    loops.push({verticesFeet:ordered,elements,signedAreaSquareFeet:area});
  }
  return {status:'closed-source-wire',loops,sourceLineCount:lines.length,joinToleranceFeet:PROFILE_JOIN_FEET,
    surfaceOrSolidCertified:false};
}
export function sourceProfiles(report){
  const owners=new Map();
  for(const line of report.lines){const row=owners.get(line.owner)??{lines:[],rejected:[]};row.lines.push(line);owners.set(line.owner,row);}
  for(const rejected of report.rejected)for(const owner of rejected.owners??[]){const row=owners.get(owner)??{lines:[],rejected:[]};row.rejected.push(rejected);owners.set(owner,row);}
  return [...owners].sort((a,b)=>a[0]-b[0]).map(([owner,row])=>({owner,...closeSourceProfile(row.lines,row.rejected)}));
}
