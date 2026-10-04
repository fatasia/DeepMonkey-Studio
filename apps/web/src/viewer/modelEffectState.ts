import type { SceneFireEffectState, SceneModelEffectsState, SceneVfxEffectState, SceneVfxTemplateId } from "@bim-studio/contracts";
import { VFX_MAX_PARTICLES_RANGE, sanitizeVfxCurves } from "./modelVfxParticles";
import { FIRE_MAX_PARTICLES_RANGE, sanitizeFireCurves } from "./modelFireParticles";
import { VFX_TEMPLATE_MAP, isVfxTemplateId } from "./vfxTemplates";

export const DEFAULT_FIRE_EFFECT: SceneFireEffectState = {
  enabled: false,
  color: "#ff6a22",
  intensity: 1.6,
  height: 2,
  density: 1,
};

type FireEffectPatch = Partial<SceneFireEffectState>;
/** exactOptionalPropertyTypes 下允许显式 undefined 的 VFX patch(用于恢复模板默认/移除单曲线)。 */
export type VfxEffectPatch = { [K in keyof SceneVfxEffectState]?: SceneVfxEffectState[K] | undefined };
export type ModelEffectsPatch = Omit<Partial<SceneModelEffectsState>, "fire" | "vfx"> & {
  fire?: FireEffectPatch;
  /** 显式 undefined = 卸载 VFX 图层。 */
  vfx?: VfxEffectPatch | undefined;
};

export function normalizeFireEffect(value: FireEffectPatch | undefined): SceneFireEffectState {
  const color = value?.color;
  const curves = sanitizeFireCurves(value?.curves);
  return {
    enabled: value?.enabled === true,
    color: isHexColor(color) ? color : DEFAULT_FIRE_EFFECT.color,
    intensity: clamp(value?.intensity, 0, 5, DEFAULT_FIRE_EFFECT.intensity),
    height: clamp(value?.height, 0.1, 50, DEFAULT_FIRE_EFFECT.height),
    density: clamp(value?.density, 0.25, 2, DEFAULT_FIRE_EFFECT.density),
    ...(curves ? { curves } : {}),
    ...(value?.blend === "alpha" || value?.blend === "additive" ? { blend: value.blend } : {}),
    ...(typeof value?.maxParticles === "number" && Number.isFinite(value.maxParticles)
      ? { maxParticles: Math.round(clamp(value.maxParticles, 16, FIRE_MAX_PARTICLES_RANGE.max, FIRE_MAX_PARTICLES_RANGE.max)) }
      : {}),
  };
}

export const DEFAULT_VFX_INTENSITY = 1.2;
export const DEFAULT_VFX_RATE = 1;
export const DEFAULT_VFX_RANGE = 2.5;
export const DEFAULT_VFX_LIFETIME = 2.4;

/** 归一化 VFX 图层状态；模板非法时回退排气蒸汽，参数越界钳制到合同值域。 */
export function normalizeVfxEffect(value: VfxEffectPatch | undefined): SceneVfxEffectState {
  const template: SceneVfxTemplateId = isVfxTemplateId(value?.template) ? value.template : "exhaust-steam";
  const color = value?.color;
  const curves = sanitizeVfxCurves(value?.curves);
  return {
    template,
    enabled: value?.enabled === true,
    color: isHexColor(color) ? color : "#cfd8dc",
    intensity: clamp(value?.intensity, 0, 5, DEFAULT_VFX_INTENSITY),
    rate: clamp(value?.rate, 0.25, 2, DEFAULT_VFX_RATE),
    range: clamp(value?.range, 0.1, 50, DEFAULT_VFX_RANGE),
    lifetime: clamp(value?.lifetime, 0.2, 8, DEFAULT_VFX_LIFETIME),
    ...(curves ? { curves } : {}),
    ...(value?.blend === "alpha" || value?.blend === "additive" ? { blend: value.blend } : {}),
    ...(typeof value?.maxParticles === "number" && Number.isFinite(value.maxParticles)
      ? { maxParticles: Math.round(clamp(value.maxParticles, 16, VFX_MAX_PARTICLES_RANGE.max, VFX_MAX_PARTICLES_RANGE.max)) }
      : {}),
  };
}

/**
 * 数据绑定和脚本常只更新火焰/VFX 的显隐或强度，嵌套合并可避免其余作者参数丢失。
 * fire 与 vfx 互不覆盖：patch 只出现其一时，另一图层的作者参数保持不变。
 * VFX 首次出现（对象尚无该图层，如行为直接触发告警环）以模板默认参数为基线；
 * 显式 `vfx: undefined` 表示卸载 VFX 图层（键存在但值为空 ≠ 未提及）。
 */
export function mergeModelEffectsPatch(
  current: SceneModelEffectsState,
  patch: ModelEffectsPatch,
): SceneModelEffectsState {
  const { fire, vfx, ...flatPatch } = patch;
  const next: SceneModelEffectsState = {
    ...current,
    ...flatPatch,
    ...(fire ? { fire: { ...(current.fire ?? DEFAULT_FIRE_EFFECT), ...fire } } : {}),
  };
  if ("vfx" in patch) {
    if (vfx) next.vfx = mergeVfxState(current.vfx, vfx);
    else delete next.vfx;
  }
  return next;
}

function mergeVfxState(current: SceneVfxEffectState | undefined, patch: VfxEffectPatch): SceneVfxEffectState {
  const base = current ?? VFX_TEMPLATE_MAP[vfxTemplateId(patch)].defaults;
  // exactOptionalPropertyTypes:显式 undefined 的键不是作者意图,跳过而不是覆盖成 undefined。
  const next: SceneVfxEffectState = { ...base };
  const writable = next as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) writable[key] = value;
  }
  return next;
}

function vfxTemplateId(patch: VfxEffectPatch): SceneVfxTemplateId {
  return isVfxTemplateId(patch.template) ? patch.template : "exhaust-steam";
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}
