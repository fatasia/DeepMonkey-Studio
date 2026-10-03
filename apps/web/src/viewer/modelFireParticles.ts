import {
  bakeParticleCurveLut, createParticleCurve, planParticleBudget, type ParticleCurve,
} from "@bim-studio/deep-engine/particles";
import type { SceneFireBlend, SceneFireCurveKey, SceneFireCurves, SceneFireEffectState } from "@bim-studio/contracts";

/** 火焰粒子的曲线与预算：全部走 deep-engine 的曲线求值/预算计划，编辑器只做接线。 */

export const FIRE_BASE_PARTICLES = 80;
export const FIRE_DEFAULT_MAX_PARTICLES = 160;
export const FIRE_MAX_PARTICLES_RANGE = { min: 16, max: 160 } as const;
/** 场景内所有火焰发射器共享的粒子上限；超出按请求量比例降级。 */
export const SCENE_FIRE_PARTICLE_BUDGET = 1024;
export const FIRE_CURVE_MAX_KEYS = 16;
export const FIRE_CURVE_LUT_RESOLUTION = 64;

export type FireCurveChannel = "size" | "alpha" | "color";

export const FIRE_CURVE_RANGE: Readonly<Record<FireCurveChannel, number>> = { size: 4, alpha: 1, color: 1 };

/** 火焰默认曲线：快速淡入、中段峰值、尾部消散；热度由高光降到余烬。 */
export const DEFAULT_FIRE_CURVES: Readonly<Record<FireCurveChannel, readonly SceneFireCurveKey[]>> = {
  size: [{ time: 0, value: 0.55 }, { time: 0.3, value: 1 }, { time: 1, value: 0.35 }],
  alpha: [{ time: 0, value: 0 }, { time: 0.1, value: 1 }, { time: 0.65, value: 0.8 }, { time: 1, value: 0 }],
  color: [{ time: 0, value: 1 }, { time: 0.45, value: 0.5 }, { time: 1, value: 0.08 }],
};

/** 曲线预设（Shuriken 常用形状），UI 与脚本共用。 */
export const FIRE_CURVE_PRESETS: Readonly<Record<string, readonly SceneFireCurveKey[]>> = {
  constant: [{ time: 0, value: 1 }, { time: 1, value: 1 }],
  fadeOut: [{ time: 0, value: 1 }, { time: 1, value: 0 }],
  fadeIn: [{ time: 0, value: 0 }, { time: 1, value: 1 }],
  peak: [{ time: 0, value: 0 }, { time: 0.5, value: 1 }, { time: 1, value: 0 }],
};

export interface ResolvedFireCurves {
  readonly size: Float32Array;
  readonly alpha: Float32Array;
  readonly color: Float32Array;
  /** size 曲线的 LUT 均值，WebGPU 无逐粒子尺寸时作为全局尺寸倍率。 */
  readonly sizeMean: number;
}

/** 清洗关键帧：丢弃非有限项，按时间排序去重，钳制到值域，最多 16 键；清洗后为空返回 undefined。 */
export function sanitizeFireCurve(keys: readonly SceneFireCurveKey[] | undefined, channel: FireCurveChannel): SceneFireCurveKey[] | undefined {
  if (!Array.isArray(keys)) return undefined;
  const maximum = FIRE_CURVE_RANGE[channel];
  const cleaned = keys
    .filter((key) => key && Number.isFinite(key.time) && Number.isFinite(key.value))
    .map((key) => ({ time: clamp(key.time, 0, 1), value: clamp(key.value, 0, maximum) }))
    .sort((a, b) => a.time - b.time);
  const unique: SceneFireCurveKey[] = [];
  for (const key of cleaned) {
    if (unique.length && unique[unique.length - 1]!.time === key.time) unique[unique.length - 1] = key;
    else unique.push(key);
  }
  return unique.length ? unique.slice(0, FIRE_CURVE_MAX_KEYS) : undefined;
}

export function sanitizeFireCurves(curves: SceneFireCurves | undefined): SceneFireCurves | undefined {
  if (!curves || typeof curves !== "object") return undefined;
  const result: SceneFireCurves = {};
  for (const channel of ["size", "alpha", "color"] as const) {
    const keys = sanitizeFireCurve(curves[channel], channel);
    if (keys) result[channel] = keys;
  }
  return Object.keys(result).length ? result : undefined;
}

function bake(keys: readonly SceneFireCurveKey[], fallback: readonly SceneFireCurveKey[], name: string): Float32Array {
  const build = (frames: readonly SceneFireCurveKey[]): ParticleCurve => createParticleCurve(frames, name);
  try {
    return bakeParticleCurveLut(build(keys), FIRE_CURVE_LUT_RESOLUTION);
  } catch {
    return bakeParticleCurveLut(build(fallback), FIRE_CURVE_LUT_RESOLUTION);
  }
}

/** 解析并烘焙三条曲线；缺省通道使用火焰默认曲线，非法输入回退默认而不是抛错。 */
export function resolveFireCurves(curves: SceneFireCurves | undefined): ResolvedFireCurves {
  const size = bake(curves?.size ?? DEFAULT_FIRE_CURVES.size, DEFAULT_FIRE_CURVES.size, "fire.size");
  const alpha = bake(curves?.alpha ?? DEFAULT_FIRE_CURVES.alpha, DEFAULT_FIRE_CURVES.alpha, "fire.alpha");
  const color = bake(curves?.color ?? DEFAULT_FIRE_CURVES.color, DEFAULT_FIRE_CURVES.color, "fire.color");
  let total = 0;
  for (const value of size) total += value;
  return { size, alpha, color, sizeMean: total / size.length };
}

export function fireBlendMode(state: Pick<SceneFireEffectState, "blend">): SceneFireBlend {
  return state.blend === "alpha" ? "alpha" : "additive";
}

/** 单发射器申请粒子数 = min(80×密度, 作者上限)，至少 1。 */
export function fireRequestedParticles(state: Pick<SceneFireEffectState, "density" | "maxParticles">): number {
  const natural = Math.round(FIRE_BASE_PARTICLES * state.density);
  const cap = state.maxParticles ?? FIRE_DEFAULT_MAX_PARTICLES;
  return Math.max(1, Math.min(natural, cap));
}

export interface FireBudgetEmitter {
  readonly id: string;
  readonly requested: number;
  readonly allocated: number;
  readonly degraded: boolean;
}

export interface FireBudgetReport {
  readonly sceneBudget: number;
  readonly requestedTotal: number;
  readonly allocatedTotal: number;
  readonly emitters: readonly FireBudgetEmitter[];
  readonly degraded: boolean;
  /** 实际分配占申请的比例（1 = 无降级）。 */
  readonly ratio: number;
  /** 引擎预算计划产生的量化降级原因（仅在真实降级时非空）。 */
  readonly reasons: readonly string[];
}

const MAX_PLANNED_EMITTERS = 64;

/**
 * 场景级预算：交给 deep-engine `planParticleBudget`（最大余数法）分配；
 * 引擎限 64 个发射器，超出的按 id 序靠后者分配 0（降级而非抛错）。
 */
export function planSceneFireBudget(
  requests: readonly { readonly id: string; readonly requested: number }[],
  sceneBudget: number = SCENE_FIRE_PARTICLE_BUDGET,
): FireBudgetReport {
  const sorted = [...requests].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const planned = sorted.slice(0, MAX_PLANNED_EMITTERS);
  const requestedTotal = sorted.reduce((sum, item) => sum + item.requested, 0);
  if (!planned.length) {
    return { sceneBudget, requestedTotal: 0, allocatedTotal: 0, emitters: [], degraded: false, ratio: 1, reasons: [] };
  }
  const plan = planParticleBudget(
    planned.map((item, index) => ({ id: `e${index}`, count: item.requested })),
    { capacityLimit: sceneBudget },
  );
  const emitters: FireBudgetEmitter[] = sorted.map((item, index) => {
    const allocated = index < planned.length ? plan.allocations[index]!.allocated : 0;
    return { id: item.id, requested: item.requested, allocated, degraded: allocated < item.requested };
  });
  const allocatedTotal = emitters.reduce((sum, item) => sum + item.allocated, 0);
  const degraded = allocatedTotal < requestedTotal;
  return {
    sceneBudget, requestedTotal, allocatedTotal, emitters, degraded,
    ratio: requestedTotal > 0 ? allocatedTotal / requestedTotal : 1,
    // 引擎在 2 的幂容量被限幅但并无实际丢弃时也会给出 capacity 原因；只有真实降级才对外暴露。
    reasons: degraded ? plan.degradation.reasons : [],
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
