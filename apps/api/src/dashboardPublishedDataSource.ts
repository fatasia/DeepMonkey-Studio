import { createHash } from "node:crypto";
import type { DashboardDataWidgetNode, DataDatasetField, JsonValue } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import type { AppConfig } from "./config.js";
import { previewDataset } from "./dataIntegration.js";
import { previewPipeline } from "./dataPipelineService.js";
import type { MetadataStore } from "./metadataStore.js";

export type DashboardDataStore = Pick<MetadataStore, "listDatasets" | "listDataConnections" | "listDataPipelines">;
export function dashboardSavedDataSource(store: DashboardDataStore, projectId: string, node: DashboardDataWidgetNode) {
  const widget = node.widget;
  if (widget.semanticBinding || widget.directBinding || widget.sampleData || (!widget.datasetId && !widget.pipelineId)) return;
  if (widget.datasetId && widget.pipelineId) throw new Error("Dashboard data source is ambiguous");
  const datasets = store.listDatasets(projectId), connections = store.listDataConnections(projectId);
  const pipeline = widget.pipelineId ? store.listDataPipelines(projectId).find(item => item.id === widget.pipelineId) : undefined;
  if (widget.pipelineId && (!pipeline || pipeline.projectId !== projectId)) throw new Error("Dashboard pipeline is outside the published project");
  const ids = pipeline ? [...new Set(pipeline.nodes.filter(node => node.type === "source").map(node => node.datasetId))] : [widget.datasetId!];
  const sources = ids.map(id => {
    const dataset = datasets.find(item => item.id === id);
    const connection = dataset && connections.find(item => item.id === dataset.connectionId);
    if (!dataset || !connection || !connection.enabled || dataset.projectId !== projectId || connection.projectId !== projectId)
      throw new Error("Dashboard dataset/connection is outside the published project");
    return { dataset: structuredClone(dataset), connection: structuredClone(connection) };
  });
  const id = pipeline?.id ?? widget.datasetId!;
  const updatedAt = pipeline?.updatedAt ?? sources[0]!.dataset.updatedAt;
  const revision = Date.parse(updatedAt);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Dashboard source revision is invalid");
  // Only a digest crosses the freeze boundary; connection credentials stay in the query service.
  const metadataSha256 = createHash("sha256").update(JSON.stringify({ pipeline, sources })).digest("hex");
  return { id, revision, kind: pipeline ? "pipeline" as const : "dataset" as const, metadataSha256, pipeline, sources };
}

export async function readDashboardSavedData(config: AppConfig, store: DashboardDataStore, projectId: string,
  node: DashboardDataWidgetNode, sourceRevision: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const token: { metadataSha256: string; capturedAt: number } = JSON.parse(sourceRevision);
  if (!Number.isSafeInteger(token.capturedAt) || token.capturedAt < 0) throw new Error("Dashboard data capture time is invalid");
  const source = dashboardSavedDataSource(store, projectId, node);
  if (!source || source.metadataSha256 !== token.metadataSha256) throw new Error("Dashboard data source changed since freeze");
  let rows: Array<Record<string, unknown>>, fields: DataDatasetField[];
  if (source.pipeline) {
    const result = await previewPipeline(config, store as MetadataStore, source.pipeline);
    if (result.status === "error") throw new Error(result.error ?? "Dashboard pipeline failed");
    rows = result.rows; fields = result.fields;
  } else {
    const item = source.sources[0]!;
    const result = await previewDataset(config, item.connection, item.dataset);
    rows = result.rows; fields = result.fields;
  }
  signal?.throwIfAborted();
  if (dashboardSavedDataSource(store, projectId, node)?.metadataSha256 !== source.metadataSha256)
    throw new Error("Dashboard data metadata changed during read");
  const field = fields.find(field => `${source.id}.${field.key}` === node.widget.key);
  if (!field) throw new Error("Published widget metric key does not select a saved source field");
  const metric = metricFromRows(rows, field.key, token.capturedAt);
  return { sourceRevision, value: { source: { kind: source.kind, id: source.id, revision: source.revision,
    contentSha256: runtimeContentSha256(metric) }, metric } };
}

/** Matches Web mergeProductMetrics; freeze the fallback clock so repeated reads compare actual data. */
function metricFromRows(rows: Array<Record<string, unknown>>, field: string, capturedAt: number) {
  const samples = [...rows].reverse().flatMap((row, index) => {
    const raw = row[field];
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value)) return [];
    const rawTime = row.recorded_at ?? row.time ?? row.timestamp;
    const time = typeof rawTime === "string" || typeof rawTime === "number" ? Date.parse(String(rawTime)) : Number.NaN;
    return [{ time: Number.isFinite(time) ? time : capturedAt - (rows.length - index) * 1_000, value }];
  }).slice(-60);
  const value = rows[0]?.[field];
  const metric = { ...(value === undefined ? {} : { value: value as JsonValue }), rows, samples };
  // Reject nonfinite/non-JSON values rather than silently dropping them during serialization.
  runtimeContentSha256(metric);
  return metric;
}
