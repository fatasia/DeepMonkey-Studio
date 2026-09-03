import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import { PlantLiteFlowDynamics } from "./PlantLiteFlowDynamics";

const model: PlantLiteModel = {
  id: "line",
  name: "物流线",
  nodes: [
    { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 2 } },
    { id: "buffer", name: "线边缓存", kind: "buffer", capacity: 8 },
    { id: "sink", name: "成品", kind: "sink" },
  ],
  edges: [{ id: "e1", from: "source", to: "buffer" }, { id: "e2", from: "buffer", to: "sink" }],
};

function trace(truncated = false): PlantLiteReplicationTrace {
  return {
    engineId: "plant-lite-des",
    engineVersion: "1.0.0",
    replication: 0,
    seed: 9,
    capturedItemCount: 1,
    omittedEventCount: truncated ? 6 : 0,
    truncated,
    limits: { maxEvents: 40, maxItems: 5 },
    events: [
      { sequence: 0, atMinute: 0, type: "item-enter", itemId: "source:1", nodeId: "source" },
      { sequence: 1, atMinute: 1, type: "item-exit", itemId: "source:1", nodeId: "source" },
      { sequence: 2, atMinute: 1, type: "item-enter", itemId: "source:1", nodeId: "buffer" },
      { sequence: 3, atMinute: 3, type: "item-exit", itemId: "source:1", nodeId: "buffer" },
      { sequence: 4, atMinute: 3, type: "item-enter", itemId: "source:1", nodeId: "sink" },
      { sequence: 5, atMinute: 3, type: "item-complete", itemId: "source:1", nodeId: "sink" },
    ],
  };
}

describe("PlantLiteFlowDynamics", () => {
  it("renders a compact accessible chart and labels representative evidence", () => {
    const html = renderToStaticMarkup(<PlantLiteFlowDynamics trace={trace()} model={model} />);
    expect(html).toContain("物流动态曲线");
    expect(html).toContain("代表性重复 #1");
    expect(html).toContain("峰值 WIP 1 · 累计产出 1");
    expect(html).toContain("role=\"img\"");
    expect(html).toContain("轨迹内 WIP");
    expect(html).toContain("线边缓存");
    expect(html).toContain("不替代多次重复的 95% 统计区间");
    expect(html).not.toContain("<details open");
  });

  it("warns that a truncated trace is not acceptance evidence and shows capture limits", () => {
    const html = renderToStaticMarkup(<PlantLiteFlowDynamics trace={trace(true)} model={model} />);
    expect(html).toContain("轨迹已截断");
    expect(html).toContain("最多 5 个物料 / 40 个事件");
    expect(html).toContain("另有 6 个事件未记录");
    expect(html).toContain("不用于方案验收");
  });

  it("renders an actionable empty state for old records without item events", () => {
    const empty = { ...trace(), events: [], capturedItemCount: 0 };
    const html = renderToStaticMarkup(<PlantLiteFlowDynamics trace={empty} model={model} />);
    expect(html).toContain("没有可绘制的物料事件");
    expect(html).toContain("重新运行并采集代表性轨迹");
  });
});
