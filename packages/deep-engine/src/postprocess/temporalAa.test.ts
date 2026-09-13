import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { TemporalAaPass } from "./temporalAa.js";
import { resolveTemporalAaCpu, temporalAaJitter } from "./temporalAaCpu.js";
import { TEMPORAL_AA_WGSL } from "./temporalAaWgsl.js";

const options = { feedback: 0.9, depthThreshold: 0.1, relativeDepthThreshold: 0.02 } as const;
function cpu(historyValid = false, depth = [4, 4]) { return { width: 2, height: 1, color: [1,0,0,1, .25,0,0,1], depth, motion: [0,0,-.5,0],
  previousColor: [1,0,0,1, 0,0,0,1], previousDepth: [4,4], currentJitter: [0,0] as const, previousJitter: [0,0] as const, historyValid }; }
function texture(width: number, height: number, format: GPUTextureFormat) { const value = { width,height,format,dimension:"2d",depthOrArrayLayers:1,sampleCount:1,usage:GPUTextureUsage.TEXTURE_BINDING,
  createView:vi.fn(()=>({})),destroy:vi.fn() }; return value as unknown as GPUTexture & {destroy:ReturnType<typeof vi.fn>}; }
function fixture() { const owned=new Set<GPUTexture|GPUBuffer>(), outputs:Array<GPUTexture&{destroy:ReturnType<typeof vi.fn>}>=[];
  const device={limits:{maxTextureDimension2D:16384,maxComputeWorkgroupsPerDimension:65535},queue:{writeBuffer:vi.fn()},createShaderModule:vi.fn(()=>({})),createBindGroupLayout:vi.fn(()=>({})),createPipelineLayout:vi.fn(()=>({})),createComputePipeline:vi.fn(()=>({})),createBindGroup:vi.fn(()=>({})),
    createTexture:vi.fn((d:GPUTextureDescriptor)=>{const s=d.size as GPUExtent3DDict,v=texture(s.width as number,s.height as number,d.format); outputs.push(v);return v;}),createBuffer:vi.fn(()=>({destroy:vi.fn()}))};
  const session={state:"ready",device,own<T extends GPUTexture|GPUBuffer>(r:T){owned.add(r);return r;},release(r:GPUTexture|GPUBuffer){if(owned.delete(r))r.destroy();}};
  return {device,session:session as unknown as DeviceSession,raw:session,owned,outputs}; }
function source(revision:number,cameraCut=false,width=2,jitter?:{currentJitter:readonly[number,number];previousJitter:readonly[number,number]}){return {color:texture(width,1,"rgba16float"),depth:texture(width,1,"r32float"),motion:texture(width,1,"rg16float"),revision,cameraCut,colorEncoding:"linear-hdr" as const,depthEncoding:"linear-view-depth-positive" as const,motionEncoding:"current-to-previous-uv" as const,...jitter};}
beforeEach(()=>{vi.stubGlobal("GPUShaderStage",{COMPUTE:1});vi.stubGlobal("GPUTextureUsage",{TEXTURE_BINDING:1,STORAGE_BINDING:2,COPY_SRC:4});vi.stubGlobal("GPUBufferUsage",{STORAGE:1,COPY_DST:2});}); afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe("temporal AA",()=>{
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("is Naga-valid",()=>{const r=spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,["--stdin-file-path","deep-taa.wgsl","--input-kind","wgsl"],{input:TEMPORAL_AA_WGSL,encoding:"utf8"});expect(r.status,r.stderr).toBe(0);});
  it("provides Halton 2/3 jitter and CPU first-frame/motion/depth rejection",()=>{
    expect(temporalAaJitter(0)[0]).toBe(0); expect(temporalAaJitter(0)[1]).toBeCloseTo(-1/6, 15); expect(temporalAaJitter(1)[0]).toBe(-.25);
    expect(Array.from(resolveTemporalAaCpu(cpu(false),options))).toEqual(cpu(false).color);
    const moved=resolveTemporalAaCpu(cpu(true),options); expect(moved[4]).toBeCloseTo(.925,5);
    const rejected=resolveTemporalAaCpu(cpu(true,[4,8]),options); expect(rejected[4]).toBeCloseTo(.25,5);
    const jittered={...cpu(true),motion:[0,0,0,0],currentJitter:[.5,0] as const,previousJitter:[-.5,0] as const};
    expect(resolveTemporalAaCpu(jittered,options)[4]).toBeCloseTo(.925,5);
  });
  it("uses explicit pixel jitter and uploads the exact current/previous pair",()=>{const f=fixture(),pass=new TemporalAaPass(f.session),p={beginComputePass:()=>({setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}})} as GPUCommandEncoder;
    const callerJitter:[number,number]=[.25,-.25];
    const first=pass.encode(p,source(0,false,2,{currentJitter:callerJitter,previousJitter:[0,0]}),options); callerJitter[0]=0;
    expect(first).toMatchObject({jitter:[.25,-.25],previousJitter:[0,0],historyUsed:false});
    const second=pass.encode(p,source(1,false,2,{currentJitter:[-.25,.25],previousJitter:[.25,-.25]}),options);
    expect(second).toMatchObject({jitter:[-.25,.25],previousJitter:[.25,-.25],historyUsed:true});
    const packed=f.device.queue.writeBuffer.mock.calls.at(-1)![2] as ArrayBuffer;
    expect([...new Float32Array(packed).slice(4,8)]).toEqual([-.25,.25,.25,-.25]); pass.dispose();
  });
  it("ping-pongs history, invalidates cuts/gaps/resizes, and disposes",()=>{const f=fixture(),pass=new TemporalAaPass(f.session),p={beginComputePass:()=>({setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}})} as GPUCommandEncoder;
    const a=pass.encode(p,source(0),options),b=pass.encode(p,source(1),options);expect(a.historyUsed).toBe(false);expect(b.historyUsed).toBe(true);expect(b.texture).not.toBe(a.texture);
    expect(pass.encode(p,source(3),options)).toMatchObject({historyUsed:false,historyInvalidation:"revision-gap"});expect(pass.encode(p,source(4,true),options)).toMatchObject({historyUsed:false,historyInvalidation:"camera-cut"});
    expect(pass.encode(p,source(5,false,4),options)).toMatchObject({historyUsed:false,historyInvalidation:"resize"}); pass.dispose();pass.dispose();expect(f.owned.size).toBe(0);
  });
  it("rolls back failed resize allocation without advancing history",()=>{const f=fixture(),pass=new TemporalAaPass(f.session),p={beginComputePass:()=>({setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}})} as GPUCommandEncoder;
    const first=pass.encode(p,source(0),options);f.device.createTexture.mockImplementationOnce(()=>{throw new Error("TAA allocation failed");});
    expect(()=>pass.encode(p,source(1,false,4),options)).toThrow("TAA allocation failed");expect(first.texture.destroy).not.toHaveBeenCalled();
    expect(pass.encode(p,source(1),options)).toMatchObject({historyUsed:true,historyInvalidation:null});pass.dispose();expect(f.owned.size).toBe(0);
  });
  it("fails closed after loss",()=>{const f=fixture(),pass=new TemporalAaPass(f.session),p={beginComputePass:()=>({setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}})} as GPUCommandEncoder;pass.encode(p,source(0),options);f.raw.state="lost";expect(()=>pass.encode(p,source(1),options)).toThrow("not ready");expect(f.owned.size).toBe(0);});
  it("fails closed on ambiguous encodings, formats, usage, dimensions, revisions, and tuning",()=>{const f=fixture(),pass=new TemporalAaPass(f.session),p={beginComputePass:()=>({setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}})} as GPUCommandEncoder,valid=source(0);
    expect(()=>pass.encode(p,{...valid,colorEncoding:"srgb" as never},options)).toThrow("explicit linear HDR");
    expect(()=>pass.encode(p,{...valid,color:texture(2,1,"rgba8unorm")},options)).toThrow("rgba16float");
    expect(()=>pass.encode(p,{...valid,motion:texture(2,1,"rg32float")},options)).toThrow("rg16float");
    const unusable={...texture(2,1,"r32float"),usage:0};expect(()=>pass.encode(p,{...valid,depth:unusable},options)).toThrow("TEXTURE_BINDING");
    expect(()=>pass.encode(p,{...valid,depth:texture(1,1,"r32float")},options)).toThrow("dimensions");
    expect(()=>pass.encode(p,{...valid,revision:-1},options)).toThrow("revision");expect(()=>pass.encode(p,valid,{...options,feedback:1})).toThrow("feedback");
    expect(()=>pass.encode(p,{...valid,currentJitter:[0,0]},options)).toThrow("supplied together");
    expect(()=>pass.encode(p,{...valid,currentJitter:[NaN,0],previousJitter:[0,0]},options)).toThrow("finite pixel offsets");
    expect(()=>pass.encode(p,{...valid,currentJitter:[.51,0],previousJitter:[0,0]},options)).toThrow("[-0.5, 0.5]");
    expect(()=>resolveTemporalAaCpu({...cpu(false),currentJitter:[Infinity,0]},options)).toThrow("currentJitter");
  });
});
