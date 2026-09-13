/// <reference types="@webgpu/types" />
import { buildMeshlets } from "@bim-studio/deep-engine/geometry";
import { HiZPyramid, MeshletCuller, meshletPlannerRecord, type DeviceSession } from "@bim-studio/deep-engine/webgpu";
import { runMeshletAffineConeProbe } from "./meshletAffineConeProbe.js";

export interface MeshletCullingProbeResult {
  readonly inputCount: number;
  readonly visibleCount: number;
  readonly expectedVisibleCount: number;
  readonly stableSourceOrder: boolean;
  readonly plannerRecordsMatch: boolean;
  readonly affineConesPassed: boolean;
  readonly affineConeCases: readonly { name: string; visibleCount: number; expectedCount: number; maxFaceViewDot: number; coneEnabled: boolean }[];
  readonly passed: boolean;
}

/** Real-device meshlet/Hi-Z composition plus affine normal-cone regressions. */
export async function runMeshletCullingProbe(session: DeviceSession): Promise<MeshletCullingProbeResult> {
  if (session.state !== "ready") throw new Error("Meshlet culling probe requires a ready device session.");
  const device = session.device, expectedVisibleCount = 16;
  const meshlets = buildProbeMeshlets(), inputCount = meshlets.meshletCount;
  const owned: Array<GPUBuffer | GPUTexture> = [];
  const own = <T extends GPUBuffer | GPUTexture>(resource: T): T => { owned.push(session.own(resource)); return resource; };
  const depthTexture = own(device.createTexture({ label: "Deep meshlet probe depth", size: [64, 64, 1], format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
  const descriptors = own(device.createBuffer({ label: "Deep meshlet probe descriptors", size: meshlets.descriptors.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  const bounds = own(device.createBuffer({ label: "Deep meshlet probe bounds", size: meshlets.bounds.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  const countReadback = own(device.createBuffer({ label: "Deep meshlet probe count readback", size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const indicesReadback = own(device.createBuffer({ label: "Deep meshlet probe index readback", size: inputCount * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const recordsReadback = own(device.createBuffer({ label: "Deep meshlet probe planner readback", size: inputCount * 32,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const pyramid = new HiZPyramid(session), culler = new MeshletCuller(session);
  try {
    device.queue.writeBuffer(descriptors, 0, meshlets.descriptors);
    device.queue.writeBuffer(bounds, 0, meshlets.bounds);
    const encoder = device.createCommandEncoder({ label: "Deep meshlet culling probe" });
    const depth = encoder.beginRenderPass({ label: "Deep meshlet probe depth clear", colorAttachments: [],
      depthStencilAttachment: { view: depthTexture.createView({ aspect: "depth-only" }), depthClearValue: 0.3,
        depthLoadOp: "clear", depthStoreOp: "store" } });
    depth.end();
    const hierarchy = pyramid.encode(encoder, { texture: depthTexture, revision: 0 }, { reversedZ: false });
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
    const frustum = { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1],
      [0, 0, 1, 0], [0, 0, -1, 1]] as const };
    const result = culler.encode(encoder, { descriptors, bounds, count: inputCount, revision: 0 }, {
      viewProjection: identity, worldFromObject: identity, cameraPosition: [0, 0, 5], frustum,
      viewport: [64, 64], reversedZ: false, hiz: hierarchy,
    });
    if (result.mode !== "gpu") throw new Error("Meshlet probe unexpectedly selected direct drawing.");
    encoder.copyBufferToBuffer(result.visibleCount, 0, countReadback, 0, 4);
    encoder.copyBufferToBuffer(result.visibleIndices, 0, indicesReadback, 0, inputCount * 4);
    encoder.copyBufferToBuffer(result.visibleRecords, 0, recordsReadback, 0, inputCount * 32);
    device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
    await Promise.all([countReadback.mapAsync(GPUMapMode.READ), indicesReadback.mapAsync(GPUMapMode.READ), recordsReadback.mapAsync(GPUMapMode.READ)]);
    const visibleCount = new Uint32Array(countReadback.getMappedRange().slice(0))[0] ?? 0;
    const visibleIndices = new Uint32Array(indicesReadback.getMappedRange().slice(0), 0, visibleCount).slice();
    const records = new Uint32Array(recordsReadback.getMappedRange().slice(0), 0, visibleCount * 8).slice();
    countReadback.unmap(); indicesReadback.unmap(); recordsReadback.unmap();
    const stableSourceOrder = visibleIndices.every((value, index) => value === index);
    let plannerRecordsMatch = records.length === visibleCount * 8;
    for (let index = 0; index < visibleCount && plannerRecordsMatch; index += 1) {
      const meshlet = visibleIndices[index]!, descriptor = meshlets.descriptors.subarray(meshlet * 4, meshlet * 4 + 4);
      const expected = meshletPlannerRecord(meshlet, descriptor);
      plannerRecordsMatch = expected.every((value, field) => value === records[index * 8 + field]);
    }
    const affine = await runMeshletAffineConeProbe(session);
    return Object.freeze({ inputCount, visibleCount, expectedVisibleCount, stableSourceOrder, plannerRecordsMatch, ...affine,
      passed: visibleCount === expectedVisibleCount && stableSourceOrder && plannerRecordsMatch && affine.affineConesPassed });
  } finally {
    culler.dispose(); pyramid.dispose();
    for (const resource of owned.reverse()) session.release(resource);
  }
}

function buildProbeMeshlets() {
  const positions = new Float32Array(64 * 9), indices = new Uint16Array(64 * 3);
  for (let meshlet = 0; meshlet < 64; meshlet += 1) {
    const outside = meshlet >= 32 && meshlet < 48, backface = meshlet >= 48;
    const x = outside ? 3 : ((meshlet % 4) - 1.5) * 0.15;
    const y = ((Math.floor(meshlet / 4) % 4) - 1.5) * 0.15;
    const z = meshlet >= 16 && meshlet < 32 ? 0.8 : 0.1, vertex = meshlet * 3;
    const triangle = [-0.02, -0.02, 0, 0.02, -0.02, 0, 0, 0.02, 0];
    for (let local = 0; local < 3; local += 1) {
      positions.set([x + triangle[local * 3]!, y + triangle[local * 3 + 1]!, z], (vertex + local) * 3);
    }
    indices.set(backface ? [vertex, vertex + 2, vertex + 1] : [vertex, vertex + 1, vertex + 2], meshlet * 3);
  }
  return buildMeshlets({ positions, indices }, { maxTriangles: 1 });
}
