import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import { PlantLiteResourceTimeline } from "./PlantLiteResourceTimeline";

describe("PlantLiteResourceTimeline", () => {
  it("renders a collapsed, honest representative Gantt summary", () => {
    const model: PlantLiteModel = {
      id: "line",
      name: "产线",
      nodes: [
        { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
        { id: "station", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 2 } },
        { id: "sink", name: "完工", kind: "sink" },
      ],
      edges: [{ id: "e1", from: "source", to: "station" }, { id: "e2", from: "station", to: "sink" }],
    };
    const trace: PlantLiteReplicationTrace = {
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      replication: 0,
      seed: 7,
      capturedItemCount: 1,
      omittedEventCount: 0,
      truncated: false,
      limits: { maxEvents: 20, maxItems: 5 },
      events: [
        { sequence: 0, atMinute: 1, type: "item-start", itemId: "source:1", nodeId: "station" },
        { sequence: 1, atMinute: 3, type: "item-complete", itemId: "source:1", nodeId: "station" },
      ],
    };
    const html = renderToStaticMarkup(<PlantLiteResourceTimeline trace={trace} model={model} />);
    expect(html).toContain("资源甘特");
    expect(html).toContain("代表性重复");
    expect(html).toContain("不替代 95% 统计区间");
    expect(html).not.toContain("<details open");
  });
});
