import type { Vector3Value, WorkcellBounds, WorkcellRobotChain } from "@bim-studio/contracts";
import { forwardKinematics, solveIk } from "./kinematics.js";
import { segmentIntersectsExpandedBounds } from "./trajectoryGeometry.js";

export interface TrajectoryObstacle {
  id: string;
  bounds: WorkcellBounds;
}

export interface PlanTrajectoryOptions {
  obstacles?: TrajectoryObstacle[];
  /** 间隙阈值只对显式声明的值生效;未声明时只输出最小间距,不出通过/违规结论。 */
  clearanceMeters?: number;
  seedAngles?: number[];
}

export interface TrajectoryPlanViolation {
  /** waypointsTcp 的索引;段级违规(间隙)记段起点索引。 */
  index: number;
  kind: "unreachable" | "joint-limit" | "clearance" | "self-clearance";
  /** IK 失败时为 TCP 位置残差;间距违规为实际距离(distanceMeters 的同义证据)。 */
  residualMeters?: number;
  obstacleId?: string;
}

export interface TrajectoryPlan {
  ok: boolean;
  /** 与 waypointsTcp 等长;IK 失败点为空数组,禁止用猜测角充数。 */
  jointPath: number[][];
  /** 与成功段一一对应(按序,不含失败段);时长为关节空间逐段匀速上限。 */
  segmentDurations: number[];
  totalCycleSeconds: number;
  violations: TrajectoryPlanViolation[];
  /** 未声明 maxSpeedDegPerSec 的关节如实标注,不参与节拍约束。 */
  unlimitedJointIds: string[];
  minimumEnvironmentClearanceMeters?: number;
  minimumSelfClearanceMeters?: number;
}

/**
 * 业务约束:TCP 路径点 → 逐点 IK → 关节空间逐段匀速上限(梯形的简化:
 * 不含加减速时间,节拍偏乐观,不能替代控制器轴参数);相邻段时长 = max(关节位移/关节速度)。
 * 碰撞判定完全复用 trajectoryGeometry 的扩张 AABB 几何,本文件不重写碰撞。
 */
export function planTrajectory(chain: WorkcellRobotChain, waypointsTcp: Vector3Value[], options: PlanTrajectoryOptions = {}): TrajectoryPlan {
  const violations: TrajectoryPlanViolation[] = [];
  const jointPath: number[][] = [];
  const configurations: Vector3Value[][] = [];
  for (let index = 0; index < waypointsTcp.length; index += 1) {
    const target = waypointsTcp[index]!;
    if (!isFiniteVector(target)) {
      violations.push({ index, kind: "unreachable", residualMeters: Number.POSITIVE_INFINITY });
      jointPath.push([]);
      configurations.push([]);
      continue;
    }
    const ik = solveIk(chain, target, options.seedAngles);
    if (!ik.ok) {
      // 限位内无解但无限位可达 → 记 joint-limit;两者都不可达才记 unreachable。
      const relaxed = solveIk(relaxJointLimits(chain), target, options.seedAngles);
      violations.push({ index, kind: relaxed.ok ? "joint-limit" : "unreachable", residualMeters: ik.residualMeters });
      jointPath.push([]);
      configurations.push([]);
      continue;
    }
    jointPath.push(ik.angles);
    configurations.push(forwardKinematics(chain, ik.angles).positions);
  }

  const unlimitedJointIds = chain.links.filter((link) => link.maxSpeedDegPerSec === undefined).map((link) => link.id);
  const segmentDurations: number[] = [];
  for (let index = 0; index + 1 < jointPath.length; index += 1) {
    const start = jointPath[index]!;
    const end = jointPath[index + 1]!;
    if (!start.length || !end.length) continue;
    let duration = 0;
    for (let joint = 0; joint < chain.links.length; joint += 1) {
      const speed = chain.links[joint]!.maxSpeedDegPerSec;
      if (speed === undefined || !Number.isFinite(speed) || speed <= 0) continue;
      duration = Math.max(duration, Math.abs(end[joint]! - start[joint]!) / speed);
    }
    segmentDurations.push(duration);
  }

  const clearance = finiteNonNegative(options.clearanceMeters);
  const obstacles = options.obstacles ?? [];
  let minimumEnvironment: number | undefined;
  let minimumSelf: number | undefined;
  for (let index = 0; index + 1 < configurations.length; index += 1) {
    const start = configurations[index]!;
    const end = configurations[index + 1]!;
    if (!start.length || !end.length) continue;
    for (const obstacle of obstacles) {
      // TCP 弦(分段线性 TCP 广相位,与 trajectoryEngine 同语义)+ 两端构型全部连杆线段,取最小。
      const tcpStart = start[start.length - 1]!;
      const tcpEnd = end[end.length - 1]!;
      const distance = Math.min(
        chainSegmentsDistance(start, obstacle.bounds),
        chainSegmentsDistance(end, obstacle.bounds),
        segmentIntersectsExpandedBounds(tcpStart, tcpEnd, obstacle.bounds, 0)
          ? 0
          : sampledSegmentDistance(tcpStart, tcpEnd, obstacle.bounds),
      );
      minimumEnvironment = minimumEnvironment === undefined ? distance : Math.min(minimumEnvironment, distance);
      if (clearance !== undefined && distance < clearance)
        violations.push({ index, kind: "clearance", residualMeters: distance, obstacleId: obstacle.id });
    }
    // 自碰只看非相邻连杆对(相邻对共享端点恒为接触);两端构型取更差值。
    // 线段模型无连杆实体半径,伸直/共线构型的非相邻接触记 0 属模型退化,
    // 该数值仅供上层结合连杆实体判读,不构成自碰通过结论。
    const startSelf = chainSelfClearance(start);
    const endSelf = chainSelfClearance(end);
    const selfDistance = startSelf === undefined ? endSelf
      : endSelf === undefined ? startSelf
        : Math.min(startSelf, endSelf);
    if (selfDistance !== undefined) {
      minimumSelf = minimumSelf === undefined ? selfDistance : Math.min(minimumSelf, selfDistance);
      if (clearance !== undefined && selfDistance < clearance)
        violations.push({ index, kind: "self-clearance", residualMeters: selfDistance });
    }
  }

  return {
    // 空路径点不是"无违规",不能产出通过结论。
    ok: violations.length === 0 && jointPath.length > 0,
    jointPath,
    segmentDurations,
    totalCycleSeconds: segmentDurations.reduce((total, value) => total + value, 0),
    violations,
    unlimitedJointIds,
    ...(minimumEnvironment !== undefined ? { minimumEnvironmentClearanceMeters: minimumEnvironment } : {}),
    ...(minimumSelf !== undefined ? { minimumSelfClearanceMeters: minimumSelf } : {}),
  };
}

/** 线段到障碍 AABB 的欧氏距离:相交(既有几何判定)记 0;不相交时点-盒解析距离沿线段自适应采样并两轮细化(误差 <1e-5 m)。 */
function chainSegmentsDistance(points: Vector3Value[], bounds: WorkcellBounds): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const distance = segmentIntersectsExpandedBounds(start, end, bounds, 0)
      ? 0
      : sampledSegmentDistance(start, end, bounds);
    minimum = Math.min(minimum, distance);
  }
  return minimum;
}

function sampledSegmentDistance(start: Vector3Value, end: Vector3Value, bounds: WorkcellBounds): number {
  const span = length(subtract(end, start));
  const samples = Math.min(257, Math.max(9, Math.ceil(span / 0.02) + 2));
  let bestT = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 3; round += 1) {
    const lower = round === 0 ? 0 : Math.max(0, bestT - 1 / (samples - 1));
    const upper = round === 0 ? 1 : Math.min(1, bestT + 1 / (samples - 1));
    bestT = lower;
    bestDistance = Number.POSITIVE_INFINITY;
    for (let step = 0; step < samples; step += 1) {
      const t = lower + ((upper - lower) * step) / (samples - 1);
      const distance = pointBoundsDistance(add(start, scale(subtract(end, start), t)), bounds);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestT = t;
      }
    }
  }
  return bestDistance;
}

function pointBoundsDistance(point: Vector3Value, bounds: WorkcellBounds): number {
  const gapX = Math.max(bounds.min.x - point.x, 0, point.x - bounds.max.x);
  const gapY = Math.max(bounds.min.y - point.y, 0, point.y - bounds.max.y);
  const gapZ = Math.max(bounds.min.z - point.z, 0, point.z - bounds.max.z);
  return Math.hypot(gapX, gapY, gapZ);
}

function chainSelfClearance(points: Vector3Value[]): number | undefined {
  let minimum: number | undefined;
  for (let left = 0; left + 1 < points.length; left += 1) {
    for (let right = left + 2; right + 1 < points.length; right += 1) {
      const distance = segmentSegmentDistance(points[left]!, points[left + 1]!, points[right]!, points[right + 1]!);
      minimum = minimum === undefined ? distance : Math.min(minimum, distance);
    }
  }
  return minimum;
}

/** 非相邻连杆对的线段最近距离(标准 clamped 最近点);相邻对共享端点恒为接触不入检。 */
function segmentSegmentDistance(p1: Vector3Value, q1: Vector3Value, p2: Vector3Value, q2: Vector3Value): number {
  const d1 = subtract(q1, p1);
  const d2 = subtract(q2, p2);
  const r = subtract(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s = 0;
  let t = 0;
  if (a <= 1e-12 && e <= 1e-12) return length(r);
  if (a <= 1e-12) {
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-12) {
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const denominator = a * e - b * b;
      s = denominator > 1e-12 ? clamp01((b * f - c * e) / denominator) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const closest1 = add(p1, scale(d1, s));
  const closest2 = add(p2, scale(d2, t));
  return length(subtract(closest1, closest2));
}

function relaxJointLimits(chain: WorkcellRobotChain): WorkcellRobotChain {
  return { ...chain, links: chain.links.map((link) => ({ ...link, minAngleDeg: -360, maxAngleDeg: 360 })) };
}

function isFiniteVector(value: Vector3Value): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}
function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function subtract(left: Vector3Value, right: Vector3Value): Vector3Value { return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z }; }
function add(left: Vector3Value, right: Vector3Value): Vector3Value { return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z }; }
function scale(value: Vector3Value, factor: number): Vector3Value { return { x: value.x * factor, y: value.y * factor, z: value.z * factor }; }
function dot(left: Vector3Value, right: Vector3Value): number { return left.x * right.x + left.y * right.y + left.z * right.z; }
function length(value: Vector3Value): number { return Math.hypot(value.x, value.y, value.z); }
function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
