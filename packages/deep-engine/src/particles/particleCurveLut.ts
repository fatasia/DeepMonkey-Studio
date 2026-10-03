/**
 * T20 切片:粒子曲线 LUT 烘焙与 O(1) 采样(Shuriken "over lifetime" / Niagara 曲线资产同口径)。
 *
 * 关键帧求值器(particleCurves)是唯一公式源;LUT 把它一次性烘焙成等距 Float32 表,
 * 逐粒子逐帧只做一次线性插值读表,无分配、无分支爆炸,适合编辑器 CPU 路径与后续 GPU 纹理上传。
 */

import { evaluateParticleCurve, type ParticleCurve } from "./particleCurves.js";

export const PARTICLE_CURVE_LUT_DEFAULT_RESOLUTION = 64;

/** 把曲线在 [0,1] 生命周期上烘焙为 resolution 个等距采样(含两端点)。 */
export function bakeParticleCurveLut(curve: ParticleCurve,
  resolution: number = PARTICLE_CURVE_LUT_DEFAULT_RESOLUTION): Float32Array {
  if (!Number.isSafeInteger(resolution) || resolution < 2 || resolution > 4_096) {
    throw new RangeError("resolution must be an integer in 2..4096.");
  }
  const lut = new Float32Array(resolution);
  const last = resolution - 1;
  for (let index = 0; index < resolution; index++) {
    lut[index] = evaluateParticleCurve(curve, index / last).value;
  }
  return lut;
}

/** 归一化生命周期 t(越界钳制,非有限值按 0)读表线性插值;lut 至少 2 项。 */
export function sampleParticleCurveLut(lut: Float32Array, t: number): number {
  const last = lut.length - 1;
  if (!(t > 0)) return lut[0]!;
  if (t >= 1) return lut[last]!;
  const scaled = t * last;
  const lower = scaled | 0;
  const alpha = scaled - lower;
  const a = lut[lower]!;
  return a + (lut[lower + 1]! - a) * alpha;
}
