import { describe, expect, it } from "vitest";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { plantLiteMeasurementEvidenceText, plantLiteMeasurementWindow } from "./plantLiteMeasurementWindow";

describe("Plant Lite measurement window evidence", () => {
  it("states total, warmup and measured minutes without blurring their meaning", () => {
    const study = record({ durationMinutes: 480, warmupMinutes: 60, maxEvents: 100_000, maxResources: 100 });
    expect(plantLiteMeasurementWindow(study)).toEqual({ totalMinutes: 480, warmupMinutes: 60, measurementMinutes: 420 });
    expect(plantLiteMeasurementEvidenceText(study)).toContain("总运行 480 分钟 · 预热 60 分钟 · 正式统计 420 分钟");
    expect(plantLiteMeasurementEvidenceText(study)).toContain("指标只采集正式窗口");
  });

  it("uses the explicit zero-warmup meaning for an old record", () => {
    const study = record({ durationMinutes: 480, maxEvents: 100_000, maxResources: 100 });
    expect(plantLiteMeasurementWindow(study)).toEqual({ totalMinutes: 480, warmupMinutes: 0, measurementMinutes: 480 });
  });
});

function record(limits: PlantLiteStudyRecord["execution"]["limits"]): PlantLiteStudyRecord {
  const interval = { mean: 1, sampleStandardDeviation: 0, lower95: 1, upper95: 1, samples: 3 };
  return {
    id: "study", projectId: "project", createdAt: "2026-09-03T00:00:00.000Z", name: "窗口证据", templateId: "agv-line-v1",
    seed: "seed", replications: 3, inputFingerprint: "input",
    outcome: { status: "completed", completedReplications: 3, throughputPerHour: interval, averageWip: interval, averageLeadTimeMinutes: interval, resourceUtilization95: {}, bottlenecks: [] },
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "input", deterministic: true, limits },
  };
}
