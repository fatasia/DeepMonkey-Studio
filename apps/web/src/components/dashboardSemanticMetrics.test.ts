import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetConfig, DataDatasetField, SemanticModelRecord } from "@bim-studio/contracts";
import { analyzeDashboardMetric } from "./dashboardAnalytics";
import { bindSemanticWidget, resolveSemanticWidget, semanticParameterKey, semanticSelectionKey } from "./dashboardSemanticBinding";
import { buildSemanticMetric, previewSemanticParameter } from "./dashboardSemanticMetrics";
import { updateDashboardParameterDraft } from "./dashboardWorkspaceModel";

const model: SemanticModelRecord = {
  id: "production", name: "生产口径", source: { kind: "dataset", id: "rows" }, revision: 1, createdAt: "", updatedAt: "",
  metrics: [
    { id: "sum", key: "qualified", label: "合格产量", fieldKey: "amount", aggregation: "sum", unit: "件", defaultFilters: [{ fieldKey: "valid", op: "eq", value: true }] },
    { id: "formula", key: "doubled", label: "双倍", expression: "amount * 2", aggregation: "avg" },
    { id: "count", key: "count", label: "记录数", aggregation: "count" },
  ],
  dimensions: [{ id: "location", key: "location", label: "地区", fieldKey: "region", hierarchy: [{ fieldKey: "region", label: "区域" }, { fieldKey: "factory", label: "工厂" }] }, { id: "plant", key: "plant", label: "工厂", fieldKey: "factory" }],
  parameters: [{ id: "r", key: "region", label: "区域", type: "option", optionsSource: { kind: "dimension", dimensionKey: "location" } }, { id: "p", key: "factory", label: "工厂", type: "option", parentKey: "region", optionsSource: { kind: "dimension", dimensionKey: "plant" } }],
};
const rows = [{ region: "东", factory: "一厂", amount: 10, valid: true }, { region: "东", factory: "二厂", amount: 30, valid: false }, { region: "西", factory: "一厂", amount: 20, valid: true }];
const fields: DataDatasetField[] = [
  { key: "region", label: "区域", type: "string" }, { key: "factory", label: "工厂", type: "string" }, { key: "amount", label: "产量", type: "number" }, { key: "valid", label: "有效", type: "boolean" },
];
const base: DashboardDataWidgetConfig = { type: "bar", key: "old.value", title: "产量", unit: "", datasetId: "old" };
const chart = bindSemanticWidget(base, "chart", model);
const kpi = bindSemanticWidget({ ...base, type: "value" }, "kpi", model);
const run = (widget = chart, filters = {}, widgets = [chart, kpi], data = rows, definitions = [model]) => buildSemanticMetric(widget, definitions, data, fields, widgets, filters);

describe("semantic dashboard consumer", () => {
  it("binds one immutable version and derives hierarchy, unit and default metric filters", () => {
    expect(chart).toMatchObject({ datasetId: "rows", unit: "件", semanticBinding: { modelId: "production", revision: 1 }, analysis: { aggregation: "sum", drillFields: ["region", "factory"] } });
    const result = run();
    expect(result.rows).toEqual([rows[0], rows[2]]);
    expect(analyzeDashboardMetric(result.semanticWidget!, result).series[0]?.values).toEqual([10, 20]);
    expect(run(kpi).value).toBe(30);
    expect(kpi.analysis?.dimensionField).toBeUndefined();
    expect(base.datasetId).toBe("old");
  });
  it("reuses the safe expression compiler and count without a field", () => {
    expect(run(bindSemanticWidget(kpi, "formula", model, { metricKey: "doubled" })).value).toBe(40);
    expect(run(bindSemanticWidget(kpi, "count", model, { metricKey: "count" })).value).toBe(3);
    expect(run(kpi, {}, [kpi], []).value).toBe(0);
  });
  it("does not silently use a changed version, deleted model or missing metric", () => {
    expect(run(chart, {}, [chart], rows, []).semanticError).toContain("不存在");
    expect(run(chart, {}, [chart], rows, [{ ...model, revision: 2 }]).semanticError).toContain("重新确认");
    expect(run({ ...chart, semanticBinding: { ...chart.semanticBinding!, metricKey: "deleted" } }).semanticError).toContain("已删除");
    expect(bindSemanticWidget(chart, "chart", { ...model, revision: 2 }).semanticBinding?.revision).toBe(2);
  });
  it("reports invalid source fields and formulas rather than displaying a stale numeric result", () => {
    const result = buildSemanticMetric(chart, [model], rows, fields.filter((field) => field.key !== "valid"), [chart], {});
    expect(result).toMatchObject({ value: undefined, semanticError: expect.stringContaining("valid") });
    const broken = { ...model, metrics: [{ ...model.metrics[0]!, fieldKey: "", expression: "unknown + 2" }] };
    expect(run(chart, {}, [chart], rows, [broken]).semanticError).toContain("unknown");
  });
  it("filters other components without self-filtering and retains the full drill path", () => {
    const filters = { [semanticSelectionKey(chart)]: { field: "factory", value: "一厂", path: [{ field: "region", value: "东" }, { field: "factory", value: "一厂" }] } };
    expect(run(kpi, filters).value).toBe(10);
    expect(run(chart, filters).rows).toHaveLength(2);
    expect(run(kpi, {}).value).toBe(30);
  });
  it("combines different component conditions with AND and permits opting out", () => {
    const second = bindSemanticWidget(base, "second", model, { dimensionKey: "plant" });
    const filters = { [semanticSelectionKey(chart)]: { field: "region", value: "东" }, [semanticSelectionKey(second)]: { field: "factory", value: "一厂" } };
    expect(run(kpi, filters, [chart, second, kpi]).value).toBe(10);
    expect(run({ ...kpi, semanticBinding: { ...kpi.semanticBinding!, autoLink: false } }, filters, [chart, second, kpi]).value).toBe(30);
    expect(run(kpi, { ...filters, [semanticSelectionKey(second)]: { field: "factory", value: "二厂" } }, [chart, second, kpi]).value).toBe(0);
  });
  it("does not cross model boundaries or emit table selections", () => {
    const foreign = { ...chart, semanticBinding: { ...chart.semanticBinding!, modelId: "foreign" } };
    const filters = { [semanticSelectionKey(chart)]: { field: "region", value: "东" } };
    expect(run(kpi, filters, [foreign, kpi]).value).toBe(30);
    expect(run(kpi, filters, [{ ...chart, type: "table" }, kpi]).value).toBe(30);
  });
  it("derives parameter options from parent-filtered rows and clears descendants", () => {
    const parent = bindSemanticWidget({ ...base, type: "filter" }, "parent", model, { parameterKey: "region" });
    const child = bindSemanticWidget({ ...base, type: "filter" }, "child", model, { parameterKey: "factory" });
    const all = [parent, child, kpi];
    const filters = { [parent.key]: "西", [child.key]: "一厂" };
    expect(run(child, filters, all).semanticWidget?.options).toEqual(["全部", "一厂"]);
    expect(run(kpi, filters, all).value).toBe(20);
    expect(updateDashboardParameterDraft(filters, all, parent.key, "东")).toEqual({ [parent.key]: "东" });
    expect(child.parentFilterKey).toBe(semanticParameterKey(model.id, "region"));
    expect(run(kpi, { [child.key]: "一厂" }, all).value).toBe(30);
  });
  it("leaves legacy widgets unchanged", () => expect(resolveSemanticWidget(base, [model]).widget).toBe(base));
  it("previews parameter drafts using the original rows without overwriting live filter options", () => {
    const parent = bindSemanticWidget({ ...base, type: "filter" }, "parent", model, { parameterKey: "region" });
    const child = bindSemanticWidget({ ...base, type: "filter" }, "child", model, { parameterKey: "factory" });
    const widgets = [parent, child];
    const live = run(child, { [parent.key]: "西" }, widgets);
    expect(live.semanticWidget?.options).toEqual(["全部", "一厂"]);
    expect(previewSemanticParameter(child, live, [model], widgets, { [parent.key]: "东" })?.semanticWidget?.options).toEqual(["全部", "一厂", "二厂"]);
    expect(live.semanticWidget?.options).toEqual(["全部", "一厂"]);
    expect(previewSemanticParameter(child, undefined, [model], widgets, {})).toBeUndefined();
  });
});
