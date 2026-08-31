import { describe, expect, it } from "vitest";
import type { IndustrialStudyRecord } from "./industrialStudy.js";
import { industrialStudyEvidenceGaps } from "./industrialStudyValidation.js";

describe("industrial Study evidence contract", () => {
  it("requires scene and model evidence only when the Study references scene objects", () => {
    const detached = record();
    expect(industrialStudyEvidenceGaps(detached)).toEqual([]);
    expect(industrialStudyEvidenceGaps({
      ...detached,
      context: { ...detached.context, sceneId: "scene-1", objectIds: ["robot-1"] },
    })).toEqual(["scene-fingerprint", "model-fingerprint"]);
  });

  it("reports legacy reproducibility gaps without inventing defaults", () => {
    const value = record();
    expect(industrialStudyEvidenceGaps({
      ...value,
      scenarioInput: null,
      execution: null,
      fingerprints: { input: null, scene: null, model: null, version: null, evidence: null },
    })).toEqual(["scenario-input", "execution", "input-fingerprint", "version-fingerprint", "result-evidence"]);
  });
});

function record(): IndustrialStudyRecord {
  return {
    id: "what-if:study-1",
    sourceRecordId: "study-1",
    projectId: "project-1",
    type: "what-if",
    title: "What-if",
    scenarioInput: { changes: [] },
    context: { sceneId: null, objectIds: [], modelId: null, modelVersion: null },
    fingerprints: { input: "input", scene: null, model: null, version: "version", evidence: "evidence" },
    execution: { engineId: "engine", engineVersion: "1.0.0", deterministic: true },
    run: { status: "completed", cancellable: false },
    result: { headline: "完成", metrics: [], evidenceRefs: ["evidence"], completedAt: "now" },
    lineage: { baselineStudyId: null, reproductionOf: null },
    reproduction: { kind: "rerun", operationsTab: "whatif" },
    createdAt: "now",
    updatedAt: "now",
  };
}
