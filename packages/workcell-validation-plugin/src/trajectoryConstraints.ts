import type {
  WorkcellAuditFinding,
  WorkcellAuditObject,
  WorkcellJointConstraintCheck,
  WorkcellRobotTrajectory,
  WorkcellTrajectoryAnalysis,
} from "@bim-studio/contracts";

export function checkJointConstraints(
  trajectory: WorkcellRobotTrajectory,
  robot: WorkcellAuditObject,
): WorkcellJointConstraintCheck[] {
  const links = robot.robot!.links;
  const jointTolerance = nonNegative(trajectory.precision?.jointToleranceDeg);
  const timeTolerance = nonNegative(trajectory.precision?.timeToleranceSeconds);
  return trajectory.waypoints.flatMap((waypoint, waypointIndex) => links.map((link, jointIndex) => {
    const angle = waypoint.jointAnglesDeg?.[jointIndex];
    const hasAngle = typeof angle === "number" && Number.isFinite(angle);
    const previous = trajectory.waypoints[waypointIndex - 1];
    const previousAngle = previous?.jointAnglesDeg?.[jointIndex];
    const duration = previous ? waypoint.timeSec - previous.timeSec : undefined;
    const inboundSpeed = hasAngle && previousAngle !== undefined && duration && duration > 0
      ? Math.abs(angle - previousAngle) / duration : undefined;
    const worstCaseSpeed = hasAngle && previousAngle !== undefined && duration
      ? duration > timeTolerance * 2
        ? (Math.abs(angle - previousAngle) + jointTolerance * 2) / (duration - timeTolerance * 2)
        : Number.POSITIVE_INFINITY
      : inboundSpeed;
    const positionStatus = !hasAngle ? "needs-data" as const
      : angle < link.minAngleDeg || angle > link.maxAngleDeg ? "outside-limit" as const
        : angle - jointTolerance < link.minAngleDeg || angle + jointTolerance > link.maxAngleDeg
          ? "tolerance-overlap" as const : "within-limit" as const;
    const speedStatus = waypointIndex === 0 ? "not-declared" as const
      : inboundSpeed === undefined ? "needs-data" as const
        : link.maxSpeedDegPerSec === undefined ? "not-declared" as const
          : inboundSpeed > link.maxSpeedDegPerSec ? "outside-limit" as const
            : worstCaseSpeed !== undefined && worstCaseSpeed > link.maxSpeedDegPerSec
              ? "tolerance-overlap" as const : "within-limit" as const;
    return {
      trajectoryId: trajectory.id,
      waypointId: waypoint.id,
      jointId: link.id,
      ...(hasAngle ? { angleDeg: angle } : {}),
      positionStatus,
      ...(inboundSpeed !== undefined ? { inboundSpeedDegPerSec: inboundSpeed } : {}),
      speedStatus,
    };
  }));
}

export function jointConstraintFindings(
  checks: WorkcellJointConstraintCheck[],
  trajectories: WorkcellRobotTrajectory[],
): WorkcellAuditFinding[] {
  const outside = checks.filter((item) => item.positionStatus === "outside-limit" || item.speedStatus === "outside-limit");
  const toleranceOverlap = checks.filter((item) => item.positionStatus === "tolerance-overlap" || item.speedStatus === "tolerance-overlap");
  const missing = checks.filter((item) => item.positionStatus === "needs-data" || item.speedStatus === "needs-data");
  const findings: WorkcellAuditFinding[] = [];
  if (outside.length) findings.push(finding(
    "trajectory-joint-limit",
    "trajectory",
    "error",
    "轨迹关节约束越界",
    `${outside.length} 个轨迹点超出位置或已声明速度限位。`,
    robotIdsForChecks(outside, trajectories),
    "调整轨迹点或时序后重新检查",
  ));
  if (toleranceOverlap.length) findings.push(finding(
    "trajectory-joint-tolerance",
    "trajectory",
    "warning",
    "关节约束与声明容差重叠",
    `${toleranceOverlap.length} 个轨迹点的容差区间可能越过位置或速度限位。`,
    robotIdsForChecks(toleranceOverlap, trajectories),
    "收紧轨迹误差或增加限位裕量后重新检查",
  ));
  if (missing.length) findings.push(finding(
    "trajectory-joint-evidence",
    "data",
    "info",
    "轨迹关节证据不完整",
    `${missing.length} 项关节角或相邻轨迹点速度无法校验。`,
    robotIdsForChecks(missing, trajectories),
    "补充各轨迹点关节角与关节最大速度",
  ));
  return findings;
}

export function buildCycleStatistics(
  trajectories: WorkcellRobotTrajectory[],
): WorkcellTrajectoryAnalysis["cycle"] {
  const validTrajectories = trajectories.filter((trajectory) => !trajectoryIssue(trajectory));
  const statistics = validTrajectories.flatMap((trajectory) => {
    const first = trajectory.waypoints[0]!;
    const last = trajectory.waypoints.at(-1)!;
    const durationSec = last.timeSec - first.timeSec;
    const pathLengthMeters = pathLength(trajectory.waypoints.map((item) => item.position));
    return [{
      trajectoryId: trajectory.id,
      robotId: trajectory.robotId,
      durationSec,
      pathLengthMeters,
      averageTcpSpeedMps: durationSec > 0 ? pathLengthMeters / durationSec : 0,
    }];
  });
  const starts = validTrajectories.flatMap((item) => item.waypoints[0]?.timeSec ?? []);
  const ends = validTrajectories.flatMap((item) => item.waypoints.at(-1)?.timeSec ?? []);
  return {
    trajectories: statistics,
    scheduleSpanSec: starts.length ? Math.max(...ends) - Math.min(...starts) : 0,
    maxConcurrentRobots: maximumConcurrency(validTrajectories),
  };
}

export function trajectoryIssue(trajectory: WorkcellRobotTrajectory): string | undefined {
  if (!trajectory.id.trim() || !trajectory.name.trim() || !trajectory.robotId.trim()) return "轨迹、名称和机器人 ID 不能为空。";
  if (trajectory.waypoints.length < 2 || trajectory.waypoints.length > 100) return "轨迹必须包含 2–100 个点。";
  if (trajectory.waypoints.some((item) => !item.id.trim() || !finiteVector(item.position) || !Number.isFinite(item.timeSec))) return "轨迹点 ID、坐标和时间必须有效。";
  if (trajectory.waypoints.some((item, index) => index > 0 && item.timeSec <= trajectory.waypoints[index - 1]!.timeSec)) return "轨迹点时间必须严格递增。";
  return undefined;
}

export function precisionStatus(trajectories: WorkcellRobotTrajectory[]): WorkcellTrajectoryAnalysis["precisionStatus"] {
  const declared = trajectories.filter((item) => item.precision?.positionToleranceMeters !== undefined && item.precision.timeToleranceSeconds !== undefined).length;
  if (declared === trajectories.length) return "declared";
  if (trajectories.some((item) => item.precision)) return "partial";
  return "undeclared";
}

function maximumConcurrency(trajectories: WorkcellRobotTrajectory[]): number {
  const events = trajectories.flatMap((trajectory) => {
    const start = trajectory.waypoints[0]?.timeSec;
    const end = trajectory.waypoints.at(-1)?.timeSec;
    return start === undefined || end === undefined || end <= start ? [] : [{ time: start, delta: 1 }, { time: end, delta: -1 }];
  }).sort((left, right) => left.time - right.time || left.delta - right.delta);
  let active = 0, maximum = 0;
  for (const event of events) { active += event.delta; maximum = Math.max(maximum, active); }
  return maximum;
}

function robotIdsForChecks(checks: WorkcellJointConstraintCheck[], trajectories: WorkcellRobotTrajectory[]): string[] {
  const trajectoryIds = new Set(checks.map((item) => item.trajectoryId));
  return trajectories.filter((item) => trajectoryIds.has(item.id)).map((item) => item.robotId);
}

function finding(id: string, category: WorkcellAuditFinding["category"], severity: WorkcellAuditFinding["severity"], title: string, detail: string, objectIds: string[], nextAction: string): WorkcellAuditFinding {
  return { id, category, severity, title, detail, objectIds: [...new Set(objectIds)], nextAction };
}
function pathLength(points: Array<{ x: number; y: number; z: number }>): number {
  return points.slice(1).reduce((total, point, index) => {
    const previous = points[index]!;
    return total + Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z);
  }, 0);
}
function finiteVector(value: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}
function nonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}
