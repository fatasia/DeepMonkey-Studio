import { prepareRenderPacket, type PbrMaterial, type RenderPacket } from "../renderPacket.js";
import { array, fields, integer, record, requireValue, string, snapshotJson } from "./primitives.js";
import { assertNativePacketDeformationSupported, deformationForBrowserJson, materializePacketDeformation } from "./renderPacketDeformation.js";
export { assertNativePacketDeformationSupported } from "./renderPacketDeformation.js";

const GEOMETRY_OPTIONAL = ["uv0", "uv1", "tangents", "colors"];
const MATERIAL_OPTIONAL = ["baseColorTexture", "metallicRoughnessTexture", "normalTexture", "occlusionTexture",
  "emissiveFactor", "emissiveStrength", "emissiveTexture", "baseColorAlpha", "alphaMode", "alphaCutoff", "doubleSided",
  "premultipliedAlpha", "fog", "shadingModel"];
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
function material(input: unknown, path: string): PbrMaterial {
  const value = record(input, path);
  fields(value, ["id", "baseColor", "metallic", "roughness"], MATERIAL_OPTIONAL, path);
  id(value.id, `${path}.id`); nonnullOptions(value, MATERIAL_OPTIONAL, path);
  for (const name of ["baseColorTexture", "metallicRoughnessTexture", "normalTexture", "occlusionTexture", "emissiveTexture"]) {
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
  return { ...rest, emissiveFactor: emission.map(number => number / runtimeStrength) as [number, number, number],
    ...(runtimeStrength === 1 ? {} : { emissiveStrength: runtimeStrength }) } as unknown as PbrMaterial;
}
function texture(input: unknown, path: string): Record<string, unknown> {
  const value = record(input, path);
  fields(value, ["id", "revision", "semantic", "width", "height", "data"], ["bytesPerRow", "mipmaps", "sampler"], path);
  id(value.id, `${path}.id`); nonnullOptions(value, ["bytesPerRow", "mipmaps", "sampler"], path);
  if (value.sampler !== undefined) {
    const sampler = record(value.sampler, `${path}.sampler`);
    fields(sampler, [], SAMPLER_FIELDS, `${path}.sampler`);
    nonnullOptions(sampler, SAMPLER_FIELDS, `${path}.sampler`);
  }
  const levels = value.mipmaps === undefined ? undefined : array(value.mipmaps, `${path}.mipmaps`).map((level, index) => {
    const levelPath = `${path}.mipmaps[${index}]`, candidate = record(level, levelPath);
    fields(candidate, ["width", "height", "data"], ["bytesPerRow"], levelPath);
    nonnullOptions(candidate, ["bytesPerRow"], levelPath);
    return { ...candidate, data: new Uint8Array(numericArray(candidate.data, `${path}.mipmaps[${index}].data`, 255)) };
  });
  return { ...value, data: new Uint8Array(numericArray(value.data, `${path}.data`, 255)), ...(levels ? { mipmaps: levels } : {}) };
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
function parseRuntimeRenderPacket(input: unknown, path: string): RenderPacket {
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
    .map((item, index) => material(item, `${path}.materials[${index}]`));
  const instances = array(value.instances, `${path}.instances`, 16_384).map((input, index) => {
    const p = `${path}.instances[${index}]`, instance = record(input, p);
    fields(instance, ["id", "geometry", "material", "transform"], ["lod", "castShadow", "receiveShadow", "pose"], p);
    if (Object.hasOwn(instance, "pose")) id(instance.pose, `${p}.pose`);
    if (Object.hasOwn(instance, "lod")) lod(instance.lod, `${p}.lod`);
    id(instance.id, `${p}.id`); string(instance.geometry, p); string(instance.material, p);
    const transform = numericArray(instance.transform, `${p}.transform`);
    requireValue(transform.length === 16, p, "Expected a 16-value transform.");
    return { ...instance, transform: new Float32Array(transform) };
  });
  const textures = value.textures === undefined ? [] : array(value.textures, `${path}.textures`, 4096).map((item, index) => texture(item, `${path}.textures[${index}]`));
  const deformation = Object.hasOwn(value, "deformation") ? materializePacketDeformation(value.deformation, `${path}.deformation`, numericArray) : undefined;
  const packet = { geometries, materials, instances, textures, ...(deformation ? { deformation } : {}) } as unknown as RenderPacket;
  prepareRenderPacket(packet);
  return packet;
}

export function validateRuntimeRenderPacket(input: unknown, path: string): void {
  assertNativePacketDeformationSupported(parseRuntimeRenderPacket(input, path));
}

/** Rehydrates the validated JSON payload into the typed arrays required by Browser residency upload. */
export function materializeRuntimeRenderPacket(input: unknown, path: string): RenderPacket {
  return parseRuntimeRenderPacket(input, path);
}

/** Browser-only JSON roundtrip retains pose/source fields and the exact skin-joint array width. */
export function serializeBrowserRenderPacket(packet: RenderPacket): string {
  prepareRenderPacket(packet);
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
