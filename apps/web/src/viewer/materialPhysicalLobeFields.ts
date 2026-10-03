/**
 * MeshPhysicalMaterial 高级 lobe 的字段表与纯校验(无 three 依赖,delivery 编译与编辑器共用):
 * 范围/单位/小数位全系统唯一来源。语义与 three r185、Deep advancedMaterials 变体一致;缺省 = 中性。
 */
import type { SceneMaterialState } from "@bim-studio/contracts";

export type PhysicalLobeScalarKey = "clearcoat" | "clearcoatRoughness" | "sheen" | "sheenRoughness" | "iridescence"
  | "iridescenceIOR" | "iridescenceThicknessMax" | "transmission" | "thickness" | "attenuationDistance";
export type PhysicalLobeColorKey = "sheenColor" | "attenuationColor";
export type PhysicalLobeKey = PhysicalLobeScalarKey | PhysicalLobeColorKey;

export interface PhysicalLobeScalarField {
  readonly key: PhysicalLobeScalarKey;
  readonly zh: string;
  readonly en: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly decimals: number;
  readonly unit: string;
  readonly neutral: number;
  /** 持久化合同允许的硬范围(contracts/sceneValidation);UI 滑块范围 [min,max] 是其子集。 */
  readonly limit: readonly [number, number];
}

/** 范围与 contracts/sceneValidation 对齐;厚度/衰减距离用世界单位(场景米制)。 */
export const PHYSICAL_LOBE_SCALARS: readonly PhysicalLobeScalarField[] = Object.freeze([
  { key: "clearcoat", zh: "清漆强度", en: "Clearcoat", min: 0, max: 1, step: 0.01, decimals: 2, unit: "", neutral: 0, limit: [0, 1] },
  { key: "clearcoatRoughness", zh: "清漆粗糙度", en: "Clearcoat roughness", min: 0, max: 1, step: 0.01, decimals: 2, unit: "", neutral: 0, limit: [0, 1] },
  { key: "sheen", zh: "光泽强度", en: "Sheen", min: 0, max: 1, step: 0.01, decimals: 2, unit: "", neutral: 0, limit: [0, 1] },
  { key: "sheenRoughness", zh: "光泽粗糙度", en: "Sheen roughness", min: 0, max: 1, step: 0.01, decimals: 2, unit: "", neutral: 1, limit: [0, 1] },
  { key: "iridescence", zh: "薄膜干涉", en: "Iridescence", min: 0, max: 1, step: 0.01, decimals: 2, unit: "", neutral: 0, limit: [0, 1] },
  { key: "iridescenceIOR", zh: "薄膜折射率", en: "Film IOR", min: 1, max: 3, step: 0.01, decimals: 2, unit: "", neutral: 1.3, limit: [1, 3] },
  { key: "iridescenceThicknessMax", zh: "薄膜厚度", en: "Film thickness", min: 0, max: 1000, step: 1, decimals: 0, unit: "nm", neutral: 400, limit: [0, 10000] },
  { key: "transmission", zh: "透射", en: "Transmission", min: 0, max: 1, step: 0.01, decimals: 2, unit: "", neutral: 0, limit: [0, 1] },
  { key: "thickness", zh: "体积厚度", en: "Volume thickness", min: 0, max: 10, step: 0.01, decimals: 2, unit: "m", neutral: 0, limit: [0, 1e6] },
  { key: "attenuationDistance", zh: "衰减距离", en: "Attenuation distance", min: 0.01, max: 100, step: 0.01, decimals: 2, unit: "m", neutral: Infinity, limit: [Number.MIN_VALUE, Number.MAX_VALUE] },
]);
export const PHYSICAL_LOBE_COLOR_NEUTRAL: Readonly<Record<PhysicalLobeColorKey, string>> = Object.freeze({
  sheenColor: "#000000", attenuationColor: "#ffffff",
});
export const PHYSICAL_LOBE_KEYS: readonly PhysicalLobeKey[] = Object.freeze([
  ...PHYSICAL_LOBE_SCALARS.map(field => field.key), "sheenColor", "attenuationColor"]);

const HEX = /^#[0-9a-f]{6}$/i;
const COLOR_KEYS = ["sheenColor", "attenuationColor"] as const;

export function physicalLobeField(key: PhysicalLobeScalarKey): PhysicalLobeScalarField {
  return PHYSICAL_LOBE_SCALARS.find(field => field.key === key)!;
}

/** 补丁里出现任一 lobe 字段(含显式 undefined 清除)。 */
export function patchTouchesPhysicalLobes(patch: SceneMaterialState): boolean {
  return PHYSICAL_LOBE_KEYS.some(key => Object.hasOwn(patch, key));
}

/** 任一 lobe 字段取非中性值 → 需要 MeshPhysicalMaterial。 */
export function stateActivatesPhysicalLobes(state: SceneMaterialState): boolean {
  for (const field of PHYSICAL_LOBE_SCALARS) {
    const value = state[field.key];
    if (value !== undefined && value !== field.neutral) return true;
  }
  return COLOR_KEYS.some(key => state[key] !== undefined && state[key]!.toLowerCase() !== PHYSICAL_LOBE_COLOR_NEUTRAL[key]);
}

/** 原子校验:整个补丁(含槽位覆盖)先校验再 mutation,越界/非法抛错。 */
export function validatePhysicalLobePatch(patch: SceneMaterialState): void {
  for (const state of [patch, ...Object.values(patch.slotOverrides ?? {})]) {
    for (const field of PHYSICAL_LOBE_SCALARS) {
      if (!Object.hasOwn(state, field.key)) continue;
      const value = state[field.key];
      if (value === undefined) {
        if (field.key === "attenuationDistance") continue;
        throw new Error(`${field.zh}不能为空`);
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < field.limit[0] || value > field.limit[1]) {
        throw new Error(`${field.zh}必须在 ${field.limit[0]}–${field.limit[1]}${field.unit} 范围内`);
      }
    }
    for (const key of COLOR_KEYS) {
      if (!Object.hasOwn(state, key)) continue;
      const value = state[key];
      if (typeof value !== "string" || !HEX.test(value)) throw new Error(`${key} 必须是 #RRGGBB`);
    }
  }
}

