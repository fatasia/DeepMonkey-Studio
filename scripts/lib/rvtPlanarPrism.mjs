// Narrow persisted six-plane/twelve-edge RVT 2024 profile. No bbox geometry.
const EPS=1e-7;
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const length=a=>Math.hypot(...a);
const near=(a,b)=>length(sub(a,b))<=EPS;
const assert=(ok,why)=>{if(!ok)throw Error(why);};
const point=(plane,uv)=>plane.origin.map((x,i)=>x+uv[0]*plane.u[i]+uv[1]*plane.v[i]);
export function decodePlanarPrism(b,element){
  assert(Buffer.isBuffer(b)&&b.length===3704,'unsupported record layout');
  assert(b.readBigUInt64LE(0)===BigInt(element)&&b.readBigUInt64LE(26)===BigInt(element)&&b.readBigUInt64LE(144)===BigInt(element),'source ID mismatch');
  assert(b.readUInt32LE(12)===3684&&b.readUInt32LE(3700)===3684,'record framing');
  assert(['3f08d501','3f08d700'].includes(b.subarray(16,20).toString('hex')),'geometry carrier marker');
  assert(b.readUInt32LE(176)===0x8c004&&b.readUInt32LE(180)===6&&b.readUInt32LE(236)===12,'source face/edge counts');
  const doubles=(at,count)=>Array.from({length:count},(_,i)=>{const n=b.readDoubleLE(at+i*8);assert(Number.isFinite(n),'non-finite source parameter');return n;});
  const planes=[];
  for(let i=0;i<6;i++){
    const at=2044+i*276,id=b.readUInt32LE(at+24);
    assert(id===i+4&&b.subarray(at,at+12).every(v=>v===255)&&b.readUInt32LE(at+12)===0&&b.readUInt32LE(at+16)===0x80004&&b.readUInt32LE(at+20)===0,'face framing');
    assert(b.subarray(at+155,at+171).equals(Buffer.from('ffffffffffffffff0000000112000000','hex'))&&b[at+203]===1,'plane carrier');
    const domain=doubles(at+171,4),frame=doubles(at+204,9),origin=frame.slice(0,3),u=frame.slice(3,6),v=frame.slice(6,9),normal=cross(u,v);
    assert(domain[2]>domain[0]&&domain[3]>domain[1]&&Math.abs(length(u)-1)<1e-10&&Math.abs(length(v)-1)<1e-10&&Math.abs(dot(u,v))<1e-10,'invalid source frame');
    planes.push({id,sourceOffset:at,domain,origin,u,v,normal});
  }
  const vertices=[],edges=[];let maxPairedResidualFeet=0;
  const intern=p=>{const found=vertices.map((q,i)=>near(p,q)?i:-1).filter(i=>i>=0);assert(found.length<=1,'ambiguous vertex');if(found.length)return found[0];vertices.push(p);return vertices.length-1;};
  for(let i=0;i<12;i++){
    const at=688+i*113,faces=[b.readUInt32LE(at+20),b.readUInt32LE(at+24)],values=doubles(at+48,8);
    assert(b.subarray(at,at+8).every(v=>v===255)&&b.readUInt32LE(at+12)===0&&b.readUInt32LE(at+16)===0x88204&&b.readUInt32LE(at+44)===0,'edge framing');
    assert(faces[0]!==faces[1]&&faces.every(id=>id>=4&&id<=9),'invalid adjacent faces');
    const ends=[];
    for(let end=0;end<2;end++){
      const positions=faces.map((id,side)=>{const p=planes[id-4],uv=values.slice(end*4+side*2,end*4+side*2+2);
        assert(uv[0]>=p.domain[0]-EPS&&uv[0]<=p.domain[2]+EPS&&uv[1]>=p.domain[1]-EPS&&uv[1]<=p.domain[3]+EPS,'edge outside finite plane domain');
        return point(p,uv);
      });
      const residual=length(sub(positions[0],positions[1]));maxPairedResidualFeet=Math.max(maxPairedResidualFeet,residual);
      assert(residual<=EPS,'shared edge disagrees between source planes');ends.push(intern(positions[0]));
    }
    assert(ends[0]!==ends[1],'zero edge');edges.push({id:i+10,sourceOffset:at,faces,vertices:ends});
  }
  assert(vertices.length===8,'not an eight-vertex prism');
  assert(new Set(edges.map(e=>[...e.vertices].sort((a,b)=>a-b).join('/'))).size===12,'duplicate edge');
  assert(vertices.every((_,i)=>edges.filter(e=>e.vertices.includes(i)).length===3),'open vertex topology');
  const center=[0,1,2].map(i=>vertices.reduce((sum,p)=>sum+p[i],0)/8),faces=[],triangles=[];
  for(const plane of planes){
    const members=edges.filter(e=>e.faces.includes(plane.id));assert(members.length===4,'face is not a single quadrilateral');
    const polygon=[members[0].vertices[0]],used=new Set();let at=polygon[0];
    for(let k=0;k<4;k++){const edge=members.find(e=>!used.has(e.id)&&e.vertices.includes(at));assert(edge,'open face');used.add(edge.id);at=edge.vertices.find(v=>v!==at);if(k<3)polygon.push(at);}
    assert(at===polygon[0]&&new Set(polygon).size===4,'invalid face cycle');
    assert(dot(plane.normal,sub(plane.origin,center))>EPS,'source plane normal points inward');
    if(dot(cross(sub(vertices[polygon[1]],vertices[polygon[0]]),sub(vertices[polygon[2]],vertices[polygon[0]])),plane.normal)<0)polygon.reverse();
    for(let i=0;i<4;i++)assert(dot(cross(sub(vertices[polygon[(i+1)%4]],vertices[polygon[i]]),sub(vertices[polygon[(i+2)%4]],vertices[polygon[(i+1)%4]])),plane.normal)>EPS,'non-convex face');
    triangles.push([polygon[0],polygon[1],polygon[2]],[polygon[0],polygon[2],polygon[3]]);faces.push({id:plane.id,vertices:polygon});
  }
  const horizontal=planes.filter(p=>Math.abs(p.normal[2])>1-1e-10),vertical=planes.filter(p=>Math.abs(p.normal[2])<1e-10);
  assert(horizontal.length===2&&vertical.length===4,'not a vertical prism');
  const lower=Math.min(...horizontal.map(p=>p.origin[2])),upper=Math.max(...horizontal.map(p=>p.origin[2]));assert(upper-lower>EPS,'zero extrusion');
  const volume=triangles.reduce((sum,t)=>{const [a,b,c]=t.map(i=>sub(vertices[i],center));return sum+dot(a,cross(b,c))/6;},0);
  assert(volume>0,'invalid signed volume');
  return {element,verticesFeet:vertices,triangles,faces,sourcePlanes:planes,sourceEdges:edges,
    lowerFeet:lower,upperFeet:upper,volumeCubicFeet:volume,maxPairedResidualFeet,quality:'source-planar-solid-preview'};
}
export function matchSourceProfile(solid,profile,lines){
  assert(profile?.status==='closed-source-wire'&&profile.owner===solid.element&&profile.loops.length===1&&profile.sourceLineCount===4,'complete single source rectangle required');
  const ids=profile.loops[0].elements,selected=ids.map(id=>lines.find(l=>l.element===id));assert(selected.every(Boolean),'missing source line');
  const z=selected[0].endpointsFeet[0][2];assert(selected.every(l=>l.endpointsFeet.every(p=>Math.abs(p[2]-z)<=EPS)),'non-horizontal source profile');
  const capEdges=solid.sourceEdges.filter(e=>e.vertices.every(i=>Math.abs(solid.verticesFeet[i][2]-solid.upperFeet)<=EPS));assert(capEdges.length===4,'source cap topology');
  const consumed=new Set();
  const nearXY=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1])<=EPS;
  for(const line of selected){const [a,b]=line.endpointsFeet;const matches=capEdges.filter(e=>{const [c,d]=e.vertices.map(i=>solid.verticesFeet[i]);return nearXY(a,c)&&nearXY(b,d)||nearXY(a,d)&&nearXY(b,c);});assert(matches.length===1&&!consumed.has(matches[0].id),'profile and source BRep disagree');consumed.add(matches[0].id);}
  // Sketch Z is not assumed to be a cap or a world placement. The solid uses
  // only its own source plane/coedge positions; this is a separate XY check.
  return {sourceLineIds:ids,sketchElevationFeet:z,association:'same-source-ID-and-XY-boundary',holes:0,
    upperLowerFrom:'persisted-plane-origins-not-metadata-bbox',sketchPlacementResolved:false};
}
