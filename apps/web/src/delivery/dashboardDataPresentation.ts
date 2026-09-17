import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { analyzeDashboardMetric, buildDashboardReport, conditionalStyle, formatDashboardReportValue,
  sortDashboardReportRows } from "../components/dashboardAnalytics";
import { formatDashboardMetricDisplay } from "../components/dashboardMetricDisplay";
import { validateFrozenDashboardMetric } from "./dashboardDataValidation";
import type { DashboardDataTextRole, DashboardFrozenData } from "./dashboardDataRasterTypes";

export function dataRoleKey(role: DashboardDataTextRole): string { return runtimeContentSha256(role); }
export function dataPresentation(widget: DashboardDataWidgetConfig, data: DashboardFrozenData, locale: string) {
  validateFrozenDashboardMetric(data);
  const metric = { value: structuredClone(data.metric.value),
    samples: [...data.metric.samples], ...(data.metric.rows ? { rows: data.metric.rows.map(row => ({ ...row })) } : {}) };
  const texts = new Map<string, { role: DashboardDataTextRole; text: string }>();
  const put = (role: DashboardDataTextRole, text: string) => { if (text.length) texts.set(dataRoleKey(role), { role, text }); };
  if (widget.type === "value") {
    const analysis = analyzeDashboardMetric(widget, metric);
    const condition = conditionalStyle(widget.conditionalRules, analysis.rows[0] ?? {}, analysis.value);
    if (condition.visible !== false) {
      put({ kind: "title" }, widget.title); put({ kind: "value" }, formatDashboardMetricDisplay(analysis.value, widget, locale));
      put({ kind: "unit" }, widget.unit);
    }
    return texts;
  }
  if (["bar", "line", "scatter", "pie"].includes(widget.type)) {
    if (widget.fontSize) {
      put({ kind: "title" }, widget.title); put({ kind: "unit" }, widget.unit);
    }
    return texts;
  }
  if (!data.table) throw new Error("Frozen table page/sort/scroll state is required");
  const report = buildDashboardReport(widget, metric), state = data.table;
  if (!Number.isSafeInteger(state.page) || state.page < 0 || !Number.isFinite(state.scrollLeft) || state.scrollLeft < 0
    || state.sort && (!["asc", "desc"].includes(state.sort.direction) || !report.columns.includes(state.sort.column)))
    throw new Error("Invalid frozen table state");
  const pageSize = Math.max(1, widget.report?.pageSize ?? 8);
  const pageCount = Math.max(1, Math.ceil(report.rows.length / pageSize)), page = Math.min(state.page, pageCount - 1);
  const sorted = state.sort ? sortDashboardReportRows(report.rows, state.sort.column, state.sort.direction) : report.rows;
  put({ kind: "title" }, widget.title);
  if (widget.report?.showRowNumbers) put({ kind: "row-number-header" }, "#");
  for (const column of report.columns) {
    put({ kind: "header", column }, column);
    put({ kind: "sort", column }, state.sort?.column === column ? state.sort.direction === "asc" ? "↑" : "↓" : "↕");
  }
  sorted.slice(page * pageSize, (page + 1) * pageSize).forEach((row, index) => {
    if (conditionalStyle(widget.conditionalRules, row).visible === false) return;
    const rowIndex = page * pageSize + index;
    if (widget.report?.showRowNumbers) put({ kind: "row-number", row: rowIndex }, String(rowIndex + 1));
    for (const column of report.columns) put({ kind: "cell", row: rowIndex, column }, formatDashboardReportValue(row[column], widget, locale));
  });
  if (report.grandTotal) report.columns.forEach((column, index) => put({ kind: "total", column },
    index === 0 ? locale === "en-US" ? "Total" : "总计" : formatDashboardReportValue(report.grandTotal?.[column], widget, locale)));
  if (pageCount > 1) {
    put({ kind: "footer" }, `${page + 1} / ${pageCount}`); put({ kind: "previous" }, "‹"); put({ kind: "next" }, "›");
  }
  return texts;
}
