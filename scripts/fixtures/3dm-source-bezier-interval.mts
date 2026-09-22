function check(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
function split(points:number[][],t:number){let row=points;const left=[row[0]],right=[row.at(-1)!];
  while(row.length>1){row=row.slice(0,-1).map((p,i)=>p.map((x,j)=>(1-t)*x+t*row[i+1][j]));left.push(row[0]);right.unshift(row.at(-1)!);}return [left,right];}
/** Exact homogeneous de Casteljau restriction, confined to one authored C0 Bezier span. */
export function sourceBezierInterval(curve:any,domain:number[]){
  const p=curve.degree,knots=curve.knots,points=curve.controlPoints;
  check(curve.rational&&Number.isInteger(p)&&p>=1&&p<=8&&points.length<=256&&knots.length===points.length+p+1
    &&domain.length===2&&domain.every(Number.isFinite)&&domain[0]<domain[1]
    &&knots.every((x:number,i:number)=>Number.isFinite(x)&&(!i||x>=knots[i-1]))
    &&points.every((v:number[])=>v.length===4&&v.every(Number.isFinite)&&v[3]>0),'unsupported-source-bezier-interval');
  const values=[...new Set<number>(knots)];check(values.every((x,i)=>knots.filter((k:number)=>k===x).length===(i===0||i===values.length-1?p+1:p)),'non-bezier-source-interval');
  const span=values.findIndex((x,i)=>i<values.length-1&&domain[0]>=x&&domain[1]<=values[i+1]);check(span>=0,'source-interval-crosses-knot');
  const lo=values[span],hi=values[span+1];let control=points.slice(span*p,span*p+p+1);
  if(domain[1]<hi)control=split(control,(domain[1]-lo)/(hi-lo))[0];
  if(domain[0]>lo)control=split(control,(domain[0]-lo)/(domain[1]-lo))[1];
  return {...curve,controlPoints:control,knots:[...Array(p+1).fill(domain[0]),...Array(p+1).fill(domain[1])]};
}

/** Restrict a C0 chain without removing authored knots or approximating its geometry. */
export function sourceBezierChainInterval(curve:any,domain:number[]){
  check(Array.isArray(domain)&&domain.length===2&&domain.every(Number.isFinite)&&domain[0]<domain[1]
    &&Array.isArray(curve?.knots),'unsupported-source-bezier-chain-interval');
  const values=[...new Set<number>(curve.knots)];
  check(domain[0]>=values[0]&&domain[1]<=values.at(-1)!,'source-chain-interval-outside-domain');
  const boundaries=[domain[0],...values.filter(x=>x>domain[0]&&x<domain[1]),domain[1]];
  const pieces=boundaries.slice(1).map((hi,i)=>sourceBezierInterval(curve,[boundaries[i],hi]));
  const p=curve.degree;
  return {...curve,controlPoints:pieces.flatMap((piece,i)=>piece.controlPoints.slice(i?1:0)),
    knots:[...Array(p+1).fill(domain[0]),...boundaries.slice(1,-1).flatMap(x=>Array(p).fill(x)),...Array(p+1).fill(domain[1])]};
}
