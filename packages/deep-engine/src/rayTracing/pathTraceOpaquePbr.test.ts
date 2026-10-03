import {describe,expect,it} from "vitest";
import {evaluatePathTraceOpaquePbr} from "./pathTraceOpaquePbr.js";
import {samplePathTraceCpuBsdf} from "./pathTraceCpuBsdf.js";
import {createPathTraceCpuKernel} from "./pathTraceCpuKernel.js";
import {createReferenceRng} from "../lighting/probeReferenceScene.js";
import {adaptPathTraceRenderPacketMaterial} from "./pathTraceRenderPacketMaterial.js";
import type {PathTraceCpuMaterial,PathTraceRgb} from "./pathTraceCpuTypes.js";

const normal: PathTraceRgb=[0,0,1];
const pbr=(metallic=0,roughness=.6,ior=1.5):PathTraceCpuMaterial=>({model:"production-opaque-pbr",
  reflectance:[.7,.4,.2],metallic,roughness,ior});
function normalIntegral(material:PathTraceCpuMaterial,count=65536):number[] {
  const result=[0,0,0];
  for(let i=0;i<count;i++){
    const nl=(i+.5)/count,l:PathTraceRgb=[Math.sqrt(1-nl*nl),0,nl];
    const rgb=evaluatePathTraceOpaquePbr(material,normal,normal,l).cosineRgb;
    for(let c=0;c<3;c++)result[c]!+=rgb[c]!*2*Math.PI/count;
  }
  return result;
}
const mean=(material:PathTraceCpuMaterial,samples:number,seed=7)=>{
  const rng=createReferenceRng(seed),sum=[0,0,0];
  for(let i=0;i<samples;i++){
    const s=samplePathTraceCpuBsdf(material,normal,normal,rng);
    if(s)for(let c=0;c<3;c++)sum[c]!+=s.weight[c]!/samples;
  }
  return sum;
};
function kernel(material:PathTraceCpuMaterial) {
  return createPathTraceCpuKernel({width:1,height:1,blas:{id:"plane",vertices:new Float32Array(
    [-1e6,-1e6,0,1e6,-1e6,0,0,1e6,0]),indices:new Uint32Array([0,1,2])},materials:[material],
    camera:{origin:[0,0,1],target:[0,0,0],up:[0,1,0],verticalFovDegrees:.001},
    environment:[1,1,1],rouletteStart:64,maxBounces:1});
}

describe("production opaque PBR mixture transport",()=>{
  it.each([0,.5,1])("supports actual stock metallic %s with default/custom IOR and rough floor",metallic=>{
    const input={id:"stock",baseColor:[.7,.4,.2] as const,metallic,roughness:0,doubleSided:true};
    expect(adaptPathTraceRenderPacketMaterial(input)).toMatchObject({model:"production-opaque-pbr",metallic,ior:1.5});
    expect(adaptPathTraceRenderPacketMaterial({...input,ior:2})).toMatchObject({ior:2});
    const a=kernel(pbr(metallic,0)),b=kernel(pbr(metallic,.045));
    for(let i=0;i<64;i++)expect(a.traceSample(0,0,i,17)).toEqual(b.traceSample(0,0,i,17));
  });
  it("uses the total BSDF and total PDF for both sampling branches",()=>{
    const material=pbr(.5),rng=createReferenceRng(5);
    let accepted=0,rejected=0;
    for(let i=0;i<4096;i++){
      const s=samplePathTraceCpuBsdf(material,normal,normal,rng);
      if(!s){rejected++;continue;}
      const evaluated=evaluatePathTraceOpaquePbr(material,normal,normal,s.direction);
      for(let c=0;c<3;c++)expect(s.weight[c]).toBeCloseTo(evaluated.cosineRgb[c]!/evaluated.pdf,13);
      accepted++;
    }
    expect(accepted).toBeGreaterThan(1000);expect(rejected).toBeGreaterThan(0);
  });
  it("keeps rejected NDF probability mass instead of resampling it",()=>{
    const material=pbr(1,1),rng=createReferenceRng(13),count=65536;
    let accepted=0;for(let i=0;i<count;i++)if(samplePathTraceCpuBsdf(material,normal,normal,rng))accepted++;
    // At alpha=1 and normal view, half the GGX branch reflects below the surface; cosine always survives.
    expect(Math.abs(accepted/count-.75)).toBeLessThan(.007);
    const evaluated=evaluatePathTraceOpaquePbr(material,normal,normal,[0,0,1]);
    expect(evaluated.pdf).toBeCloseTo(.5/Math.PI+.5/(4*Math.PI),14);
  });
  it.each([0,.5,1])("matches normal-view numerical single+multiple integral at metallic %s",metallic=>{
    const material=pbr(metallic,1),expected=normalIntegral(material),actual=mean(material,65536);
    for(let c=0;c<3;c++)expect(Math.abs(actual[c]!-expected[c]!)).toBeLessThan(.006);
    console.info("I16 production PBR furnace",{metallic,expected,actual});
  });
  it("includes positive C8 multiple scattering for rough full metal",()=>{
    const r=evaluatePathTraceOpaquePbr(pbr(1,1),normal,normal,[.6,0,.8]);
    expect(Math.min(...r.multiple)).toBeGreaterThan(0);
    expect(r.cosineRgb[0]).toBe(r.single[0]!+r.multiple[0]!);
  });
  it("converges and replays the real integrator across fixed seeds",()=>{
    const material=pbr(.5,1),expected=normalIntegral(material)[0]!,trace=kernel(material);
    const rmse=(spp:number)=>Math.sqrt(Array.from({length:16},(_,seed)=>{
      let total=0;for(let i=0;i<spp;i++)total+=trace.traceSample(0,0,i,seed)[0]/spp;
      return (total-expected)**2;
    }).reduce((a,b)=>a+b)/16);
    const low=rmse(16),high=rmse(4096);
    console.info("I16 production PBR convergence",{expected,low,high});
    expect(high).toBeLessThan(.01);expect(high).toBeLessThan(low/4);
    const result=trace.traceSample(0,0,123,17);trace.traceSample(0,0,122,9);
    expect(trace.traceSample(0,0,123,17)).toEqual(result);
  });
  it("preserves base IOR and mixed-metal numeric domains",()=>{
    const input={id:"stock",baseColor:[.7,.4,.2] as const,metallic:.5,roughness:.6,doubleSided:true};
    for(const metallic of [-.1,1.1,NaN])expect(()=>adaptPathTraceRenderPacketMaterial({...input,metallic})).toThrow();
    for(const ior of [.5,NaN,Infinity])expect(()=>adaptPathTraceRenderPacketMaterial({...input,ior})).toThrow();
    const low=evaluatePathTraceOpaquePbr(pbr(0,.6,1),normal,normal,normal);
    const high=evaluatePathTraceOpaquePbr(pbr(0,.6,2),normal,normal,normal);
    expect(high.single[0]).toBeGreaterThan(low.single[0]!);
    expect(high.multiple[0]).toBeGreaterThan(low.multiple[0]!);
  });
});
