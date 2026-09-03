import type {
  Vector3Value,
  WorkcellRobotTrajectory,
  WorkcellTrajectoryAnalysis,
  WorkcellTrajectoryWaypoint,
} from "@bim-studio/contracts";

interface SourceSegment {
  trajectory: WorkcellRobotTrajectory;
  start: WorkcellTrajectoryWaypoint;
  end: WorkcellTrajectoryWaypoint;
  lengthMeters: number;
}

/** 拒绝把陈旧分析与当前轨迹拼成看似完整的交付包。 */
export function trajectoryEvidenceRelationshipIssue(
  trajectories: readonly WorkcellRobotTrajectory[],
  analysis: WorkcellTrajectoryAnalysis,
): string | undefined {
  const sourceById = new Map(trajectories.map((item) => [item.id, item]));
  const cycleTrajectoryIds = analysis.cycle.trajectories.map((item) => item.trajectoryId);
  if (new Set(cycleTrajectoryIds).size !== cycleTrajectoryIds.length) return "节拍证据包含重复轨迹 ID";
  const segments = new Map<string, SourceSegment>();
  for (const trajectory of sourceById.values()) trajectory.waypoints.slice(1).forEach((end, index) => {
    const start = trajectory.waypoints[index]!;
    segments.set(segmentKey(trajectory.id, `${trajectory.id}:${index}-${index + 1}`), {
      trajectory,
      start,
      end,
      lengthMeters: Math.hypot(end.position.x - start.position.x, end.position.y - start.position.y, end.position.z - start.position.z),
    });
  });
  const cycleIssue = cycleEvidenceIssue(sourceById, analysis);
  if (cycleIssue) return cycleIssue;
  for (const check of analysis.segmentChecks) {
    const segment = segments.get(segmentKey(check.trajectoryId, check.segmentId));
    if (!segment || !sameMeasurement(segment.start.timeSec, check.startTimeSec)
      || !sameMeasurement(segment.end.timeSec, check.endTimeSec)
      || !sameMeasurement(segment.lengthMeters, check.lengthMeters)) {
      return `轨迹段证据与关键帧不匹配：${check.trajectoryId}/${check.segmentId}`;
    }
  }
  for (const trajectoryId of cycleTrajectoryIds) {
    const trajectory = sourceById.get(trajectoryId)!;
    const expectedSegmentIds = trajectory.waypoints.slice(1).map((_, index) => `${trajectory.id}:${index}-${index + 1}`);
    const actualSegmentIds = analysis.segmentChecks.filter((item) => item.trajectoryId === trajectoryId).map((item) => item.segmentId);
    if (expectedSegmentIds.some((id) => !actualSegmentIds.includes(id)) || actualSegmentIds.length !== expectedSegmentIds.length) {
      return `轨迹段证据不完整：${trajectoryId}`;
    }
  }
  const jointIssue = jointEvidenceIssue(sourceById, analysis);
  if (jointIssue) return jointIssue;
  for (const candidate of analysis.avoidanceCandidates) {
    const matchingRisk = analysis.segmentChecks.some((item) => item.trajectoryId === candidate.trajectoryId
      && item.segmentId === candidate.segmentId && item.potentialObstacleIds.includes(candidate.obstacleId));
    if (!matchingRisk) return `避障候选缺少对应风险段：${candidate.trajectoryId}/${candidate.segmentId}`;
  }
  const scheduleIssue = scheduleEvidenceIssue(segments, analysis);
  if (scheduleIssue) return scheduleIssue;
  return undefined;
}

function jointEvidenceIssue(
  sourceById: Map<string, WorkcellRobotTrajectory>,
  analysis: WorkcellTrajectoryAnalysis,
): string | undefined {
  const checksByTrajectory = new Map<string, WorkcellTrajectoryAnalysis["jointChecks"]>();
  for (const check of analysis.jointChecks) {
    const checks = checksByTrajectory.get(check.trajectoryId) ?? [];
    checks.push(check);
    checksByTrajectory.set(check.trajectoryId, checks);
  }
  for (const [trajectoryId, checks] of checksByTrajectory) {
    const trajectory = sourceById.get(trajectoryId);
    if (!trajectory) return `关节证据与轨迹不匹配：${trajectoryId}`;
    const jointIndexById = new Map<string, number>();
    for (const check of checks) {
      if (!jointIndexById.has(check.jointId)) jointIndexById.set(check.jointId, jointIndexById.size);
    }
    const seen = new Set<string>();
    for (const check of checks) {
      const waypointIndex = trajectory.waypoints.findIndex((item) => item.id === check.waypointId);
      if (waypointIndex < 0) return `关节证据与关键帧不匹配：${check.trajectoryId}/${check.waypointId}`;
      const evidenceKey = `${check.waypointId}\u0000${check.jointId}`;
      if (seen.has(evidenceKey)) return `关节证据重复：${check.trajectoryId}/${check.waypointId}/${check.jointId}`;
      seen.add(evidenceKey);
      const jointIndex = jointIndexById.get(check.jointId)!;
      const waypoint = trajectory.waypoints[waypointIndex]!;
      const angle = waypoint.jointAnglesDeg?.[jointIndex];
      if (!sameOptionalMeasurement(angle, check.angleDeg)) {
        return `关节角证据与关键帧不匹配：${check.trajectoryId}/${check.waypointId}/${check.jointId}`;
      }
      const previous = trajectory.waypoints[waypointIndex - 1];
      const previousAngle = previous?.jointAnglesDeg?.[jointIndex];
      const inboundSpeed = previous && angle !== undefined && previousAngle !== undefined
        ? Math.abs(angle - previousAngle) / (waypoint.timeSec - previous.timeSec)
        : undefined;
      if (!sameOptionalMeasurement(inboundSpeed, check.inboundSpeedDegPerSec)) {
        return `关节速度证据与关键帧不匹配：${check.trajectoryId}/${check.waypointId}/${check.jointId}`;
      }
    }
  }
  return undefined;
}

function scheduleEvidenceIssue(
  segments: Map<string, SourceSegment>,
  analysis: WorkcellTrajectoryAnalysis,
): string | undefined {
  for (const conflict of analysis.scheduleConflicts) {
    const left = segments.get(segmentKey(conflict.trajectoryIds[0], conflict.segmentIds[0]));
    const right = segments.get(segmentKey(conflict.trajectoryIds[1], conflict.segmentIds[1]));
    if (!left || !right
      || left.trajectory.robotId !== conflict.robotIds[0]
      || right.trajectory.robotId !== conflict.robotIds[1]
      || left.trajectory.robotId === right.trajectory.robotId) {
      return `多机器人调度证据与轨迹段不匹配：${conflict.trajectoryIds.join("/")}`;
    }
    const startTimeSec = Math.max(
      left.start.timeSec - nonNegative(left.trajectory.precision?.timeToleranceSeconds),
      right.start.timeSec - nonNegative(right.trajectory.precision?.timeToleranceSeconds),
    );
    const endTimeSec = Math.min(
      left.end.timeSec + nonNegative(left.trajectory.precision?.timeToleranceSeconds),
      right.end.timeSec + nonNegative(right.trajectory.precision?.timeToleranceSeconds),
    );
    if (endTimeSec <= startTimeSec
      || !sameMeasurement(startTimeSec, conflict.startTimeSec)
      || !sameMeasurement(endTimeSec, conflict.endTimeSec)) {
      return `多机器人调度证据与轨迹段不匹配：${conflict.trajectoryIds.join("/")}`;
    }
    const closest = closestTcpApproach(left, right, startTimeSec, endTimeSec);
    if (!sameMeasurement(closest.timeSec, conflict.closestTimeSec)
      || !sameMeasurement(closest.distanceMeters, conflict.minimumTcpDistanceMeters)
      || conflict.minimumTcpDistanceMeters > conflict.requiredDistanceMeters + measurementTolerance(conflict.requiredDistanceMeters)) {
      return `多机器人最近点证据与当前轨迹不匹配：${conflict.trajectoryIds.join("/")}`;
    }
  }
  return undefined;
}

/** Mirrors the audit engine's deterministic piecewise-linear closest-approach calculation. */
function closestTcpApproach(left: SourceSegment, right: SourceSegment, startTimeSec: number, endTimeSec: number) {
  const boundaries = [...new Set([
    startTimeSec,
    endTimeSec,
    left.start.timeSec,
    left.end.timeSec,
    right.start.timeSec,
    right.end.timeSec,
  ].filter((time) => time >= startTimeSec && time <= endTimeSec))].sort((a, b) => a - b);
  let closest = { distanceMeters: Number.POSITIVE_INFINITY, timeSec: startTimeSec };
  for (let index = 1; index < boundaries.length; index += 1) {
    const intervalStart = boundaries[index - 1]!;
    const intervalEnd = boundaries[index]!;
    const relativeStart = subtract(positionAt(left, intervalStart), positionAt(right, intervalStart));
    const relativeEnd = subtract(positionAt(left, intervalEnd), positionAt(right, intervalEnd));
    const relativeDelta = subtract(relativeEnd, relativeStart);
    const denominator = dot(relativeDelta, relativeDelta);
    const ratio = denominator > 1e-12 ? clamp(-dot(relativeStart, relativeDelta) / denominator, 0, 1) : 0;
    const distanceMeters = Math.hypot(
      relativeStart.x + relativeDelta.x * ratio,
      relativeStart.y + relativeDelta.y * ratio,
      relativeStart.z + relativeDelta.z * ratio,
    );
    const timeSec = intervalStart + (intervalEnd - intervalStart) * ratio;
    if (distanceMeters < closest.distanceMeters - 1e-12
      || (Math.abs(distanceMeters - closest.distanceMeters) <= 1e-12 && timeSec < closest.timeSec)) {
      closest = { distanceMeters, timeSec };
    }
  }
  return closest;
}

function positionAt(segment: SourceSegment, timeSec: number): Vector3Value {
  const ratio = clamp((timeSec - segment.start.timeSec) / (segment.end.timeSec - segment.start.timeSec), 0, 1);
  return {
    x: segment.start.position.x + (segment.end.position.x - segment.start.position.x) * ratio,
    y: segment.start.position.y + (segment.end.position.y - segment.start.position.y) * ratio,
    z: segment.start.position.z + (segment.end.position.z - segment.start.position.z) * ratio,
  };
}

function cycleEvidenceIssue(
  sourceById: Map<string, WorkcellRobotTrajectory>,
  analysis: WorkcellTrajectoryAnalysis,
): string | undefined {
  const intervals: Array<{ start: number; end: number }> = [];
  for (const statistic of analysis.cycle.trajectories) {
    const trajectory = sourceById.get(statistic.trajectoryId);
    if (!trajectory || trajectory.robotId !== statistic.robotId) return `节拍证据与轨迹不匹配：${statistic.trajectoryId}`;
    const start = trajectory.waypoints[0]!.timeSec;
    const end = trajectory.waypoints.at(-1)!.timeSec;
    const duration = end - start;
    const pathLength = trajectory.waypoints.slice(1).reduce((total, waypoint, index) => {
      const previous = trajectory.waypoints[index]!;
      return total + Math.hypot(waypoint.position.x - previous.position.x, waypoint.position.y - previous.position.y, waypoint.position.z - previous.position.z);
    }, 0);
    const averageSpeed = duration > 0 ? pathLength / duration : 0;
    if (!sameMeasurement(duration, statistic.durationSec)
      || !sameMeasurement(pathLength, statistic.pathLengthMeters)
      || !sameMeasurement(averageSpeed, statistic.averageTcpSpeedMps)) {
      return `节拍证据与关键帧不匹配：${statistic.trajectoryId}`;
    }
    intervals.push({ start, end });
  }
  const scheduleSpan = intervals.length
    ? Math.max(...intervals.map((item) => item.end)) - Math.min(...intervals.map((item) => item.start))
    : 0;
  if (!sameMeasurement(scheduleSpan, analysis.cycle.scheduleSpanSec)) return "排程跨度与轨迹时序不匹配";
  if (maximumConcurrency(intervals) !== analysis.cycle.maxConcurrentRobots) return "最大并行机器人数量与轨迹时序不匹配";
  return undefined;
}

function maximumConcurrency(intervals: Array<{ start: number; end: number }>): number {
  const events = intervals.flatMap((item) => [{ time: item.start, delta: 1 }, { time: item.end, delta: -1 }])
    .sort((left, right) => left.time - right.time || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function sameMeasurement(left: number, right: number): boolean {
  return Math.abs(left - right) <= measurementTolerance(left, right);
}
function sameOptionalMeasurement(left: number | undefined, right: number | undefined): boolean {
  return left === undefined || right === undefined ? left === right : sameMeasurement(left, right);
}
function measurementTolerance(...values: number[]): number { return 1e-6 * Math.max(1, ...values.map(Math.abs)); }
function subtract(left: Vector3Value, right: Vector3Value): Vector3Value {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}
function dot(left: Vector3Value, right: Vector3Value): number { return left.x * right.x + left.y * right.y + left.z * right.z; }
function nonNegative(value: number | undefined): number { return value !== undefined && value >= 0 ? value : 0; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function segmentKey(trajectoryId: string, segmentId: string): string { return `${trajectoryId}\u0000${segmentId}`; }
