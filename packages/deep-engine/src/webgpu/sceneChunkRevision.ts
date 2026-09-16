import type { GeometryResource, PreparedBatch } from "../renderPacketTypes.js";
import type { PreparedTexture } from "../textures/decodedTexture.js";
import { snapshotPreparedLod } from "./snapshotPreparedLod.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import { publicResidentPacketBatches, publicResidentPacketGeometrySource, publicResidentPacketTextureSource,
  registerResidentPacketProjectionSources, residentPacketProjectionBatches, residentPacketProjectionGeometrySource,
  residentPacketProjectionTextureSource } from "./residentPacketProjectionView.js";

/** Static dependency identity excludes transform/material values and author LOD selection. */
export function sceneChunkBatchIdentity(batch: PreparedBatch): string {
  return JSON.stringify([batch.geometry, batch.instanceIds,
    batch.lod?.levels.map(level => level.geometry), batch.textures]);
}

/** Borrows the same GPU lease closure; only per-frame instance/selection bytes get a new owned snapshot. */
export function reviseSceneChunkProjection(source: ResidentPacketProjection,
  updates: ReadonlyMap<string, PreparedBatch>): ResidentPacketProjection {
  const batches = residentPacketProjectionBatches(source).map(batch => {
    const update = updates.get(batch.source.key);
    if (!update || update.pose !== undefined || sceneChunkBatchIdentity(update) !== sceneChunkBatchIdentity(batch.source)
      || update.count !== batch.source.count || update.data.length !== update.count * 36
      || !update.data.every(Number.isFinite)) throw new Error("Scene chunk revision changed its resource closure.");
    return Object.freeze({ ...batch, source: Object.freeze({ ...update, ...(batch.source.textures ? { textures: batch.source.textures } : {}), data: update.data.slice(),
      instanceIds: Object.freeze([...update.instanceIds]), ...(update.lod ? { lod: snapshotPreparedLod(update.lod) } : {}) }) });
  });
  const geometries = new Map<string, GeometryResource>(), textures = new Map<string, PreparedTexture>();
  for (const batch of batches) {
    for (const id of batch.source.lod?.levels.map(level => level.geometry) ?? [batch.source.geometry]) {
      const value = residentPacketProjectionGeometrySource(source, id); if (value) geometries.set(id, value);
    }
    for (const binding of batch.textures) {
      const id = binding.slot.texture, value = residentPacketProjectionTextureSource(source, id); if (value) textures.set(id, value);
    }
  }
  const projection: ResidentPacketProjection = { get batches() { return publicResidentPacketBatches(projection); },
    ...(source.partialLod === undefined ? {} : { partialLod: source.partialLod }),
    get released() { return source.released; }, geometry: (id: string) => source.geometry(id),
    geometrySource: (id: string) => publicResidentPacketGeometrySource(projection, id), texture: (id: string) => source.texture(id),
    textureSource: (id: string) => publicResidentPacketTextureSource(projection, id), release: () => source.release() };
  registerResidentPacketProjectionSources(projection, { batches: Object.freeze(batches), geometries, textures });
  return Object.freeze(projection);
}
