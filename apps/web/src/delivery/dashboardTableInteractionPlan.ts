import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { dashboardReportCsv } from "../components/dashboardAnalytics";
import { dashboardReportXlsx } from "../components/dashboardReportXlsx";
import { dashboardReportView, type DashboardReportViewState } from "../components/dashboardReportView";
import type { DashboardMetric } from "../components/dashboardMetricTypes";

export interface DashboardTableOrderPlan {
  readonly sort: DashboardReportViewState["sort"];
  readonly pages: readonly DashboardReportViewState[];
  readonly exports: { readonly csv: Uint8Array; readonly xlsx: Uint8Array };
  readonly rows: readonly Record<string, unknown>[];
}

/** 冻结既有 Web 语义；Native 不计算排序、分组、公式或 Excel 文档。 */
export async function dashboardTableInteractionPlan(widget: DashboardDataWidgetConfig, metric: DashboardMetric,
  signal?: AbortSignal): Promise<readonly DashboardTableOrderPlan[]> {
  signal?.throwIfAborted();
  const initial = dashboardReportView(widget, metric, { page: 0 });
  const sorts: DashboardReportViewState["sort"][] = [undefined,
    ...initial.report.columns.flatMap(column => [{ column, direction: "asc" as const }, { column, direction: "desc" as const }])];
  const result: DashboardTableOrderPlan[] = [];
  for (const sort of sorts) {
    signal?.throwIfAborted();
    const view = dashboardReportView(widget, metric, { page: 0, sort });
    const csv = new TextEncoder().encode(dashboardReportCsv(view.report));
    const xlsx = await dashboardReportXlsx(view.report, widget.title);
    signal?.throwIfAborted();
    result.push({ sort, rows: view.report.rows, exports: { csv, xlsx },
      pages: Array.from({ length: view.pageCount }, (_, page) => ({ page, sort })) });
  }
  return result;
}
