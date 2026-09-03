import type { PlantLiteConfidenceInterval, PlantLiteStudyRecord } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlantLiteQualityEvidence } from "./PlantLiteQualityEvidence";

describe("PlantLiteQualityEvidence", () => {
  it("shows system and station quality evidence with an explicit no-rework boundary", () => {
    const html = renderToStaticMarkup(<PlantLiteQualityEvidence result={study()} />);
    expect(html).toContain("质量与报废");
    expect(html).toContain("合格产出");
    expect(html).toContain("报废");
    expect(html).toContain("系统一次通过率");
    expect(html).toContain("配置 97.0%");
    expect(html).toContain("当前不含返工循环");
    expect(html).toContain("未处置在制品不入分母");
  });

  it("keeps a configured legacy record honest when quality metrics are absent", () => {
    const legacy = study();
    delete legacy.outcome.quality;
    const html = renderToStaticMarkup(<PlantLiteQualityEvidence result={legacy} />);
    expect(html).toContain("质量证据缺失");
    expect(html).toContain("重新运行");
  });

  it("does not add noise to a model that never configured quality", () => {
    const legacy = study();
    delete legacy.outcome.quality;
    const station = legacy.model?.nodes.find((node) => node.kind === "station");
    if (station?.kind === "station") delete station.yieldRate;
    expect(renderToStaticMarkup(<PlantLiteQualityEvidence result={legacy} />)).toBe("");
  });
});

function study(): PlantLiteStudyRecord {
  const ci = (mean: number): PlantLiteConfidenceInterval => ({ mean, sampleStandardDeviation: 0.01, lower95: Math.max(0, mean - 0.02), upper95: mean + 0.02, samples: 12 });
  return {
    id: "quality", projectId: "project", name: "质量方案", createdAt: "2026-09-03T00:00:00Z",
    templateId: "agv-line-v1", seed: "quality", replications: 12, inputFingerprint: "input",
    model: {
      id: "line", name: "line",
      nodes: [
        { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
        { id: "inspection", name: "终检", kind: "station", processingTime: { kind: "deterministic", value: 1 }, yieldRate: 0.97 },
        { id: "sink", name: "成品", kind: "sink" },
      ],
      edges: [{ id: "a", from: "source", to: "inspection" }, { id: "b", from: "inspection", to: "sink" }],
    },
    outcome: {
      status: "completed", completedReplications: 12, throughputPerHour: ci(58), averageWip: ci(2), averageLeadTimeMinutes: ci(2), resourceUtilization95: {}, bottlenecks: [],
      quality: { goodOutputItems: ci(464), scrapItems: ci(16), firstPassYield: ci(0.967), stationMetrics95: { inspection: { inspectedItems: ci(480), goodItems: ci(464), scrapItems: ci(16), firstPassYield: ci(0.967) } } },
    },
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "input", deterministic: true, limits: { durationMinutes: 480, maxEvents: 10_000, maxResources: 10 } },
  };
}
