import { renderToStaticMarkup } from "react-dom/server";
import type { DataPipelineNode, DataPipelinePreview } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { DataPipelineDebugPanel } from "./DataPipelineDebugPanel";

const selectedNode: DataPipelineNode = {
  id: "filter",
  type: "filter",
  name: "仅保留告警",
  formula: "alarm == TRUE",
  position: { x: 220, y: 0 },
};

const preview = {
  pipeline: { id: "flow", projectId: "project", name: "告警处理", nodes: [selectedNode], edges: [], createdAt: "", updatedAt: "" },
  status: "success",
  fields: [{ key: "alarm", label: "告警", type: "boolean" }],
  rows: [{ alarm: true }],
  durationMs: 3,
  diagnostics: [{
    nodeId: selectedNode.id,
    status: "success",
    inputRows: 5,
    outputRows: 1,
    durationMs: 2,
    inputSample: [{ alarm: false }, { alarm: true }],
    sample: [{ alarm: true }],
  }],
  executedThroughNodeId: selectedNode.id,
} satisfies DataPipelinePreview;

describe("DataPipelineDebugPanel", () => {
  it("makes node input, output and targeted execution explicit", () => {
    const html = renderToStaticMarkup(
      <DataPipelineDebugPanel locale="zh-CN" preview={preview} selectedNode={selectedNode} busy={false} onRunThrough={() => undefined} />,
    );

    expect(html).toContain("节点调试");
    expect(html).toContain("输入");
    expect(html).toContain("输出");
    expect(html).toContain("运行到此");
    expect(html).toContain("运行至此");
    expect(html).toContain("5 → 1 行");
  });
});
