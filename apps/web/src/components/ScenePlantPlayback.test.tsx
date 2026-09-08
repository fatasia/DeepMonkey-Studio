import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import { ScenePlantPlayback } from "./ScenePlantPlayback";

const model: PlantLiteModel = { id: "empty", name: "空模型", nodes: [], edges: [] };
const trace: PlantLiteReplicationTrace = { engineId: "plant-lite-des", engineVersion: "1.0.0", replication: 0, seed: 1, capturedItemCount: 0, omittedEventCount: 0, truncated: false, limits: { maxEvents: 10, maxItems: 10 }, events: [] };

describe("scene playback layer controls", () => {
  it("keeps one playback clock, starts optional layers off, and explains absent anchors", () => {
    const html = renderToStaticMarkup(<ScenePlantPlayback locale="zh-CN" model={model} trace={trace} />);
    expect(html.match(/aria-label="仿真时间轴"/g)).toHaveLength(1);
    expect(html.split("</div>")[0]?.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(html).toContain("运输轨迹");
    expect(html).toContain("等待热力");
    expect(html).toContain("无场景锚点，仅显示事件时间线");
    expect(html).toContain("不代表全量队列或时间累计占用");
  });
  it("localizes the new layer controls and sampling boundary without claiming the legacy player is localized", () => {
    const html = renderToStaticMarkup(<ScenePlantPlayback locale="en-US" model={model} trace={trace} />).split("</div>")[0]!;
    expect(html).toContain("Transport trails");
    expect(html).toContain("Waiting heat");
    expect(html).toContain("Unit: items");
    expect(html).toContain("not the complete queue or time-integrated occupancy");
    expect(html).toContain("No scene anchors; showing the event timeline only");
    expect(html).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
