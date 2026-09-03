import type { IndustrialValidationStudyRecord, SceneSnapshot, WorkcellAuditResult } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { composeRobotWorkcellAssistant } from "./robotWorkcellAssistant";
import type { RobotWorkcellAssistantInput } from "./robotWorkcellAssistantTypes";
import { buildRobotWorkcellStudyInput, matchingRobotWorkcellStudy } from "./robotWorkcellStudy";

describe("robot workcell Study handoff", () => {
  it("stores the quick-screen evidence and preserves the unresolved engineering checks", () => {
    const input = assistantInput();
    const result = composeRobotWorkcellAssistant(input, auditResult());
    const existing = { id: "study-old", sourceRefs: ["older-evidence"] } as IndustrialValidationStudyRecord;
    const study = buildRobotWorkcellStudyInput({
      scene: sceneFixture(), input, result, existing, completedAt: "2026-09-03T01:00:00.000Z",
    });

    expect(study).toMatchObject({
      title: "机器人快速初筛：取放任务",
      sourceKind: "workcell-audit",
      studyType: "workcell-audit",
      sourceRefs: ["older-evidence", "audit-evidence", result.evidenceFingerprint],
      sceneId: "scene-1",
      objectIds: ["robot-1", "tool-1", "target-1", "fence-1"],
      execution: { engineId: "manufacturing.robot-workcell.screening", deterministic: true },
      baselineStudyId: "study-old",
      reproductionOf: "study-old",
      latestResult: { status: "passed", failureCount: 0, evidenceFingerprint: result.evidenceFingerprint },
      scenarioInput: {
        kind: "robot-workcell-quick-screen-v1",
        taskDraft: { robotId: "robot-1", controllerProgramGenerated: false },
        quickScreening: {
          status: "ready-for-control-validation",
          loadScreening: { status: "within-planning-envelope", totalLoadKg: 12 },
          remainingEngineeringChecks: expect.arrayContaining([
            expect.stringContaining("完整 IK"),
            expect.stringContaining("网格级连续扫掠碰撞"),
          ]),
        },
      },
    });
    expect(study.acceptanceCriteria).toEqual(expect.arrayContaining([
      expect.stringContaining("控制逻辑"),
      expect.stringContaining("完整 IK"),
    ]));
    expect(matchingRobotWorkcellStudy(study as IndustrialValidationStudyRecord, "scene-1", "robot-1")).toBe(study);
    expect(matchingRobotWorkcellStudy(study as IndustrialValidationStudyRecord, "scene-1", "another-robot")).toBeUndefined();
  });

  it("does not serialize a blocked quick screen as a passed Study", () => {
    const input = assistantInput();
    input.targets[0] = { ...input.targets[0]!, jointAnglesDeg: [240] };
    const result = composeRobotWorkcellAssistant(input, auditResult());
    const study = buildRobotWorkcellStudyInput({ scene: sceneFixture(), input, result });

    expect(result.status).toBe("blocked");
    expect(study.latestResult).toMatchObject({ status: "failed", failureCount: 1 });
  });
});

function assistantInput(): RobotWorkcellAssistantInput {
  return {
    sceneId: "scene-1", taskName: "取放任务",
    robot: {
      id: "robot-1", name: "机器人", baseBonePath: "root", base: { x: 0, y: 0, z: 0 },
      currentTcpPosition: { x: 0, y: 0, z: 0 }, bounds: bounds(-.5, .5),
      toolObjectId: "tool-1",
      loadCapability: { ratedPayloadKg: 20, maximumLoadCenterDistanceMeters: .35, source: "configured-prefab" },
      toolLoad: {
        toolMassKg: 4, carriedPayloadKg: 8,
        tcpPositionMeters: { x: 0, y: 0, z: .25 }, tcpOrientationEulerDeg: { x: 0, y: 90, z: 0 },
        combinedCenterOfMassMeters: { x: 0, y: 0, z: .2 }, source: "author-confirmed",
      },
      joints: [{ bonePath: "root/j1", name: "J1", axis: "z", length: 2, minAngleDeg: -180, maxAngleDeg: 180, currentAngleDeg: 0 }],
    },
    targets: [{
      id: "target-1", name: "取料点", position: { x: 1, y: 0, z: 0 },
      orientationEulerDeg: { x: 0, y: 0, z: 0 }, jointAnglesDeg: [30], processTimeSec: 1,
    }],
    objects: [
      { id: "tool-1", name: "抓手", role: "tool", position: { x: 0, y: 0, z: 0 }, bounds: bounds(-.1, .1) },
      { id: "fence-1", name: "围栏", role: "obstacle", position: { x: 3, y: 0, z: 0 }, bounds: bounds(2.5, 3.5) },
    ],
    cycleGoal: { targetSec: 10, tcpSpeedMps: 1, tcpRadiusMeters: .1, jointSpeedDegPerSec: 90, controllerOverheadSec: .2, toolActionSec: .5, safetyMarginPercent: 10 },
    clearanceThreshold: .25,
    planningAssumptions: { origin: "authored", status: "engineer-confirmed" },
  };
}

function auditResult(): WorkcellAuditResult {
  return {
    generatedBy: "workcell-validation-plugin", sceneId: "scene-1", status: "passed", summary: "快速初筛完成",
    inventory: { robot: 1, tool: 1, target: 1, equipment: 0, obstacle: 1, unknown: 0 }, findings: [],
    collisionPairs: [{ objectIds: ["robot-1", "fence-1"], distance: 2, intersects: false, required: true }],
    reachability: [{ robotId: "robot-1", targetId: "target-1", distance: 1, minimumReach: 0, maximumReach: 2, status: "reachable" }],
    loadChecks: [{
      robotId: "robot-1", toolObjectId: "tool-1", status: "within-planning-envelope", violations: [], missingFields: [],
      ratedPayloadKg: 20, totalLoadKg: 12, payloadUtilization: .6,
      maximumLoadCenterDistanceMeters: .35, loadCenterDistanceMeters: .2, loadCenterUtilization: .2 / .35,
      tcpOffsetDistanceMeters: .25, evidenceCoverage: 1, capabilitySource: "configured-prefab", toolLoadSource: "author-confirmed",
      declaration: "仅做规划筛查。",
    }],
    incompleteObjectIds: [], evidenceCoverage: 1, evidenceFingerprint: "audit-evidence",
    validationDraft: { objective: "验证取放任务", acceptanceCriteria: ["快速初筛"], objectIds: ["robot-1", "target-1"] },
  };
}

function sceneFixture(): SceneSnapshot {
  return {
    schemaVersion: 1, id: "scene-1", projectId: "project-1", name: "装配工位",
    camera: { position: { x: 3, y: 3, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [], primitives: [], measurements: [], createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function bounds(min: number, max: number) {
  return { min: { x: min, y: min, z: min }, max: { x: max, y: max, z: max } };
}
