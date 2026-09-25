import type {
  Vector3Value,
  WorkcellAuditFinding,
  WorkcellAuditObject,
  WorkcellAvoidanceCandidate,
  WorkcellBounds,
  WorkcellRobotScheduleConflict,
  WorkcellRobotTrajectory,
  WorkcellTrajectorySegmentCheck,
  WorkcellTrajectoryWaypoint,
} from "@bim-studio/contracts";

export interface PreparedTrajectorySegment {
  trajectory: WorkcellRobotTrajectory;
  id: string;
  start: WorkcellTrajectoryWaypoint;
  end: WorkcellTrajectoryWaypoint;
  radius: number;
  tolerance: number;
  timeTolerance: number;
}

export function buildSegmentChecks(
  segments: PreparedTrajectorySegment[],
  obstacles: WorkcellAuditObject[],
  clearance: number,
  findings: WorkcellAuditFinding[],
): WorkcellTrajectorySegmentCheck[] {
  return segments.map((segment) => {
    const potentialObstacleIds = obstacles
      .filter((object) => object.id !== segment.trajectory.robotId)
      .filter((object) => segmentIntersectsExpandedBounds(segment.start.position, segment.end.position, object.bounds!, segment.radius + segment.tolerance + clearance))
      .map((object) => object.id)
      .sort();
    if (potentialObstacleIds.length) findings.push(finding(
      `trajectory-conflict-${segment.id}`,
      "trajectory",
      "warning",
      "轨迹广相位存在潜在冲突",
      `${segment.id} 的连续 TCP 包围球可能进入 ${potentialObstacleIds.join("、")} 的扩张 AABB；这是保守初筛，不是网格精确碰撞。`,
      [segment.trajectory.robotId, ...potentialObstacleIds],
      "复核避障候选并进入网格级离线仿真",
    ));
    return {
      trajectoryId: segment.trajectory.id,
      segmentId: segment.id,
      startTimeSec: segment.start.timeSec,
      endTimeSec: segment.end.timeSec,
      lengthMeters: vectorDistance(segment.start.position, segment.end.position),
      potentialObstacleIds,
    };
  });
}

export function buildAvoidanceCandidates(
  segments: PreparedTrajectorySegment[],
  checks: WorkcellTrajectorySegmentCheck[],
  obstacles: WorkcellAuditObject[],
  clearance: number,
): WorkcellAvoidanceCandidate[] {
  const bySegment = new Map(segments.map((item) => [item.id, item]));
  const byObstacle = new Map(obstacles.map((item) => [item.id, item]));
  return checks.flatMap((check) => check.potentialObstacleIds.slice(0, 10).map((obstacleId) => {
    const segment = bySegment.get(check.segmentId)!;
    const obstacle = byObstacle.get(obstacleId)!;
    const margin = segment.radius + segment.tolerance + clearance;
    const waypoints = detourWaypoints(segment.start.position, segment.end.position, obstacle.bounds!, margin + 0.001);
    const path = [segment.start.position, ...waypoints, segment.end.position];
    const blocked = path.slice(1).some((end, index) => obstacles
      .filter((item) => item.id !== segment.trajectory.robotId)
      .some((item) => segmentIntersectsExpandedBounds(path[index]!, end, item.bounds!, margin)));
    const status = blocked ? "no-simple-candidate" as const : "candidate-found" as const;
    return {
      trajectoryId: check.trajectoryId,
      segmentId: check.segmentId,
      obstacleId,
      status,
      waypoints: status === "candidate-found" ? waypoints : [],
      ...(status === "candidate-found" ? { addedDistanceMeters: pathLength(path) - vectorDistance(segment.start.position, segment.end.position) } : {}),
      declaration: status === "candidate-found"
        ? "候选仅通过相同 TCP 包围球/AABB 广相位复核，尚未检查关节可达、姿态、奇异点、连杆或动力学。"
        : "固定两折线策略未找到可通过广相位的候选；不代表完整路径规划无解。",
    };
  })).slice(0, 100);
}

export function buildScheduleConflicts(
  segments: PreparedTrajectorySegment[],
  clearance: number,
  findings: WorkcellAuditFinding[],
): WorkcellRobotScheduleConflict[] {
  const conflicts: WorkcellRobotScheduleConflict[] = [];
  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      const left = segments[leftIndex]!;
      const right = segments[rightIndex]!;
      if (left.trajectory.robotId === right.trajectory.robotId) continue;
      // 时间容差扩张活动窗口；位置插值在段外钳制到端点，保持保守结论。
      const startTimeSec = Math.max(left.start.timeSec - left.timeTolerance, right.start.timeSec - right.timeTolerance);
      const endTimeSec = Math.min(left.end.timeSec + left.timeTolerance, right.end.timeSec + right.timeTolerance);
      if (endTimeSec <= startTimeSec) continue;
      const closest = closestTcpApproach(left, right, startTimeSec, endTimeSec);
      // 线性段内以“段速度 × 时间容差”扩张空间裕量，覆盖允许的提前/滞后执行偏差。
      const timingMargin = segmentSpeed(left) * left.timeTolerance + segmentSpeed(right) * right.timeTolerance;
      const requiredDistanceMeters = left.radius + left.tolerance + right.radius + right.tolerance + timingMargin + clearance;
      if (closest.distance > requiredDistanceMeters) continue;
      conflicts.push({
        trajectoryIds: [left.trajectory.id, right.trajectory.id],
        robotIds: [left.trajectory.robotId, right.trajectory.robotId],
        segmentIds: [left.id, right.id],
        startTimeSec,
        endTimeSec,
        closestTimeSec: closest.time,
        minimumTcpDistanceMeters: closest.distance,
        requiredDistanceMeters,
      });
    }
  }
  if (conflicts.length) findings.push(finding(
    "multi-robot-schedule-conflict",
    "schedule",
    "warning",
    "多机器人存在时间段空间冲突",
    `${conflicts.length} 个重叠时间段内，连续 TCP 包围球最小距离低于声明间隙。`,
    [...new Set(conflicts.flatMap((item) => item.robotIds))],
    "错开时间段或复核避让轨迹后重新运行",
  ));
  return conflicts.slice(0, 500);
}

function closestTcpApproach(left: PreparedTrajectorySegment, right: PreparedTrajectorySegment, start: number, end: number) {
  const boundaries = [...new Set([
    start,
    end,
    left.start.timeSec,
    left.end.timeSec,
    right.start.timeSec,
    right.end.timeSec,
  ].filter((time) => time >= start && time <= end))].sort((a, b) => a - b);
  let closest = { distance: Number.POSITIVE_INFINITY, time: start };
  for (let index = 1; index < boundaries.length; index += 1) {
    const intervalStart = boundaries[index - 1]!;
    const intervalEnd = boundaries[index]!;
    const relativeStart = subtract(positionAt(left, intervalStart), positionAt(right, intervalStart));
    const relativeEnd = subtract(positionAt(left, intervalEnd), positionAt(right, intervalEnd));
    const relativeDelta = subtract(relativeEnd, relativeStart);
    const denominator = dot(relativeDelta, relativeDelta);
    const ratio = denominator > 1e-12 ? clamp(-dot(relativeStart, relativeDelta) / denominator, 0, 1) : 0;
    const distance = length(add(relativeStart, scale(relativeDelta, ratio)));
    const time = intervalStart + (intervalEnd - intervalStart) * ratio;
    if (distance < closest.distance - 1e-12 || (Math.abs(distance - closest.distance) <= 1e-12 && time < closest.time)) {
      closest = { distance, time };
    }
  }
  return closest;
}

function detourWaypoints(start: Vector3Value, end: Vector3Value, bounds: WorkcellBounds, margin: number): Vector3Value[] {
  const xDominant = Math.abs(end.x - start.x) >= Math.abs(end.z - start.z);
  const middleY = (start.y + end.y) / 2;
  if (xDominant) {
    const direction = end.x >= start.x ? 1 : -1;
    const side = closestSide((start.z + end.z) / 2, bounds.min.z - margin, bounds.max.z + margin);
    return [
      { x: direction > 0 ? bounds.min.x - margin : bounds.max.x + margin, y: middleY, z: side },
      { x: direction > 0 ? bounds.max.x + margin : bounds.min.x - margin, y: middleY, z: side },
    ];
  }
  const direction = end.z >= start.z ? 1 : -1;
  const side = closestSide((start.x + end.x) / 2, bounds.min.x - margin, bounds.max.x + margin);
  return [
    { x: side, y: middleY, z: direction > 0 ? bounds.min.z - margin : bounds.max.z + margin },
    { x: side, y: middleY, z: direction > 0 ? bounds.max.z + margin : bounds.min.z - margin },
  ];
}

/** 导出供 kinematics 轨迹规划逐点复用;语义与实现保持不变,禁止在别处重写碰撞几何。 */
export function segmentIntersectsExpandedBounds(start: Vector3Value, end: Vector3Value, bounds: WorkcellBounds, margin: number): boolean {
  let lower = 0, upper = 1;
  for (const axis of ["x", "y", "z"] as const) {
    const delta = end[axis] - start[axis];
    const minimum = bounds.min[axis] - margin;
    const maximum = bounds.max[axis] + margin;
    if (Math.abs(delta) < 1e-12) {
      if (start[axis] < minimum || start[axis] > maximum) return false;
      continue;
    }
    const first = (minimum - start[axis]) / delta;
    const second = (maximum - start[axis]) / delta;
    lower = Math.max(lower, Math.min(first, second));
    upper = Math.min(upper, Math.max(first, second));
    if (lower > upper) return false;
  }
  return true;
}

function positionAt(segment: PreparedTrajectorySegment, time: number): Vector3Value {
  const ratio = clamp((time - segment.start.timeSec) / (segment.end.timeSec - segment.start.timeSec), 0, 1);
  return add(segment.start.position, scale(subtract(segment.end.position, segment.start.position), ratio));
}

function segmentSpeed(segment: PreparedTrajectorySegment): number {
  return vectorDistance(segment.start.position, segment.end.position) / (segment.end.timeSec - segment.start.timeSec);
}

function finding(id: string, category: WorkcellAuditFinding["category"], severity: WorkcellAuditFinding["severity"], title: string, detail: string, objectIds: string[], nextAction: string): WorkcellAuditFinding {
  return { id, category, severity, title, detail, objectIds: [...new Set(objectIds)], nextAction };
}
function vectorDistance(left: Vector3Value, right: Vector3Value): number { return length(subtract(left, right)); }
function pathLength(points: Vector3Value[]): number { return points.slice(1).reduce((total, point, index) => total + vectorDistance(points[index]!, point), 0); }
function closestSide(value: number, lower: number, upper: number): number { return Math.abs(value - lower) <= Math.abs(value - upper) ? lower : upper; }
function add(left: Vector3Value, right: Vector3Value): Vector3Value { return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z }; }
function subtract(left: Vector3Value, right: Vector3Value): Vector3Value { return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z }; }
function scale(value: Vector3Value, factor: number): Vector3Value { return { x: value.x * factor, y: value.y * factor, z: value.z * factor }; }
function dot(left: Vector3Value, right: Vector3Value): number { return left.x * right.x + left.y * right.y + left.z * right.z; }
function length(value: Vector3Value): number { return Math.hypot(value.x, value.y, value.z); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
