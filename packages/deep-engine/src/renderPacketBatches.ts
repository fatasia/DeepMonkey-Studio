import { packTransform } from "./instanceTransform.js";
import { getGeometryFeatures, validateGeometryFeatures, type GeometryFeatureSource } from "./renderPacketGeometryFeatures.js";
import { prepareLodProfile } from "./renderPacketLod.js";
import type {
  AlphaMode,
  PbrMaterial,
  PreparedBatch,
  PreparedLodProfile,
  PreparedMaterialTextures,
  RenderInstance,
} from "./renderPacketTypes.js";

interface MutableBatch {
  readonly geometry: string;
  readonly instanceIds: string[];
  readonly mirrored: boolean;
  readonly doubleSided: boolean;
  readonly alphaMode: AlphaMode;
  readonly offsets: number[];
  readonly textures?: PreparedMaterialTextures;
  readonly lod?: PreparedLodProfile;
}

export function validateInstanceIds(instances: readonly RenderInstance[]): void {
  const ids = new Set<string>();
  for (const instance of instances) {
    if (typeof instance.id !== "string" || !instance.id.length || ids.has(instance.id)) {
      throw new Error("Invalid or duplicate instance ID.");
    }
    ids.add(instance.id);
  }
}

export function packInstanceBatches(
  geometries: GeometryFeatureSource,
  instances: readonly RenderInstance[],
  materials: ReadonlyMap<string, PbrMaterial>,
  materialTextures: ReadonlyMap<string, PreparedMaterialTextures | undefined>,
): readonly PreparedBatch[] {
  const staging = new Float32Array(instances.length * 36);
  const grouped = new Map<string, MutableBatch>();
  let offset = 0;
  for (const instance of instances) {
    const material = materials.get(instance.material);
    if (!geometries.has(instance.geometry) || !material) {
      throw new Error(`Missing geometry or material for instance ${instance.id}.`);
    }
    const textures = materialTextures.get(material.id);
    const features = getGeometryFeatures(geometries, instance.geometry);
    validateGeometryFeatures(instance.geometry, material, textures, features);
    const lod = prepareLodProfile(instance, geometries, material, textures);
    const mirrored = packTransform(instance.transform, staging, offset);
    packMaterialRecord(staging, offset, material, textures, mirrored);
    const alphaMode = material.alphaMode ?? "OPAQUE";
    const doubleSided = material.doubleSided === true;
    const batchMirrored = doubleSided ? false : mirrored;
    const key = batchKey(instance.geometry, batchMirrored, doubleSided, alphaMode, textures, lod);
    let batch = grouped.get(key);
    if (!batch) {
      batch = {
        geometry: instance.geometry,
        instanceIds: [],
        mirrored: batchMirrored,
        doubleSided,
        alphaMode,
        offsets: [],
        ...(textures ? { textures } : {}),
        ...(lod ? { lod } : {}),
      };
      grouped.set(key, batch);
    }
    batch.instanceIds.push(instance.id);
    batch.offsets.push(offset);
    offset += 36;
  }
  return finalizeBatches(grouped, staging);
}

function packMaterialRecord(
  target: Float32Array,
  offset: number,
  material: PbrMaterial,
  textures: PreparedMaterialTextures | undefined,
  mirrored: boolean,
): void {
  target[offset + 24] = material.baseColor[0];
  target[offset + 25] = material.baseColor[1];
  target[offset + 26] = material.baseColor[2];
  target[offset + 27] = material.metallic;
  target[offset + 28] = material.roughness;
  target[offset + 29] = Math.fround(material.alphaCutoff ?? 0.5);
  // shader 使用该符号修正镜像实例的 TBN 手性；不占用 ground 标志所在的 material.y。
  target[offset + 30] = mirrored ? -1 : 1;
  const alphaMode = material.alphaMode ?? "OPAQUE";
  const doubleSided = material.doubleSided === true;
  target[offset + 31] = (doubleSided ? 1 : 0) + (alphaMode === "MASK" ? 2 : alphaMode === "BLEND" ? 4 : 0);
  const emissiveFactor = material.emissiveFactor ?? [0, 0, 0];
  // v1 plain ABI 没有空闲标量，故无材质组时预乘 strength；材质组路径在 WGSL 显式乘 emissiveRow1.w。
  const emissiveScale = textures ? 1 : material.emissiveStrength ?? 1;
  target[offset + 32] = emissiveFactor[0] * emissiveScale;
  target[offset + 33] = emissiveFactor[1] * emissiveScale;
  target[offset + 34] = emissiveFactor[2] * emissiveScale;
  target[offset + 35] = material.baseColorAlpha ?? 1;
}

function finalizeBatches(
  grouped: ReadonlyMap<string, MutableBatch>,
  staging: Float32Array<ArrayBuffer>,
): readonly PreparedBatch[] {
  const result: PreparedBatch[] = [];
  for (const [key, group] of grouped) {
    const data = grouped.size === 1 ? staging : new Float32Array(group.offsets.length * 36);
    if (data !== staging) {
      let target = 0;
      for (const source of group.offsets) {
        for (let index = 0; index < 36; index++) data[target++] = staging[source + index]!;
      }
    }
    result.push({
      key,
      geometry: group.geometry,
      instanceIds: Object.freeze(group.instanceIds.slice()),
      mirrored: group.mirrored,
      doubleSided: group.doubleSided,
      alphaMode: group.alphaMode,
      data,
      count: group.offsets.length,
      ...(group.textures ? { textures: group.textures } : {}),
      ...(group.lod ? { lod: group.lod } : {}),
    });
  }
  return result;
}

function batchKey(
  geometry: string,
  mirrored: boolean,
  doubleSided: boolean,
  alphaMode: AlphaMode,
  textures: PreparedMaterialTextures | undefined,
  lod: PreparedLodProfile | undefined,
): string {
  // Keep the retired per-instance transparency discriminator slot stable so existing
  // packet caches do not churn when moving to batched weighted OIT.
  return JSON.stringify([geometry, mirrored, doubleSided, alphaMode, textures ?? null, lod ?? null]);
}
