import { evaluateWhatIfOperatingEnvelope, type WhatIfStudyRecord } from "@bim-studio/studio-core";
import { describe, expect, it } from "vitest";
import {
  compareWhatIfStudies,
  DEFAULT_WHAT_IF_DRAFT,
  whatIfDraftFromStudy,
  whatIfRequestFromDraft,
} from "./whatIfStudy";

function record(overrides: Partial<WhatIfStudyRecord> = {}): WhatIfStudyRecord {
  const request = whatIfRequestFromDraft(DEFAULT_WHAT_IF_DRAFT);
  const result = evaluateWhatIfOperatingEnvelope(request.input);
  return {
    id: "study-1",
    projectId: "project-1",
    name: request.name,
    createdAt: "2026-08-31T08:00:00.000Z",
    input: request.input,
    result,
    execution: {
      engineId: "deterministic-local-elasticity-envelope",
      engineVersion: "1.0.0",
      inputFingerprint: result.inputFingerprint,
      deterministic: true,
    },
    ...overrides,
  };
}

describe("what-if study presentation", () => {
  it("round-trips the focused editor fields through a stored request", () => {
    const study = record();
    expect(whatIfDraftFromStudy(study)).toEqual(DEFAULT_WHAT_IF_DRAFT);
    expect(study.result.predictions[0]?.predictedValue).toBe(108);
  });

  it("proves exact reproduction only with lineage and matching evidence", () => {
    const baseline = record();
    const reproduced = record({ id: "study-2", reproductionOf: baseline.id });
    expect(compareWhatIfStudies(baseline, reproduced)).toMatchObject({
      evidenceStatus: "verified",
      exactReproduction: true,
      riskChanged: false,
      metrics: [{ metricId: "throughput", delta: 0 }],
    });

    delete reproduced.execution;
    expect(compareWhatIfStudies(baseline, reproduced)).toMatchObject({
      evidenceStatus: "legacy-missing",
      exactReproduction: false,
    });
  });
});
