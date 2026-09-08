import { Client } from "pg";
import { assertDataWritebackConfig, type DataConnectionRecord, type DataDatasetRecord, type DataPostgresWritebackConfig, type DataWritebackSnapshot, type DataWritebackValue } from "@bim-studio/contracts";
import { connectionPassword } from "./dataIntegrationHelpers.js";
import { DataWritebackError } from "./dataWritebackService.js";

export const quoteSqlName = (name: string): string => `"${name.replaceAll('"', '""')}"`;
export const sqlTable = (target: DataPostgresWritebackConfig): string => `${quoteSqlName(target.schema)}.${quoteSqlName(target.table)}`;
export function postgresTarget(connection: DataConnectionRecord, dataset: DataDatasetRecord, recordId: string): DataPostgresWritebackConfig {
  if (!connection.enabled || connection.type !== "postgresql" || dataset.connectionId !== connection.id || dataset.projectId !== connection.projectId) throw new DataWritebackError(400, "unsupported-target", "填报目标必须是本项目已启用的 PostgreSQL 连接");
  try { assertDataWritebackConfig(dataset.writeback); } catch { throw new DataWritebackError(400, "writeback-not-configured", "数据集尚未配置有效填报目标"); }
  if (dataset.writeback.version !== 2) throw new DataWritebackError(400, "unsupported-target", "填报配置与连接类型不匹配");
  if (!/^[\p{L}\p{N}_-]{1,128}$/u.test(recordId)) throw new DataWritebackError(400, "invalid-record-id", "记录标识无效");
  return dataset.writeback;
}
export function postgresClient(connection: DataConnectionRecord): Client {
  const { host, port, database, user } = connection.config;
  if (typeof host !== "string" || !host.trim() || typeof database !== "string" || !database.trim() || typeof user !== "string" || !user.trim()
    || !Number.isInteger(Number(port ?? 5432)) || Number(port ?? 5432) < 1 || Number(port ?? 5432) > 65535) throw new DataWritebackError(400, "invalid-target", "请完整配置 PostgreSQL 主机、数据库与用户");
  let password: string;
  try { password = connectionPassword(connection, "POSTGRES_PASSWORD"); }
  catch { throw new DataWritebackError(400, "invalid-credential", "PostgreSQL 密码环境变量未配置"); }
  // 不回退到平台元数据库配置，也不接受浏览器临时连接或连接串。
  const client = new Client({ host, port: Number(port ?? 5432), database, user, password,
    ...(connection.config.ssl === true ? { ssl: { rejectUnauthorized: true } } : {}),
    connectionTimeoutMillis: 8000, query_timeout: 10000, statement_timeout: 8000,
    lock_timeout: 3000, idle_in_transaction_session_timeout: 10000, application_name: "bim-studio-writeback" });
  client.on("error", () => { /* 连接终止由当前查询失败与提交结果处理，不让空闲 socket 错误退出 API。 */ });
  return client;
}

/** 不信任配置里的“主键”：核验真实单列 PK、非空整数版本及可写基础字段。 */
export async function assertPostgresTarget(client: Client, target: DataPostgresWritebackConfig): Promise<void> {
  const result = await client.query<{ name: string; type: string; notnull: boolean; generated: string; primarykey: boolean }>(`
    SELECT a.attname AS name, t.typname AS type, a.attnotnull AS notnull, a.attgenerated AS generated,
      EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid AND i.indisprimary
        AND i.indisvalid AND i.indnkeyatts=1 AND a.attnum=i.indkey[0]) AS primarykey
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
    WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`, [target.schema, target.table]);
  const columns = new Map(result.rows.map(column => [column.name, column]));
  const key = columns.get(target.primaryKey), version = columns.get(target.versionColumn);
  if (!key?.primarykey || !["text", "varchar", "bpchar", "uuid", "int2", "int4", "int8"].includes(key.type)) throw new DataWritebackError(400, "primary-key-required", "填报表必须使用真实单列主键");
  if (!version?.notnull || version.generated || !["int2", "int4", "int8"].includes(version.type)) throw new DataWritebackError(400, "version-column-required", "版本列必须是非空、非生成的整数列");
  const allowed = { string: ["text", "varchar", "bpchar"], number: ["int2", "int4", "int8", "numeric", "float4", "float8"], boolean: ["bool"], date: ["date"] };
  for (const field of target.fields) {
    const column = columns.get(field.key);
    if (!column || column.generated || !allowed[field.type].includes(column.type)) throw new DataWritebackError(400, "column-type-mismatch", "填报字段与数据库列类型不匹配，或为只读生成列");
  }
}
export function postgresProjection(target: DataPostgresWritebackConfig): string {
  return [`${quoteSqlName(target.versionColumn)}::text AS "__revision"`, ...target.fields.map(field => `${quoteSqlName(field.key)}${["date", "number"].includes(field.type) ? "::text" : ""} AS ${quoteSqlName(field.key)}`)].join(", ");
}
export function postgresSnapshot(row: Record<string, unknown>, target: DataPostgresWritebackConfig): DataWritebackSnapshot {
  if (typeof row.__revision !== "string" || !/^(0|[1-9]\d{0,18})$/.test(row.__revision)) throw new DataWritebackError(502, "version-unsupported", "记录版本必须为非负整数");
  const values: Record<string, DataWritebackValue> = {};
  for (const field of target.fields) {
    const raw = row[field.key];
    const value = raw === null ? null : field.type === "number" ? Number(raw) : raw;
    if (value !== null && (typeof value !== (field.type === "date" ? "string" : field.type)
      || (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))
        || decimalIdentity(String(raw)) !== decimalIdentity(String(value)))))) throw new DataWritebackError(502, "invalid-record", "记录字段无法无损转换为填报类型");
    values[field.key] = value as DataWritebackValue;
  }
  return { values, version: `"sql:${row.__revision}"` };
}
/** 比较十进制有效位，避免 numeric 被 Number 静默截短；允许等价尾零与指数形式。 */
function decimalIdentity(value: string): string | undefined {
  const parts = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!parts) return undefined;
  let digits = `${parts[2]}${parts[3] ?? ""}`.replace(/^0+/, "");
  if (!digits) return "0";
  let exponent = Number(parts[4] ?? 0) - (parts[3]?.length ?? 0);
  const tail = /0+$/.exec(digits)?.[0].length ?? 0;
  exponent += tail; if (tail) digits = digits.slice(0, -tail);
  return `${parts[1] === "-" ? "-" : ""}${digits}e${exponent}`;
}
