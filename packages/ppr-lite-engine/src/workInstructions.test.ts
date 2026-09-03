import { describe, expect, it } from "vitest";
import type { PprBopVersion } from "@bim-studio/contracts";
import { analyzePprBopVersion, comparePprBopVersions } from "./engine.js";
import { buildPprWorkInstructionPreview } from "./workInstructions.js";

describe("PPR electronic work instructions", () => {
  it("builds a readable preview in the supplied process order and keeps fallback operations", () => {
    const version = plan();
    const preview = buildPprWorkInstructionPreview(version, ["inspect"]);

    expect(preview.operations.map((operation) => operation.operationId)).toEqual(["inspect", "assemble"]);
    expect(preview.operations.map((operation) => operation.sequence)).toEqual([1, 2]);
    expect(preview.totalStepCount).toBe(3);
    expect(preview.totalQualityControlCount).toBe(2);
    expect(preview.operations[1]).toMatchObject({
      operationName: "装配",
      visualReferences: [{ kind: "scene", id: "assembly-scene" }, { kind: "object", id: "fixture-01" }],
    });
  });

  it("reports definition coverage and keeps legacy two-field checks as visible, incomplete evidence", () => {
    const version = plan();
    const ready = analyzePprBopVersion(version);
    expect(ready.qualityControl).toMatchObject({
      operationCount: 2,
      coveredOperationCount: 2,
      completeOperationCount: 2,
      controlPointCount: 2,
      completeControlPointCount: 2,
      qualityPlanReady: true,
      evidenceScope: "control-plan-definition-only",
    });

    version.operations[1]!.workInstruction!.qualityChecks = [{
      id: "legacy-check",
      checkpoint: "旧版外观验收",
      acceptanceCriteria: "无划伤",
    }];
    const legacy = analyzePprBopVersion(version);
    expect(legacy.issues).toContainEqual(expect.objectContaining({
      code: "incomplete-quality-control",
      entityId: "inspect",
      severity: "warning",
    }));
    expect(legacy.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(legacy.qualityControl).toMatchObject({ completeOperationCount: 1, qualityPlanReady: false });
  });

  it("rejects inverted limits, targets outside limits and invalid every-N sampling", () => {
    const version = plan();
    version.operations[0]!.workInstruction!.qualityChecks[0] = {
      ...version.operations[0]!.workInstruction!.qualityChecks[0]!,
      specificationKind: "limits",
      targetValue: 9,
      lowerLimit: 10,
      upperLimit: 5,
      samplingFrequency: { mode: "every-n-items", interval: 0 },
    };
    version.operations[0]!.workInstruction!.qualityChecks.push({
      id: "target-outside-limits",
      checkpoint: "同轴度",
      specificationKind: "limits",
      targetValue: 2,
      lowerLimit: 0,
      upperLimit: 1,
      unit: "mm",
      inspectionMethod: "百分表",
      samplingFrequency: { mode: "every-item" },
      outOfControlReaction: "停止工序并隔离工件",
    });
    const issues = analyzePprBopVersion(version).issues;
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid-quality-limits", entityId: "assemble", severity: "error" }),
      expect.objectContaining({ code: "invalid-quality-target", entityId: "assemble", severity: "error" }),
      expect.objectContaining({ code: "invalid-quality-sampling", entityId: "assemble", severity: "error" }),
    ]));
  });

  it("validates authored content and only accepts linked scene/object visual context", () => {
    const version = plan();
    version.operations[0]!.workInstruction = {
      steps: [{ id: "step-1", instruction: " " }],
      safetyNotes: [{ id: "note-1", note: "佩戴护目镜" }, { id: "note-1", note: "确认急停" }],
      qualityChecks: [{ id: "quality-1", checkpoint: "间隙", acceptanceCriteria: "" }],
      visualReferences: [
        { kind: "script", id: "runtime-script" } as never,
        { kind: "object", id: "not-linked" },
      ],
    };
    version.operations[1]!.workInstruction!.steps = [];

    const issues = analyzePprBopVersion(version).issues;
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid-work-instruction-item", entityId: "assemble", severity: "error" }),
      expect.objectContaining({ code: "invalid-work-instruction-visual-reference", entityId: "assemble", severity: "error" }),
      expect.objectContaining({ code: "unlinked-work-instruction-visual-reference", entityId: "assemble", severity: "warning" }),
      expect.objectContaining({ code: "missing-work-instruction-step", entityId: "inspect", severity: "error" }),
    ]));
  });

  it("tracks EWI edits as an operation change with normal version impact", () => {
    const before = plan();
    const after = structuredClone(before);
    after.id = "version-2";
    after.version = "v2";
    after.basedOnVersionId = before.id;
    after.operations[0]!.workInstruction!.qualityChecks[0]!.acceptanceCriteria = "间隙 0.4–0.7 mm";

    const comparison = comparePprBopVersions(before, after);
    expect(comparison.changes).toContainEqual({
      entityType: "operation",
      entityId: "assemble",
      changeType: "modified",
      changedFields: ["workInstruction"],
    });
    expect(comparison.impact).toMatchObject({ operationIds: ["assemble"], componentIds: ["product-1"] });
  });
});

function plan(): PprBopVersion {
  return {
    id: "version-1",
    planId: "assembly-plan",
    version: "v1",
    name: "总装计划",
    createdAt: "2026-09-03T08:00:00.000Z",
    references: [{ kind: "scene", id: "assembly-scene" }],
    components: [{ id: "product-1", name: "整机", kind: "product" }],
    operations: [
      {
        id: "assemble",
        name: "装配",
        standardTimeMinutes: 4,
        componentRefs: [{ componentId: "product-1", role: "in-process" }],
        references: [{ kind: "object", id: "fixture-01" }],
        workInstruction: {
          steps: [
            { id: "assemble-step-1", instruction: "将底座放入定位夹具" },
            { id: "assemble-step-2", instruction: "按对角顺序紧固四颗螺栓" },
          ],
          safetyNotes: [{ id: "assemble-safety-1", note: "夹具闭合前确认双手离开夹紧区" }],
          qualityChecks: [{
            id: "assemble-quality-1",
            checkpoint: "装配间隙",
            acceptanceCriteria: "按图纸特性 12 记录",
            specificationKind: "limits",
            targetValue: 0.65,
            lowerLimit: 0.5,
            upperLimit: 0.8,
            unit: "mm",
            inspectionMethod: "塞尺",
            samplingFrequency: { mode: "every-n-items", interval: 10 },
            outOfControlReaction: "停止装配并隔离本批",
          }],
          visualReferences: [{ kind: "scene", id: "assembly-scene" }, { kind: "object", id: "fixture-01" }],
        },
      },
      {
        id: "inspect",
        name: "终检",
        standardTimeMinutes: 2,
        componentRefs: [{ componentId: "product-1", role: "output" }],
        workInstruction: {
          steps: [{ id: "inspect-step-1", instruction: "记录间隙测量值" }],
          safetyNotes: [],
          qualityChecks: [{
            id: "inspect-quality-1",
            checkpoint: "终检间隙",
            specificationKind: "tolerance",
            targetValue: 0.65,
            tolerance: 0.15,
            unit: "mm",
            inspectionMethod: "塞尺",
            samplingFrequency: { mode: "every-item" },
            outOfControlReaction: "隔离不合格件并停止放行",
          }],
        },
      },
    ],
    precedenceRelations: [{ id: "assemble-inspect", predecessorOperationId: "assemble", successorOperationId: "inspect" }],
    resources: [],
    resourceAssignments: [],
  };
}
