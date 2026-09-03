import { describe, expect, it } from "vitest";
import type { PprBopVersionDraft, PprWorkInstructionQualityCheck } from "./ppr.js";

describe("PPR quality-control contract", () => {
  it("keeps a structured control point inside its owning BOP operation", () => {
    const qualityControl: PprWorkInstructionQualityCheck = {
      id: "quality-1",
      checkpoint: "紧固扭矩",
      specificationKind: "tolerance",
      targetValue: 12,
      tolerance: 1,
      unit: "N·m",
      inspectionMethod: "校准扭矩枪",
      samplingFrequency: { mode: "every-n-items", interval: 20 },
      outOfControlReaction: "停止工序并隔离本批",
    };
    const draft: PprBopVersionDraft = {
      planId: "plan-1",
      name: "装配计划",
      components: [{ id: "product-1", name: "整机", kind: "product" }],
      operations: [{
        id: "operation-1",
        name: "装配",
        standardTimeMinutes: 3,
        componentRefs: [{ componentId: "product-1", role: "output" }],
        workInstruction: { steps: [], safetyNotes: [], qualityChecks: [qualityControl] },
      }],
      precedenceRelations: [],
      resources: [],
      resourceAssignments: [],
    };

    const restored = JSON.parse(JSON.stringify(draft)) as PprBopVersionDraft;
    expect(restored.operations[0]?.workInstruction?.qualityChecks[0]).toEqual(qualityControl);
    expect(restored).not.toHaveProperty("qualityControlPoints");
  });
});
