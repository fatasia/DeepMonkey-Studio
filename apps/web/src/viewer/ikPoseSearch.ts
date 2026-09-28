import * as THREE from "three";
import {
  effectorWorldPosition,
  isFreeJoint,
  poseFromRecord,
  poseManipulability,
  poseToRecord,
  resolvePoseValues,
  skeletonFK,
  solveSkeletonIK,
  type IKEffector,
  type IKSkeleton,
} from "./ikSkeleton";

/**
 * 确定性姿态搜索:以"末端误差 + 接近偏好 + 限位罚项(+ 可选避奇异)"为代价函数,
 * 在确定性网格种子 + 调用方种子上做多起点精修,输出按代价升序的完整解序列。
 * 工业语境:机械臂在多个可达解中按最短行程/避奇异选解。
 * 全流程无随机源、固定遍历顺序:同输入产生逐位一致的解序,可直接与小数据库暴力检索对拍。
 */

export interface PoseSearchWeights {
  /** 末端位置误差(米)的权重,作用于误差平方项。 */
  position?: number;
  /** 接近偏好的权重,作用于与基准姿态的 L2 距离平方。 */
  proximity?: number;
  /** 限位罚项权重,作用于越限量平方和。 */
  limit?: number;
  /** 避奇异权重;非 0 时代价包含 1/(可操作度+ε)。缺省 0(不计算,省一次雅可比)。 */
  singularity?: number;
}

export interface PoseSearchOptions {
  weights?: PoseSearchWeights;
  /** 接近偏好基准(如当前行程姿态),关节名 → SI 值;缺省不启用接近项。 */
  preferredPose?: Record<string, number>;
  /** 调用方补充种子(如历史解、数据库姿态);与网格种子合并去重。 */
  seeds?: Record<string, number>[];
  /** 每个种子的 IK 精修全局迭代数;0 = 不精修(纯暴力检索)。缺省 12。 */
  refinementIterations?: number;
  /** 网格种子数量上限(不含零姿态与调用方种子)。缺省 64。 */
  maxSeeds?: number;
  /** 每个自由关节的网格采样数(1..5)。缺省 3(下界/中位/上界)。 */
  samplesPerJoint?: number;
}

export interface PoseCostBreakdown {
  /** 末端位置误差(米),原始值便于验收口径(≤臂长 0.5%)。 */
  positionError: number;
  /** 与基准姿态的 L2 距离(弧度/米混合空间);无基准时为 0。 */
  proximity: number;
  /** 越限量平方和;限内姿态恒为 0。 */
  limitPenalty: number;
  /** 避奇异代价 1/(w+ε);未启用时为 0。 */
  singularity: number;
  /** 加权总代价,排序主键。 */
  total: number;
}

export interface RankedPoseSolution {
  /** 关节名 → SI 值的完整目标姿态(fixed 不含)。 */
  values: Record<string, number>;
  cost: PoseCostBreakdown;
}

const DEFAULT_WEIGHTS: Required<PoseSearchWeights> = { position: 1, proximity: 0.1, limit: 100, singularity: 0 };
const SINGULARITY_EPSILON = 1e-9;

function resolvedWeights(options: PoseSearchOptions): Required<PoseSearchWeights> {
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  for (const [name, value] of Object.entries(weights)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`姿态搜索权重 ${name} 必须是非负有限数值`);
  }
  return weights;
}

function freeJointIndices(skeleton: IKSkeleton): number[] {
  const indices: number[] = [];
  for (let index = 0; index < skeleton.nodes.length; index++) {
    if (isFreeJoint(skeleton.nodes[index]!)) indices.push(index);
  }
  return indices;
}

/** 单个姿态的代价分解;候选越限不报错(罚项表达),但 NaN/未知关节显式报错。 */
export function evaluatePoseCost(
  skeleton: IKSkeleton,
  effector: IKEffector,
  target: THREE.Vector3,
  candidate: Record<string, number>,
  options: PoseSearchOptions = {},
): PoseCostBreakdown {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
    throw new Error("姿态搜索目标位置必须有限");
  }
  const weights = resolvedWeights(options);
  const pose = poseFromRecord(skeleton, candidate);
  const values = resolvePoseValues(skeleton, pose);
  const free = freeJointIndices(skeleton);
  const world = skeletonFK(skeleton, values);
  const positionError = effectorWorldPosition(world, skeleton, effector).distanceTo(target);
  let proximity = 0;
  if (options.preferredPose) {
    const preferred = poseFromRecord(skeleton, options.preferredPose);
    const preferredValues = resolvePoseValues(skeleton, preferred);
    let sum = 0;
    for (const index of free) {
      const difference = values[index]! - preferredValues[index]!;
      sum += difference * difference;
    }
    proximity = Math.sqrt(sum);
  }
  let limitPenalty = 0;
  for (const index of free) {
    const node = skeleton.nodes[index]!;
    if (!node.limits) continue;
    const value = values[index]!;
    const excess = Math.max(0, node.limits.lower - value, value - node.limits.upper);
    limitPenalty += excess * excess;
  }
  let singularity = 0;
  if (weights.singularity > 0) {
    singularity = 1 / (poseManipulability(skeleton, values, effector) + SINGULARITY_EPSILON);
  }
  const total =
    weights.position * positionError * positionError +
    weights.proximity * proximity * proximity +
    weights.limit * limitPenalty +
    weights.singularity * singularity;
  return { positionError, proximity, limitPenalty, singularity, total };
}

/** 按总代价升序排序,同代价按自由关节值字典序破并列:任何输入都有唯一确定序。 */
export function rankPoseCandidates(
  skeleton: IKSkeleton,
  effector: IKEffector,
  target: THREE.Vector3,
  candidates: readonly Record<string, number>[],
  options: PoseSearchOptions = {},
): RankedPoseSolution[] {
  const free = freeJointIndices(skeleton);
  const scored = candidates.map(candidate => {
    const full = poseFromRecord(skeleton, candidate);
    return {
      vector: free.map(index => full[index]!),
      entry: { values: poseToRecord(skeleton, full), cost: evaluatePoseCost(skeleton, effector, target, candidate, options) },
    };
  });
  scored.sort((left, right) => {
    if (left.entry.cost.total !== right.entry.cost.total) return left.entry.cost.total - right.entry.cost.total;
    for (let index = 0; index < free.length; index++) {
      const difference = left.vector[index]! - right.vector[index]!;
      if (difference !== 0) return difference;
    }
    return 0;
  });
  return scored.map(item => item.entry);
}

/** 生成确定性网格种子:限位内均匀采样(无限制关节取 [-π/2, π/2]),笛卡尔积按字典序,超上限等距抽稀。 */
function gridSeeds(skeleton: IKSkeleton, options: PoseSearchOptions): number[][] {
  const free = freeJointIndices(skeleton);
  const samplesPerJoint = Math.floor(options.samplesPerJoint ?? 3);
  if (!Number.isInteger(samplesPerJoint) || samplesPerJoint < 1 || samplesPerJoint > 5) {
    throw new Error("samplesPerJoint 必须是 1..5 的整数");
  }
  const maxSeeds = Math.floor(options.maxSeeds ?? 64);
  if (!Number.isInteger(maxSeeds) || maxSeeds < 1) throw new Error("maxSeeds 必须是正整数");
  const axes = free.map(index => {
    const node = skeleton.nodes[index]!;
    const lower = node.limits ? node.limits.lower : -Math.PI / 2;
    const upper = node.limits ? node.limits.upper : Math.PI / 2;
    const axis: number[] = [];
    for (let sample = 0; sample < samplesPerJoint; sample++) {
      axis.push(upper === lower ? lower : lower + ((upper - lower) * sample) / (samplesPerJoint - 1));
    }
    return axis;
  });
  if (free.length === 0) return [[]];
  const total = axes.reduce((product, axis) => product * axis.length, 1);
  const stride = Math.max(1, Math.ceil(total / maxSeeds));
  const seeds: number[][] = [];
  const vector = new Array<number>(free.length).fill(0);
  // 按字典序枚举,仅保留序号能被步长整除的组合:与全量枚举的等距抽样一致且不指数展开。
  const emit = (dimension: number, prefixIndex: number): void => {
    if (dimension === free.length) {
      if (prefixIndex % stride === 0) seeds.push([...vector]);
      return;
    }
    const axis = axes[dimension]!;
    for (let sample = 0; sample < axis.length; sample++) {
      vector[dimension] = axis[sample]!;
      emit(dimension + 1, prefixIndex * axis.length + sample);
    }
  };
  emit(0, 0);
  return seeds;
}

/**
 * 多起点姿态搜索:零姿态 + 调用方种子 + 确定性网格 → 逐种子精修(或原样保留)→
 * 统一排序。候选含原始种子与精修结果,搜索质量恒不低于对同一种子的纯暴力检索。
 */
export function searchPoses(
  skeleton: IKSkeleton,
  effector: IKEffector,
  target: THREE.Vector3,
  options: PoseSearchOptions = {},
): RankedPoseSolution[] {
  const refinement = Math.floor(options.refinementIterations ?? 12);
  if (!Number.isInteger(refinement) || refinement < 0 || refinement > 512) {
    throw new Error("refinementIterations 必须是 0..512 的整数");
  }
  const free = freeJointIndices(skeleton);
  // 种子统一为自由关节稠密向量,与网格种子同构。
  const seeds: number[][] = [new Array<number>(free.length).fill(0)];
  for (const seed of options.seeds ?? []) {
    const full = poseFromRecord(skeleton, seed);
    seeds.push(free.map(index => full[index]!));
  }
  seeds.push(...gridSeeds(skeleton, options));
  const seen = new Set<string>();
  const candidates: Record<string, number>[] = [];
  const push = (vector: readonly number[]): void => {
    const key = vector.map(value => value.toFixed(12)).join(",");
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(poseToRecord(skeleton, padSeed(skeleton, vector, free)));
  };
  for (const seed of seeds) {
    push(seed);
    if (refinement > 0) {
      const refined = solveSkeletonIK(skeleton, [{ effector, position: target }], {
        globalIterations: refinement,
        initialPose: padSeed(skeleton, seed, free),
      });
      push(refined.pose);
    }
  }
  return rankPoseCandidates(skeleton, effector, target, candidates, options);
}

/** 网格种子是自由关节稠密向量,补齐 fixed/mimic 位后才能作为初始姿态。 */
function padSeed(skeleton: IKSkeleton, seed: readonly number[], free: readonly number[]): number[] {
  const padded = new Array<number>(skeleton.nodes.length).fill(0);
  for (let position = 0; position < free.length; position++) padded[free[position]!] = seed[position] ?? 0;
  return padded;
}
