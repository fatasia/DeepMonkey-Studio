import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetConfig, DataDatasetField } from "@bim-studio/contracts";
import { replaceDashboardWidgetDataProduct } from "./dashboardDataProductReplacement";

const fields: DataDatasetField[] = [
  { key: "region", label: "Region", type: "string" },
  { key: "category", label: "Category", type: "string" },
  { key: "amount", label: "Amount", type: "number", unit: "万元" },
];

describe("dashboard data product replacement", () => {
  it("preserves matching semantic fields and replaces the source atomically", () => {
    const widget = {
      title: "分析",
      key: "old.amount",
      type: "bar",
      unit: "",
      datasetId: "old",
      analysis: { dimensionField: "region", seriesField: "category", measureField: "amount", aggregation: "sum" },
    } satisfies DashboardDataWidgetConfig;
    expect(replaceDashboardWidgetDataProduct(widget, "pipeline:clean", fields)).toMatchObject({
      pipelineId: "clean",
      key: "clean.amount",
      field: "amount",
      unit: "万元",
      analysis: { dimensionField: "region", seriesField: "category", measureField: "amount" },
    });
  });

  it("remaps template roles when the target schema uses different names", () => {
    const widget = {
      title: "交叉表",
      key: "mock.value",
      type: "table",
      unit: "",
      datasetId: "mock",
      analysis: { dimensionField: "mock_dim", measureField: "value", aggregation: "sum" },
      report: { mode: "crosstab", rowField: "mock_dim", columnField: "mock_series", valueField: "value", valueFields: ["value"] },
    } satisfies DashboardDataWidgetConfig;
    const next = replaceDashboardWidgetDataProduct(widget, "dataset:actual", fields);
    expect(next).toMatchObject({
      datasetId: "actual",
      field: "amount",
      key: "actual.amount",
      analysis: { dimensionField: "region", measureField: "amount" },
      report: { rowField: "region", columnField: "category", valueField: "amount", valueFields: ["amount"] },
    });
  });
});
