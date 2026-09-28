/**
 * T09 切片一:雾散射 CPU 参考(闭式解析 + 能量守恒)。
 *
 * 与既有底座的关系(只读复用,不重建):
 * - 密度/相位/步进数值积分在 `fog/volumetricFog.ts`(本文件的闭式解是它的解析对照,
 *   用于一致性核验与收敛评估,不替代步进实现);
 * - `webgpu/pbrFog.ts` 定义 HDR 合成口径:volumetric kind = 1 − exp(−σ·d)(Beer 线性),
 *   exp2 kind = 1 − exp(−(ρ·d))² 即 density 平方(Three r185 fog_fragment.glsl 语义)。
 *   两种口径物理含义不同,本文件分别复现并测试逐式一致。
 *
 * 能量守恒承诺(全部有测试兜底):
 * - 单程透射恒 ∈ [0,1](含极端参数扫描);
 * - 均匀介质内散射闭式 L = Le·albedo·P·(1−T),相位按球面积分归一(HG 精确归一);
 * - 多散射近似采用"归一化八度分配":(1−a)·aⁱ 权重 share Σ = 1−a^N ≤ 1,
 *   总内散射恒 ≤ 单次散射能量预算 P·albedo;常见误实现(未归一化 aⁱ 直接叠加)
 *   在 a≥0.5 且 T→1 时会突破预算,测试中给出反例证明归一化的必要性。
 * 全 f64 纯函数;同输入逐位同输出。
 */

import { densityAtHeight, henyeyGreensteinPhase, type VolumetricMedium } from "../fog/volumetricFog.js";

/** 闭式指数高度雾透射 T = exp(−∫₀^d σ(y₀+s·dy) ds),密度钳制约定与 densityAtHeight 一致(h<0 按 h=0)。 */
export function heightFogTransmittance(originY: number, directionY: number, distance: number,
  medium: Pick<VolumetricMedium, "baseExtinction" | "scaleHeight">): number {
  if (!Number.isFinite(originY) || !Number.isFinite(directionY) || !Number.isFinite(distance) || distance < 0) {
    throw new RangeError("heightFogTransmittance requires finite inputs and nonnegative distance.");
  }
  const { baseExtinction, scaleHeight } = medium;
  const dy = directionY;
  if (dy === 0) {
    const opticalDepth = densityAtHeight(originY, medium) * distance;
    return Math.exp(-opticalDepth);
  }
  // 分段积分子段:[sStart, sEnd] 内密度要么恒为 σ₀(h≤0),要么按 exp(−y/H) 解析积分。
  let opticalDepth = 0;
  const segment = (sStart: number, sEnd: number, yStart: number, yEnd: number): void => {
    if (sEnd <= sStart) return;
    if (yStart <= 0 && yEnd <= 0) {
      opticalDepth += baseExtinction * (sEnd - sStart);
      return;
    }
    if (yStart >= 0 && yEnd >= 0) {
      // ∫ σ₀ e^{−y/H} ds 对任意 dy 方向均为正:密度沿 s 单调,取差值绝对值
      // (同时消除大高度下的灾难性对消符号风险)。
      opticalDepth += baseExtinction * scaleHeight / Math.abs(dy)
        * Math.abs(Math.exp(-yStart / scaleHeight) - Math.exp(-yEnd / scaleHeight));
      return;
    }
    const crossing = sStart + (0 - yStart) / dy; // y(s) = yStart + dy·(s − sStart) 的穿地参数
    segment(sStart, crossing, yStart, 0);
    segment(crossing, sEnd, 0, yEnd);
  };
  segment(0, distance, originY, originY + dy * distance);
  return Math.exp(-opticalDepth);
}

/** 均匀介质 Beer-Lambert 透射(pbrFog volumetric 口径的透射侧)。 */
export function uniformFogTransmittance(extinction: number, distance: number): number {
  if (!Number.isFinite(extinction) || extinction < 0 || !Number.isFinite(distance) || distance < 0) {
    throw new RangeError("uniformFogTransmittance requires finite nonnegative inputs.");
  }
  return Math.exp(-extinction * distance);
}

/** 均匀介质内散射闭式:Le·albedo·P·(1−T)(= Le·σs·P·∫e^{−σs}ds 的解析解)。 */
export function uniformInscatter(lightRadiance: number, albedo: number, phase: number,
  transmittance: number): number {
  if (!Number.isFinite(lightRadiance) || lightRadiance < 0 || !Number.isFinite(phase)) {
    throw new RangeError("uniformInscatter requires finite nonnegative radiance and finite phase.");
  }
  if (!Number.isFinite(albedo) || albedo < 0 || albedo > 1) {
    throw new RangeError("uniformInscatter albedo must be in [0, 1].");
  }
  if (!Number.isFinite(transmittance) || transmittance < 0 || transmittance > 1) {
    throw new RangeError("uniformInscatter transmittance must be in [0, 1].");
  }
  return lightRadiance * albedo * phase * (1 - transmittance);
}

/**
 * 多散射近似(归一化八度分配):第 i 个八度贡献 (1−a)·aⁱ 的散射 albedo share,
 * 光学深度按 (2i+1) 倍(Frostbite 风格的深度倍增直觉,可替换)。
 * 总散射 ≤ P·albedo·(1−a^N) ≤ P·albedo:恒不超单次散射能量预算。
 */
export function multiScatterInscatter(lightRadiance: number, albedo: number, phase: number,
  transmittance: number, octaves: number, contribution: number): number {
  if (!Number.isSafeInteger(octaves) || octaves < 1 || octaves > 8) {
    throw new RangeError("multiScatterInscatter octaves must be an integer in [1, 8].");
  }
  if (!Number.isFinite(contribution) || contribution <= 0 || contribution >= 1) {
    throw new RangeError("multiScatterInscatter contribution must be in (0, 1).");
  }
  let total = 0;
  let weight = 1;
  for (let octave = 0; octave < octaves; octave += 1) {
    const share = octave === 0 ? 1 - contribution : (1 - contribution) * weight;
    weight *= contribution;
    const octaveTransmittance = Math.pow(transmittance, 2 * octave + 1);
    total += share * (1 - octaveTransmittance);
  }
  return lightRadiance * albedo * phase * total;
}

/** exp2 雾因子(Three r185 语义):1 − exp(−(ρ·d)²);与 pbrFog exp2 口径逐式一致。 */
export function exp2FogFactor(density: number, depth: number): number {
  if (!Number.isFinite(density) || density < 0 || !Number.isFinite(depth)) {
    throw new RangeError("exp2FogFactor requires finite nonnegative density and finite depth.");
  }
  if (density === 0) return 0;
  const opticalDepth = density * depth;
  return 1 - Math.exp(-opticalDepth * opticalDepth);
}

/** 合同 exp2 密度 → 参考 depth 处等价 Beer 消光(等透射换算):exp(−σ·x) = exp(−(ρ·x)²)。 */
export function equivalentBeerExtinction(exp2Density: number, referenceDepth: number): number {
  if (!Number.isFinite(exp2Density) || exp2Density < 0 || !Number.isFinite(referenceDepth) || referenceDepth <= 0) {
    throw new RangeError("equivalentBeerExtinction requires finite inputs and positive referenceDepth.");
  }
  return exp2Density * exp2Density * referenceDepth;
}

export { henyeyGreensteinPhase };
