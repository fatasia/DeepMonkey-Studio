import type { SceneMaterialState } from "@bim-studio/contracts";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as THREE from "three";

const SOURCE_SLOT = "studioGltfMaterialSlot";
export interface SelectionMaterialSlot { id: string; name: string; material: SceneMaterialState; sourceMaterial?: SceneMaterialState; }

/** Material indices survive GLTF reloads and per-instance Material.clone(). */
export function tagGltfMaterialSlots(gltf: GLTF): void {
  gltf.scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      const index = gltf.parser.associations.get(material)?.materials;
      if (Number.isSafeInteger(index) && index! >= 0) {
        material.userData[SOURCE_SLOT] = `gltf:${index}`;
        material.userData.studioSourceMaterialState = readMaterialSlot(material);
        const standard = material as THREE.MeshStandardMaterial;
        material.userData.studioSourceLinearColors = {
          ...(standard.color?.isColor ? { color: standard.color.toArray() } : {}),
          ...(standard.emissive?.isColor ? { emissive: standard.emissive.toArray() } : {}),
        };
      }
    }
  });
}
export function materialSlotId(material: THREE.Material): string | undefined {
  const id = material.userData[SOURCE_SLOT];
  return typeof id === "string" && /^gltf:(0|[1-9]\d*)$/.test(id) ? id : undefined;
}
export function materialStateForSlot(state: SceneMaterialState, material: THREE.Material): SceneMaterialState | undefined {
  const { slotOverrides, ...global } = state;
  const id = materialSlotId(material);
  const slot = id ? slotOverrides?.[id] : undefined;
  if (Object.keys(global).length === 0 && !slot) return undefined;
  return slot ? { ...global, ...slot } : global;
}
export function readMaterialSlot(material: THREE.Material): SceneMaterialState {
  const value = material as THREE.MeshStandardMaterial;
  const adjustment = value.userData.studioColorAdjustment as Partial<SceneMaterialState> | undefined;
  return {
    hue: adjustment?.hue ?? 0, saturation: adjustment?.saturation ?? 0,
    brightness: adjustment?.brightness ?? 0, contrast: adjustment?.contrast ?? 0,
    ...(value.normalScale?.isVector2 ? { normalScale: value.normalScale.x } : {}),
    ...(typeof value.wireframe === "boolean" ? { wireframe: value.wireframe } : {}),
    ...(value.color?.isColor ? { color: `#${value.color.getHexString()}` } : {}),
    ...(typeof value.roughness === "number" ? { roughness: value.roughness } : {}),
    ...(typeof value.metalness === "number" ? { metalness: value.metalness } : {}),
    ...(value.isMeshStandardMaterial ? { ior: (value as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial ? (value as THREE.MeshPhysicalMaterial).ior : 1.5 } : {}),
    ...(value.emissive?.isColor ? { emissive: `#${value.emissive.getHexString()}`, emissiveIntensity: value.emissiveIntensity } : {}),
    doubleSided: value.side === THREE.DoubleSide,
  };
}

export function sourceMaterialState(material: THREE.Material): SceneMaterialState | undefined {
  const source = material.userData.studioSourceMaterialState as SceneMaterialState | undefined;
  return source ? structuredClone(source) : undefined;
}

export function restoreMaterialSourceColors(material: THREE.MeshStandardMaterial, state: SceneMaterialState): void {
  const source = material.userData.studioSourceLinearColors as { color?: number[]; emissive?: number[] } | undefined;
  if (state.sourceColor && source?.color && material.color?.isColor) material.color.fromArray(source.color);
  if (state.sourceEmissive && source?.emissive && material.emissive?.isColor) material.emissive.fromArray(source.emissive);
}

export function mergeMaterialPatch(previous: SceneMaterialState | undefined, patch: SceneMaterialState): SceneMaterialState {
  const next = { ...previous, ...structuredClone(patch) };
  if (patch.sourceColor === undefined && ["color", "hue", "saturation", "brightness", "contrast"].some(key => key in patch)) next.sourceColor = false;
  if (patch.sourceEmissive === undefined && patch.emissive !== undefined) next.sourceEmissive = false;
  if (patch.slotOverrides) {
    next.slotOverrides = { ...previous?.slotOverrides };
    for (const [id, slot] of Object.entries(patch.slotOverrides)) next.slotOverrides[id] = mergeMaterialPatch(previous?.slotOverrides?.[id], slot);
  }
  return next;
}
