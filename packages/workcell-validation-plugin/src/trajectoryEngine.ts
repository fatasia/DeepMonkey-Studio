import type {
  WorkcellAuditFinding,
  WorkcellAuditInput,
  WorkcellAuditObject,
  WorkcellJointConstraintCheck,
  WorkcellRobotTrajectory,
  WorkcellTrajectoryAnalysis,
} from "@bim-studio/contracts";
import {
  buildAvoidanceCandidates,
  buildScheduleConflicts,
  buildSegmentChecks,
  type PreparedTrajectorySegment,
} from "./trajectoryGeometry.js";
import {
  buildCycleStatistics,
  checkJointConstraints,
  jointConstraintFindings,
  precisionStatus,
  trajectoryIssue,
} from "./trajectoryConstraints.js";

const DEFAULT_TCP_RADIUS_METERS = 0.1;

export interface WorkcellTrajectoryAudit {
  analysis: WorkcellTrajectoryAnalysis;
  findings: WorkcellAuditFinding[];
}

/**
 * 连续性仅针对分段线性 TCP 包围球成立；障碍物使用扩张 AABB，属于保守广相位，
 * 可能产生假阳性，绝不能替代连杆、工具和电缆的网格级扫掠碰撞。
 */
export function analyzeWorkcellTrajectories(input: WorkcellAuditInput): WorkcellTrajectoryAudit | undefined {
  const trajectories = uniqueTrajectories(input.trajectories ?? []);
  if (!trajectories.length) return undefined;
  const objects = new Map(input.objects.map((item) => [item.id, item]));
  const clearance = finiteNonNegative(input.clearanceThreshold, 0.25);
  const findings: WorkcellAuditFinding[] = [];
  const segments: PreparedTrajectorySegment[] = [];
  const jointChecks: WorkcellJointConstraintCheck[] = [];

  for (const trajectory of trajectories) {
    const robot = objects.get(trajectory.robotId);
    if (!robot?.robot?.links.length) {
      findings.push(finding(`trajectory-robot-${trajectory.id}`, "data", "error", "轨迹缺少机器人关节链", `${trajectory.name} 无法关联具有关节链的机器人。`, [trajectory.robotId], "修复轨迹机器人绑定"));
      continue;
    }
    const issue = trajectoryIssue(trajectory);
    if (issue) {
      findings.push(finding(`trajectory-invalid-${trajectory.id}`, "data", "error", "轨迹时序无效", issue, [trajectory.robotId], "修复轨迹点坐标与递增时间"));
      continue;
    }
    jointChecks.push(...checkJointConstraints(trajectory, robot));
    prepareSegments(trajectory, segments);
    if (trajectory.precision?.positionToleranceMeters === undefined) findings.push(finding(
      `trajectory-precision-${trajectory.id}`,
      "data",
      "info",
      "轨迹位置精度未声明",
      `${trajectory.name} 可执行广相位筛查，但不能量化输入坐标误差。`,
      [trajectory.robotId],
      "声明轨迹来源与位置容差",
    ));
  }

  const obstacles = input.objects.filter((item) => item.role !== "target" && validBounds(item));
  const segmentChecks = buildSegmentChecks(segments, obstacles, clearance, findings);
  const avoidanceCandidates = buildAvoidanceCandidates(segments, segmentChecks, obstacles, clearance);
  const scheduleConflicts = buildScheduleConflicts(segments, clearance, findings);
  findings.push(...jointConstraintFindings(jointChecks, trajectories));
  return {
    findings,
    analysis: {
      method: "piecewise-linear-tcp-sphere-aabb-v1",
      approximation: "conservative-broad-phase",
      declaration: "连续检查覆盖每个分段线性 TCP 包围球；障碍物按扩张 AABB 处理。多机器人时段检查用声明时间容差换算线性段空间裕量。结果可能假阳性，不是机器人连杆、工具、工件或电缆的网格精确碰撞，也不覆盖控制器抖动曲线。避障点仅为确定性候选，不生成或下发控制器程序。",
      precisionStatus: precisionStatus(trajectories),
      jointChecks,
      segmentChecks,
      avoidanceCandidates,
      scheduleConflicts,
      cycle: buildCycleStatistics(trajectories),
    },
  };
}

function prepareSegments(trajectory: WorkcellRobotTrajectory, target: PreparedTrajectorySegment[]): void {
  const radius = finitePositive(trajectory.tcpRadius, DEFAULT_TCP_RADIUS_METERS);
  const tolerance = finiteNonNegative(trajectory.precision?.positionToleranceMeters, 0);
  const timeTolerance = finiteNonNegative(trajectory.precision?.timeToleranceSeconds, 0);
  for (let index = 1; index < trajectory.waypoints.length; index += 1) target.push({
    trajectory,
    id: `${trajectory.id}:${index - 1}-${index}`,
    start: trajectory.waypoints[index - 1]!,
    end: trajectory.waypoints[index]!,
    radius,
    tolerance,
    timeTolerance,
  });
}

function finding(id: string, category: WorkcellAuditFinding["category"], severity: WorkcellAuditFinding["severity"], title: string, detail: string, objectIds: string[], nextAction: string): WorkcellAuditFinding {
  return { id, category, severity, title, detail, objectIds: [...new Set(objectIds)], nextAction };
}
function validBounds(object: WorkcellAuditObject): boolean {
  return Boolean(object.bounds
    && finiteVector(object.bounds.min)
    && finiteVector(object.bounds.max)
    && object.bounds.min.x <= object.bounds.max.x
    && object.bounds.min.y <= object.bounds.max.y
    && object.bounds.min.z <= object.bounds.max.z);
}
function uniqueTrajectories(values: WorkcellRobotTrajectory[]): WorkcellRobotTrajectory[] { return [...new Map(values.slice(0, 20).map((item) => [item.id, item])).values()]; }
function finitePositive(value: number | undefined, fallback: number): number { return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback; }
function finiteNonNegative(value: number | undefined, fallback: number): number { return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback; }
function finiteVector(value: { x: number; y: number; z: number }): boolean { return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z); }
