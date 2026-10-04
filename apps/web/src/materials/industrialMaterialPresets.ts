import type { SceneMaterialState } from "@bim-studio/contracts";

/**
 * 工业材质参数预设库(编辑器刀 5)。
 *
 * 预设 = 参数组合的声明表,不是新渲染路径:套用 = `expandMaterialPreset` 展开为
 * 全量外观 patch,走既有 `updateSelectionMaterial` → selectionMaterialCommand →
 * 引擎 mergeMaterialPatch/applyMaterialState 写路径,对象即时更新。
 *
 * 字段口径 = contracts/sceneMaterial.ts + sceneValidation.ts 合法域:
 * - metalness/roughness ∈ [0,1];ior ≥ 1;transmission ∈ [0,1];thickness ∈ [0,1e6];
 *   clearcoat/sheen/iridescence ∈ [0,1];emissive ∈ 颜色串,emissiveIntensity ∈ [0,10]。
 * - 契约无 alpha/opacity 材质字段(模型层 SceneModelState.opacity 另行管理),
 *   玻璃类预设用 transmission + roughness 表达,不写 alpha。
 * - transmission/clearcoat 等 lobe 仅在 MeshPhysicalMaterial(WebGL 全量支持;
 *   Deep WebGPU 管线需 advancedMaterials 变体才求值,见 studioDeepAdvancedMaterials.ts)。
 */

export type MaterialPresetGroup = "metal" | "nonmetal" | "glass-screen";

export interface IndustrialMaterialPreset {
  id: string;
  zh: string;
  en: string;
  group: MaterialPresetGroup;
  /** 预设外观参数;只允许标量外观域字段(不允许贴图/screen/uvAnimation/shaderEffect/slotOverrides)。 */
  values: PresetMaterialValues;
}

/** 预设可携带的标量外观域(契约 SceneMaterialState 的真子集);color/metalness/roughness 必填。 */
export type PresetMaterialValues = Required<Pick<
  SceneMaterialState, "color" | "metalness" | "roughness"
>> & Partial<Pick<SceneMaterialState, PresetOptionalKey>>;

type PresetOptionalKey = "ior" | "emissive" | "emissiveIntensity" | "transmission" | "thickness" | "clearcoat"
  | "clearcoatRoughness" | "sheen" | "sheenRoughness" | "sheenColor" | "iridescence"
  | "attenuationColor" | "attenuationDistance" | "doubleSided";

/** 内置预设套用时强制接管的外观域;未显式给出的字段写中性关闭值,覆盖对象残留外观。 */
const NEUTRAL_APPEARANCE = {
  emissive: "#000000",
  emissiveIntensity: 0,
  transmission: 0,
  thickness: 0,
  clearcoat: 0,
  clearcoatRoughness: 0,
  sheen: 0,
  sheenRoughness: 1,
  iridescence: 0,
} as const;

export const PRESET_GROUPS: ReadonlyArray<{ key: MaterialPresetGroup; zh: string; en: string }> = [
  { key: "metal", zh: "金属", en: "Metal" },
  { key: "nonmetal", zh: "非金属", en: "Non-metal" },
  { key: "glass-screen", zh: "玻璃与屏", en: "Glass & screens" },
];

/**
 * 内置工业预设(12)。参数按物理合理标定(PBR 手册/ Substance 源常规域):
 * 抛光金属 rough 0.1–0.25,机加工/拉丝 0.35–0.5,铸造面 0.6–0.8;
 * 塑料/橡胶/混凝土为介电(metal 0),玻璃 transmission 0.85–0.95 + ior 1.5。
 */
export const BUILTIN_MATERIAL_PRESETS: readonly IndustrialMaterialPreset[] = Object.freeze([
  {
    id: "builtin.stainless-steel",
    zh: "不锈钢",
    en: "Stainless steel",
    group: "metal",
    values: { color: "#c8c8c8", metalness: 1, roughness: 0.22 },
  },
  {
    id: "builtin.brushed-metal",
    zh: "拉丝金属",
    en: "Brushed metal",
    group: "metal",
    values: { color: "#9ba3aa", metalness: 0.92, roughness: 0.38 },
  },
  {
    id: "builtin.anodized-aluminum",
    zh: "阳极氧化铝",
    en: "Anodized aluminum",
    group: "metal",
    values: { color: "#7f8790", metalness: 1, roughness: 0.55 },
  },
  {
    id: "builtin.brass",
    zh: "黄铜",
    en: "Brass",
    group: "metal",
    values: { color: "#c9a24a", metalness: 1, roughness: 0.28 },
  },
  {
    id: "builtin.cast-iron",
    zh: "铸铁",
    en: "Cast iron",
    group: "metal",
    values: { color: "#565b62", metalness: 1, roughness: 0.75 },
  },
  {
    id: "builtin.galvanized-steel",
    zh: "镀锌钢",
    en: "Galvanized steel",
    group: "metal",
    values: { color: "#a9b2b8", metalness: 1, roughness: 0.5 },
  },
  {
    id: "builtin.engineering-plastic",
    zh: "工程塑料",
    en: "Engineering plastic",
    group: "nonmetal",
    values: { color: "#d4a84f", metalness: 0, roughness: 0.45 },
  },
  {
    id: "builtin.rubber",
    zh: "橡胶",
    en: "Rubber",
    group: "nonmetal",
    values: { color: "#26292c", metalness: 0, roughness: 0.88 },
  },
  {
    id: "builtin.concrete",
    zh: "混凝土",
    en: "Concrete",
    group: "nonmetal",
    values: { color: "#a8a39a", metalness: 0, roughness: 0.9 },
  },
  {
    id: "builtin.gloss-ceramic",
    zh: "亮面陶瓷",
    en: "Gloss ceramic",
    group: "nonmetal",
    values: { color: "#dde8ea", metalness: 0, roughness: 0.08 },
  },
  {
    id: "builtin.frosted-glass",
    zh: "磨砂玻璃",
    en: "Frosted glass",
    group: "glass-screen",
    // 契约无 alpha 字段;透射走 transmission + roughness(WebGL MeshPhysicalMaterial 全量支持)。
    values: { color: "#e6eef0", metalness: 0, roughness: 0.6, transmission: 0.85, thickness: 0.5, ior: 1.52 },
  },
  {
    id: "builtin.emissive-panel",
    zh: "自发光屏",
    en: "Emissive panel",
    group: "glass-screen",
    values: { color: "#0c0f12", metalness: 0, roughness: 0.25, emissive: "#58c6f2", emissiveIntensity: 2.5 },
  },
]) as readonly IndustrialMaterialPreset[];

const HEX = /^#[0-9a-f]{6}$/i;

/** 预设参数域校验:越界/非法即拒绝(存为预设与内置表单测共用同一裁决)。 */
export function validateMaterialPresetValues(values: unknown): string[] {
  const problems: string[] = [];
  if (typeof values !== "object" || values === null) return ["预设参数必须是对象"];
  const v = values as Record<string, unknown>;
  if (typeof v.color !== "string" || !HEX.test(v.color)) problems.push("基础色必须是 #RRGGBB");
  for (const key of ["metalness", "roughness"] as const) {
    const value = v[key];
    if (value === undefined || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      problems.push(`${key} 必须是 0–1 的有限数值`);
    }
  }
  if (v.ior !== undefined && (typeof v.ior !== "number" || !Number.isFinite(v.ior) || v.ior < 1)) problems.push("折射率必须是 ≥1 的有限数值");
  for (const key of ["emissiveIntensity"] as const) {
    const value = v[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10)) {
      problems.push(`${key} 必须是 0–10 的有限数值`);
    }
  }
  for (const key of ["transmission", "thickness", "clearcoat", "clearcoatRoughness", "sheen", "sheenRoughness", "iridescence"] as const) {
    const value = v[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) problems.push(`${key} 必须是非负有限数值`);
    else if (key !== "thickness" && value > 1) problems.push(`${key} 必须在 0–1 范围内`);
    else if (key === "thickness" && value > 1e6) problems.push("thickness 超过持久化上限 1e6");
  }
  for (const key of ["emissive", "sheenColor", "attenuationColor"] as const) {
    const value = v[key];
    if (value !== undefined && (typeof value !== "string" || !HEX.test(value))) problems.push(`${key} 必须是 #RRGGBB`);
  }
  if (v.attenuationDistance !== undefined && (typeof v.attenuationDistance !== "number" || !Number.isFinite(v.attenuationDistance) || v.attenuationDistance <= 0)) {
    problems.push("衰减距离必须是大于 0 的有限数值");
  }
  return problems;
}

/**
 * 把预设展开为"全量外观 patch":
 * - 预设字段 → 预设值;
 * - 外观接管域未给出 → 中性关闭值(引擎 applyMaterialNumbers 对 emissive 用 truthy 判断、
 *   applyPhysicalLobes 对 undefined 跳过,只有中性值能真正覆盖残留外观);
 * - 中性 0 不会误触 standard→physical 晋升(stateActivatesPhysicalLobes 判非中性才晋升);
 * - 不触碰:贴图字段、颜色校正、UV 动画、屏幕、shaderEffect、customShader、slotOverrides
 *   ——预设接管 PBR 参数,不破坏用户贴图与屏幕配置。
 */
export function expandMaterialPreset(values: PresetMaterialValues): SceneMaterialState {
  // 中性基线先行(确定性键值,不含 undefined),预设显式值逐键覆盖;
  // 中性 0 不会误触 standard→physical 晋升(stateActivatesPhysicalLobes 判非中性才晋升)。
  const expanded: SceneMaterialState = {
    color: values.color,
    metalness: values.metalness,
    roughness: values.roughness,
    emissive: NEUTRAL_APPEARANCE.emissive,
    emissiveIntensity: NEUTRAL_APPEARANCE.emissiveIntensity,
    transmission: NEUTRAL_APPEARANCE.transmission,
    thickness: NEUTRAL_APPEARANCE.thickness,
    clearcoat: NEUTRAL_APPEARANCE.clearcoat,
    clearcoatRoughness: NEUTRAL_APPEARANCE.clearcoatRoughness,
    sheen: NEUTRAL_APPEARANCE.sheen,
    sheenRoughness: NEUTRAL_APPEARANCE.sheenRoughness,
    iridescence: NEUTRAL_APPEARANCE.iridescence,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) (expanded as Record<string, unknown>)[key] = structuredClone(value);
  }
  return expanded;
}

const CAPTURE_KEYS = [
  "color", "metalness", "roughness", "ior", "emissive", "emissiveIntensity",
  "transmission", "thickness", "clearcoat", "clearcoatRoughness",
  "sheen", "sheenRoughness", "sheenColor", "iridescence",
  "attenuationColor", "attenuationDistance", "doubleSided",
] as const satisfies ReadonlyArray<keyof PresetMaterialValues>;

/** 从当前对象材质捕获标量外观域(存为预设的数据源;贴图/屏幕/UV/特效不入预设)。 */
export function capturePresetValues(material: SceneMaterialState): PresetMaterialValues {
  const values: Partial<PresetMaterialValues> = {};
  for (const key of CAPTURE_KEYS) {
    const value = material[key];
    if (value !== undefined) (values as Record<string, unknown>)[key] = structuredClone(value);
  }
  return values as PresetMaterialValues;
}

/** 卡片缩略的明/暗派生色;非法输入返回基色自身。 */
export function shadeHexColor(hex: string, amount: number): string {
  if (!HEX.test(hex)) return hex;
  const channel = (offset: number) => Math.max(0, Math.min(255, parseInt(hex.slice(offset, offset + 2), 16) + Math.round(255 * amount)));
  return `#${[1, 3, 5].map(offset => channel(offset).toString(16).padStart(2, "0")).join("")}`;
}
