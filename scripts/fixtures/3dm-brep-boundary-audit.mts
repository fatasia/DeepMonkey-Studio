import { proveLinearSelfSeam } from './3dm-self-seam-proof.mts';
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
const key=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`;
const segmentDistance=(p:number[],a:number[],b:number[])=>{
  const d=b.map((x,i)=>x-a[i]),l=d.reduce((s,x)=>s+x*x,0);
  const t=l?Math.max(0,Math.min(1,d.reduce((s,x,i)=>s+x*(p[i]-a[i]),0)/l)):0;
  return distance(p,a.map((x,i)=>x+t*d[i]));
};
function sides(part:any){
  if(!part.boundaryEdges?.length)return new Map();
  const edges=new Map<string,{a:number,b:number,count:number}>();
  for(const t of part.mesh.triangles)for(let i=0;i<3;i++){
    const a=t[i],b=t[(i+1)%3],k=key(a,b),prior=edges.get(k);if(prior)prior.count++;else edges.set(k,{a,b,count:1});
  }
  return new Map((part.boundaryEdges??[]).map((boundary:any)=>{
    const segments=boundary.vertices.slice(1).map((b:number,i:number)=>{
      const a=boundary.vertices[i],actual=edges.get(key(a,b));
      return {a:part.mesh.positions[a],b:part.mesh.positions[b],direction:actual?.count===1?(actual.a===a?1:-1):0};
    });return [boundary.trim,{segments,face:part.face}];
  }));
}
/** Audit only: never snap unrelated source edges or increase the authored geometric tolerance. */
export function auditBrepBoundaries(ir:any,parts:any[],tolerance=1e-8){
  if(!Number.isFinite(tolerance)||tolerance<=0)throw new Error('invalid-boundary-tolerance');
  const byFace=new Map(parts.map(p=>[p.face,p])),byTrim=new Map(parts.flatMap(p=>[...sides(p)]));
  const uses=ir.edges.map(()=>[] as number[]);ir.trims.forEach((t:any,i:number)=>{if(t.edge>=0)uses[t.edge]?.push(i);});
  const shared:any[]=[],seams:any[]=[],unverified:any[]=[];
  for(let edge=0;edge<uses.length;edge++){
    const trims=uses[edge],faces=trims.map((t:number)=>ir.loops[ir.trims[t].loop].face);
    if(trims.length!==2){unverified.push({edge,reason:'source-edge-not-two-sided',faces});continue;}
    let seamProof:any;
    if(faces[0]===faces[1])try{seamProof=proveLinearSelfSeam(ir,edge,trims);}
    catch(error){unverified.push({edge,reason:error instanceof Error?error.message:'self-seam-not-audited',faces});continue;}
    const pair:any[]=trims.map((t:number)=>byTrim.get(t));
    if(pair.some(s=>!s)){unverified.push({edge,reason:'missing-boundary-mesh',faces});continue;}
    let maxSampledDeviation=0,unmatchedSegments=0,orientationErrors=0,invalidBoundarySegments=0;
    if(seamProof){
      const curve=ir.curves3d[ir.edges[edge].curve3d],limit=Math.min(1e-10,ir.edges[edge].tolerance+1e-12);
      seamProof.maxMeshSourceDeviation=Math.max(...pair.flatMap(side=>side.segments.flatMap((s:any)=>[s.a,s.b]
        .map(p=>segmentDistance(p,curve.controlPoints[0],curve.controlPoints[1])))));
      if(!Number.isFinite(seamProof.maxMeshSourceDeviation)||seamProof.maxMeshSourceDeviation>limit)invalidBoundarySegments++;
    }
    for(let side=0;side<2;side++)for(const segment of pair[side].segments){
      const other=pair[1-side].segments;
      if(!segment.direction)invalidBoundarySegments++;
      for(const p of [segment.a,segment.b,segment.a.map((x:number,i:number)=>(x+segment.b[i])/2)])
        maxSampledDeviation=Math.max(maxSampledDeviation,Math.min(...other.map((s:any)=>segmentDistance(p,s.a,s.b))));
      let best:any;
      for(const s of other){const same=Math.max(distance(segment.a,s.a),distance(segment.b,s.b)),opposite=Math.max(distance(segment.a,s.b),distance(segment.b,s.a)),error=Math.min(same,opposite);
        if(error<=tolerance&&(!best||error<best.error))best={s,same,opposite,error};}
      const match=best?.s;
      if(!match)unmatchedSegments++;
      else if(segment.direction&&match.direction){
        const same=best.same<=best.opposite;
        if(segment.direction===(same?match.direction:-match.direction))orientationErrors++;
      }
    }
    (seamProof?seams:shared).push({edge,faces,segmentCounts:pair.map(s=>s.segments.length),maxSampledDeviation,unmatchedSegments,
      orientationErrors,invalidBoundarySegments,conforming:!unmatchedSegments&&!orientationErrors&&!invalidBoundarySegments,...(seamProof?{seamProof}:{})});
  }
  const allFacesPresent=ir.faces.length===byFace.size&&ir.faces.every((_:any,i:number)=>byFace.has(i));
  return {tolerance,allFacesPresent,shared,seams,unverified,
    status:allFacesPresent&&shared.length+seams.length>0&&!unverified.length&&[...shared,...seams].every(s=>s.conforming)?'conforming-two-sided-boundary':'unverified-or-nonconforming-boundary'};
}
