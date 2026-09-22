import {evaluateSurface} from './3dm-nurbs-parameters.mjs';
const sub=(a:number[],b:number[])=>a.map((x,i)=>x-b[i]);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normal=(p:number[][])=>cross(sub(p[1],p[0]),sub(p[2],p[0]));
const area=(p:number[][])=>(p[1][0]-p[0][0])*(p[2][1]-p[0][1])-(p[1][1]-p[0][1])*(p[2][0]-p[0][0]);
const distance=(a:number[],b:number[])=>Math.hypot(...sub(a,b));
export function collapsedFloat32Triangles(mesh:any){return mesh.triangles.flatMap((t:number[],i:number)=>Math.hypot(...normal(t.map(id=>mesh.positions[id].map(Math.fround))))===0?[i]:[]);}

/** Relocate only unprotected interior samples along a cylinder's linear axis.
 * Source trims, indices, curved-axis samples and face identities are immutable.
 * No triangle is discarded. The entire face rolls back unless all collapses end.
 */
export function repairFloat32Interior(ir:any,input:any,metersPerUnit:number){
  const before=collapsedFloat32Triangles(input.mesh);
  if(!before.length)return input;
  if(!Number.isFinite(metersPerUnit)||metersPerUnit<=0||!['cad-ir-trimmed-cylinder','cad-ir-proven-cylinder'].includes(input.geometrySource)
    ||![0,1].includes(input.audit?.curvedAxis)||!Number.isFinite(input.audit?.physicalBoundMm))return input;
  const surface=ir.surfaces[ir.faces[input.face].surface],axis=1-input.audit.curvedAxis;
  if(surface.degree[axis]!==1||surface.controlPointCount[axis]!==2)return input;
  if(input.mesh.positions.some((p:number[],id:number)=>distance(p,evaluateSurface(surface,input.audit.uv[id]))>1e-10))return input;
  const part=structuredClone(input),mesh=part.mesh,uv=part.audit.uv,protectedVertices=new Set<number>(part.boundaryEdges.flatMap((b:any)=>b.vertices));
  const moves:any[]=[];let remaining=before,maxMovement=0;
  for(let pass=0;remaining.length&&pass<64;pass++){
    let accepted=false;
    for(const id of mesh.triangles[remaining[0]] as number[]){
      if(protectedVertices.has(id))continue;
      const oldUv=[...uv[id]],oldPosition=[...mesh.positions[id]],incidents=mesh.triangles.flatMap((t:number[],i:number)=>t.includes(id)?[i]:[]);
      if(distance(oldPosition,evaluateSurface(surface,oldUv))>1e-10)continue;
      const signed=incidents.map((i:number)=>area(mesh.triangles[i].map((v:number)=>uv[v])));
      for(let step=0;step<12&&!accepted;step++)for(const direction of [-1,1]){
        const candidate=[...oldUv];candidate[axis]+=direction*2**step*1e-8/(metersPerUnit*1000);
        if(candidate[axis]<=surface.domain[axis][0]||candidate[axis]>=surface.domain[axis][1])continue;
        const point=evaluateSurface(surface,candidate),movement=distance(point,input.mesh.positions[id]);
        if(movement*metersPerUnit*1000>1e-5)continue;
        uv[id]=candidate;mesh.positions[id]=point;
        const valid=incidents.every((index:number,k:number)=>{
          const t=mesh.triangles[index],n=normal(t.map((v:number)=>mesh.positions[v])),q=normal(t.map((v:number)=>mesh.positions[v].map(Math.fround)));
          return area(t.map((v:number)=>uv[v]))*signed[k]>0&&Math.hypot(...n)>1e-14
            &&t.every((v:number)=>n.reduce((s,x,j)=>s+x*mesh.normals[v][j],0)>0
              &&(Math.hypot(...q)===0?remaining.includes(index):q.reduce((s,x,j)=>s+x*mesh.normals[v][j],0)>0));
        });
        const bad=valid?collapsedFloat32Triangles(mesh):remaining;
        if(valid&&bad.length<remaining.length&&bad.every((i:number)=>remaining.includes(i))){
          maxMovement=Math.max(maxMovement,movement);remaining=bad;moves.push({vertex:id,from:oldUv,to:candidate,movement});accepted=true;break;
        }
        uv[id]=oldUv;mesh.positions[id]=oldPosition;
      }
      if(accepted)break;
    }
    if(!accepted)return input;
  }
  if(remaining.length)return input;
  const quantization=Math.max(...mesh.positions.map((p:number[])=>distance(p,p.map(Math.fround))));
  const quantizationDelta=Math.max(0,quantization-part.audit.quantization);
  const physicalBoundMm=input.audit.physicalBoundMm+(maxMovement+quantizationDelta)*metersPerUnit*1000;
  if(!Number.isFinite(physicalBoundMm)||physicalBoundMm>.01)return input;
  part.audit.quantization=quantization;part.audit.physicalBoundMm=physicalBoundMm;
  part.audit.float32InteriorRepair={collapsedBefore:before.length,collapsedAfter:0,moves,maxMovement,
    priorPhysicalBoundMm:input.audit.physicalBoundMm,quantizationDelta,physicalBoundMm};
  return part;
}
