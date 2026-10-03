import type * as THREE from "three";

/**
 * Deep advancedMaterials 变体按需开关:仅当场景里存在 three r185 MeshPhysicalMaterial 的
 * clearcoat / sheen / iridescence / transmission 激活 lobe 时才编译该着色变体与材质 uniform 扩展,
 * 其余场景保持 stock 管线(WGSL、材质 uniform 与帧耗时均不变)。判定与 three refreshUniformsPhysical 一致:
 * 对应标量 > 0 才视为装载该 lobe。
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