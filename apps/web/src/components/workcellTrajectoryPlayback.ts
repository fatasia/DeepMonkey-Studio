import type {
  Vector3Value,
  WorkcellRobotTrajectory,
  WorkcellTrajectoryAnalysis,
  WorkcellTrajectoryWaypoint,
} from "@bim-studio/contracts";

const EPSILON = 1e-6;

export type WorkcellTrajectoryEventKind = "waypoint" | "potential-collision" | "joint-constraint" | "schedule-conflict";
export type WorkcellTrajectoryEventSeverity = "info" | "warning" | "error";

export interface WorkcellTrajectoryPlaybackEvent {
  id: string;
  trajectoryId: string;
  timeSec: number;
  endTimeSec?: number;
  kind: WorkcellTrajectoryEventKind;
  severity: WorkcellTrajectoryEventSeverity;
  label: string;
  objectIds: string[];
  waypointId?: string;
  segmentId?: string;
}

export interface WorkcellTrajectoryTrack {
  id: string;
  name: string;
  robotId: string;
  startTimeSec: number;
  endTimeSec: number;
  waypoints: WorkcellTrajectoryWaypoint[];
  events: WorkcellTrajectoryPlaybackEvent[];
}

export interface WorkcellTrajectoryFrame {
  trajectoryId: string;
  robotId: string;
  timeSec: number;
  position: Vector3Value;
  source: "waypoint" | "linear-segment";
  segmentProgress: number;
  waypointId?: string;
  segmentId?: string;
}

/**
 * 只把本次审计输入与返回证据能相互印证的内容放进时间轴。
 * 不完整轨迹、失配的段 ID/时刻和范围外事件会被丢弃，避免把陈旧结果画到当前任务上。
 */
export function buildWorkcellTrajectoryTracks(
  trajectories: readonly WorkcellRobotTrajectory[],
  analysis: WorkcellTrajectoryAnalysis,
): WorkcellTrajectoryTrack[] {
  return uniqueTrajectories(trajectories)
    .filter((trajectory) => validTrajectory(trajectory) && hasMatchingCycleEvidence(trajectory, analysis))
    .map((trajectory) => {
      const waypoints = trajectory.waypoints.map(cloneWaypoint);
      const segmentById = new Map<string, { start: WorkcellTrajectoryWaypoint; end: WorkcellTrajectoryWaypoint }>(waypoints.slice(1).map((end, index) => {
        const start = waypoints[index]!;
        return [`${trajectory.id}:${index}-${index + 1}`, { start, end }] as const;
      }));
      const events: WorkcellTrajectoryPlaybackEvent[] = waypoints.map((waypoint) => ({
        id: `${trajectory.id}:waypoint:${waypoint.id}`,
        trajectoryId: trajectory.id,
        timeSec: waypoint.timeSec,
        kind: "waypoint",
        severity: "info",
        label: `关键帧 · ${waypoint.id}`,
        objectIds: [trajectory.robotId],
        waypointId: waypoint.id,
      }));

      for (const check of analysis.segmentChecks) {
        if (check.trajectoryId !== trajectory.id || !check.potentialObstacleIds.length) continue;
        const segment = segmentById.get(check.segmentId);
        if (!segment || !sameTime(check.startTimeSec, segment.start.timeSec) || !sameTime(check.endTimeSec, segment.end.timeSec)) continue;
        events.push({
          id: `${trajectory.id}:collision:${check.segmentId}`,
          trajectoryId: trajectory.id,
          timeSec: segment.start.timeSec,
          endTimeSec: segment.end.timeSec,
          kind: "potential-collision",
          severity: "warning",
          label: `风险段 · ${check.potentialObstacleIds.length} 个潜在障碍`,
          objectIds: unique([trajectory.robotId, ...check.potentialObstacleIds]),
          segmentId: check.segmentId,
        });
      }

      for (const check of analysis.jointChecks) {
        if (check.trajectoryId !== trajectory.id) continue;
        const positionRisk = check.positionStatus === "outside-limit" || check.positionStatus === "tolerance-overlap";
        const speedRisk = check.speedStatus === "outside-limit" || check.speedStatus === "tolerance-overlap";
        if (!positionRisk && !speedRisk) continue;
        const waypoint = waypoints.find((item) => item.id === check.waypointId);
        if (!waypoint) continue;
        const outside = check.positionStatus === "outside-limit" || check.speedStatus === "outside-limit";
        events.push({
          id: `${trajectory.id}:joint:${check.waypointId}:${check.jointId}`,
          trajectoryId: trajectory.id,
          timeSec: waypoint.timeSec,
          kind: "joint-constraint",
          severity: outside ? "error" : "warning",
          label: `${check.jointId} ${outside ? "越出约束" : "接近约束"}`,
          objectIds: [trajectory.robotId],
          waypointId: waypoint.id,
        });
      }

      for (const conflict of analysis.scheduleConflicts) {
        const trajectoryIndex = conflict.trajectoryIds.indexOf(trajectory.id);
        if (trajectoryIndex < 0 || !Number.isFinite(conflict.closestTimeSec)) continue;
        const segmentId = conflict.segmentIds[trajectoryIndex];
        if (!segmentId || !segmentById.has(segmentId)) continue;
        if (!inside(conflict.closestTimeSec, waypoints[0]!.timeSec, waypoints.at(-1)!.timeSec)) continue;
        events.push({
          id: `${trajectory.id}:schedule:${conflict.segmentIds.join(":")}`,
          trajectoryId: trajectory.id,
          timeSec: conflict.closestTimeSec,
          kind: "schedule-conflict",
          severity: "warning",
          label: `多机器人最近距离 ${formatMeters(conflict.minimumTcpDistanceMeters)}`,
          objectIds: unique(conflict.robotIds),
          segmentId,
        });
      }

      return {
        id: trajectory.id,
        name: trajectory.name,
        robotId: trajectory.robotId,
        startTimeSec: waypoints[0]!.timeSec,
        endTimeSec: waypoints.at(-1)!.timeSec,
        waypoints,
        events: dedupeEvents(events).sort(compareEvents),
      };
    });
}

/** 分段线性插值与审计引擎一致；它只描述 TCP 候选点，不推导关节姿态。 */
export function sampleWorkcellTrajectory(track: WorkcellTrajectoryTrack, requestedTimeSec: number): WorkcellTrajectoryFrame {
  const timeSec = clamp(
    Number.isFinite(requestedTimeSec) ? requestedTimeSec : track.startTimeSec,
    track.startTimeSec,
    track.endTimeSec,
  );
  const exact = track.waypoints.find((item) => sameTime(item.timeSec, timeSec));
  if (exact) return {
    trajectoryId: track.id,
    robotId: track.robotId,
    timeSec: exact.timeSec,
    position: { ...exact.position },
    source: "waypoint",
    segmentProgress: 0,
    waypointId: exact.id,
  };

  const endIndex = track.waypoints.findIndex((item) => item.timeSec > timeSec);
  const safeEndIndex = endIndex > 0 ? endIndex : track.waypoints.length - 1;
  const start = track.waypoints[safeEndIndex - 1]!;
  const end = track.waypoints[safeEndIndex]!;
  const segmentProgress = clamp((timeSec - start.timeSec) / (end.timeSec - start.timeSec), 0, 1);
  return {
    trajectoryId: track.id,
    robotId: track.robotId,
    timeSec,
    position: interpolate(start.position, end.position, segmentProgress),
    source: "linear-segment",
    segmentProgress,
    segmentId: `${track.id}:${safeEndIndex - 1}-${safeEndIndex}`,
  };
}

export function adjacentWorkcellTrajectoryEvent(
  events: readonly WorkcellTrajectoryPlaybackEvent[],
  timeSec: number,
  direction: -1 | 1,
): WorkcellTrajectoryPlaybackEvent | undefined {
  const ordered = [...events].sort(compareEvents);
  return direction > 0
    ? ordered.find((item) => item.timeSec > timeSec + EPSILON)
    : ordered.reverse().find((item) => item.timeSec < timeSec - EPSILON);
}

function validTrajectory(trajectory: WorkcellRobotTrajectory): boolean {
  if (!trajectory.id.trim() || !trajectory.name.trim() || !trajectory.robotId.trim() || trajectory.waypoints.length < 2 || trajectory.waypoints.length > 100) return false;
  return trajectory.waypoints.every((waypoint, index) => (
    waypoint.id.trim()
    && Number.isFinite(waypoint.timeSec)
    && finiteVector(waypoint.position)
    && (index === 0 || waypoint.timeSec > trajectory.waypoints[index - 1]!.timeSec)
  ));
}
function hasMatchingCycleEvidence(trajectory: WorkcellRobotTrajectory, analysis: WorkcellTrajectoryAnalysis): boolean {
  const statistic = analysis.cycle.trajectories.find((item) => item.trajectoryId === trajectory.id && item.robotId === trajectory.robotId);
  if (!statistic) return false;
  const duration = trajectory.waypoints.at(-1)!.timeSec - trajectory.waypoints[0]!.timeSec;
  const pathLength = trajectory.waypoints.slice(1).reduce((total, waypoint, index) => {
    const previous = trajectory.waypoints[index]!;
    return total + Math.hypot(
      waypoint.position.x - previous.position.x,
      waypoint.position.y - previous.position.y,
      waypoint.position.z - previous.position.z,
    );
  }, 0);
  return sameMeasurement(statistic.durationSec, duration) && sameMeasurement(statistic.pathLengthMeters, pathLength);
}
function uniqueTrajectories(values: readonly WorkcellRobotTrajectory[]): WorkcellRobotTrajectory[] {
  return [...new Map(values.map((item) => [item.id, item])).values()];
}
function cloneWaypoint(value: WorkcellTrajectoryWaypoint): WorkcellTrajectoryWaypoint {
  return { ...value, position: { ...value.position }, ...(value.jointAnglesDeg ? { jointAnglesDeg: [...value.jointAnglesDeg] } : {}) };
}
function dedupeEvents(values: WorkcellTrajectoryPlaybackEvent[]): WorkcellTrajectoryPlaybackEvent[] {
  return [...new Map(values.map((item) => [item.id, item])).values()];
}
function compareEvents(left: WorkcellTrajectoryPlaybackEvent, right: WorkcellTrajectoryPlaybackEvent): number {
  return left.timeSec - right.timeSec || eventRank(left.kind) - eventRank(right.kind) || left.id.localeCompare(right.id);
}
function eventRank(kind: WorkcellTrajectoryEventKind): number {
  return ({ "joint-constraint": 0, "potential-collision": 1, "schedule-conflict": 2, waypoint: 3 })[kind];
}
function interpolate(start: Vector3Value, end: Vector3Value, ratio: number): Vector3Value {
  return {
    x: start.x + (end.x - start.x) * ratio,
    y: start.y + (end.y - start.y) * ratio,
    z: start.z + (end.z - start.z) * ratio,
  };
}
function sameTime(left: number, right: number): boolean { return Math.abs(left - right) <= EPSILON; }
function sameMeasurement(left: number, right: number): boolean { return Math.abs(left - right) <= EPSILON * Math.max(1, Math.abs(left), Math.abs(right)); }
function inside(value: number, minimum: number, maximum: number): boolean { return value >= minimum - EPSILON && value <= maximum + EPSILON; }
function finiteVector(value: Vector3Value): boolean { return [value.x, value.y, value.z].every(Number.isFinite); }
function unique(values: readonly string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function formatMeters(value: number): string { return Number.isFinite(value) ? `${value.toFixed(3)} m` : "未声明"; }
