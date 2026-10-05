import type * as THREE from "three";

/**
 * Deep 渲染器按需变体的宿主侧探测(同一族两档):
 * - advancedMaterials:场景里存在 three r185 MeshPhysicalMaterial 的 clearcoat / sheen /
 *   iridescence / transmission 激活 lobe 时才编译该着色变体与材质 uniform 扩展,其余场景保持
 *   stock 管线(WGSL、材质 uniform 与帧耗时均不变)。判定与 three refreshUniformsPhysical 一致:
 *   对应标量 > 0 才视为装载该 lobe。
 * - alphaToCoverage(AA-M2):场景/作者包里存在 `material.alphaToCoverage === true` 请求时才
 *   声明投影能力门并显式钉 MSAA4 主 pass;缺省不透传任何字段,现行为逐位不变。
 */
export function sceneUsesDeepAdvancedMaterials(root: THREE.Object3D): boolean {
  let used = false;
  root.traverse(child => {
    if (used) return;
    const material = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    for (const entry of Array.isArray(material) ? material : [material]) {
      const physical = entry as THREE.MeshPhysicalMaterial;
      if (physical.isMeshPhysicalMaterial === true
        && (physical.clearcoat > 0 || physical.sheen > 0 || physical.iridescence > 0 || physical.transmission > 0)) { used = true; return; }
    }
  });
  return used;
}
/** 独立作者包(SceneSnapshot 编译产物)是否携带需要 advancedMaterials 变体的 lobe。 */
export function packetUsesDeepAdvancedMaterials(packet: { readonly materials: ReadonlyArray<{
  readonly advancedParameters?: unknown;
  readonly extendedParameters?: { readonly clearcoat?: { readonly factor?: number }; readonly transmission?: { readonly factor?: number } };
}> }): boolean {
  return packet.materials.some(material => material.advancedParameters !== undefined
    || (material.extendedParameters?.clearcoat?.factor ?? 0) > 0 || (material.extendedParameters?.transmission?.factor ?? 0) > 0);
}

/** 投影桥/渲染器因"高级材质变体未启用"拒绝时的特征(用于受控重建,而不是整场景回退)。 */
export function isDeepAdvancedMaterialsRejection(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.includes("MeshPhysicalMaterial non-neutral extensions") || message.includes("advanced-materials/not-enabled");
}

/** 场景里是否存在 three r185 alpha-to-coverage 请求(仅声明,不校验合法性;BLEND 组合由投影桥 fail-closed 拒绝)。 */
export function sceneUsesAlphaToCoverage(root: THREE.Object3D): boolean {
  let used = false;
  root.traverse(child => {
    if (used) return;
    const material = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    for (const entry of Array.isArray(material) ? material : [material]) {
      if ((entry as THREE.MeshStandardMaterial).alphaToCoverage === true) { used = true; return; }
    }
  });
  return used;
}

/** 独立作者包(SceneSnapshot 编译产物)是否携带 alpha-to-coverage 请求。 */
export function packetUsesAlphaToCoverage(packet: { readonly materials: ReadonlyArray<{ readonly alphaToCoverage?: unknown }> }): boolean {
  return packet.materials.some(material => material.alphaToCoverage === true);
}

/**
 * 投影桥因"alpha-to-coverage 能力门未声明"拒绝时的精确特征(用于受控重建,与
 * advancedMaterials 同族)。必须带句号全匹配:能力门拒绝是
 * "…does not support material alphaToCoverage.",而语义拒绝
 * "…material alphaToCoverage with transparent."(transparent 组合无定义)不得触发重建。
 */
export function isAlphaToCoverageRejection(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.includes("Three projection does not support material alphaToCoverage.");
}

/**
 * 后端创建时的 a2c 双模式判定(体量门拆分,逻辑与合同注释自桥内迁此):
 * requested=粘性请求(晚到材质拒绝重建),maskFallbackActive=A2C-P1 探针判
 * 掩码未生效后的粘性降级档(不再声明 a2c 能力门,改投 alphaToCoverageMaskFallback
 * —— a2c 材质投影为 MASK@A2C_MASK_FALLBACK_ALPHA_CUTOFF(0.4),纯 a2c 的阶梯
 * 覆盖退化为硬切,但消除全画实心板;重建一次性,落定后不再重触发)。
 * 声明能力的同时显式钉 MSAA4 主 pass——a2c 管线变体只在多采样档构建(见桥)。
 */
export function resolveAlphaToCoverageCreateModes(input: {
  readonly requested: boolean;
  readonly authorRenderPacket: { readonly materials: ReadonlyArray<{ readonly alphaToCoverage?: unknown }> } | undefined;
  readonly scene: THREE.Object3D | undefined;
  readonly maskFallbackActive: boolean;
}): { readonly alphaToCoverage: boolean; readonly a2cMaskFallback: boolean } {
  const wanted = input.requested || (input.authorRenderPacket
    ? packetUsesAlphaToCoverage(input.authorRenderPacket) : sceneUsesAlphaToCoverage(input.scene!));
  return { alphaToCoverage: wanted && !input.maskFallbackActive, a2cMaskFallback: wanted && input.maskFallbackActive };
}
