/**
 * 仿真结果导出门面:publishResultMqtt(MQTT 单主题 JSON,QoS 1)与 writeResultSql
 * (study_results 一行一指标,UPSERT 幂等)。定位是仿真完成后的导出器,不是实时流订阅,
 * 也不做远程控制;transport 可注入,真实客户端缺失时显式报"未安装"。
 */
import type { ResultExportPayload } from "./resultExportPayload.js";
import { resultExportPayloadSha256 } from "./resultExportPayload.js";
import {
  buildStudyResultUpsertStatement,
  buildStudyResultsEnsureTableStatement,
  resolveMqttTransport,
  resolvePgTransport,
} from "./resultExportTransport.js";
import type {
  ResultMqttConnection,
  ResultMqttTransport,
  ResultSqlConnection,
  ResultSqlTransport,
} from "./resultExportTransport.js";
import type { ResultExportReceipt, ResultExportTarget } from "@bim-studio/contracts";
import { assertResultExportTarget } from "@bim-studio/contracts";

export {
  STUDY_RESULTS_DEFAULT_TABLE,
  STUDY_RESULT_COLUMNS,
  buildResultExportPayload,
  resultExportPayloadSha256,
} from "./resultExportPayload.js";
export type {
  BuildResultExportPayloadOptions,
  ResultExportKpi,
  ResultExportPayloadJson,
  ResultExportRowValues,
} from "./resultExportPayload.js";
export {
  MemoryMqttTransport,
  MemoryStudyResultSqlTransport,
  buildStudyResultUpsertStatement,
  buildStudyResultsEnsureTableStatement,
  resolveMqttTransport,
  resolvePgTransport,
} from "./resultExportTransport.js";
export type {
  ResultMqttConnection,
  ResultMqttTransport,
  ResultSqlConnection,
  ResultSqlTransport,
  SqlParameterizedStatement,
} from "./resultExportTransport.js";

export interface ResultExportTransports {
  mqtt?: ResultMqttTransport;
  sql?: ResultSqlTransport;
}

/** 单主题 JSON 发布,QoS 1;payload 即 JSON.stringify(payloadJson),收据携带其 sha256。 */
export async function publishResultMqtt(
  payload: ResultExportPayload,
  target: ResultExportTarget,
  transport?: ResultMqttTransport,
  connection?: ResultMqttConnection,
): Promise<ResultExportReceipt> {
  assertResultExportTarget(target);
  if (target.kind !== "mqtt") throw new Error(`publishResultMqtt 需要 MQTT 目标,收到 ${target.kind}`);
  const body = JSON.stringify(payload.payloadJson);
  const payloadSha256 = resultExportPayloadSha256(payload.payloadJson);
  const resolved = transport
    ?? (connection ? await resolveMqttTransport(connection) : undefined);
  if (!resolved) {
    throw new Error("MQTT 发布失败:未提供 transport,也未提供 broker 连接配置(brokerUrl)");
  }
  await resolved.publish(target.topicOrTable, body, { qos: 1 });
  await resolved.end?.();
  return {
    target,
    publishedAt: new Date().toISOString(),
    itemCount: payload.rows.length,
    transport: resolved.kind,
    evidence: { payloadSha256 },
  };
}

/** study_results 幂等写入:先建表(幂等 DDL),再逐行 UPSERT(主键 study_id+metric_key+provenance)。 */
export async function writeResultSql(
  payload: ResultExportPayload,
  target: ResultExportTarget,
  transport?: ResultSqlTransport,
  connection?: ResultSqlConnection,
): Promise<ResultExportReceipt> {
  assertResultExportTarget(target);
  if (target.kind !== "sql") throw new Error(`writeResultSql 需要 SQL 目标,收到 ${target.kind}`);
  const table = target.topicOrTable;
  const rows = payload.rows;
  for (const row of rows) {
    if (row.table !== table) {
      throw new Error(`payload 行目标表 ${row.table} 与导出目标表 ${table} 不一致,拒绝写入`);
    }
  }
  const resolved = transport ?? (connection ? await resolvePgTransport(connection) : undefined);
  if (!resolved) {
    throw new Error("SQL 写入失败:未提供 transport,也未提供数据库连接配置(connectionString)");
  }
  await resolved.ensureStudyResultsTable(buildStudyResultsEnsureTableStatement(table));
  const written = await resolved.upsertStudyResultRows(rows.map((row) => buildStudyResultUpsertStatement(table, row.values)));
  // 真实客户端(pg)在写入完成后关闭连接;内存 fake 不实现 end,保留状态供测试回读。
  await resolved.end?.();
  return {
    target,
    publishedAt: new Date().toISOString(),
    itemCount: written,
    transport: resolved.kind,
    evidence: { payloadSha256: resultExportPayloadSha256(payload.payloadJson) },
  };
}
