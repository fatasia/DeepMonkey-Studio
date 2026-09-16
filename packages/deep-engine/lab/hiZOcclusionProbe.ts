/// <reference types="@webgpu/types" />
import { HiZOcclusionCuller, HiZPyramid, packCullingInstances, type CullingInstance,
  type DeviceSession } from "@bim-studio/deep-engine/webgpu";
import { runHiZAffineOcclusionProbe, type HiZAffineOcclusionResult } from "./hiZAffineOcclusionProbe.js";

export interface HiZOcclusionProbeResult {
  readonly inputCount: number;
  readonly visibleCount: number;
  readonly indirectCount: number;
  readonly expectedVisibleCount: number;
  readonly peakResourceCount: number;
  readonly affine: HiZAffineOcclusionResult;
  readonly passed: boolean;
}

/** Standalone real-device composition probe; it never enters the renderer frame loop. */
export async function runHiZOcclusionProbe(session: DeviceSession, inputCount = 128): Promise<HiZOcclusionProbeResult> {
  if (session.state !== "ready") throw new Error("Hi-Z occlusion probe requires a ready device session.");
  if (!Number.isSafeInteger(inputCount) || inputCount < 2 || inputCount > 524_288 || inputCount % 2 !== 0) {
    throw new RangeError("Hi-Z occlusion probe input count must be an even integer in [2, 524288].");
  }
  const device = session.device, expectedVisibleCount = inputCount / 2;
  const owned: Array<GPUBuffer | GPUTexture> = [];
  const own = <T extends GPUBuffer | GPUTexture>(resource: T): T => { owned.push(session.own(resource)); return resource; };
  const source = own(device.createTexture({ label: "Deep Hi-Z occlusion probe depth", size: [64, 64, 1], format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
  const instances = Array.from({ length: inputCount }, (_, index): CullingInstance => {
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
      ((index % 8) - 3.5) / 5, ((Math.floor(index / 8) % 8) - 3.5) / 5, index < expectedVisibleCount ? 0.1 : 0.8, 1];
    return { modelMatrix: matrix, bounds: [0, 0, 0, 0.01] };
  });
  const instanceBuffer = own(device.createBuffer({ label: "Deep Hi-Z occlusion probe instances", size: inputCount * 144,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  const boundsBuffer = own(device.createBuffer({ label: "Deep Hi-Z occlusion probe bounds", size: inputCount * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  const countReadback = own(device.createBuffer({ label: "Deep Hi-Z occlusion probe count readback", size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const indirectReadback = own(device.createBuffer({ label: "Deep Hi-Z occlusion probe indirect readback", size: 20,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const indicesReadback = own(device.createBuffer({ label: "Deep Hi-Z occlusion probe indices readback", size: inputCount * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const pyramid = new HiZPyramid(session), culler = new HiZOcclusionCuller(session);
  try {
    device.queue.writeBuffer(instanceBuffer, 0, packCullingInstances(instances));
    device.queue.writeBuffer(boundsBuffer, 0, new Float32Array(instances.flatMap(item => [...item.bounds])));
    const encoder = device.createCommandEncoder({ label: "Deep Hi-Z occlusion probe" });
    const depth = encoder.beginRenderPass({ label: "Deep Hi-Z occlusion probe depth clear", colorAttachments: [],
      depthStencilAttachment: { view: source.createView({ aspect: "depth-only" }), depthClearValue: 0.3,
        depthLoadOp: "clear", depthStoreOp: "store" } });
    depth.end();
    const hierarchy = pyramid.encode(encoder, { texture: source, revision: 0 }, { reversedZ: false });
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
    const result = culler.encode(encoder, { instances: instanceBuffer, bounds: boundsBuffer, count: inputCount,
      revision: 0, indexCount: 3 }, { viewProjection: identity, cameraPosition: [0, 0, 5], viewport: [64, 64],
      hiz: hierarchy, reversedZ: false }, { temporal: false });
    if (result.mode !== "indirect") throw new Error("Hi-Z occlusion probe unexpectedly selected the direct path.");
    encoder.copyBufferToBuffer(result.visibleCount, 0, countReadback, 0, 4);
    encoder.copyBufferToBuffer(result.indirect, 0, indirectReadback, 0, 20);
    encoder.copyBufferToBuffer(result.visibleIndices, 0, indicesReadback, 0, inputCount * 4);
    device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
    await Promise.all([countReadback.mapAsync(GPUMapMode.READ), indirectReadback.mapAsync(GPUMapMode.READ), indicesReadback.mapAsync(GPUMapMode.READ)]);
    const visibleCount = new Uint32Array(countReadback.getMappedRange().slice(0))[0] ?? 0;
    const indirectCount = new Uint32Array(indirectReadback.getMappedRange().slice(0))[1] ?? 0;
    const indices = Array.from(new Uint32Array(indicesReadback.getMappedRange().slice(0)).slice(0, visibleCount)).sort((a, b) => a - b);
    countReadback.unmap(); indirectReadback.unmap(); indicesReadback.unmap();
    const affine = await runHiZAffineOcclusionProbe(session);
    const passed = affine.passed && visibleCount === expectedVisibleCount && indirectCount === expectedVisibleCount
      && indices.every((value, index) => value === index);
    return Object.freeze({ inputCount, visibleCount, indirectCount, expectedVisibleCount,
      peakResourceCount: session.resourceCount, affine, passed });
  } finally {
    culler.dispose(); pyramid.dispose();
    for (const resource of owned.reverse()) session.release(resource);
  }
}
