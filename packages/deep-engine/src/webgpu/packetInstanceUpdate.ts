import {
  assertPacketDeformationSupported,
  geometryCenter,
  prepareInstanceUpdate,
  type InstanceUpdate,
} from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import {
  type MaterialBindingPool,
  materialBindingMatches,
  type MaterialBinding,
} from "./materialBindings.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import {
  collectTransformHistory,
  packCurrentTransforms,
  packPreviousTransforms,
} from "./packetInstanceHistory.js";
import type { PacketTextureLookup } from "./packetTextureLookup.js";
import type { DeformationSnapshot } from "../deformation/types.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import { authorLodMetadataChanged } from "./authorLodMetadata.js";

export class PacketInstanceRollbackError extends AggregateError {}

export interface PacketInstanceUpdateContext {
  readonly deformation?: DeformationSnapshot;
  readonly commitDeformation?: () => boolean;
  readonly session: DeviceSession;
  readonly materials: MaterialBindingPool;
  readonly textures: PacketTextureLookup;
  readonly geometries: ReadonlyMap<string, CachedPacketGeometry>;
  readonly batches: ReadonlyMap<string, CachedPacketBatch>;
  readonly assertCurrent: () => void;
}

export interface PacketInstanceUpdateResult {
  readonly batches: Map<string, CachedPacketBatch>;
  readonly historyUpdates: ReadonlyMap<string, Float32Array<ArrayBuffer>>;
  readonly changed: boolean;
}

export type CommitCullingHistory = (
  updates: ReadonlyMap<string, Float32Array<ArrayBuffer>>,
) => void;

interface PendingWrite {
  readonly next: CachedPacketBatch;
  readonly previous?: CachedPacketBatch;
  readonly currentChanged: boolean;
  readonly historyChanged: boolean;
}

interface AttemptedWrite { readonly buffer: GPUBuffer; readonly restore?: Float32Array<ArrayBuffer> }

/** Applies the animation fast path as one CPU-visible transaction. */
export function updatePacketInstances(
  context: PacketInstanceUpdateContext,
  update: InstanceUpdate,
): PacketInstanceUpdateResult {
  assertPacketDeformationSupported(update, context?.commitDeformation !== undefined);
  const features = new Map(Array.from(context.geometries, ([id, value]) => [id, {
    uv0: value.source.uv0 !== undefined,
    uv1: value.source.uv1 !== undefined,
    tangents: value.source.tangents !== undefined,
    colors: value.source.colors !== undefined,
    triangles: value.source.indices.length / 3,
    center: geometryCenter(value.source),
  }]));
  const prepared = prepareInstanceUpdate(features, update, context.textures.semanticMap(), context.deformation);
  const history = collectTransformHistory(context.batches);
  for (const source of prepared) {
    if (source.data.byteLength > context.session.device.limits.maxBufferSize) {
      throw new Error("Instances exceed device buffer limit.");
    }
  }

  const batches = new Map<string, CachedPacketBatch>();
  const createdBuffers: GPUBuffer[] = [];
  const acquiredMaterials: MaterialBinding[] = [];
  const writes: PendingWrite[] = [];
  const attempted: AttemptedWrite[] = [];
  const historyUpdates = new Map<string, Float32Array<ArrayBuffer>>();
  let deformationChanged = false;
  let lodChanged = false;
  try {
    for (const source of prepared) {
      const previous = context.batches.get(source.key);
      const metadataChanged = authorLodMetadataChanged(previous?.source, source);
      const previousTransforms = packPreviousTransforms(source, history);
      const currentTransforms = packCurrentTransforms(source);
      if (!equal(currentTransforms, previousTransforms)) historyUpdates.set(source.key, currentTransforms);
      const lookup = (id: string) => context.textures.get(id)!;
      const sameMaterial = materialBindingMatches(previous?.material, source.textures, lookup);
      const currentChanged = !previous || !equal(previous.source.data, source.data);
      const historyChanged = !previous || !equal(previous.previousTransforms, previousTransforms);
      if (previous && !currentChanged && !historyChanged && sameMaterial) {
        batches.set(source.key, metadataChanged ? { ...previous, source } : previous);
        lodChanged ||= metadataChanged;
        continue;
      }
      const material = sameMaterial
        ? previous?.material
        : context.materials.acquire(source.textures, lookup);
      if (material && material !== previous?.material) acquiredMaterials.push(material);
      const current = ensureBuffer(
        context.session,
        previous?.buffer,
        previous?.capacity ?? 0,
        source.data.byteLength,
        "Deep packet instances",
        createdBuffers,
      );
      const historical = ensureBuffer(
        context.session,
        previous?.previousBuffer,
        previous?.previousCapacity ?? 0,
        previousTransforms.byteLength,
        "Deep packet previous transforms",
        createdBuffers,
      );
      const next: CachedPacketBatch = {
        source,
        buffer: current.buffer,
        capacity: current.capacity,
        previousBuffer: historical.buffer,
        previousCapacity: historical.capacity,
        previousTransforms,
        ...(material ? { material } : {}),
      };
      batches.set(source.key, next);
      writes.push({ next, currentChanged, historyChanged, ...(previous ? { previous } : {}) });
    }
    for (const write of writes) {
      if (write.historyChanged) {
        attempted.push({ buffer: write.next.previousBuffer,
          ...(write.next.previousBuffer === write.previous?.previousBuffer ? { restore: write.previous.previousTransforms } : {}) });
        context.session.device.queue.writeBuffer(write.next.previousBuffer, 0, write.next.previousTransforms);
      }
      if (write.currentChanged) {
        attempted.push({ buffer: write.next.buffer,
          ...(write.next.buffer === write.previous?.buffer ? { restore: write.previous.source.data } : {}) });
        context.session.device.queue.writeBuffer(write.next.buffer, 0, write.next.source.data);
      }
    }
    context.assertCurrent();
    deformationChanged = context.commitDeformation?.() ?? false;
  } catch (error) {
    rollbackWrites(context, attempted, createdBuffers, acquiredMaterials, error);
  }

  try {
    runResourceCleanup("Instance retirement failed.", [...context.batches].flatMap(([key, previous]) => {
      const next = batches.get(key);
      return [() => { if (next?.buffer !== previous.buffer) context.session.release(previous.buffer); },
        () => { if (next?.previousBuffer !== previous.previousBuffer) context.session.release(previous.previousBuffer); },
        () => { if (next?.material !== previous.material) context.materials.release(previous.material); }];
    }));
  } catch (error) {
    // 发布前旧资源已开始退役，不能回到旧映射；连候选一起释放并请求整个 packet 重建。
    const failures: unknown[] = [error];
    try { runResourceCleanup("Instance candidate disposal failed.", [
      ...createdBuffers.map(buffer => () => context.session.release(buffer)),
      ...acquiredMaterials.map(material => () => context.materials.release(material)),
    ]); } catch (cleanup) { failures.push(cleanup); }
    throw new PacketInstanceRollbackError(failures, "Instance retirement failed; packet rebuild is required.");
  }
  return { batches, historyUpdates,
    changed: deformationChanged || lodChanged || writes.length > 0 || context.batches.size !== batches.size };
}

/** Advances motion history only after the renderer has submitted the frame successfully. */
export function commitPacketInstanceFrame(
  session: DeviceSession,
  batches: ReadonlyMap<string, CachedPacketBatch>,
  updates: ReadonlyMap<string, Float32Array<ArrayBuffer>>,
  commitCulling: CommitCullingHistory,
): boolean {
  if (!updates.size) return false;

  const attempted: CachedPacketBatch[] = [];
  try {
    for (const [key, current] of updates) {
      const batch = batches.get(key)!;
      attempted.push(batch);
      session.device.queue.writeBuffer(batch.previousBuffer, 0, current);
    }
    commitCulling(updates);
  } catch (cause) {
    const failures: unknown[] = [];
    for (let index = attempted.length - 1; index >= 0; index--) {
      const batch = attempted[index]!;
      try {
        session.device.queue.writeBuffer(batch.previousBuffer, 0, batch.previousTransforms);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new PacketInstanceRollbackError(
        [cause, ...failures],
        "Frame history rollback failed; packet resources were disposed.",
      );
    }
    throw cause;
  }
  for (const [key, current] of updates) batches.get(key)!.previousTransforms.set(current);
  return true;
}

function ensureBuffer(
  session: DeviceSession,
  current: GPUBuffer | undefined,
  capacity: number,
  required: number,
  label: string,
  created: GPUBuffer[],
): { buffer: GPUBuffer; capacity: number } {
  if (current && capacity >= required) return { buffer: current, capacity };
  const buffer = session.own(session.device.createBuffer({
    label,
    size: Math.max(4, required),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));
  created.push(buffer);
  return { buffer, capacity: Math.max(4, required) };
}

function rollbackWrites(
  context: PacketInstanceUpdateContext,
  attempted: readonly AttemptedWrite[],
  createdBuffers: readonly GPUBuffer[],
  acquiredMaterials: readonly MaterialBinding[],
  cause: unknown,
): never {
  const failures: unknown[] = [];
  for (let index = attempted.length - 1; index >= 0; index--) {
    const { buffer, restore } = attempted[index]!;
    if (!restore) continue;
    try {
      context.session.device.queue.writeBuffer(buffer, 0, restore);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const buffer of createdBuffers) context.session.release(buffer);
  for (const material of acquiredMaterials) context.materials.release(material);
  if (failures.length) {
    throw new PacketInstanceRollbackError(
      [cause, ...failures],
      "Instance rollback failed; packet resources were disposed.",
    );
  }
  throw cause;
}

const equal = (a: Float32Array, b: Float32Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);
