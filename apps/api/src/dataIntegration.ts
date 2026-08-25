import type { DataConnectionRecord, DataDatasetField, DataDatasetPreview, DataDatasetRecord } from "@bim-studio/contracts";
import mysql from "mysql2/promise";
import oracledb from "oracledb";
import type { AppConfig } from "./config.js";
import { runProcess } from "./store.js";

export async function ensureDemoMetrics(config: AppConfig): Promise<void> {
  const statement = `
    CREATE TABLE IF NOT EXISTS bim_studio_demo_metrics (
      recorded_at TIMESTAMPTZ NOT NULL,
      device_id TEXT NOT NULL,
      temperature DOUBLE PRECISION NOT NULL,
      pressure DOUBLE PRECISION NOT NULL,
      running BOOLEAN NOT NULL
    );
    INSERT INTO bim_studio_demo_metrics (recorded_at, device_id, temperature, pressure, running)
    SELECT NOW() - (index || ' minutes')::interval,
           'AHU-' || LPAD(((index % 3) + 1)::text, 2, '0'),
           ROUND((22 + SIN(index / 4.0) * 5 + (index % 3))::numeric, 1),
           ROUND((101 + COS(index / 5.0) * 8)::numeric, 1),
           index % 7 <> 0
    FROM generate_series(0, 59) AS index
    WHERE NOT EXISTS (SELECT 1 FROM bim_studio_demo_metrics);
  `;
  await runPostgres(config.metadata.postgres, statement);
}

export async function previewDataset(config: AppConfig, connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<DataDatasetPreview> {
  const startedAt = performance.now();
  let rows: Array<Record<string, unknown>>;
  if (connection.type === "postgresql") rows = await previewPostgres(config, connection, dataset);
  else if (connection.type === "mysql") rows = await previewMysql(connection, dataset);
  else if (connection.type === "oracle") rows = await previewOracle(connection, dataset);
  else if (connection.type === "tdengine") rows = await previewTdengine(connection, dataset);
  else if (connection.type === "http") rows = await previewHttp(config, connection, dataset);
  else throw new Error(`当前预览器暂不支持 ${connection.type}；实时协议请通过 Node-RED 桥接后预览`);
  const fields = dataset.fields.length > 0 ? dataset.fields : inferFields(rows);
  return { dataset: { ...dataset, fields }, fields, rows: rows.slice(0, 100), durationMs: performance.now() - startedAt };
}

export async function demoSensorRows(config: AppConfig): Promise<Array<Record<string, unknown>>> {
  const output = await runPostgres(config.metadata.postgres, `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text FROM (SELECT recorded_at, device_id, temperature, pressure, running FROM bim_studio_demo_metrics ORDER BY recorded_at DESC LIMIT 30) t;`, true);
  return parseRows(output);
}

async function previewPostgres(config: AppConfig, connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const query = readonlyQuery(dataset);
  const wrapped = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text FROM (${query.replace(/;+\s*$/, "")}) t;`;
  const passwordEnv = String(connection.config.passwordEnv || "POSTGRES_PASSWORD");
  const postgres = {
    host: String(connection.config.host || config.metadata.postgres.host),
    port: Number(connection.config.port || config.metadata.postgres.port),
    database: String(connection.config.database || config.metadata.postgres.database),
    user: String(connection.config.user || config.metadata.postgres.user),
    password: process.env[passwordEnv] ?? config.metadata.postgres.password,
    psqlPath: config.metadata.postgres.psqlPath
  };
  return parseRows(await runPostgres(postgres, wrapped, true));
}

async function previewMysql(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const client = await mysql.createConnection({
    host: String(connection.config.host || "127.0.0.1"),
    port: Number(connection.config.port || 3306),
    database: String(connection.config.database || ""),
    user: String(connection.config.user || "root"),
    password: connectionPassword(connection, "MYSQL_PASSWORD"),
    connectTimeout: 8_000,
    dateStrings: true
  });
  try {
    const [rows] = await client.query(readonlyQuery(dataset));
    return Array.isArray(rows) ? rows.slice(0, 100).map((row) => ({ ...(row as Record<string, unknown>) })) : [];
  } finally {
    await client.end();
  }
}

async function previewOracle(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const host = String(connection.config.host || "127.0.0.1");
  const port = Number(connection.config.port || 1521);
  const serviceName = String(connection.config.serviceName || connection.config.database || "ORCL");
  const client = await oracledb.getConnection({ user: String(connection.config.user || ""), password: connectionPassword(connection, "ORACLE_PASSWORD"), connectString: `${host}:${port}/${serviceName}` });
  try {
    const result = await client.execute<Record<string, unknown>>(readonlyQuery(dataset), [], { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 100, fetchArraySize: 100 });
    return (result.rows ?? []).map((row) => normalizeRow(row));
  } finally {
    await client.close();
  }
}

async function previewTdengine(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const host = String(connection.config.host || "127.0.0.1");
  const port = Number(connection.config.port || 6041);
  const database = String(connection.config.database || "").trim();
  const protocol = connection.config.secure === true ? "https" : "http";
  const endpoint = `${protocol}://${host}:${port}/rest/sql${database ? `/${encodeURIComponent(database)}` : ""}`;
  const user = String(connection.config.user || "root");
  const password = connectionPassword(connection, "TDENGINE_PASSWORD");
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "text/plain; charset=utf-8", authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` }, body: readonlyQuery(dataset), signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`TDengine HTTP ${response.status} ${response.statusText}`);
  const result = await response.json() as { code?: number; desc?: string; column_meta?: Array<[string, string, number]>; data?: unknown[][] };
  if (result.code && result.code !== 0) throw new Error(result.desc || `TDengine 查询失败：${result.code}`);
  const columns = result.column_meta?.map((column) => column[0]) ?? [];
  return (result.data ?? []).slice(0, 100).map((values) => Object.fromEntries(columns.map((column, index) => [column, values[index]])));
}

async function previewHttp(config: AppConfig, connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const configuredUrl = String(connection.config.url || "").trim();
  if (!configuredUrl) throw new Error("HTTP 连接缺少 URL");
  const url = configuredUrl.startsWith("/") ? `http://127.0.0.1:${config.port}${configuredUrl}` : configuredUrl;
  const response = await fetch(url, { method: String(connection.config.method || "GET"), signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  let value: unknown = await response.json();
  for (const segment of dataset.sourceKey?.split(".").filter(Boolean) ?? []) value = value && typeof value === "object" ? (value as Record<string, unknown>)[segment] : undefined;
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  if (value && typeof value === "object") return [value as Record<string, unknown>];
  return [{ value }];
}

function runPostgres(postgres: AppConfig["metadata"]["postgres"], statement: string, tuplesOnly = false): Promise<string> {
  return runProcess(postgres.psqlPath, ["-X", "-v", "ON_ERROR_STOP=1", "-h", postgres.host, "-p", String(postgres.port), "-U", postgres.user, "-d", postgres.database, ...(tuplesOnly ? ["-t", "-A"] : [])], { PGPASSWORD: postgres.password }, statement);
}

function parseRows(output: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(output.trim() || "[]");
  return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function readonlyQuery(dataset: DataDatasetRecord): string {
  const query = dataset.query?.trim();
  if (!query || !/^(select|with|show|describe|desc)\b/i.test(query) || /\b(insert|update|delete|drop|alter|truncate|grant|revoke|copy|create|replace|merge|call|execute)\b/i.test(query)) throw new Error("数据集预览只允许只读 SELECT / WITH / SHOW 查询");
  return query.replace(/;+\s*$/, "");
}

function connectionPassword(connection: DataConnectionRecord, fallbackEnvironment: string): string {
  const environmentName = String(connection.config.passwordEnv || fallbackEnvironment);
  const password = process.env[environmentName];
  if (password === undefined) throw new Error(`未配置密码环境变量 ${environmentName}`);
  return password;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
}

function inferFields(rows: Array<Record<string, unknown>>): DataDatasetField[] {
  const sample = rows[0] ?? {};
  return Object.entries(sample).map(([key, value]) => ({ key, label: key, type: inferFieldType(value) }));
}

function inferFieldType(value: unknown): DataDatasetField["type"] {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return "datetime";
  if (typeof value === "object" && value !== null) return "json";
  return "string";
}
