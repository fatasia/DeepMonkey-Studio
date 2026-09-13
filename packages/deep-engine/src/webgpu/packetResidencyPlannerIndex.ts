import type { PreparedBatch, PreparedPacket } from "../renderPacketTypes.js";
import type { PreparedTexture } from "../textures/decodedTexture.js";

export interface CompiledResidencyBatch {
  readonly order: number;
  readonly key: string;
  readonly geometry: string;
  readonly fallbackGeometry: string;
  readonly instances: ReadonlySet<string>;
  readonly textures: readonly string[];
  /** Resident geometry selected for each authored desired LOD index. */
  readonly lod?: readonly string[];
}

export interface CompiledResidencyTexture {
  readonly id: string;
  readonly independentMipCount: number;
}

export interface CompiledPacketResidencyIndex {
  readonly batches: ReadonlyMap<string, CompiledResidencyBatch>;
  readonly textures: ReadonlyMap<string, CompiledResidencyTexture>;
  readonly geometryOrder: ReadonlyMap<string, number>;
  readonly textureOrder: ReadonlyMap<string, number>;
}

/** Copies only immutable planning metadata; source payloads and caller collections are never retained. */
export function compilePacketResidencyIndex(packet: PreparedPacket): CompiledPacketResidencyIndex {
  if (!packet || typeof packet !== "object" || !(packet.geometries instanceof Map)
    || !Array.isArray(packet.textures) || !Array.isArray(packet.batches)) {
    throw new TypeError("Prepared packet is invalid.");
  }
  const geometryOrder = new Map<string, number>(); let position = 0;
  for (const [key, source] of packet.geometries) {
    if (!source || key !== source.id || geometryOrder.has(key)) {
      throw new Error(`Invalid packet geometry: ${key}.`);
    }
    geometryOrder.set(key, position++);
  }
  const textures = new Map<string, CompiledResidencyTexture>(), textureOrder = new Map<string, number>();
  for (const source of packet.textures) {
    if (!source || typeof source.id !== "string" || textures.has(source.id)) {
      throw new Error(`Invalid packet texture: ${String(source?.id)}.`);
    }
    textures.set(source.id, Object.freeze({ id: source.id,
      independentMipCount: independentMipCount(source) }));
    textureOrder.set(source.id, position++);
  }
  const batches = new Map<string, CompiledResidencyBatch>();
  for (const source of packet.batches) {
    const batch = compileBatch(source, batches.size, geometryOrder, textures, batches);
    batches.set(batch.key, batch);
  }
  return Object.freeze({ batches, textures, geometryOrder, textureOrder });
}

function compileBatch(source: PreparedBatch, order: number,
  geometries: ReadonlyMap<string, number>, textures: ReadonlyMap<string, CompiledResidencyTexture>,
  batches: ReadonlyMap<string, CompiledResidencyBatch>): CompiledResidencyBatch {
  if (!source || typeof source.key !== "string" || !source.key.length || batches.has(source.key)
    || !Array.isArray(source.instanceIds) || source.count !== source.instanceIds.length) {
    throw new Error(`Invalid packet residency batch: ${String(source?.key)}.`);
  }
  if (!geometries.has(source.geometry)) {
    throw new Error(`Packet residency geometry is unavailable: ${source.geometry}.`);
  }
  const instances = new Set<string>(source.instanceIds);
  if (instances.size !== source.instanceIds.length) {
    throw new Error(`Duplicate packet instance in batch: ${source.key}.`);
  }
  const lod = compileLod(source, geometries);
  const textureIds = batchTextures(source);
  for (const id of textureIds) {
    if (!textures.has(id)) throw new Error(`Packet residency texture is unavailable: ${id}.`);
  }
  return Object.freeze({ order, key: source.key, geometry: source.geometry,
    fallbackGeometry: lod?.at(-1) ?? source.geometry, instances,
    textures: Object.freeze(textureIds), ...(lod ? { lod } : {}) });
}

function compileLod(batch: PreparedBatch,
  geometries: ReadonlyMap<string, number>): readonly string[] | undefined {
  const levels = batch.lod?.levels;
  if (!levels) return undefined;
  if (!Array.isArray(levels) || levels.length < 2 || levels.length > 8
    || levels[0]?.geometry !== batch.geometry) {
    throw new Error(`Invalid packet residency LOD profile: ${batch.key}.`);
  }
  for (const level of levels) {
    if (!level || !geometries.has(level.geometry) || typeof level.resident !== "boolean") {
      throw new Error(`Invalid packet residency LOD geometry: ${batch.key}.`);
    }
  }
  const fallback = levels.at(-1)!;
  if (!fallback.resident) {
    throw new Error(`Packet residency coarsest fallback is unavailable: ${fallback.geometry}.`);
  }
  return Object.freeze(levels.map((_, desired) => {
    let target = desired;
    while (!levels[target]!.resident) target += 1;
    return levels[target]!.geometry;
  }));
}

function independentMipCount(source: PreparedTexture): number {
  if (!Array.isArray(source.levels) || !source.levels.length) {
    throw new Error(`Packet residency texture has no mip levels: ${source.id}.`);
  }
  if (source.format === "rgba8unorm" || source.format === "rgba8unorm-srgb") return source.levels.length;
  let count = 0;
  for (const level of source.levels) {
    if (level.width % 4 || level.height % 4) break;
    count += 1;
  }
  if (!count) throw new Error(`Compressed texture has no independently uploadable level: ${source.id}.`);
  return count;
}

function batchTextures(batch: PreparedBatch): string[] {
  const result: string[] = [], value = batch.textures;
  if (value?.baseColor) result.push(value.baseColor.texture);
  if (value?.metallicRoughness) result.push(value.metallicRoughness.texture);
  if (value?.normal) result.push(value.normal.texture);
  if (value?.occlusion) result.push(value.occlusion.texture);
  if (value?.emissive) result.push(value.emissive.texture);
  return result;
}
