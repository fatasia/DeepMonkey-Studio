import type { RenderPacket } from "../renderPacket.js";
import { mainPipelineKey, materialMode, rasterMode } from "../webgpu/pipelines.js";

/**
 * 从独立作者包推导首帧可能绘制的 main 管线键（保守超集）。
 *
 * 语义对齐 renderPacketBatches/renderPacketMaterials 的批次准备：
 * - `textured`：任一纹理槽存在（baseColor/metallicRoughness/normal/occlusion/emissive）；
 * - `normalMapped`：normal 纹理存在；
 * - `alphaMode` 缺省 OPAQUE；`doubleSided` 缺省 false；
 * - `mirrored`：实例变换左上 3×3 行列式为负（列主序 16 元素）。
 *
 * 阴影/显示/输出管线始终在关键作用域内，这里只返回 main 键；
 * plain/ccw 由 createPipelinesBuild 恒定并入。推导只可能多选、不会漏选，
 * 多选的代价只是关键集稍大，漏选才会让首帧绘制抛错。
 */
export function firstFramePipelineMainKeys(packet: RenderPacket): readonly string[] {
  const materials = new Map(packet.materials.map(material => [material.id, material]));
  const keys = new Set<string>();
  for (const instance of packet.instances) {
    const material = materials.get(instance.material);
    if (!material) continue;
    const textured = material.baseColorTexture !== undefined
      || material.metallicRoughnessTexture !== undefined
      || material.normalTexture !== undefined
      || material.occlusionTexture !== undefined
      || material.emissiveTexture !== undefined;
    keys.add(mainPipelineKey(
      materialMode(textured, material.normalTexture !== undefined),
      (material.alphaMode ?? "OPAQUE") === "BLEND",
      rasterMode(isMirroredTransform(instance.transform), material.doubleSided === true),
    ));
  }
  return [...keys];
}

function isMirroredTransform(transform: ArrayLike<number>): boolean {
  if (transform.length < 11) return false;
  const a = transform[0]!, b = transform[1]!, c = transform[2]!;
  const d = transform[4]!, e = transform[5]!, f = transform[6]!;
  const g = transform[8]!, h = transform[9]!, i = transform[10]!;
  // 列主序 4×4 的左上 3×3 行列式。
  return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e) < 0;
}
