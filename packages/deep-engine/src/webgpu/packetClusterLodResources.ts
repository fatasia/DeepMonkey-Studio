import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { ClusterLodRenderSlot } from "./clusterLodRenderSlot.js";
import { MeshBuffers } from "./meshBuffers.js";
import { bakePacketClusterGeometry, clusterLocalCamera, clusterTransformSupported } from "./packetClusterLodGeometry.js";
import { runResourceCleanup } from "./resourceCleanup.js";

const MAX_INSTANCES = 64;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;
interface Entry { readonly batch: CachedPacketBatch; readonly index: number; readonly slot: ClusterLodRenderSlot; readonly mesh: MeshBuffers }

function meshBytes(baked: ReturnType<typeof bakePacketClusterGeometry>): number {
  const geometry = baked.geometry;
  return geometry.vertices.length / 6 * 40 + geometry.indices.byteLength
    + (geometry.tangents?.byteLength ?? 0) + (geometry.colors?.byteLength ?? 0);
}
function slotBytes(baked: ReturnType<typeof bakePacketClusterGeometry>): number {
  // Includes selector/readback buffers, diagnostic geometry and simultaneous old/new indirect commands.
  return baked.staging.levelGeometry.reduce((sum, level) => sum + level.vertices.byteLength + level.indices.byteLength, 0)
    + baked.staging.dag.nodes.length * (64 + 8 + 40) + 48 + 8 + 64;
}

/** Per-section PBR replacement. Unsupported sections retain ordinary packet draws. */
export class PacketClusterLodResources {
  private entries = new Map<string, readonly Entry[]>();
  private meshes: MeshBuffers[] = [];
  private fallbacks: string[] = [];
  private disposed = false;
  private frameDraws = 0;
  private frameTriangles = 0;

  constructor(private readonly session: DeviceSession, batches: ReadonlyMap<string, CachedPacketBatch>,
    geometries: ReadonlyMap<string, CachedPacketGeometry>) {
    let instanceCount = 0, bytes = 0;
    const bakedGeometries = new Map<string, { baked: ReturnType<typeof bakePacketClusterGeometry>; mesh: MeshBuffers }>();
    for (const [key, batch] of batches) {
      const source = geometries.get(batch.source.geometry)?.source;
      const reason = !source ? "missing-geometry" : batch.source.pose ? "deformation" : batch.source.lod ? "authored-lod"
        : batch.source.alphaMode !== "OPAQUE" ? "alpha-material" : source.indices.length < 384 ? "small-geometry"
        : instanceCount + batch.source.count > MAX_INSTANCES ? "instance-budget"
        : Array.from({ length: batch.source.count }, (_, index) => index).some(index =>
          !clusterTransformSupported(batch.source.data, index * 36)) ? "nonuniform-transform" : undefined;
      if (reason) { this.fallbacks.push(`${key}:${reason}`); continue; }
      const entries: Entry[] = [];
      try {
        let geometry = bakedGeometries.get(source!.id);
        if (!geometry) {
          const baked = bakePacketClusterGeometry(source!);
          const geometryBytes = meshBytes(baked);
          if (bytes + geometryBytes + slotBytes(baked) * batch.source.count > MAX_STAGED_BYTES) {
            this.fallbacks.push(`${key}:stage-memory-budget`); continue;
          }
          const mesh = new MeshBuffers(session, baked.geometry);
          this.meshes.push(mesh); bytes += geometryBytes;
          geometry = { baked, mesh }; bakedGeometries.set(source!.id, geometry);
        }
        for (let index = 0; index < batch.source.count; index++) {
          const stagingBytes = slotBytes(geometry.baked);
          if (bytes + stagingBytes > MAX_STAGED_BYTES) throw new Error("stage-memory-budget");
          const slot = ClusterLodRenderSlot.create(session, geometry.baked.staging);
          entries.push({ batch, index, slot, mesh: geometry.mesh }); bytes += stagingBytes;
        }
        this.entries.set(key, entries); instanceCount += entries.length;
      } catch (reason) {
        for (const entry of entries) entry.slot.dispose();
        this.fallbacks.push(`${key}:${reason instanceof Error ? reason.message : String(reason)}`);
      }
    }
  }

  encode(encoder: GPUCommandEncoder, eye: readonly [number, number, number], target: readonly [number, number, number],
    height: number, fov: number): void {
    this.frameDraws = 0; this.frameTriangles = 0;
    for (const entries of this.entries.values()) for (const { slot, batch, index } of entries) {
      if (slot.hasFallback()) continue;
      const record = batch.source.data, offset = index * 36;
      slot.updateCameraFromView({ eye: clusterLocalCamera(record, offset, eye), target: clusterLocalCamera(record, offset, target) }, height, fov);
      slot.encodeFrame(encoder);
    }
  }

  draw(pass: GPURenderPassEncoder, batch: CachedPacketBatch, previous: boolean): { drawCalls: number; triangles: number } | undefined {
    const entries = this.entries.get(batch.source.key);
    if (!entries) return undefined;
    if (entries.some(entry => entry.batch !== batch)) {
      this.entries.delete(batch.source.key);
      this.fallbacks.push(`${batch.source.key}:author-revision-changed`);
      runResourceCleanup("Cluster section retirement failed.", entries.map(entry => () => entry.slot.dispose()));
      return undefined;
    }
    if (entries.some(entry => {
      const state = entry.slot.metrics();
      return state.warming || state.stale || entry.slot.hasFallback();
    })) return undefined;
    let drawCalls = 0, triangles = 0;
    for (const entry of entries) {
      const stats = entry.slot.drawWithGeometry(pass, entry.mesh.vertices, entry.mesh.indices, batch.buffer,
        previous ? batch.previousBuffer : undefined, entry.index,
        batch.source.textures?.normal ? entry.mesh.tangents : undefined, entry.mesh.colors)!;
      drawCalls += stats.draws; triangles += stats.triangles;
    }
    this.frameDraws += drawCalls; this.frameTriangles += triangles;
    return { drawCalls, triangles };
  }

  afterSubmit(): void {
    for (const entries of this.entries.values()) for (const { slot } of entries) {
      void slot.ingest().catch(error => slot.noteIngestFailure(error));
    }
  }
  cancelFrame(): void {
    for (const entries of this.entries.values()) for (const { slot } of entries) slot.cancelPendingFrame();
  }
  metrics() {
    const slots = [...this.entries.values()].flat().map(entry => entry.slot.metrics());
    return { draws: this.frameDraws, triangles: this.frameTriangles, sections: this.entries.size,
      warming: slots.some(slot => slot.warming), stale: slots.some(slot => slot.stale),
      fallbackReasons: [...this.fallbacks, ...slots.flatMap(slot => slot.fallbackReason ? [slot.fallbackReason] : [])] };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const slots = [...this.entries.values()].flat().map(entry => entry.slot);
    this.entries.clear();
    const meshes = this.meshes; this.meshes = [];
    runResourceCleanup("Cluster PBR resources disposal failed.", [...slots, ...meshes].map(resource => () => resource.dispose()));
  }
}
