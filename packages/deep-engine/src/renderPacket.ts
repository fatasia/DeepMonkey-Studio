import { packInstanceBatches, validateInstanceIds } from "./renderPacketBatches.js";
import {
  geometryFeatureMap,
  snapshotUsedGeometries,
  validateGeometries,
} from "./renderPacketGeometry.js";
import { prepareMaterialTextures } from "./renderPacketMaterials.js";
import type {
  GeometryFeatures,
  InstanceUpdate,
  PreparedBatch,
  PreparedPacket,
  RenderPacket,
} from "./renderPacketTypes.js";
import { uniqueById } from "./renderPacketValidation.js";
import { prepareTextures, type TextureSemantic } from "./textures/decodedTexture.js";

export { geometryCenter } from "./renderPacketGeometry.js";
export { MAX_EMISSIVE_STRENGTH } from "./renderPacketMaterials.js";
export type {
  AlphaMode,
  GeometryFeatures,
  GeometryResource,
  InstanceUpdate,
  NormalTextureSlot,
  OcclusionTextureSlot,
  PbrMaterial,
  PreparedBatch,
  PreparedLodLevel,
  PreparedLodProfile,
  PreparedMaterialTextures,
  PreparedPacket,
  PreparedTextureSlot,
  RenderInstance,
  RenderLodLevel,
  RenderLodProfile,
  RenderPacket,
  TextureSlot,
} from "./renderPacketTypes.js";

export function prepareRenderPacket(packet: RenderPacket): PreparedPacket {
  if (packet.instances.length > 16_384
    || packet.geometries.length > 4096
    || packet.materials.length > 16_384) {
    throw new Error("Render packet exceeds resource limits.");
  }
  const geometries = uniqueById(packet.geometries, "geometry");
  const textures = prepareTextures(packet.textures === undefined ? [] : packet.textures);
  validateGeometries(geometries);
  const textureSemantics = new Map(textures.map(texture => [texture.id, texture.semantic]));
  const batches = prepareInstanceUpdate(geometryFeatureMap(geometries), packet, textureSemantics);
  const usedTextures = collectUsedTextures(batches);
  return {
    geometries: snapshotUsedGeometries(geometries, batches),
    textures: textures.filter(texture => usedTextures.has(texture.id)),
    batches,
  };
}

export function prepareInstanceUpdate(
  geometries: ReadonlySet<string> | ReadonlyMap<string, boolean | GeometryFeatures>,
  update: InstanceUpdate,
  textureSemantics: ReadonlyMap<string, TextureSemantic> = new Map(),
): readonly PreparedBatch[] {
  if (update.instances.length > 16_384 || update.materials.length > 16_384) {
    throw new Error("Instance update exceeds resource limits.");
  }
  const materials = uniqueById(update.materials, "material");
  validateInstanceIds(update.instances);
  const materialTextures = prepareMaterialTextures(materials, textureSemantics);
  return packInstanceBatches(geometries, update.instances, materials, materialTextures);
}

function collectUsedTextures(batches: readonly PreparedBatch[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const batch of batches) {
    if (batch.textures?.baseColor) result.add(batch.textures.baseColor.texture);
    if (batch.textures?.metallicRoughness) result.add(batch.textures.metallicRoughness.texture);
    if (batch.textures?.normal) result.add(batch.textures.normal.texture);
    if (batch.textures?.occlusion) result.add(batch.textures.occlusion.texture);
    if (batch.textures?.emissive) result.add(batch.textures.emissive.texture);
  }
  return result;
}
