import type { Material } from "three";

interface SourceOpacity { opacity: number; transparent: boolean; depthWrite: boolean }
const sourceOpacity = new WeakMap<Material, SourceOpacity>();

/** 场景透明度是源外观的倍率；共享材质被遍历多次也不能累乘。 */
export function applySourceMaterialOpacity(material: Material, factor: number): void {
  let source = sourceOpacity.get(material);
  if (!source) {
    source = { opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite };
    sourceOpacity.set(material, source);
  }
  const multiplier = Number.isFinite(factor) ? Math.max(0, Math.min(1, factor)) : 1;
  const transparent = source.transparent || multiplier < 0.999;
  if (material.transparent !== transparent) material.needsUpdate = true;
  material.opacity = source.opacity * multiplier;
  material.transparent = transparent;
  material.depthWrite = source.depthWrite && multiplier >= 0.999;
}
