import * as THREE from "three";
import type { SceneMaterialState } from "@bim-studio/contracts";
import { copyOwnedMaterialSurface } from "./materialIor";
import { materialStateForSlot } from "./materialSlots";
import { PHYSICAL_LOBE_COLOR_NEUTRAL, patchTouchesPhysicalLobes, physicalLobeField, stateActivatesPhysicalLobes,
  validatePhysicalLobePatch, type PhysicalLobeScalarKey } from "./materialPhysicalLobeFields";

export * from "./materialPhysicalLobeFields";

/** MeshPhysicalMaterial 高级 lobe 的 three 材质读写与 standard→physical 晋升(字段表见 materialPhysicalLobeFields)。 */

/** 读取 three 材质当前值;仅 MeshStandardMaterial 系输出(与 ior 同口径),standard 材质给中性值。 */
export function readPhysicalLobes(material: THREE.Material): SceneMaterialState {
  const value = material as THREE.MeshPhysicalMaterial;
  if (!value.isMeshStandardMaterial) return {};
  if (!value.isMeshPhysicalMaterial) {
    return { clearcoat: 0, clearcoatRoughness: 0, sheen: 0, sheenRoughness: 1, sheenColor: PHYSICAL_LOBE_COLOR_NEUTRAL.sheenColor,
      iridescence: 0, iridescenceIOR: 1.3, iridescenceThicknessMax: 400, transmission: 0, thickness: 0,
      attenuationColor: PHYSICAL_LOBE_COLOR_NEUTRAL.attenuationColor };
  }
  return {
    clearcoat: value.clearcoat, clearcoatRoughness: value.clearcoatRoughness,
    sheen: value.sheen, sheenRoughness: value.sheenRoughness, sheenColor: `#${value.sheenColor.getHexString()}`,
    iridescence: value.iridescence, iridescenceIOR: value.iridescenceIOR,
    iridescenceThicknessMax: value.iridescenceThicknessRange[1] ?? 400,
    transmission: value.transmission, thickness: value.thickness,
    attenuationColor: `#${value.attenuationColor.getHexString()}`,
    ...(Number.isFinite(value.attenuationDistance) ? { attenuationDistance: value.attenuationDistance } : {}),
  };
}

/** 把补丁写入 MeshPhysicalMaterial;非 physical 材质忽略(晋升由 preparePhysicalLobes 负责)。 */
export function applyPhysicalLobes(material: THREE.Material, state: SceneMaterialState): void {
  const target = material as THREE.MeshPhysicalMaterial;
  if (!target.isMeshPhysicalMaterial || !patchTouchesPhysicalLobes(state)) return;
  const clamp = (key: PhysicalLobeScalarKey, value: number): number => {
    const field = physicalLobeField(key);
    return THREE.MathUtils.clamp(value, field.limit[0], field.limit[1]);
  };
  if (state.clearcoat !== undefined) target.clearcoat = clamp("clearcoat", state.clearcoat);
  if (state.clearcoatRoughness !== undefined) target.clearcoatRoughness = clamp("clearcoatRoughness", state.clearcoatRoughness);
  if (state.sheen !== undefined) target.sheen = clamp("sheen", state.sheen);
  if (state.sheenRoughness !== undefined) target.sheenRoughness = clamp("sheenRoughness", state.sheenRoughness);
  if (state.sheenColor !== undefined) target.sheenColor.set(state.sheenColor);
  if (state.iridescence !== undefined) target.iridescence = clamp("iridescence", state.iridescence);
  if (state.iridescenceIOR !== undefined) target.iridescenceIOR = clamp("iridescenceIOR", state.iridescenceIOR);
  if (state.iridescenceThicknessMax !== undefined) {
    target.iridescenceThicknessRange = [target.iridescenceThicknessRange[0] ?? 100, clamp("iridescenceThicknessMax", state.iridescenceThicknessMax)];
  }
  if (state.transmission !== undefined) target.transmission = clamp("transmission", state.transmission);
  if (state.thickness !== undefined) target.thickness = clamp("thickness", state.thickness);
  if (state.attenuationColor !== undefined) target.attenuationColor.set(state.attenuationColor);
  // 显式 undefined = 清除(恢复 three 默认的无限衰减距离)。
  if (Object.hasOwn(state, "attenuationDistance")) {
    target.attenuationDistance = state.attenuationDistance === undefined ? Infinity : clamp("attenuationDistance", state.attenuationDistance);
  }
  target.needsUpdate = true;
}

/** 仅当补丁请求非中性 lobe 时,把受影响的 MeshStandardMaterial 晋升为 MeshPhysicalMaterial(与 prepareMaterialIor 同构)。 */
export function preparePhysicalLobes(object: THREE.Object3D, patch: SceneMaterialState,
  collisionOriginals: Map<THREE.Mesh, THREE.Material | THREE.Material[]>,
  onPromote?: (source: THREE.Material, target: THREE.Material) => void): void {
  validatePhysicalLobePatch(patch);
  const replacements = new Map<THREE.Material, THREE.Material>();
  object.traverse(child => {
    const mesh = child as THREE.Mesh;
    const original = collisionOriginals.get(mesh) ?? mesh.material;
    if (!original) return;
    const sources = Array.isArray(original) ? original : [original];
    const next = sources.map(source => {
      const cached = replacements.get(source);
      if (cached) return cached;
      const state = materialStateForSlot(patch, source);
      const material = source as THREE.MeshPhysicalMaterial;
      if (!state || !material.isMeshStandardMaterial || material.isMeshPhysicalMaterial || !stateActivatesPhysicalLobes(state)) return source;
      const physical = new THREE.MeshPhysicalMaterial();
      copyOwnedMaterialSurface(physical, material);
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
