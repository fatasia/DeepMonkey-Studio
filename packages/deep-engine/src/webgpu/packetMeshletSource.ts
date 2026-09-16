import { buildMeshlets } from "../geometry/meshletBuilder.js";
import { expandMeshletIndices } from "../geometry/meshletIndices.js";
import type { GeometryResource } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import { MeshletIndexBuffer } from "./meshletIndexBuffer.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
export const PACKET_MESHLET_STAGE_BYTES = 32 * 1024 * 1024;
export interface PacketMeshletBudget { remainingBytes: number }
/** Candidate-stage entry used by Nanite Lite: all-or-nothing static build with explicit fallback. */
export function prepareNaniteLiteCandidate(session: DeviceSession, geometry: GeometryResource, budget: PacketMeshletBudget) {
  return PacketMeshletSource.prepare(session, geometry, budget);
}
/** Created only by the geometry candidate stage, never by view encoding. */
export class PacketMeshletSource {
  private disposed = false;
  private constructor(private readonly session: DeviceSession, readonly descriptors: GPUBuffer,
    readonly bounds: GPUBuffer, readonly indices: MeshletIndexBuffer, readonly count: number, readonly revision: number,
    readonly budgetBytes: number, private readonly budget: PacketMeshletBudget) {}
  static prepare(session: DeviceSession, geometry: GeometryResource, budget: PacketMeshletBudget):
    { source?: PacketMeshletSource; fallback?: string } {
    const triangles = geometry.indices.length / 3;
    if (triangles < 64) return { fallback: "small-geometry" };
    if (triangles > 512 * 126) return { fallback: "geometry-capacity" };
    const estimate = geometry.vertices.byteLength + geometry.indices.byteLength + 512 * 80;
    if (estimate > budget.remainingBytes) return { fallback: "stage-memory-budget" };
    const positions = new Float32Array(geometry.vertices.length / 2);
    for (let vertex = 0; vertex < positions.length / 3; vertex++) positions.set(geometry.vertices.subarray(vertex * 6, vertex * 6 + 3), vertex * 3);
    const built = buildMeshlets({ positions, indices: geometry.indices });
    if (built.meshletCount < 64) return { fallback: "small-meshlet-count" };
    if (built.meshletCount > 512) return { fallback: "meshlet-capacity" };
    const expanded = expandMeshletIndices(built), device = session.device;
    const limit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
    if (Math.max(built.descriptors.byteLength, built.bounds.byteLength, expanded.indices.byteLength) > limit) return { fallback: "device-buffer-limit" };
    const buffers: GPUBuffer[] = []; let indices: MeshletIndexBuffer | undefined;
    const upload = (label: string, data: Uint32Array<ArrayBuffer> | Float32Array<ArrayBuffer>) => {
      const buffer = session.own(device.createBuffer({ label, size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      buffers.push(buffer); device.queue.writeBuffer(buffer, 0, data); return buffer;
    };
    try {
      const descriptors = upload("Deep packet meshlet descriptors", built.descriptors), bounds = upload("Deep packet meshlet bounds", built.bounds);
      indices = new MeshletIndexBuffer(session, expanded); budget.remainingBytes -= estimate;
      return { source: new PacketMeshletSource(session, descriptors, bounds, indices, built.meshletCount, geometry.revision, estimate, budget) };
    } catch (error) { failWithResourceCleanup(error, "Packet meshlet preparation failed.", [
      ...buffers.map(buffer => () => session.release(buffer)), () => indices?.dispose(),
    ]); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.budget.remainingBytes += this.budgetBytes;
    runResourceCleanup("Packet meshlet disposal failed.", [
    () => this.session.release(this.descriptors), () => this.session.release(this.bounds), () => this.indices.dispose(),
  ]); }
}
