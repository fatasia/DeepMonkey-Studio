type Net={knots:number[],points:number[][]};
function check(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
/** Homogeneous Boehm insertion; common knots change the basis, never the represented source curve. */
export function commonKnotBasis(degree:number,a:Net,b:Net){
  check(Number.isInteger(degree)&&degree>=1&&degree<=8&&[a,b].every(net=>net.points.length<=256&&net.points.length>degree
    &&net.knots.length===net.points.length+degree+1&&net.knots.every((x,i)=>Number.isFinite(x)&&(!i||x>=net.knots[i-1]))
    &&net.knots.slice(0,degree+1).every(x=>x===0)&&net.knots.slice(-degree-1).every(x=>x===1)
    &&net.points.every(p=>p.length===4&&p.every(Number.isFinite)&&p[3]>0)),'invalid-common-knot-source');
  const multiplicity=(knots:number[],t:number)=>knots.filter(x=>x===t).length;
  const values=[...new Set([...a.knots,...b.knots])].filter(t=>t>0&&t<1).sort((x,y)=>x-y);
  check(values.length<=128,'common-knot-budget');
  const target=values.map(t=>({t,count:Math.max(multiplicity(a.knots,t),multiplicity(b.knots,t))}));
  check(target.every(x=>x.count<=degree),'discontinuous-common-knot');
  const refine=(source:Net)=>{let points=source.points.map(p=>[...p]),knots=[...source.knots];
    for(const {t,count} of target){let m=multiplicity(knots,t);
      while(m<count){check(points.length<256,'common-knot-budget');let k=degree;while(k+1<knots.length&&knots[k+1]<=t)k++;
        const next:number[][]=[],n=points.length-1;
        for(let i=0;i<=k-degree;i++)next[i]=points[i];
        for(let i=k-m;i<=n;i++)next[i+1]=points[i];
        for(let i=k-degree+1;i<=k-m;i++){const denominator=knots[i+degree]-knots[i];check(denominator>0,'singular-common-knot');
          const f=(t-knots[i])/denominator;check(f>=0&&f<=1,'invalid-common-knot-blend');next[i]=points[i-1].map((x,j)=>(1-f)*x+f*points[i][j]);}
        points=next;knots.splice(k+1,0,t);m++;
      }
    }
    check(points.every(p=>p.length===4&&p.every(Number.isFinite)&&p[3]>0),'invalid-common-knot-control');return {knots,points};
  };
  return [refine(a),refine(b)] as const;
}
