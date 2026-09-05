import type { DataDatasetRecord } from "@bim-studio/contracts";

/** 目录仅用于定位数据；不携带 SQL、连接配置或采样行，也不替代工具返回的证据。 */
export function industrialAgentDatasetCatalog(projectId: string, datasets: readonly DataDatasetRecord[]) {
  const scoped = datasets.filter((dataset) => dataset.projectId === projectId);
  const entries = [];
  let characters = 0;
  for (const dataset of scoped.slice(0, 50)) {
    const entry = {
      id: dataset.id, name: dataset.name, updatedAt: dataset.updatedAt,
      fields: dataset.fields.slice(0, 64).map(({ key, label, type, unit }) => ({ key, label, type, ...(unit ? { unit } : {}) })),
      fieldsTruncated: dataset.fields.length > 64,
    };
    const size = JSON.stringify(entry).length;
    if (characters + size > 40_000) break;
    entries.push(entry);
    characters += size;
  }
  return { projectId, total: scoped.length, truncated: entries.length < scoped.length, datasets: entries };
}
