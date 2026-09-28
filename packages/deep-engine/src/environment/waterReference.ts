/**
 * T09 切片一:水最小 CPU 参考(平面反射矩阵 + Gerstner 波 + Fresnel)。
 *
 * 公式来源(公开内容自实现,不复制受限代码):
 * - 平面反射矩阵:解析推导(点 x 对平面 {n·x = d} 的镜像 x' = x − 2(n·x−d)n),
 *   输出列主序 4×4(与 lighting/worldLights.ts 的列主序 Float 矩阵约定一致)。
 * - Gerstner 波:NVIDIA GPU Gems 1 (Fernando, 2004) 第 1 章 "Effective Water Simulation"
 *   公开公式:位移 P = Σ[Q·A·Dₓ·cosφ, A·sinφ, Q·A·D_z·cosφ],φ = k(D·P₀) − ωt + ψ,
 *   深水色散 ω = √(g·k);法线按 GPU Gems 式(12) 紧凑形式。自交防护 Σ Q·A·k ≤ 1。
 * - Fresnel:Schlick 近似,水 F0 = ((n_water−n_air)/(n_water+n_air))²(≈0.02037)。
 * 全 f64 纯函数;相位由 seed 整数混淆链派生(与 particles 统计参考同族),逐位确定。
 */

import type { Vec3 } from "./skyReference.js";

/** 列主序 4×4 反射矩阵:点 x 对平面 {n·x = d}(d = n·p₀)的镜像。 */
export function planarReflectionMatrix(unitNormal: Vec3, pointOnPlane: Vec3): Float64Array {
  const length = Math.hypot(...unitNormal);
  if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-9) {
    throw new RangeError("planarReflectionMatrix requires a unit normal.");
  }
  if (!unitNormal.every(Number.isFinite) || !pointOnPlane.every(Number.isFinite)) {
    throw new RangeError("planarReflectionMatrix requires finite inputs.");
  }
  const [nx, ny, nz] = unitNormal;
  const [ox, oy, oz] = pointOnPlane;
  const d = nx * ox + ny * oy + nz * oz;
  // 线性部分 I − 2nnᵀ,平移 2d·n(x' = (I−2nnᵀ)x + 2d·n)。
  const matrix = new Float64Array(16);
  matrix[0] = 1 - 2 * nx * nx; matrix[1] = -2 * nx * ny; matrix[2] = -2 * nx * nz;
  matrix[4] = -2 * ny * nx; matrix[5] = 1 - 2 * ny * ny; matrix[6] = -2 * ny * nz;
  matrix[8] = -2 * nz * nx; matrix[9] = -2 * nz * ny; matrix[10] = 1 - 2 * nz * nz;
  matrix[12] = 2 * d * nx; matrix[13] = 2 * d * ny; matrix[14] = 2 * d * nz;
  matrix[15] = 1;
  return matrix;
}

/** 列主序矩阵 × 齐 3 点/方向(w=0 时忽略平移)。 */
export function transformByMatrix(matrix: Float64Array, value: Vec3, translate: boolean): Vec3 {
  return [
    matrix[0]! * value[0] + matrix[4]! * value[1] + matrix[8]! * value[2] + (translate ? matrix[12]! : 0),
    matrix[1]! * value[0] + matrix[5]! * value[1] + matrix[9]! * value[2] + (translate ? matrix[13]! : 0),
    matrix[2]! * value[0] + matrix[6]! * value[1] + matrix[10]! * value[2] + (translate ? matrix[14]! : 0),
  ];
}

export interface GerstnerWave {
  /** 波行进方向(水平面内),非零即可,内部归一化。 */
  readonly directionXZ: readonly [number, number];
  /** 振幅 A(米),> 0。 */
  readonly amplitude: number;
  /** 波长 λ(米),> 0;k = 2π/λ。 */
  readonly wavelength: number;
  /** 尖锐度 Q ∈ [0,1];合成自交防护 Σ Q·A·k ≤ 1。 */
  readonly steepness: number;
  /** 相位偏移(弧度);缺省由 seed 派生。 */
  readonly phaseOffset?: number;
}

export interface GerstnerSample {
  /** 位移后的水面点 [x, y, z](y 为高度)。 */
  readonly position: Vec3;
  /** 解析法线(单位)。 */
  readonly normal: Vec3;
}

function hashPhase(seed: number, index: number): number {
  // 32 位整数混淆链(与 particles 统计参考同族),输出 [0, 2π)。
  let value = (Math.imul(seed + index, 0x9e3779b1) ^ 0x7feb352d) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b) >>> 0;
  return (value / 4294967296) * Math.PI * 2;
}

export interface GerstnerEvaluation {
  readonly waveNumbers: readonly number[];
  readonly angularFrequencies: readonly number[];
}

/** 编译校验:方向非零、A/λ/Q 范围、自交防护 Σ Q·A·k ≤ 1;返回缓存标量。 */
export function compileGerstnerWaves(waves: readonly GerstnerWave[], seed = 0x5ea0,
  gravity = 9.81): GerstnerEvaluation {
  if (!Number.isFinite(gravity) || gravity <= 0) throw new RangeError("Gerstner gravity must be positive.");
  let loopBudget = 0;
  const waveNumbers: number[] = [];
  const angularFrequencies: number[] = [];
  for (let index = 0; index < waves.length; index += 1) {
    const wave = waves[index]!;
    const [dx, dz] = wave.directionXZ;
    const directionLength = Math.hypot(dx, dz);
    if (!Number.isFinite(directionLength) || directionLength <= 1e-9) {
      throw new RangeError(`Gerstner wave ${index} direction must be a nonzero finite vector.`);
    }
    if (!Number.isFinite(wave.amplitude) || wave.amplitude <= 0) {
      throw new RangeError(`Gerstner wave ${index} amplitude must be positive.`);
    }
    if (!Number.isFinite(wave.wavelength) || wave.wavelength <= 0) {
      throw new RangeError(`Gerstner wave ${index} wavelength must be positive.`);
    }
    if (!Number.isFinite(wave.steepness) || wave.steepness < 0 || wave.steepness > 1) {
      throw new RangeError(`Gerstner wave ${index} steepness must be in [0, 1].`);
    }
    const k = 2 * Math.PI / wave.wavelength;
    loopBudget += wave.steepness * wave.amplitude * k;
    waveNumbers.push(k);
    angularFrequencies.push(Math.sqrt(gravity * k));
  }
  if (loopBudget > 1) {
    throw new RangeError(`Gerstner waves self-intersect: Σ Q·A·k = ${loopBudget.toFixed(6)} > 1.`);
  }
  return { waveNumbers, angularFrequencies };
}

/** Gerstner 采样:position/normal 均为 (x,z,t) 的纯函数;相位缺省由 seed 混淆链派生。 */
export function gerstnerSample(evaluation: GerstnerEvaluation, waves: readonly GerstnerWave[],
  x: number, z: number, time: number, seed = 0x5ea0): GerstnerSample {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(time)) {
    throw new RangeError("gerstnerSample requires finite coordinates and time.");
  }
  let px = x, py = 0, pz = z;
  let nx = 0, ny = 1, nz = 0;
  for (let index = 0; index < waves.length; index += 1) {
    const wave = waves[index]!;
    const directionLength = Math.hypot(wave.directionXZ[0], wave.directionXZ[1]);
    const dx = wave.directionXZ[0] / directionLength;
    const dz = wave.directionXZ[1] / directionLength;
    const k = evaluation.waveNumbers[index]!;
    const omega = evaluation.angularFrequencies[index]!;
    const phase = k * (dx * x + dz * z) - omega * time
      + (wave.phaseOffset ?? hashPhase(seed, index));
    const sinus = Math.sin(phase);
    const cosine = Math.cos(phase);
    const qak = wave.steepness * wave.amplitude * k;
    px += qak * dx * cosine;
    py += wave.amplitude * sinus;
    pz += qak * dz * cosine;
    // GPU Gems 式(12) 紧凑法线(累积后归一)。
    nx -= dx * k * wave.amplitude * cosine;
    ny -= qak * sinus;
    nz -= dz * k * wave.amplitude * cosine;
  }
  const normalLength = Math.hypot(nx, ny, nz);
  return {
    position: [px, py, pz],
    normal: [nx / normalLength, ny / normalLength, nz / normalLength],
  };
}

/** Schlick Fresnel:f0 + (1−f0)(1−cosθ)⁵;cosθ ∈ [0,1](0 = 掠射)。 */
export function schlickFresnel(cosIncident: number, f0: number): number {
  if (!Number.isFinite(cosIncident) || cosIncident < 0 || cosIncident > 1) {
    throw new RangeError("schlickFresnel requires cosIncident in [0, 1].");
  }
  if (!Number.isFinite(f0) || f0 < 0 || f0 >= 1) {
    throw new RangeError("schlickFresnel requires f0 in [0, 1).");
  }
  const inverse = 1 - cosIncident;
  return f0 + (1 - f0) * inverse ** 5;
}

/** 空气→水(折射率 1.333)的 Schlick F0 = ((n−1)/(n+1))²。 */
export function waterFresnelZero(refractiveIndex = 1.333): number {
  if (!Number.isFinite(refractiveIndex) || refractiveIndex < 1) {
    throw new RangeError("waterFresnelZero requires a refractive index ≥ 1.");
  }
  const ratio = (refractiveIndex - 1) / (refractiveIndex + 1);
  return ratio * ratio;
}
