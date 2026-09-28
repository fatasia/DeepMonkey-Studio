import { describe, expect, it } from "vitest";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { markdownFromPlantLiteStudy, reportFromPlantLiteStudy } from "./plantLiteStudyReport";

function study(): PlantLiteStudyRecord {
  const interval = { mean: 10, sampleStandardDeviation: 1, lower95: 9, upper95: 11, samples: 3 };
  return {
    id: "study-1", projectId: "p", createdAt: "2026-09-28T08:00:00Z", name: "装配线",
    templateId: "agv-line-v1", seed: "fixed", replications: 3, inputFingerprint: "input-hash",
    model: { id: "line-flow-draft", name: "草稿", nodes: [{ id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } }, { id: "sink", name: "成品", kind: "sink" }], edges: [{ id: "e", from: "source", to: "sink" }] },
    outcome: { status: "completed", completedReplications: 3, throughputPerHour: interval, averageWip: interval, averageLeadTimeMinutes: interval, resourceUtilization95: {}, bottlenecks: [] },
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "input-hash", deterministic: true, limits: { durationMinutes: 90, warmupMinutes: 15, maxEvents: 1000, maxResources: 10 } },
  };
}

describe("saved Plant Study report consumer", () => {
  it("generates a deterministic report from saved Study with honest calibration limits", () => {
    const saved = study();
    const first = reportFromPlantLiteStudy(saved);
    expect(first).toEqual(reportFromPlantLiteStudy(saved));
    expect(first.meta).toMatchObject({ inputFingerprint: "input-hash", resultFingerprint: null, replications: 3 });
    expect(first.kpis[0]?.ci95?.samples).toBe(3);
    const markdown = markdownFromPlantLiteStudy(saved);
    expect(markdown).toContain("独立校准集尚缺");
    expect(markdown).toContain("PPR 线性可编辑草稿");
    expect(markdown).toContain("75 分钟正式统计窗口");
    expect(markdown).toContain("结果指纹:");
    expect(saved.outcome).not.toHaveProperty("resultFingerprint");
  });
  it("blocks legacy and incomplete records without fabricating evidence", () => {
    const noModel = study();
    delete noModel.model;
    expect(() => reportFromPlantLiteStudy(noModel)).toThrow(/完整模型/);
    const insufficient = study();
    insufficient.outcome.status = "insufficient-data";
    expect(() => reportFromPlantLiteStudy(insufficient)).toThrow(/已完成/);
  });
});
