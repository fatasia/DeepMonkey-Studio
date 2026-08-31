import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LogisticsExperimentResult } from "@bim-studio/contracts";
import { LogisticsStudyPanel } from "./LogisticsStudyPanel";

function result(overrides: Partial<LogisticsExperimentResult> = {}): LogisticsExperimentResult {
  return {
    id: "run-1",
    projectId: "project-1",
    name: "物流基线",
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

describe("LogisticsStudyPanel", () => {
  it("keeps the first-run state focused", () => {
    const html = renderToStaticMarkup(
      <LogisticsStudyPanel results={[]} busy={false} onLoadInputs={() => undefined} onReproduce={() => undefined} />,
    );
    expect(html).toContain("运行第一个工况");
    expect(html).not.toContain("对比基线");
  });

  it("renders comparison, lineage and repeat actions", () => {
    const baseline = result();
    const html = renderToStaticMarkup(
      <LogisticsStudyPanel
        results={[result({ id: "run-2", reproductionOf: baseline.id }), baseline]}
        busy={false}
        onLoadInputs={() => undefined}
        onReproduce={() => undefined}
      />,
    );
    expect(html).toContain("复现校验通过");
    expect(html).toContain("精确复现基线");
    expect(html).toContain("物流仿真对比");
  });

  it("labels legacy history without inventing engine evidence", () => {
    const legacy = result({ id: "legacy" });
    delete legacy.execution;
    const html = renderToStaticMarkup(
      <LogisticsStudyPanel
        results={[result({ id: "run-2" }), legacy]}
        busy={false}
        onLoadInputs={() => undefined}
        onReproduce={() => undefined}
      />,
    );
    expect(html).toContain("历史记录缺少执行引擎证据");
    expect(html).not.toContain("复现校验通过");
  });
});
