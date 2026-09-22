import { MAX_EMISSIVE_STRENGTH } from "../renderPacket.js";
import { invalid, list, noExtensions, object, unsupported, type JsonObject } from "./validation.js";

export const KHR_MATERIALS_EMISSIVE_STRENGTH = "KHR_materials_emissive_strength";
export const KHR_MATERIALS_IOR = "KHR_materials_ior";

export function readMaterialIor(material: JsonObject, path: string, used: ReadonlySet<string>): number | undefined {
  if (material.extensions === undefined) return undefined;
  const extensions = object(material.extensions, `${path}.extensions`);
  if (extensions[KHR_MATERIALS_IOR] === undefined) return undefined;
  const extensionPath = `${path}.extensions.${KHR_MATERIALS_IOR}`;
  if (!used.has(KHR_MATERIALS_IOR)) invalid(extensionPath, "KHR_materials_ior must be declared in extensionsUsed.");
  const extension = object(extensions[KHR_MATERIALS_IOR], extensionPath);
  for (const name of Object.keys(extension)) {
    if (!["ior", "extensions", "extras"].includes(name)) unsupported(`${extensionPath}.${name}`, `property ${name}`);
  }
  noExtensions(extension, extensionPath);
  const ior = extension.ior === undefined ? 1.5 : extension.ior;
  if (typeof ior !== "number" || !Number.isFinite(ior) || !Number.isFinite(Math.fround(ior)) || ior < 1) {
    invalid(`${extensionPath}.ior`, "Expected a finite float32 IOR at least 1.");
  }
  return ior;
}

export interface GltfExtensionSets {
  readonly used: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
}

export function validateExtensionSets(document: JsonObject, supported: ReadonlySet<string>): GltfExtensionSets {
  const used = list(document.extensionsUsed, "extensionsUsed").map((value, index) => {
    if (typeof value !== "string" || !value) invalid(`extensionsUsed[${index}]`, "Extension names must be nonempty strings.");
    if (!supported.has(value)) unsupported(`extensionsUsed[${index}]`, `extension ${value}`);
    return value;
  });
  if (new Set(used).size !== used.length) invalid("extensionsUsed", "Duplicate extension names are invalid.");
  const required = list(document.extensionsRequired, "extensionsRequired").map((value, index) => {
    if (typeof value !== "string" || !value) invalid(`extensionsRequired[${index}]`, "Extension names must be nonempty strings.");
    if (!supported.has(value)) unsupported(`extensionsRequired[${index}]`, `extension ${value}`);
    if (!used.includes(value)) invalid(`extensionsRequired[${index}]`, "Required extension must also appear in extensionsUsed.");
    return value;
  });
  if (new Set(required).size !== required.length) invalid("extensionsRequired", "Duplicate extension names are invalid.");
  return Object.freeze({ used: new Set(used), required: new Set(required) });
}

/** Reads the Khronos extension without accepting undeclared or unrelated material extensions. */
export function readEmissiveStrength(material: JsonObject, path: string, used: ReadonlySet<string>): number | undefined {
  readMaterialIor(material, path, used);
  if (material.extensions === undefined) return undefined;
  const extensions = object(material.extensions, `${path}.extensions`);
  for (const name of Object.keys(extensions)) {
    if (name !== KHR_MATERIALS_EMISSIVE_STRENGTH && name !== KHR_MATERIALS_IOR) unsupported(`${path}.extensions.${name}`, `extension ${name}`);
  }
  if (extensions[KHR_MATERIALS_EMISSIVE_STRENGTH] === undefined) return undefined;
  if (!used.has(KHR_MATERIALS_EMISSIVE_STRENGTH)) {
    invalid(`${path}.extensions.${KHR_MATERIALS_EMISSIVE_STRENGTH}`, `${KHR_MATERIALS_EMISSIVE_STRENGTH} must be declared in extensionsUsed.`);
  }
  const extensionPath = `${path}.extensions.${KHR_MATERIALS_EMISSIVE_STRENGTH}`;
  const extension = object(extensions[KHR_MATERIALS_EMISSIVE_STRENGTH], extensionPath);
  for (const name of Object.keys(extension)) {
    if (name !== "emissiveStrength" && name !== "extensions" && name !== "extras") {
      unsupported(`${extensionPath}.${name}`, `property ${name}`);
    }
  }
  noExtensions(extension, extensionPath);
  const strength = extension.emissiveStrength === undefined ? 1 : extension.emissiveStrength;
  if (typeof strength !== "number" || !Number.isFinite(strength) || strength < 0 || !Number.isFinite(Math.fround(strength))) {
    invalid(`${extensionPath}.emissiveStrength`, "Expected a nonnegative finite float32 value.");
  }
  if (strength > MAX_EMISSIVE_STRENGTH) {
    unsupported(`${extensionPath}.emissiveStrength`, `emissive strength above engine HDR limit ${MAX_EMISSIVE_STRENGTH}`);
  }
  return strength;
}
