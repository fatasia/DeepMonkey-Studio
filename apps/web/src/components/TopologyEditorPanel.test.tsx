import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TopologyDocument } from "@bim-studio/contracts";
import { TopologyEditorPanel } from "./TopologyEditorPanel";

const document: TopologyDocument = {
  id: "topology-line-1",
  name: "一号产线",
  nodes: [
    {
      id: "robot-1",
      kind: "controller",
      x: 120,
      y: 160,
      properties: {
        label: "码垛机器人",
        dataBinding: { productType: "pipeline", productId: "pipeline-status", field: "running" }
      }
    }
  ],
  edges: []
};

describe("TopologyEditorPanel", () => {
  it("renders the lightweight workbench and its persisted nodes", () => {
    const html = renderToStaticMarkup(<TopologyEditorPanel locale="zh-CN" document={document} dataProducts={[
      { id: "pipeline-status", type: "pipeline", name: "设备实时状态", fields: ["running", "alarm"] }
    ]} onChange={() => undefined} />);

    expect(html).toContain("一号产线");
    expect(html).toContain("码垛机器人");
    expect(html).toContain("节点库");
    expect(html).toContain("数据驱动");
    expect(html).toContain("1 节点");
  });

  it("renders English product copy from the same component", () => {
    const html = renderToStaticMarkup(<TopologyEditorPanel locale="en-US" document={document} onChange={() => undefined} />);
    expect(html).toContain("Node library");
    expect(html).toContain("Lightweight topology");
  });
});
