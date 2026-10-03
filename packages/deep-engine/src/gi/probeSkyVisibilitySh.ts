import type { ProbeVector3 } from "../lighting/probeClipmapPlan.js";

/**
 * Brief-GI M1:天光可见度向量 → L1 SH 投影/重建 + 时域滤波。
 *
 * == 投影(白炉逐位负控的构造性保证,与 F5 方案 A 同族) ==
 * 系数序 (c0, d_y, d_z, d_x),重建核 (1, dir.y, dir.z, dir.x)(unnormalized 轴基,
 * deepDiffuse 64B eval 同族):
 * - `c0 = (Σ_i v_i) / N`(顺序累加,与捕获均值同式同序);
 * - `d_axis = (3/N) · Σ_i (v_i − c0) · dir_i[axis]`。
 * 均匀场(v_i ≡ v):N ≤ 32 个同值 f32 顺序求和无舍入(整数域),`v_i − c0 ≡ 0` 精确
 * → dipoles 精确零 → `recon(dir) ≡ v`。全开天空(v ≡ 1)时以可见度乘辐射度 = ×1.0,
 * IEEE754 逐位恒等 —— C12 白炉能量守恒在构造层面保持。
 *
 * == 时域滤波 ==
 * `blendSkyVisibilitySh(previous, next, α)`:α=0 逐位返回 previous、α=1 逐位返回 next、
 * 逐系数线性插值;稳态(previous ≡ next)下任意 α 逐位不动(收缩到不动点,无抖动源)。
 */

/** 单探针天光可见度 L1 SH:(c0, d_y, d_z, d_x)。 */
export type SkyVisibilitySh = readonly [number, number, number, number];

/** SH 系数数(l0 + L1 三轴)。 */
export const SKY_VISIBILITY_SH_COEFFICIENTS = 4;

/**
 * 可见度向量 → L1 SH。`visibilities` 与 `directions` 逐下标对齐(traceSdfSkyVisibility
 * 的单探针切片);值域越界([0,1] 外)/非有限 fail-fast(上游合同破坏必须在此暴露)。
 */
export function projectSkyVisibilitySh(visibilities: ArrayLike<number>,
  directions: readonly ProbeVector3[]): SkyVisibilitySh {
  if (visibilities.length !== directions.length || directions.length === 0) {
    throw new RangeError("Sky visibility SH projection needs one direction per visibility sample.");
  }
  let c0 = 0;
  for (let index = 0; index < visibilities.length; index++) {
    const value = visibilities[index]!;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError("Sky visibility samples must be finite in [0, 1].");
    }
    c0 += value;
  }
  c0 /= directions.length;
  let sumY = 0, sumZ = 0, sumX = 0;
  for (let index = 0; index < directions.length; index++) {
    const direction = directions[index]!;
    if (direction.length !== 3 || !direction.every(Number.isFinite)) {
      throw new RangeError("Sky visibility SH directions must be finite vec3.");
    }
    const centered = visibilities[index]! - c0;
    sumY += centered * direction[1]!;
    sumZ += centered * direction[2]!;
    sumX += centered * direction[0]!;
  }
  const count = directions.length;
  return Object.freeze([c0, 3 * sumY / count, 3 * sumZ / count, 3 * sumX / count]);
}

/** SH 重建:F5 L1 eval 同族核 (1, y, z, x);负值截断为 0(可见度非负语义)。 */
export function evaluateSkyVisibilitySh(sh: SkyVisibilitySh, direction: ProbeVector3): number {
  if (direction.length !== 3 || !direction.every(Number.isFinite)) {
    throw new RangeError("Sky visibility SH evaluation needs a finite direction.");
  }
  return Math.max(0, sh[0]! + sh[1]! * direction[1]! + sh[2]! * direction[2]! + sh[3]! * direction[0]!);
}

/** 全零判据(= 缺失探针,消费侧可跳过天光调制)。 */
export function isSkyVisibilityShNeutral(sh: SkyVisibilitySh | undefined): boolean {
  if (!sh) return true;
  return sh.every(value => value === 0);
}

/**
 * 时域滤波:逐系数 lerp。α=0 → 逐位 previous(原对象),α=1 → 逐位 next(原对象);
 * α 必须有限 ∈[0,1](越界 fail-fast——调用方应传 clamp 后的解析值)。
 */
export function blendSkyVisibilitySh(previous: SkyVisibilitySh, next: SkyVisibilitySh,
  alpha: number): SkyVisibilitySh {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new RangeError("Sky visibility SH temporal alpha must be finite in [0, 1].");
  }
  if (alpha === 0) return previous;
  if (alpha === 1) return next;
  return Object.freeze([
    previous[0]! + (next[0]! - previous[0]!) * alpha,
    previous[1]! + (next[1]! - previous[1]!) * alpha,
    previous[2]! + (next[2]! - previous[2]!) * alpha,
    previous[3]! + (next[3]! - previous[3]!) * alpha,
  ]);
}
