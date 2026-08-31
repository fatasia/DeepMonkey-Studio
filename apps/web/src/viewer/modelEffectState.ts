import type { SceneFireEffectState, SceneModelEffectsState } from "@bim-studio/contracts";

export const DEFAULT_FIRE_EFFECT: SceneFireEffectState = {
  enabled: false,
  color: "#ff6a22",
  intensity: 1.6,
  height: 2,
  density: 1,
};

type FireEffectPatch = Partial<SceneFireEffectState>;
export type ModelEffectsPatch = Omit<Partial<SceneModelEffectsState>, "fire"> & { fire?: FireEffectPatch };

export function normalizeFireEffect(value: FireEffectPatch | undefined): SceneFireEffectState {
  const color = value?.color;
  return {
    enabled: value?.enabled === true,
    color: isHexColor(color) ? color : DEFAULT_FIRE_EFFECT.color,
    intensity: clamp(value?.intensity, 0, 5, DEFAULT_FIRE_EFFECT.intensity),
    height: clamp(value?.height, 0.1, 50, DEFAULT_FIRE_EFFECT.height),
    density: clamp(value?.density, 0.25, 2, DEFAULT_FIRE_EFFECT.density),
  };
}

/** 数据绑定和脚本常只更新火焰显隐或强度，嵌套合并可避免其余作者参数丢失。 */
export function mergeModelEffectsPatch(
  current: SceneModelEffectsState,
  patch: ModelEffectsPatch,
): SceneModelEffectsState {
  const { fire, ...flatPatch } = patch;
  return {
    ...current,
    ...flatPatch,
    ...(fire ? { fire: { ...(current.fire ?? DEFAULT_FIRE_EFFECT), ...fire } } : {}),
  };
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}
