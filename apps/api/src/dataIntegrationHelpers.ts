/** 数据接入共享工具：统一协议 URL、查询安全、重试策略与字段推断。 */
import type { DataConnectionRecord, DataDatasetField, DataDatasetRecord } from "@bim-studio/contracts";
import { compileFormula, evaluateFormula } from "@bim-studio/data-runtime";
import { executeRowScript } from "@bim-studio/data-runtime/script";
import type { AppConfig } from "./config.js";
import { runProcess } from "./store.js";

export function connectorUrl(connection: DataConnectionRecord, protocols: string[]): URL {
  const value = String(connection.config.url || "").trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${connection.type} 连接缺少有效 URL`);
  }
  if (!protocols.includes(url.protocol) || url.username || url.password) throw new Error(`${connection.type} URL 协议无效或包含明文凭据`);
  if ((url.protocol === "tcp:" || url.protocol === "udp:") && (!url.port || Number(url.port) < 1 || Number(url.port) > 65_535))
    throw new Error(`${connection.type} URL 必须指定有效端口`);
  return url;
}

export function kafkaBrokers(connection: DataConnectionRecord): string[] {
  const value = String(connection.config.url || "")
    .trim()
    .replace(/^kafka:\/\//i, "");
  const brokers = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9._~-]+:\d{1,5}$/.test(item));
  if (brokers.length === 0) throw new Error("Kafka Broker 地址无效，格式示例：kafka://broker-1:9092,broker-2:9092");
  return brokers;
}

export function requiredSource(dataset: DataDatasetRecord, label: string): string {
  const value = dataset.sourceKey?.trim();
  if (!value) throw new Error(`${label} 不能为空`);
  return value;
}

export function sampleTimeout(connection: DataConnectionRecord): number {
  return Math.min(15_000, Math.max(500, Number(connection.config.sampleTimeoutMs || 3_000)));
}
export async function waitForRows(rows: unknown[], timeoutMs: number, error: string): Promise<void> {
  await new Promise<void>((resolve, reject) => setTimeout(() => (rows.length ? resolve() : reject(new Error(error))), timeoutMs));
}
export function isRetryablePreviewError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:timeout|timed out|econnreset|econnrefused|ehostunreach|enetunreach|socket|broker|连接.*(?:断开|失败|超时)|HTTP 5\d\d)/i.test(message);
}

export function messageRow(text: string, metadata: Record<string, unknown>): Record<string, unknown> {
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* Text payloads are valid protocol values. */
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), ...Object.fromEntries(Object.entries(metadata).map(([key, item]) => [`$${key}`, item])) }
    : { value, ...Object.fromEntries(Object.entries(metadata).map(([key, item]) => [`$${key}`, item])) };
}

export function selectMessageRows(rows: Array<Record<string, unknown>>, sourceKey?: string): Array<Record<string, unknown>> {
  return sourceKey ? rows.map((row) => selectHttpRows(row, sourceKey)[0] ?? {}).filter((row) => Object.keys(row).length > 0) : rows;
}
export function normalizeProtocolValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeProtocolValue);
  return value;
}
export function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} 必须是 ${minimum}–${maximum} 的整数`);
  return parsed;
}

export function selectHttpRows(payload: unknown, sourceKey?: string): Array<Record<string, unknown>> {
  let value = payload;
  for (const segment of sourceKey?.split(".").filter(Boolean) ?? []) value = value && typeof value === "object" ? (value as Record<string, unknown>)[segment] : undefined;
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  if (value && typeof value === "object") return [value as Record<string, unknown>];
  return [{ value }];
}

export function runPostgres(postgres: AppConfig["metadata"]["postgres"], statement: string, tuplesOnly = false): Promise<string> {
  return runProcess(
    postgres.psqlPath,
    ["-X", "-v", "ON_ERROR_STOP=1", "-h", postgres.host, "-p", String(postgres.port), "-U", postgres.user, "-d", postgres.database, ...(tuplesOnly ? ["-t", "-A"] : [])],
    { PGPASSWORD: postgres.password },
    statement,
  );
}

export function parseRows(output: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(output.trim() || "[]");
  return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

export function readonlyQuery(dataset: DataDatasetRecord): string {
  const query = dataset.query?.trim();
  if (
    !query ||
    !/^(select|with|show|describe|desc)\b/i.test(query) ||
    /\b(insert|update|delete|drop|alter|truncate|grant|revoke|copy|create|replace|merge|call|execute)\b/i.test(query)
  )
    throw new Error("数据集预览只允许只读 SELECT / WITH / SHOW 查询");
  return query.replace(/;+\s*$/, "");
}

export function connectionPassword(connection: DataConnectionRecord, fallbackEnvironment: string): string {
  const environmentName = String(connection.config.passwordEnv || fallbackEnvironment);
  const password = process.env[environmentName];
  if (password === undefined) throw new Error(`未配置密码环境变量 ${environmentName}`);
  return password;
}

export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
}

export function inferFields(rows: Array<Record<string, unknown>>): DataDatasetField[] {
  const sample = rows[0] ?? {};
  return Object.entries(sample).map(([key, value]) => ({ key, label: key, type: inferFieldType(value) }));
}

export function parseJsonObjectQuery(query: string | undefined, label: string): Record<string, unknown> {
  const value = query?.trim() || "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label}必须是合法 JSON 对象`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象`);
  return parsed as Record<string, unknown>;
}

export function readonlyFluxQuery(query: string | undefined): string {
  const value = query?.trim();
  if (!value) throw new Error("InfluxDB 数据集缺少 Flux 查询");
  if (/\b(to|delete|create|drop|http)\s*\(/i.test(value)) throw new Error("InfluxDB 数据集预览只允许只读 Flux 查询");
  return value;
}

export function readonlyPromQlQuery(query: string | undefined): string {
  const value = query?.trim();
  if (!value) throw new Error("Prometheus 数据集缺少 PromQL 查询");
  return value;
}

export function parseScalar(value: string): string | number | boolean | null {
  if (value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  return value;
}

export async function applyComputedFields(rows: Array<Record<string, unknown>>, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  let nextRows = rows.map((row) => ({ ...row }));
  for (const field of dataset.computedFields ?? []) {
    if (field.mode === "script") {
      const result = await executeRowScript(field.formula, nextRows, {}, { timeoutMs: 150, memoryLimitBytes: 8 * 1024 * 1024 });
      nextRows = nextRows.map((row, index) => ({ ...row, [field.key]: result.output[index] ?? null }));
    } else {
      const compiled = compileFormula(field.formula);
      nextRows = nextRows.map((row) => ({ ...row, [field.key]: evaluateFormula(compiled, row) }));
    }
  }
  return nextRows;
}

export function inferFieldType(value: unknown): DataDatasetField["type"] {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value) && !Number.isNaN(Date.parse(value)))
    return "datetime";
  if (typeof value === "object" && value !== null) return "json";
  return "string";
}
