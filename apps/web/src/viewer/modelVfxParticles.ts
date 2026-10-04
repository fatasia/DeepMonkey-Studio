import {
  bakeParticleCurveLut, createParticleCurve, planParticleBudget, type ParticleCurve,
} from "@bim-studio/deep-engine/particles";
import type { SceneFireCurveKey, SceneFireCurves, SceneVfxEffectState, SceneVfxTemplateId } from "@bim-studio/contracts";
import { VFX_TEMPLATE_MAP } from "./vfxTemplates";

/** VFX 图层的曲线、发射量与预算：全部走 deep-engine 的曲线求值/预算计划，编辑器只做接线。 */

export const VFX_BASE_PARTICLES = 80;
export const VFX_DEFAULT_MAX_PARTICLES = 128;
export const VFX_MAX_PARTICLES_RANGE = { min: 16, max: 512 } as const;
/** 场景内所有 VFX 发射器共享的粒子上限（与火焰图层各自独立预算池）；超出按请求量比例降级。 */
export const SCENE_VFX_PARTICLE_BUDGET = 1024;
export const VFX_CURVE_LUT_RESOLUTION = 64;

export type VfxCurveChannel = "size" | "alpha" | "color";

export const VFX_CURVE_RANGE: Readonly<Record<VfxCurveChannel, number>> = { size: 4, alpha: 1, color: 1 };

const VFX_CURVE_MAX_KEYS = 16;

/** 清洗关键帧：丢弃非有限项，按时间排序去重，钳制到值域，最多 16 键；清洗后为空返回 undefined。 */
export function sanitizeVfxCurve(keys: readonly SceneFireCurveKey[] | undefined, channel: VfxCurveChannel): SceneFireCurveKey[] | undefined {
  if (!Array.isArray(keys)) return undefined;
  const maximum = VFX_CURVE_RANGE[channel];
  const cleaned = keys
    .filter((key) => key && Number.isFinite(key.time) && Number.isFinite(key.value))
    .map((key) => ({ time: clamp(key.time, 0, 1), value: clamp(key.value, 0, maximum) }))
    .sort((a, b) => a.time - b.time);
  const unique: SceneFireCurveKey[] = [];
  for (const key of cleaned) {
    if (unique.length && unique[unique.length - 1]!.time === key.time) unique[unique.length - 1] = key;
    else unique.push(key);
  }
  return unique.length ? unique.slice(0, VFX_CURVE_MAX_KEYS) : undefined;
}

export function sanitizeVfxCurves(curves: SceneFireCurves | undefined): SceneFireCurves | undefined {
  if (!curves || typeof curves !== "object") return undefined;
  const result: SceneFireCurves = {};
  for (const channel of ["size", "alpha", "color"] as const) {
    const keys = sanitizeVfxCurve(curves[channel], channel);
    if (keys) result[channel] = keys;
  }
  return Object.keys(result).length ? result : undefined;
}

export interface ResolvedVfxCurves {
  readonly size: Float32Array;
  readonly alpha: Float32Array;
  readonly color: Float32Array;
  /** size 曲线的 LUT 均值，WebGPU 无逐粒子尺寸时作为全局尺寸倍率。 */
  readonly sizeMean: number;
}

function nonEmpty(keys: readonly SceneFireCurveKey[] | undefined): readonly SceneFireCurveKey[] | undefined {
  return keys && keys.length ? keys : undefined;
}

function bake(keys: readonly SceneFireCurveKey[] | undefined, fallback: readonly SceneFireCurveKey[] | undefined, name: string): Float32Array {
  const frames = nonEmpty(keys) ?? nonEmpty(fallback) ?? [{ time: 0, value: 1 }, { time: 1, value: 1 }];
  const build = (list: readonly SceneFireCurveKey[]): ParticleCurve => createParticleCurve(list, name);
  try {
    return bakeParticleCurveLut(build(frames), VFX_CURVE_LUT_RESOLUTION);
  } catch {
    return bakeParticleCurveLut(build([{ time: 0, value: 1 }, { time: 1, value: 1 }]), VFX_CURVE_LUT_RESOLUTION);
  }
}

/** 解析并烘焙三条曲线；缺省通道使用模板默认曲线，非法输入回退模板默认而不是抛错。 */
export function resolveVfxCurves(state: Pick<SceneVfxEffectState, "template" | "curves">): ResolvedVfxCurves {
  const fallback = VFX_TEMPLATE_MAP[state.template]?.defaults.curves;
  const size = bake(state.curves?.size, fallback?.size, "vfx.size");
  const alpha = bake(state.curves?.alpha, fallback?.alpha, "vfx.alpha");
  const color = bake(state.curves?.color, fallback?.color, "vfx.color");
  let total = 0;
  for (const value of size) total += value;
  return { size, alpha, color, sizeMean: total / size.length };
}

/** 曲线通道是否为作者自定义（UI 的"默认"按钮状态）。 */
export function vfxCurveCustom(
  state: Pick<SceneVfxEffectState, "template" | "curves">, channel: VfxCurveChannel,
): boolean {
  return Boolean(state.curves?.[channel]);
}

/** 写回单条曲线；undefined 表示恢复模板默认（整字段消失时移除 curves 容器）。 */
export function withVfxCurve(
  state: Pick<SceneVfxEffectState, "template" | "curves">,
  channel: VfxCurveChannel,
  keys: SceneFireCurveKey[] | undefined,
): SceneFireCurves | undefined {
  const { [channel]: _removed, ...rest } = state.curves ?? {};
  const curves = keys ? { ...rest, [channel]: keys } : rest;
  return Object.keys(curves).length ? curves : undefined;
}

/** 单发射器申请粒子数 = min(80×速率, 作者上限)，至少 1。 */
export function vfxRequestedParticles(state: Pick<SceneVfxEffectState, "rate" | "maxParticles">): number {
  const natural = Math.round(VFX_BASE_PARTICLES * state.rate);
  const cap = state.maxParticles ?? VFX_DEFAULT_MAX_PARTICLES;
  return Math.max(1, Math.min(natural, cap));
}

export interface VfxBudgetEmitter {
  readonly id: string;
  readonly requested: number;
  readonly allocated: number;
  readonly degraded: boolean;
}

export interface VfxBudgetReport {
  readonly sceneBudget: number;
  readonly requestedTotal: number;
  readonly allocatedTotal: number;
  readonly emitters: readonly VfxBudgetEmitter[];
  readonly degraded: boolean;
  /** 实际分配占申请的比例（1 = 无降级）。 */
  readonly ratio: number;
  /** 引擎预算计划产生的量化降级原因（仅在真实降级时非空）。 */
  readonly reasons: readonly string[];
}

const MAX_PLANNED_EMITTERS = 64;

/**
 * VFX 场景预算：交给 deep-engine `planParticleBudget`（最大余数法）分配；
 * 引擎限 64 个发射器，超出的按 id 序靠后者分配 0（降级而非抛错）。
 * 与火焰层同构，但使用独立的 SCENE_VFX_PARTICLE_BUDGET 预算池。
 */
export function planSceneVfxBudget(
  requests: readonly { readonly id: string; readonly requested: number }[],
  sceneBudget: number = SCENE_VFX_PARTICLE_BUDGET,
): VfxBudgetReport {
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
  const emitters: VfxBudgetEmitter[] = sorted.map((item, index) => {
    const allocated = index < planned.length ? plan.allocations[index]!.allocated : 0;
    return { id: item.id, requested: item.requested, allocated, degraded: allocated < item.requested };
  });
  const allocatedTotal = emitters.reduce((sum, item) => sum + item.allocated, 0);
  const degraded = allocatedTotal < requestedTotal;
  return {
    sceneBudget, requestedTotal, allocatedTotal, emitters, degraded,
    ratio: requestedTotal > 0 ? allocatedTotal / requestedTotal : 1,
    reasons: degraded ? plan.degradation.reasons : [],
  };
}

/** 模板缺省混合模式；未列出的模板默认叠加。 */
export function vfxBlendMode(state: Pick<SceneVfxEffectState, "template" | "blend">): "additive" | "alpha" {
  if (state.blend === "additive" || state.blend === "alpha") return state.blend;
  return VFX_TEMPLATE_MAP[state.template]?.defaults.blend === "alpha" ? "alpha" : "additive";
}

/** 供面板显示的模板安全查找：非法 id 回退排气蒸汽并保持数据原样。 */
export function vfxTemplateOf(template: SceneVfxTemplateId) {
  return VFX_TEMPLATE_MAP[template] ?? VFX_TEMPLATE_MAP["exhaust-steam"]!;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
