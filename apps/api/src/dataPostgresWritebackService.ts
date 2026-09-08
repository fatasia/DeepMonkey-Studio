import { validateDataWritebackValues, type DataConnectionRecord, type DataDatasetRecord, type DataWritebackRequest, type DataWritebackSnapshot } from "@bim-studio/contracts";
import { DataWritebackError } from "./dataWritebackService.js";
import { assertPostgresTarget, postgresClient, postgresProjection, postgresSnapshot, postgresTarget, quoteSqlName, sqlTable } from "./dataPostgresWritebackTarget.js";

export class DataPostgresWritebackService {
  async read(connection: DataConnectionRecord, dataset: DataDatasetRecord, recordId: string): Promise<DataWritebackSnapshot> {
    const target = postgresTarget(connection, dataset, recordId), client = postgresClient(connection);
    try {
      await client.connect();
      await assertPostgresTarget(client, target);
      const result = await client.query(`SELECT ${postgresProjection(target)} FROM ${sqlTable(target)} WHERE ${quoteSqlName(target.primaryKey)}=$1 LIMIT 2`, [recordId]);
      if (!result.rows.length) throw new DataWritebackError(404, "record-not-found", "填报记录不存在");
      if (result.rows.length !== 1) throw new DataWritebackError(400, "primary-key-required", "记录标识不唯一");
      return postgresSnapshot(result.rows[0], target);
    } catch (error) { throw sqlError(error, false); }
    finally { await client.end().catch(() => undefined); }
  }

  async write(connection: DataConnectionRecord, dataset: DataDatasetRecord, recordId: string, body: unknown): Promise<DataWritebackSnapshot> {
    const target = postgresTarget(connection, dataset, recordId);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["values", "expectedVersion"].includes(key))) throw new DataWritebackError(400, "invalid-request", "填报提交格式无效");
    const input = body as DataWritebackRequest;
    if (typeof input.expectedVersion !== "string" || !/^"sql:(0|[1-9]\d{0,18})"$/.test(input.expectedVersion)) throw new DataWritebackError(400, "version-required", "请先读取记录的有效版本");
    const issues = validateDataWritebackValues(target, input.values);
    if (issues.length) throw new DataWritebackError(422, "validation-error", "请修正填报字段", "not-written", issues);
    const client = postgresClient(connection);
    let transaction = false, committing = false;
    try {
      await client.connect();
      await client.query("BEGIN"); transaction = true;
      await assertPostgresTarget(client, target);
      const table = sqlTable(target), key = quoteSqlName(target.primaryKey), revision = quoteSqlName(target.versionColumn);
      const current = await client.query(`SELECT ${postgresProjection(target)} FROM ${table} WHERE ${key}=$1 LIMIT 2 FOR UPDATE`, [recordId]);
      if (!current.rows.length) throw new DataWritebackError(404, "record-not-found", "填报记录不存在");
      if (current.rows.length !== 1) throw new DataWritebackError(400, "primary-key-required", "记录标识不唯一");
      if (postgresSnapshot(current.rows[0], target).version !== input.expectedVersion) throw new DataWritebackError(409, "revision-conflict", "记录已更新，请重新读取并核对草稿");
      const entries = Object.entries(input.values), parameters: unknown[] = entries.map(([, value]) => value);
      parameters.push(recordId, input.expectedVersion.slice(5, -1));
      const assignments = entries.map(([column], i) => `${quoteSqlName(column)}=$${i + 1}`);
      const result = await client.query(`UPDATE ${table} SET ${assignments.join(", ")}, ${revision}=${revision}+1 WHERE ${key}=$${entries.length + 1} AND ${revision}=$${entries.length + 2} RETURNING ${postgresProjection(target)}`, parameters);
      if (result.rowCount !== 1) throw new DataWritebackError(409, "revision-conflict", "记录未完成单行更新，请重新读取并核对草稿");
      const snapshot = postgresSnapshot(result.rows[0], target);
      if (snapshot.version !== `"sql:${BigInt(input.expectedVersion.slice(5, -1)) + 1n}"`) throw new DataWritebackError(400, "version-update-invalid", "数据库未按约定递增记录版本");
      // COMMIT 发出后断线不能证明事务未提交；此时只返回未知，不重试 SQL。
      committing = true;
      await client.query("COMMIT"); transaction = false;
      return snapshot;
    } catch (error) {
      if (transaction && !committing) await client.query("ROLLBACK").catch(() => undefined);
      throw sqlError(error, committing);
    } finally { await client.end().catch(() => undefined); }
  }
}

function sqlError(error: unknown, committing: boolean): DataWritebackError {
  if (committing) return new DataWritebackError(502, "write-outcome-unknown", "写入结果未确认，请重新读取后核对，勿重复提交", "unknown");
  if (error instanceof DataWritebackError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code.startsWith("23") || ["22003", "22007", "22P02"].includes(code)) return new DataWritebackError(422, "database-validation-error", "数据库拒绝字段值，请核对类型、范围或约束");
  if (code === "42501") return new DataWritebackError(403, "database-permission-denied", "数据源账号没有该表的读取或更新权限");
  return new DataWritebackError(502, "database-operation-failed", "数据库操作未完成，请检查连接、目标表和访问权限");
}
