function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
/** Clamped polynomial bicubics with simple interior knots are C2 throughout the active domain. */
export function validatePolynomialBicubic(s:any,multispan:boolean) {
  check(s?.dimension===3&&!s.rational&&s.degree?.length===2&&s.degree.every((d:number)=>d===3)
    &&s.controlPointCount?.length===2&&s.controlPointCount.every((n:number)=>Number.isInteger(n)&&n>=4&&n<=256)
    &&s.parameterMap?.kind==='identity','unsupported-polynomial-bicubic');
  check(multispan?s.controlPointCount.some((n:number)=>n>4):s.controlPointCount.every((n:number)=>n===4),'unsupported-single-bicubic');
  check(s.domain?.length===2&&s.domain.every((d:number[])=>d.length===2&&d.every(Number.isFinite)&&d[1]>d[0])
    &&s.knots?.length===2&&s.knots.every((k:number[],axis:number)=>{
      const n=s.controlPointCount[axis],d=s.domain[axis];return k.length===n+4&&k.every(Number.isFinite)
        &&k.slice(0,4).every(x=>x===d[0])&&k.slice(-4).every(x=>x===d[1])
        &&k.slice(3,n).every((x,i)=>x<k[i+4]);
    })&&s.controlPoints?.length===s.controlPointCount[0]*s.controlPointCount[1]
    &&s.controlPoints.every((p:number[])=>p.length===3&&p.every(Number.isFinite)),'invalid-bicubic-control-net');
}
/** Exact B-spline derivative net; removing each endpoint knot retains the source parameter domain. */
export function polynomialDerivative(s:any,axis:number) {
  const degree=[...s.degree],counts=[...s.controlPointCount],controlPoints:number[][]=[];
  degree[axis]--;counts[axis]--;
  for(let v=0;v<counts[1];v++)for(let u=0;u<counts[0];u++) {
    const offset=axis===0?u:v,span=s.knots[axis][offset+s.degree[axis]+1]-s.knots[axis][offset+1];
    check(span>0&&Number.isFinite(span),'singular-bicubic-derivative-span');
    const i=v*s.controlPointCount[0]+u,j=i+(axis===0?1:s.controlPointCount[0]),scale=s.degree[axis]/span;
    controlPoints.push(s.controlPoints[j].map((x:number,k:number)=>(x-s.controlPoints[i][k])*scale));
  }
  return {...s,degree,controlPointCount:counts,controlPoints,knots:s.knots.map((k:number[],i:number)=>i===axis?k.slice(1,-1):k)};
}
