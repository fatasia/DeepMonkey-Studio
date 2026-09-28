import { describe, expect, it } from "vitest";
import { createObjectHeader, type DigitalThreadObject, type IndustrialStudyRecord, type PprBopVersion } from "@bim-studio/contracts";
import { comparePprBopVersions } from "@bim-studio/ppr-lite-engine";
import { assessStudyChangeImpact, type StudyChangeBinding } from "./studyChangeImpact.js";

const before: PprBopVersion = {
  id: "bop-1", planId: "line", version: "v1", createdAt: "2026-09-28", name: "装配",
  components: [{ id: "frame", name: "门框", kind: "part" }, { id: "panel", name: "门板", kind: "part" }],
  operations: [
    { id: "weld", name: "焊接", standardTimeMinutes: 4, componentRefs: [{ componentId: "frame", role: "input" }], workInstruction: { steps: [{ id: "step-1", instruction: "焊接" }], safetyNotes: [], qualityChecks: [] } },
    { id: "paint", name: "喷涂", standardTimeMinutes: 4, componentRefs: [{ componentId: "panel", role: "input" }] },
  ],
  precedenceRelations: [],
  resources: [{ id: "robot", name: "焊接机器人", kind: "robot" }, { id: "sprayer", name: "喷涂设备", kind: "equipment" }],
  resourceAssignments: [{ id: "weld-robot", operationId: "weld", resourceId: "robot" }, { id: "paint-sprayer", operationId: "paint", resourceId: "sprayer" }],
};
const after = structuredClone(before);
after.id = "bop-2";
after.version = "v2";
after.resources[0]!.capacity = 2;
const comparison = comparePprBopVersions(before, after);

function study(id: string, baselineStudyId: string | null = null): IndustrialStudyRecord {
  return {
    id, sourceRecordId: id, projectId: "p", type: "plant-lite", title: id,
    scenarioInput: null, context: { sceneId: null, objectIds: [], modelId: null, modelVersion: null },
    fingerprints: { input: null, scene: null, model: null, version: null, evidence: null },
    execution: null, run: { status: "completed", cancellable: false }, result: null,
    lineage: { baselineStudyId, reproductionOf: null }, reproduction: { kind: "rerun", operationsTab: "logistics" },
    createdAt: "2026-09-28", updatedAt: "2026-09-28",
  };
}
function binding(studyId: string, kind: StudyChangeBinding["entities"][number]["kind"], id: string): StudyChangeBinding {
  return { studyId, planId: "line", versionId: "bop-1", entities: [{ kind, id }], assets: [] };
}
function evaluate(studies: IndustrialStudyRecord[], bindings: StudyChangeBinding[], extra = {}) {
  return assessStudyChangeImpact({ studies, bindings, before, after, comparison, ...extra });
}

describe("Study change impact without inferred dependencies", () => {
  it("marks only the dependent Study stale after a single resource change and retains historical baseline", () => {
    const original = study("plant-lite:baseline");
    const candidate = study("plant-lite:candidate", original.id);
    const inputStudies = structuredClone([original, candidate, study("plant-lite:paint")]);
    const result = evaluate(inputStudies, [binding(original.id, "operation", "weld"), binding(candidate.id, "resource", "robot"), binding("plant-lite:paint", "operation", "paint")]);
    expect(result.studies.map(({ status }) => status)).toEqual(["stale", "stale", "fresh"]);
    expect(result.studies[1]?.baselineStudyId).toBe(original.id);
    expect(result.studies[0]?.reasons[0]).toMatchObject({ code: "ppr-changed", subject: "operation:weld" });
    expect(inputStudies).toEqual([original, candidate, study("plant-lite:paint")]);
    expect(before.resources[0]?.capacity).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it("tracks BOM and EWI independently, including deleted relation endpoints", () => {
    const newer = structuredClone(before);
    newer.id = "bop-3";
    newer.components[0]!.name = "新版门框";
    newer.operations[1]!.workInstruction = { steps: [{ id: "paint-step", instruction: "戴口罩" }], safetyNotes: [], qualityChecks: [] };
    newer.precedenceRelations.push({ id: "weld-paint", predecessorOperationId: "weld", successorOperationId: "paint" });
    const changed = comparePprBopVersions(before, newer);
    const result = assessStudyChangeImpact({ studies: [study("bom"), study("ewi"), study("paint")],
      bindings: [binding("bom", "component", "frame"), binding("ewi", "operation", "paint"), binding("paint", "resource", "sprayer")],
      before, after: newer, comparison: changed });
    expect(result.studies.map(({ status }) => status)).toEqual(["stale", "stale", "fresh"]);
    expect(result.studies[1]?.reasons[0]?.message).toContain("workInstruction");

    const withoutAssignment = structuredClone(before);
    withoutAssignment.id = "bop-4";
    withoutAssignment.resourceAssignments = withoutAssignment.resourceAssignments.filter((item) => item.id !== "weld-robot");
    const deleted = assessStudyChangeImpact({ studies: [study("weld")], bindings: [binding("weld", "operation", "weld")], before, after: withoutAssignment, comparison: comparePprBopVersions(before, withoutAssignment) });
    expect(deleted.studies[0]?.reasons[0]?.message).toContain("资源分配");
  });

  it("reports unknown for missing, mismatched, duplicate or deleted dependency rather than guessing fresh", () => {
    const b = binding("duplicate", "resource", "robot");
    const invalid = { ...binding("mismatch", "resource", "robot"), versionId: "other-version" };
    const result = evaluate([study("missing"), study("duplicate"), study("mismatch"), study("deleted"), study("empty")],
      [b, b, invalid, binding("deleted", "resource", "no-resource"), { ...binding("empty", "resource", "robot"), entities: [] }, binding("unknown-study", "resource", "robot")]);
    expect(result.studies.map(({ status }) => status)).toEqual(["unknown", "unknown", "unknown", "unknown", "unknown"]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining(["missing-binding", "duplicate-binding", "invalid-binding", "missing-entity", "missing-study"]));
    expect(() => assessStudyChangeImpact({ studies: [], bindings: [], before, after: { ...after, planId: "other" }, comparison })).toThrow("同一工艺计划");
  });

  it("detects package revision and mismatched source hash, preserving clean unrelated assets", () => {
    const snapshot = { packageId: "pkg:robot", revision: 2, sourceHash: "hash-2" };
    const assets = [{ modelId: "model-robot", snapshot }];
    const old = { ...binding("old", "resource", "sprayer"), assets };
    const clean = { ...binding("clean", "resource", "sprayer"), assets: [{ modelId: "model-paint", snapshot: { packageId: "pkg:paint", revision: 1, sourceHash: "same" } }] };
    const current = [{ modelId: "model-robot", snapshot: { ...snapshot, revision: 3, sourceHash: "hash-3" } }, { modelId: "model-paint", snapshot: clean.assets[0]!.snapshot }];
    const result = evaluate([study("old"), study("clean")], [old, clean], { assetHeads: current });
    expect(result.studies.map(({ status }) => status)).toEqual(["stale", "fresh"]);
    expect(result.studies[0]?.reasons[0]).toMatchObject({ code: "asset-revised", subject: "model-robot" });
    const sameRevision = evaluate([study("old")], [old], { assetHeads: [{ modelId: "model-robot", snapshot: { ...snapshot, sourceHash: "different" } }] });
    expect(sameRevision.studies[0]?.status).toBe("stale");
    const deleted = evaluate([study("old")], [old]);
    expect(deleted.studies[0]?.status).toBe("unknown");
    expect(deleted.diagnostics[0]?.code).toBe("missing-asset");
    const conflicted = evaluate([study("old")], [old], { assetHeads: [current[0], { modelId: "model-robot", snapshot: { ...snapshot, revision: 4 } }] });
    expect(conflicted.studies[0]?.status).toBe("unknown");
    expect(conflicted.diagnostics.map((item) => item.code)).toContain("asset-revision-conflict");
  });

  it("reports a deleted directly bound resource and a changed plan-wide dependency", () => {
    const newer = structuredClone(before);
    newer.id = "bop-removed";
    newer.resources = newer.resources.filter((resource) => resource.id !== "robot");
    newer.resourceAssignments = newer.resourceAssignments.filter((assignment) => assignment.resourceId !== "robot");
    const changed = comparePprBopVersions(before, newer);
    const result = assessStudyChangeImpact({ studies: [study("deleted-resource"), study("whole-plan")], bindings: [binding("deleted-resource", "resource", "robot"), binding("whole-plan", "plan", "line")], before, after: newer, comparison: changed });
    expect(result.studies.map((item) => item.status)).toEqual(["stale", "stale"]);
    expect(result.studies[0]?.reasons[0]?.message).toContain("已删除");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "missing-entity", studyId: "deleted-resource" }));
    expect(result.studies[1]?.reasons[0]?.subject).toBe("plan:line");
  });

  it("detects newly added assignment and precedence as operation dependencies", () => {
    const newer = structuredClone(before);
    newer.id = "bop-new-edges";
    newer.precedenceRelations.push({ id: "weld-paint", predecessorOperationId: "weld", successorOperationId: "paint" });
    newer.resourceAssignments.push({ id: "paint-robot", operationId: "paint", resourceId: "robot" });
    const impact = assessStudyChangeImpact({ studies: [study("paint"), study("isolated")], bindings: [binding("paint", "operation", "paint"), binding("isolated", "component", "frame")], before, after: newer, comparison: comparePprBopVersions(before, newer) });
    expect(impact.studies.map((item) => item.status)).toEqual(["stale", "fresh"]);
    expect(impact.studies[0]?.reasons[0]?.message).toContain("资源分配");
  });

  it("diagnoses a linked Study result with an invalid baseline while leaving unrelated Study fresh", () => {
    const result: DigitalThreadObject = { ...createObjectHeader({ stableId: "result-bad", kind: "study-result", at: "2026-09-28" }), kind: "study-result", payload: { studyRecordId: "run-bad" } };
    const badBaseline: DigitalThreadObject = { ...createObjectHeader({ stableId: "baseline-bad", kind: "release-baseline", at: "2026-09-28" }), kind: "release-baseline", payload: { entries: [{ stableId: "missing-object", version: 1 }] } };
    const evaluated = evaluate([study("run-bad"), study("other")], [binding("run-bad", "resource", "sprayer"), binding("other", "resource", "sprayer")], { threadObjects: [result, badBaseline] });
    expect(evaluated.studies.map((item) => item.status)).toEqual(["fresh", "fresh"]);
    expect(evaluated.diagnostics.some((item) => item.message.includes("missing-object"))).toBe(true);
  });

  it("diagnoses broken thread links without treating external Study records as missing thread objects", () => {
    const result: DigitalThreadObject = { ...createObjectHeader({ stableId: "result-1", kind: "study-result", at: "2026-09-28" }), kind: "study-result", payload: { studyRecordId: "run-1" } };
    const known = evaluate([study("run-1")], [binding("run-1", "resource", "sprayer")], { threadObjects: [result] });
    expect(known.diagnostics).toEqual([]);
    const broken: DigitalThreadObject = { ...createObjectHeader({ stableId: "result-2", kind: "study-result", at: "2026-09-28" }), kind: "study-result", payload: { studyRecordId: "run-deleted" } };
    const missing = evaluate([study("run-1")], [binding("run-1", "resource", "sprayer")], { threadObjects: [broken] });
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: "thread-link", message: expect.stringContaining("run-deleted") }));
  });
});
