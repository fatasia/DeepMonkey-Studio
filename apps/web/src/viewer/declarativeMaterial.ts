import * as THREE from "three";
import type { SceneMaterialState } from "@bim-studio/contracts";
import { compileDeclarativeMaterial, registerDeclarativeMaterialOwner, clearDeclarativeMaterialOwner } from "@bim-studio/deep-engine/shader-authoring";
import { materialStateForSlot } from "./materialSlots";
import { copyOwnedMaterialSurface } from "./materialIor";

const baselines = new WeakMap<THREE.Material, THREE.Material>();

/** Validate every source before any detach/promotion; metadata is not an execution sandbox. */
export function validateDeclarativeMaterialPatch(patch: SceneMaterialState): void {
  for (const state of [patch, ...Object.values(patch.slotOverrides ?? {})]) {
    if (state.customShader !== undefined) compileDeclarativeMaterial(state.customShader.source);
  }
}

export function prepareDeclarativeMaterial(object: THREE.Object3D, patch: SceneMaterialState,
  collisionOriginals: Map<THREE.Mesh, THREE.Material | THREE.Material[]>,
  onReplace: (source: THREE.Material, target: THREE.Material) => void): void {
  const replacements = new Map<THREE.Material, THREE.Material>();
  object.traverse(child => {
    const mesh = child as THREE.Mesh, original = collisionOriginals.get(mesh) ?? mesh.material;
    if (!original) return;
    const materials = Array.isArray(original) ? original : [original];
    const next = materials.map(source => {
      const previous = replacements.get(source); if (previous) return previous;
      const state = materialStateForSlot(patch, source);
      if (!state || !Object.hasOwn(state, "customShader")) return source;
      const compiled = state.customShader ? compileDeclarativeMaterial(state.customShader.source) : undefined;
      const baseline = baselines.get(source);
      if (!compiled) {
        if (!baseline) return source;
        const restored = baseline.clone(); restored.userData = { ...baseline.userData };
        delete restored.userData.studioCustomShader;
        onReplace(source, restored); replacements.set(source, restored); return restored;
      }
      const m = compiled.model;
      const desired = m.surface === "unlit" ? "basic" : m.clearcoatFactor > 0 ? "physical" : "standard";
      const current = source as THREE.MeshPhysicalMaterial;
      const target = desired === "basic" ? new THREE.MeshBasicMaterial()
        : desired === "physical" ? new THREE.MeshPhysicalMaterial() : new THREE.MeshStandardMaterial();
      copyOwnedMaterialSurface(target, baseline ?? source);
      // MeshBasicMaterial cannot copy Standard/Physical fields through its specialized copy.
      if ((target as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
        const basic = target as THREE.MeshBasicMaterial;
        basic.map = current.map; basic.color.copy(current.color); basic.opacity = current.opacity;
      }
      baselines.set(target, baseline ?? source.clone());
      const standard = target as THREE.MeshPhysicalMaterial;
      standard.color.fromArray(m.baseColor);
      standard.userData.studioUngradedColor = `#${standard.color.getHexString()}`;
      standard.userData.studioUngradedLinearColor = standard.color.toArray();
      standard.userData.studioCustomShader = { source: compiled.source };
      if (standard.isMeshStandardMaterial) {
        standard.metalness = m.metallic; standard.roughness = m.roughness;
        standard.emissive.fromArray(m.emissiveFactor); standard.emissiveIntensity = m.emissiveStrength;
      }
      if (standard.isMeshPhysicalMaterial) { standard.clearcoat = m.clearcoatFactor; standard.clearcoatRoughness = m.clearcoatRoughness; }
      standard.opacity = m.alpha === "opaque" ? 1 : m.baseColor[3];
      standard.transparent = m.alpha === "blend"; standard.alphaTest = m.alpha === "mask" ? 0.5 : 0;
      standard.depthWrite = m.alpha !== "blend"; standard.side = m.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
      registerDeclarativeMaterialOwner(target, compiled.source);
      onReplace(source, target); replacements.set(source, target); return target;
    });
    if (next.every((material, i) => material === materials[i])) return;
    const result = Array.isArray(original) ? next : next[0]!;
    if (collisionOriginals.has(mesh)) collisionOriginals.set(mesh, result); else mesh.material = result;
  });
  for (const source of replacements.keys()) { clearDeclarativeMaterialOwner(source); baselines.delete(source); source.dispose(); }
}
