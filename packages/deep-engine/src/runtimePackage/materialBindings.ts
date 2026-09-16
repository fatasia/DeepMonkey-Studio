import type { DeepShaderPackageV2 } from "../shaderPackage/types.js";
import { compareRuntimeStrings } from "./hash.js";
import { array, fields, record, requireValue, resourceId, snapshotJson, string } from "./primitives.js";
import type { RuntimeMaterialShaderBinding } from "./types.js";

function readBindings(input: unknown, allowEmpty = false): RuntimeMaterialShaderBinding[] {
  const entries = array(input, "$.materialBindings", 16_384);
  requireValue(allowEmpty || entries.length > 0, "$.materialBindings", "Runtime package v2 requires material bindings.");
  return entries.map((candidate, index) => {
    const path = `$.materialBindings[${index}]`, entry = record(candidate, path);
    fields(entry, ["materialId", "packageId", "techniqueId"], [], path);
    const materialId = string(entry.materialId, `${path}.materialId`);
    const techniqueId = string(entry.techniqueId, `${path}.techniqueId`);
    requireValue(materialId.length > 0 && new TextEncoder().encode(materialId).length <= 256, path, "Invalid material identity.");
    requireValue(techniqueId.length > 0 && new TextEncoder().encode(techniqueId).length <= 128, path, "Invalid technique identity.");
    return { materialId, packageId: resourceId(entry.packageId, `${path}.packageId`), techniqueId };
  });
}

/** Owns author input and orders Unicode material ids identically to the native UTF-8 comparator. */
export function normalizeRuntimeMaterialBindings(input: unknown, allowEmpty = false): readonly RuntimeMaterialShaderBinding[] {
  return readBindings(snapshotJson(input), allowEmpty).sort((a, b) => compareRuntimeStrings(a.materialId, b.materialId));
}

export function validateRuntimeMaterialBindings(input: unknown, materials: readonly { readonly id: string }[],
  shaders: ReadonlyMap<string, DeepShaderPackageV2>, allowEmpty = false): void {
  const bindings = readBindings(input, allowEmpty), materialIds = new Set(materials.map(material => material.id)), used = new Set<string>();
  let previous: string | undefined;
  for (const [index, binding] of bindings.entries()) {
    const path = `$.materialBindings[${index}]`;
    requireValue(previous === undefined || compareRuntimeStrings(previous, binding.materialId) < 0,
      path, "Material bindings must be sorted by unique material id.");
    previous = binding.materialId;
    requireValue(materialIds.has(binding.materialId), path, "Material binding refers to an absent material.");
    const shader = shaders.get(binding.packageId);
    requireValue(shader, path, "Material binding refers to an absent shader package.");
    requireValue(String(shader.shaderAbi.id) === "deep.pbr.mesh.v2", path, "Executable materials require the CSM shader ABI deep.pbr.mesh.v2.");
    requireValue(shader.passes.some(pass => pass.techniqueId === binding.techniqueId && pass.kind === "forward"),
      path, "Material binding technique has no forward pass.");
    used.add(binding.packageId);
  }
  requireValue(used.size === shaders.size, "$.materialBindings", "Every shader entrypoint must be bound to a material.");
}
