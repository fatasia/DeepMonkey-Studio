import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import { PlantLiteMaterialFlowAnalysis } from "./PlantLiteMaterialFlowAnalysis";

const model: PlantLiteModel = {
  id: "line",
  name: "line",
  nodes: [
    { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
    { id: "station", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 2 } },
    { id: "sink", name: "成品", kind: "sink" },
  ],
  edges: [{ id: "in", from: "source", to: "station" }, { id: "out", from: "station", to: "sink" }],
};

function trace(truncated: boolean): PlantLiteReplicationTrace {
  return {
    engineId: "plant-lite-des",
    engineVersion: "1.0.0",
    replication: 0,
    seed: 8,
    capturedItemCount: 1,
    omittedEventCount: truncated ? 4 : 0,
    truncated,
    limits: { maxEvents: 20, maxItems: 1 },
    events: [
      { sequence: 0, atMinute: 0, type: "item-exit", itemId: "item-1", nodeId: "source" },
      { sequence: 1, atMinute: 0, type: "item-enter", itemId: "item-1", nodeId: "station" },
      { sequence: 2, atMinute: 1, type: "item-start", itemId: "item-1", nodeId: "station" },
      { sequence: 3, atMinute: 3, type: "item-complete", itemId: "item-1", nodeId: "station" },
    ],
  };
}

describe("PlantLiteMaterialFlowAnalysis", () => {
  it("renders compact route and duration evidence from saved trace events", () => {
    const html = renderToStaticMarkup(<PlantLiteMaterialFlowAnalysis model={model} trace={trace(false)} />);
    expect(html).toContain("物料流分析");
    expect(html).toContain("1 次已采集转移");
    expect(html).toContain("P50 1.0 · P95 1.0 · n=1");
    expect(html).toContain("P50 2.0 · P95 2.0 · n=1");
    expect(html).toContain("只纳入 enter→start→complete 完整区间");
    expect(html).toContain("已采集流向");
    expect(html).toContain("线宽反映已采集转移次数");
    expect(html).toContain("来料到装配：已采集 1 次转移；单边已配对证据");
    expect(html).toContain("plant-flow-diagram-svg is-wide");
    expect(html).toContain("plant-flow-diagram-svg is-compact");
    expect(html).not.toContain("<details open");
  });

  it("states that a truncated trace is only a captured sample", () => {
    const html = renderToStaticMarkup(<PlantLiteMaterialFlowAnalysis model={model} trace={trace(true)} />);
    expect(html).toContain("轨迹已截断");
    expect(html).toContain("仅代表 1 个已采集物料");
    expect(html).toContain("不代表全量运行");
    expect(html).toContain("另有 4 个事件未记录");
    expect(html).toContain("仅覆盖已采集轨迹，非全量运行");
    expect(html).toContain("轨迹已截断，本图只代表已采集事件");
  });

  it("renders parallel endpoint totals once and exposes their attribution uncertainty in text", () => {
    const parallelModel: PlantLiteModel = {
      ...model,
      edges: [...model.edges, { id: "in-backup", from: "source", to: "station" }],
    };
    const html = renderToStaticMarkup(<PlantLiteMaterialFlowAnalysis model={parallelModel} trace={trace(false)} />);
    expect(html).toContain("并行边合计");
    expect(html).toContain("同端点 2 条并行边合计，无法归属到单边");
    expect(html.match(/plant-flow-diagram-link is-parallel-route-total/g)).toHaveLength(2);
  });
});
