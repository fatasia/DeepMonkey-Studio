import { invalid, noExtensions, object, unsupported, vector, type JsonObject } from "./validation.js";

export const KHR_MATERIALS_SPECULAR = "KHR_materials_specular";

/** Read factors without baking their independent reflectance into core PBR channels. */
export function readGltfSpecular(material: JsonObject, path: string, used: ReadonlySet<string>) {
  if (material.extensions === undefined) return undefined;
  const extensions = object(material.extensions, `${path}.extensions`);
  if (extensions[KHR_MATERIALS_SPECULAR] === undefined) return undefined;
  const location = `${path}.extensions.${KHR_MATERIALS_SPECULAR}`;
  if (!used.has(KHR_MATERIALS_SPECULAR)) invalid(location, "Specular extension must be declared in extensionsUsed.");
  const source = object(extensions[KHR_MATERIALS_SPECULAR], location);
  noExtensions(source, location);
  for (const key of Object.keys(source)) {
    if (!["specularFactor", "specularColorFactor", "specularTexture", "specularColorTexture", "extras", "extensions"].includes(key)) {
      unsupported(`${location}.${key}`, "specular material property");
    }
  }
  const factor = source.specularFactor ?? 1;
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0 || factor > 1) {
    invalid(`${location}.specularFactor`, "Expected a finite value in 0..1.");
  }
  const color = source.specularColorFactor === undefined ? [1, 1, 1]
    : vector(source.specularColorFactor, 3, `${location}.specularColorFactor`);
  if (color.some(value => value < 0 || !Number.isFinite(Math.fround(value)))) {
    invalid(`${location}.specularColorFactor`, "Expected nonnegative finite float32 RGB.");
  }
  return { source, path: location, factor: Math.fround(factor),
    color: color.map(Math.fround) as [number, number, number] };
}

/** Geometry and scalar parsers retain their strict subset after this layer takes ownership. */
export function withoutSpecular(material: JsonObject, path: string): JsonObject {
  if (material.extensions === undefined) return material;
  const extensions = { ...object(material.extensions, `${path}.extensions`) };
  if (extensions[KHR_MATERIALS_SPECULAR] === undefined) return material;
  delete extensions[KHR_MATERIALS_SPECULAR];
  const result = { ...material };
  if (Object.keys(extensions).length) result.extensions = extensions;
  else delete result.extensions;
  return result;
}
