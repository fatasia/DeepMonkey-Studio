import { describe, expect, it } from "vitest";
import type { ModelRecord, ParametricCadBuildSummary } from "@bim-studio/contracts";
import { PARAMETRIC_CAD_TEMPLATES } from "@bim-studio/parametric-modeling-plugin";
import { createParametricGeneration } from "./parametricGeneration";

const build: ParametricCadBuildSummary = {
  durationMs: 20, volumeMm3: 100, faceCount: 6, edgeCount: 12, triangleCount: 24,
  bounds: [[0, 0, 0], [10, 10, 10]], warnings: []
};

describe("createParametricGeneration", () => {
  it("starts a new immutable chain at revision one", () => {
    const result = createParametricGeneration(PARAMETRIC_CAD_TEMPLATES[0]!.definition, build, undefined, "2026-08-28T00:00:00.000Z");
    expect(result).toMatchObject({ revision: 1, generatedAt: "2026-08-28T00:00:00.000Z" });
    expect(result.supersedesModelId).toBeUndefined();
  });

  it("creates the next revision without mutating the previous model", () => {
    const first = createParametricGeneration(PARAMETRIC_CAD_TEMPLATES[0]!.definition, build);
    const previous = { id: "model-v1", generation: first } as ModelRecord;
    const next = createParametricGeneration(PARAMETRIC_CAD_TEMPLATES[1]!.definition, build, previous);
    expect(next).toMatchObject({ revision: 2, supersedesModelId: "model-v1" });
    expect(previous.generation?.revision).toBe(1);
  });
});
