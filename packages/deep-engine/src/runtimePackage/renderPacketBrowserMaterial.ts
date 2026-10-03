import type { PbrMaterial } from "../renderPacketTypes.js";
import { normalizeExtendedMaterialParameters, type MaterialParameterOverrides, type ExtendedMaterialParameters } from "../shader/materialParameters.js";
import { normalizeLayeredSurfaceParameters, type LayeredSurfaceOverrides } from "../shader/materialLayeredSurface.js";
import { array, fields, record, requireValue } from "./primitives.js";

function optionalFields(value: Record<string, unknown>, names: readonly string[], path: string): void {
  fields(value, [], names, path);
  for (const name of Object.keys(value)) requireValue(value[name] !== null && value[name] !== undefined,
    `${path}.${name}`, "Null or undefined optional field.");
}
function scalarFields(value: Record<string, unknown>, names: readonly string[], path: string): void {
  optionalFields(value, names, path);
  for (const name of Object.keys(value)) requireValue(typeof value[name] === "number" && Number.isFinite(value[name]),
    `${path}.${name}`, "Expected a finite material number.");
}
function parameters(input: unknown, path: string): ExtendedMaterialParameters {
  const value = record(input, path);
  optionalFields(value, ["ior", "clearcoat", "anisotropy", "transmission"], path);
  if (Object.hasOwn(value, "ior")) requireValue(typeof value.ior === "number" && Number.isFinite(value.ior), `${path}.ior`, "Expected finite IOR.");
  for (const [name, keys] of [["clearcoat", ["factor", "roughness"]], ["anisotropy", ["strength", "rotation"]],
    ["transmission", ["factor"]]] as const) {
    if (Object.hasOwn(value, name)) scalarFields(record(value[name], `${path}.${name}`), keys, `${path}.${name}`);
  }
  return normalizeExtendedMaterialParameters(value as MaterialParameterOverrides);
}
function surface(input: unknown, path: string): void {
  const value = record(input, path);
  optionalFields(value, ["baseColor", "metallic", "roughness", "baseColorTexture", "metallicRoughnessTexture"], path);
  for (const name of ["metallic", "roughness"]) if (Object.hasOwn(value, name)) {
    requireValue(typeof value[name] === "number", `${path}.${name}`, "Expected a material number.");
  }
  if (Object.hasOwn(value, "baseColor")) {
    const color = array(value.baseColor, `${path}.baseColor`, 3);
    requireValue(color.length === 3 && color.every(channel => typeof channel === "number"), `${path}.baseColor`, "Expected three color numbers.");
  }
  for (const name of ["baseColorTexture", "metallicRoughnessTexture"]) if (Object.hasOwn(value, name)) {
    const p = `${path}.${name}`, slot = record(value[name], p);
    fields(slot, ["texture"], ["texCoord", "offset", "scale", "rotation"], p);
    for (const key of Object.keys(slot)) requireValue(slot[key] !== null && slot[key] !== undefined, `${p}.${key}`, "Null or undefined texture field.");
    for (const key of ["offset", "scale"]) if (Object.hasOwn(slot, key)) {
      const values = array(slot[key], `${p}.${key}`, 2);
      requireValue(values.length === 2 && values.every(number => typeof number === "number" && Number.isFinite(number)), `${p}.${key}`, "Expected two finite UV numbers.");
    }
    if (Object.hasOwn(slot, "rotation")) requireValue(typeof slot.rotation === "number", `${p}.rotation`, "Expected a UV rotation number.");
  }
}
/** Browser-only fields; Native runtime validation retains its existing closed material profile. */
export function browserMaterialExtensions(value: Record<string, unknown>, path: string): Pick<PbrMaterial, "extendedParameters" | "layered"> {
  const extendedParameters = Object.hasOwn(value, "extendedParameters") ? parameters(value.extendedParameters, `${path}.extendedParameters`) : undefined;
  const layered = layeredMaterialExtension(value, path);
  return { ...(extendedParameters ? { extendedParameters } : {}), ...(layered ? { layered } : {}) };
}

/** I-C23:分层材质扩展的独立校验/规范化。Native 生产消费接通后,native
 * profile 放行 layered(与本扩展同一校验路径),但 extendedParameters 仍是
 * Browser-only(native stock 光照核不评扩展 lobe,与 native 基材同界)。 */
export function layeredMaterialExtension(value: Record<string, unknown>, path: string): LayeredSurfaceOverrides | undefined {
  if (!Object.hasOwn(value, "layered")) return undefined;
  const p = `${path}.layered`, input = record(value.layered, p);
  optionalFields(input, ["base", "layers"], p);
  const base = Object.hasOwn(input, "base") ? parameters(input.base, `${p}.base`) : undefined;
  const layers = Object.hasOwn(input, "layers") ? array(input.layers, `${p}.layers`, 2).map((raw, index) => {
    const lp = `${p}.layers[${index}]`, layer = record(raw, lp);
    optionalFields(layer, ["params", "coverage", "mode", "surface", "responseModel"], lp);
    if (Object.hasOwn(layer, "params")) parameters(layer.params, `${lp}.params`);
    if (Object.hasOwn(layer, "surface")) surface(layer.surface, `${lp}.surface`);
    return layer;
  }) : [];
  const normalized = normalizeLayeredSurfaceParameters({ ...(base ? { base } : {}), layers } as LayeredSurfaceOverrides);
  return Object.freeze({ ...(base ? { base: normalized.base } : {}), layers: Object.freeze(normalized.layers.map((layer, index) => Object.freeze({
    ...layer, ...(normalized.surfaces[index] ? { surface: normalized.surfaces[index] } : {}),
  }))) });
}
