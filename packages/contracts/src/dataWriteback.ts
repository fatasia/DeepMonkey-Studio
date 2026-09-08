/** 受控 REST 填报：记录端点必须支持强 ETag 与 If-Match 条件更新。 */
export type DataWritebackValue = string | number | boolean | null;
export interface DataWritebackField {
  key: string;
  type: "string" | "number" | "boolean" | "date";
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: DataWritebackValue[];
}
export interface DataRestWritebackConfig {
  version: 1;
  /** 同连接 origin 下的绝对路径；必须且只能包含一个 {id}。 */
  recordPath: string;
  fields: DataWritebackField[];
}
export interface DataPostgresWritebackConfig {
  version: 2;
  kind: "postgresql";
  schema: string;
  table: string;
  primaryKey: string;
  /** 必须是数据库非空整数列；所有业务写入方均须递增此列。 */
  versionColumn: string;
  fields: DataWritebackField[];
  recordPath?: never;
}
export type DataWritebackConfig = DataRestWritebackConfig | DataPostgresWritebackConfig;
export interface DataWritebackSnapshot {
  values: Record<string, DataWritebackValue>;
  version: string;
}
export interface DataWritebackRequest {
  expectedVersion: string;
  values: Record<string, DataWritebackValue>;
}
export interface DataWritebackIssue { field: string; message: string }

const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function assertDataWritebackConfig(value: unknown): asserts value is DataWritebackConfig {
  if (!object(value)) throw new Error("填报配置格式无效");
  if (value.version === 2) {
    if (value.kind !== "postgresql" || Object.keys(value).some(key => !["version", "kind", "schema", "table", "primaryKey", "versionColumn", "fields"].includes(key))) throw new Error("SQL 填报配置格式无效");
    for (const key of ["schema", "table", "primaryKey", "versionColumn"]) if (!sqlIdentifier(value[key])) throw new Error("SQL 表与列名无效");
    if (value.primaryKey === value.versionColumn) throw new Error("版本列不能与主键相同");
    if (/^(pg_|information_schema$)/i.test(String(value.schema))) throw new Error("不能填报系统模式");
  } else {
    if (value.version !== 1 || Object.keys(value).some(key => !["version", "recordPath", "fields"].includes(key))) throw new Error("填报配置格式无效");
    if (typeof value.recordPath !== "string" || !/^\/(?!\/)[A-Za-z0-9_/{\}.-]+$/.test(value.recordPath)
    || value.recordPath.length > 512 || value.recordPath.split("{id}").length !== 2
      || /[{}]/.test(value.recordPath.replace("{id}", "")) || value.recordPath.split("/").some(part => part === "." || part === "..")) throw new Error("填报路径必须包含一个 {id}，且不能跨域或跳转目录");
  }
  if (!Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 32) throw new Error("填报字段需要 1 至 32 个");
  const keys = new Set<string>();
  for (const field of value.fields) {
    if (!object(field) || typeof field.key !== "string" || !/^[\p{L}\p{N}_-]{1,64}$/u.test(field.key) || unsafeKeys.has(field.key) || keys.has(field.key)) throw new Error("填报字段名无效或重复");
    keys.add(field.key);
    if (value.version === 2 && (!sqlIdentifier(field.key) || field.key === "__revision" || field.key === value.primaryKey || field.key === value.versionColumn)) throw new Error("填报字段不能包含主键、版本列或无效 SQL 列名");
    if (Object.keys(field).some(key => !["key", "type", "required", "min", "max", "maxLength", "options"].includes(key)) || !["string", "number", "boolean", "date"].includes(String(field.type))) throw new Error("填报字段类型无效");
    if (field.required !== undefined && typeof field.required !== "boolean") throw new Error("必填规则无效");
    for (const key of ["min", "max", "maxLength"]) if (field[key] !== undefined && (typeof field[key] !== "number" || !Number.isFinite(field[key]))) throw new Error("填报范围规则无效");
    if ((field.min !== undefined || field.max !== undefined) && field.type !== "number") throw new Error("数值范围仅适用于数值字段");
    if (typeof field.min === "number" && typeof field.max === "number" && field.min > field.max) throw new Error("填报最小值大于最大值");
    if (field.maxLength !== undefined && (field.type !== "string" || !Number.isInteger(field.maxLength) || Number(field.maxLength) < 1 || Number(field.maxLength) > 4096)) throw new Error("文本长度范围为 1 至 4096");
    if (field.options !== undefined && (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 100 || field.options.some(option => validateValue(field as unknown as DataWritebackField, option, false)))) throw new Error("填报选项无效");
  }
}
function sqlIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(value) && new TextEncoder().encode(value).length <= 63 && !unsafeKeys.has(value);
}
function validateValue(field: DataWritebackField, value: unknown, checkOptions = true): string | undefined {
  if (value === null) return field.required ? "不能为空" : undefined;
  if (typeof value === "string" && !value.trim()) return field.required ? "不能为空" : field.type === "string" || field.type === "date" ? undefined : "类型不匹配";
  if (typeof value !== (field.type === "date" ? "string" : field.type)) return "类型不匹配";
  if (typeof value === "number" && (!Number.isFinite(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) return "超出数值范围";
  if (typeof value === "string" && value.length > (field.maxLength ?? 4096)) return "文本过长";
  if (field.type === "date" && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return "日期无效";
  if (checkOptions && field.options && !field.options.includes(value as DataWritebackValue)) return "不在可选范围内";
}
export function validateDataWritebackValues(config: DataWritebackConfig, values: unknown): DataWritebackIssue[] {
  if (!object(values)) return [{ field: "", message: "填报数据必须是对象" }];
  const fields = new Map(config.fields.map(field => [field.key, field]));
  const issues = Object.keys(values).filter(key => !fields.has(key)).map(field => ({ field, message: "字段不允许写入" }));
  for (const field of config.fields) {
    const message = Object.hasOwn(values, field.key) ? validateValue(field, values[field.key]) : field.required ? "不能为空" : undefined;
    if (message) issues.push({ field: field.key, message });
  }
  if (Object.keys(values).length === 0) issues.push({ field: "", message: "没有填报数据" });
  return issues;
}
