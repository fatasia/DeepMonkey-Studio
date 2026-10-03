import {describe,expect,it} from "vitest";
import {createPathTraceCpuTransport,type PathTraceCpuSurfaceQuery} from "./pathTraceCpuTransport.js";
import type {PathTraceCpuMaterial,PathTraceRgb} from "./pathTraceCpuTypes.js";
const unit=(v:number[]):[number,number,number]=>{const length=Math.hypot(...v);return v.map(x=>x/length) as [number,number,number];};
const rho=.8,material:PathTraceCpuMaterial={model:"lambert",reflectance:[rho,rho,rho]};
function plane(normal:PathTraceRgb,record?:number[][],bsdf=material):PathTraceCpuSurfaceQuery {
  return query=>{record?.push([query.ox,query.oy,query.oz,query.dx,query.dy,query.dz]);
    const t=-query.oz/query.dz;
    return t>=0&&t<=query.tMax?{t,normal,geometricNormal:[0,0,1],material:bsdf}:undefined;
  };
}
const kernel=(normal:PathTraceRgb,environment:PathTraceRgb|((d:PathTraceRgb)=>PathTraceRgb)=[1,1,1],back=false)=>
  createPathTraceCpuTransport({width:1,height:1,camera:{origin:[0,0,back?-1:1],target:[0,0,0],up:[0,1,0],verticalFovDegrees:.001},
    environment,maxBounces:1,rouletteStart:64},plane(normal));
const mean=(trace:ReturnType<typeof kernel>,count=65536)=>{
  let sum=0,correction=0;for(let i=0;i<count;i++){
    const value=trace.traceSample(0,0,i,19)[0]-correction,next=sum+value;
    correction=(next-sum)-value;sum=next;
  }return sum/count;
};
describe("radiance shading normals retain geometric reflection support",()=>{
  it.each([0,30,60,85])("matches independent clipped Lambert furnace at %s degrees",angle=>{
    const radians=angle*Math.PI/180,normal:[number,number,number]=[Math.sin(radians),0,Math.cos(radians)];
    const expected=rho*(1+normal[2])/2,actual=mean(kernel(normal));
    expect(Math.abs(actual-expected)).toBeLessThan(.005);expect(actual).toBeLessThanOrEqual(rho);
    console.info("I16 tilted Lambert furnace",{angle,expected,actual,error:Math.abs(actual-expected)});
  });
  it("does not leak geometric backside-only environment through strongly tilted normals",()=>{
    const trace=kernel(unit([1,0,.1]),direction=>direction[2]<0?[100,100,100]:[0,0,0]);
    for(let i=0;i<65536;i++)expect(trace.traceSample(0,0,i,19)).toEqual([0,0,0]);
  });
  it("orients both normals together for real double-sided backface radiance",()=>{
    const normal=unit([1,0,.1]),front=mean(kernel(normal)),back=mean(kernel(normal,[1,1,1],true));
    const expected=rho*(1+normal[2])/2;
    expect(Math.abs(front-expected)).toBeLessThan(.005);expect(Math.abs(back-expected)).toBeLessThan(.005);
    console.info("I16 strong-normal double-sided furnace",{front,back,expected});
  });
  it("uses geometric epsilon instead of displacing along the shading tangent",()=>{
    const record:number[][]=[],trace=createPathTraceCpuTransport({width:1,height:1,
      camera:{origin:[0,0,1],target:[0,0,0],up:[0,1,0],verticalFovDegrees:.001},
      environment:[1,1,1],maxBounces:1,rouletteStart:64,rayEpsilon:1e-5},plane(unit([1,0,.1]),record));
    for(let i=0;record.length<2&&i<100;i++){record.length=0;trace.traceSample(0,0,i,19);}
    expect(record.length).toBe(2);
    const a=record[0]!,b=record[1]!,t=-a[2]!/a[5]!;
    expect(b[0]!-(a[0]!+a[3]!*t)).toBe(0);expect(b[1]!-(a[1]!+a[4]!*t)).toBe(0);
    expect(b[2]).toBe(1e-5);
  });
  it("returns zero when a valid geometric view is below the shading hemisphere",()=>{
    const trace=createPathTraceCpuTransport({width:1,height:1,camera:{origin:[-5,0,1],target:[0,0,0],up:[0,1,0],verticalFovDegrees:.001},
      environment:[1,1,1],maxBounces:1,rouletteStart:64},plane(unit([5,0,1])));
    for(let i=0;i<128;i++)expect(trace.traceSample(0,0,i,19)).toEqual([0,0,0]);
  });
  it("keeps flat legacy reference normals and seed consumption exactly unchanged",()=>{
    const options={width:1,height:1,camera:{origin:[0,0,1] as const,target:[0,0,0] as const,up:[0,1,0] as const,verticalFovDegrees:.001},
      environment:[1,1,1] as const,maxBounces:1,rouletteStart:64};
    const query=plane([0,0,1]),a=createPathTraceCpuTransport(options,query),b=createPathTraceCpuTransport(options,q=>{
      const hit=query(q);if(!hit)return;const {geometricNormal:_,...legacy}=hit;return legacy;
    });
    for(let i=0;i<1024;i++)expect(a.traceSample(0,0,i,19)).toEqual(b.traceSample(0,0,i,19));
  });
  it.each([[60,[.4486019366413083,.2232196271181554,.1144123559663043]],
    [85,[.39771751862719923,.20134113288874425,.10480677554090664]]])
    ("matches independent production-source angular PBR integral at %s degrees",(angle,expected)=>{
      // Goldens independently integrate stock CPU source+C8 WGSL over the geometric hemisphere.
      const theta=(angle as number)*Math.PI/180,normal:[number,number,number]=[Math.sin(theta),0,Math.cos(theta)];
      const bsdf:PathTraceCpuMaterial={model:"production-opaque-pbr",reflectance:[.8,.4,.2],metallic:.5,roughness:1,ior:1.5};
      const trace=createPathTraceCpuTransport({width:1,height:1,camera:{origin:[0,0,1],target:[0,0,0],up:[0,1,0],verticalFovDegrees:.001},
        environment:[1,1,1],maxBounces:1,rouletteStart:64},plane(normal,undefined,bsdf)),actual=[0,0,0],count=65536;
      for(let i=0;i<count;i++){const rgb=trace.traceSample(0,0,i,19);for(let c=0;c<3;c++)actual[c]!+=rgb[c]!/count;}
      for(let c=0;c<3;c++)expect(Math.abs(actual[c]!-(expected as number[])[c]!)).toBeLessThan(.006);
    });
});
