import type { ProbeVector3 } from "./probeClipmapPlan.js";
import { DEEP_REFLECTION_PROBE_DIRECTION_EPSILON, DEEP_REFLECTION_PROBE_SECONDARY_CUTOFF,
  DEEP_REFLECTION_PROBE_SENTINEL_DEGENERATE, DEEP_REFLECTION_PROBE_SENTINEL_OUTSIDE,
  DEEP_REFLECTION_PROBE_UNCONSTRAINED_STEP } from "./reflectionProbeBoxProjectionWgsl.js";

/**
 * C15 反射探针盒投影——WGSL 核的 CPU 镜像(f64 可执行规范)。
 * WGSL 单源(wgsl/reflectionProbeBoxProjection.wgsl)是着色端唯一实现;本模块逐式镜像
 * 三支公式(盒投影/影响体权重/双探针归一),门禁:reflectionProbeParallax.test.ts 数值
 * 用例 + scripts/c15ReflectionProbeParallaxGpuTest.mts 真机 f32↔f64 对拍(maxDir ≤1e-5,
 * 实测 9.98e-8;哨兵要求逐位一致——哨兵是语义不是数值)。
 */

export interface ReflectionProbeBoxProjectResult {
  /** 校正后采样方向(单位向量);不校正时即原始反射向量。 */
  readonly direction: ProbeVector3;
  /** 接收点→影响体面交点距离;不校正时为负哨兵(SENTINEL_OUTSIDE/SENTINEL_DEGENERATE)。 */
  readonly hitDistance: number;
  readonly corrected: boolean;
}

/** 数值判据字面量(与 WGSL deepReflectionProbeFinite3 的 limit 互钉)。 */
const FINITE_LIMIT = 1_000_000_000;

/** WGSL deepReflectionProbeBoxProject 的 CPU 镜像:守卫 → 盒内判据 → 单位化 → 逐轴出射 → 交点方向。 */
export function reflectionProbeBoxProjectCpu(worldPosition: ProbeVector3, reflectionDirection: ProbeVector3,
  probe: { center: ProbeVector3; halfExtents: ProbeVector3 }): ReflectionProbeBoxProjectResult {
  const directionLength = Math.hypot(...reflectionDirection);
  if (!(directionLength > DEEP_REFLECTION_PROBE_DIRECTION_EPSILON)
    || !finite3(worldPosition, FINITE_LIMIT) || !finite3(reflectionDirection, FINITE_LIMIT)
    || !finite3(probe.center, FINITE_LIMIT) || !finite3(probe.halfExtents, FINITE_LIMIT)
    || probe.halfExtents.some(value => !(value > 0))) {
    return { direction: [...reflectionDirection] as ProbeVector3,
      hitDistance: DEEP_REFLECTION_PROBE_SENTINEL_DEGENERATE, corrected: false };
  }
  const relative: ProbeVector3 = [worldPosition[0] - probe.center[0], worldPosition[1] - probe.center[1],
    worldPosition[2] - probe.center[2]];
  if (relative.some((value, axis) => Math.abs(value) > probe.halfExtents[axis]!)) {
    return { direction: [...reflectionDirection] as ProbeVector3,
      hitDistance: DEEP_REFLECTION_PROBE_SENTINEL_OUTSIDE, corrected: false };
  }
  const direction: ProbeVector3 = [reflectionDirection[0] / directionLength,
    reflectionDirection[1] / directionLength, reflectionDirection[2] / directionLength];
  let exitDistance = DEEP_REFLECTION_PROBE_UNCONSTRAINED_STEP;
  for (let axis = 0; axis < 3; axis++) {
    if (!(Math.abs(direction[axis]!) >= DEEP_REFLECTION_PROBE_DIRECTION_EPSILON)) continue;
    const bound = direction[axis]! > 0 ? probe.halfExtents[axis]! : -probe.halfExtents[axis]!;
    exitDistance = Math.min(exitDistance, (bound - relative[axis]!) / direction[axis]!);
  }
  const corrected: ProbeVector3 = [relative[0] + direction[0]! * exitDistance,
    relative[1] + direction[1]! * exitDistance, relative[2] + direction[2]! * exitDistance];
  return { direction: normalize(corrected), hitDistance: exitDistance, corrected: true };
}

/** WGSL deepReflectionProbeInfluenceWeight 的 CPU 镜像:核 1 / 壳内线性 / 影响体外 0 / 非法 0。 */
export function reflectionProbeInfluenceWeightCpu(worldPosition: ProbeVector3,
  probe: { center: ProbeVector3; halfExtents: ProbeVector3; blendDistance: number;
    influenceRadius: number }): number {
  if (!finite3(worldPosition, FINITE_LIMIT) || !finite3(probe.center, FINITE_LIMIT)
    || !finite3(probe.halfExtents, FINITE_LIMIT) || probe.halfExtents.some(value => !(value > 0))) return 0;
  const outside = Math.hypot(
    Math.max(Math.abs(worldPosition[0] - probe.center[0]) - probe.halfExtents[0]!, 0),
    Math.max(Math.abs(worldPosition[1] - probe.center[1]) - probe.halfExtents[1]!, 0),
    Math.max(Math.abs(worldPosition[2] - probe.center[2]) - probe.halfExtents[2]!, 0));
  if (!(outside < probe.influenceRadius)) return 0;
  const shell = Math.min(Math.max(probe.blendDistance, 0), probe.influenceRadius);
  const core = Math.max(probe.influenceRadius - shell, 0);
  if (outside <= core) return 1;
  return 1 - (outside - core) / Math.max(probe.influenceRadius - core, 0.000001);
}

/** WGSL deepReflectionProbePairWeights 的 CPU 镜像:次级低于裁剪阈退化为单探针 (1,0)。 */
export function reflectionProbePairWeightsCpu(primaryWeight: number, secondaryWeight: number,
  secondaryCutoff: number = DEEP_REFLECTION_PROBE_SECONDARY_CUTOFF): [number, number] {
  const primary = primaryWeight > 0 ? primaryWeight : 0;
  const secondary = secondaryWeight > 0 ? secondaryWeight : 0;
  if (!(primary + secondary >= secondaryCutoff)) return [0, 0];
  const secondaryKept = secondary < secondaryCutoff ? 0 : secondary;
  const keptTotal = primary + secondaryKept;
  return [primary / keptTotal, secondaryKept / keptTotal];
}

function normalize(value: ProbeVector3): ProbeVector3 {
  const length = Math.hypot(...value);
  return length > 0 ? [value[0] / length, value[1] / length, value[2] / length] : [0, 0, 0];
}
function finite3(value: readonly number[], limit: number): boolean {
  return value.length === 3 && value.every(item => Number.isFinite(item) && Math.abs(item) <= limit);
}
