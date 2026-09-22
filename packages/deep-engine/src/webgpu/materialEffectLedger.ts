import type { InstanceUpdate, PbrMaterial, PreparedBatch } from "../renderPacket.js";

export interface MaterialEffectValues {
  readonly baseColor: readonly [number, number, number];
  readonly metallic: number;
  readonly roughness: number;
  readonly alphaCutoff: number;
  readonly surfaceFlags: number;
  readonly emissive: readonly [number, number, number];
  readonly alpha: number;
  readonly emissiveStrength: number;
  readonly pipeline: Readonly<{ alphaMode: "OPAQUE" | "MASK" | "BLEND"; doubleSided: boolean;
    premultipliedAlpha: boolean; alphaCutoff?: number; castShadow: boolean }>;
  readonly textures: Readonly<Partial<Record<"baseColor" | "metallicRoughness" | "normal" | "occlusion" | "emissive", string>>>;
}

export interface MaterialEffectLedgerEntry {
  readonly instanceId: string;
  readonly materialId: string;
  /** Stable prepared-batch identity consumed by the draw path. */
  readonly batchKey: string;
  /** Zero-based record in the batch's uploaded instance buffer. */
  readonly instanceRecord: number;
  readonly authored: MaterialEffectValues;
  readonly consumed: MaterialEffectValues;
}

export interface MaterialEffectLedgerSnapshot {
  readonly entries: readonly MaterialEffectLedgerEntry[];
}

/** Reconciles author material values against the exact float records and texture identities consumed by GPU draws. */
export function compileMaterialEffectLedger(
  author: Pick<InstanceUpdate, "materials" | "instances">,
  batches: readonly PreparedBatch[],
): MaterialEffectLedgerSnapshot {
  const materials = new Map<string, PbrMaterial>();
  for (const material of author.materials) {
    if (materials.has(material.id)) throw new Error(`Material effect ledger found duplicate material identity: ${material.id}.`);
    materials.set(material.id, material);
  }
  const prepared = new Map<string, { readonly batch: PreparedBatch; readonly record: number }>();
  for (const batch of batches) {
    if (batch.data.length !== batch.instanceIds.length * 36) {
      throw new Error(`Material effect ledger found malformed batch data: ${batch.key}.`);
    }
    batch.instanceIds.forEach((instanceId, record) => {
      if (prepared.has(instanceId)) throw new Error(`Material effect ledger found duplicate instance identity: ${instanceId}.`);
      prepared.set(instanceId, { batch, record });
    });
  }
  const entries = author.instances.map(instance => {
    const material = materials.get(instance.material);
    if (!material) throw new Error(`Material effect ledger is missing author material: ${instance.material}.`);
    const located = prepared.get(instance.id);
    if (!located) throw new Error(`Material effect ledger is missing consumed instance: ${instance.id}.`);
    prepared.delete(instance.id);
    const authored = authorValues(material, instance.receiveShadow !== false,
      instance.castShadow !== false, located.batch.textures !== undefined);
    const consumed = consumedValues(located.batch, located.record);
    assertValues(instance.id, authored, consumed);
    return Object.freeze({ instanceId: instance.id, materialId: material.id,
      batchKey: located.batch.key, instanceRecord: located.record, authored, consumed });
  });
  if (prepared.size) throw new Error(`Material effect ledger found unknown consumed instance: ${prepared.keys().next().value}.`);
  entries.sort((left, right) => left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0);
  return Object.freeze({ entries: Object.freeze(entries) });
}

function authorValues(material: PbrMaterial, receiveShadow: boolean, castShadow: boolean,
  textured: boolean): MaterialEffectValues {
  const alphaMode = material.alphaMode ?? "OPAQUE";
  const emissiveFactor = material.emissiveFactor ?? [0, 0, 0];
  const emissiveStrength = material.emissiveStrength ?? 1;
  const packedEmissiveStrength = textured ? 1 : emissiveStrength;
  return values({
    baseColor: material.baseColor.map(Math.fround) as unknown as readonly [number, number, number],
    metallic: Math.fround(material.metallic), roughness: Math.fround(material.roughness),
    alphaCutoff: Math.fround(material.alphaCutoff ?? (alphaMode === "BLEND" ? 0 : 0.5)),
    surfaceFlags: (material.doubleSided === true ? 1 : 0)
      + (alphaMode === "MASK" ? 2 : alphaMode === "BLEND" ? 4 + (material.alphaCutoff !== undefined ? 2 : 0) : 0)
      + (receiveShadow ? 0 : 16) + (material.fog === false ? 32 : 0)
      + (material.shadingModel === "unlit" ? 64 : 0)
      + (alphaMode === "BLEND" && material.premultipliedAlpha === true ? 128 : 0),
    emissive: emissiveFactor.map(value => Math.fround(value * packedEmissiveStrength)) as unknown as readonly [number, number, number],
    alpha: Math.fround(material.baseColorAlpha ?? 1),
    emissiveStrength: Math.fround(textured ? emissiveStrength : 1),
    pipeline: Object.freeze({ alphaMode, doubleSided: material.doubleSided === true,
      premultipliedAlpha: alphaMode === "BLEND" && material.premultipliedAlpha === true,
      ...(material.alphaCutoff === undefined ? {} : { alphaCutoff: material.alphaCutoff }), castShadow }),
    textures: authorTextures(material),
  });
}

function consumedValues(batch: PreparedBatch, record: number): MaterialEffectValues {
  const offset = record * 36, data = batch.data;
  return values({
    baseColor: [data[offset + 24]!, data[offset + 25]!, data[offset + 26]!],
    metallic: data[offset + 27]!, roughness: data[offset + 28]!, alphaCutoff: data[offset + 29]!,
    // High bits are an internal texture-array material-row index. The ledger
    // validates the authored surface semantics stored in the low ten bits.
    surfaceFlags: data[offset + 31]! % 1024, emissive: [data[offset + 32]!, data[offset + 33]!, data[offset + 34]!],
    alpha: data[offset + 35]!, emissiveStrength: batch.textures?.emissiveStrength ?? 1,
    pipeline: Object.freeze({ alphaMode: batch.alphaMode, doubleSided: batch.doubleSided,
      premultipliedAlpha: batch.premultipliedAlpha === true,
      ...(batch.alphaCutoff === undefined ? {} : { alphaCutoff: batch.alphaCutoff }), castShadow: batch.castShadow !== false }),
    textures: consumedTextures(batch),
  });
}

function values(value: MaterialEffectValues): MaterialEffectValues {
  return Object.freeze({ ...value, baseColor: Object.freeze([...value.baseColor]) as unknown as MaterialEffectValues["baseColor"],
    emissive: Object.freeze([...value.emissive]) as unknown as MaterialEffectValues["emissive"],
    pipeline: Object.freeze({ ...value.pipeline }), textures: Object.freeze({ ...value.textures }) });
}

function authorTextures(material: PbrMaterial): MaterialEffectValues["textures"] {
  return Object.freeze({
    ...(material.baseColorTexture ? { baseColor: material.baseColorTexture.texture } : {}),
    ...(material.metallicRoughnessTexture ? { metallicRoughness: material.metallicRoughnessTexture.texture } : {}),
    ...(material.normalTexture ? { normal: material.normalTexture.texture } : {}),
    ...(material.occlusionTexture ? { occlusion: material.occlusionTexture.texture } : {}),
    ...(material.emissiveTexture ? { emissive: material.emissiveTexture.texture } : {}),
  });
}

function consumedTextures(batch: PreparedBatch): MaterialEffectValues["textures"] {
  return Object.freeze({
    ...(batch.textures?.baseColor ? { baseColor: batch.textures.baseColor.texture } : {}),
    ...(batch.textures?.metallicRoughness ? { metallicRoughness: batch.textures.metallicRoughness.texture } : {}),
    ...(batch.textures?.normal ? { normal: batch.textures.normal.texture } : {}),
    ...(batch.textures?.occlusion ? { occlusion: batch.textures.occlusion.texture } : {}),
    ...(batch.textures?.emissive ? { emissive: batch.textures.emissive.texture } : {}),
  });
}

function assertValues(instanceId: string, authored: MaterialEffectValues, consumed: MaterialEffectValues): void {
  for (const key of ["metallic", "roughness", "alphaCutoff", "surfaceFlags", "alpha", "emissiveStrength"] as const) {
    if (authored[key] !== consumed[key]) mismatch(instanceId, key);
  }
  for (const key of ["baseColor", "emissive"] as const) {
    if (!authored[key].every((value, index) => value === consumed[key][index])) mismatch(instanceId, key);
  }
  if (JSON.stringify(authored.pipeline) !== JSON.stringify(consumed.pipeline)) mismatch(instanceId, "pipeline");
  if (JSON.stringify(authored.textures) !== JSON.stringify(consumed.textures)) mismatch(instanceId, "textures");
}

function mismatch(instanceId: string, field: string): never {
  throw new Error(`Material effect ledger mismatch for ${instanceId}: ${field}.`);
}
