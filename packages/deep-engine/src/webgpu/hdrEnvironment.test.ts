import { afterEach, describe, expect, it, vi } from "vitest";
import { createHdrEnvironment } from "./hdrEnvironment.js";
import { PbrReflectionArray } from "./pbrReflectionArray.js";

afterEach(() => vi.unstubAllGlobals());

describe("HDR environment GPU boundary", () => {
  it("returns a copyable HDR specular cube accepted by the production compact reflection binding", async () => {
    vi.stubGlobal("GPUTextureUsage", { COPY_SRC:1,COPY_DST:2,TEXTURE_BINDING:4,STORAGE_BINDING:8 });
    vi.stubGlobal("GPUBufferUsage", { COPY_DST:2,UNIFORM:64 });
    const pass={setPipeline:vi.fn(),setBindGroup:vi.fn(),dispatchWorkgroups:vi.fn(),end:vi.fn()};
    const device={limits:{minUniformBufferOffsetAlignment:256},queue:{writeTexture:vi.fn(),writeBuffer:vi.fn(),
      submit:vi.fn(),onSubmittedWorkDone:async()=>{}},pushErrorScope:vi.fn(),popErrorScope:async()=>null,
      createShaderModule:()=>({getCompilationInfo:async()=>({messages:[]})}),
      createComputePipelineAsync:async()=>({getBindGroupLayout:()=>({})}),createBindGroup:()=>({}),
      createSampler:()=>({}),createBuffer:()=>({}),createTexture:vi.fn((descriptor:GPUTextureDescriptor)=>{
        const size=descriptor.size as GPUExtent3DDict;
        return {width:size.width,height:size.height,depthOrArrayLayers:size.depthOrArrayLayers,
          mipLevelCount:descriptor.mipLevelCount??1,usage:descriptor.usage,format:descriptor.format,createView:vi.fn(()=>({}))};
      }),createCommandEncoder:()=>({beginComputePass:()=>pass,finish:()=>({})})};
    const session={state:"ready",device,own:(resource:unknown)=>resource,release:vi.fn()};
    const environment=await createHdrEnvironment(session as never,{width:1,height:1,data:new Float32Array([1,1,1])});
    expect(environment.specularTexture!.usage & GPUTextureUsage.COPY_SRC).toBe(1);
    expect(() => new PbrReflectionArray(session as never).get(environment)).not.toThrow();
    expect(environment.specularTexture!.createView).toHaveBeenCalledWith({dimension:"cube-array"});
  });
  it("rejects a pre-aborted request before touching the device", async () => {
    const controller = new AbortController(), reason = new Error("cancelled by caller"); controller.abort(reason);
    const device = new Proxy({}, { get: vi.fn(() => { throw new Error("device touched"); }) });
    const session = { state: "ready", device };
    await expect(createHdrEnvironment(session as never,
      { width: 1, height: 1, data: new Float32Array([1, 1, 1]) }, {}, controller.signal)).rejects.toBe(reason);
  });

  it("fails invalid quality and pixel input before allocating resources", async () => {
    const device = new Proxy({}, { get: vi.fn(() => { throw new Error("device touched"); }) });
    const session = { state: "ready", device };
    await expect(createHdrEnvironment(session as never,
      { width: 1, height: 1, data: new Float32Array([1, 1, 1]) }, { specularSize: 32 as never }))
      .rejects.toThrow("quality");
    await expect(createHdrEnvironment(session as never,
      { width: 1, height: 1, data: new Float32Array([Number.NaN, 1, 1]) }))
      .rejects.toThrow("invalid radiance");
  });
});
