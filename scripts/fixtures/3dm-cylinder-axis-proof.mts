const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
function check(v:unknown,m:string):asserts v {if(!v)throw new Error(m);}
/** Prove that inserted linear-axis knots preserve one affine translation, without changing the source. */
export function proveCylinderAxis(s:any,linear:number) {
  const curved=1-linear,count=s.controlPointCount[linear],width=s.controlPointCount[0],knots:number[]=s.knots[linear];
  check(s.degree[linear]===1&&count>=2&&count<=4096&&knots.length===count+2
    &&knots.every(Number.isFinite)&&knots[0]===knots[1]&&knots.at(-1)===knots.at(-2)
    &&knots.slice(1,-2).every((k,i)=>k<knots[i+2])
    &&s.domain[linear][0]===knots[1]&&s.domain[linear][1]===knots[count],'unsupported-cylinder-axis-knots');
  const cv=(row:number,i:number)=>s.controlPoints[linear===1?row*width+i:i*width+row];
  const weight=(p:number[])=>s.rational?p[3]:1;
  const decode=(p:number[])=>p.slice(0,3).map(x=>x/weight(p));
  const origin=decode(cv(0,0)),last=decode(cv(count-1,0)),translation=last.map((x,i)=>x-origin[i]);
  let minWeight=Infinity,maxNumeratorDifference=0,maxWeightDifference=0,maxIdealRadius=0;
  for(let i=0;i<s.controlPointCount[curved];i++)for(let row=0;row<count;row++) {
    const p=cv(row,i),w=weight(p),base=cv(0,i),wBase=weight(base),t=(knots[row+1]-knots[1])/(knots[count]-knots[1]);
    check(p.every(Number.isFinite)&&w>0&&Number.isFinite(wBase)&&wBase>0,'invalid-cylinder-axis-control');
    const ideal=decode(base).map((x,j)=>x-origin[j]+translation[j]*t);
    const numerator=p.slice(0,3).map((x,j)=>x-origin[j]*w);
    maxNumeratorDifference=Math.max(maxNumeratorDifference,distance(numerator,ideal.map(x=>x*wBase)));
    maxWeightDifference=Math.max(maxWeightDifference,Math.abs(w-wBase));
    maxIdealRadius=Math.max(maxIdealRadius,Math.hypot(...ideal));minWeight=Math.min(minWeight,w);
  }
  // Positive basis functions partition unity. Bound homogeneous numerator and denominator separately.
  const arithmeticGuard=128*Number.EPSILON*Math.max(1,maxIdealRadius);
  const equivalenceBound=(maxNumeratorDifference+maxIdealRadius*maxWeightDifference)/minWeight+arithmeticGuard;
  check(Number.isFinite(equivalenceBound)&&equivalenceBound<=1e-9,'non-affine-cylinder-axis');
  return {translation,equivalenceBound,segments:count-1};
}
