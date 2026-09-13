import type { PreparedBatch } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import {
  createGpuCullingPipelineContext,
  type Frustum,
  type GpuCullingPhaseResources,
  type GpuCullingPipelineContext,
  type GpuCullingSharedInputs,
} from "./gpuFrustumCulling.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { HiZOcclusionCuller, HI_Z_OCCLUSION_MIN_INSTANCES, type HiZOcclusionView } from "./hiZOcclusionCulling.js";
import { HiZInstanceCompactor } from "./hiZInstanceCompactor.js";

export interface PacketCullingView {
  readonly previousHiZ?: HiZOcclusionView;
  readonly sceneRevision: number;
}

export interface PacketCullingDraw {
  readonly compacted: GPUBuffer;
  readonly compactedPrevious: GPUBuffer;
  readonly indirect: GPUBuffer;
}

export interface PacketCullingStats {
  readonly phase: "shadow" | "opaque";
  readonly frustumBatches: number;
  readonly occlusionBatches: number;
}

interface OcclusionResources {
  readonly culler: HiZOcclusionCuller;
  readonly compactor: HiZInstanceCompactor;
}

type CullingPhaseKey = "opaque" | `shadow:${number}`;

interface CachedCullingBatch {
  readonly shared: GpuCullingSharedInputs;
  readonly phases: Map<CullingPhaseKey, GpuCullingPhaseResources>;
  readonly active: Map<CullingPhaseKey, PacketCullingDraw>;
  source: PreparedBatch;
  geometryRevision: number;
  previousTransforms: Float32Array<ArrayBuffer>;
  occlusion?: OcclusionResources;
}

/** Two compute dispatches and a compacted buffer cost more than a direct instanced draw for tiny batches. */
export const GPU_CULLING_MIN_INSTANCES = 64;

/** Owns the compute resources derived from resident packet batches. */
export class PacketCullingResources {
  private readonly batches = new Map<string, CachedCullingBatch>();
  private context: GpuCullingPipelineContext | undefined;

  constructor(private readonly session: DeviceSession) {}

  encode(
    encoder: GPUCommandEncoder,
    frustum: Frustum,
    phase: "shadow" | "opaque",
    batches: ReadonlyMap<string, CachedPacketBatch>,
    geometries: ReadonlyMap<string, CachedPacketGeometry>,
    view?: PacketCullingView,
    shadowCascade = 0,
  ): PacketCullingStats {
    let frustumBatches = 0, occlusionBatches = 0;
    const phaseKey = cullingPhaseKey(phase, shadowCascade);
    for (const cached of batches.values()) {
      if (cached.source.lod) {
        this.batches.get(cached.source.key)?.active.delete(phaseKey);
        continue;
      }
      if ((phase === "shadow" && cached.source.alphaMode === "BLEND")
        || cached.source.count < GPU_CULLING_MIN_INSTANCES) continue;
      const geometry = geometries.get(cached.source.geometry)!;
      const culler = this.ensure(phaseKey, cached, geometry);
      const entry = this.batches.get(cached.source.key)!;
      entry.active.delete(phaseKey);
      if (phase === "opaque" && view?.previousHiZ && cached.source.count >= HI_Z_OCCLUSION_MIN_INSTANCES) {
        entry.occlusion ??= { culler: new HiZOcclusionCuller(this.session), compactor: new HiZInstanceCompactor(this.session) };
        const visible = entry.occlusion.culler.encode(encoder, { instances: entry.shared.input,
          bounds: entry.shared.bounds, count: cached.source.count, revision: view.sceneRevision,
          indexCount: geometry.mesh.indexCount }, view.previousHiZ, { temporal: true });
        if (visible.mode === "indirect") {
          const compacted = entry.occlusion.compactor.encode(encoder, { instances: entry.shared.input,
            previousTransforms: entry.shared.previous, count: cached.source.count,
            capacity: entry.shared.capacity, visibility: visible });
          entry.active.set(phaseKey, { compacted: compacted.instances,
            compactedPrevious: compacted.previousTransforms, indirect: compacted.indirect });
          occlusionBatches++;
          continue;
        }
      }
      culler.writeView(this.session.device.queue, frustum, { indexCount: geometry.mesh.indexCount });
      culler.encode(encoder);
      entry.active.set(phaseKey, culler);
      frustumBatches++;
    }
    return { phase, frustumBatches, occlusionBatches };
  }

  phase(batchKey: string, phase: "shadow" | "opaque", shadowCascade = 0): PacketCullingDraw | undefined {
    return this.batches.get(batchKey)?.active.get(cullingPhaseKey(phase, shadowCascade));
  }

  /** Keeps the compacted motion stream on the same submitted-frame boundary as direct draws. */
  commitPrevious(updates: ReadonlyMap<string, Float32Array<ArrayBuffer>>): void {
    const attempted: Array<{ entry: CachedCullingBatch; previous: Float32Array<ArrayBuffer> }> = [];
    try {
      for (const [key, current] of updates) {
        const entry = this.batches.get(key);
        if (!entry || equal(entry.previousTransforms, current)) continue;
        attempted.push({ entry, previous: entry.previousTransforms });
        this.session.device.queue.writeBuffer(entry.shared.previous, 0, current);
      }
    } catch (cause) {
      const failures: unknown[] = [];
      for (let index = attempted.length - 1; index >= 0; index--) {
        const { entry, previous } = attempted[index]!;
        try { this.session.device.queue.writeBuffer(entry.shared.previous, 0, previous); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) {
        this.dispose();
        throw new AggregateError([cause, ...failures], "Culling history rollback failed; culling resources were released.");
      }
      throw cause;
    }
    for (const { entry } of attempted) {
      const key = entry.source.key;
      entry.previousTransforms = updates.get(key)!.slice();
    }
  }

  prune(resident: ReadonlyMap<string, CachedPacketBatch>): void {
    const valid = new Set(Array.from(resident, ([key, batch]) =>
      batch.source.count >= GPU_CULLING_MIN_INSTANCES ? key : undefined)
      .filter((key): key is string => key !== undefined));
    for (const [key, culler] of this.batches) {
      if (valid.has(key)) continue;
      releaseEntry(culler);
      this.batches.delete(key);
    }
  }

  dispose(): void {
    for (const culler of this.batches.values()) releaseEntry(culler);
    this.batches.clear();
    this.context?.dispose();
    this.context = undefined;
  }

  private ensure(
    phase: CullingPhaseKey,
    batch: CachedPacketBatch,
    geometry: CachedPacketGeometry,
  ): GpuCullingPhaseResources {
    const key = batch.source.key;
    const previous = this.batches.get(key);
    const reusable = previous !== undefined && previous.shared.capacity >= batch.source.count;
    const bounds = [...geometry.center, geometry.radius] as [number, number, number, number];
    const values = (): Array<{ instanceData: Float32Array; bounds: [number, number, number, number] }> =>
      Array.from({ length: batch.source.count }, (_, index) => ({
        instanceData: batch.source.data.subarray(index * 36, index * 36 + 36),
        previousTransform: batch.previousTransforms.subarray(index * 12, index * 12 + 12),
        bounds,
      }));

    let entry: CachedCullingBatch;
    if (!reusable) {
      let shared: GpuCullingSharedInputs | undefined;
      try {
        this.context ??= createGpuCullingPipelineContext(this.session.device);
        shared = this.context.createSharedInputs(
          Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, batch.source.count)))),
        );
        shared.writeInstances(this.session.device.queue, values());
        const phaseResources = shared.createPhase(geometry.mesh.indexCount);
        entry = {
          shared,
          phases: new Map([[phase, phaseResources]]),
          active: new Map(),
          source: batch.source,
          geometryRevision: geometry.source.revision,
          previousTransforms: batch.previousTransforms.slice(),
        };
      } catch (error) {
        shared?.dispose();
        if (previous) releaseEntry(previous);
        this.batches.delete(key);
        throw error;
      }
      this.batches.set(key, entry);
      if (previous) releaseEntry(previous);
      return entry.phases.get(phase)!;
    }

    entry = previous;
    if (entry.source !== batch.source || entry.geometryRevision !== geometry.source.revision) {
      try {
        entry.shared.writeInstances(this.session.device.queue, values());
      } catch (error) {
        releaseEntry(entry);
        this.batches.delete(key);
        throw error;
      }
      entry.source = batch.source;
      entry.geometryRevision = geometry.source.revision;
      entry.previousTransforms = batch.previousTransforms.slice();
    }
    const currentPhase = entry.phases.get(phase);
    if (currentPhase?.indexCount === geometry.mesh.indexCount) return currentPhase;
    let nextPhase: GpuCullingPhaseResources;
    try {
      nextPhase = entry.shared.createPhase(geometry.mesh.indexCount);
    } catch (error) {
      currentPhase?.dispose();
      entry.phases.delete(phase);
      throw error;
    }
    entry.phases.set(phase, nextPhase);
    currentPhase?.dispose();
    return nextPhase;
  }
}

const equal = (a: Float32Array, b: Float32Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function releaseEntry(entry: CachedCullingBatch): void {
  entry.occlusion?.compactor.dispose();
  entry.occlusion?.culler.dispose();
  entry.shared.dispose();
}

function cullingPhaseKey(phase: "shadow" | "opaque", cascade: number): CullingPhaseKey {
  if (!Number.isInteger(cascade) || cascade < 0 || cascade > 7) throw new RangeError("Shadow cascade index must be 0..7.");
  return phase === "opaque" ? phase : `shadow:${cascade}`;
}
