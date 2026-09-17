import {createRequire} from 'node:module';
import {polygonArea,insideRing} from './3dm-planar-trim.mts';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),{ShapeUtils,Vector2}=require('three');
const orient=(a:number[],b:number[],c:number[])=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function check(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
/** Replace one planar boundary triangle by its simple source-UV polygon, preserving every boundary vertex. */
export function triangulateLocalPlane(uv:number[][],boundary:number[],opposite:number){
  const ids=[...boundary,opposite],ring=ids.map(i=>uv[i]);check(ids.length<=256&&new Set(ids).size===ids.length,'invalid-local-plane-polygon');
  const area=polygonArea(ring);check(Number.isFinite(area)&&Math.abs(area)>1e-14,'degenerate-local-plane-polygon');
  for(let i=0;i<ring.length;i++)for(let j=i+2;j<ring.length;j++){
    if(i===0&&j===ring.length-1)continue;const a=ring[i],b=ring[(i+1)%ring.length],c=ring[j],d=ring[(j+1)%ring.length];
    check(!(orient(a,b,c)*orient(a,b,d)<=0&&orient(c,d,a)*orient(c,d,b)<=0
      &&Math.min(a[0],b[0])<=Math.max(c[0],d[0])&&Math.min(c[0],d[0])<=Math.max(a[0],b[0])
      &&Math.min(a[1],b[1])<=Math.max(c[1],d[1])&&Math.min(c[1],d[1])<=Math.max(a[1],b[1])),'self-intersecting-local-plane-polygon');
  }
  const triangles:number[][]=ShapeUtils.triangulateShape(ring.map(p=>new Vector2(...p)),[]).map((t:number[])=>t.map(i=>ids[i]));
  check(triangles.length===ids.length-2,'incomplete-local-plane-triangulation');let covered=0;
  const edges=new Map<string,{count:number,balance:number}>();
  for(const t of triangles){let signed=polygonArea(t.map(i=>uv[i]));if(signed*area<0){[t[1],t[2]]=[t[2],t[1]];signed=-signed;}
    check(signed*area>0,'degenerate-local-plane-triangle');covered+=Math.abs(signed);
    check(insideRing([0,1].map(axis=>t.reduce((sum,i)=>sum+uv[i][axis],0)/3),ring),'outside-local-plane-triangle');
    for(let i=0;i<3;i++){const a=t[i],b=t[(i+1)%3],key=[a,b].sort((a,b)=>a-b).join(':'),e=edges.get(key)??{count:0,balance:0};e.count++;e.balance+=a<b?1:-1;edges.set(key,e);}
  }
  check(Math.abs(covered-Math.abs(area))<=1e-12*Math.max(1,Math.abs(area)),'local-plane-area-mismatch');
  const boundaryKeys=new Set(ids.map((id,i)=>[id,ids[(i+1)%ids.length]].sort((a,b)=>a-b).join(':')));
  for(const key of boundaryKeys)check(edges.get(key)?.count===1,'missing-local-plane-boundary');
  check([...edges].every(([key,e])=>boundaryKeys.has(key)?e.count===1:e.count===2&&e.balance===0),'nonmanifold-local-plane-triangulation');return triangles;
}
