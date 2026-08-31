import { describe, expect, it } from "vitest";
import {
  evaluateWhatIfOperatingEnvelope,
  type WhatIfOperatingEnvelopeInput,
} from "./whatIfOperatingEnvelope.js";

describe("what-if operating envelope", () => {
  it("explains absolute and relative elasticity contributions", () => {
    const result = evaluateWhatIfOperatingEnvelope(baseInput());

    expect(result.predictions).toEqual([
      expect.objectContaining({ metricId: "energy", baseline: 50, predictedDelta: 2.5, predictedValue: 52.5, modeled: true }),
      expect.objectContaining({ metricId: "throughput", baseline: 100, predictedDelta: 8, predictedValue: 108, relativeDelta: 0.08 }),
    ]);
    expect(result.predictions.find((item) => item.metricId === "energy")?.contributions).toEqual([
      expect.objectContaining({ variableId: "speed", predictedDelta: 1.5, formula: "baseline × coefficient × change" }),
      expect.objectContaining({ variableId: "temperature", predictedDelta: 1, formula: "coefficient × change" }),
    ]);
    expect(result.applicability.status).toBe("supported");
    expect(result.risk.level).toBe("low");
    expect(result.nonSolverDeclaration).toContain("不是物理、离散事件或优化求解器结果");
  });

  it("reports constraint exceedance and preserves declared severity", () => {
    const input = baseInput();
    input.changes = [{ variableId: "speed", delta: 0.2, mode: "relative" }];
    input.elasticities = [{
      variableId: "speed", metricId: "throughput", coefficient: 1,
      inputMode: "relative", outputMode: "relative", reliability: 0.95,
    }];
    input.constraints = [{ constraintId: "throughput-limit", metricId: "throughput", maximum: 110, severity: "critical" }];

    const result = evaluateWhatIfOperatingEnvelope(input);
    expect(result.constraintEvaluations).toEqual([expect.objectContaining({
      constraintId: "throughput-limit",
      predictedValue: 120,
      marginToMaximum: -10,
      violatedBounds: ["maximum"],
      violated: true,
      normalizedExceedance: expect.any(Number),
    })]);
    expect(result.violatedConstraintIds).toEqual(["throughput-limit"]);
    expect(result.risk).toMatchObject({ level: "critical", reasons: [expect.stringContaining("throughput-limit")] });
  });

  it("marks extrapolation outside the declared domain and lowers confidence", () => {
    const input = baseInput();
    input.changes = [{ variableId: "speed", delta: 0.5, mode: "relative" }];
    input.elasticities = [{
      variableId: "speed", metricId: "throughput", coefficient: 0.8,
      inputMode: "relative", outputMode: "relative", reliability: 1,
    }];
    const result = evaluateWhatIfOperatingEnvelope(input);

    expect(result.predictions.find((item) => item.metricId === "throughput")).toMatchObject({ predictedValue: 140 });
    expect(result.applicability).toMatchObject({ status: "out-of-domain" });
    expect(result.applicability.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectType: "variable", subjectId: "speed", status: "outside" }),
      expect.objectContaining({ subjectType: "predicted-metric", subjectId: "throughput", status: "outside" }),
    ]));
    expect(result.confidence).toMatchObject({ score: 0.35, level: "low" });
    expect(result.risk).toMatchObject({ level: "critical", reasons: expect.arrayContaining(["工况超出声明适用域"]) });
  });

  it("keeps the evidence fingerprint stable across input ordering", () => {
    const firstInput = baseInput();
    const secondInput = baseInput();
    secondInput.baselines = [...secondInput.baselines].reverse();
    secondInput.changes = [...secondInput.changes].reverse();
    secondInput.elasticities = [...secondInput.elasticities].reverse();
    secondInput.constraints = [...secondInput.constraints].reverse();
    secondInput.applicabilityDomain = {
      ...secondInput.applicabilityDomain,
      variableRanges: [...secondInput.applicabilityDomain.variableRanges].reverse(),
      metricRanges: [...secondInput.applicabilityDomain.metricRanges].reverse(),
    };

    const first = evaluateWhatIfOperatingEnvelope(firstInput);
    const second = evaluateWhatIfOperatingEnvelope(secondInput);
    expect(first.inputFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f\d]{16}$/);
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
    expect(first.evidenceFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f\d]{16}$/);
    expect(first.evidenceFingerprint).toBe(second.evidenceFingerprint);
    expect(first.predictions).toEqual(second.predictions);
  });

  it("surfaces missing elasticity coverage instead of inventing a response", () => {
    const input = baseInput();
    input.changes = [
      ...input.changes,
      { variableId: "valve-opening", delta: 5, mode: "absolute" },
    ];
    input.applicabilityDomain = {
      ...input.applicabilityDomain,
      variableRanges: [
        ...input.applicabilityDomain.variableRanges,
        { variableId: "valve-opening", mode: "absolute", minimumDelta: -10, maximumDelta: 10 },
      ],
    };
    const result = evaluateWhatIfOperatingEnvelope(input);

    expect(result.unmodeledVariableIds).toEqual(["valve-opening"]);
    expect(result.applicability.status).toBe("caution");
    expect(result.applicability.checks).toContainEqual(expect.objectContaining({
      subjectType: "elasticity-coverage",
      subjectId: "valve-opening",
      status: "unknown",
    }));
    expect(result.confidence.level).toBe("low");
  });

  it("rejects ambiguous units and invalid contracts before calculation", () => {
    const modeMismatch = baseInput();
    modeMismatch.elasticities = [{
      variableId: "speed", metricId: "throughput", coefficient: 0.8,
      inputMode: "absolute", outputMode: "relative", reliability: 0.9,
    }];
    expect(() => evaluateWhatIfOperatingEnvelope(modeMismatch)).toThrow("输入模式不一致");

    const duplicate = baseInput();
    duplicate.baselines = [...duplicate.baselines, { metricId: "energy", value: 60 }];
    expect(() => evaluateWhatIfOperatingEnvelope(duplicate)).toThrow("基线指标 ID 必须非空且唯一");
  });
});

function baseInput(): WhatIfOperatingEnvelopeInput {
  return {
    baselines: [
      { metricId: "throughput", value: 100, unit: "t/h" },
      { metricId: "energy", value: 50, unit: "kWh" },
    ],
    changes: [
      { variableId: "speed", delta: 0.1, mode: "relative" },
      { variableId: "temperature", delta: 5, mode: "absolute", unit: "°C" },
    ],
    elasticities: [
      {
        variableId: "speed", metricId: "throughput", coefficient: 0.8,
        inputMode: "relative", outputMode: "relative", reliability: 0.9, evidenceRef: "calibration/run-24",
      },
      {
        variableId: "speed", metricId: "energy", coefficient: 0.3,
        inputMode: "relative", outputMode: "relative", reliability: 0.8,
      },
      {
        variableId: "temperature", metricId: "energy", coefficient: 0.2,
        inputMode: "absolute", outputMode: "absolute", reliability: 0.7,
      },
    ],
    constraints: [
      { constraintId: "throughput-high", metricId: "throughput", maximum: 115, severity: "critical" },
      { constraintId: "energy-high", metricId: "energy", maximum: 60, severity: "warning" },
    ],
    applicabilityDomain: {
      variableRanges: [
        { variableId: "speed", mode: "relative", minimumDelta: -0.2, maximumDelta: 0.2 },
        { variableId: "temperature", mode: "absolute", minimumDelta: -10, maximumDelta: 10 },
      ],
      metricRanges: [
        { metricId: "throughput", minimum: 80, maximum: 125 },
        { metricId: "energy", minimum: 40, maximum: 65 },
      ],
      evidenceRef: "envelope/line-a-v3",
    },
  };
}
