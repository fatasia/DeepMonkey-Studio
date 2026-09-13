import type {
  GeometryResource,
  PreparedBatch,
  PreparedMaterialTextures,
  PreparedPacket,
} from "../renderPacket.js";
import type { GpuResidentLease } from "../streaming/gpuResidentLease.js";
import type { PreparedTexture, TextureSemantic } from "../textures/decodedTexture.js";
import type {
  GpuGeometryResidencyHandle,
} from "./gpuGeometryResidencyUploader.js";
import type {
  GpuRenderResidencyHandle,
} from "./gpuRenderResidencyUploader.js";
import type {
  GpuTextureResidencyHandle,
} from "./gpuTextureResidencyUploader.js";
import { publicResidentPacketBatches, publicResidentPacketGeometrySource,
  publicResidentPacketTextureSource, registerResidentPacketProjectionSources } from "./residentPacketProjectionView.js";

export type ResidentPacketTextureRole =
  "baseColor" | "metallicRoughness" | "normal" | "occlusion" | "emissive";

export type ResidentPacketTextureBinding = {
  readonly [Role in ResidentPacketTextureRole]: Readonly<{
    role: Role;
    slot: NonNullable<PreparedMaterialTextures[Role]>;
    texture: GpuTextureResidencyHandle;
  }>
}[ResidentPacketTextureRole];

/** Contains each leased geometry once; identify LOD levels by handle.sourceId. */
export interface ResidentPacketBatch {
  readonly source: PreparedBatch;
  readonly geometries: readonly GpuGeometryResidencyHandle[];
  readonly textures: readonly ResidentPacketTextureBinding[];
}

export type ResidentPacketLeaseProvider = (
  kind: GpuRenderResidencyHandle["kind"],
  id: string,
) => GpuResidentLease<GpuRenderResidencyHandle> | undefined;

export interface ResidentPacketProjectionOptions {
  /** Allows absent finer LODs while requiring a resident coarsest fallback. */
  readonly allowPartialLod?: boolean;
}

export interface ResidentPacketProjection {
  readonly batches: readonly ResidentPacketBatch[];
  readonly released: boolean;
  readonly partialLod?: boolean;
  geometry(id: string): GpuGeometryResidencyHandle | undefined;
  geometrySource(id: string): GeometryResource | undefined;
  texture(id: string): GpuTextureResidencyHandle | undefined;
  textureSource(id: string): PreparedTexture | undefined;
  /** Idempotent and best effort: every lease is attempted before an error is rethrown. */
  release(): void;
}

const TEXTURE_ROLES = Object.freeze([
  "baseColor", "metallicRoughness", "normal", "occlusion", "emissive",
] as const);

const ROLE_SEMANTICS = Object.freeze({
  baseColor: "baseColor",
  metallicRoughness: "metallicRoughness",
  normal: "normal",
  occlusion: "occlusion",
  emissive: "emissive",
} as const satisfies Record<ResidentPacketTextureRole, TextureSemantic>);

/**
 * Acquires one lease per unique packet dependency and publishes only after every
 * batch has a complete, revision-matched geometry and material texture closure.
 */
export function createResidentPacketProjection(
  packet: PreparedPacket,
  acquire: ResidentPacketLeaseProvider,
  options: ResidentPacketProjectionOptions = {},
): ResidentPacketProjection {
  const leases: GpuResidentLease<GpuRenderResidencyHandle>[] = [];
  const seenLeases = new Set<GpuResidentLease<GpuRenderResidencyHandle>>();
  const geometries = new Map<string, GpuGeometryResidencyHandle>();
  const textures = new Map<string, GpuTextureResidencyHandle>();
  try {
    const textureSources = indexTextures(packet.textures);
    const batches = packet.batches.map(batch => Object.freeze({
      source: batch,
      geometries: acquireBatchGeometries(batch),
      textures: Object.freeze(textureSlots(batch).map(({ role, slot }) => {
        const source = textureSources.get(slot.texture);
        if (!source || source.semantic !== ROLE_SEMANTICS[role]) {
          throw new Error(`Missing prepared ${role} texture dependency: ${slot.texture}.`);
        }
        const texture = textures.get(slot.texture) ?? acquireTexture(source);
        return bindTexture({ role, slot } as ResidentPacketTextureSource, texture);
      })),
    } satisfies ResidentPacketBatch));
    return new Projection(Object.freeze(batches), geometries, textures,
      packet.geometries, textureSources, leases, options.allowPartialLod === true);
  } catch (error) {
    const failures = releaseAll(leases);
    if (failures.length) throw new AggregateError([error, ...failures], "Resident packet projection rollback failed.");
    throw error;
  }

  function take(kind: GpuRenderResidencyHandle["kind"], id: string,
    required = true): GpuRenderResidencyHandle | undefined {
    const lease = acquire(kind, id);
    if (!lease && !required) return undefined;
    if (!lease || typeof lease !== "object" || typeof lease.release !== "function") {
      throw new Error(`GPU resident dependency is unavailable: ${kind}:${id}.`);
    }
    if (seenLeases.has(lease)) throw new Error(`GPU resident provider reused a lease: ${kind}:${id}.`);
    seenLeases.add(lease); leases.push(lease);
    if (!lease.resource || typeof lease.resource !== "object") {
      throw new Error(`GPU resident lease has no resource: ${kind}:${id}.`);
    }
    return lease.resource;
  }

  function acquireGeometry(id: string, revision: number,
    required: boolean): GpuGeometryResidencyHandle | undefined {
    const handle = take("geometry", id, required);
    if (!handle) return undefined;
    if (handle.kind !== "geometry" || handle.sourceId !== id || handle.sourceRevision !== revision
      || !Number.isSafeInteger(handle.level) || handle.level < 0 || !handle.mesh) {
      throw new Error(`GPU geometry dependency differs from prepared packet: ${id}.`);
    }
    geometries.set(id, handle); return handle;
  }

  function acquireBatchGeometries(batch: PreparedBatch): readonly GpuGeometryResidencyHandle[] {
    const levels = geometryLevels(batch, options.allowPartialLod === true);
    const result: GpuGeometryResidencyHandle[] = [];
    const ids = new Set<string>();
    const handles = new Set<GpuGeometryResidencyHandle>();
    for (const level of levels) {
      if (!level.acquire) continue;
      const source = packet.geometries.get(level.id);
      if (!source || source.id !== level.id) {
        throw new Error(`Missing prepared geometry dependency: ${level.id}.`);
      }
      const handle = geometries.get(level.id)
        ?? acquireGeometry(level.id, source.revision, level.required);
      if (!handle) continue;
      if (ids.has(handle.sourceId) || handles.has(handle)) {
        throw new Error(`Duplicate resident geometry handle: ${handle.sourceId}.`);
      }
      ids.add(handle.sourceId); handles.add(handle); result.push(handle);
    }
    return Object.freeze(result);
  }

  function acquireTexture(source: PreparedTexture): GpuTextureResidencyHandle {
    const handle = take("texture", source.id)!;
    const levels = handle.kind === "texture" ? source.levels.slice(handle.level) : [];
    const base = levels[0], byteLength = levels.reduce((sum, level) => sum + level.byteLength, 0);
    if (handle.kind !== "texture" || handle.id !== source.id || handle.revision !== source.revision
      || handle.semantic !== source.semantic || handle.format !== source.format
      || !Number.isSafeInteger(handle.level) || handle.level < 0 || !base
      || handle.byteLength !== byteLength || handle.width !== base.width
      || handle.height !== base.height || handle.mipLevelCount !== levels.length
      || handle.requiredFeature !== source.requiredFeature
    ) {
      throw new Error(`GPU texture dependency differs from prepared packet: ${source.id}.`);
    }
    textures.set(source.id, handle); return handle;
  }
}

class Projection implements ResidentPacketProjection {
  private releasedValue = false;
  constructor(
    batches: readonly ResidentPacketBatch[],
    private readonly geometries: ReadonlyMap<string, GpuGeometryResidencyHandle>,
    private readonly textures: ReadonlyMap<string, GpuTextureResidencyHandle>,
    private readonly geometrySources: ReadonlyMap<string, GeometryResource>,
    private readonly textureSources: ReadonlyMap<string, PreparedTexture>,
    private readonly leases: readonly GpuResidentLease<GpuRenderResidencyHandle>[],
    readonly partialLod: boolean,
  ) { registerResidentPacketProjectionSources(this,
    { batches, geometries: geometrySources, textures: textureSources }); }
  get batches(): readonly ResidentPacketBatch[] { return publicResidentPacketBatches(this); }
  get released(): boolean { return this.releasedValue; }
  geometry(id: string): GpuGeometryResidencyHandle | undefined { return this.geometries.get(id); }
  geometrySource(id: string): GeometryResource | undefined { return publicResidentPacketGeometrySource(this, id); }
  texture(id: string): GpuTextureResidencyHandle | undefined { return this.textures.get(id); }
  textureSource(id: string): PreparedTexture | undefined { return publicResidentPacketTextureSource(this, id); }
  release(): void {
    if (this.releasedValue) return;
    this.releasedValue = true;
    const failures = releaseAll(this.leases);
    if (failures.length) throw new AggregateError(failures, "Resident packet projection release failed.");
  }
}

interface GeometryLevelRequest {
  readonly id: string;
  readonly acquire: boolean;
  readonly required: boolean;
}

function geometryLevels(batch: PreparedBatch, partial: boolean): readonly GeometryLevelRequest[] {
  if (!batch.lod) return [{ id: batch.geometry, acquire: true, required: true }];
  if (!batch.lod.levels.length || batch.lod.levels[0]?.geometry !== batch.geometry) {
    throw new Error(`Invalid prepared LOD dependency order: ${batch.key}.`);
  }
  if (!partial) return batch.lod.levels.map(level => ({
    id: level.geometry, acquire: true, required: true,
  }));
  const coarsest = batch.lod.levels.at(-1)!;
  if (!coarsest.resident) {
    throw new Error(`Prepared LOD coarsest fallback is unavailable: ${coarsest.geometry}.`);
  }
  return batch.lod.levels.map(level => ({
    id: level.geometry,
    acquire: level.resident,
    required: level === coarsest,
  }));
}

type ResidentPacketTextureSource = {
  readonly [Role in ResidentPacketTextureRole]: Readonly<{
    role: Role;
    slot: NonNullable<PreparedMaterialTextures[Role]>;
  }>
}[ResidentPacketTextureRole];

function textureSlots(batch: PreparedBatch): readonly ResidentPacketTextureSource[] {
  if (!batch.textures) return [];
  return TEXTURE_ROLES.flatMap(role => {
    const slot = batch.textures?.[role];
    return slot ? [{ role, slot } as ResidentPacketTextureSource] : [];
  });
}

function bindTexture(
  source: ResidentPacketTextureSource,
  texture: GpuTextureResidencyHandle,
): ResidentPacketTextureBinding {
  return Object.freeze({ ...source, texture }) as ResidentPacketTextureBinding;
}

function indexTextures(values: readonly PreparedTexture[]): ReadonlyMap<string, PreparedTexture> {
  const result = new Map<string, PreparedTexture>();
  for (const value of values) {
    if (result.has(value.id)) throw new Error(`Duplicate prepared texture dependency: ${value.id}.`);
    result.set(value.id, value);
  }
  return result;
}

function releaseAll(leases: readonly GpuResidentLease<GpuRenderResidencyHandle>[]): unknown[] {
  const failures: unknown[] = [];
  for (let index = leases.length - 1; index >= 0; index--) {
    try { leases[index]!.release(); }
    catch (error) { failures.push(error); }
  }
  return failures;
}
