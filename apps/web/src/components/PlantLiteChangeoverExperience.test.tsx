import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlantLiteModel, PlantLiteStudyRecord } from "@bim-studio/contracts";
import { PlantLiteChangeoverEditor } from "./PlantLiteChangeoverEditor";
import { PlantLiteChangeoverEvidence } from "./PlantLiteChangeoverEvidence";
import { PlantLiteProductMixEditor } from "./PlantLiteProductMixEditor";

const model: PlantLiteModel = {
  id: "mix",
  name: "混流线",
  productTypes: [
    { id: "a", name: "阀体", share: 0.6 },
    { id: "b", name: "泵体", share: 0.4 },
  ],
  nodes: [
    { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
    { id: "station", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 1 }, changeovers: [{ fromProductTypeId: "a", toProductTypeId: "b", minutes: 3 }] },
    { id: "sink", name: "成品", kind: "sink" },
  ],
  edges: [{ id: "a", from: "source", to: "station" }, { id: "b", from: "station", to: "sink" }],
};

describe("Plant Lite mixed-flow authoring and evidence", () => {
  it("does not prefill engineering product data and exposes an explicit apply action", () => {
    const { productTypes: _productTypes, ...legacyModel } = model;
    const html = renderToStaticMarkup(<PlantLiteProductMixEditor model={legacyModel} onChange={() => undefined} />);
    expect(html).toContain("系统不会代填产品或比例");
    expect(html).toContain("添加产品类型");
    expect(html).toContain("应用产品组合");
  });

  it("shows a directional matrix and states the zero-minute fallback", () => {
    const station = model.nodes.find((node) => node.kind === "station");
    if (!station || station.kind !== "station") throw new Error("station missing");
    const html = renderToStaticMarkup(<PlantLiteChangeoverEditor model={model} station={station} onChange={() => undefined} />);
    expect(html).toContain("阀体");
    expect(html).toContain("泵体");
    expect(html).toContain("方向可不同");
    expect(html).toContain("留空或 0 明确表示该方向不换型");
    expect(html).toContain("value=\"3\"");
  });

  it("renders per-product throughput, changeover CI and trace evidence", () => {
    const html = renderToStaticMarkup(<PlantLiteChangeoverEvidence result={record()} />);
    expect(html).toContain("计划投放");
    expect(html).toContain("完成占比");
    expect(html).toContain("完成吞吐");
    expect(html).toContain("60.0%");
    expect(html).toContain("12.00 件/时");
    expect(html).toContain("5.0 次");
    expect(html).toContain("15.0 分钟");
    expect(html).toContain("未配置的方向明确按 0 分钟处理");
    expect(html).toContain("阀体 → 泵体");
  });

  it("labels completion-share evidence that covers only part of the completed replications", () => {
    const partial = record();
    partial.outcome.productTypeMetrics95!.a!.completionShare.samples = 1;
    const html = renderToStaticMarkup(<PlantLiteChangeoverEvidence result={partial} />);
    expect(html).toContain("1/3 次有完成件");
  });
});

function record(): PlantLiteStudyRecord {
  const ci = (mean: number) => ({ mean, sampleStandardDeviation: 0, lower95: mean, upper95: mean, samples: 3 });
  return {
    id: "study",
    projectId: "project",
    createdAt: "2026-09-03T00:00:00.000Z",
    name: "混流研究",
    templateId: "agv-line-v1",
    model,
    modelFingerprint: "model",
    seed: "fixed",
    replications: 3,
    inputFingerprint: "input",
    trace: {
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      replication: 0,
      seed: 1,
      capturedItemCount: 1,
      omittedEventCount: 0,
      truncated: false,
      limits: { maxEvents: 20, maxItems: 10 },
      events: [{ sequence: 0, atMinute: 2, type: "item-changeover-start", itemId: "source:1", nodeId: "station", productTypeId: "b", changeover: { fromProductTypeId: "a", toProductTypeId: "b", startMinute: 2, durationMinutes: 3 } }],
    },
    outcome: {
      status: "completed",
      completedReplications: 3,
      throughputPerHour: ci(20),
      averageWip: ci(2),
      averageLeadTimeMinutes: ci(4),
      nodeMetrics95: { station: { utilization: ci(0.8), averageQueueLength: ci(1), blockedMinutes: ci(0), starvedMinutes: ci(1), changeoverCount: ci(5), changeoverMinutes: ci(15) } },
      resourceUtilization95: {},
      productTypeMetrics95: {
        a: { completedItems: ci(24), completionShare: ci(0.6), throughputPerHour: ci(12) },
        b: { completedItems: ci(16), completionShare: ci(0.4), throughputPerHour: ci(8) },
      },
      bottlenecks: [],
    },
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "input", deterministic: true, limits: { durationMinutes: 120, maxEvents: 1_000, maxResources: 10 } },
  };
}
