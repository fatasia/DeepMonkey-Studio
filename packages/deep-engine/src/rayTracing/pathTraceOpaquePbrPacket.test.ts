import {describe,expect,it} from "vitest";
import {createPathTraceRenderPacketKernel} from "./pathTraceRenderPacketKernel.js";
import {PathTraceCpuRender} from "./pathTraceCpuRender.js";
import {decodeRadianceHdr} from "../textures/radianceHdr.js";
import type {RenderPacket} from "../renderPacketTypes.js";
import type {RuntimeSceneCamera} from "../runtimePackage/types.js";
const identity={sceneRevision:1,materialHash:"pbr-.5",cameraHash:"normal"};
const camera:RuntimeSceneCamera={schema:"deep-engine.scene-camera",schemaVersion:1,id:"pt-camera",revision:1,
  position:[0,0,3],target:[0,0,0],verticalFovDegrees:1,near:.1,far:10};
const packet=(metallic=.5):RenderPacket=>({geometries:[{id:"wall",revision:1,
  vertices:new Float32Array([-1e5,-1e5,0,0,0,1,1e5,-1e5,0,0,0,1,0,1e5,0,0,0,1]),indices:new Uint32Array([0,1,2])}],
  materials:[{id:"pbr",baseColor:[.8,.4,.2],metallic,roughness:1,ior:1.5,doubleSided:true}],
  instances:[{id:"wall-1",geometry:"wall",material:"pbr",transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]});
const kernel=(metallic=.5)=>createPathTraceRenderPacketKernel({packet:packet(metallic),camera,width:1,height:1,
  environment:[1,1,1],rouletteStart:64,maxBounces:1});
const config={width:1,height:1,maxSamples:16384,minSamples:64,varianceThreshold:.02,maxAccumulationBytes:24,sampleSeed:19};
describe("authored packet production PBR consumption",()=>{
  it("renders real dielectric/mixed/full-metal packets with explicit production profile",()=>{
    for(const metallic of [0,.5,1]){
      const trace=kernel(metallic);expect(trace.profile).toBe("production-opaque-two-sided-pbr-single-and-multiple");
      for(let i=0;i<128;i++)expect(trace.traceSample(0,0,i,19).every(Number.isFinite)).toBe(true);
    }
  });
  it("accumulates async samples and exports actual HDR against independent PBR integral",async()=>{
    const render=new PathTraceCpuRender(config);render.begin(identity,kernel());
    expect(()=>render.exportHdr()).toThrow(/convergence/);
    let yields=0;await render.advanceAsync(16384,async()=>{yields++;});
    expect(yields).toBe(16383);expect(render.converged).toBe(true);
    const expected=[.5450609106424684,.27005523499793294,.13747006084036667];
    const output=render.exportHdr(),image=decodeRadianceHdr(output.bytes);
    for(let c=0;c<3;c++)expect(Math.abs(image.data[c]!-expected[c]!)).toBeLessThan(.007);
    expect(output.receipt.sampleCount).toBe(16384);expect(render.session.residentBytes).toBe(0);
    console.info("I16 packet PBR actual HDR",{expected,decoded:[...image.data],bytes:output.bytes.length,receipt:output.receipt});
  });
  it("replays the same seeded packet pixels across batch partitions",()=>{
    const a=new PathTraceCpuRender(config),b=new PathTraceCpuRender(config);
    a.begin(identity,kernel());b.begin(identity,kernel());a.advance(128);b.advance(3);b.advance(17);b.advance(108);
    expect(a.image().data).toEqual(b.image().data);expect(a.session.sampleCount).toBe(b.session.sampleCount);
    a.dispose();b.dispose();
  });
  it("cancels between async samples without exporting old generation",async()=>{
    const abort=new AbortController(),render=new PathTraceCpuRender(config);render.begin(identity,kernel(),abort.signal);
    await render.advanceAsync(128,async()=>abort.abort(),abort.signal);
    expect(render.session.phase).toBe("cancelled");expect(render.session.residentBytes).toBe(0);
    expect(()=>render.image()).toThrow();expect(()=>render.exportHdr()).toThrow();
  });
  it("keeps unsupported texture/layer/alpha/single-side rejection",()=>{
    const variants=[{baseColorTexture:{texture:"authored"}},{layered:{}},{alphaMode:"BLEND"},{doubleSided:false}];
    for(const extra of variants){const input=packet();
      expect(()=>createPathTraceRenderPacketKernel({packet:{...input,materials:[{...input.materials[0]!,...extra}]},
        camera,width:1,height:1,environment:[1,1,1]})).toThrow();
    }
  });
});
