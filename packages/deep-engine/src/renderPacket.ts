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
import type { MaterialInstanceOptions } from "./materialInstanceAbi.js";
import { prepareTextures, validateTextures, type TextureSemantic } from "./textures/decodedTexture.js";
import type { DeformationSnapshot } from "./deformation/types.js";
import { preparePacketDeformation, prepareDeformationPoseUpdate } from "./renderPacketDeformation.js";
export { assertPacketDeformationSupported, prepareDeformationPoseUpdate } from "./renderPacketDeformation.js";

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
  PreparedAuthorSelectedLodProfile,
  PreparedScreenSpaceLodProfile,
  PreparedMaterialTextures,
  PreparedPacket,
  PreparedTextureSlot,
  RenderInstance,
  RenderLodLevel,
  RenderLodProfile,
  RenderAuthorLodLevel,
  RenderAuthorSelectedLodProfile,
  RenderObjectBinding,
  RenderScreenSpaceLodProfile,
  RenderPacket,
  TextureSlot,
} from "./renderPacketTypes.js";

function preparePacketStructure(packet: RenderPacket, options: MaterialInstanceOptions) {
  if (packet.instances.length > 16_384
    || packet.geometries.length > 4096
    || packet.materials.length > 16_384) {
    throw new Error("Render packet exceeds resource limits.");
  }
  const geometries = uniqueById(packet.geometries, "geometry");
  const textures = packet.textures === undefined ? [] : packet.textures;
  validateTextures(textures);
  validateGeometries(geometries);
  const deformation = preparePacketDeformation(packet.deformation, geometries, packet.instances);
  const textureSemantics = new Map(textures.map(texture => [texture.id, texture.semantic]));
  const batches = prepareInstanceUpdate(geometryFeatureMap(geometries), { materials: packet.materials, instances: packet.instances,
    ...(deformation ? { poses: deformation.poses } : {}) }, textureSemantics, deformation, options);
  return { geometries, deformation, batches };
}

/** Same admission rules as preparation, without unused geometry or pixel snapshots. */
export function validateRenderPacket(packet: RenderPacket, options: MaterialInstanceOptions = {}): void {
  preparePacketStructure(packet, options);
}

export function prepareRenderPacket(packet: RenderPacket, options: MaterialInstanceOptions = {}): PreparedPacket {
  const { geometries, deformation, batches } = preparePacketStructure(packet, options);
  const usedTextures = collectUsedTextures(batches);
  return {
    geometries: snapshotUsedGeometries(geometries, batches, deformation?.sources.map(source => source.geometry)),
    ...(deformation ? { deformation } : {}),
    textures: prepareTextures((packet.textures ?? []).filter(texture => usedTextures.has(texture.id))),
    batches,
  };
}

export function prepareInstanceUpdate(
  geometries: ReadonlySet<string> | ReadonlyMap<string, boolean | GeometryFeatures>,
  update: InstanceUpdate,
  textureSemantics: ReadonlyMap<string, TextureSemantic> = new Map(),
  deformation?: DeformationSnapshot,
  options: MaterialInstanceOptions = {},
): readonly PreparedBatch[] {
  if (update.instances.length > 16_384 || update.materials.length > 16_384) {
    throw new Error("Instance update exceeds resource limits.");
  }
  const materials = uniqueById(update.materials, "material");
  validateInstanceIds(update.instances);
  const currentDeformation = prepareDeformationPoseUpdate(deformation, update.poses, update.instances);
  if (currentDeformation) for (const instance of update.instances) {
    if (instance.pose === undefined || !materials.get(instance.material)?.normalTexture) continue;
    const pose = currentDeformation.poses.find(value => value.id === instance.pose);
    const source = currentDeformation.sources.find(value => value.id === pose?.source);
    if (!(source?.kind === "skin" ? source.skinning?.tangents : source?.morph?.tangents))
      throw new Error("Deformed normal-mapped instances require a deformable tangent stream.");
  }
  const materialTextures = prepareMaterialTextures(materials, textureSemantics);
  return packInstanceBatches(geometries, update.instances, materials, materialTextures, options);
}

function collectUsedTextures(batches: readonly PreparedBatch[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const batch of batches) {
    if (batch.textures?.baseColor) result.add(batch.textures.baseColor.texture);
    if (batch.textures?.metallicRoughness) result.add(batch.textures.metallicRoughness.texture);
    if (batch.textures?.normal) result.add(batch.textures.normal.texture);
    if (batch.textures?.occlusion) result.add(batch.textures.occlusion.texture);
    if (batch.textures?.emissive) result.add(batch.textures.emissive.texture);
    if (batch.textures?.specular) result.add(batch.textures.specular.texture);
    if (batch.textures?.specularColor) result.add(batch.textures.specularColor.texture);
    for (const layer of batch.textures?.layered?.textures ?? []) {
      if (layer.baseColor) result.add(layer.baseColor.texture);
      if (layer.metallicRoughness) result.add(layer.metallicRoughness.texture);
    }
  }
  return result;
}
