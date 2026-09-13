import type { GeometryResource, PreparedBatch } from "../renderPacketTypes.js";
import type { PreparedTexture } from "../textures/decodedTexture.js";
import type { ResidentPacketBatch, ResidentPacketProjection } from "./residentPacketProjection.js";

interface ResidentPacketProjectionSources {
  readonly batches: readonly ResidentPacketBatch[];
  readonly geometries: ReadonlyMap<string, GeometryResource>;
  readonly textures: ReadonlyMap<string, PreparedTexture>;
}

const sources = new WeakMap<object, ResidentPacketProjectionSources>();

/** Registers trusted immutable CPU sources without exposing their mutable typed-array views. */
export function registerResidentPacketProjectionSources(
  projection: ResidentPacketProjection,
  value: ResidentPacketProjectionSources,
): void {
  if (sources.has(projection)) throw new Error("Resident packet projection sources are already registered.");
  sources.set(projection, value);
}

/** Engine-only zero-copy batch view; foreign test adapters fall back to their public contract. */
export function residentPacketProjectionBatches(
  projection: ResidentPacketProjection,
): readonly ResidentPacketBatch[] {
  return sources.get(projection)?.batches ?? projection.batches;
}

/** Engine-only zero-copy geometry source view. */
export function residentPacketProjectionGeometrySource(
  projection: ResidentPacketProjection,
  id: string,
): GeometryResource | undefined {
  return sources.get(projection)?.geometries.get(id) ?? projection.geometrySource(id);
}

/** Engine-only zero-copy texture source view. */
export function residentPacketProjectionTextureSource(
  projection: ResidentPacketProjection,
  id: string,
): PreparedTexture | undefined {
  return sources.get(projection)?.textures.get(id) ?? projection.textureSource(id);
}

export function publicResidentPacketBatches(
  projection: ResidentPacketProjection,
): readonly ResidentPacketBatch[] {
  const value = sources.get(projection);
  if (!value) throw new Error("Resident packet projection sources are unavailable.");
  return Object.freeze(value.batches.map(batch => Object.freeze({
    ...batch,
    source: snapshotBatch(batch.source),
  })));
}

export function publicResidentPacketGeometrySource(
  projection: ResidentPacketProjection,
  id: string,
): GeometryResource | undefined {
  const source = sources.get(projection)?.geometries.get(id);
  return source && snapshotGeometry(source);
}

export function publicResidentPacketTextureSource(
  projection: ResidentPacketProjection,
  id: string,
): PreparedTexture | undefined {
  const source = sources.get(projection)?.textures.get(id);
  return source && snapshotTexture(source);
}

function snapshotGeometry(source: GeometryResource): GeometryResource {
  return Object.freeze({ ...source, vertices: source.vertices.slice(), indices: source.indices.slice(),
    ...(source.uv0 ? { uv0: source.uv0.slice() } : {}),
    ...(source.uv1 ? { uv1: source.uv1.slice() } : {}),
    ...(source.tangents ? { tangents: source.tangents.slice() } : {}),
  });
}

function snapshotTexture(source: PreparedTexture): PreparedTexture {
  return Object.freeze({ ...source, sampler: Object.freeze({ ...source.sampler }),
    levels: Object.freeze(source.levels.map(level => Object.freeze({
      ...level, data: level.data.slice(),
    }))),
  });
}

function snapshotBatch(source: PreparedBatch): PreparedBatch {
  return Object.freeze({ ...source, instanceIds: Object.freeze(source.instanceIds.slice()),
    data: source.data.slice(),
    ...(source.sortCenter ? { sortCenter: Object.freeze([...source.sortCenter]) as
      readonly [number, number, number] } : {}),
    ...(source.textures ? { textures: snapshotMaterialTextures(source.textures) } : {}),
    ...(source.lod ? { lod: Object.freeze({ ...source.lod,
      levels: Object.freeze(source.lod.levels.map(level => Object.freeze({ ...level }))),
    }) } : {}),
  });
}

function snapshotMaterialTextures(source: NonNullable<PreparedBatch["textures"]>):
NonNullable<PreparedBatch["textures"]> {
  const slot = <T extends { readonly uvTransform: readonly number[] }>(value: T | undefined): T | undefined =>
    value && Object.freeze({ ...value, uvTransform: Object.freeze([...value.uvTransform]) }) as T;
  return Object.freeze({ emissiveStrength: source.emissiveStrength,
    ...(source.baseColor ? { baseColor: slot(source.baseColor)! } : {}),
    ...(source.metallicRoughness ? { metallicRoughness: slot(source.metallicRoughness)! } : {}),
    ...(source.normal ? { normal: slot(source.normal)! } : {}),
    ...(source.occlusion ? { occlusion: slot(source.occlusion)! } : {}),
    ...(source.emissive ? { emissive: slot(source.emissive)! } : {}),
  });
}
