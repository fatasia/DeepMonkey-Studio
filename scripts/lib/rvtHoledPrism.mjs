import {triangulateSourceLoops} from './rvtPlanarTriangulation.mjs';
const EPS=1e-7,check=(ok,why)=>{if(!ok)throw Error(why);};
const sub=(a,b)=>a.map((v,k)=>v-b[k]),dot=(a,b)=>a.reduce((s,v,k)=>s+v*b[k],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const area=p=>p.reduce((s,v,i)=>{const q=p[(i+1)%p.length];return s+v[0]*q[1]-q[0]*v[1];},0)/2;
const orient=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const on=(a,b,p)=>Math.abs(orient(a,b,p))<=EPS&&p.every((v,k)=>v>=Math.min(a[k],b[k])-EPS&&v<=Math.max(a[k],b[k])+EPS);
const intersects=(a,b,c,d)=>on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b)||(orient(a,b,c)*orient(a,b,d)<0&&orient(c,d,a)*orient(c,d,b)<0);
const inside=(p,loop)=>{let yes=false;for(let i=0,j=loop.length-1;i<loop.length;j=i++){const a=loop[i],b=loop[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
export function validatePlanarLoops(loops){
  check(loops.length>0,'missing face loops');
  for(const loop of loops){check(loop.length>=3&&Math.abs(area(loop))>EPS,'zero-area loop');
    for(let i=0;i<loop.length;i++)for(let j=i+1;j<loop.length;j++)if(j!==i+1&&!(i===0&&j===loop.length-1))check(!intersects(loop[i],loop[(i+1)%loop.length],loop[j],loop[(j+1)%loop.length]),'self-intersecting loop');
  }
  for(let i=0;i<loops.length;i++)for(let j=i+1;j<loops.length;j++)for(let a=0;a<loops[i].length;a++)for(let b=0;b<loops[j].length;b++)check(!intersects(loops[i][a],loops[i][(a+1)%loops[i].length],loops[j][b],loops[j][(b+1)%loops[j].length]),'touching/crossing face loops');
  const outer=loops.reduce((best,l,i)=>Math.abs(area(l))>Math.abs(area(loops[best]))?i:best,0);
  for(let i=0;i<loops.length;i++)if(i!==outer){check(inside(loops[i][0],loops[outer]),'hole outside outer loop');for(let j=0;j<loops.length;j++)if(j!==i&&j!==outer)check(!inside(loops[i][0],loops[j]),'nested hole/island unsupported');}
  return outer;
}
export function decodeHoledPrism(b,element){
  check(Buffer.isBuffer(b)&&b.length===22997,'unsupported holed record layout');
  check([0,26,144].every(at=>b.readBigUInt64LE(at)===BigInt(element)),'source ID mismatch');
  check(b.readUInt32LE(12)===22977&&b.readUInt32LE(22993)===22977&&b.subarray(16,20).toString('hex')==='3f08d700','record framing');
  check(b.readUInt32LE(176)===0x8c004&&b.readUInt32LE(180)===33&&b.readUInt32LE(398)===93,'source face/edge counts');
  const doubles=(at,n)=>Array.from({length:n},(_,i)=>{const x=b.readDoubleLE(at+i*8);check(Number.isFinite(x),'non-finite source parameter');return x;});
  const planes=[],marker=Buffer.from('ffffffffffffffff0000000112000000','hex');let at=-1;
  while((at=b.indexOf(marker,at+1))>=0){
    check(at>=78&&at+121<=b.length,'plane framing');
    const id=b.readUInt32LE(at-66),domain=doubles(at+16,4),frame=doubles(at+49,9),u=frame.slice(3,6),v=frame.slice(6,9);
    check(b.subarray(at-78,at-66).toString('hex')==='ffffffff0000000004000800'&&b[at+48]===1&&id===planes.length+4,'plane carrier');
    check(domain[2]>domain[0]&&domain[3]>domain[1]&&Math.abs(Math.hypot(...u)-1)<1e-10&&Math.abs(Math.hypot(...v)-1)<1e-10&&Math.abs(dot(u,v))<1e-10,'invalid plane basis');
    planes.push({id,sourceOffset:at,domain,origin:frame.slice(0,3),u,v,normal:cross(u,v)});
  }
  check(planes.length===33,'missing plane');
  const vertices=[],edges=[];let maxPairedResidualFeet=0;
  const intern=p=>{const matches=vertices.map((q,i)=>Math.hypot(...sub(p,q))<=EPS?i:-1).filter(i=>i>=0);check(matches.length<=1,'ambiguous vertex');if(matches.length)return matches[0];vertices.push(p);return vertices.length-1;};
  for(let i=0;i<93;i++){
    const at=3010+i*113,faces=[b.readUInt32LE(at+20),b.readUInt32LE(at+24)],uv=doubles(at+48,8);
    check(b.subarray(at,at+8).every(v=>v===255)&&b.readUInt32LE(at+12)===0&&[0x88204,0x882e4].includes(b.readUInt32LE(at+16))&&b.readUInt32LE(at+44)===0,'edge framing');
    check(faces[0]!==faces[1]&&faces.every(id=>id>=4&&id<=36),'edge face reference');
    const parallel=Math.hypot(...cross(planes[faces[0]-4].normal,planes[faces[1]-4].normal))<=1e-10;
    const ends=[];
    for(let end=0;end<2;end++){
      const points=faces.map((id,side)=>{const p=planes[id-4],[u,v]=uv.slice(end*4+side*2,end*4+side*2+2);
        check(u>=p.domain[0]-EPS&&u<=p.domain[2]+EPS&&v>=p.domain[1]-EPS&&v<=p.domain[3]+EPS,'edge outside plane domain');
        return p.origin.map((x,k)=>x+u*p.u[k]+v*p.v[k]);});
      const error=Math.hypot(...sub(points[0],points[1]));maxPairedResidualFeet=Math.max(maxPairedResidualFeet,error);check(error<=EPS,'paired edge residual');ends.push(intern(points[0]));
    }
    check(ends[0]!==ends[1],'zero edge');
    if(parallel){const [a,c]=ends.map(i=>vertices[i]);check(faces.every(id=>Math.abs(planes[id-4].normal[2])<1e-10)&&Math.hypot(a[0]-c[0],a[1]-c[1])<=EPS,'unsupported coplanar nonvertical edge');}
    edges.push({id:37+i,faces,vertices:ends,sourceOffset:at});
  }
  check(vertices.length===62&&new Set(edges.map(e=>[...e.vertices].sort((a,b)=>a-b).join('/'))).size===93,'source vertex/edge topology');
  const triangles=[],faces=[];
  for(const plane of planes){
    const members=edges.filter(e=>e.faces.includes(plane.id)),remaining=new Set(members.map(e=>e.id)),loops=[];
    for(const vertex of new Set(members.flatMap(e=>e.vertices)))check(members.filter(e=>e.vertices.includes(vertex)).length===2,'open/branching face');
    while(remaining.size){const first=members.find(e=>remaining.has(e.id)),loop=[first.vertices[0]];let current=loop[0];
      do{const edge=members.find(e=>remaining.has(e.id)&&e.vertices.includes(current));check(edge,'open face loop');remaining.delete(edge.id);current=edge.vertices.find(v=>v!==current);if(current!==loop[0])loop.push(current);check(loop.length<=members.length,'face cycle budget');}while(current!==loop[0]);loops.push(loop);
    }
    const project=loop=>loop.map(i=>{const p=sub(vertices[i],plane.origin);return Math.abs(plane.normal[2])>1-1e-10?[vertices[i][0],vertices[i][1]*Math.sign(plane.normal[2])]:[dot(p,plane.u),dot(p,plane.v)];});
    const outer=validatePlanarLoops(loops.map(project)),ordered=[loops[outer],...loops.filter((_,i)=>i!==outer)].map((loop,i)=>{const positive=area(project(loop))>0;return positive===(i===0)?loop:[...loop].reverse();});
    const coordinates=ordered.map(project),start=triangles.length;
    const triangulated=triangulateSourceLoops(ordered,project);
    let triangleArea=0;
    for(const t of triangulated){const ids=[...t],points=ids.map(i=>vertices[i]),normal=cross(sub(points[1],points[0]),sub(points[2],points[0]));if(dot(normal,plane.normal)<0)[ids[1],ids[2]]=[ids[2],ids[1]];
      check(Math.hypot(...normal)>EPS,`zero-area triangulation face ${plane.id} vertices ${ids.join('/')}`);triangleArea+=Math.hypot(...normal)/2;triangles.push(ids);}
    const expected=coordinates.reduce((s,l)=>s+area(l),0);check(expected>0&&Math.abs(triangleArea-expected)<=Math.max(1,expected)*1e-10,'face area conservation');
    faces.push({id:plane.id,loops:ordered,triangleStart:start,triangleCount:triangles.length-start,areaSquareFeet:expected});
  }
  const incidence=new Map();for(const t of triangles)for(let i=0;i<3;i++){const x=t[i],y=t[(i+1)%3],key=[x,y].sort((a,b)=>a-b).join('/'),values=incidence.get(key)??[];values.push([x,y]);incidence.set(key,values);}
  for(const values of incidence.values())check(values.length===2&&values[0][0]===values[1][1]&&values[0][1]===values[1][0],'non-manifold triangulated shell');
  const horizontal=planes.filter(p=>Math.abs(p.normal[2])>1-1e-10);check(horizontal.length===2,'not vertical extrusion');
  const capFaces=horizontal.map(p=>faces.find(f=>f.id===p.id));check(capFaces.every(f=>f.loops.length===2&&f.loops.map(l=>l.length).sort((a,b)=>a-b).join('/')==='4/27'),'unsupported cap topology');
  const lower=Math.min(...horizontal.map(p=>p.origin[2])),upper=Math.max(...horizontal.map(p=>p.origin[2]));
  const center=[0,1,2].map(k=>vertices.reduce((s,p)=>s+p[k],0)/vertices.length),volume=triangles.reduce((sum,t)=>{const [a,b,c]=t.map(i=>sub(vertices[i],center));return sum+dot(a,cross(b,c))/6;},0);
  check(volume>0&&Math.abs(volume-capFaces[0].areaSquareFeet*(upper-lower))<1e-7,'extrusion volume conservation');
  return {element,verticesFeet:vertices,triangles,faces,sourcePlanes:planes,sourceEdges:edges,lowerFeet:lower,upperFeet:upper,volumeCubicFeet:volume,maxPairedResidualFeet,holes:1,quality:'source-holed-planar-solid-preview'};
}
export function matchHoledSourceProfile(solid,profile,lines){
  check(profile?.status==='closed-source-wire'&&profile.owner===solid.element&&profile.loops.length===2&&profile.sourceLineCount===31,'complete two-loop source profile required');
  const cap=solid.sourceEdges.filter(e=>e.vertices.every(i=>Math.abs(solid.verticesFeet[i][2]-solid.upperFeet)<=EPS));check(cap.length===31,'source cap edges');
  const ids=profile.loops.flatMap(l=>l.elements),used=new Set(),near=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1])<=EPS;
  for(const id of ids){const line=lines.find(l=>l.element===id);check(line,'missing profile source line');const [a,b]=line.endpointsFeet;
    const matches=cap.filter(e=>{const[c,d]=e.vertices.map(i=>solid.verticesFeet[i]);return near(a,c)&&near(b,d)||near(a,d)&&near(b,c);});check(matches.length===1&&!used.has(matches[0].id),'source profile/BRep mismatch');used.add(matches[0].id);}
  validatePlanarLoops(profile.loops.map(l=>l.verticesFeet.map(p=>p.slice(0,2))));
  return {sourceLineIds:ids,holes:1,association:'same-source-ID-and-two-loop-XY-boundary',sketchPlacementResolved:false};
}
