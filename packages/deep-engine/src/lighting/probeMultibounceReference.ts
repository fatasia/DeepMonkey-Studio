import type { ProbeVector3 } from "./probeClipmapPlan.js";
import { createReferenceRng, intersectReferenceScene, referenceSceneDiagonal,
  sampleReferenceDirect, uniformSphereDirection, type ReferenceScene } from "./probeReferenceScene.js";

/**
 * G3 多散射验收的物理真值分母：路径追踪式多弹 MC（纯 CPU、确定性）。
 *
 * == 与一跳参考（probeReferenceIntegrator）的分工 ==
 * 一跳 `integrateProbeReference` 是「引擎口径」分母：hit 方向直射、miss 方向常量环境，
 * 只隔离方向采样误差。本模块默认同为引擎口径直射（无阴影射线）+ Lambert 续弹（余弦
 * 加权采样，throughput 乘 albedo/p），miss 计 throughput·ambient——首跳语义与一跳参考
 * 完全一致，差异只在没有续弹。验收多散射自反馈时用它当分母，自反馈开的收益 =
 * 对本分母的 RMSE 收窄，单一变量是「续弹贡献」。`shadowed: true` 切物理真值口径
 * （命中点阴影射线），仅供阴影对照，不进自反馈 RMSE 验收。
 *
 * == 诚实边界 ==
 * 固定弹射深度（默认 3 跳）截断而非真正 infinite bounces；余弦加权 + RR 下残余方差比
 * 一跳参考大，半分 z 检验（同一阈值族）剔除遮挡不连续附近的探针后再进稳定区域 RMSE。
 */

/** 默认样本数（与 T02/G3-S1 的 4096 MC 同口径，任务验收绑定该数）。 */
export const MULTIBOUNCE_DEFAULT_SAMPLE_COUNT = 4096;
/** 默认最大弹射次数（含首跳；3 = 首跳 + 2 次续弹）。 */
export const MULTIBOUNCE_DEFAULT_BOUNCES = 3;
/** 半分自一致性 z 检验默认阈值（与一跳参考同族）。 */
export const MULTIBOUNCE_DEFAULT_STABILITY_Z = 3;

export interface ProbeMultibounceOptions {
  readonly sampleCount?: number;
  readonly seed?: number;
  /** 最大弹射次数（≥1 整数）。 */
  readonly bounces?: number;
  readonly stabilityZ?: number;
  /**
   * 直射口径：默认 false = 引擎口径（无阴影射线，与一跳参考/生产内核同功能量——多散射
   * 验收的单一变量是「续弹贡献」）；true = 物理真值口径（命中点阴影射线），仅供阴影
   * 对照实验，不用于自反馈 RMSE 验收。
   */
  readonly shadowed?: boolean;
}

export interface ProbeMultibounceSample {
  /** 方向均值辐照度（线性 RGB，与一跳参考同存储口径）。 */
  readonly irradiance: ProbeVector3;
  /** miss 方向占比（首跳口径，信息性输出）。 */
  readonly missRatio: number;
  /** 半分自一致（z 检验 ≤ 阈值）：true = 可进入稳定区域 RMSE。 */
  readonly stable: boolean;
  readonly halfSplitZ: number;
  readonly sampleCount: number;
  readonly bounces: number;
}

/** 余弦加权半球方向（Lambert BRDF 采样；返回世界系方向，未随法线上半球归一化省略）。 */
export function cosineHemisphereDirection(normal: ProbeVector3, u: number, v: number): ProbeVector3 {
  const z = Math.sqrt(Math.max(0, 1 - u)), radius = Math.sqrt(u), phi = 2 * Math.PI * v;
  const tangent = Math.abs(normal[0]!) < 0.9 ? [0, 0, 1] as const : [1, 0, 0] as const;
  const bitangent: ProbeVector3 = [
    normal[1]! * tangent[2]! - normal[2]! * tangent[1]!,
    normal[2]! * tangent[0]! - normal[0]! * tangent[2]!,
    normal[0]! * tangent[1]! - normal[1]! * tangent[0]!];
  const main: ProbeVector3 = [
    bitangent[1]! * normal[2]! - bitangent[2]! * normal[1]!,
    bitangent[2]! * normal[0]! - bitangent[0]! * normal[2]!,
    bitangent[0]! * normal[1]! - bitangent[1]! * normal[0]!];
  const local: ProbeVector3 = [radius * Math.cos(phi), z, radius * Math.sin(phi)];
  return [bitangent[0]! * local[0]! + main[0]! * local[1]! + normal[0]! * local[2]!,
    bitangent[1]! * local[0]! + main[1]! * local[1]! + normal[1]! * local[2]!,
    bitangent[2]! * local[0]! + main[2]! * local[1]! + normal[2]! * local[2]!];
}

/**
 * 多弹路径追踪 MC 参考值 + 半分稳定性：每个样本从探针出发球面均匀首方向；每跳命中点
 * 计 shadowed 直射（NEE）并按 albedo 均值 RR 续弹（throughput ×= albedo/p），miss 计
 * throughput·ambient；深度到 bounces 截断。偶/奇样本两半集做 z 检验判稳定性。
 */
export function integrateProbeReferenceMultibounce(scene: ReferenceScene, position: ProbeVector3,
  options: ProbeMultibounceOptions = {}): ProbeMultibounceSample {
  const sampleCount = options.sampleCount ?? MULTIBOUNCE_DEFAULT_SAMPLE_COUNT;
  const bounces = options.bounces ?? MULTIBOUNCE_DEFAULT_BOUNCES;
  const stabilityZ = options.stabilityZ ?? MULTIBOUNCE_DEFAULT_STABILITY_Z;
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 4 || sampleCount % 2 !== 0) {
    throw new RangeError("Multibounce sampleCount must be an even safe integer ≥ 4.");
  }
  if (!Number.isSafeInteger(bounces) || bounces < 1) {
    throw new RangeError("Multibounce bounces must be a positive integer.");
  }
  if (!Number.isFinite(stabilityZ) || stabilityZ <= 0) {
    throw new RangeError("Multibounce stabilityZ must be finite and positive.");
  }
  const rng = createReferenceRng(options.seed ?? 0);
  const side = Math.ceil(Math.sqrt(sampleCount));
  const tMax = referenceSceneDiagonal(scene);
  const shadowed = options.shadowed === true;
  const halfA: [number, number, number] = [0, 0, 0], halfB: [number, number, number] = [0, 0, 0];
  let misses = 0, scalarA = 0, scalarA2 = 0, scalarB = 0, scalarB2 = 0;
  for (let index = 0; index < sampleCount; index++) {
    const ix = index % side, iy = Math.floor(index / side);
    let throughput: [number, number, number] = [1, 1, 1];
    let origin: ProbeVector3 = [...position] as ProbeVector3;
    let direction = uniformSphereDirection((ix + rng()) / side, (iy + rng()) / side);
    const radiance: [number, number, number] = [0, 0, 0];
    let miss = false;
    for (let bounce = 0; bounce < bounces; bounce++) {
      const hit = intersectReferenceScene(scene, origin, direction, tMax);
      if (hit === undefined) {
        miss = true;
        radiance[0] += throughput[0] * scene.ambient[0]!;
        radiance[1] += throughput[1] * scene.ambient[1]!;
        radiance[2] += throughput[2] * scene.ambient[2]!;
        break;
      }
      const hitPoint: ProbeVector3 = [origin[0]! + direction[0]! * hit.t,
        origin[1]! + direction[1]! * hit.t, origin[2]! + direction[2]! * hit.t];
      const direct = sampleReferenceDirect(scene, hitPoint, hit.normal, hit.albedo, shadowed);
      radiance[0] += throughput[0] * direct[0];
      radiance[1] += throughput[1] * direct[1];
      radiance[2] += throughput[2] * direct[2];
      const survival = Math.min(0.95, Math.max(0.05, (hit.albedo[0]! + hit.albedo[1]! + hit.albedo[2]!) / 3));
      if (bounce === bounces - 1 || rng() >= survival) break;
      throughput = [throughput[0] * hit.albedo[0]! / survival,
        throughput[1] * hit.albedo[1]! / survival, throughput[2] * hit.albedo[2]! / survival];
      origin = [hitPoint[0]! + hit.normal[0]! * 1e-3, hitPoint[1]! + hit.normal[1]! * 1e-3,
        hitPoint[2]! + hit.normal[2]! * 1e-3];
      direction = cosineHemisphereDirection(hit.normal, rng(), rng());
    }
    if (miss) misses += 1;
    const scalar = (radiance[0] + radiance[1] + radiance[2]) / 3;
    const target = index % 2 === 0 ? halfA : halfB;
    target[0] += radiance[0]; target[1] += radiance[1]; target[2] += radiance[2];
    if (index % 2 === 0) { scalarA += scalar; scalarA2 += scalar * scalar; }
    else { scalarB += scalar; scalarB2 += scalar * scalar; }
  }
  const half = sampleCount / 2;
  const meanA = scalarA / half, meanB = scalarB / half;
  const pooledVariance = (scalarA2 - half * meanA * meanA + scalarB2 - half * meanB * meanB)
    / Math.max(sampleCount - 2, 1);
  const standardError = Math.sqrt(Math.max(0, pooledVariance) * (1 / half + 1 / half));
  const halfSplitZ = Math.abs(meanA - meanB) < 1e-12 || standardError < 1e-12
    ? 0 : Math.abs(meanA - meanB) / standardError;
  const irradiance: ProbeVector3 = [(halfA[0] + halfB[0]) / sampleCount,
    (halfA[1] + halfB[1]) / sampleCount, (halfA[2] + halfB[2]) / sampleCount];
  return Object.freeze({ irradiance: Object.freeze(irradiance), missRatio: misses / sampleCount,
    stable: halfSplitZ <= stabilityZ, halfSplitZ, sampleCount, bounces });
}
