import { expect, it } from "vitest";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { dataPresentation } from "./dashboardDataPresentation";
import { validateFrozenDashboardMetric } from "./dashboardDataValidation";
import type { DashboardFrozenData } from "./dashboardDataRasterTypes";
const widget: DashboardDataWidgetConfig = { type: "value", title: "利用率", key: "metric", unit: "%" };
function data(metric: DashboardFrozenData["metric"]): DashboardFrozenData {
  return { source: { kind: "dataset", id: "data", revision: 3, contentSha256: runtimeContentSha256(metric) }, metric,
    table: { page: 0, scrollLeft: 0 }, layout: { textBoxes: [], backgrounds: [] } };
}
it("uses the existing KPI format without multiplying percentage or inventing absent data", () => {
  expect([...dataPresentation(widget, data({ value: 81.6666, samples: [] }), "zh-CN").values()].map(v => v.text))
    .toEqual(["利用率", "81.7", "%"]);
  expect([...dataPresentation(widget, data({ samples: [] }), "zh-CN").values()].map(v => v.text))
    .toEqual(["利用率", "—", "%"]);
});
it("uses report aggregation, totals, formatting and stable semantic roles", () => {
  const table = { ...widget, type: "table" as const, report: { mode: "grouped" as const, rowField: "region",
    valueField: "amount", aggregation: "sum" as const, showGrandTotal: true, valueFormat: "number" as const, decimalPlaces: 1 } };
  const view = dataPresentation(table, data({ rows: [{ region: "A", amount: 2 }, { region: "A", amount: 3 }], samples: [] }), "en-US");
  expect([...view.values()]).toEqual(expect.arrayContaining([
    { role: { kind: "cell", row: 0, column: "amount" }, text: "5.0" },
    { role: { kind: "total", column: "region" }, text: "Total" },
    { role: { kind: "total", column: "amount" }, text: "5.0" }]));
});
it("hides conditional rows after paging and preserves row numbers", () => {
  const table = { ...widget, type: "table" as const, report: { mode: "detail" as const, pageSize: 2, showRowNumbers: true },
    conditionalRules: [{ id: "hide", field: "amount", operator: "eq" as const, value: 1, visible: false }] };
  const snapshot = data({ rows: [{ amount: 1 }, { amount: 2 }, { amount: 3 }], samples: [] });
  const values = [...dataPresentation(table, snapshot, "zh-CN").values()];
  expect(values).toContainEqual({ role: { kind: "row-number", row: 1 }, text: "2" });
  expect(values.some(v => v.role.kind === "cell" && v.role.row === 0)).toBe(false);
  expect(values).toContainEqual({ role: { kind: "footer" }, text: "1 / 2" });
});
it("rejects hash substitution and non-finite nested data", () => {
  const snapshot = data({ value: 1, samples: [] });
  expect(() => validateFrozenDashboardMetric({ ...snapshot, metric: { value: 2, samples: [] } })).toThrow(/identity/);
  expect(() => validateFrozenDashboardMetric(data({ value: Number.NaN, samples: [] }))).toThrow();
});
