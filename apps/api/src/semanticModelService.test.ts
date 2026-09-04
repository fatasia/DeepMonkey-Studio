import { describe, expect, it } from "vitest";
import type { DataDatasetField, SemanticModelRecord } from "@bim-studio/contracts";
import { resolveSemanticSourceFields, validateSemanticModel, type SemanticModelValidationContext } from "./semanticModelService.js";

const fields: DataDatasetField[] = [
  { key: "recorded_at", label: "时间", type: "datetime" },
  { key: "device_id", label: "设备", type: "string" },
  { key: "temperature", label: "温度", type: "number", unit: "°C" },
  { key: "pressure", label: "压力", type: "number" },
  { key: "running", label: "运行", type: "boolean" },
];

function createContext(options: { datasetComputed?: Array<{ key: string; label: string; type: string; formula: string }> } = {}): SemanticModelValidationContext {
  return {
    listDatasets: () => [
      { id: "ds-1", fields, computedFields: options.datasetComputed },
      { id: "ds-empty", fields: [] },
    ],
    listDataPipelines: () => [{ id: "pipe-1" }],
  };
}

function createModel(overrides: Partial<SemanticModelRecord> = {}): SemanticModelRecord {
  return {
    id: "model-1",
    name: "设备运行口径",
    source: { kind: "dataset", id: "ds-1" },
    metrics: [
      { id: "m-1", key: "avgTemperature", label: "平均温度", fieldKey: "temperature", aggregation: "avg", unit: "°C" },
      { id: "m-2", key: "runningCount", label: "运行数量", aggregation: "count" },
    ],
    dimensions: [
      { id: "d-1", key: "device", label: "设备", fieldKey: "device_id" },
      { id: "d-2", key: "time", label: "时间层级", fieldKey: "recorded_at", hierarchy: [{ fieldKey: "recorded_at", label: "时刻" }] },
    ],
    parameters: [
      { id: "p-1", key: "deviceFilter", label: "设备筛选", type: "option", optionsSource: { kind: "dimension", dimensionKey: "device" } },
    ],
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("resolveSemanticSourceFields", () => {
  it("merges dataset fields with computed fields", () => {
    const ctx = createContext({ datasetComputed: [{ key: "delta", label: "温差", type: "number", formula: "temperature - pressure" }] });
    const result = resolveSemanticSourceFields(createModel(), ctx, "default");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.fields.map((field) => field.key)).toContain("delta");
  });

  it("requires explicit fields for pipeline sources", () => {
    const result = resolveSemanticSourceFields(createModel({ source: { kind: "pipeline", id: "pipe-1" } }), createContext(), "default");
    expect(result.status).toBe("error");
  });

  it("accepts pipeline sources with explicit fields", () => {
    const result = resolveSemanticSourceFields(
      createModel({ source: { kind: "pipeline", id: "pipe-1", fields: [{ key: "value", label: "值", type: "number" }] } }),
      createContext(),
      "default",
    );
    expect(result.status).toBe("ok");
  });

  it("rejects missing dataset or pipeline sources", () => {
    expect(resolveSemanticSourceFields(createModel({ source: { kind: "dataset", id: "missing" } }), createContext(), "default").status).toBe("error");
    expect(resolveSemanticSourceFields(createModel({ source: { kind: "pipeline", id: "missing" } }), createContext(), "default").status).toBe("error");
  });
});

describe("validateSemanticModel", () => {
  it("accepts a valid model", () => {
    expect(validateSemanticModel(createModel(), createContext(), "default")).toEqual([]);
  });

  it("requires a name", () => {
    expect(validateSemanticModel(createModel({ name: " " }), createContext(), "default")).toContain("语义模型名称不能为空");
  });

  it("rejects duplicate and malformed keys", () => {
    const errors = validateSemanticModel(
      createModel({
        metrics: [
          { id: "m-1", key: "bad-key", label: "x", fieldKey: "temperature", aggregation: "sum" },
          { id: "m-2", key: "bad-key", label: "y", fieldKey: "temperature", aggregation: "sum" },
        ],
      }),
      createContext(),
      "default",
    );
    expect(errors.join("\n")).toContain("必须以字母开头");
    expect(errors.join("\n")).toContain("重复");
  });

  it("rejects metrics with both field and expression or neither", () => {
    const both = validateSemanticModel(
      createModel({ metrics: [{ id: "m-1", key: "m", label: "m", fieldKey: "temperature", expression: "pressure + 1", aggregation: "sum" }] }),
      createContext(),
      "default",
    );
    expect(both.join("\n")).toContain("不能同时指定字段和表达式");
    const neither = validateSemanticModel(
      createModel({ metrics: [{ id: "m-1", key: "m", label: "m", aggregation: "sum" }] }),
      createContext(),
      "default",
    );
    expect(neither.join("\n")).toContain("需要指定字段或表达式");
    const countWithoutField = validateSemanticModel(
      createModel({ metrics: [{ id: "m-1", key: "m", label: "m", aggregation: "count" }] }),
      createContext(),
      "default",
    );
    expect(countWithoutField).toEqual([]);
  });

  it("compiles metric expressions and validates dependencies", () => {
    const invalid = validateSemanticModel(
      createModel({ metrics: [{ id: "m-1", key: "m", label: "m", expression: "temperature +", aggregation: "sum" }] }),
      createContext(),
      "default",
    );
    expect(invalid.join("\n")).toContain("表达式无效");
    const unknownDependency = validateSemanticModel(
      createModel({ metrics: [{ id: "m-1", key: "m", label: "m", expression: "nonexistent + 1", aggregation: "sum" }] }),
      createContext(),
      "default",
    );
    expect(unknownDependency.join("\n")).toContain("不在源字段中");
  });

  it("rejects dimensions and filters referencing unknown fields", () => {
    const errors = validateSemanticModel(
      createModel({
        dimensions: [{ id: "d-1", key: "d", label: "d", fieldKey: "nope" }],
        metrics: [
          {
            id: "m-1",
            key: "m",
            label: "m",
            fieldKey: "temperature",
            aggregation: "sum",
            defaultFilters: [{ fieldKey: "also-nope", op: "eq", value: 1 }],
          },
        ],
      }),
      createContext(),
      "default",
    );
    expect(errors.join("\n")).toContain("不在源字段中");
  });

  it("detects parameter parent cycles and missing references", () => {
    const cycle = validateSemanticModel(
      createModel({
        parameters: [
          { id: "p-1", key: "a", label: "a", type: "option", parentKey: "b" },
          { id: "p-2", key: "b", label: "b", type: "option", parentKey: "a" },
        ],
      }),
      createContext(),
      "default",
    );
    expect(cycle.join("\n")).toContain("循环");
    const missingParent = validateSemanticModel(
      createModel({ parameters: [{ id: "p-1", key: "a", label: "a", type: "text", parentKey: "ghost" }] }),
      createContext(),
      "default",
    );
    expect(missingParent.join("\n")).toContain("不存在");
  });

  it("rejects option parameters referencing unknown dimensions or with empty static options", () => {
    const unknownDimension = validateSemanticModel(
      createModel({
        parameters: [{ id: "p-1", key: "a", label: "a", type: "option", optionsSource: { kind: "dimension", dimensionKey: "ghost" } }],
      }),
      createContext(),
      "default",
    );
    expect(unknownDimension.join("\n")).toContain("选项维度 ghost 不存在");
    const emptyStatic = validateSemanticModel(
      createModel({ parameters: [{ id: "p-1", key: "a", label: "a", type: "option", optionsSource: { kind: "static", options: [] } }] }),
      createContext(),
      "default",
    );
    expect(emptyStatic.join("\n")).toContain("没有静态选项");
  });
});
