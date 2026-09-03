import type { DashboardDataWidgetConfig, DataDatasetRecord, DataPipelineDefinition } from "@bim-studio/contracts";

export const DEFAULT_DATA_REFRESH_SECONDS = 5;
export const MIN_DATA_REFRESH_SECONDS = 2;

export interface DataProductRefreshPlan {
  readonly key: string;
  readonly kind: "dataset" | "pipeline";
  readonly id: string;
  /** 0 表示只做首次加载与用户主动刷新。 */
  readonly refreshSeconds: number;
}

export function normalizeDataRefreshSeconds(value: unknown, fallback = DEFAULT_DATA_REFRESH_SECONDS): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  return Math.max(MIN_DATA_REFRESH_SECONDS, value);
}

/** 管道跟随最快的定时源；所有源均为手动时，管道也保持手动。 */
export function derivePipelineRefreshSeconds(
  pipeline: DataPipelineDefinition | undefined,
  datasets: readonly DataDatasetRecord[],
  fallback = DEFAULT_DATA_REFRESH_SECONDS,
): number {
  if (!pipeline) return fallback;
  const sourceIds = [...new Set(pipeline.nodes.flatMap((node) => (node.type === "source" ? [node.datasetId] : [])))];
  if (sourceIds.length === 0) return fallback;
  const sourcePeriods = sourceIds.map((id) => normalizeDataRefreshSeconds(datasets.find((dataset) => dataset.id === id)?.refreshSeconds, fallback));
  const scheduledPeriods = sourcePeriods.filter((seconds) => seconds > 0);
  return scheduledPeriods.length > 0 ? Math.min(...scheduledPeriods) : 0;
}

export function resolveDataProductRefreshSeconds(
  kind: DataProductRefreshPlan["kind"],
  id: string,
  datasets: readonly DataDatasetRecord[],
  pipelines: readonly DataPipelineDefinition[],
): number {
  if (kind === "dataset") return normalizeDataRefreshSeconds(datasets.find((dataset) => dataset.id === id)?.refreshSeconds);
  return derivePipelineRefreshSeconds(pipelines.find((pipeline) => pipeline.id === id), datasets);
}

export function buildDashboardDataProductRefreshPlans(
  widgets: readonly DashboardDataWidgetConfig[],
  datasets: readonly DataDatasetRecord[],
  pipelines: readonly DataPipelineDefinition[],
): DataProductRefreshPlan[] {
  const products = new Map<string, Pick<DataProductRefreshPlan, "kind" | "id">>();
  for (const widget of widgets) {
    if (widget.datasetId) products.set(`dataset:${widget.datasetId}`, { kind: "dataset", id: widget.datasetId });
    if (widget.pipelineId) products.set(`pipeline:${widget.pipelineId}`, { kind: "pipeline", id: widget.pipelineId });
  }
  return [...products.entries()].map(([key, product]) => ({
    key,
    ...product,
    refreshSeconds: resolveDataProductRefreshSeconds(product.kind, product.id, datasets, pipelines),
  }));
}
