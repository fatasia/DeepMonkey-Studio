import * as THREE from "three";
import type { SceneMaterialState } from "@bim-studio/contracts";
import { materialStateForSlot } from "./materialSlots";

export function materialIor(material: THREE.Material): number | undefined {
  const value = material as THREE.MeshPhysicalMaterial;
  return value.isMeshStandardMaterial ? value.isMeshPhysicalMaterial ? value.ior : 1.5 : undefined;
}

/** Promote only edited standard materials; physical parameters require Three's physical shader. */
export function prepareMaterialIor(object: THREE.Object3D, patch: SceneMaterialState,
  collisionOriginals: Map<THREE.Mesh, THREE.Material | THREE.Material[]>,
  onPromote?: (source: THREE.Material, target: THREE.Material) => void): void {
  // Validate the whole edit before mutating any slot, so malformed persisted state is atomic.
  for (const state of [patch, ...Object.values(patch.slotOverrides ?? {})]) {
    if (state.ior !== undefined && (!Number.isFinite(state.ior) || state.ior < 1 || !Number.isFinite(Math.fround(state.ior)))) {
      throw new Error("折射率必须为不小于 1 的有限数值");
    }
  }
  const replacements = new Map<THREE.Material, THREE.Material>();
  object.traverse(child => {
    const mesh = child as THREE.Mesh;
    const original = collisionOriginals.get(mesh) ?? mesh.material;
    if (!original) return;
    const sources = Array.isArray(original) ? original : [original];
    const next = sources.map(source => {
      const cached = replacements.get(source);
      if (cached) return cached;
      const ior = materialStateForSlot(patch, source)?.ior;
      if (ior === undefined) return source;
      const material = source as THREE.MeshPhysicalMaterial;
      if (!material.isMeshStandardMaterial) return source;
      if (material.isMeshPhysicalMaterial) { material.ior = ior; return source; }
      if (ior === 1.5) return source;
      const physical = new THREE.MeshPhysicalMaterial();
      THREE.MeshStandardMaterial.prototype.copy.call(physical, material);
      physical.defines = { ...material.defines, PHYSICAL: "" };
      // Texture ownership metadata and source snapshots retain their original objects.
      physical.userData = { ...material.userData };
      physical.onBeforeCompile = material.onBeforeCompile;
      physical.customProgramCacheKey = material.customProgramCacheKey;
      physical.ior = ior;
      onPromote?.(source, physical);
      replacements.set(source, physical);
      return physical;
    });
    if (next.every((item, index) => item === sources[index])) return;
    const result = Array.isArray(original) ? next : next[0]!;
    if (collisionOriginals.has(mesh)) collisionOriginals.set(mesh, result);
    else mesh.material = result;
  });
  for (const source of replacements.keys()) source.dispose();
}
