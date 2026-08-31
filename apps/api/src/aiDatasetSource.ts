import type { DataSourceEvidence } from "@bim-studio/contracts";
import type { DataQuerySource } from "@bim-studio/data-query-plugin";
import type { MetadataStore } from "./metadataStore.js";

export interface AiDatasetSnapshot {
  records: Array<Record<string, string | number>>;
  numericRows: Array<Record<string, number>>;
  evidence: DataSourceEvidence;
}

/**
 * 将数据中心的统一数据集转换为算法输入。连接凭据仍封装在数据层，AI 插件只接收
 * 有界快照和来源证据，避免每个模型重复实现数据库、消息队列与现场协议驱动。
 */
export async function readAiDataset(
  source: DataQuerySource,
  store: MetadataStore,
  projectId: string,
  datasetId: string,
  signal: AbortSignal,
): Promise<AiDatasetSnapshot> {
  const dataset = source.getDataset(projectId, datasetId);
  if (!dataset) throw new Error("AI 数据集不存在或已删除");
  const connection = store.listDataConnections(projectId).find((item) => item.id === dataset.connectionId);
  if (!connection) throw new Error("AI 数据集连接不存在或已删除");
  if (!connection.enabled) throw new Error(`数据连接“${connection.name}”已停用`);

  const preview = await source.readDataset(projectId, datasetId, signal);
  if (preview.rows.length === 0) throw new Error(`数据集“${dataset.name}”没有可用于模型运行的记录`);
  const records = preview.rows.map(normalizeModelRecord).filter((row) => Object.keys(row).length > 0);
  if (records.length === 0) throw new Error(`数据集“${dataset.name}”不包含可用于模型运行的标量字段`);

  return {
    records,
    numericRows: records.map(toNumericRow),
    evidence: {
      datasetId: dataset.id,
      datasetName: dataset.name,
      connectionId: connection.id,
      connectionType: connection.type,
      rowCount: records.length,
      fieldKeys: preview.fields.map((field) => field.key),
      sampledAt: new Date().toISOString(),
      durationMs: Math.round(preview.durationMs),
    },
  };
}

function normalizeModelRecord(row: Record<string, unknown>): Record<string, string | number> {
  const normalized: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "number" && Number.isFinite(value)) normalized[key] = value;
    else if (typeof value === "string") normalized[key] = value;
    else if (typeof value === "boolean") normalized[key] = value ? 1 : 0;
    else if (value instanceof Date) normalized[key] = value.toISOString();
  }
  return normalized;
}

function toNumericRow(row: Record<string, string | number>): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric)) normalized[key] = numeric;
  }
  return normalized;
}
