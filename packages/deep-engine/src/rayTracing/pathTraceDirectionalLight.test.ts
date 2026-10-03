import {describe,expect,it} from "vitest";
import {createPathTraceCpuKernel} from "./pathTraceCpuKernel.js";
import {createPathTraceRenderPacketKernel} from "./pathTraceRenderPacketKernel.js";
import {preparePathTraceDirectionalLight,evaluatePathTraceDirect} from "./pathTraceDirectionalLight.js";
import {pathTraceStudioEnvironment} from "./pathTraceStudioEnvironment.js";
import {environmentShader} from "../webgpu/environmentShader.js";
import type {PathTraceCpuMaterial,PathTraceRgb} from "./pathTraceCpuTypes.js";
const lighting={direction:[.6,0,.8] as const,radiance:[2,3,4] as const,exposure:1,shadows:true};
const camera={origin:[0,0,3] as const,target:[0,0,0] as const,up:[0,1,0] as const,verticalFovDegrees:.001};
const material={model:"lambert" as const,reflectance:[.5,.25,.75] as const};
function kernel(blocked=false,shadows=true,light:typeof lighting|null={...lighting,shadows}) {
  const vertices=[-100,-100,0,100,-100,0,0,100,0];
  if(blocked)vertices.push(.65,-2,1,2,-2,1,2,2,1,.65,2,1);
  return createPathTraceCpuKernel({width:1,height:1,camera,environment:[0,0,0],maxBounces:1,
    blas:{id:"actual-wall",vertices:new Float32Array(vertices),indices:new Uint32Array(blocked?[0,1,2,3,4,5,3,5,6]:[0,1,2])},
    materials:blocked?[material,material,material]:[material],...(light?{lighting:light}:{})});
}
describe("compiled directional delta NEE consumes actual BVH shadows",()=>{
  it.each(["castShadow","receiveShadow"] as const)("rejects unconsumed %s overrides only in the active shadow profile",field=>{
    const packet={geometries:[{id:"wall",revision:1,vertices:new Float32Array([-100,-100,0,0,0,1,100,-100,0,0,0,1,0,100,0,0,0,1]),indices:new Uint32Array([0,1,2])}],
      materials:[{id:"m",baseColor:[.5,.25,.75] as const,roughness:1,metallic:0,doubleSided:true}],
      instances:[{id:"i",geometry:"wall",material:"m",transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],[field]:false}]};
    const options={packet,width:1,height:1,environment:[0,0,0] as const,maxBounces:1,lighting,
      camera:{schema:"deep-engine.scene-camera" as const,schemaVersion:1 as const,id:"scene.camera" as const,revision:1 as const,
        position:camera.origin,target:camera.target,verticalFovDegrees:1,near:.01,far:100}};
    expect(()=>createPathTraceRenderPacketKernel(options)).toThrow(/castShadow\/receiveShadow/);
    const allowed=createPathTraceRenderPacketKernel({...options,lighting:{...lighting,shadows:false}});
    expect(allowed.traceSample(0,0,0,18).every(value=>value>0)).toBe(true);
  });
  it("rejects light leaking through geometric backside even when authored shading normal faces the light",()=>{
    const options={packet:{geometries:[{id:"wall",revision:1,vertices:new Float32Array([-100,-100,0,.8,0,.6,100,-100,0,.8,0,.6,0,100,0,.8,0,.6]),indices:new Uint32Array([0,1,2])}],
      materials:[{id:"m",baseColor:[.5,.25,.75] as const,roughness:1,metallic:0,doubleSided:true}],
      instances:[{id:"i",geometry:"wall",material:"m",transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]},
      width:1,height:1,environment:[0,0,0] as const,maxBounces:1,lighting:{...lighting,direction:[.8,0,-.6] as const},
      camera:{schema:"deep-engine.scene-camera" as const,schemaVersion:1 as const,id:"scene.camera" as const,revision:1 as const,
        position:camera.origin,target:camera.target,verticalFovDegrees:1,near:.01,far:100}};
    const trace=createPathTraceRenderPacketKernel(options);
    for(let sample=0;sample<128;sample++)expect(trace.traceSample(0,0,sample,19)).toEqual([0,0,0]);
  });
  it("matches independent Lambert cosine and radiance without display exposure",()=>{
    const trace=kernel();
    for(let seed=0;seed<32;seed++)trace.traceSample(0,0,seed,seed).forEach((value,c)=>
      expect(value).toBeCloseTo(material.reflectance[c]!/Math.PI*.8*lighting.radiance[c]!,14));
    const exposed=kernel(false,true,{...lighting,exposure:1.55});
    expect(exposed.traceSample(0,0,0,0)).toEqual(trace.traceSample(0,0,0,0));
  });
  it("queries actual off-camera occluder and honors the compiled shadow toggle",()=>{
    for(let sample=0;sample<32;sample++){
      expect(kernel(true).traceSample(0,0,sample,18)).toEqual([0,0,0]);
      expect(kernel(true,false).traceSample(0,0,sample,18)).toEqual(kernel().traceSample(0,0,sample,18));
    }
  });
  it("preserves snapshots, zero-light seed identity and geometric light hemispheres",()=>{
    const input={...lighting,direction:[.6,0,.8] as [number,number,number],radiance:[2,3,4] as [number,number,number]};
    const prepared=preparePathTraceDirectionalLight(input)!;input.radiance.fill(0);input.direction.fill(0);
    expect(prepared.radiance).toEqual([2,3,4]);expect(prepared.direction).toEqual([.6,0,.8]);
    expect(Object.isFrozen(prepared.direction)).toBe(true);
    const zero=kernel(false,true,{...lighting,radiance:[0,0,0]}),old=kernel(false,true,null);
    const back=kernel(false,true,{...lighting,direction:[.6,0,-.8]});
    for(let i=0;i<512;i++){expect(zero.traceSample(0,0,i,31)).toEqual(old.traceSample(0,0,i,31));expect(back.traceSample(0,0,i,31)).toEqual([0,0,0]);}
  });
  it("rejects unknown or unsupported light contracts without dropping fields",()=>{
    for(const patch of [{direction:[0,0,0]},{radiance:[NaN,1,1]},{exposure:2},{shadows:1},
      {extra:true},{localLights:[{kind:"point"}]},{lightProfiles:[{}]},{localLights:{}},{lightProfiles:""}])
      expect(()=>preparePathTraceDirectionalLight({...lighting,...patch} as never)).toThrow();
  });
  it("keeps legacy conductor and diffuse analytic BRDF profiles",()=>{
    const conductor:PathTraceCpuMaterial={model:"ggx-conductor",reflectance:[.2,.5,.8],roughness:1};
    expect(evaluatePathTraceDirect(conductor,[0,0,1],[0,0,1],[0,0,1])).toEqual(conductor.reflectance.map(f0=>f0/(4*Math.PI)));
    expect(evaluatePathTraceDirect(material,[0,0,1],[0,0,1],[0,0,-1])).toEqual([0,0,0]);
  });
  it("samples actual studio incident radiance, preserving source coefficients",()=>{
    // Independent directional goldens avoid importing the implementation as its own oracle.
    expect(pathTraceStudioEnvironment([0,-1,0])).toEqual([.025,.03,.04]);
    pathTraceStudioEnvironment([1,0,0]).forEach((value,c)=>expect(value).toBeCloseTo([.05234375,.0628125,.080625][c]!,14));
    for(const snippet of ["vec3f(5.0, 4.8, 4.4)","vec3f(2.8, 3.4, 4.2)","vec3f(1.3, 1.5, 1.8)",
      "smoothstep(-0.3, 0.9, direction.y)","smoothstep(0.88, 1.0, max(edge.x, edge.y))"])
      expect(environmentShader).toContain(snippet);
    const key=[-1,1.5,1] as PathTraceRgb,normal=key.map(x=>x/Math.hypot(...key)) as unknown as PathTraceRgb;
    const skyT=(normal[1]+.3)/1.2,sky=skyT*skyT*(3-2*skyT);
    const expected=[.025+.175*sky+5,.03+.21*sky+4.8,.04+.26*sky+4.4];
    pathTraceStudioEnvironment(normal).forEach((value,c)=>expect(value).toBeCloseTo(expected[c]!,14));
  });
});
