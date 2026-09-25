import type { SceneMaterialState } from "@bim-studio/contracts";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { Color } from "three";
import { isNeutralMaterialField } from "./sceneNeutralAppearance";

type Material = RenderPacket["materials"][number];
const scalarFields = new Set(["color", "roughness", "metalness", "ior", "emissive", "emissiveIntensity", "doubleSided", "normalScale", "sourceColor", "sourceEmissive", "customShader"]);

export function assertStaticMaterialOverrides(state: SceneMaterialState | undefined, id: string): void {
  if (state?.slotOverrides !== undefined && (!state.slotOverrides || typeof state.slotOverrides !== "object"
    || Array.isArray(state.slotOverrides) || Object.keys(state.slotOverrides).length > 4096)) throw new Error(`对象 ${id} 的材质槽无效`);
  for (const [slot, value] of Object.entries(state?.slotOverrides ?? {})) {
    if (!/^gltf:(0|[1-9]\d*)$/.test(slot) || !value || typeof value !== "object" || "slotOverrides" in value) {
      throw new Error(`对象 ${id} 的材质槽无效`);
    }
    assertStaticMaterialOverrides(value, id);
  }
  for (const [key, value] of Object.entries(state ?? {})) {
    if (value !== undefined && key !== "slotOverrides" && !scalarFields.has(key) && !isNeutralMaterialField(key, value)) {
      throw new Error(`对象 ${id} 的扩展外观需要模型适配：${key}`);
    }
  }
}

/** Mirror the existing instance-wide editor override without mutating shared GLB materials. */
export function applyStaticMaterialOverrides(source: Material, state: SceneMaterialState | undefined, id: string, original: Material = source): Material {
  if (!state) return source;
  assertStaticMaterialOverrides(state, id);
  if (state.doubleSided !== undefined && typeof state.doubleSided !== "boolean") throw new Error(`对象 ${id} 的双面材质无效`);
  for (const key of ["sourceColor", "sourceEmissive"] as const) {
    if (state[key] !== undefined && typeof state[key] !== "boolean") throw new Error(`对象 ${id} 的源颜色恢复参数无效`);
  }
  const normalScale = state.normalScale === undefined ? undefined : bounded(state.normalScale, 4, id);
  if (state.ior !== undefined && (typeof state.ior !== "number" || state.ior < 1 || !Number.isFinite(Math.fround(state.ior)))) throw new Error(`对象 ${id} 的折射率必须为不小于 1 的有限数值`);
  return {
    ...source,
    ...(state.ior === undefined ? {} : { ior: state.ior }),
    ...(normalScale === undefined || !source.normalTexture ? {} : { normalTexture: { ...source.normalTexture, normalScale } }),
    ...(state.color === undefined && !state.sourceColor ? {} : { baseColor: state.sourceColor ? original.baseColor : linearColor(state.color!, id) }),
    ...(state.roughness === undefined ? {} : { roughness: bounded(state.roughness, 1, id) }),
    ...(state.metalness === undefined ? {} : { metallic: bounded(state.metalness, 1, id) }),
    ...(state.emissive === undefined && !state.sourceEmissive ? {} : { emissiveFactor: state.sourceEmissive ? original.emissiveFactor ?? [0, 0, 0] : linearColor(state.emissive!, id) }),
    ...(state.emissiveIntensity === undefined ? {} : { emissiveStrength: bounded(state.emissiveIntensity, 10, id) }),
    ...(state.doubleSided === undefined ? {} : { doubleSided: state.doubleSided }),
  };
}
function bounded(value: number, max: number, id: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`对象 ${id} 的材质参数必须为有限数值`);
  return Math.min(max, Math.max(0, value));
}
function linearColor(value: string, id: string): [number, number, number] {
  if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value)) throw new Error(`对象 ${id} 的材质颜色必须为 #RRGGBB`);
  const color = new Color(value);
  return [color.r, color.g, color.b];
}

export function sourceMaterialSlot(id: string): string | undefined {
  const index = /\/material\/(0|[1-9]\d*)$/.exec(id)?.[1];
  return index === undefined ? undefined : `gltf:${index}`;
}
export function applySourceMaterialOverrides(source: Material, state: SceneMaterialState | undefined, id: string): Material {
  const global = applyStaticMaterialOverrides(source, state, id);
  const slot = sourceMaterialSlot(source.id);
  return slot ? applyStaticMaterialOverrides(global, state?.slotOverrides?.[slot], id, source) : global;
}
export function assertMaterialSlotsResolve(materials: readonly Material[], state: SceneMaterialState | undefined, id: string): void {
  const slots = new Set(materials.map(material => sourceMaterialSlot(material.id)));
  for (const slot of Object.keys(state?.slotOverrides ?? {})) {
    if (!slots.has(slot)) throw new Error(`对象 ${id} 的材质槽不在源资源中：${slot}`);
  }
}
