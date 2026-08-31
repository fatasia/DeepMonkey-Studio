import type { IndustrialValidationStudyRecord, SceneSnapshot, WorkcellAuditInput, WorkcellAuditResult } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { buildWorkcellAuditStudyInput, matchingWorkcellStudy } from "./workcellAuditStudy";

const scene = { id: "scene-1", name: "焊装工位" } as SceneSnapshot;
const scenarioInput: WorkcellAuditInput = {
  sceneId: scene.id,
  objects: [{ id: "robot-1", name: "机器人", role: "robot", position: { x: 0, y: 0, z: 0 } }],
};

function auditResult(status: WorkcellAuditResult["status"]): WorkcellAuditResult {
  return {
    generatedBy: "workcell-validation-plugin",
    status,
    sceneId: scene.id,
    summary: "发现机器人与围栏间隙不足",
    inventory: { robot: 1, tool: 0, target: 1, equipment: 0, obstacle: 1, unknown: 0 },
    findings: status === "passed" ? [] : [{
      id: "clearance-1",
      category: "clearance",
      severity: "warning",
      title: "安全间隙不足",
      detail: "机器人与围栏间距低于阈值",
      objectIds: ["robot-1", "fence-1"],
      nextAction: "调整围栏位置",
    }],
    collisionPairs: [],
    reachability: [],
    incompleteObjectIds: [],
    evidenceCoverage: 1,
    evidenceFingerprint: `workcell-${status}`,
    validationDraft: {
      objective: "复核机器人可达性与安全间隙",
      acceptanceCriteria: ["安全间隙满足阈值"],
      objectIds: ["robot-1", "fence-1"],
    },
  };
}

describe("workcell audit study evidence", () => {
  it("persists an actionable audit as the latest failed Study result", () => {
    const input = buildWorkcellAuditStudyInput({
      scene,
      result: auditResult("warning"),
      scenarioInput,
      completedAt: "2026-08-31T08:00:00.000Z",
    });

    expect(input).toMatchObject({
      title: "工位验证：焊装工位",
      sourceKind: "workcell-audit",
      studyType: "workcell-audit",
      sourceRefs: ["workcell-warning"],
      scenarioInput,
      execution: {
        engineId: "manufacturing.workcell.audit",
        engineVersion: "1.1.0",
        deterministic: true,
      },
      context: {
        sceneFingerprint: expect.any(String),
        modelFingerprint: expect.any(String),
        versionFingerprint: expect.any(String),
      },
      latestResult: {
        status: "failed",
        scenarioId: "workcell-audit:scene-1",
        evidenceFingerprint: "workcell-warning",
        failureCount: 1,
        completedAt: "2026-08-31T08:00:00.000Z",
      },
    });
  });

  it("updates the matching record and retains its evidence lineage", () => {
    const existing = {
      id: "study-1",
      revision: 3,
      sourceKind: "workcell-audit",
      sceneId: scene.id,
      sourceRefs: ["workcell-warning"],
    } as IndustrialValidationStudyRecord;
    const input = buildWorkcellAuditStudyInput({ scene, result: auditResult("passed"), scenarioInput, existing });

    expect(input).toMatchObject({
      sourceRefs: ["workcell-warning", "workcell-passed"],
      baselineStudyId: "study-1",
      reproductionOf: "study-1",
      latestResult: { status: "passed", failureCount: 0 },
    });
    expect(matchingWorkcellStudy(existing, scene.id)).toBe(existing);
    expect(matchingWorkcellStudy(existing, "another-scene")).toBeUndefined();
  });
});
