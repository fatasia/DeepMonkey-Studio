const MAX_POINTS=2048,MAX_DEPTH=24;
function check(value:unknown,message:string):asserts value { if(!value) throw new Error(message); }
const mix=(a:number[],b:number[],t:number)=>a.map((x,i)=>(1-t)*x+t*b[i]);
const point=(p:number[])=>p.slice(0,-1).map(x=>x/p.at(-1)!);
function split(points:number[][],t:number) {
  let row=points; const left=[row[0]],right=[row.at(-1)!];
  while(row.length>1) { row=row.slice(0,-1).map((p,i)=>mix(p,row[i+1],t)); left.push(row[0]); right.unshift(row.at(-1)!); }
  return [left,right];
}
function segmentDistance(p:number[],a:number[],b:number[]) {
  const u=b.map((x,i)=>x-a[i]),d=u.reduce((s,x)=>s+x*x,0);
  const t=d?Math.max(0,Math.min(1,u.reduce((s,x,i)=>s+(p[i]-a[i])*x,0)/d)):0;
  return Math.hypot(...p.map((x,i)=>x-a[i]-t*u[i]));
}
// Positive rational Bézier control hull gives a conservative chord bound.
export function trimPolyline(curve:any,domain:number[],reversed:boolean,tolerance:number) {
  check([2,3].includes(curve?.dimension) && Number.isInteger(curve.degree) && curve.degree>=1 && curve.degree<=8
    && curve.parameterMap?.kind==='identity' && curve.controlPoints.length<=4096,'unsupported-trim-curve');
  const p=curve.degree; let knots=[...curve.knots],points=curve.controlPoints.map((cv:number[])=>curve.rational?[...cv]:[...cv,1]);
  check(points.length>p && knots.length===points.length+p+1 && knots.every((k:number,i:number)=>Number.isFinite(k)&&(i===0||k>=knots[i-1]))
    && points.every((cv:number[])=>cv.length===curve.dimension+1&&cv.every(Number.isFinite)&&cv.at(-1)!>0),'invalid-trim-nurbs');
  check(domain?.length===2&&domain.every(Number.isFinite)&&domain[0]<domain[1]
    &&domain[0]>=knots[p]&&domain[1]<=knots[points.length]&&tolerance>0&&Number.isFinite(tolerance),'invalid-trim-subdomain');
  check(knots.slice(0,p+1).every((k:number)=>k===knots[p])&&knots.slice(-p-1).every((k:number)=>k===knots.at(-1)),'unsupported-unclamped-trim');
  const interior=[...new Set<number>(knots.filter((k:number)=>k>knots[p]&&k<knots[points.length]))];
  for(const value of interior) {
    let multiplicity=knots.filter((k:number)=>k===value).length;
    check(multiplicity<=p,'discontinuous-trim-curve');
    while(multiplicity<p) {
      const k=knots.lastIndexOf(value),n=points.length-1,next:number[][]=[];
      for(let i=0;i<=k-p;i++) next[i]=points[i];
      for(let i=k-multiplicity;i<=n;i++) next[i+1]=points[i];
      for(let i=k-p+1;i<=k-multiplicity;i++) next[i]=mix(points[i-1],points[i],(value-knots[i])/(knots[i+p]-knots[i]));
      points=next; knots.splice(k+1,0,value); multiplicity++;
    }
  }
  const result:number[][]=[],parameters:number[]=[]; let maxBound=0;
  const append=(control:number[][],depth:number,start:number,end:number)=>{
    const a=point(control[0]),b=point(control.at(-1)!);
    const bound=Math.max(...control.map(cv=>segmentDistance(point(cv),a,b)));
    if(bound<=tolerance) {
      check(result.length<MAX_POINTS,'trim-vertex-budget');
      if(!result.length) { result.push(a); parameters.push(start); }
      result.push(b); parameters.push(end); maxBound=Math.max(maxBound,bound); return;
    }
    check(depth<MAX_DEPTH,'trim-subdivision-budget');
    const [left,right]=split(control,.5),middle=(start+end)/2;
    append(left,depth+1,start,middle); append(right,depth+1,middle,end);
  };
  for(let i=p;i<points.length;i++) {
    const start=knots[i],end=knots[i+1],lo=Math.max(start,domain[0]),hi=Math.min(end,domain[1]);
    if(!(lo<hi)) continue;
    let control=points.slice(i-p,i+1);
    if(hi<end) control=split(control,(hi-start)/(end-start))[0];
    if(lo>start) control=split(control,(lo-start)/(hi-start))[1];
    append(control,0,lo,hi);
  }
  check(result.length>=2,'empty-trim-curve');
  if(reversed) { result.reverse(); parameters.reverse(); }
  return {points:result,parameters,maxBound};
}
