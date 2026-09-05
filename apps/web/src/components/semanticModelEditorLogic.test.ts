import { describe, expect, it } from "vitest";
import { moveSemanticItem, newSemanticModel, semanticFormulaEvidence, semanticSaveErrors, semanticSourceFields, semanticUniqueKey, setSemanticMetricMode } from "./semanticModelEditorLogic";
import type { DataDatasetRecord, SemanticMetricDefinition } from "@bim-studio/contracts";

describe("semantic model editor logic", () => {
  it("creates a manual unsaved model without guessing the source", () => {
    const draft = newSemanticModel("pipeline");
    expect(draft).toMatchObject({ revision: 0, source: { kind: "pipeline", id: "", fields: [] }, metrics: [], dimensions: [], parameters: [] });
    expect(newSemanticModel("dataset").id).not.toBe(draft.id);
  });
  it("uses unique keys even after deleting or copying a definition", () => {
    expect(semanticUniqueKey("metric", [{ key: "metric_1" }, { key: "metric_3" }])).toBe("metric_2");
  });
  it("removes the opposite metric source without mutating the original", () => {
    const metric: SemanticMetricDefinition = { id: "m", key: "m", label: "M", aggregation: "sum", fieldKey: "amount" };
    const expression = setSemanticMetricMode(metric, "expression");
    expect(expression.expression).toBe(""); expect(expression.fieldKey).toBeUndefined();
    const field = setSemanticMetricMode({ ...expression, expression: "amount * 2" }, "field");
    expect(field.expression).toBeUndefined(); expect(field.fieldKey).toBe("");
    expect(metric.fieldKey).toBe("amount");
  });
  it("uses the existing formula compiler and reports missing dependencies", () => {
    const fields = [{ key: "amount", label: "产量", type: "number" as const }];
    expect(semanticFormulaEvidence("amount * 2", fields)).toEqual({ dependencies: ["amount"], error: "" });
    expect(semanticFormulaEvidence("ghost * 2", fields).error).toContain("ghost");
    expect(semanticFormulaEvidence("amount + (", fields).error).not.toBe("");
  });
  it("includes computed dataset fields and preserves explicit pipeline fields", () => {
    const dataset = { id: "d", fields: [{ key: "value", label: "数值", type: "number" }], computedFields: [{ id: "c", key: "double", label: "双倍", type: "number", formula: "value * 2" }] } as DataDatasetRecord;
    const model = newSemanticModel("dataset"); model.source.id = "d";
    expect(semanticSourceFields(model, [dataset]).map(field => field.key)).toEqual(["value", "double"]);
    model.source = { kind: "pipeline", id: "p", fields: [{ key: "out", label: "输出", type: "number" }] };
    expect(semanticSourceFields(model, [dataset])).toEqual(model.source.fields);
  });
  it("splits server errors and moves hierarchy rows without losing definitions", () => {
    expect(semanticSaveErrors(new Error("字段失效；参数环；名称重复"))).toEqual(["字段失效", "参数环", "名称重复"]);
    const levels = [{ fieldKey: "region" }, { fieldKey: "line" }];
    expect(moveSemanticItem(levels, 1, -1)).toEqual([levels[1], levels[0]]);
    expect(moveSemanticItem(levels, 0, -1)).toEqual(levels);
    expect(levels[0]?.fieldKey).toBe("region");
  });
});
