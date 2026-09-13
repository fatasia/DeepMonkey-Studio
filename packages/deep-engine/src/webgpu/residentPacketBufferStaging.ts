import type { PreparedBatch } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import {
  type MaterialBinding,
  type MaterialBindingPool,
  materialBindingMatches,
} from "./materialBindings.js";
import { uploadBuffer } from "./meshBuffers.js";
import { collectTransformHistory, packPreviousTransforms } from "./packetInstanceHistory.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { PacketGeometryBounds } from "./packetGeometryBounds.js";
import { stageResidentPacketGeometries } from "./residentPacketGeometryStaging.js";
import type {
  ResidentPacketBatch,
  ResidentPacketProjection,
  ResidentPacketTextureRole,
} from "./residentPacketProjection.js";
import { residentPacketProjectionBatches,
  residentPacketProjectionTextureSource } from "./residentPacketProjectionView.js";
import type { TextureBinding } from "./textureResources.js";

export interface ResidentPacketBufferStagingContext {
  readonly session: DeviceSession;
  readonly materials: MaterialBindingPool;
  readonly geometries: ReadonlyMap<string, CachedPacketGeometry>;
  readonly batches: ReadonlyMap<string, CachedPacketBatch>;
  readonly geometryBounds?: ReadonlyMap<string, PacketGeometryBounds>;
}

export interface StagedResidentPacketBuffers {
  readonly geometries: Map<string, CachedPacketGeometry>;
  readonly geometryBounds: ReadonlyMap<string, PacketGeometryBounds>;
  readonly batches: Map<string, CachedPacketBatch>;
  readonly createdBuffers: GPUBuffer[];
  readonly acquiredMaterials: MaterialBinding[];
  readonly projection: ResidentPacketProjection;
  readonly changed: boolean;
  settled: boolean;
}

export interface ResidentPacketBufferPublication {
  readonly geometries: Map<string, CachedPacketGeometry>;
  readonly geometryBounds: ReadonlyMap<string, PacketGeometryBounds>;
  readonly batches: Map<string, CachedPacketBatch>;
  /** Owns every borrowed streamed mesh and texture until release() is called. */
  readonly projection: ResidentPacketProjection;
  readonly changed: boolean;
}
/**
 * Takes ownership of projection and stages only packet-local auxiliary resources.
 * The current cache remains drawable until the returned stage is committed.
 */
export function stageResidentPacketBuffers(
  context: ResidentPacketBufferStagingContext,
  projection: ResidentPacketProjection,
): StagedResidentPacketBuffers {
  if (projection.released) throw new Error("Resident packet projection is already released.");
  if (context.session.state !== "ready") throw new Error("Packet resources are not ready.");
  const batches = new Map<string, CachedPacketBatch>();
  const createdBuffers: GPUBuffer[] = [];
  const acquiredMaterials: MaterialBinding[] = [];
  const history = collectTransformHistory(context.batches);
  let geometryStage: ReturnType<typeof stageResidentPacketGeometries>;
  try {
    geometryStage = stageResidentPacketGeometries(context.geometries, projection);
    for (const resident of residentPacketProjectionBatches(projection)) {
      const textures = validateTextureClosure(projection, resident);
      stageBatch(context, resident.source, textures, history, batches,
        createdBuffers, acquiredMaterials);
    }
  } catch (error) {
    const failures = releaseCandidates(context, createdBuffers, acquiredMaterials, projection);
    if (failures.length) {
      throw new AggregateError([error, ...failures], "Resident packet staging rollback failed.");
    }
    throw error;
  }
  const { geometries, geometryBounds } = geometryStage;
  return {
    geometries, geometryBounds, batches, createdBuffers, acquiredMaterials, projection, settled: false,
    changed: !sameMapEntries(context.geometries, geometries)
      || !sameMapEntries(context.batches, batches)
      || (context.geometryBounds !== undefined && !sameBounds(context.geometryBounds, geometryBounds)),
  };
}

/** Transfers candidate ownership to the caller without touching the current drawable cache. */
export function commitResidentPacketBufferStage(
  context: ResidentPacketBufferStagingContext,
  staged: StagedResidentPacketBuffers,
): ResidentPacketBufferPublication {
  if (staged.settled) throw new Error("Resident packet stage is already settled.");
  if (staged.projection.released || context.session.state !== "ready") {
    discardResidentPacketBufferStage(context, staged);
    throw new Error("Resident packet stage cannot be published.");
  }
  staged.settled = true;
  return Object.freeze({ geometries: staged.geometries, geometryBounds: staged.geometryBounds,
    batches: staged.batches,
    projection: staged.projection, changed: staged.changed });
}

/** Idempotently releases only this candidate's auxiliary resources and projection leases. */
export function discardResidentPacketBufferStage(
  context: ResidentPacketBufferStagingContext,
  staged: StagedResidentPacketBuffers,
): void {
  if (staged.settled) return;
  staged.settled = true;
  const failures = releaseCandidates(context, staged.createdBuffers,
    staged.acquiredMaterials, staged.projection);
  if (failures.length) throw new AggregateError(failures, "Resident packet stage discard failed.");
}

const TEXTURE_ROLES = Object.freeze([
  "baseColor", "metallicRoughness", "normal", "occlusion", "emissive",
] as const satisfies readonly ResidentPacketTextureRole[]);

const ROLE_SEMANTICS = Object.freeze({
  baseColor: "baseColor", metallicRoughness: "metallicRoughness", normal: "normal",
  occlusion: "occlusion", emissive: "emissive",
} as const);

function validateTextureClosure(
  projection: ResidentPacketProjection,
  resident: ResidentPacketBatch,
): ReadonlyMap<string, TextureBinding> {
  const expected = resident.source.textures;
  const expectedCount = TEXTURE_ROLES.reduce((count, role) => count + (expected?.[role] ? 1 : 0), 0);
  if (resident.textures.length !== expectedCount) {
    throw new Error(`Resident material texture closure is incomplete: ${resident.source.key}.`);
  }
  const byRole = new Map<ResidentPacketTextureRole, ResidentPacketBatch["textures"][number]>();
  for (const binding of resident.textures) {
    if (!TEXTURE_ROLES.includes(binding.role) || byRole.has(binding.role)) {
      throw new Error(`Resident material texture roles are invalid: ${resident.source.key}.`);
    }
    byRole.set(binding.role, binding);
  }
  const textures = new Map<string, TextureBinding>();
  for (const role of TEXTURE_ROLES) {
    const slot = expected?.[role];
    if (!slot) continue;
    const binding = byRole.get(role), handle = binding?.texture;
    if (!binding || binding.slot !== slot || !handle || handle.kind !== "texture"
      || handle.id !== slot.texture || handle.semantic !== ROLE_SEMANTICS[role]
      || projection.texture(slot.texture) !== handle
      || !validTextureHandle(projection, handle)) {
      throw new Error(`Resident ${role} texture binding is invalid: ${slot.texture}.`);
    }
    const previous = textures.get(handle.id);
    if (previous && previous !== handle) {
      throw new Error(`Resident texture binding is inconsistent: ${handle.id}.`);
    }
    textures.set(handle.id, handle);
  }
  return textures;
}

function validTextureHandle(projection: ResidentPacketProjection,
  value: ResidentPacketBatch["textures"][number]["texture"]): boolean {
  const source = residentPacketProjectionTextureSource(projection, value.id);
  const validLevel = Number.isSafeInteger(value.level) && value.level >= 0;
  const levels = validLevel ? source?.levels.slice(value.level) ?? [] : [];
  const base = levels[0], bytes = levels.reduce((sum, level) => sum + level.byteLength, 0);
  return validLevel && !!source && source.id === value.id && source.revision === value.revision
    && source.semantic === value.semantic && source.format === value.format
    && source.requiredFeature === value.requiredFeature && !!base
    && value.byteLength === bytes && value.width === base.width && value.height === base.height
    && value.mipLevelCount === levels.length && !!value.texture && !!value.view && !!value.sampler;
}

function stageBatch(
  context: ResidentPacketBufferStagingContext,
  source: PreparedBatch,
  textures: ReadonlyMap<string, TextureBinding>,
  history: ReturnType<typeof collectTransformHistory>,
  target: Map<string, CachedPacketBatch>,
  created: GPUBuffer[],
  acquired: MaterialBinding[],
): void {
  if (target.has(source.key)) throw new Error(`Duplicate resident packet batch: ${source.key}.`);
  const previous = context.batches.get(source.key);
  const lookup = (id: string): TextureBinding => {
    const binding = textures.get(id);
    if (!binding) throw new Error(`Resident texture binding is unavailable: ${id}.`);
    return binding;
  };
  const sameMaterial = materialBindingMatches(previous?.material, source.textures, lookup);
  const material = sameMaterial ? previous?.material : context.materials.acquire(source.textures, lookup);
  if (!sameMaterial && material) acquired.push(material);
  const reuseInstances = previous !== undefined && sameInstancePayload(previous.source, source);
  let buffer = previous?.buffer, previousBuffer = previous?.previousBuffer;
  let previousTransforms = previous?.previousTransforms;
  if (!reuseInstances) {
    if (source.data.byteLength > context.session.device.limits.maxBufferSize) {
      throw new Error("Instances exceed device buffer limit.");
    }
    buffer = uploadBuffer(context.session, "Deep packet instances", source.data,
      GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
    created.push(buffer);
    previousTransforms = packPreviousTransforms(source, history);
    previousBuffer = uploadBuffer(context.session, "Deep packet previous transforms",
      previousTransforms, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
    created.push(previousBuffer);
  }
  if (previous && reuseInstances && sameMaterial && sameBatchSource(previous.source, source)) {
    target.set(source.key, previous); return;
  }
  target.set(source.key, { source, buffer: buffer!, capacity: reuseInstances
    ? previous!.capacity : source.data.byteLength, previousBuffer: previousBuffer!,
    previousCapacity: reuseInstances ? previous!.previousCapacity : previousTransforms!.byteLength,
    previousTransforms: previousTransforms!, ...(material ? { material } : {}) });
}

function sameInstancePayload(left: PreparedBatch, right: PreparedBatch): boolean {
  return left.geometry === right.geometry && left.count === right.count
    && equalStrings(left.instanceIds, right.instanceIds) && equalNumbers(left.data, right.data);
}

function sameBatchSource(left: PreparedBatch, right: PreparedBatch): boolean {
  return sameInstancePayload(left, right) && left.key === right.key
    && left.mirrored === right.mirrored && left.doubleSided === right.doubleSided
    && left.alphaMode === right.alphaMode && equalOptionalNumbers(left.sortCenter, right.sortCenter)
    && JSON.stringify(left.textures) === JSON.stringify(right.textures)
    && JSON.stringify(left.lod) === JSON.stringify(right.lod);
}

function releaseCandidates(context: ResidentPacketBufferStagingContext,
  buffers: readonly GPUBuffer[], materials: readonly MaterialBinding[],
  projection: ResidentPacketProjection): unknown[] {
  const failures: unknown[] = [];
  for (let index = buffers.length - 1; index >= 0; index--) {
    try { context.session.release(buffers[index]!); } catch (error) { failures.push(error); }
  }
  for (let index = materials.length - 1; index >= 0; index--) {
    try { context.materials.release(materials[index]); } catch (error) { failures.push(error); }
  }
  try { projection.release(); } catch (error) { failures.push(error); }
  return failures;
}

function sameMapEntries<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  return left.size === right.size && Array.from(right).every(([key, value]) => left.get(key) === value);
}
function sameBounds(left: ReadonlyMap<string, PacketGeometryBounds>,
  right: ReadonlyMap<string, PacketGeometryBounds>): boolean {
  return left.size === right.size && Array.from(right).every(([id, value]) => {
    const previous = left.get(id);
    return previous?.revision === value.revision && previous.radius === value.radius
      && previous.center.every((axis, index) => axis === value.center[index]);
  });
}
const equalNumbers = (left: ArrayLike<number>, right: ArrayLike<number>): boolean =>
  left.length === right.length && Array.from(left).every((value, index) => value === right[index]);
const equalStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const equalOptionalNumbers = (left: ArrayLike<number> | undefined, right: ArrayLike<number> | undefined): boolean =>
  left === undefined ? right === undefined : right !== undefined && equalNumbers(left, right);
