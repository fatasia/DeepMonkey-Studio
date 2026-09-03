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

  it("never upgrades unconfirmed starter values to a passed audit", () => {
    const input = loadFixture();
    input.clearanceThreshold = .25;
    input.planningAssumptions = { origin: "starter-values", status: "unconfirmed" };
    const result = auditWorkcell(input);

    expect(result).toMatchObject({
      status: "needs-data",
      planningEvidence: {
        status: "needs-data",
        origin: "starter-values",
        missingFields: ["planning-confirmation"],
      },
    });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "planning-evidence-needs-data", severity: "info" }),
    ]));
  });

  it("does not invent the former 0.25 m clearance when a required relation has no threshold", () => {
    const result = auditWorkcell({
      sceneId: "scene-clearance",
      objects: [
        { id: "machine", name: "设备", role: "equipment", position: { x: 0, y: 0, z: 0 }, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } },
        { id: "guard", name: "围栏", role: "obstacle", position: { x: 2, y: 0, z: 0 }, bounds: { min: { x: 2, y: 0, z: 0 }, max: { x: 3, y: 1, z: 1 } } },
      ],
    });

    expect(result.status).toBe("needs-data");
    expect(result.planningEvidence?.missingFields).toContain("clearance-threshold");
    expect(result.validationDraft.acceptanceCriteria.join(" ")).not.toContain("0.25");
  });

  it("keeps trajectory space evidence unavailable when TCP radius is missing", () => {
    const input = loadFixture();
    input.clearanceThreshold = .2;
    input.trajectories = [{
      id: "path", name: "作者轨迹", robotId: "robot",
      precision: { source: "author-confirmed" },
      waypoints: [
        { id: "start", timeSec: 0, position: { x: 0, y: 0, z: 0 } },
        { id: "end", timeSec: 1, position: { x: 1, y: 0, z: 0 } },
      ],
    }];
    const result = auditWorkcell(input);

    expect(result.status).toBe("needs-data");
    expect(result.planningEvidence?.missingFields).toContain("trajectory-tcp-radius");
    expect(result.trajectoryAnalysis?.segmentChecks).toHaveLength(0);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "trajectory-tcp-radius-path" }),
    ]));
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

  it("integrates load, TCP and center-of-mass evidence into the deterministic audit", () => {
    const input = loadFixture();
    const result = auditWorkcell(input);

    expect(result.status).toBe("passed");
    expect(result.loadChecks).toEqual([expect.objectContaining({
      robotId: "robot",
      status: "within-planning-envelope",
      totalLoadKg: 12,
      payloadUtilization: .6,
      loadCenterDistanceMeters: .2,
      evidenceCoverage: 1,
    })]);
    expect(result.validationDraft.acceptanceCriteria).toEqual(expect.arrayContaining([
      expect.stringContaining("额定负载"),
    ]));

    const changedTcp = structuredClone(input);
    changedTcp.objects[0]!.robot!.toolLoad!.tcpOrientationEulerDeg = { x: 0, y: 0, z: 90 };
    expect(auditWorkcell(changedTcp).evidenceFingerprint).not.toBe(result.evidenceFingerprint);

    input.objects[0]!.robot!.toolLoad!.carriedPayloadKg = 18;
    const overloaded = auditWorkcell(input);
    expect(overloaded.status).toBe("failed");
    expect(overloaded.loadChecks[0]).toMatchObject({ status: "exceeds-planning-envelope", violations: ["payload"] });
    expect(overloaded.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "load", severity: "error", title: "机器人负载超出规划包络" }),
    ]));
  });

  it("keeps missing load measurements visible as needs-data", () => {
    const input = loadFixture();
    delete input.objects[0]!.robot!.toolLoad;
    const result = auditWorkcell(input);

    expect(result.status).toBe("needs-data");
    expect(result.loadChecks[0]).toMatchObject({
      status: "needs-data",
      missingFields: expect.arrayContaining(["tool-mass", "tcp-position", "combined-center-of-mass"]),
    });
    expect(result.loadChecks[0]).not.toHaveProperty("totalLoadKg");
    expect(result.summary).toContain("缺少负载/TCP规划证据");
  });

  it("integrates human reach, work-height and handling evidence without claiming certified ergonomics", () => {
    const input = humanFixture();
    const passed = auditWorkcell(input);

    expect(passed.status).toBe("passed");
    expect(passed.ergonomicsChecks).toEqual([expect.objectContaining({
      profileId: "human-task-1", status: "pass", evidenceCoverage: 1,
      rules: expect.arrayContaining([
        expect.objectContaining({ id: "shoulder-reach", status: "pass" }),
        expect.objectContaining({ id: "work-height", status: "pass" }),
        expect.objectContaining({ id: "manual-load", status: "pass" }),
      ]),
    })]);
    expect(passed.validationDraft.acceptanceCriteria).toEqual(expect.arrayContaining([expect.stringContaining("人工作业")]));
    expect(passed.ergonomicsChecks?.[0]?.declaration).toContain("不输出 NIOSH");

    const overloaded = structuredClone(input);
    overloaded.ergonomicsProfiles![0]!.task!.loadMassKg = 12;
    const failed = auditWorkcell(overloaded);
    expect(failed.status).toBe("failed");
    expect(failed.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "ergonomics", severity: "error" }),
    ]));
    expect(failed.evidenceFingerprint).not.toBe(passed.evidenceFingerprint);

    const changedPolicy = structuredClone(input);
    changedPolicy.ergonomicsProfiles![0]!.policy!.maximumLoadKg = 9;
    const changedPolicyResult = auditWorkcell(changedPolicy);
    expect(changedPolicyResult.ergonomicsChecks?.[0]?.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "manual-load", limitValue: 9 }),
    ]));
    expect(changedPolicyResult.evidenceFingerprint).not.toBe(passed.evidenceFingerprint);

    delete input.ergonomicsProfiles![0]!.anthropometry;
    expect(auditWorkcell(input)).toMatchObject({ status: "needs-data", ergonomicsChecks: [{ status: "needs-data" }] });
  });
});

function humanFixture(): WorkcellAuditInput {
  return {
    sceneId: "scene-human",
    objects: [
      { id: "person", name: "操作员", role: "equipment", position: { x: 0, y: 0, z: 0 }, bounds: { min: { x: -.2, y: 0, z: -.2 }, max: { x: .2, y: 1.8, z: .2 } } },
      { id: "work-point", name: "装配点", role: "target", position: { x: .35, y: 1.08, z: 0 }, bounds: { min: { x: .34, y: 1.07, z: -.01 }, max: { x: .36, y: 1.09, z: .01 } } },
    ],
    ergonomicsProfiles: [{
      id: "human-task-1", name: "人工装配", operatorObjectId: "person",
      anthropometry: { method: "percentile", percentile: 50, statureMeters: 1.72, shoulderHeightMeters: 1.42, elbowHeightMeters: 1.08, functionalReachMeters: .75, source: "author-confirmed" },
      task: { workPointObjectId: "work-point", loadMassKg: 4, repetitionsPerHour: 30, durationMinutes: 45, source: "author-confirmed" },
      policy: { maximumLoadKg: 10, maximumRepetitionsPerHour: 60, maximumDurationMinutes: 60, neutralHeightToleranceMeters: .3, warningUtilizationRatio: .8, source: "author-confirmed" },
    }],
  };
}

function loadFixture(): WorkcellAuditInput {
  return {
    sceneId: "scene-load",
    objects: [
      {
        id: "robot", name: "机器人", role: "robot", position: { x: 0, y: 0, z: 0 },
        bounds: { min: { x: -.5, y: -.5, z: 0 }, max: { x: .5, y: .5, z: 2 } },
        robot: {
          base: { x: 0, y: 0, z: 0 },
          toolObjectId: "tool",
          targetObjectIds: ["target"],
          links: [{ id: "j1", name: "J1", length: 1, minAngleDeg: -180, maxAngleDeg: 180 }],
          loadCapability: { ratedPayloadKg: 20, maximumLoadCenterDistanceMeters: .35, source: "configured-prefab" },
          toolLoad: {
            toolMassKg: 4,
            carriedPayloadKg: 8,
            tcpPositionMeters: { x: 0, y: 0, z: .25 },
            tcpOrientationEulerDeg: { x: 0, y: 90, z: 0 },
            combinedCenterOfMassMeters: { x: 0, y: 0, z: .2 },
            source: "author-confirmed",
          },
        },
      },
      {
        id: "tool", name: "抓手", role: "tool", position: { x: 0, y: 0, z: 1.8 },
        bounds: { min: { x: -.1, y: -.1, z: 1.7 }, max: { x: .1, y: .1, z: 1.9 } },
      },
      {
        id: "target", name: "取料点", role: "target", position: { x: 1, y: 0, z: 0 },
        bounds: { min: { x: .99, y: -.01, z: -.01 }, max: { x: 1.01, y: .01, z: .01 } },
      },
    ],
  };
}

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
