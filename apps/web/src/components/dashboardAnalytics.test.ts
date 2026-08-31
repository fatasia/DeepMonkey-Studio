import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { aggregate, analyzeDashboardMetric, buildDashboardReport, conditionalStyle, dashboardReportCsv, formatDashboardReportValue, sortDashboardReportRows } from "./dashboardAnalytics";

const rows = [
  { region: "华东", month: "1月", sales: 10, cost: 4 },
  { region: "华东", month: "2月", sales: 20, cost: 8 },
  { region: "华南", month: "1月", sales: 5, cost: 2 }
];

function widget(patch: Partial<DashboardDataWidgetConfig>): DashboardDataWidgetConfig {
  return { title: "销售", key: "sales", type: "bar", unit: "", ...patch };
}

describe("dashboard analytics", () => {
  it("calculates fields and aggregates dimensions", () => {
    const result = analyzeDashboardMetric(widget({ analysis: { dimensionField: "region", measureField: "profit", aggregation: "sum", calculatedFields: [{ key: "profit", label: "利润", formula: "sales - cost" }], sort: "value-desc" } }), { value: 20, samples: [], rows });
    expect(result.categories).toEqual(["华东", "华南"]);
    expect(result.series[0]?.values).toEqual([18, 3]);
  });

  it("builds a crosstab and csv grand totals", () => {
    const report = buildDashboardReport(widget({ type: "table", report: { mode: "crosstab", rowField: "region", columnField: "month", valueField: "sales", aggregation: "sum", showGrandTotal: true } }), { value: 20, samples: [], rows });
    expect(report.columns).toEqual(["region", "1月", "2月"]);
    expect(report.rows[0]).toMatchObject({ region: "华东", "1月": 10, "2月": 20 });
    expect(dashboardReportCsv(report)).toContain("总计,15,20");
  });

  it("builds multi-measure grouped and crosstab reports with row totals", () => {
    const grouped = buildDashboardReport(widget({ type: "table", report: { mode: "grouped", rowField: "region", valueFields: ["sales", "cost"], aggregation: "sum", showGrandTotal: true } }), { value: 20, samples: [], rows });
    expect(grouped.columns).toEqual(["region", "sales", "cost"]);
    expect(grouped.rows[0]).toMatchObject({ region: "华东", sales: 30, cost: 12 });
    expect(grouped.grandTotal).toEqual({ sales: 35, cost: 14 });

    const crosstab = buildDashboardReport(widget({ type: "table", report: { mode: "crosstab", rowField: "region", columnField: "month", valueFields: ["sales", "cost"], aggregation: "sum", showSubtotal: true, showGrandTotal: true } }), { value: 20, samples: [], rows });
    expect(crosstab.columns).toEqual(["region", "1月 · sales", "1月 · cost", "2月 · sales", "2月 · cost", "行总计 · sales", "行总计 · cost"]);
    expect(crosstab.rows[0]).toMatchObject({ region: "华东", "1月 · sales": 10, "1月 · cost": 4, "行总计 · sales": 30, "行总计 · cost": 12 });
    expect(dashboardReportCsv(crosstab)).toContain("总计,15,6,20,8,35,14");
  });

  it("evaluates conditional rules and aggregate modes", () => {
    expect(aggregate([1, 2, 2], "distinct-count")).toBe(2);
    expect(conditionalStyle([{ id: "hot", field: "sales", operator: "gte", value: 10, color: "#f00" }], rows[0]!)).toEqual({ color: "#f00" });
  });

  it("sorts report values naturally and formats business numbers", () => {
    expect(sortDashboardReportRows([{ value: 20 }, { value: 3 }], "value", "asc").map((row) => row.value)).toEqual([3, 20]);
    expect(formatDashboardReportValue(1234.5, widget({ type: "table", report: { mode: "detail", valueFormat: "currency", decimalPlaces: 1, currency: "CNY" } }), "zh-CN")).toContain("1,234.5");
    expect(formatDashboardReportValue(0.126, widget({ type: "table", report: { mode: "detail", valueFormat: "percent", decimalPlaces: 1 } }), "zh-CN")).toBe("12.6%");
  });
});
