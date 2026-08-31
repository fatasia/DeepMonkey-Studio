import { describe, expect, it } from "vitest";
import type { WhatIfStudyRequest } from "@bim-studio/studio-core";
import { reproduceWhatIfStudy, runWhatIfStudy } from "./whatIfStudy.js";

const request: WhatIfStudyRequest = {
  name: " 速度提升筛查 ",
  input: {
    baselines: [{ metricId: "throughput", value: 100 }],
    changes: [{ variableId: "speed", delta: 0.1, mode: "relative" }],
    elasticities: [{
      variableId: "speed",
      metricId: "throughput",
      coefficient: 0.8,
      inputMode: "relative",
      outputMode: "relative",
      reliability: 0.9,
    }],
    constraints: [{ constraintId: "throughput-range", metricId: "throughput", minimum: 80, maximum: 120, severity: "critical" }],
    applicabilityDomain: {
      variableRanges: [{ variableId: "speed", mode: "relative", minimumDelta: -0.2, maximumDelta: 0.2 }],
      metricRanges: [{ metricId: "throughput", minimum: 80, maximum: 120 }],
    },
  },
};

describe("what-if study record", () => {
  it("runs on the server and records deterministic execution evidence", () => {
    const record = runWhatIfStudy("project-1", request, "2026-08-31T08:00:00.000Z");

    expect(record).toMatchObject({
      projectId: "project-1",
      name: "速度提升筛查",
      createdAt: "2026-08-31T08:00:00.000Z",
      result: { predictions: [{ predictedValue: 108 }] },
      execution: {
        engineId: "deterministic-local-elasticity-envelope",
        engineVersion: "1.0.0",
        deterministic: true,
      },
    });
    expect(record.execution?.inputFingerprint).toBe(record.result.inputFingerprint);
  });

  it("creates a new lineage record with identical input and result evidence", () => {
    const source = runWhatIfStudy("project-1", request, "2026-08-31T08:00:00.000Z");
    const reproduced = reproduceWhatIfStudy("project-1", source, "2026-08-31T09:00:00.000Z");

    expect(reproduced.id).not.toBe(source.id);
    expect(reproduced.reproductionOf).toBe(source.id);
    expect(reproduced.execution?.inputFingerprint).toBe(source.execution?.inputFingerprint);
    expect(reproduced.result.evidenceFingerprint).toBe(source.result.evidenceFingerprint);
  });
});
