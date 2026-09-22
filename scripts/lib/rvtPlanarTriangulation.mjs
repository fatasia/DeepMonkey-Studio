import {createRequire} from 'node:module';
const requireWeb=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const {ShapeUtils,Vector2}=requireWeb('three');
// Earcut may emit a near-zero cap triangle at a numerically collinear source
// vertex. Triangulate the reduced loop, then split its boundary triangle so
// every original coedge and source vertex remains conforming.
export function triangulateSourceLoops(ordered,project){
  const nearLine=(a,b,c)=>{
    const x=c[0]-a[0],y=c[1]-a[1],length=Math.hypot(x,y);
    return length>0&&Math.abs(x*(b[1]-a[1])-y*(b[0]-a[0]))/length<=1e-7&&(b[0]-a[0])*(b[0]-c[0])+(b[1]-a[1])*(b[1]-c[1])<=0;
  };
  const reduced=ordered.map(loop=>{const ids=[...loop];let changed=true;
    while(changed&&ids.length>3){changed=false;const points=project(ids);
      for(let i=0;i<ids.length;i++)if(nearLine(points[(i+ids.length-1)%ids.length],points[i],points[(i+1)%ids.length])){ids.splice(i,1);changed=true;break;}}
    return ids;
  });
  // Quantize only the 2D predicate coordinates, not retained source vertices.
  // 1e-7 ft is the existing source-join tolerance (0.00003048 mm).
  const points=reduced.map(loop=>project(loop).map(p=>p.map(x=>Math.round(x/1e-7)*1e-7))),flat=reduced.flat();
  const triangles=ShapeUtils.triangulateShape(points[0].map(p=>new Vector2(...p)),points.slice(1).map(l=>l.map(p=>new Vector2(...p)))).map(t=>t.map(i=>flat[i]));
  for(let loopIndex=0;loopIndex<ordered.length;loopIndex++){
    const loop=ordered[loopIndex],simple=reduced[loopIndex];
    for(let i=0;i<simple.length;i++){
      const a=simple[i],b=simple[(i+1)%simple.length],chain=[a];let at=loop.indexOf(a);
      do{at=(at+1)%loop.length;chain.push(loop[at]);if(chain.length>loop.length+1)throw Error('boundary split cycle');}while(loop[at]!==b);
      if(chain.length===2)continue;
      const matches=triangles.map((t,index)=>t.includes(a)&&t.includes(b)?index:-1).filter(i=>i>=0);
      if(matches.length!==1)throw Error('triangulation omitted source boundary');
      const index=matches[0],t=triangles[index],opposite=t.find(v=>v!==a&&v!==b);
      if(t[(t.indexOf(a)+1)%3]!==b)chain.reverse();
      triangles.splice(index,1,...chain.slice(0,-1).map((v,j)=>[v,chain[j+1],opposite]));
    }
  }
  return triangles;
}
