import { CHART_BUDGETS, validateChartJson } from "@bim-studio/deep-engine";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import type { DashboardFrozenData } from "./dashboardDataRasterTypes";

export function validateFrozenDashboardMetric(data: Pick<DashboardFrozenData, "source" | "metric">): void {
  if (validateChartJson(data.metric).length || !data.source.id || !Number.isSafeInteger(data.source.revision)
    || data.source.revision < 0 || !["dataset", "pipeline", "binding", "sample"].includes(data.source.kind)
    || runtimeContentSha256(data.metric) !== data.source.contentSha256) throw new Error("Frozen metric identity mismatch");
  if (!Array.isArray(data.metric.samples) || data.metric.samples.length > CHART_BUDGETS.rows
    || (data.metric.rows !== undefined && (!Array.isArray(data.metric.rows) || data.metric.rows.length > CHART_BUDGETS.rows))
    || data.metric.samples.some(sample => !Number.isFinite(sample.time) || !Number.isFinite(sample.value))
    || data.metric.rows?.some(row => row === null || typeof row !== "object" || Array.isArray(row)))
    throw new Error("Invalid frozen metric samples or row budget");
}
