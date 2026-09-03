import type { DataDatasetRecord, DataPipelineDefinition } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { createTransformNode, derivePipelineFieldHints, validatePipelineDraft } from "./DataPipelineStudioParts";
import { insertPipelineNodeAfter } from "./DataPipelineEditing";

const dataset = { id: "dataset-1", name: "设备数据", fields: [] } as unknown as DataDatasetRecord;

function pipeline(nodes: DataPipelineDefinition["nodes"]): DataPipelineDefinition {
  return {
    id: "pipeline-1",
    projectId: "project-1",
    name: "设备告警",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    nodes,
    edges: [],
  };
}

describe("validatePipelineDraft", () => {
  it("accepts a complete linear pipeline", () => {
    const result = validatePipelineDraft(
      pipeline([
        { id: "source", type: "source", name: "设备数据", datasetId: dataset.id, position: { x: 0, y: 0 } },
        { id: "filter", type: "filter", name: "运行设备", formula: "running == TRUE", position: { x: 1, y: 0 } },
        { id: "output", type: "output", name: "数据产品", position: { x: 2, y: 0 } },
      ]),
      [dataset],
    );

    expect(result).toBeUndefined();
  });

  it("identifies the transform that is missing its required configuration", () => {
    const result = validatePipelineDraft(
      pipeline([
        { id: "source", type: "source", name: "设备数据", datasetId: dataset.id, position: { x: 0, y: 0 } },
        { id: "sort", type: "sort", name: "按时间排序", field: "", direction: "asc", position: { x: 1, y: 0 } },
        { id: "output", type: "output", name: "数据产品", position: { x: 2, y: 0 } },
      ]),
      [dataset],
    );

    expect(result).toBe("节点“按时间排序”需要排序字段");
  });
});

describe("insertPipelineNodeAfter", () => {
  it("inserts at the selected connection instead of always appending before output", () => {
    const source = { id: "source", type: "source", name: "设备数据", datasetId: dataset.id, position: { x: 0, y: 0 } } as const;
    const filter = { id: "filter", type: "filter", name: "运行设备", formula: "running == TRUE", position: { x: 1, y: 0 } } as const;
    const output = { id: "output", type: "output", name: "数据产品", position: { x: 2, y: 0 } } as const;
    const sort = { id: "sort", type: "sort", name: "按温度排序", field: "temperature", direction: "desc", position: { x: 0, y: 0 } } as const;

    const result = insertPipelineNodeAfter(pipeline([source, filter, output]), sort, source.id);

    expect(result.nodes.map((node) => node.id)).toEqual(["source", "sort", "filter", "output"]);
    expect(result.edges.map((edge) => [edge.sourceNodeId, edge.targetNodeId])).toEqual([
      ["source", "sort"],
      ["sort", "filter"],
      ["filter", "output"],
    ]);
  });
});

describe("derivePipelineFieldHints", () => {
  it("tracks fields produced and reduced by previous nodes", () => {
    const nodes: DataPipelineDefinition["nodes"] = [
      { id: "source", type: "source", name: "源", datasetId: dataset.id, position: { x: 0, y: 0 } },
      { id: "formula", type: "formula", name: "计算", key: "energy", label: "能耗", fieldType: "number", formula: "value", position: { x: 1, y: 0 } },
      { id: "select", type: "select", name: "选择", fields: ["area", "energy"], position: { x: 2, y: 0 } },
      { id: "aggregate", type: "aggregate", name: "汇总", groupBy: ["area"], field: "energy", operation: "sum", outputKey: "total", position: { x: 3, y: 0 } },
      { id: "output", type: "output", name: "输出", position: { x: 4, y: 0 } },
    ];

    const fields = derivePipelineFieldHints(nodes, "output", [
      { key: "area", label: "区域", type: "string" },
      { key: "value", label: "值", type: "number" },
    ]);

    expect(fields.map((field) => field.key)).toEqual(["area", "total"]);
  });
});

describe("createTransformNode", () => {
  const fields = [
    { key: "recorded_at", label: "采集时间", type: "datetime" as const },
    { key: "device_id", label: "设备", type: "string" as const },
    { key: "temperature", label: "温度", type: "number" as const },
    { key: "computed_value", label: "已有计算值", type: "number" as const },
  ];

  it("uses real upstream fields instead of placeholder fields that fail on first run", () => {
    const formula = createTransformNode("formula", "zh-CN", fields);
    const script = createTransformNode("script", "zh-CN", fields);
    const sort = createTransformNode("sort", "zh-CN", fields);
    const select = createTransformNode("select", "zh-CN", fields);

    expect(formula).toMatchObject({
      type: "formula",
      key: "computed_value_2",
      formula: "ROUND(temperature, 2)",
    });
    expect(script).toMatchObject({
      type: "script",
      fieldType: "datetime",
      source: 'return input["recorded_at"];',
    });
    expect(sort).toMatchObject({ type: "sort", field: "recorded_at" });
    expect(select).toMatchObject({
      type: "select",
      fields: ["recorded_at", "device_id", "temperature", "computed_value"],
    });
  });

  it("keeps new nodes valid when no upstream schema has been discovered", () => {
    expect(createTransformNode("formula", "zh-CN")).toMatchObject({ formula: "0" });
    expect(createTransformNode("script", "zh-CN")).toMatchObject({ source: "return null;" });
    expect(createTransformNode("sort", "zh-CN")).toMatchObject({ field: "" });
  });
});
