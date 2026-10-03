import type { CapabilityFailure } from "./capabilityInventory.js";
import { DOCUMENT_SUPPORTED_EXTENSIONS, KHR_MATERIALS_EMISSIVE_STRENGTH, PROJECTABLE_FALLBACK_EXTENSIONS } from "./materialExtensions.js";
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

export interface ThirdPartyMaterialProfile {
  readonly document: JsonObject;
  readonly losses: readonly CapabilityFailure[];
}

/**
 * N5 零配置第三方材质 profile：非必需的已知 fallback 与未知材质扩展投影为核心 glTF 回退并逐条登记 loss，
 * 不再整文件拒绝（glTF 规范允许忽略非必需扩展，损失合同要求"不静默丢弃"）。
 * required 扩展原样保留，由严格 manifest 层精确 fail-closed；caller-owned 文档不被修改。
 */
export function projectThirdPartyMaterialProfile(json: unknown): ThirdPartyMaterialProfile {
  const document = object(json, "$");
  const used = list(document.extensionsUsed, "extensionsUsed");
  const required = new Set(list(document.extensionsRequired, "extensionsRequired"));
  const losses: CapabilityFailure[] = [];
  const retainedUsed = used.filter(name => required.has(name as string) || DOCUMENT_SUPPORTED_EXTENSIONS.has(name as string));
  const result: JsonObject = { ...document, extensionsUsed: retainedUsed };
  if (!retainedUsed.length) delete result.extensionsUsed;
  if (document.materials !== undefined) {
    result.materials = list(document.materials, "materials", 16_383).map((value, index) => {
      const material: JsonObject = { ...object(value, `materials[${index}]`) };
      if (material.extensions === undefined) return material;
      const extensions = object(material.extensions, `materials[${index}].extensions`);
      const kept: JsonObject = {};
      for (const name of Object.keys(extensions)) {
        const projected = !required.has(name) && name !== KHR_MATERIALS_EMISSIVE_STRENGTH
          && !DOCUMENT_SUPPORTED_EXTENSIONS.has(name);
        if (!projected) {
          kept[name] = extensions[name]!;
          continue;
        }
        const known = PROJECTABLE_FALLBACK_EXTENSIONS.has(name);
        losses.push({
          code: known ? "extension-fallback" : "extension-unknown", stage: "extension",
          assetPath: `materials[${index}].extensions.${name}`, count: 1,
          detail: known
            ? `${name} 不受引擎标量渲染 profile 支持；零配置回退核心 glTF/PBR 渲染（unlit 的平面着色语义回退为 lit PBR），语义已如实登记。`
            : `${name} 不在引擎已知清单；零配置按未知扩展回退核心 PBR 并显式登记，不静默丢弃。`,
        });
      }
      if (Object.keys(kept).length) material.extensions = kept;
      else delete material.extensions;
      return material;
    });
  }
  return { document: result, losses };
}
