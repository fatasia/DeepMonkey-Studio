import type { ProbeAabb, ProbeVector3 } from "./probeClipmapPlan.js";

/**
 * DDGI 式 probe 位置优化（relocation 求解器，波次2 GI 收口）。
 * 采样端（probeClipmapSamplingWgsl ABI v1）把 relocation 加回格点得到有效探针位置；
 * 本模块在更新侧求解偏移：probe 埋进遮挡体或贴面时沿最短逸出方向推开，避免全黑探针
 * 与切比雪夫失效导致的泄漏。幂等：已安全的探针返回零偏移。
 * 消费路径：surface-cache capture 管线在每个探针更新时以遮挡体集合调用本求解器，
 * 结果写入 IrradianceProbeRecord.positionOffset（packIrradianceProbeRecord 已有通道）。
 */

export interface ProbeRelocationInput {
  /** 探针格点世界坐标（不含既有偏移；既有偏移由调用方叠加后传入或合并）。 */
  readonly cellPosition: ProbeVector3;
  readonly spacing: number;
  /** 参与更新的遮挡体（世界 AABB）；空集合视为开阔，返回零偏移。 */
  readonly obstacles: readonly ProbeAabb[];
  /** 偏移上限（每轴），默认 0.5*spacing——超出会把探针拽进相邻格的权重域。 */
  readonly maxOffset?: number;
  /** 安全间距，默认 0.2*spacing（与采样端 DEEP_GI_NORMAL_BIAS_CELLS 对齐）。 */
  readonly margin?: number;
}

export function computeProbeRelocation(input: ProbeRelocationInput): ProbeVector3 {
  const margin = input.margin ?? input.spacing * 0.2;
  const maxOffset = input.maxOffset ?? input.spacing * 0.5;
  if (!Number.isFinite(margin) || margin < 0 || !Number.isFinite(maxOffset) || maxOffset < 0) {
    throw new RangeError("Probe relocation margin and maxOffset must be finite and nonnegative.");
  }
  const position = finiteVector(input.cellPosition, "cellPosition");
  if (!Number.isFinite(input.spacing) || input.spacing <= 0) throw new RangeError("Probe relocation spacing must be positive.");
  if (input.obstacles.length === 0) return [0, 0, 0];
  let offsetX = 0, offsetY = 0, offsetZ = 0, worstPenetration = 0;
  for (const obstacle of input.obstacles) {
    const push = escapeVector(position, obstacle, margin);
    if (push === undefined) continue;
    // 最深穿透的遮挡体主导方向；次深遮挡体只允许在同方向追加、不抵消（避免拉锯）。
    if (push.depth > worstPenetration) {
      worstPenetration = push.depth;
      offsetX = push.x; offsetY = push.y; offsetZ = push.z;
    }
  }
  if (worstPenetration === 0) return [0, 0, 0];
  const scale = maxOffset / Math.max(Math.hypot(offsetX, offsetY, offsetZ), 1e-9);
  return [clamp(offsetX * Math.min(1, scale), -maxOffset, maxOffset),
    clamp(offsetY * Math.min(1, scale), -maxOffset, maxOffset),
    clamp(offsetZ * Math.min(1, scale), -maxOffset, maxOffset)];
}

interface Escape { readonly x: number; readonly y: number; readonly z: number; readonly depth: number }

/** 探针在 AABB 内 → 沿最薄轴逸出到表面外 margin；进入 margin 包壳 → 沿最近面法向推开；否则 undefined。 */
function escapeVector(position: ProbeVector3, obstacle: ProbeAabb, margin: number): Escape | undefined {
  const min = obstacle.min, max = obstacle.max;
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(min[axis]!) || !Number.isFinite(max[axis]!) || min[axis]! > max[axis]!) {
      throw new RangeError("Probe relocation obstacle bounds must be finite with min ≤ max.");
    }
  }
  const inside = position.every((value, axis) => value > min[axis]! && value < max[axis]!);
  if (inside) {
    const escapes = [max[0]! - position[0]!, position[0]! - min[0]!, max[1]! - position[1]!,
      position[1]! - min[1]!, max[2]! - position[2]!, position[2]! - min[2]!];
    let axis = 0, sign = 1, depth = escapes[0]!;
    for (let candidate = 1; candidate < 6; candidate++) {
      if (escapes[candidate]! < depth) { axis = candidate >> 1; sign = candidate % 2 === 0 ? 1 : -1; depth = escapes[candidate]!; }
    }
    const distance = depth + margin;
    return { x: axis === 0 ? sign * distance : 0, y: axis === 1 ? sign * distance : 0, z: axis === 2 ? sign * distance : 0, depth };
  }
  const closest = position.map((value, axis) => clamp(value, min[axis]!, max[axis]!));
  const delta = position.map((value, axis) => value - closest[axis]!);
  const distance = Math.hypot(delta[0]!, delta[1]!, delta[2]!);
  if (distance >= margin) return undefined;
  if (distance <= 1e-9) {
    // 恰在表面/棱上：沿中心方向推出（确定性的退化兜底）。
    const center = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
    const direction = position.map((value, axis) => value - center[axis]!);
    const length = Math.hypot(direction[0]!, direction[1]!, direction[2]!);
    if (length <= 1e-9) return { x: 0, y: margin, z: 0, depth: margin };
    return { x: direction[0]! / length * margin, y: direction[1]! / length * margin, z: direction[2]! / length * margin, depth: margin };
  }
  return { x: delta[0]! / distance * (margin - distance), y: delta[1]! / distance * (margin - distance),
    z: delta[2]! / distance * (margin - distance), depth: margin - distance };
}

function finiteVector(value: ProbeVector3, name: string): ProbeVector3 {
  if (value.length !== 3 || value.some(item => !Number.isFinite(item))) {
    throw new RangeError(`Probe relocation ${name} must be finite XYZ.`);
  }
  return value;
}
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
