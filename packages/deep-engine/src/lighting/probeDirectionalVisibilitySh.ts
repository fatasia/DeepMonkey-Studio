import type { ProbeVector3 } from "./probeClipmapPlan.js";
import { GI_SPECULAR_ENVIRONMENT_VISIBILITY_LUMA_EPSILON, type GiRgb } from "./probeSpecularEnvironmentVisibility.js";

/**
 * F5 方向修复方案 A：96B `IrradianceProbeRecord` words[12..23] 启用为 RGB L1 SH 方向
 * 可见度（f32 小端，channel-major：每通道一个 vec4）。
 *
 * == 布局合同（与 probeClipmapSamplingWgsl 的 reserved0/1/2 逐字对位） ==
 * | words   | 内容 |
 * | 12..15  | R 通道 (c_l0, c_l1m-1, c_l1m0, c_l1m1) |
 * | 16..19  | G 通道同序 |
 * | 20..23  | B 通道同序 |
 *
 * == 投影（白炉逐位负控的构造性保证） ==
 * 对探针 32 方向既有射线的每方向贡献 s_i（= 捕获均值 summand：命中 Lambert 一跳或 miss
 * 环境，与 capture `sum` 同值同序）：
 * - `c0[ch] = (Σ_i s_i[ch]) / N`（与捕获均值同式同序，均匀场时与 capture RGB 同源）；
 * - `d_axis[ch] = (3/N) · Σ_i (s_i[ch] − c0[ch]) · dir_i[axis]`（等权最小二乘，
 *   unnormalized 轴基，与 Frame deepDiffuse 64B eval 同族）；
 * - 重建 `recon(dir)[ch] = c0[ch] + d_y·dir.y + d_z·dir.z + d_x·dir.x`。
 * 均匀场：32 个同值浮点求和/除 32 精确无舍入 → `s_i − c0 ≡ 0.0` 精确 → dipoles 精确零 →
 * `recon ≡ c0`，`gate = clamp(c0/c0,0,1) = 1.0` 精确 → `radiance * 1.0 * …` 与无门版本
 * 逐位同（WGSL 同式同序，见 probeRadianceKernel moments 变体与
 * probeClipmapTextureSamplingWgsl.deepGiSpecularDirectionalVisibility）。
 *
 * == 消费 ==
 * `gate = clamp(luma(recon(reflect(-view,n))) / luma(envIrr), 0, 1)`（Rec.709）；
 * 域外/近黑恒 1；12 字全零 = SH 缺失 → fallback 标量门
 * `clamp(luma(probeRgb)/luma(env),0,1)`（f5-variant-semantics 裁定式，批准降级为
 * fallback；暗 albedo vs 遮挡不可辨识的局限如实保留，见
 * docs/specs/f5-directional-l1-implementation-20261003.md §4）。
 */

/** 每通道系数数：l0, l1m-1(·y), l1m0(·z), l1m1(·x)。 */
export const PROBE_VISIBILITY_SH_COEFFICIENTS = 4;
/** record 内占用的 f32 word 数（words[12..23]），96B 记录布局零变更。 */
export const DEEP_GI_PROBE_VISIBILITY_SH_WORDS = 12;
/** record 内块起始 word 下标。 */
export const DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET = 12;
/** 系数编码域（|word| 上限；dipole ≤ 3× 均值，capture 域 ≤65504 → 余量充足）。 */
export const DEEP_GI_PROBE_VISIBILITY_SH_MAX_ABS = 1_000_000;

/** 单通道 L1 系数：(l0, l1m-1, l1m0, l1m1)，重建核 (1, dir.y, dir.z, dir.x)。 */
export type ProbeVisibilityShChannel = readonly [number, number, number, number];
export interface ProbeDirectionalVisibilitySh {
  readonly r: ProbeVisibilityShChannel;
  readonly g: ProbeVisibilityShChannel;
  readonly b: ProbeVisibilityShChannel;
}

const LUMA_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

function luma(value: GiRgb): number {
  return Math.max(value[0], 0) * LUMA_WEIGHTS[0]
    + Math.max(value[1], 0) * LUMA_WEIGHTS[1]
    + Math.max(value[2], 0) * LUMA_WEIGHTS[2];
}

/**
 * 方向贡献 → RGB L1 SH。`samples` 与 `directions` 逐下标对齐（捕获侧同一条 Fibonacci
 * 方向集）。`c0` 与捕获均值同式同序（顺序累加）；dipole 为均值扣除后的等权 LSQ 投影。
 */
export function projectProbeDirectionalVisibilitySh(samples: readonly GiRgb[],
  directions: readonly ProbeVector3[]): ProbeDirectionalVisibilitySh {
  if (samples.length !== directions.length || samples.length === 0) {
    throw new RangeError("Probe visibility SH projection needs one direction per sample.");
  }
  const count = samples.length;
  const mean = [0, 0, 0];
  for (const sample of samples) {
    for (let channel = 0; channel < 3; channel++) {
      const value = sample[channel]!;
      if (!Number.isFinite(value)) throw new RangeError("Probe visibility SH samples must be finite.");
      mean[channel] = mean[channel]! + value;
    }
  }
  for (let channel = 0; channel < 3; channel++) mean[channel] = mean[channel]! / count;
  // dipole 轴序与系数序一致：m-1=·y、m0=·z、m1=·x。
  const sums = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let index = 0; index < count; index++) {
    const direction = directions[index]!, sample = samples[index]!;
    if (direction.length !== 3 || !direction.every(Number.isFinite)) {
      throw new RangeError("Probe visibility SH directions must be finite vec3.");
    }
    for (let channel = 0; channel < 3; channel++) {
      const centered = sample[channel]! - mean[channel]!;
      sums[channel]![0]! += centered * direction[1]!;
      sums[channel]![1]! += centered * direction[2]!;
      sums[channel]![2]! += centered * direction[0]!;
    }
  }
  const channel = (axis: 0 | 1 | 2): ProbeVisibilityShChannel => [
    mean[axis]!, 3 * sums[axis]![0]! / count, 3 * sums[axis]![1]! / count, 3 * sums[axis]![2]! / count];
  return Object.freeze({ r: Object.freeze(channel(0)), g: Object.freeze(channel(1)), b: Object.freeze(channel(2)) });
}

/** SH 重建（deepDiffuse 同族 eval 核 (1, y, z, x)）；通道负值截断为 0。 */
export function evaluateProbeDirectionalVisibilitySh(sh: ProbeDirectionalVisibilitySh,
  direction: ProbeVector3): GiRgb {
  if (direction.length !== 3 || !direction.every(Number.isFinite)) {
    throw new RangeError("Probe visibility SH evaluation needs a finite direction.");
  }
  const axis: ProbeVisibilityShChannel = [1, direction[1]!, direction[2]!, direction[0]!];
  const evalChannel = (c: ProbeVisibilityShChannel): number => {
    let value = 0;
    for (let coefficient = 0; coefficient < PROBE_VISIBILITY_SH_COEFFICIENTS; coefficient++) {
      value += c[coefficient]! * axis[coefficient]!;
    }
    return Math.max(0, value);
  };
  return [evalChannel(sh.r), evalChannel(sh.g), evalChannel(sh.b)];
}

/** 12 字全零 = SH 缺失（探针未以 moments 变体捕获/发布）→ 消费侧走标量 fallback 门。 */
export function isProbeDirectionalVisibilityShMissing(
  sh: ProbeDirectionalVisibilitySh | undefined): boolean {
  if (!sh) return true;
  return [...sh.r, ...sh.g, ...sh.b].every(value => value === 0);
}

/** words[12..23] 解包（record Float32Array 视图）；全零 → undefined（缺失）。 */
export function unpackProbeVisibilityShWords(words: ArrayLike<number>,
  offset = DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET): ProbeDirectionalVisibilitySh | undefined {
  if (words.length < offset + DEEP_GI_PROBE_VISIBILITY_SH_WORDS) {
    throw new RangeError("Probe record too short for visibility SH words.");
  }
  const channel = (base: number): ProbeVisibilityShChannel => [
    words[base]!, words[base + 1]!, words[base + 2]!, words[base + 3]!];
  const sh: ProbeDirectionalVisibilitySh = { r: channel(offset), g: channel(offset + 4), b: channel(offset + 8) };
  return isProbeDirectionalVisibilityShMissing(sh) ? undefined : sh;
}

/** pack 侧系数校验（有限 + 编码域）；`occlusionFloor` 同风格 fail-fast。 */
export function validateProbeVisibilitySh(sh: ProbeDirectionalVisibilitySh | undefined): void {
  if (!sh) return;
  for (const value of [...sh.r, ...sh.g, ...sh.b]) {
    if (!Number.isFinite(value) || Math.abs(value) > DEEP_GI_PROBE_VISIBILITY_SH_MAX_ABS) {
      throw new RangeError("directionalVisibilitySh is out of bounds.");
    }
  }
}

/**
 * 单探针镜面方向门（WGSL `deepGiSpecularDirectionalVisibility` 的 CPU 逐式镜像）：
 * 域外/近黑恒 1；SH 在场 → 方向重建比，缺失 → 标量 fallback 比；均 clamp 到 [0,1]。
 */
export function probeSpecularDirectionalVisibilityGate(input: {
  readonly inDomain: boolean;
  readonly environmentIrradiance: GiRgb;
  readonly probeIrradiance: GiRgb;
  readonly reflection: ProbeVector3;
  readonly directionalSh?: ProbeDirectionalVisibilitySh;
}): number {
  if (!input.inDomain) return 1;
  const envLuma = luma(input.environmentIrradiance);
  if (!(envLuma > GI_SPECULAR_ENVIRONMENT_VISIBILITY_LUMA_EPSILON)) return 1;
  const numerator = isProbeDirectionalVisibilityShMissing(input.directionalSh)
    ? luma(input.probeIrradiance)
    : luma(evaluateProbeDirectionalVisibilitySh(input.directionalSh!, input.reflection));
  return Math.min(1, Math.max(0, numerator / envLuma));
}
