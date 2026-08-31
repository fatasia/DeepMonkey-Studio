import { describe, expect, it } from "vitest";
import type { LogisticsExperimentResult } from "@bim-studio/contracts";
import { compareLogisticsStudies, logisticsRequestFromResult } from "./logisticsStudy";

function result(overrides: Partial<LogisticsExperimentResult> = {}): LogisticsExperimentResult {
  return {
    id: "run-1",
    projectId: "project-1",
    name: "基线工况",
    createdAt: "2026-08-31T08:00:00.000Z",
    agvCount: 4,
    bufferCapacity: 12,
    demandPerHour: 60,
    cycleTimeSec: 240,
    chargingMinutesPerHour: 5,
    congestionFactor: 0.2,
    durationHours: 8,
    throughputPerHour: 52,
    fulfilledRate: 0.8667,
    utilization: 0.8,
    averageWip: 8,
    leadTimeMinutes: 13.2,
    bottleneck: "transport",
    recommendation: "减少拥堵",
    fingerprint: "input-a",
    execution: {
      engineId: "factory-flow-analytic",
      engineVersion: "1.0.0",
      inputFingerprint: "input-a",
      deterministic: true,
    },
    ...overrides,
  };
}

describe("logistics study", () => {
  it("compares outcomes and classifies useful metric direction", () => {
    const comparison = compareLogisticsStudies(result(), result({
      id: "run-2",
      throughputPerHour: 58,
      fulfilledRate: 0.9667,
      averageWip: 7,
      leadTimeMinutes: 11.5,
      bottleneck: "demand",
      fingerprint: "input-b",
      execution: {
        engineId: "factory-flow-analytic",
        engineVersion: "1.0.0",
        inputFingerprint: "input-b",
        deterministic: true,
      },
    }));
    expect(comparison.evidenceStatus).toBe("verified");
    expect(comparison.bottleneckChanged).toBe(true);
    expect(comparison.metrics.find((item) => item.key === "throughputPerHour")).toMatchObject({
      delta: 6,
      impact: "improved",
    });
    expect(comparison.metrics.find((item) => item.key === "leadTimeMinutes")?.impact).toBe("improved");
  });

  it("proves an exact reproduction only when lineage, input and outputs match", () => {
    const baseline = result();
    const comparison = compareLogisticsStudies(baseline, result({
      id: "run-copy",
      reproductionOf: baseline.id,
    }));
    expect(comparison.exactReproduction).toBe(true);
    expect(logisticsRequestFromResult(baseline)).toEqual({
      name: "基线工况",
      agvCount: 4,
      bufferCapacity: 12,
      demandPerHour: 60,
      cycleTimeSec: 240,
      chargingMinutesPerHour: 5,
      congestionFactor: 0.2,
      durationHours: 8,
    });
  });

  it("does not fabricate execution evidence for legacy history", () => {
    const legacy = result();
    delete legacy.execution;
    const comparison = compareLogisticsStudies(legacy, result({ id: "run-2" }));
    expect(comparison.evidenceStatus).toBe("legacy-missing");
    expect(comparison.exactReproduction).toBe(false);
  });
});
