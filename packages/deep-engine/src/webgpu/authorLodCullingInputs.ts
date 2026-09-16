import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { DeviceSession } from "./deviceSession.js";
import type { GpuCullingPipelineContext, GpuCullingSharedInputs, GpuCullingPhaseResources } from "./gpuFrustumCulling.js";
import { failWithResourceCleanup } from "./resourceCleanup.js";

/** Stable per-real-geometry input, independent of the author's selection revision. */
export class AuthorLodCullingInputs {
  readonly shared: GpuCullingSharedInputs;
  readonly phase: GpuCullingPhaseResources;
  private readonly data: Float32Array;
  private readonly previous: Float32Array;
  private readonly bounds: readonly number[];
  private readonly geometryRevision: number;
  constructor(session: DeviceSession, context: GpuCullingPipelineContext,
    batch: CachedPacketBatch, geometry: CachedPacketGeometry) {
    const bytes = Math.max(1, batch.source.count) * 144;
    if (bytes > session.device.limits.maxBufferSize || bytes > session.device.limits.maxStorageBufferBindingSize) {
      throw Error("Author LOD culling inputs exceed device buffer limits.");
    }
    this.data = batch.source.data.slice(); this.previous = batch.previousTransforms.slice();
    this.bounds = [...geometry.center, geometry.radius]; this.geometryRevision = geometry.source.revision;
    this.shared = context.createSharedInputs(Math.max(1, batch.source.count));
    try {
      this.shared.writeInstances(session.device.queue, Array.from({ length: batch.source.count }, (_, index) => ({
        instanceData: this.data.subarray(index * 36, index * 36 + 36),
        previousTransform: this.previous.subarray(index * 12, index * 12 + 12),
        bounds: [...geometry.center, geometry.radius] as [number, number, number, number],
      })));
      this.phase = this.shared.createPhase(geometry.mesh.indexCount);
    } catch (error) { failWithResourceCleanup(error, "Author LOD culling input failed.", [() => this.shared.dispose()]); }
  }
  matches(batch: CachedPacketBatch, geometry: CachedPacketGeometry): boolean {
    return this.geometryRevision === geometry.source.revision && this.phase.indexCount === geometry.mesh.indexCount
      && equal(this.data, batch.source.data) && equal(this.previous, batch.previousTransforms)
      && this.bounds.every((value, index) => value === (index === 3 ? geometry.radius : geometry.center[index]));
  }
  destroy(): void { this.shared.dispose(); }
}
const equal = (a: Float32Array, b: Float32Array): boolean => a.length === b.length && a.every((value, index) => value === b[index]);
