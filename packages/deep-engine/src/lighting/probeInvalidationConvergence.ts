import type { ProbeAabb, ProbeVector3 } from "./probeClipmapPlan.js";

/**
 * T02 增量失效与预算收敛推演（纯 CPU）：源（几何/材质/灯光）revision → 脏探针最小集 →
 * 固定每帧预算 N 探针/帧的收敛曲线与"1 秒内达 RMSE≤10%"的预算档推导。
 *
 * == 与既有底座的分工（不重建） ==
 * - 几何/材质 revision → 脏 AABB：复用 `ProbeSurfaceCache`（upsert/remove → pending →
 *   beginFrame().dirtyBounds → commit）。本模块只消费它的 frame 输出。
 * - 脏 AABB → 待更新探针调度：调度优先级/预算在 `ProbeClipmapUpdateScheduler`（classify
 *   dynamic/dirty + 距离排序 + LEVEL_WHEEL）。本模块的推演复刻同一排序语义
 *   （脏类按距相机距离升序、同距按下标），用于 CPU 收敛推演，不替代调度器。
 * - 灯光 revision → 影响域：灯光不在 ProbeSurfaceCache 里，本模块提供
 *   `lightInfluenceBounds`（点光半径 → AABB），与 surface 脏域走同一脏探针推导。
 *
 * == 推演口径（诚实边界） ==
 * 每帧把最多 budget 个陈旧探针直接刷新为目标真值（假设刷新即精确、脏分类无浪费），
 * 这是收敛速度的乐观上界；"1 秒内收敛"是 60fps 帧预算推演，不是 GPU 实测。
 */

/** 灯光影响域：点光源半径球的最小包围 AABB。radius 必须有限正值。 */
export function lightInfluenceBounds(center: ProbeVector3, radius: number): ProbeAabb {
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError("Light influence radius must be finite and positive.");
  if (center.length !== 3 || center.some(value => !Number.isFinite(value))) {
    throw new RangeError("Light influence center must be finite XYZ.");
  }
  return Object.freeze({ min: Object.freeze(center.map(value => value - radius)) as ProbeVector3,
    max: Object.freeze(center.map(value => value + radius)) as ProbeVector3 });
}

/**
 * 脏探针最小集：格点位置落在任一脏 AABB 内（含边界，与调度器 pointInside 同语义）→
 * 按线性下标升序去重输出。位置向量必须三维有限。
 */
export function deriveDirtyProbeIndices(positions: readonly ProbeVector3[],
  bounds: readonly ProbeAabb[]): readonly number[] {
  positions.forEach((position, index) => {
    if (position.length !== 3 || position.some(value => !Number.isFinite(value))) {
      throw new RangeError(`Probe position ${index} must be finite XYZ.`);
    }
  });
  const dirty: number[] = [];
  for (let index = 0; index < positions.length; index++) {
    const position = positions[index]!;
    if (bounds.some(box => pointInside(position, box))) dirty.push(index);
  }
  return Object.freeze(dirty);
}

function pointInside(point: ProbeVector3, box: ProbeAabb): boolean {
  return point.every((value, axis) => value >= box.min[axis]! && value <= box.max[axis]!);
}

/** 全场归一化 RMSE：sqrt(mean‖stored−target‖₂²) / mean‖target‖₂；indices 限定统计域。 */
export function computeNormalizedFieldRmse(stored: readonly ProbeVector3[],
  target: readonly ProbeVector3[], indices?: readonly number[]): number {
  const domain = indices ?? stored.map((_, index) => index);
  let squareSum = 0, referenceSum = 0;
  for (const index of domain) {
    const left = stored[index], right = target[index];
    if (!left || !right || left.length !== 3 || right.length !== 3
      || ![...left, ...right].every(Number.isFinite)) {
      throw new RangeError(`Field RMSE probe ${index} vectors are invalid.`);
    }
    squareSum += left.reduce((sum, value, axis) => sum + (value - right[axis]!) ** 2, 0);
    referenceSum += Math.hypot(right[0], right[1], right[2]);
  }
  if (domain.length === 0) return 0;
  const denominator = referenceSum / domain.length;
  return denominator > 0 ? Math.sqrt(squareSum / domain.length) / denominator : 0;
}

export interface BudgetedRecoveryInput {
  /** 探针格点位置（与 stored/target 同序；排序只读）。 */
  readonly positions: readonly ProbeVector3[];
  /** 变化后的陈旧场（消费端当前看到）。 */
  readonly stale: readonly ProbeVector3[];
  /** 变化后的目标真值场（刷新即达）。 */
  readonly target: readonly ProbeVector3[];
  /** 脏探针下标（deriveDirtyProbeIndices 输出）。 */
  readonly dirtyIndices: readonly number[];
  /** 相机位置（调度器同款距离优先）。 */
  readonly camera: ProbeVector3;
}
export interface BudgetedRecoveryOptions {
  /** 每帧刷新探针数上限（≥1 整数）。 */
  readonly budget: number;
  readonly fps?: number;
  /** 归一化 RMSE 容差（默认 0.10 = 验收 10%）。 */
  readonly tolerance?: number;
  /** 防呆上限帧数（默认 4096）。 */
  readonly maxFrames?: number;
}
export interface RecoveryFrameRecord {
  readonly frame: number;
  readonly updatedThisFrame: number;
  readonly cumulativeUpdated: number;
  readonly normalizedRmse: number;
}
export interface BudgetedRecoveryResult {
  readonly budget: number;
  readonly fps: number;
  readonly tolerance: number;
  readonly dirtyCount: number;
  /** 第 0 帧记录初值 RMSE，其后每帧一条。 */
  readonly frames: readonly RecoveryFrameRecord[];
  readonly framesToTolerance?: number;
  readonly secondsToTolerance?: number;
  readonly converged: boolean;
  readonly maxUpdatesPerFrame: number;
}

/**
 * 固定预算档下的失效恢复推演：每帧按调度器语义（脏类 → 距相机升序 → 下标序）刷新最多
 * budget 个陈旧探针，逐帧输出归一化 RMSE 曲线，直到容差或 maxFrames。
 */
export function simulateBudgetedRecovery(input: BudgetedRecoveryInput,
  options: BudgetedRecoveryOptions): BudgetedRecoveryResult {
  const { positions, stale, target, dirtyIndices, camera } = input;
  const budget = options.budget;
  const fps = options.fps ?? 60;
  const tolerance = options.tolerance ?? 0.10;
  const maxFrames = options.maxFrames ?? 4096;
  if (!Number.isSafeInteger(budget) || budget < 1) throw new RangeError("Recovery budget must be a positive integer.");
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError("Recovery fps must be finite and positive.");
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new RangeError("Recovery tolerance must be finite and positive.");
  if (positions.length !== stale.length || stale.length !== target.length) {
    throw new RangeError("Budgeted recovery requires equal-length positions/stale/target fields.");
  }
  const order = [...new Set(dirtyIndices)].sort((left, right) =>
    squaredDistance(positions[left]!, camera) - squaredDistance(positions[right]!, camera) || left - right);
  const pending = new Set(order);
  const working = stale.map(vector => Object.freeze([...vector]) as ProbeVector3);
  const frames: RecoveryFrameRecord[] = [];
  let cumulative = 0, framesToTolerance: number | undefined, maxUpdatesPerFrame = 0;
  const record = (frame: number, updated: number): void => {
    maxUpdatesPerFrame = Math.max(maxUpdatesPerFrame, updated);
    // 收敛度量取脏域（发生变化的探针集）：这是比全场更严格的口径——局部变化不会被
    // 大分母稀释。
    frames.push(Object.freeze({ frame, updatedThisFrame: updated, cumulativeUpdated: cumulative,
      normalizedRmse: computeNormalizedFieldRmse(working, target, order) }));
  };
  record(0, 0);
  for (let frame = 1; frame <= maxFrames && pending.size > 0; frame++) {
    let updated = 0;
    for (const index of order) {
      if (updated >= budget) break;
      if (!pending.has(index)) continue;
      working[index] = target[index]!;
      pending.delete(index);
      updated += 1;
    }
    cumulative += updated;
    record(frame, updated);
    if (frames[frames.length - 1]!.normalizedRmse <= tolerance) { framesToTolerance = frame; break; }
  }
  const last = frames[frames.length - 1]!;
  return Object.freeze({ budget, fps, tolerance, dirtyCount: order.length, frames: Object.freeze(frames),
    ...(framesToTolerance === undefined ? {} : { framesToTolerance,
      secondsToTolerance: framesToTolerance / fps }),
    converged: last.normalizedRmse <= tolerance, maxUpdatesPerFrame });
}

/** 闭式预算下限：budget ≥ ceil(dirtyCount / (fps·seconds)) 时推演保证 1 秒内清空脏集。 */
export function minimumFrameBudget(dirtyCount: number, fps = 60, toleranceSeconds = 1): number {
  if (!Number.isSafeInteger(dirtyCount) || dirtyCount < 0) throw new RangeError("dirtyCount must be a nonnegative integer.");
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(toleranceSeconds) || toleranceSeconds <= 0) {
    throw new RangeError("minimumFrameBudget fps/toleranceSeconds must be finite and positive.");
  }
  return Math.ceil(dirtyCount / (fps * toleranceSeconds));
}

function squaredDistance(point: ProbeVector3, other: ProbeVector3): number {
  return point.reduce((sum, value, axis) => sum + (value - other[axis]!) ** 2, 0);
}
