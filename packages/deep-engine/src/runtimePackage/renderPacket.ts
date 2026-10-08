import { STOCK_MATERIAL_INSTANCE_OPTIONS } from "../materialInstanceAbi.js";
import { prepareRenderPacket, type PbrMaterial, type RenderPacket } from "../renderPacket.js";
import { array, fields, integer, record, requireValue, string, snapshotJson } from "./primitives.js";
import { assertNativePacketDeformationSupported, deformationForBrowserJson, materializePacketDeformation } from "./renderPacketDeformation.js";
import { browserMaterialExtensions, layeredMaterialExtension, parseExtendedMaterialParametersJson, parseAdvancedMaterialParametersJson } from "./renderPacketBrowserMaterial.js";
import { assertNativeLayeredMaterialSupported, assertNativeStockMaterialExtensionsSupported } from "./renderPacketNativeMaterial.js";
import { normalizeAdvancedMaterialParameters } from "../shader/materialAdvancedParameters.js";
import { decodeRuntimeTextureBytes, RUNTIME_TEXTURE_BYTE_LIMIT, validateRuntimeTexturePlaneBytes } from "./renderPacketTextureBytes.js";
export { assertNativePacketDeformationSupported } from "./renderPacketDeformation.js";

const GEOMETRY_OPTIONAL = ["uv0", "uv1", "tangents", "colors"];
const MATERIAL_OPTIONAL = ["baseColorTexture", "metallicRoughnessTexture", "normalTexture", "occlusionTexture",
  "emissiveFactor", "emissiveStrength", "emissiveTexture", "baseColorAlpha", "alphaMode", "alphaCutoff", "doubleSided",
  "premultipliedAlpha", "fog", "shadingModel", "ior"];
const SPECULAR_FIELDS = ["specularFactor", "specularColorFactor", "specularTexture", "specularColorTexture"];
const SLOT_FIELDS = ["texCoord", "offset", "scale", "rotation"];
const SAMPLER_FIELDS = ["addressModeU", "addressModeV", "magFilter", "minFilter", "mipmapFilter", "maxAnisotropy"];
function id(value: unknown, path: string): void {
  const text = string(value, path);
  requireValue(text.length > 0 && new TextEncoder().encode(text).length <= 256, path, "Invalid RenderPacket id.");
}
function nonnullOptions(value: Record<string, unknown>, names: readonly string[], path: string): void {
  for (const name of names) if (Object.hasOwn(value, name)) requireValue(value[name] !== null, `${path}.${name}`, "Null optional field.");
}
function numericArray(input: unknown, path: string, maxInteger?: number): number[] {
  // 兼容历史 JSON.stringify(TypedArray) 的稠密数字键，但不接受稀疏或伪装字段。
  const values = Array.isArray(input) ? input : (() => {
    const object = record(input, path), keys = Object.keys(object);
    return keys.map((_, index) => {
      requireValue(Object.hasOwn(object, index.toString()), path, "Sparse typed-array encoding.");
      return object[index.toString()];
    });
  })();
  for (const value of values) requireValue(typeof value === "number" && Number.isFinite(value)
    && (maxInteger === undefined ? Number.isFinite(Math.fround(value)) : Number.isInteger(value) && value >= 0 && value <= maxInteger),
  path, "Invalid array element.");
  return values as number[];
}
function material(input: unknown, path: string, browserProfile: boolean): PbrMaterial {
  const value = record(input, path);
  // I-C23:layered 是双端字段(Web 消费 + Native 生产消费),两个 profile 都
  // 走同一 fail-closed 校验。C9/native:stock extendedParameters 与 advanced
  // (保守子集 sheen)接通 native 求值,两个 profile 走同一闭合域 JSON 解析;
  // 子集差异由 assertNativeStockMaterialExtensionsSupported 承担(未消费的
  // anisotropy/iridescence/volume 非零值 fail-closed;stock transmission is consumed).
  const optional = [...MATERIAL_OPTIONAL, ...SPECULAR_FIELDS, "extendedParameters", "layered", "advancedParameters"];
  fields(value, ["id", "baseColor", "metallic", "roughness"], optional, path);
  const extensions = browserProfile ? browserMaterialExtensions(value, path)
    : (() => {
      const extendedParameters = Object.hasOwn(value, "extendedParameters")
        ? parseExtendedMaterialParametersJson(value.extendedParameters, `${path}.extendedParameters`) : undefined;
      const advancedParameters = Object.hasOwn(value, "advancedParameters")
        ? normalizeAdvancedMaterialParameters(parseAdvancedMaterialParametersJson(value.advancedParameters, `${path}.advancedParameters`)) : undefined;
      assertNativeStockMaterialExtensionsSupported(extendedParameters, advancedParameters, path);
      return {
        ...(extendedParameters ? { extendedParameters } : {}),
        ...(Object.hasOwn(value, "layered") ? { layered: layeredMaterialExtension(value, path) } : {}),
        ...(advancedParameters ? { advancedParameters } : {}),
      };
    })();
  if (!browserProfile) assertNativeLayeredMaterialSupported(extensions.layered, `${path}.layered`);
  id(value.id, `${path}.id`); nonnullOptions(value, optional, path);
  for (const name of ["baseColorTexture", "metallicRoughnessTexture", "normalTexture", "occlusionTexture", "emissiveTexture", "specularTexture", "specularColorTexture"]) {
    if (!Object.hasOwn(value, name)) continue;
    const slot = record(value[name], `${path}.${name}`);
    fields(slot, ["texture"], [...SLOT_FIELDS, ...(name === "normalTexture" ? ["normalScale"] : name === "occlusionTexture" ? ["strength"] : [])], `${path}.${name}`);
    nonnullOptions(slot, Object.keys(slot), `${path}.${name}`);
  }
  const factor = value.emissiveFactor === undefined ? [0, 0, 0] : numericArray(value.emissiveFactor, `${path}.emissiveFactor`);
  requireValue(factor.length === 3 && factor.every(number => number >= 0), path, "Invalid emissiveFactor.");
  const strength = value.emissiveStrength === undefined ? 1 : value.emissiveStrength;
  requireValue(typeof strength === "number" && strength >= 0 && strength <= 256, path, "Invalid emissiveStrength.");
  const emission = factor.map(number => number * strength);
  requireValue(emission.every(number => Number.isFinite(Math.fround(number)) && number <= 256), path,
    "Emissive output exceeds the runtime HDR limit.");
  // Runtime Package v1 may store factor*strength in emissiveFactor. Re-split it
  // for the author RenderPacket ABI without changing the final linear emission.
  const runtimeStrength = Math.max(1, ...emission);
  const { emissiveFactor: _factor, emissiveStrength: _strength, ...rest } = value;
  return { ...rest, ...extensions,
    ...(value.specularColorFactor === undefined ? {} : { specularColorFactor: [...numericArray(value.specularColorFactor, `${path}.specularColorFactor`)] }),
    emissiveFactor: emission.map(number => number / runtimeStrength) as [number, number, number],
    ...(runtimeStrength === 1 ? {} : { emissiveStrength: runtimeStrength }) } as unknown as PbrMaterial;
}
function texture(input: unknown, path: string, browserProfile: boolean): Record<string, unknown> {
  const value = record(input, path);
  fields(value, ["id", "revision", "semantic", "width", "height", "data"], ["bytesPerRow", "mipmaps", "sampler", "generateMipmaps"], path);
  if (value.generateMipmaps !== undefined) requireValue(typeof value.generateMipmaps === "boolean", `${path}.generateMipmaps`, "Expected boolean.");
  id(value.id, `${path}.id`); nonnullOptions(value, ["bytesPerRow", "mipmaps", "sampler"], path);
  if (!browserProfile) requireValue(["baseColor", "metallicRoughness", "normal", "occlusion", "emissive", "specular", "specularColor"].includes(value.semantic as string),
    `${path}.semantic`, "Native RenderPacket texture semantic is unsupported.");
  if (value.sampler !== undefined) {
    const sampler = record(value.sampler, `${path}.sampler`);
    fields(sampler, [], SAMPLER_FIELDS, `${path}.sampler`);
    nonnullOptions(sampler, SAMPLER_FIELDS, `${path}.sampler`);
  }
  const levels = value.mipmaps === undefined ? undefined : array(value.mipmaps, `${path}.mipmaps`).map((level, index) => {
    const levelPath = `${path}.mipmaps[${index}]`, candidate = record(level, levelPath);
    fields(candidate, ["width", "height", "data"], ["bytesPerRow"], levelPath);
    nonnullOptions(candidate, ["bytesPerRow"], levelPath);
    return { ...candidate, data: typeof candidate.data === "string" ? decodeRuntimeTextureBytes(candidate.data)
      : new Uint8Array(numericArray(candidate.data, `${path}.mipmaps[${index}].data`, 255)) };
  });
  return { ...value, data: typeof value.data === "string" ? decodeRuntimeTextureBytes(value.data)
    : new Uint8Array(numericArray(value.data, `${path}.data`, 255)), ...(levels ? { mipmaps: levels } : {}) };
}
function lod(input: unknown, path: string): void {
  const profile = record(input, path);
  const authored = profile.strategy === "author-selected";
  if (authored) {
    fields(profile, ["strategy", "revision", "levels", "selectedLevels"], [], path);
    integer(profile.revision, 0, Number.MAX_SAFE_INTEGER, `${path}.revision`);
    for (const value of array(profile.selectedLevels, `${path}.selectedLevels`, 8))
      integer(value, 0, 7, `${path}.selectedLevels`);
  } else {
    fields(profile, ["levels"], ["strategy", "hysteresisRatio"], path);
    nonnullOptions(profile, ["strategy", "hysteresisRatio"], path);
    requireValue(profile.strategy === undefined || profile.strategy === "screen-space", path, "Unsupported LOD strategy.");
  }
  for (const [index, input] of array(profile.levels, `${path}.levels`, 8).entries()) {
    const p = `${path}.levels[${index}]`, level = record(input, p);
    if (authored) fields(level, ["geometry", "distance", "hysteresis"], [], p);
    else {
      fields(level, ["geometry", "minProjectedDiameterPixels", "geometricError"], ["resident"], p);
      nonnullOptions(level, ["resident"], p);
    }
  }
  // prepareRenderPacket below owns level ordering, residency, geometry/material compatibility and numeric limits.
}
function parseRuntimeRenderPacket(input: unknown, path: string, browserProfile = false): RenderPacket {
  const value = record(input, path);
  fields(value, ["geometries", "materials", "instances"], ["schema", "version", "textures", "deformation"], path);
  requireValue(value.schema === undefined || value.schema === "deep-engine.render-packet", path, "Unsupported RenderPacket schema.");
  requireValue(value.version === undefined || value.version === 1, path, "Unsupported RenderPacket version.");
  const geometries = array(value.geometries, `${path}.geometries`, 4096).map((input, index) => {
    const p = `${path}.geometries[${index}]`, geometry = record(input, p);
    fields(geometry, ["id", "revision", "vertices", "indices"], GEOMETRY_OPTIONAL, p);
    id(geometry.id, `${p}.id`); integer(geometry.revision, 0, Number.MAX_SAFE_INTEGER, `${p}.revision`);
    const result = { ...geometry, vertices: new Float32Array(numericArray(geometry.vertices, `${p}.vertices`)),
      indices: new Uint32Array(numericArray(geometry.indices, `${p}.indices`, 0xffff_ffff)) };
    for (const key of GEOMETRY_OPTIONAL) if (Object.hasOwn(geometry, key)) {
      (result as Record<string, unknown>)[key] = new Float32Array(numericArray(geometry[key], `${p}.${key}`));
    }
    return result;
  });
  const materials = array(value.materials, `${path}.materials`, 16_384)
    .map((item, index) => material(item, `${path}.materials[${index}]`, browserProfile));
  const instances = array(value.instances, `${path}.instances`, 16_384).map((input, index) => {
    const p = `${path}.instances[${index}]`, instance = record(input, p);
    fields(instance, ["id", "geometry", "material", "transform"], ["lod", "castShadow", "receiveShadow", "outline", "pose"], p);
    if (Object.hasOwn(instance, "pose")) id(instance.pose, `${p}.pose`);
    if (Object.hasOwn(instance, "lod")) lod(instance.lod, `${p}.lod`);
    id(instance.id, `${p}.id`); string(instance.geometry, p); string(instance.material, p);
    const transform = numericArray(instance.transform, `${p}.transform`);
    requireValue(transform.length === 16, p, "Expected a 16-value transform.");
    return { ...instance, transform: new Float32Array(transform) };
  });
  const textureValues = value.textures === undefined ? [] : array(value.textures, `${path}.textures`, 4096);
  let textureBytes = 0;
  for (const [index, item] of textureValues.entries()) {
    const p = `${path}.textures[${index}]`, candidate = record(item, p);
    textureBytes += validateRuntimeTexturePlaneBytes(candidate, p);
    for (const [level, data] of (candidate.mipmaps === undefined ? [] : array(candidate.mipmaps, `${p}.mipmaps`, 15)).entries())
      textureBytes += validateRuntimeTexturePlaneBytes(record(data, `${p}.mipmaps[${level}]`), `${p}.mipmaps[${level}]`);
    requireValue(textureBytes <= RUNTIME_TEXTURE_BYTE_LIMIT, p, "Texture data exceeds the 128 MiB packet budget.");
  }
  const textures = textureValues.map((item, index) => texture(item, `${path}.textures[${index}]`, browserProfile));
  const deformation = Object.hasOwn(value, "deformation") ? materializePacketDeformation(value.deformation, `${path}.deformation`, numericArray) : undefined;
  const packet = { geometries, materials, instances, textures, ...(deformation ? { deformation } : {}) } as unknown as RenderPacket;
  prepareRenderPacket(packet, STOCK_MATERIAL_INSTANCE_OPTIONS);
  return packet;
}

export function validateRuntimeRenderPacket(input: unknown, path: string): void {
  assertNativePacketDeformationSupported(parseRuntimeRenderPacket(input, path));
}

/** Check fields changed by normalization before discarding their source representation. */
export function validateRuntimeRenderPacketSource(input: unknown, path: string): void {
  const value = record(input, path);
  requireValue(value.schema === undefined || value.schema === "deep-engine.render-packet", path, "Unsupported RenderPacket schema.");
  requireValue(value.version === undefined || value.version === 1, path, "Unsupported RenderPacket version.");
  array(value.materials, `${path}.materials`, 16_384).forEach((item, index) => material(item, `${path}.materials[${index}]`, false));
}

/** Rehydrates the validated JSON payload into the typed arrays required by Browser residency upload. */
export function materializeRuntimeRenderPacket(input: unknown, path: string): RenderPacket {
  return parseRuntimeRenderPacket(input, path, true);
}

/** Browser-only JSON roundtrip retains pose/source fields and the exact skin-joint array width. */
export function serializeBrowserRenderPacket(packet: RenderPacket): string {
  prepareRenderPacket(packet, STOCK_MATERIAL_INSTANCE_OPTIONS);
  return JSON.stringify(snapshotJson({ ...packet, schema: "deep-engine.render-packet", version: 1,
    ...(packet.deformation ? { deformation: deformationForBrowserJson(packet.deformation) } : {}) }, true));
}

/** 只折叠已有语义；不丢弃 LOD、压缩纹理或未来字段来伪造可执行包。 */
export function normalizeRuntimeRenderPacket(value: Record<string, unknown>): void {
  assertNativePacketDeformationSupported(value);
  value.schema = "deep-engine.render-packet";
  value.version = 1;
  for (const candidate of value.materials as Record<string, unknown>[]) {
    if (candidate.emissiveStrength === undefined) continue;
    const factor = (candidate.emissiveFactor ?? [0, 0, 0]) as number[];
    candidate.emissiveFactor = factor.map(channel => channel * (candidate.emissiveStrength as number));
    delete candidate.emissiveStrength;
  }
}
