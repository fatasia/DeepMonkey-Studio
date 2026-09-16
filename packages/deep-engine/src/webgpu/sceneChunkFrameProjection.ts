import type { GeometryResource } from "../renderPacketTypes.js";
import type { PreparedTexture } from "../textures/decodedTexture.js";
import type { GpuGeometryResidencyHandle } from "./gpuGeometryResidencyUploader.js";
import type { GpuTextureResidencyHandle } from "./gpuTextureResidencyUploader.js";
import type { ResidentPacketBatch, ResidentPacketProjection } from "./residentPacketProjection.js";
import { sameResidencySource } from "./packetResidencySnapshot.js";
import { publicResidentPacketBatches, publicResidentPacketGeometrySource, publicResidentPacketTextureSource,
  registerResidentPacketProjectionSources, residentPacketProjectionBatches,
  residentPacketProjectionGeometrySource, residentPacketProjectionTextureSource } from "./residentPacketProjectionView.js";

/** Consumes every child lease as one drawable closure; never copies or destroys author resources. */
export function mergeSceneChunkProjections(children: readonly ResidentPacketProjection[], onRelease: () => void): ResidentPacketProjection {
  let released = false;
  const release = () => {
    if (released) return;
    released = true; onRelease();
    const errors: unknown[] = [];
    for (const child of new Set(children)) try { child.release(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Scene frame projection release failed.");
  };
  try {
    const batches: ResidentPacketBatch[] = [], batchKeys = new Set<string>(), instanceIds = new Set<string>();
    const geometries = new Map<string, GpuGeometryResidencyHandle>(), textures = new Map<string, GpuTextureResidencyHandle>();
    const geometrySources = new Map<string, GeometryResource>(), textureSources = new Map<string, PreparedTexture>();
    if (new Set(children).size !== children.length) throw new Error("Duplicate scene chunk projection.");
    for (const child of children) {
      if (child.released) throw new Error("Scene chunk projection is already released.");
      for (const batch of residentPacketProjectionBatches(child)) {
        if (batch.source.pose !== undefined) throw new Error("Scene chunk deformation is unsupported.");
        if (batchKeys.has(batch.source.key)) throw new Error(`Duplicate scene chunk batch: ${batch.source.key}.`);
        batchKeys.add(batch.source.key);
        for (const id of batch.source.instanceIds) {
          if (instanceIds.has(id)) throw new Error(`Duplicate scene chunk instance: ${id}.`);
          instanceIds.add(id);
        }
        if (instanceIds.size > 16_384) throw new Error("Scene frame exceeds instance limits.");
        for (const handle of batch.geometries) {
          if (child.geometry(handle.sourceId) !== handle) throw new Error(`Conflicting scene chunk batch geometry: ${handle.sourceId}.`);
        }
        for (const id of new Set(batch.source.lod?.levels.map(level => level.geometry) ?? [batch.source.geometry])) {
          const source = residentPacketProjectionGeometrySource(child, id), previous = geometrySources.get(id);
          if (!source || source.id !== id || previous && !sameResidencySource({ kind: "geometry", value: previous }, { kind: "geometry", value: source }))
            throw new Error(`Conflicting scene chunk geometry source: ${id}.`);
          geometrySources.set(id, source);
          if (geometrySources.size > 4096) throw new Error("Scene frame exceeds geometry limits.");
          const handle = child.geometry(id);
          if (handle) {
            if (geometries.has(id) && geometries.get(id) !== handle) throw new Error(`Conflicting scene chunk GPU geometry: ${id}.`);
            geometries.set(id, handle);
          }
        }
        for (const binding of batch.textures) {
          const id = binding.slot.texture, source = residentPacketProjectionTextureSource(child, id), previous = textureSources.get(id);
          if (!source || source.id !== id || previous && !sameResidencySource({ kind: "texture", value: previous }, { kind: "texture", value: source }))
            throw new Error(`Conflicting scene chunk texture source: ${id}.`);
          if (child.texture(id) !== binding.texture || textures.has(id) && textures.get(id) !== binding.texture)
            throw new Error(`Conflicting scene chunk GPU texture: ${id}.`);
          textureSources.set(id, source); textures.set(id, binding.texture);
          if (textureSources.size > 4096) throw new Error("Scene frame exceeds texture limits.");
        }
        batches.push(batch);
      }
    }
    const projection: ResidentPacketProjection = {
      get batches() { return publicResidentPacketBatches(projection); },
      get released() { return released; }, partialLod: children.some(child => child.partialLod),
      geometry: id => geometries.get(id), geometrySource: id => publicResidentPacketGeometrySource(projection, id),
      texture: id => textures.get(id), textureSource: id => publicResidentPacketTextureSource(projection, id), release,
    };
    // Another chunk may lease a finer shared level; the complete frame owns that handle for every batch.
    const combinedBatches = batches.map(batch => Object.freeze({ ...batch, geometries: Object.freeze(
      [...new Set(batch.source.lod?.levels.map(level => level.geometry) ?? [batch.source.geometry])]
        .flatMap(id => { const handle = geometries.get(id); return handle ? [handle] : []; })) }));
    registerResidentPacketProjectionSources(projection, { batches: Object.freeze(combinedBatches), geometries: geometrySources, textures: textureSources });
    return Object.freeze(projection);
  } catch (error) {
    try { release(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Scene chunk merge rollback failed."); }
    throw error;
  }
}
