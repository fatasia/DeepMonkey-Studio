import type { WorkcellRobotTrajectory, WorkcellTrajectoryAnalysis } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import {
  adjacentWorkcellTrajectoryEvent,
  buildWorkcellTrajectoryTracks,
  sampleWorkcellTrajectory,
} from "./workcellTrajectoryPlayback";

describe("workcell trajectory playback evidence", () => {
  it("interpolates only the audited piecewise-linear TCP input and exposes real evidence times", () => {
    const tracks = buildWorkcellTrajectoryTracks(trajectories(), analysis());
    const track = tracks.find((item) => item.id === "path-a")!;

    expect(track.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "potential-collision", timeSec: 1, endTimeSec: 5, objectIds: ["robot-a", "guard-1"] }),
      expect.objectContaining({ kind: "schedule-conflict", timeSec: 4, objectIds: ["robot-a", "robot-b"] }),
      expect.objectContaining({ kind: "joint-constraint", timeSec: 5, severity: "error", waypointId: "pick" }),
    ]));
    expect(sampleWorkcellTrajectory(track, 3)).toMatchObject({
      source: "linear-segment",
      timeSec: 3,
      position: { x: 2, y: 1, z: 0 },
      segmentProgress: .5,
      segmentId: "path-a:0-1",
    });
  });

  it("clamps to real keyframes instead of extrapolating", () => {
    const track = buildWorkcellTrajectoryTracks(trajectories(), analysis())[0]!;
    expect(sampleWorkcellTrajectory(track, -10)).toMatchObject({ source: "waypoint", timeSec: 1, waypointId: "home", position: { x: 0, y: 0, z: 0 } });
    expect(sampleWorkcellTrajectory(track, 99)).toMatchObject({ source: "waypoint", timeSec: 5, waypointId: "pick", position: { x: 4, y: 2, z: 0 } });
  });

  it("drops invalid tracks and stale segment evidence rather than inventing playback", () => {
    const invalid: WorkcellRobotTrajectory = {
      id: "invalid", name: "倒序轨迹", robotId: "robot-a",
      waypoints: [
        { id: "a", timeSec: 2, position: { x: 0, y: 0, z: 0 } },
        { id: "b", timeSec: 1, position: { x: 1, y: 0, z: 0 } },
      ],
    };
    const stale = analysis();
    stale.segmentChecks[0] = { ...stale.segmentChecks[0]!, endTimeSec: 99 };
    const tracks = buildWorkcellTrajectoryTracks([...trajectories(), invalid], stale);
    expect(tracks.some((item) => item.id === "invalid")).toBe(false);
    expect(tracks[0]!.events.some((item) => item.kind === "potential-collision")).toBe(false);

    const staleSchedule = analysis();
    staleSchedule.scheduleConflicts[0] = { ...staleSchedule.scheduleConflicts[0]!, segmentIds: ["removed-segment", "path-b:0-1"] };
    expect(buildWorkcellTrajectoryTracks(trajectories(), staleSchedule)[0]!.events.some((item) => item.kind === "schedule-conflict")).toBe(false);

    const unpaired = analysis();
    unpaired.cycle.trajectories[0] = { ...unpaired.cycle.trajectories[0]!, durationSec: 99 };
    expect(buildWorkcellTrajectoryTracks([trajectories()[0]!], unpaired)).toEqual([]);
  });

  it("moves to the adjacent evidence event without cycling past the track", () => {
    const events = buildWorkcellTrajectoryTracks(trajectories(), analysis())[0]!.events;
    expect(adjacentWorkcellTrajectoryEvent(events, 1, 1)?.timeSec).toBe(4);
    expect(adjacentWorkcellTrajectoryEvent(events, 5, 1)).toBeUndefined();
    expect(adjacentWorkcellTrajectoryEvent(events, 5, -1)?.timeSec).toBe(4);
  });
});

function trajectories(): WorkcellRobotTrajectory[] {
  return [
    {
      id: "path-a", name: "机器人 A 取放", robotId: "robot-a",
      waypoints: [
        { id: "home", timeSec: 1, position: { x: 0, y: 0, z: 0 }, jointAnglesDeg: [0] },
        { id: "pick", timeSec: 5, position: { x: 4, y: 2, z: 0 }, jointAnglesDeg: [190] },
      ],
    },
    {
      id: "path-b", name: "机器人 B 上料", robotId: "robot-b",
      waypoints: [
        { id: "start", timeSec: 0, position: { x: 4, y: 0, z: 0 } },
        { id: "end", timeSec: 5, position: { x: 0, y: 2, z: 0 } },
      ],
    },
  ];
}

function analysis(): WorkcellTrajectoryAnalysis {
  return {
    method: "piecewise-linear-tcp-sphere-aabb-v1",
    approximation: "conservative-broad-phase",
    declaration: "分段线性 TCP 包围球与扩张 AABB 广相位。",
    precisionStatus: "partial",
    jointChecks: [{
      trajectoryId: "path-a", waypointId: "pick", jointId: "J1", angleDeg: 190,
      positionStatus: "outside-limit", inboundSpeedDegPerSec: 47.5, speedStatus: "within-limit",
    }],
    segmentChecks: [
      { trajectoryId: "path-a", segmentId: "path-a:0-1", startTimeSec: 1, endTimeSec: 5, lengthMeters: Math.sqrt(20), potentialObstacleIds: ["guard-1"] },
      { trajectoryId: "path-b", segmentId: "path-b:0-1", startTimeSec: 0, endTimeSec: 5, lengthMeters: Math.sqrt(20), potentialObstacleIds: [] },
    ],
    avoidanceCandidates: [],
    scheduleConflicts: [{
      trajectoryIds: ["path-a", "path-b"], robotIds: ["robot-a", "robot-b"], segmentIds: ["path-a:0-1", "path-b:0-1"],
      startTimeSec: 1, endTimeSec: 5, closestTimeSec: 4, minimumTcpDistanceMeters: .08, requiredDistanceMeters: .3,
    }],
    cycle: {
      trajectories: [
        { trajectoryId: "path-a", robotId: "robot-a", durationSec: 4, pathLengthMeters: Math.sqrt(20), averageTcpSpeedMps: Math.sqrt(20) / 4 },
        { trajectoryId: "path-b", robotId: "robot-b", durationSec: 5, pathLengthMeters: Math.sqrt(20), averageTcpSpeedMps: Math.sqrt(20) / 5 },
      ],
      scheduleSpanSec: 5,
      maxConcurrentRobots: 2,
    },
  };
}
