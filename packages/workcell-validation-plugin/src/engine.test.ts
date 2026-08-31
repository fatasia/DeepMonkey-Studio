import { describe, expect, it } from "vitest";
import type { WorkcellAuditInput } from "@bim-studio/contracts";
import { auditWorkcell } from "./engine.js";

describe("workcell validation", () => {
  it("finds deterministic collisions and unreachable robot targets", () => {
    const result = auditWorkcell(fixture());
    expect(result.status).toBe("failed");
    expect(result.findings.some((item) => item.category === "collision" && item.severity === "error")).toBe(true);
    expect(result.reachability).toMatchObject([{ robotId: "robot", targetId: "target", status: "outside" }]);
    expect(result.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not invent collision conclusions without geometry", () => {
    const result = auditWorkcell({ sceneId: "scene", objects: [{ id: "machine", name: "机床", role: "equipment", position: { x: 0, y: 0, z: 0 } }] });
    expect(result.status).toBe("needs-data");
    expect(result.collisionPairs).toHaveLength(0);
    expect(result.incompleteObjectIds).toEqual(["machine"]);
    expect(result.findings[0]?.detail).toContain("不输出碰撞或间隙结论");
  });

  it("produces a stable fingerprint for the same evidence", () => {
    expect(auditWorkcell(fixture()).evidenceFingerprint).toBe(auditWorkcell(fixture()).evidenceFingerprint);
  });

  it("includes PS Lite trajectory evidence in the audit fingerprint and acceptance draft", () => {
    const input = fixture();
    input.trajectories = [{
      id: "robot-path",
      name: "机器人直线路径",
      robotId: "robot",
      tcpRadius: 0.1,
      precision: { source: "author-confirmed", positionToleranceMeters: 0.01, timeToleranceSeconds: 0.01 },
      waypoints: [
        { id: "start", timeSec: 0, position: { x: -2, y: 1, z: 0 }, jointAnglesDeg: [0] },
        { id: "end", timeSec: 4, position: { x: 2, y: 1, z: 0 }, jointAnglesDeg: [20] },
      ],
    }];
    const result = auditWorkcell(input);

    expect(result.trajectoryAnalysis).toMatchObject({
      approximation: "conservative-broad-phase",
      segmentChecks: [{ trajectoryId: "robot-path" }],
    });
    expect(result.validationDraft.acceptanceCriteria).toContain("多机器人轨迹在重叠时间段内满足声明间隙");
    expect(result.summary).toContain("1 段连续广相位");
    const withoutTrajectory = auditWorkcell(fixture());
    expect(result.evidenceFingerprint).not.toBe(withoutTrajectory.evidenceFingerprint);
  });
});

function fixture(): WorkcellAuditInput {
  return {
    sceneId: "scene",
    clearanceThreshold: 0.25,
    objects: [
      {
        id: "robot", name: "机器人", role: "robot", position: { x: 0, y: 0, z: 0 },
        bounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } },
        robot: { base: { x: 0, y: 0, z: 0 }, links: [{ id: "j1", name: "大臂", length: 2, minAngleDeg: -180, maxAngleDeg: 180 }], targetObjectIds: ["target"] },
      },
      { id: "fence", name: "安全围栏", role: "obstacle", position: { x: 0.5, y: 0, z: 0 }, bounds: { min: { x: 0.5, y: 0, z: -2 }, max: { x: 0.7, y: 2, z: 2 } } },
      { id: "target", name: "抓取点", role: "target", position: { x: 3, y: 0, z: 0 } },
    ],
  };
}
