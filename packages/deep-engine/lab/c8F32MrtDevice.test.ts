import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sceneShader } from "../src/webgpu/pbrShader.js";
import { prepareF32MrtObservation, decodeF32Witness } from "./c8F32MrtDevice.js";

beforeEach(() => { vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1, RENDER_ATTACHMENT: 16 }); vi.stubGlobal("GPUBufferUsage", { MAP_READ: 1, COPY_DST: 8 }); vi.stubGlobal("GPUMapMode", { READ: 1 }); });
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const events: string[] = [], createdTextures: GPUTexture[] = [], descriptors: GPURenderPipelineDescriptor[] = [];
  const passDescriptors: GPURenderPassDescriptor[] = [];
  const device = {
    limits: { maxBufferSize: 2 ** 24, maxColorAttachmentBytesPerSample: 32 }, lost: new Promise(() => {}), destroy: vi.fn(),
    createTexture(input: GPUTextureDescriptor) {
      const size = input.size as number[];
      const texture = { format: input.format, usage: input.usage, width: size[0], height: size[1], dimension: "2d", depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: input.sampleCount ?? 1,
        createView: () => ({}), destroy: vi.fn() } as unknown as GPUTexture;
      createdTextures.push(texture); return texture;
    },
    createBuffer(input: GPUBufferDescriptor) {
      const bytes = new ArrayBuffer(input.size);
      new DataView(bytes).setFloat32(0, 6.099000453948975, true);
      return { mapState: "unmapped", mapAsync: async () => { events.push("map"); }, getMappedRange: () => bytes, unmap() {}, destroy: vi.fn() };
    },
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline(input: GPURenderPipelineDescriptor) { descriptors.push(input); return {}; },
    async createRenderPipelineAsync(input: GPURenderPipelineDescriptor) { descriptors.push(input); return {}; },
    createCommandEncoder() { return {
      beginRenderPass(input: GPURenderPassDescriptor) { passDescriptors.push(input); return { setPipeline() {}, drawIndexed() {}, drawIndexedIndirect() {}, end: () => { events.push("end"); } }; },
      copyTextureToBuffer() { events.push("copy"); }, finish: () => { events.push("finish"); return {}; },
    }; }, queue: { submit() { events.push("submit"); } },
  } as unknown as GPUDevice;
  const adapter = { requestDevice: async () => device } as unknown as GPUAdapter;
  const gpu = { requestAdapter: async () => adapter } as unknown as GPU;
  return { device, gpu, events, createdTextures, descriptors, passDescriptors };
}
async function setup() {
  const f = fixture(), observer = prepareF32MrtObservation("full", f.gpu);
  expect(await (await observer.gpu.requestAdapter())!.requestDevice()).toBe(f.device);
  const module = f.device.createShaderModule({ label: "Deep PBR", code: sceneShader });
  const descriptor: GPURenderPipelineDescriptor = { label: "Deep forward PBR plain/depth/ccw", layout: "auto", vertex: { module, entryPoint: "vertexMain" },
    fragment: { module, entryPoint: "fragmentMainColor", targets: [{ format: "rgba16float" }] }, primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" }, multisample: { count: 1 } };
  const pipeline = await f.device.createRenderPipelineAsync(descriptor);
  const hdr = f.device.createTexture({ size: [320, 192], format: "rgba16float", usage: 16 }), depth = f.device.createTexture({ size: [320, 192], format: "depth32float", usage: 16 });
  const passDescriptor: GPURenderPassDescriptor = { label: "Deep HDR opaque color", colorAttachments: [{ view: hdr.createView(), loadOp: "clear", storeOp: "store" }],
    depthStencilAttachment: { view: depth.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 } };
  return { ...f, observer, pipeline, passDescriptor };
}
it("copies the actual F32 attachment after end, maps after submit, preserves native identity and restores hooks", async () => {
  const original = fixture(); const originalMethod = original.device.createCommandEncoder;
  const observation = prepareF32MrtObservation("single", original.gpu);
  await (await observation.gpu.requestAdapter())!.requestDevice(); observation.dispose();
  expect(original.device.createCommandEncoder).toBe(originalMethod);
  const f = await setup();
  const encoder = f.device.createCommandEncoder(), pass = encoder.beginRenderPass(f.passDescriptor);
  pass.setPipeline(f.pipeline); pass.drawIndexed(3); pass.end(); const buffer = encoder.finish();
  expect(f.events).toEqual(["end", "copy", "finish"]);
  f.device.queue.submit([buffer]); const snapshots = await f.observer.snapshots();
  expect(f.events).toEqual(["end", "copy", "finish", "submit", "map"]);
  expect(decodeF32Witness(snapshots[0]!)[0]).toBe(6.099000453948975);
  expect(f.observer.receipt()).toMatchObject({ qualityCertified: false, passCount: 1, submitted: 1, attachmentBytesPerSample: 24, witnessFormat: "rgba32float" });
  expect(Array.from(f.passDescriptors[0]!.colorAttachments)[0]).toBe(Array.from(f.passDescriptor.colorAttachments)[0]);
  expect(f.createdTextures[2]!.destroy).toHaveBeenCalledOnce(); f.observer.dispose(); f.observer.dispose();
  expect(f.createdTextures[0]!.destroy).not.toHaveBeenCalled();
});
it("rejects changed source, unsubmitted snapshots, incompatible pass and unobserved pipeline", async () => {
  const f = await setup();
  expect(() => f.device.createShaderModule({ label: "Deep PBR", code: sceneShader + "\n" })).toThrow("drifted");
  const encoder = f.device.createCommandEncoder();
  expect(() => encoder.beginRenderPass({ ...f.passDescriptor, colorAttachments: [...f.passDescriptor.colorAttachments, null] })).toThrow("canonical");
  const pass = encoder.beginRenderPass(f.passDescriptor);
  expect(() => pass.setPipeline({} as GPURenderPipeline)).toThrow("noncanonical");
  expect(() => encoder.finish()).toThrow("completed draw");
  await expect(f.observer.snapshots()).rejects.toThrow("submitted"); f.observer.dispose();
  expect(f.createdTextures[2]!.destroy).toHaveBeenCalledOnce();
});
it("decodes tightly packed IEEE F32 without half conversion and rejects format confusion", () => {
  const bytes = new Uint8Array(16); new DataView(bytes.buffer).setFloat32(0, 6.099000453948975, true);
  const snapshot = { frameId: "test", resourceId: "witness", width: 1, height: 1, format: "rgba32float" as const, bytesPerRow: 16, bytes };
  expect(decodeF32Witness(snapshot)[0]).toBe(6.099000453948975);
  expect(() => decodeF32Witness({ ...snapshot, format: "rgba16float" })).toThrow("format");
});
it("keeps the initial validation snapshot and names only the explicitly armed next pass", async () => {
  const f = await setup();
  function frame() {
    const encoder = f.device.createCommandEncoder(), pass = encoder.beginRenderPass(f.passDescriptor);
    pass.setPipeline(f.pipeline); pass.drawIndexed(3); pass.end(); f.device.queue.submit([encoder.finish()]);
  }
  frame();
  const name = "strict-emissive/front/exposure-0.5";
  f.observer.armFrame(name);
  expect(() => f.observer.armFrame("strict-emissive/oblique/exposure-0.5")).toThrow("pending");
  frame();
  expect(() => f.observer.armFrame(name)).toThrow("duplicate");
  const snapshots = await f.observer.snapshots();
  expect(snapshots.map(snapshot => snapshot.frameId)).toEqual(["c8-f32-1", "c8-f32-2"]);
  expect(f.observer.receipt().passes).toEqual([{ frameId: "c8-f32-1", phase: "validation" }, { frameId: "c8-f32-2", phase: "observed", name }]);
  expect(f.observer.receipt().armedFrameCount).toBe(1); f.observer.dispose();
});
