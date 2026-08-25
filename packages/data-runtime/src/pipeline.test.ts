import type { DataPipelineDefinition } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { DataPipelineError, executeDataPipeline, validateDataPipeline } from "./pipeline.js";

function pipeline(nodes: DataPipelineDefinition["nodes"]): DataPipelineDefinition {
  return {
    id: "pipeline-1",
    projectId: "project-1",
    name: "温度告警",
    nodes,
    edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, sourceNodeId: nodes[index]!.id, targetNodeId: node.id })),
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z"
  };
}

describe("data pipeline runtime", () => {
  it("executes filter, formula, script, sort and limit nodes with diagnostics", async () => {
    const definition = pipeline([
      { id: "source", type: "source", name: "设备数据", datasetId: "dataset-1", position: { x: 0, y: 0 } },
      { id: "filter", type: "filter", name: "只看运行设备", formula: "running == TRUE", position: { x: 220, y: 0 } },
      { id: "formula", type: "formula", name: "华氏温度", key: "fahrenheit", label: "华氏温度", fieldType: "number", formula: "ROUND(temperature * 1.8 + 32, 1)", position: { x: 440, y: 0 } },
      { id: "script", type: "script", name: "设备摘要", key: "summary", label: "摘要", fieldType: "string", source: "return `${input.device}: ${input.fahrenheit}°F`;", position: { x: 660, y: 0 } },
      { id: "sort", type: "sort", name: "温度降序", field: "fahrenheit", direction: "desc", position: { x: 880, y: 0 } },
      { id: "limit", type: "limit", name: "前一条", count: 1, position: { x: 1100, y: 0 } },
      { id: "output", type: "output", name: "告警结果", position: { x: 1320, y: 0 } }
    ]);
    const result = await executeDataPipeline(definition, async () => [
      { device: "AHU-01", temperature: 22, running: false },
      { device: "AHU-02", temperature: 26, running: true },
      { device: "AHU-03", temperature: 28, running: true }
    ]);

    expect(result.rows).toEqual([{ device: "AHU-03", temperature: 28, running: true, fahrenheit: 82.4, summary: "AHU-03: 82.4°F" }]);
    expect(result.diagnostics).toHaveLength(7);
    expect(result.diagnostics.every((item) => item.status === "success")).toBe(true);
  });

  it("rejects implicit cycles", () => {
    const definition = pipeline([
      { id: "source", type: "source", name: "源", datasetId: "dataset-1", position: { x: 0, y: 0 } },
      { id: "filter", type: "filter", name: "过滤", formula: "TRUE", position: { x: 220, y: 0 } },
      { id: "output", type: "output", name: "输出", position: { x: 440, y: 0 } }
    ]);
    definition.edges.push({ id: "cycle", sourceNodeId: "filter", targetNodeId: "source" });
    expect(() => validateDataPipeline(definition)).toThrow(DataPipelineError);
  });

  it("reports the failed node and completed diagnostics", async () => {
    const definition = pipeline([
      { id: "source", type: "source", name: "源", datasetId: "dataset-1", position: { x: 0, y: 0 } },
      { id: "script", type: "script", name: "坏脚本", key: "value", label: "值", fieldType: "number", source: "throw new Error('bad row');", position: { x: 220, y: 0 } },
      { id: "output", type: "output", name: "输出", position: { x: 440, y: 0 } }
    ]);
    await expect(executeDataPipeline(definition, async () => [{ value: 1 }])).rejects.toMatchObject({ nodeId: "script", diagnostics: [{ status: "success" }, { status: "error" }] });
  });
});
