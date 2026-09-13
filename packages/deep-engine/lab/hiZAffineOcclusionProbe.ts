/// <reference types="@webgpu/types" />
import { HiZOcclusionCuller, HiZPyramid, packCullingInstances, type DeviceSession } from "@bim-studio/deep-engine/webgpu";
import { HI_Z_AFFINE_DEPTH_REGION, HI_Z_AFFINE_REPEATS, HI_Z_AFFINE_VIEW, hiZAffineProbeCases } from "./hiZAffineProbeScene.js";

export const HI_Z_AFFINE_DEPTH_WGSL = /* wgsl */ `
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.3, 1.0);
}`;

export interface HiZAffineOcclusionResult {
  readonly cases: readonly string[];
  readonly visibleCounts: readonly number[];
  readonly expectedCounts: readonly number[];
  readonly indirectCount: number;
  readonly passed: boolean;
}

/** Raster depth + production pyramid/culler: rotation must not pull clear pixels into its test rectangle. */
export async function runHiZAffineOcclusionProbe(session: DeviceSession): Promise<HiZAffineOcclusionResult> {
  const device = session.device, cases = hiZAffineProbeCases();
  const instances = cases.flatMap(item => Array.from({ length: HI_Z_AFFINE_REPEATS }, () => item.instance));
  const owned: Array<GPUBuffer | GPUTexture> = [];
  const own = <T extends GPUBuffer | GPUTexture>(resource: T): T => { owned.push(session.own(resource)); return resource; };
  const pyramid = new HiZPyramid(session), culler = new HiZOcclusionCuller(session);
  try {
    const depth = own(device.createTexture({ label: "Deep Hi-Z affine depth", size: [64, 64, 1], format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    const instanceBuffer = own(device.createBuffer({ label: "Deep Hi-Z affine instances", size: instances.length * 144,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
    const boundsBuffer = own(device.createBuffer({ label: "Deep Hi-Z affine bounds", size: instances.length * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
    const readback = own(device.createBuffer({ label: "Deep Hi-Z affine readback", size: 24 + instances.length * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    const packed = new Float32Array(packCullingInstances(instances)), bounds = new Float32Array(instances.flatMap(item => [...item.bounds]));
    cases.forEach((item, group) => {
      for (let repeat = 0; repeat < HI_Z_AFFINE_REPEATS; repeat++) {
        const index = group * HI_Z_AFFINE_REPEATS + repeat;
        if (item.invalid === "nan-model") packed[index * 36] = NaN;
        if (item.invalid === "infinite-bound") bounds[index * 4 + 3] = Infinity;
        if (item.invalid === "negative-bound") bounds[index * 4 + 3] = -.1;
      }
    });
    device.queue.writeBuffer(instanceBuffer, 0, packed);
    device.queue.writeBuffer(boundsBuffer, 0, bounds);
    const pipeline = device.createRenderPipeline({ label: "Deep Hi-Z affine occluder", layout: "auto",
      vertex: { module: device.createShaderModule({ label: "Deep Hi-Z affine occluder WGSL", code: HI_Z_AFFINE_DEPTH_WGSL }), entryPoint: "vertex" },
      primitive: { topology: "triangle-list" }, depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" } });
    const encoder = device.createCommandEncoder({ label: "Deep Hi-Z affine verification" });
    const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
      view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    pass.setPipeline(pipeline); pass.setScissorRect(...HI_Z_AFFINE_DEPTH_REGION); pass.draw(3); pass.end();
    const hierarchy = pyramid.encode(encoder, { texture: depth, revision: 0 }, { reversedZ: false });
    const result = culler.encode(encoder, { instances: instanceBuffer, bounds: boundsBuffer, count: instances.length, revision: 0, indexCount: 3 },
      { viewProjection: HI_Z_AFFINE_VIEW, cameraPosition: [0, 0, 5], viewport: [64, 64], hiz: hierarchy, reversedZ: false }, { temporal: false });
    if (result.mode !== "indirect") throw new Error("Hi-Z affine probe requires indirect execution.");
    encoder.copyBufferToBuffer(result.visibleCount, 0, readback, 0, 4);
    encoder.copyBufferToBuffer(result.indirect, 0, readback, 4, 20);
    encoder.copyBufferToBuffer(result.visibleIndices, 0, readback, 24, instances.length * 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(readback.getMappedRange().slice(0)); readback.unmap();
    const count = words[0]!, indirectCount = words[2]!, visibleCounts = cases.map(() => 0);
    const ids = Array.from(words.slice(6, 6 + count));
    for (const id of ids) if (id < instances.length) visibleCounts[Math.floor(id / HI_Z_AFFINE_REPEATS)]!++;
    const expectedCounts: number[] = cases.map(item => item.visible ? HI_Z_AFFINE_REPEATS : 0);
    const passed = count === expectedCounts.reduce((a, b) => a + b, 0) && indirectCount === count
      && new Set(ids).size === count && visibleCounts.every((value, index) => value === expectedCounts[index]);
    return { cases: cases.map(item => item.name), visibleCounts, expectedCounts, indirectCount, passed };
  } finally {
    culler.dispose(); pyramid.dispose();
    for (const resource of owned.reverse()) session.release(resource);
  }
}
