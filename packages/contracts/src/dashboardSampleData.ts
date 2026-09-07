/** 作者提供的公开示例，不连接设备或写回数据源；随应用草稿和发布版本保存。 */
export interface DashboardSampleData {
  sourceId?: string;
  rows: Array<Record<string, string | number | boolean | null>>;
}

export const DASHBOARD_SAMPLE_LIMITS = { rows: 100, columns: 16, text: 512, bytes: 131072 } as const;

export function assertDashboardSampleData(value: unknown, path = "sampleData"): asserts value is DashboardSampleData {
  const fail = (reason: string): never => { throw new Error(`${path}: ${reason}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("必须是对象 / Expected an object");
  const rows = (value as DashboardSampleData).rows;
  const sourceId = (value as DashboardSampleData).sourceId;
  if (sourceId !== undefined && (typeof sourceId !== "string" || !sourceId.trim() || sourceId.length > 128)) fail("无效示例来源 / Invalid sample source");
  if (!Array.isArray(rows) || rows.length > DASHBOARD_SAMPLE_LIMITS.rows) fail("最多 100 行 / Up to 100 rows");
  const columns = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) fail("每行必须是对象 / Each row must be an object");
    for (const [key, cell] of Object.entries(row)) {
      if (!key.trim() || key.length > 64 || ["__proto__", "constructor", "prototype"].includes(key)) fail("无效字段名 / Invalid field name");
      columns.add(key);
      if (cell === null || typeof cell === "boolean") continue;
      if (typeof cell === "number" && Number.isFinite(cell)) continue;
      if (typeof cell === "string" && cell.length <= DASHBOARD_SAMPLE_LIMITS.text) continue;
      fail("单元格仅支持文本、有限数字、布尔值或空值 / Cells require text, finite numbers, booleans or null");
    }
  }
  if (columns.size > DASHBOARD_SAMPLE_LIMITS.columns) fail("最多 16 列 / Up to 16 columns");
  if (new TextEncoder().encode(JSON.stringify(value)).length > DASHBOARD_SAMPLE_LIMITS.bytes) fail("示例数据过大 / Sample data is too large");
}
