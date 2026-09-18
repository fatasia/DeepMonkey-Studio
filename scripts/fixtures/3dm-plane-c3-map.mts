import {evaluateCurve,evaluateSurface} from './3dm-nurbs-parameters.mjs';
import {sourceBezierInterval} from './3dm-source-bezier-interval.mts';
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
const dot=(a:number[],b:number[])=>a.reduce((s,x,i)=>s+x*b[i],0);
function check(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
function elevate(points:number[][],degree:number){let p=points.length-1;while(p<degree){const next=[points[0]];for(let i=1;i<=p;i++)next.push(points[i].map((x,j)=>i/(p+1)*points[i-1][j]+(1-i/(p+1))*x));next.push(points.at(-1)!);points=next;p++;}return points;}
function controlBound(a:number[][],b:number[][]){const degree=Math.max(a.length,b.length)-1;a=elevate(a,degree);b=elevate(b,degree);
  const pa=a.map(p=>p.slice(0,3).map(x=>x/p[3])),pb=b.map(p=>p.slice(0,3).map(x=>x/p[3])),wa=a.map(p=>p[3]/a[0][3]),wb=b.map(p=>p[3]/b[0][3]);
  return Math.max(...pa.map((p,i)=>distance(p,pb[i])))+2*Math.max(...pb.map(p=>distance(p,pb[0])))*Math.max(...wa.map((w,i)=>Math.abs(w-wb[i])))/Math.min(...wa);
}
/** Proposal fitting is never evidence: every monotone interval is certified by homogeneous control bounds. */
export function provePlaneC3Map(ir:any,face:number,edgeIndex:number,metersPerUnit:number){
  const edge=ir.edges[edgeIndex],c3=ir.curves3d[edge?.curve3d],surface=ir.surfaces[ir.faces[face].surface],trimIndex=ir.trims.findIndex((t:any)=>t.edge===edgeIndex&&ir.loops[t.loop].face===face),trim=ir.trims[trimIndex],c2=ir.curves2d[trim?.curve2d];
  check(Number.isFinite(metersPerUnit)&&metersPerUnit>0&&edge?.tolerance>0&&surface.parameterMap?.kind==='identity'&&!surface.rational&&surface.degree.every((d:number)=>d===1)&&surface.controlPointCount.every((n:number)=>n===2)
    &&c2?.parameterMap?.kind==='identity'&&c3?.parameterMap?.kind==='identity'&&!c2.rational&&c2.degree===3&&c3.rational&&c3.degree===2,'unsupported-plane-c3-reconstruction');
  const cp=surface.controlPoints,u=cp[1].map((x:number,i:number)=>x-cp[0][i]),v=cp[2].map((x:number,i:number)=>x-cp[0][i]),uu=dot(u,u),vv=dot(v,v),uv=dot(u,v),det=uu*vv-uv*uv;
  check(det>1e-12&&distance(cp[3],cp[1].map((x:number,i:number)=>x+cp[2][i]-cp[0][i]))<1e-12,'non-affine-reconstruction-plane');
  const planeUv=(point:number[])=>{const d=point.map((x,i)=>x-cp[0][i]),du=dot(d,u),dv=dot(d,v);return [(du*vv-dv*uv)/det,(dv*uu-du*uv)/det].map((t,i)=>surface.domain[i][0]+t*(surface.domain[i][1]-surface.domain[i][0]));};
  const projected=c3.controlPoints.map((p:number[])=>{const point=p.slice(0,3).map(x=>x/p[3]),uv=planeUv(point);check(uv.every((x,i)=>x>=surface.domain[i][0]&&x<=surface.domain[i][1]),'reconstructed-source-outside-plane');return {uv,point};});
  const planeBound=Math.max(...projected.map((p:any)=>distance(evaluateSurface(surface,p.uv),p.point)));check(planeBound<1e-10,'source-c3-not-on-plane');
  const lifted={...c2,dimension:3,rational:true,controlPoints:c2.controlPoints.map((p:number[])=>[...evaluateSurface(surface,p),1])};
  const a=[...new Set<number>(c2.knots)],b=[...new Set<number>(c3.knots)];
  check(a.length===b.length&&a.length<=17&&a[0]===trim.sourceSubdomain[0]&&a.at(-1)===trim.sourceSubdomain[1]&&b[0]===edge.sourceSubdomain[0]&&b.at(-1)===edge.sourceSubdomain[1],'unsupported-plane-c3-spans');
  const original=(t:number)=>evaluateCurve(lifted,t),target=(t:number)=>evaluateCurve(c3,t);
  if(distance(original(a[0]),target(b[0]))>distance(original(a[0]),target(b.at(-1)!)))b.reverse();
  check(a.every((t,i)=>distance(original(t),target(b[i]))<1e-10),'plane-c3-span-endpoint-mismatch');
  const limit=Math.min(edge.tolerance/4,.0000005/metersPerUnit),segments:{source:number[],target:number[],bound:number}[]=[];
  const visit=(lo:number,hi:number,x:number,y:number,depth:number)=>{
    const left=sourceBezierInterval(lifted,[lo,hi]).controlPoints,right=sourceBezierInterval(c3,[Math.min(x,y),Math.max(x,y)]).controlPoints;
    if(x>y)right.reverse();const bound=controlBound(left,right)+planeBound+1e-10;
    if(bound<=limit){check(segments.length<1024,'plane-c3-map-budget');segments.push({source:[lo,hi],target:[x,y],bound});return;}
    check(depth<16&&segments.length<1024,'plane-c3-map-budget');const middle=(lo+hi)/2,p=original(middle);let low=0,high=1;
    for(let j=0;j<60;j++){const f=low+(high-low)/3,g=high-(high-low)/3;if(distance(p,target(x+f*(y-x)))<distance(p,target(x+g*(y-x))))high=g;else low=f;}
    const m=x+(low+high)/2*(y-x);check(Math.abs(m-x)>1e-14&&Math.abs(y-m)>1e-14,'non-monotonic-plane-c3-map');
    visit(lo,middle,x,m,depth+1);visit(middle,hi,m,y,depth+1);
  };
  for(let i=1;i<a.length;i++)visit(a[i-1],a[i],b[i-1],b[i],0);
  const toC3=(t:number)=>{const s=segments.find(s=>t>=s.source[0]-1e-12&&t<=s.source[1]+1e-12);check(s,'plane-c3-parameter-outside');const f=Math.max(0,Math.min(1,(t-s.source[0])/(s.source[1]-s.source[0])));return s.target[0]+f*(s.target[1]-s.target[0]);};
  return {surface,trim:trimIndex,curve:c3,segments,planeBound,continuousBound:Math.max(...segments.map(s=>s.bound)),toC3,planeUv,toUv:(t:number)=>planeUv(target(t)),
    projectedCurve:{...c3,dimension:2,controlPoints:c3.controlPoints.map((p:number[],i:number)=>[...projected[i].uv.map((x:number)=>x*p[3]),p[3]])}};
}
