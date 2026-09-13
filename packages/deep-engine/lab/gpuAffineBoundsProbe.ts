/// <reference types="@webgpu/types" />
import { geometryCenter, prepareRenderPacket, type GeometryResource, type RenderPacket } from "../src/renderPacket.js";
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { createGpuFrustumCulling, type CullingInstance, type Frustum } from "../src/webgpu/gpuFrustumCulling.js";
import { MeshBuffers, uploadBuffer } from "../src/webgpu/meshBuffers.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "../src/webgpu/packetBufferTypes.js";
import { packPreviousTransforms } from "../src/webgpu/packetInstanceHistory.js";
import { PacketLodResources } from "../src/webgpu/packetLodResources.js";

const distances = [1.5, 2.5, 1.5];
const frustum: Frustum = { planes: [[1, 1, 0, 0], [-1, 0, 0, 100], [0, 1, 0, 100],
  [0, -1, 0, 100], [0, 0, 1, 100], [0, 0, -1, 100]] };

/** Real GPU counter/compaction readback for intersecting sheared and reflected geometry. */
export async function runGpuAffineBoundsProbe(session: DeviceSession) {
  const device = session.device, buffers: GPUBuffer[] = [], meshes: MeshBuffers[] = [];
  const own = (buffer: GPUBuffer) => { buffers.push(buffer); return session.own(buffer); };
  const ordinary = createGpuFrustumCulling(device, 4, 6), lod = new PacketLodResources(session);
  try {
    const prepared = prepareRenderPacket(packet());
    const geometries = new Map<string, CachedPacketGeometry>([...prepared.geometries].map(([id, source]) => {
      const mesh = new MeshBuffers(session, source); meshes.push(mesh);
      const center = geometryCenter(source);
      const radius = Math.max(...Array.from(source.indices, index => Math.hypot(source.vertices[index * 6]! - center[0],
        source.vertices[index * 6 + 1]! - center[1], source.vertices[index * 6 + 2]! - center[2])));
      return [id, { source, mesh, center, radius }];
    }));
    const batches = new Map<string, CachedPacketBatch>(prepared.batches.map(source => {
      const previousTransforms = packPreviousTransforms(source);
      const buffer = own(uploadBuffer(session, "Deep affine LOD instances", source.data, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE));
      const previousBuffer = own(uploadBuffer(session, "Deep affine LOD previous", previousTransforms, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE));
      return [source.key, { source, buffer, capacity: source.data.byteLength, previousBuffer,
        previousCapacity: previousTransforms.byteLength, previousTransforms }];
    }));
    const readback = own(device.createBuffer({ label: "Deep affine culling readback", size: 640 + batches.size * 160,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    ordinary.writeInput(device.queue, distances.map((distance, index): CullingInstance => ({
      modelMatrix: transform(distance, index === 2), bounds: [0, 0, 0, 1], metadata: [index, 0, 0, 0] })), frustum);
    const encoder = device.createCommandEncoder({ label: "Deep affine bounds counterexample" });
    ordinary.encode(encoder);
    encoder.copyBufferToBuffer(ordinary.indirect, 0, readback, 0, 20);
    encoder.copyBufferToBuffer(ordinary.compacted, 0, readback, 32, 4 * 144);
    lod.encode(encoder, batches, geometries, 0, {
      camera: { projection: "orthographic", position: [0, 0, -10], forward: [0, 0, 1], verticalSize: 64, near: 0.1, far: 100 },
      viewport: { width: 64, height: 64 }, frustum });
    const draws = [...batches.keys()].map(key => lod.draws(key)!);
    draws.forEach((batch, index) => encoder.copyBufferToBuffer(batch[0]!.indirect, 0, readback, 640 + index * 160, 160));
    device.queue.submit([encoder.finish()]); lod.commitFrame();
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Uint32Array(readback.getMappedRange().slice(0)); readback.unmap();
    const ordinaryVisible = values[1]!;
    const ordinaryIds = Array.from({ length: ordinaryVisible }, (_, index) => values[8 + index * 36 + 32]!).sort((a, b) => a - b);
    const lodCounts = [0, 1].map(level => draws.reduce((sum, _draw, index) => sum + values[160 + index * 40 + level * 5 + 1]!, 0));
    const exactSupportPreserved = ordinaryVisible === 2 && JSON.stringify(ordinaryIds) === "[0,2]";
    const conservativeLodPreserved = lodCounts[0] === 2;
    const rotationInflationAvoided = lodCounts[1] === 2;
    return { ordinaryVisible, ordinaryIds, lodCounts, exactSupportPreserved, conservativeLodPreserved, rotationInflationAvoided,
      passed: exactSupportPreserved && conservativeLodPreserved && rotationInflationAvoided };
  } finally {
    ordinary.dispose(); lod.dispose(); for (const mesh of meshes) mesh.dispose();
    for (const buffer of buffers) session.release(buffer);
  }
}

function transform(distance: number, reflected: boolean): number[] {
  const t = -distance * Math.SQRT1_2;
  return [reflected ? -1 : 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, t, t, 0, 1];
}

function packet(): RenderPacket {
  const r = Math.SQRT1_2;
  const vertices = new Float32Array([r, r, 0, 0, 0, 1, -r, 0, 0, 0, 0, 1, r, -r, 0, 0, 0, 1]);
  const geometry = (id: string, indices: number[]): GeometryResource => ({ id, vertices, indices: new Uint32Array(indices), revision: 0 });
  const lod = { levels: [{ geometry: "fine", minProjectedDiameterPixels: 3, geometricError: 0 },
    { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 0.1 }] } as const;
  // The two rotation controls have diameter 2px; the old norm-product bound
  // inflated the 45° case to 2.83px. The independent profile threshold is 2.5px.
  const rotationLod = { levels: [{ ...lod.levels[0], minProjectedDiameterPixels: 2.5 }, lod.levels[1]] } as const;
  return { geometries: [geometry("fine", [0, 1, 2, 0, 1, 2]), geometry("coarse", [0, 1, 2])],
    materials: [{ id: "surface", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
    instances: [...distances.map((distance, index) => ({ id: `affine-${index}`, geometry: "fine", material: "surface",
      transform: transform(distance, index === 2), lod })),
      ...[0, Math.PI / 4].map(angle => ({ id: `rotation-${angle}`, geometry: "fine", material: "surface", lod: rotationLod,
        transform: [Math.cos(angle), Math.sin(angle), 0, 0, -Math.sin(angle), Math.cos(angle), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }))] };
}
