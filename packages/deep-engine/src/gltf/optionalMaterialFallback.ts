import { invalid, list, object, unsupported, type JsonObject } from "./validation.js";

const supportedFallbacks = new Set(["KHR_materials_clearcoat", "KHR_materials_unlit"]);

export type GltfOptionalMaterialFallback = "KHR_materials_clearcoat" | "KHR_materials_unlit";

/**
 * Projects explicitly selected optional material extensions to their core glTF fallback.
 * Required extensions remain fail-closed and the caller-owned document is never mutated.
 */
export function projectOptionalMaterialFallbacks(
  json: unknown,
  requested: readonly GltfOptionalMaterialFallback[] | undefined,
): unknown {
  if (requested === undefined) return json;
  const names = list(requested, "options.optionalMaterialFallbacks", supportedFallbacks.size).map((value, index) => {
    if (typeof value !== "string" || !value) {
      invalid(`options.optionalMaterialFallbacks[${index}]`, "Extension names must be nonempty strings.");
    }
    if (!supportedFallbacks.has(value)) {
      unsupported(`options.optionalMaterialFallbacks[${index}]`, `material fallback ${value}`);
    }
    return value;
  });
  if (new Set(names).size !== names.length) {
    invalid("options.optionalMaterialFallbacks", "Duplicate extension names are invalid.");
  }
  if (!names.length) return json;

  const document = object(json, "$"), used = list(document.extensionsUsed, "extensionsUsed");
  const required = new Set(list(document.extensionsRequired, "extensionsRequired"));
  for (const name of names) {
    if (!used.includes(name)) invalid("options.optionalMaterialFallbacks", `${name} is not declared in extensionsUsed.`);
    if (required.has(name)) unsupported("extensionsRequired", `required material fallback ${name}`);
  }

  const result: JsonObject = { ...document, extensionsUsed: used.filter(name => !names.includes(name as string)) };
  if (document.materials !== undefined) {
    result.materials = list(document.materials, "materials", 16_383).map((value, index) => {
      const material: JsonObject = { ...object(value, `materials[${index}]`) };
      if (material.extensions === undefined) return material;
      const extensions: JsonObject = { ...object(material.extensions, `materials[${index}].extensions`) };
      for (const name of names) delete extensions[name];
      if (Object.keys(extensions).length) material.extensions = extensions;
      else delete material.extensions;
      return material;
    });
  }
  return result;
}
