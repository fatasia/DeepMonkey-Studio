import type { WorkcellAuditInput, WorkcellRobotTrajectory } from "@bim-studio/contracts";
import { validateCapabilityValue } from "@bim-studio/plugin-runtime";
import { describe, expect, it } from "vitest";
import { analyzeWorkcellTrajectories } from "./trajectoryEngine.js";
import { workcellAuditInputSchema } from "./workcellSchemas.js";

describe("PS Lite trajectory engine", () => {
  it("checks continuous broad-phase, joint constraints, avoidance, schedule and cycle evidence", () => {
    const input = fixture();
    expect(validateCapabilityValue(workcellAuditInputSchema, input)).toEqual([]);
    const audit = analyzeWorkcellTrajectories(input);

    expect(audit?.analysis).toMatchObject({
      method: "piecewise-linear-tcp-sphere-aabb-v1",
      approximation: "conservative-broad-phase",
      precisionStatus: "declared",
      cycle: { scheduleSpanSec: 4, maxConcurrentRobots: 2 },
    });
    expect(audit?.analysis.declaration).toContain("不是机器人连杆、工具、工件或电缆的网格精确碰撞");
    expect(audit?.analysis.segmentChecks.find((item) => item.trajectoryId === "path-a")?.potentialObstacleIds).toContain("guard");
    expect(audit?.analysis.avoidanceCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ trajectoryId: "path-a", obstacleId: "guard", status: "candidate-found" }),
    ]));
    expect(audit?.analysis.scheduleConflicts).toEqual([
      expect.objectContaining({ robotIds: ["robot-a", "robot-b"], minimumTcpDistanceMeters: 0 }),
    ]);
    expect(audit?.analysis.jointChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ trajectoryId: "path-a", waypointId: "a-1", positionStatus: "within-limit", speedStatus: "within-limit" }),
    ]));
    expect(audit?.findings.some((item) => item.category === "trajectory" && item.detail.includes("保守初筛"))).toBe(true);
    expect(audit?.findings.some((item) => item.category === "schedule")).toBe(true);
  });

  it("does not report a multi-robot conflict when execution windows do not overlap", () => {
    const input = fixture();
    input.trajectories![1] = shiftedTrajectory(input.trajectories![1]!, 10);
    const audit = analyzeWorkcellTrajectories(input);

    expect(audit?.analysis.scheduleConflicts).toHaveLength(0);
    expect(audit?.analysis.cycle.scheduleSpanSec).toBe(14);
  });

  it("rejects non-increasing trajectory time without inventing segment evidence", () => {
    const input = fixture();
    input.trajectories![0]!.waypoints[1]!.timeSec = 0;
    const audit = analyzeWorkcellTrajectories(input);

    expect(audit?.analysis.segmentChecks.some((item) => item.trajectoryId === "path-a")).toBe(false);
    expect(audit?.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "trajectory-invalid-path-a", severity: "error" }),
    ]));
    expect(audit?.analysis.cycle.trajectories.map((item) => item.trajectoryId)).toEqual(["path-b"]);
    expect(audit?.analysis.cycle.maxConcurrentRobots).toBe(1);
  });

  it("keeps nominally valid joints visible when declared tolerance crosses a limit", () => {
    const input = fixture();
    input.trajectories![0]!.waypoints[1]!.jointAnglesDeg = [89.8];
    const audit = analyzeWorkcellTrajectories(input);

    expect(audit?.analysis.jointChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        trajectoryId: "path-a",
        waypointId: "a-1",
        positionStatus: "tolerance-overlap",
        speedStatus: "within-limit",
      }),
    ]));
    expect(audit?.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "trajectory-joint-tolerance", severity: "warning" }),
    ]));
  });

  it("does not pass speed when declared timing uncertainty consumes its margin", () => {
    const input = fixture();
    input.trajectories![0]!.precision!.timeToleranceSeconds = 1.5;
    const audit = analyzeWorkcellTrajectories(input);

    expect(audit?.analysis.jointChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        trajectoryId: "path-a",
        waypointId: "a-1",
        inboundSpeedDegPerSec: 10,
        speedStatus: "tolerance-overlap",
      }),
    ]));
  });
});

function fixture(): WorkcellAuditInput {
  return {
    sceneId: "scene-1",
    clearanceThreshold: 0.15,
    objects: [
      robot("robot-a", { x: 0, y: 0, z: 0 }),
      robot("robot-b", { x: 2, y: 0, z: -2 }),
      {
        id: "guard",
        name: "安全围栏",
        role: "obstacle",
        position: { x: 2, y: 0, z: 0 },
        bounds: { min: { x: 1.6, y: -0.5, z: -0.2 }, max: { x: 2.4, y: 0.5, z: 0.2 } },
      },
    ],
    trajectories: [
      trajectory("path-a", "robot-a", [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }], [0, 40]),
      trajectory("path-b", "robot-b", [{ x: 2, y: 0, z: -2 }, { x: 2, y: 0, z: 2 }], [0, -40]),
    ],
  };
}

function robot(id: string, position: { x: number; y: number; z: number }) {
  return {
    id,
    name: id,
    role: "robot" as const,
    position,
    robot: {
      base: position,
      links: [{ id: `${id}-j1`, name: "J1", length: 2, minAngleDeg: -90, maxAngleDeg: 90, maxSpeedDegPerSec: 30 }],
    },
  };
}

function trajectory(
  id: string,
  robotId: string,
  positions: Array<{ x: number; y: number; z: number }>,
  angles: number[],
): WorkcellRobotTrajectory {
  return {
    id,
    name: id,
    robotId,
    tcpRadius: 0.1,
    precision: { source: "author-confirmed", positionToleranceMeters: 0.01, timeToleranceSeconds: 0.01, jointToleranceDeg: 0.5 },
    waypoints: positions.map((position, index) => ({ id: `${id === "path-a" ? "a" : "b"}-${index}`, timeSec: index * 4, position, jointAnglesDeg: [angles[index]!] })),
  };
}

function shiftedTrajectory(trajectory: WorkcellRobotTrajectory, seconds: number): WorkcellRobotTrajectory {
  return { ...trajectory, waypoints: trajectory.waypoints.map((item) => ({ ...item, timeSec: item.timeSec + seconds })) };
}
