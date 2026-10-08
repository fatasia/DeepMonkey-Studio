import { hasAdvancedMaterialFeatures, normalizeAdvancedMaterialParameters } from "../shader/materialAdvancedParameters.js";
import type { RenderPacket } from "../renderPacket.js";
import type { RenderView } from "../webgpu/pbrRenderer.js";
import type { PbrRendererOptions } from "../webgpu/pbrRendererTypes.js";
import { mainPipelineKey, materialMode, rasterMode } from "../webgpu/pipelines.js";
import type { ThreeObjectSource } from "./types.js";
import type { ThreeProjectionBridge } from "./ThreeProjectionBridge.js";

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
export function firstFramePipelineMainKeys(packet: RenderPacket, kind: "all" | "static" | "deformed" = "all", advancedMaterials = false): readonly string[] {
  const materials = new Map(packet.materials.map(material => [material.id, material]));
  const keys = new Set<string>();
  for (const instance of packet.instances) {
    if (kind !== "all" && (instance.pose !== undefined) !== (kind === "deformed")) continue;
    const material = materials.get(instance.material);
    if (!material) continue;
    const transparent = (material.alphaMode ?? "OPAQUE") === "BLEND"
      || (advancedMaterials && (material.extendedParameters?.transmission.factor ?? 0) > 0);
    const textured = material.baseColorTexture !== undefined
      || material.metallicRoughnessTexture !== undefined
      || material.normalTexture !== undefined
      || material.occlusionTexture !== undefined
      || material.emissiveTexture !== undefined
      || material.specularTexture !== undefined || material.specularColorTexture !== undefined
      || (material.specularFactor !== undefined && material.specularFactor !== 1)
      || (material.specularColorFactor !== undefined && material.specularColorFactor.some(value => value !== 1))
      // 无纹理的扩展/高级 lobe 材质由中性纹理承载,走 material 管线(与 prepareMaterialTextures 的判定一致)。
      || material.extendedParameters !== undefined
      || (material.advancedParameters !== undefined
        && hasAdvancedMaterialFeatures(normalizeAdvancedMaterialParameters(material.advancedParameters)));
    keys.add(mainPipelineKey(
      materialMode(textured, material.normalTexture !== undefined),
      transparent,
      rasterMode(isMirroredTransform(instance.transform), material.doubleSided === true),
      // 同族清剿(2026-10-07):renderPacketBatches 的批次键含 /a2c 后缀,packetDraw
      // 按 /a2c 查表;关键集漏掉 a2c 键会让首帧 a2c 批次 fail-closed(包路径与
      // 投影路径同族)。BLEND+a2c 的非法组合由 renderPacketBatches 拒绝,这里
      // 同样不产生 blend×a2c 键(mainPipelineKey 的 a2c 位只在非透明档有意义)。
      material.alphaToCoverage === true && !transparent,
    ));
  }
  return [...keys];
}

/** 已知包的 pose 编译与静态关键管线共用 bootstrap 校验，背景仍待首帧放行。 */
export function packetFirstFrameRendererOptions(options: PbrRendererOptions, packet: RenderPacket): PbrRendererOptions {
  if (options.pipelines?.firstFrameSubset === false) return options;
  const posed = options.deformation === true && packet.instances.some(instance => instance.pose !== undefined);
  return Object.freeze({ ...options, pipelines: Object.freeze({ ...options.pipelines,
    firstFrameSubset: true,
    firstFrameMainKeys: Object.freeze(firstFramePipelineMainKeys(packet, posed ? "static" : "all", options.advancedMaterials === true)),
    ...(posed ? { deferDeformation: false,
      deformationFirstFrameMainKeys: Object.freeze(firstFramePipelineMainKeys(packet, "deformed", options.advancedMaterials === true)) } : {}),
  }) });
}

function isMirroredTransform(transform: ArrayLike<number>): boolean {
  if (transform.length < 11) return false;
  const a = transform[0]!, b = transform[1]!, c = transform[2]!;
  const d = transform[4]!, e = transform[5]!, f = transform[6]!;
  const g = transform[8]!, h = transform[9]!, i = transform[10]!;
  // 列主序 4×4 的左上 3×3 行列式。
  return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e) < 0;
}

/**
 * 投影路径首帧 main 键推导(首帧攻坚 2026-10-07):对 three 场景做一次 CPU 预投影,
 * 用与包路径完全相同的 `firstFramePipelineMainKeys` 推导首帧可能绘制的 main 键。
 *
 * 预投影是只读树遍历:bridge 的 `project()` 不落任何 GPU 状态,acceptance 由
 * `acknowledge()` 落账且被 epoch 守卫 —— 本次预投影从不 acknowledge,后续
 * `sync()` 的正式投影会自增 epoch 使其自然作废,几何/材质/纹理缓存(Map 命中)
 * 反而被第二次投影复用。投影失败返回 undefined(fail-open 回全量等待,不抛)。
 */
export function projectionFirstFrameMainKeys(projection: ThreeProjectionBridge, root: ThreeObjectSource,
  cameraLayerMask: number | undefined, view?: RenderView, advancedMaterials = false): readonly string[] | undefined {
  try {
    const projected = projection.project(root, {
      cameraLayerMask: cameraLayerMask ?? 1,
      ...(view ? { view } : {}),
    });
    return projected.ok ? firstFramePipelineMainKeys(projected.packet, "all", advancedMaterials) : undefined;
  } catch {
    return undefined;
  }
}
