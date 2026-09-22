import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { buildDashboardReport, sortDashboardReportRows } from "./dashboardAnalytics";
import type { DashboardMetric } from "./dashboardMetricTypes";

export interface DashboardReportViewState {
  readonly page: number;
  readonly sort?: { readonly column: string; readonly direction: "asc" | "desc" } | undefined;
}

/** Web 呈现和离线编译共用：导出全部已排序行，分页只影响可见行。 */
export function dashboardReportView(widget: DashboardDataWidgetConfig, metric: DashboardMetric | undefined,
  state: DashboardReportViewState) {
  const report = buildDashboardReport(widget, metric);
  const pageSize = Math.max(1, widget.report?.pageSize ?? 8);
  const pageCount = Math.max(1, Math.ceil(report.rows.length / pageSize));
  const page = Math.min(Math.max(0, state.page), pageCount - 1);
  const rows = state.sort ? sortDashboardReportRows(report.rows, state.sort.column, state.sort.direction) : report.rows;
  return { report: { ...report, rows }, page, pageCount, pageSize,
    rowNumberOffset: page * pageSize, visibleRows: rows.slice(page * pageSize, (page + 1) * pageSize) };
}
