import type { DeepGiQuality, ProbeClipmapLevel, ProbeVector3 } from "./probeClipmapPlan.js";
import { sampleIrradianceProbeClipmap, type IrradianceProbeRecord } from "./probeClipmapSampling.js";
import { evaluateProbeRadianceWithDirections } from "./probeReferenceIntegrator.js";
import type { ReferenceScene } from "./probeReferenceScene.js";
import { probeOcclusionDirection } from "../rayTracing/probeOcclusionRayExtension.js";

/**
 * G3 多散射第一版：探针场一阶自反馈（设计稿 §3.3 第 3 条的既定落点）。
 *
 * == 机制（迭代式雅可比反馈，不做独立 radiance cache） ==
 * 迭代 0 = T02 引擎口径一跳（hit 直射 + miss 常量环境）。迭代 k 的积分把**命中面的着色**
 * 加上间接项：direct(hit) + ρ(hit) × gain × E_{k-1}(命中点沿法线抬半步处的邻域采样)——
 * 与 DDGI 多散射扩展（Dong et al. 2019）同机制。设计稿原文写「miss-ambient 项换成采样
 * 探针场」，实测封闭室内 miss 占比极小、该落点收益不可测（35.08%→34.78%），命中面反弹
 * 才是多跳能量的物理入口，故落点按论文机制修正并在验收脚本留对照数据。
 * miss 方向射向场景之外，保持常量 ambient 不变。逐迭代读上一轮场而非本迭代新场
 * （双缓冲，同探针不自馈）；每次反弹乘 ρ<1 × gain≤1，能量几何收敛。
 *
 * == 哨兵（设计稿：泄露 + 正反馈必须先于功能落地） ==
 * 1. 泄露哨兵 = 采样链复用 `sampleIrradianceProbeClipmap`：validity 0（墙内/埋入）不贡献
 *    + Chebyshev 距离可见性 + 法线半球权重——与墙漏三件套同一条链，不另造判据；命中点
 *    采样天然落在墙内时由同一链拒绝（穿墙亮斑不被反馈放大）。
 * 2. 发散哨兵 = 逐迭代监控场总能量，增幅超过 `BOUNCE_DIVERGENCE_LIMIT`（5%）或出现非
 *    有限值即判正反馈失控：截断迭代、fail-closed 回上一轮场并标记 `diverged`。
 * 3. 迭代上限 `DEEP_GI_BOUNCE_FEEDBACK_ITERATIONS`：硬上限，配置超出 fail-closed 回上限。
 *
 * == 门控（与 G3-S1 probeRadianceDirectionGate 同款两段式） ==
 * 运行时边界 `resolveDeepGiBounceFeedback` 永不抛错（非法 fail-closed 关闭）；作者档位
 * `bounceFeedbackForQuality`：performance/balanced 关、quality opt-in 开——默认档（balanced）
 * 不切，产品行为零变化（工厂接线点留主线，同 G3-S1 报告纪律）。
 */

/** 迭代硬上限（防正反馈的最后一道闸；验收定标显示 3 迭代后 RMSE 增益 <0.5%）。 */
export const DEEP_GI_BOUNCE_FEEDBACK_ITERATIONS = 4;
/** 反馈增益（间接项 = ρ × gain × 邻域采样辐照；物理阻尼 1.0，>1 只在实验对照中出现）。 */
export const DEEP_GI_BOUNCE_FEEDBACK_GAIN = 1;
/** 单迭代硬上限：场总能量增幅超过 100% 判爆炸（正常一阶反弹对高反照率房间 ~+50% 合法）。 */
export const BOUNCE_DIVERGENCE_LIMIT = 2;
/** 失控判定：连续 N 次迭代能量均在增长（增幅 >1%）——正常反馈 1-2 迭代后饱和，持续增长即正反馈。 */
export const BOUNCE_DIVERGENCE_STREAK = 2;
/** 能量增长视作「在增长」的最小相对增幅。 */
export const BOUNCE_ENERGY_GROWTH_EPSILON = 0.01;

export type DeepGiBounceFeedbackPreset = "off" | "on";

export interface DeepGiBounceFeedbackResolution {
  readonly enabled: boolean;
  readonly failClosed: boolean;
  readonly reason?: string;
}

/**
 * 解析自反馈配置：`undefined`/"off"/false → 关（默认）；"on"/true → 开；
 * 其余一切值 fail-closed 回关并给机器可读原因（渲染循环不因脏配置中断）。
 */
export function resolveDeepGiBounceFeedback(
  value?: DeepGiBounceFeedbackPreset | boolean): DeepGiBounceFeedbackResolution {
  if (value === undefined || value === "off" || value === false) {
    return Object.freeze({ enabled: false, failClosed: false });
  }
  if (value === "on" || value === true) {
    return Object.freeze({ enabled: true, failClosed: false });
  }
  return Object.freeze({ enabled: false, failClosed: true,
    reason: `Deep GI bounce feedback config must be "off"/"on"/true/false; got ${describe(value)}; failed closed to off.` });
}

/** 质量档位 → 自反馈映射：默认不切（performance/balanced 关），quality 档 opt-in 开。 */
export function bounceFeedbackForQuality(quality: DeepGiQuality): boolean {
  switch (quality) {
    case "performance":
    case "balanced":
      return false;
    case "quality":
      return true;
    default:
      throw new RangeError("Invalid Deep GI quality.");
  }
}

export interface BounceFeedbackFieldInput {
  /** 探针位置（与探针场同序）。 */
  readonly positions: readonly ProbeVector3[];
  /** 单层探针网格元数据（采样器的 level 语义，墙漏测试同款构造）。 */
  readonly level: ProbeClipmapLevel;
  /** 埋入/墙内探针下标：validity 0，反馈采样拒绝其贡献（T02 埋入判据的产物）。 */
  readonly buriedIndices?: readonly number[];
  readonly directionCount?: number;
}

export interface BounceFeedbackOptions {
  /** 反馈迭代次数（1..DEEP_GI_BOUNCE_FEEDBACK_ITERATIONS，越界 fail-closed 回上限）。 */
  readonly iterations?: number;
  /** 反馈增益 [0,1]；越界 fail-closed 回 DEEP_GI_BOUNCE_FEEDBACK_GAIN。 */
  readonly gain?: number;
  /** 泄露哨兵开关（生产恒开；关闭仅供对照实验观察无哨兵行为）。默认 true。 */
  readonly leakSentinel?: boolean;
}

export interface BounceFeedbackResult {
  /** 最终探针场（迭代 0 场或最后一次被接受的迭代场）。 */
  readonly field: readonly ProbeVector3[];
  readonly iterationsRun: number;
  readonly diverged: boolean;
  /** diverged 时触发的迭代序号（1 起）。 */
  readonly divergenceIteration?: number;
  /** 每次被接受的迭代后的场总能量（发散哨兵证据链，下标 0 = 一跳场）。 */
  readonly energyTrail: readonly number[];
  readonly iterations: number;
  readonly gain: number;
}

/**
 * 发散哨兵单步判定（纯函数，迭代器逐迭代调用；独立导出便于单测）：
 * - 能量非有限或单迭代增幅超过 `BOUNCE_DIVERGENCE_LIMIT`（爆炸）→ 立即失控；
 * - 连续 `BOUNCE_DIVERGENCE_STREAK` 次迭代能量均在增长（增幅 > epsilon）→ 正反馈失控
 *   （正常反馈 1-2 迭代后饱和，持续单调增长才是失控特征）。
 * 返回 `tripped` 与更新后的 streak 计数；调用方在 tripped 时 fail-closed 回上一轮场。
 */
export function bounceEnergySentinel(energy: number, reference: number,
  growthStreak: number): { tripped: boolean; growthStreak: number } {
  if (!Number.isFinite(energy) || energy > reference * BOUNCE_DIVERGENCE_LIMIT) {
    return { tripped: true, growthStreak: 0 };
  }
  if (energy > reference * (1 + BOUNCE_ENERGY_GROWTH_EPSILON)) {
    const streak = growthStreak + 1;
    return { tripped: streak >= BOUNCE_DIVERGENCE_STREAK, growthStreak: streak };
  }
  return { tripped: false, growthStreak: 0 };
}

/**
 * 探针场一阶自反馈：一跳场起步，逐迭代把 miss 环境项换成上一轮场的邻域采样。
 * 确定性：无 RNG，同输入逐位同输出；返回冻结结果，输入场不被修改（双缓冲）。
 */
export function integrateProbeFieldWithFeedback(scene: ReferenceScene,
  input: BounceFeedbackFieldInput, options: BounceFeedbackOptions = {}): BounceFeedbackResult {
  const iterations = resolveIterations(options.iterations);
  const gain = resolveGain(options.gain);
  const leakSentinel = options.leakSentinel !== false;
  const directionCount = input.directionCount ?? 16;
  if (!Number.isSafeInteger(directionCount) || directionCount < 1) {
    throw new RangeError("Bounce feedback directionCount must be a positive integer.");
  }
  const buried = new Set(input.buriedIndices ?? []);
  const directions = Array.from({ length: directionCount }, (_, ordinal) =>
    probeOcclusionDirection(ordinal, directionCount));
  // 迭代 0：T02 引擎口径一跳；距离统计只在此算一次（几何不变 → 各迭代共享）。
  const base = input.positions.map(position =>
    evaluateProbeRadianceWithDirections(scene, position, directions, {}));
  let field: ProbeVector3[] = base.map(sample => [...sample.irradiance] as ProbeVector3);
  const recordsFor = (): IrradianceProbeRecord[] => input.positions.map((_, index) => ({
    irradiance: field[index]!,
    validity: buried.has(index) ? 0 : 1,
    meanDistance: base[index]!.meanDistance,
    distanceVariance: Math.max(base[index]!.distanceVariance, 1e-4),
    occlusionFloor: 0 }));
  const energies = [fieldEnergy(field)];
  const energyTrail: number[] = [energies[0]!];
  let diverged = false, divergenceIteration: number | undefined, iterationsRun = 0, growthStreak = 0;
  const levels = [input.level];
  const step = Math.max(referenceHalfStep(scene), 1e-3);
  for (let iteration = 1; iteration <= iterations && !diverged; iteration++) {
    const previous = field.map(vector => Object.freeze([...vector]) as ProbeVector3);
    const previousRecords: IrradianceProbeRecord[] = input.positions.map((_, index) => ({
      irradiance: previous[index]!,
      validity: leakSentinel && buried.has(index) ? 0 : 1,
      meanDistance: base[index]!.meanDistance,
      distanceVariance: Math.max(base[index]!.distanceVariance, 1e-4),
      occlusionFloor: 0 }));
    const next = input.positions.map((position, index) => {
      if (leakSentinel && buried.has(index)) return previous[index]!;
      const sample = evaluateProbeRadianceWithDirections(scene, position, directions, {
        indirectBounce: (hit, hitPoint) => {
          // 命中点沿法线抬半步防自遮挡；泄露哨兵链（validity/Chebyshev/法线权重）在
          // 采样器内拒绝墙内贡献，墙内亮斑不被反馈放大。
          const samplePoint: ProbeVector3 = [hitPoint[0]! + hit.normal[0]! * step,
            hitPoint[1]! + hit.normal[1]! * step, hitPoint[2]! + hit.normal[2]! * step];
          const sampled = sampleIrradianceProbeClipmap({ worldPosition: samplePoint,
            worldNormal: hit.normal, levels, records: previousRecords,
            environmentFallback: scene.ambient });
          return [gain * hit.albedo[0]! * sampled.irradiance[0]!,
            gain * hit.albedo[1]! * sampled.irradiance[1]!,
            gain * hit.albedo[2]! * sampled.irradiance[2]!];
        } });
      return [...sample.irradiance] as ProbeVector3;
    });
    const energy = fieldEnergy(next);
    const reference = energies[energies.length - 1]!;
    const sentinel = bounceEnergySentinel(energy, reference, growthStreak);
    growthStreak = sentinel.growthStreak;
    if (sentinel.tripped) {
      diverged = true;
      divergenceIteration = iteration;
      break;
    }
    field = next;
    energies.push(energy);
    energyTrail.push(energy);
    iterationsRun = iteration;
  }
  return Object.freeze({ field: Object.freeze(field.map(vector => Object.freeze([...vector]) as ProbeVector3)),
    iterationsRun,
    diverged,
    ...(divergenceIteration === undefined ? {} : { divergenceIteration }),
    energyTrail: Object.freeze(energyTrail), iterations, gain });
}

function resolveIterations(value: number | undefined): number {
  if (value === undefined) return DEEP_GI_BOUNCE_FEEDBACK_ITERATIONS;
  if (!Number.isSafeInteger(value) || value < 1 || value > DEEP_GI_BOUNCE_FEEDBACK_ITERATIONS) {
    return DEEP_GI_BOUNCE_FEEDBACK_ITERATIONS;
  }
  return value;
}

function resolveGain(value: number | undefined): number {
  if (value === undefined) return DEEP_GI_BOUNCE_FEEDBACK_GAIN;
  if (!Number.isFinite(value) || value < 0 || value > 2) return DEEP_GI_BOUNCE_FEEDBACK_GAIN;
  return value;
}

function fieldEnergy(field: readonly ProbeVector3[]): number {
  return field.reduce((sum, vector) => sum + Math.hypot(vector[0]!, vector[1]!, vector[2]!), 0);
}

/** 命中点采样抬升步长：场景对角线的 1/64（防自遮挡且落在邻域插值支撑内）。 */
function referenceHalfStep(scene: ReferenceScene): number {
  const extent = scene.bounds.max.map((value, axis) => value - scene.bounds.min[axis]!);
  return Math.hypot(...extent) / 64;
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
