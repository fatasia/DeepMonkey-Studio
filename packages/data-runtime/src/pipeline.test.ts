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
    expect(result.diagnostics.find((item) => item.nodeId === "filter")?.inputSample).toHaveLength(3);
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

  it("selects fields, removes duplicates and aggregates groups", async () => {
    const definition = pipeline([
      { id: "source", type: "source", name: "源", datasetId: "dataset-1", position: { x: 0, y: 0 } },
      { id: "select", type: "select", name: "保留字段", fields: ["area", "energy"], position: { x: 220, y: 0 } },
      { id: "unique", type: "deduplicate", name: "去重", fields: ["area", "energy"], position: { x: 440, y: 0 } },
      { id: "aggregate", type: "aggregate", name: "区域汇总", groupBy: ["area"], field: "energy", operation: "sum", outputKey: "total", position: { x: 660, y: 0 } },
      { id: "output", type: "output", name: "输出", position: { x: 880, y: 0 } },
    ]);
    const result = await executeDataPipeline(definition, async () => [
      { area: "A", energy: 10, ignored: true },
      { area: "A", energy: 10, ignored: false },
      { area: "A", energy: 15, ignored: true },
      { area: "B", energy: 7, ignored: true },
    ]);

    expect(result.rows).toEqual([
      { area: "A", total: 25 },
      { area: "B", total: 7 },
    ]);
    expect(result.diagnostics.map((item) => item.outputRows)).toEqual([4, 4, 3, 2, 2]);
  });

  it("runs only through the selected node and keeps downstream work untouched", async () => {
    const definition = pipeline([
      { id: "source", type: "source", name: "源", datasetId: "dataset-1", position: { x: 0, y: 0 } },
      { id: "formula", type: "formula", name: "计算", key: "doubled", label: "两倍", fieldType: "number", formula: "value * 2", position: { x: 220, y: 0 } },
      { id: "script", type: "script", name: "不应执行", key: "failed", label: "失败", fieldType: "number", source: "throw new Error('downstream ran');", position: { x: 440, y: 0 } },
      { id: "output", type: "output", name: "输出", position: { x: 660, y: 0 } },
    ]);

    const result = await executeDataPipeline(definition, async () => [{ value: 4 }], { throughNodeId: "formula" });

    expect(result.status).toBe("success");
    expect(result.executedThroughNodeId).toBe("formula");
    expect(result.rows).toEqual([{ value: 4, doubled: 8 }]);
    expect(result.diagnostics.map((item) => item.nodeId)).toEqual(["source", "formula"]);
    expect(result.diagnostics[1]?.inputSample).toEqual([{ value: 4 }]);
  });

  it("publishes the union of sparse output fields", async () => {
    const definition = pipeline([
      { id: "source", type: "source", name: "源", datasetId: "dataset-1", position: { x: 0, y: 0 } },
      { id: "output", type: "output", name: "输出", position: { x: 220, y: 0 } },
    ]);

    const result = await executeDataPipeline(definition, async () => [{ device: "A", alarm: null }, { device: "B", alarm: true, code: 7 }]);

    expect(result.fields).toEqual([
      { key: "device", label: "device", type: "string" },
      { key: "alarm", label: "alarm", type: "boolean" },
      { key: "code", label: "code", type: "number" },
    ]);
  });
});
