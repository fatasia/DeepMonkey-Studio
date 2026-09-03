import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { PlantLiteBufferStrategyExperiment } from "./PlantLiteBufferStrategyExperiment";

function study(withModel = true): PlantLiteStudyRecord {
  const interval = { mean: 10, sampleStandardDeviation: 0, lower95: 10, upper95: 10, samples: 12 };
  return {
    id: "baseline",
    projectId: "project",
    name: "基线",
    createdAt: "2026-09-03T00:00:00Z",
    templateId: "agv-line-v1",
    ...(withModel ? { model: createAgvLinePlantLiteModel({ bufferCapacity: 10 }) } : {}),
    seed: "fixed",
    replications: 12,
    inputFingerprint: "input",
    outcome: {
      status: "completed",
      completedReplications: 12,
      throughputPerHour: interval,
      averageWip: interval,
      averageLeadTimeMinutes: interval,
      resourceUtilization95: {},
      bottlenecks: [],
    },
    execution: {
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      inputFingerprint: "input",
      deterministic: true,
      limits: { durationMinutes: 480, maxEvents: 100_000, maxResources: 100 },
    },
  };
}

describe("PlantLiteBufferStrategyExperiment", () => {
  it("renders a compact selectable baseline and truthful capacity candidates", () => {
    const html = renderToStaticMarkup(<PlantLiteBufferStrategyExperiment study={study()} busy={false} onRunSweep={() => undefined} />);
    expect(html).toContain("缓冲区策略实验");
    expect(html).toContain("单变量 · 固定随机条件");
    expect(html).toContain("工序间缓冲");
    expect(html).toContain("基线 10 件");
    expect(html).toContain("减至 5");
    expect(html).toContain("减至 8");
    expect(html).toContain("扩至 15");
    expect(html).toContain("扩至 20");
    expect(html).toContain("运行 4 个方案");
    expect(html).not.toContain("自动最优");
  });

  it("disables the action and exposes busy state while the shared run is active", () => {
    const html = renderToStaticMarkup(<PlantLiteBufferStrategyExperiment study={study()} busy onRunSweep={() => undefined} />);
    expect(html).toContain("aria-busy=\"true\"");
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("运行中");
  });

  it("does not occupy result space when an older record has no authored model", () => {
    expect(renderToStaticMarkup(<PlantLiteBufferStrategyExperiment study={study(false)} busy={false} onRunSweep={() => undefined} />)).toBe("");
  });
});
