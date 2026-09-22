import type { PbrMaterial, RenderInstance, RenderPacket } from "../renderPacket.js";
import { AccessorReader } from "./accessors.js";
import { materialResource, meshResources } from "./meshResources.js";
import { KHR_MATERIALS_IOR, KHR_MATERIALS_EMISSIVE_STRENGTH, validateExtensionSets } from "./materialExtensions.js";
import { sceneMeshNodes } from "./nodeTransforms.js";
import { budget, invalid, list, noExtensions, object, unsupported, validateJson } from "./validation.js";

export interface GltfImportOptions {
  /** 不同资产并入同一投影时使用不同前缀，避免资源 ID 冲突。 */
  readonly resourcePrefix?: string;
  /** 默认使用 glTF 的 scene；未指定默认场景时使用第一个场景。 */
  readonly sceneIndex?: number;
  /** Cancels CPU-side validation and expansion before a packet is published. */
  readonly signal?: AbortSignal;
}

/** 静态、不透明、无纹理的 glTF 2.0 子集。失败不返回部分网格，也不触发任何 IO。 */
export function decodeGltf(json: unknown, buffers: readonly Uint8Array[], options: GltfImportOptions = {}): RenderPacket {
  options?.signal?.throwIfAborted();
  validateJson(json);
  object(options, "options");
  const document = object(json, "$"), asset = object(document.asset, "asset");
  noExtensions(document, "$");
  noExtensions(asset, "asset");
  if (asset.version !== "2.0") unsupported("asset.version", "glTF versions other than 2.0");
  if (asset.minVersion !== undefined && asset.minVersion !== "2.0") unsupported("asset.minVersion", "newer minimum glTF versions");
  const extensions = validateExtensionSets(document, new Set([KHR_MATERIALS_EMISSIVE_STRENGTH, KHR_MATERIALS_IOR]));
  for (const field of ["animations", "skins", "textures", "images", "cameras"]) {
    if (list(document[field], field).length) unsupported(field, field);
  }
  const prefix = options.resourcePrefix === undefined ? "gltf" : options.resourcePrefix;
  if (typeof prefix !== "string" || !prefix.length || prefix.length > 256) invalid("options.resourcePrefix", "Expected a nonempty prefix of at most 256 characters.");
  const reader = new AccessorReader(document, buffers, options.signal);
  const materials = list(document.materials, "materials", 16_383)
    .map((value, index) => materialResource(value, index, prefix, extensions.used));
  const sourceMeshes = list(document.meshes, "meshes", 4096);
  const { geometries, meshes } = meshResources(sourceMeshes, materials, reader, prefix);
  const nodes = sceneMeshNodes(document, sourceMeshes, options.sceneIndex), instances: RenderInstance[] = [];
  for (const node of nodes) {
    meshes[node.mesh]!.forEach((primitive, index) => {
      budget(instances.length + 1, 16_384, "instances");
      instances.push({ id: `${prefix}/node/${node.index}/primitive/${index}`, ...primitive, transform: node.transform });
    });
  }
  const defaults: PbrMaterial = { id: `${prefix}/material/default`, baseColor: [1, 1, 1], metallic: 1, roughness: 1 };
  const needsDefault = meshes.some(primitives => primitives.some(primitive => primitive.material === defaults.id));
  return { geometries, materials: needsDefault ? [...materials, defaults] : materials, instances };
}
