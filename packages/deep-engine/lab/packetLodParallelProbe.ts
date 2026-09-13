/// <reference types="@webgpu/types" />
import { prepareRenderPacket, type GeometryResource, type RenderPacket } from "@bim-studio/deep-engine";
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";
import { geometryCenter } from "../src/renderPacket.js";
import { applyPacketLodBudgetReference } from "../src/webgpu/packetLodBudgetReference.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "../src/webgpu/packetBufferTypes.js";
import { PacketLodResources } from "../src/webgpu/packetLodResources.js";
import { PACKET_LOD_INDIRECT_STRIDE } from "../src/webgpu/packetLodWgsl.js";
import { packPreviousTransforms } from "../src/webgpu/packetInstanceHistory.js";
import { MeshBuffers, uploadBuffer } from "../src/webgpu/meshBuffers.js";

const OBJECTS = 1_024, LEVELS = 3, INSTANCE_BYTES = 144, ROW_BYTES = 256;
const MAX_OBJECTS = 900, MAX_TRIANGLES = 2_300;
const PIXEL_WIDTH = 32, PIXEL_HEIGHT = 16;

export interface PacketLodParallelProbeResult {
  readonly objectCount: number;
  readonly acceptedObjects: number;
  readonly levelCounts: readonly number[];
  readonly cpuGpuMatched: boolean;
  readonly stableCompaction: boolean;
  readonly indirectDrawReadback: boolean;
  readonly zeroFirstInstance: boolean;
  readonly lod0Pixel: readonly number[];
  readonly lod2Pixel: readonly number[];
  readonly passed: boolean;
}

/** Executes the production selector, parallel budget/compaction, indirect draw, and GPU readback. */
export async function runPacketLodParallelProbe(session: DeviceSession): Promise<PacketLodParallelProbeResult> {
  if (session.state !== "ready") throw new Error("Packet LOD parallel probe requires a ready device session.");
  const device = session.device, prepared = prepareRenderPacket(packet());
  const meshes: MeshBuffers[] = [], owned: GPUBuffer[] = [];
  const lod = new PacketLodResources(session);
  const indirectReadback = device.createBuffer({ label: "Deep packet LOD probe indirect", size: 8 * PACKET_LOD_INDIRECT_STRIDE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const compactedReadback = device.createBuffer({ label: "Deep packet LOD probe compacted", size: OBJECTS * LEVELS * INSTANCE_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const pixelReadback = device.createBuffer({ label: "Deep packet LOD probe pixel", size: ROW_BYTES * PIXEL_HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const color = device.createTexture({ label: "Deep packet LOD probe color", size: [PIXEL_WIDTH, PIXEL_HEIGHT], format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  let encoded = false, submitted = false;
  try {
    const geometries = cachedGeometries(session, prepared.geometries, meshes);
    const batches = cachedBatches(session, prepared.batches[0]!, owned);
    const encoder = device.createCommandEncoder({ label: "Deep packet LOD parallel probe" });
    const stats = lod.encode(encoder, batches, geometries, 0, {
      camera: { projection: "perspective", position: [0, 0, 0], forward: [0, 0, 1],
        verticalFovRadians: Math.PI / 2, near: 0.1, far: 100 }, viewport: { width: 256, height: 256 },
      frustum: { planes: [[1, 0, 0, 100], [-1, 0, 0, 100], [0, 1, 0, 100],
        [0, -1, 0, 100], [0, 0, 1, 100], [0, 0, -1, 100]] },
      budget: { maxObjects: MAX_OBJECTS, maxTriangles: MAX_TRIANGLES },
    });
    encoded = true;
    const batch = prepared.batches[0]!, draws = lod.draws(batch.key)!;
    encoder.copyBufferToBuffer(draws[0]!.indirect, 0, indirectReadback, 0, 8 * PACKET_LOD_INDIRECT_STRIDE);
    encoder.copyBufferToBuffer(draws[0]!.instances, 0, compactedReadback, 0, OBJECTS * LEVELS * INSTANCE_BYTES);
    encodeDraw(device, encoder, color, draws, geometries);
    encoder.copyTextureToBuffer({ texture: color }, { buffer: pixelReadback, bytesPerRow: ROW_BYTES }, [PIXEL_WIDTH, PIXEL_HEIGHT]);
    const command = encoder.finish(); device.queue.submit([command]); submitted = true; lod.commitFrame();
    await device.queue.onSubmittedWorkDone();
    await Promise.all([indirectReadback.mapAsync(GPUMapMode.READ), compactedReadback.mapAsync(GPUMapMode.READ),
      pixelReadback.mapAsync(GPUMapMode.READ)]);
    const indirect = new Uint32Array(indirectReadback.getMappedRange().slice(0));
    const compacted = new Float32Array(compactedReadback.getMappedRange().slice(0));
    const pixels = new Uint8Array(pixelReadback.getMappedRange().slice(0));
    const lod0Pixel = [...pixels.slice(8 * ROW_BYTES + 8 * 4, 8 * ROW_BYTES + 8 * 4 + 4)];
    const lod2Pixel = [...pixels.slice(8 * ROW_BYTES + 24 * 4, 8 * ROW_BYTES + 24 * 4 + 4)];
    indirectReadback.unmap(); compactedReadback.unmap(); pixelReadback.unmap();
    const cpu = applyPacketLodBudgetReference(Array.from({ length: OBJECTS }, (_, index) => ({
      selectedLevel: index < 256 ? 0 : 2, triangles: index < 256 ? 8 : 1, drawable: true, inFrustum: true,
    })), MAX_OBJECTS, MAX_TRIANGLES);
    const levelCounts = Array.from({ length: LEVELS }, (_, level) => indirect[level * 5 + 1]!);
    const cpuGpuMatched = levelCounts.every((value, level) => value === cpu.levelCounts[level]);
    const stableCompaction = [0, 2].every(level => cpu.compactedIndices[level]!.every((sourceIndex, index) =>
      close(compacted[(level * OBJECTS + index) * 36 + 3]!, sourceIndex * 1e-4)));
    const zeroFirstInstance = Array.from({ length: 8 }, (_, level) => indirect[level * 5 + 4]).every(value => value === 0);
    const indirectDrawReadback = zeroFirstInstance && lod0Pixel[0]! > 180 && lod0Pixel[1]! < 40
      && lod2Pixel[0]! < 40 && lod2Pixel[1]! > 180
      && [lod0Pixel, lod2Pixel].every(pixel => pixel[2]! > 90 && pixel[3] === 255);
    const acceptedObjects = levelCounts.reduce((sum, value) => sum + value, 0);
    const passed = stats.inputObjects === OBJECTS && stats.selectionBatches === 1 && stats.indirectDraws === 2
      && acceptedObjects === 508 && cpuGpuMatched && stableCompaction && indirectDrawReadback;
    return Object.freeze({ objectCount: OBJECTS, acceptedObjects, levelCounts: Object.freeze(levelCounts),
      cpuGpuMatched, stableCompaction, indirectDrawReadback, zeroFirstInstance,
      lod0Pixel: Object.freeze(lod0Pixel), lod2Pixel: Object.freeze(lod2Pixel), passed });
  } catch (error) {
    if (encoded) { if (submitted) lod.failFrame(); else lod.cancelFrame(); }
    throw error;
  } finally {
    lod.dispose(); for (const resource of owned.reverse()) session.release(resource);
    for (const mesh of meshes.reverse()) mesh.dispose(); color.destroy();
    for (const buffer of [indirectReadback, compactedReadback, pixelReadback]) {
      if (buffer.mapState === "mapped") buffer.unmap(); buffer.destroy();
    }
  }
}

function packet(): RenderPacket {
  const lod = { levels: [
    { geometry: "high", minProjectedDiameterPixels: 80, geometricError: 0 },
    { geometry: "medium", minProjectedDiameterPixels: 20, geometricError: 0.25, resident: false },
    { geometry: "low", minProjectedDiameterPixels: 0, geometricError: 1 },
  ] } as const;
  return { geometries: [geometry("high", 8), geometry("medium", 4), geometry("low", 1)],
    materials: [{ id: "surface", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
    instances: Array.from({ length: OBJECTS }, (_, index) => ({ id: `lod-${index}`, geometry: "high", material: "surface",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index * 1e-4, 0, index < 256 ? 2 : index < 640 ? 6 : 20, 1], lod })) };
}

function geometry(id: string, triangles: number): GeometryResource {
  return { id, revision: 0, vertices: new Float32Array([
    -0.5, -0.5, 0, 0, 0, 1, 0.5, -0.5, 0, 0, 0, 1, 0, 0.5, 0, 0, 0, 1,
  ]), indices: Uint32Array.from({ length: triangles * 3 }, (_, index) => index % 3) };
}

function cachedGeometries(session: DeviceSession, sources: ReadonlyMap<string, GeometryResource>, meshes: MeshBuffers[]): Map<string, CachedPacketGeometry> {
  return new Map([...sources].map(([id, source]) => {
    const mesh = new MeshBuffers(session, source); meshes.push(mesh); const center = geometryCenter(source);
    const radius = Math.max(...Array.from(source.indices, index => Math.hypot(source.vertices[index * 6]! - center[0],
      source.vertices[index * 6 + 1]! - center[1], source.vertices[index * 6 + 2]! - center[2])));
    return [id, { source, mesh, center, radius }] as const;
  }));
}

function cachedBatches(session: DeviceSession, source: ReturnType<typeof prepareRenderPacket>["batches"][number],
  owned: GPUBuffer[]): Map<string, CachedPacketBatch> {
  const previousTransforms = packPreviousTransforms(source);
  const buffer = uploadBuffer(session, "Deep packet LOD probe instances", source.data, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
  const previousBuffer = uploadBuffer(session, "Deep packet LOD probe history", previousTransforms, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
  owned.push(buffer, previousBuffer);
  return new Map([[source.key, { source, buffer, capacity: source.data.byteLength, previousBuffer,
    previousCapacity: previousTransforms.byteLength, previousTransforms }]]);
}

function encodeDraw(device: GPUDevice, encoder: GPUCommandEncoder, color: GPUTexture,
  draws: NonNullable<ReturnType<PacketLodResources["draws"]>>, geometries: ReadonlyMap<string, CachedPacketGeometry>): void {
  const module = device.createShaderModule({ code: `
    struct Output { @builtin(position) position: vec4f, @location(0) color: vec3f }
    @vertex fn vertexMain(@location(0) position: vec3f, @location(1) currentRow0: vec4f,
      @location(2) previousRow0: vec4f) -> Output {
      let low = currentRow0.w > 0.02555;
      let historyMatches = abs(currentRow0.w - previousRow0.w) < 0.000001;
      var output: Output; output.position = vec4f(position.xy * 1.6, 0.0, 1.0);
      output.color = vec3f(select(0.8, 0.1, low), select(0.1, 0.8, low), select(0.0, 0.4, historyMatches));
      return output;
    }
    @fragment fn fragmentMain(input: Output) -> @location(0) vec4f { return vec4f(input.color, 1.0); }
  ` });
  const pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vertexMain", buffers: [
    { arrayStride: 40, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
    { arrayStride: 144, stepMode: "instance", attributes: [{ shaderLocation: 1, offset: 0, format: "float32x4" }] },
    { arrayStride: 48, stepMode: "instance", attributes: [{ shaderLocation: 2, offset: 0, format: "float32x4" }] },
  ] },
    fragment: { module, entryPoint: "fragmentMain", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: color.createView(),
    loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
  pass.setPipeline(pipeline);
  for (const [index, draw] of draws.entries()) {
    pass.setViewport(index * 16, 0, 16, 16, 0, 1);
    geometries.get(draw.geometry)!.mesh.drawIndirect(pass, draw.instances, draw.indirect, false,
      draw.previousTransforms, draw.indirectOffset, draw.instanceByteOffset, draw.previousByteOffset);
  }
  pass.end();
}

function close(left: number, right: number): boolean { return Math.abs(left - right) <= 1e-6; }
