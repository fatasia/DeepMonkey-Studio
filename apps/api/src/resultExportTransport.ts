/**
 * 结果导出 transport:MQTT 发布与 SQL 写入的可注入出口。
 * 依赖纪律:mqtt 与 pg 均为 apps/api 既有依赖,经动态 import 收编;真实客户端缺失时
 * 显式报"未安装"错误而不是 crash。全部接口可注入(测试用内存 fake),fake 的 UPSERT
 * 语义与 SQL ON CONFLICT 一致(按主键 study_id+metric_key+provenance 覆盖)。
 * SQL 值一律参数占位($1..$n),表名经 contracts 校验为严格标识符后拼接,禁止值拼接。
 */
import { assertSqlTableName } from "@bim-studio/contracts";
import { STUDY_RESULT_COLUMNS } from "./resultExportPayload.js";
import type { ResultExportRowValues } from "./resultExportPayload.js";

/** MQTT 连接配置;合同不承载明文密码之外的敏感信息,密码解析由宿主/路由层负责。 */
export interface ResultMqttConnection {
  brokerUrl: string;
  clientId?: string;
  user?: string;
  password?: string;
  connectTimeoutMs?: number;
}

/** SQL 连接配置;pg 连接串可由宿主从环境变量解析后传入。 */
export interface ResultSqlConnection {
  connectionString?: string;
}

/** 参数化语句:值一律走 values 数组,禁止把值拼进 text。 */
export interface SqlParameterizedStatement {
  text: string;
  values: unknown[];
}

/** MQTT 发布 transport;end 由发布器在完成后调用,连接生命周期归发布器管。 */
export interface ResultMqttTransport {
  readonly kind: "mqtt" | "fake";
  publish(topic: string, payload: string, options: { qos: 1 }): Promise<void>;
  end?(): Promise<void>;
}

/** SQL transport:ensure 建 study_results 形状表,upsert 逐条执行参数化 UPSERT,返回执行语句数。 */
export interface ResultSqlTransport {
  readonly kind: "sql" | "fake";
  ensureStudyResultsTable(statement: SqlParameterizedStatement): Promise<void>;
  upsertStudyResultRows(statements: SqlParameterizedStatement[]): Promise<number>;
  /** 真实客户端关闭连接;内存 fake 不实现(保留状态供回读)。 */
  end?(): Promise<void>;
}

/** mqtt 包客户端的发布所需最小面(真实类型经 as never 断言,避免拖入完整类型依赖)。 */
interface MqttPublishClient {
  publishAsync(topic: string, payload: string, options: { qos: 1 }): Promise<unknown>;
  endAsync(force?: boolean): Promise<unknown>;
}

/** pg 客户端最小面。 */
interface PgQueryClient {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<unknown>;
}

function missingDependencyError(packageName: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${packageName} 客户端未安装:结果导出依赖 ${packageName} 包(当前环境未提供)。原始错误:${detail}`);
}

/** 默认 MQTT transport:动态 import mqtt(v5),QoS 由调用方传入(导出器固定 QoS 1)。 */
export async function resolveMqttTransport(
  connection: ResultMqttConnection,
  load: () => Promise<unknown> = () => import("mqtt"),
): Promise<ResultMqttTransport> {
  let mod: unknown;
  try {
    mod = await load();
  } catch (error) {
    throw missingDependencyError("mqtt", error);
  }
  const connectAsync = (mod as { connectAsync?: unknown } | null)?.connectAsync;
  if (typeof connectAsync !== "function") {
    throw new Error("mqtt 客户端未安装:动态导入的 mqtt 包缺少 connectAsync 入口");
  }
  const client = (await (connectAsync as (url: string, options: Record<string, unknown>) => Promise<unknown>)(
    connection.brokerUrl,
    {
      clientId: connection.clientId ?? `bim-studio-result-export-${Date.now()}`,
      reconnectPeriod: 0,
      ...(connection.connectTimeoutMs !== undefined ? { connectTimeout: connection.connectTimeoutMs } : {}),
      ...(connection.user ? { username: connection.user } : {}),
      ...(connection.password ? { password: connection.password } : {}),
    },
  )) as never as MqttPublishClient;
  return {
    kind: "mqtt",
    async publish(topic, payload, options) {
      await client.publishAsync(topic, payload, { qos: options.qos });
    },
    async end() {
      await client.endAsync(true);
    },
  };
}

/** 默认 SQL transport(pg Client);connectionString 透传 pg 配置。 */
export async function resolvePgTransport(
  connection: ResultSqlConnection,
  load: () => Promise<unknown> = () => import("pg"),
): Promise<ResultSqlTransport> {
  let mod: unknown;
  try {
    mod = await load();
  } catch (error) {
    throw missingDependencyError("pg", error);
  }
  const clientConstructor = (mod as { Client?: unknown } | null)?.Client;
  if (typeof clientConstructor !== "function") {
    throw new Error("pg 客户端未安装:动态导入的 pg 包缺少 Client 入口");
  }
  const client = new (clientConstructor as new (config: { connectionString?: string }) => PgQueryClient)({
    ...(connection.connectionString ? { connectionString: connection.connectionString } : {}),
  });
  await client.connect();
  return {
    kind: "sql",
    async ensureStudyResultsTable(statement) {
      await client.query(statement.text, statement.values);
    },
    async upsertStudyResultRows(statements) {
      let executed = 0;
      for (const statement of statements) {
        await client.query(statement.text, statement.values);
        executed += 1;
      }
      return executed;
    },
    async end() {
      await client.end();
    },
  };
}

/** study_results 建表语句(幂等 DDL;主键即 UPSERT 冲突键)。表名已由调用方断言为严格标识符。 */
export function buildStudyResultsEnsureTableStatement(table: string): SqlParameterizedStatement {
  assertSqlTableName(table, "table");
  return {
    text:
      `CREATE TABLE IF NOT EXISTS ${table} (\n` +
      "  study_id TEXT NOT NULL,\n" +
      "  metric_key TEXT NOT NULL,\n" +
      "  metric_value DOUBLE PRECISION,\n" +
      "  unit TEXT,\n" +
      "  ci_low DOUBLE PRECISION,\n" +
      "  ci_high DOUBLE PRECISION,\n" +
      "  samples INTEGER,\n" +
      "  provenance TEXT NOT NULL,\n" +
      "  fingerprint TEXT,\n" +
      "  PRIMARY KEY (study_id, metric_key, provenance)\n" +
      ")",
    values: [],
  };
}

/** 一行一指标的参数化 UPSERT:值全部 $1..$9 占位,冲突时覆盖可变列(键列不动)。 */
export function buildStudyResultUpsertStatement(table: string, values: ResultExportRowValues): SqlParameterizedStatement {
  assertSqlTableName(table, "table");
  if (values.length !== STUDY_RESULT_COLUMNS.length) {
    throw new Error(`study_results 行值列数应为 ${STUDY_RESULT_COLUMNS.length},收到 ${values.length}`);
  }
  const columns = STUDY_RESULT_COLUMNS.join(", ");
  const placeholders = STUDY_RESULT_COLUMNS.map((_, index) => `$${index + 1}`).join(", ");
  const updatable = STUDY_RESULT_COLUMNS.filter((column) => !["study_id", "metric_key", "provenance"].includes(column));
  const assignments = updatable.map((column) => `${column} = EXCLUDED.${column}`).join(", ");
  return {
    text:
      `INSERT INTO ${table} (${columns}) VALUES (${placeholders})\n` +
      `ON CONFLICT (study_id, metric_key, provenance) DO UPDATE SET ${assignments}`,
    values: [...values],
  };
}

/** 内存 fake transport:按主键 Map 复现 UPSERT 语义,供测试回读与幂等断言;同时留存全部语句供审计。 */
export class MemoryStudyResultSqlTransport implements ResultSqlTransport {
  readonly kind = "fake" as const;
  readonly statements: SqlParameterizedStatement[] = [];
  readonly ensuredTables: string[] = [];
  private readonly tables = new Map<string, Map<string, ResultExportRowValues>>();

  async ensureStudyResultsTable(statement: SqlParameterizedStatement): Promise<void> {
    this.statements.push(statement);
    const table = /CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_.]*)/.exec(statement.text)?.[1];
    if (!table) throw new Error("fake transport 收到非建表语句");
    this.ensuredTables.push(table);
    if (!this.tables.has(table)) this.tables.set(table, new Map());
  }

  async upsertStudyResultRows(statements: SqlParameterizedStatement[]): Promise<number> {
    let count = 0;
    for (const statement of statements) {
      this.statements.push(statement);
      const table = /INSERT INTO ([A-Za-z_][A-Za-z0-9_.]*)/.exec(statement.text)?.[1];
      if (!table || !this.tables.has(table)) throw new Error(`fake transport 未识别的目标表:${table ?? statement.text}`);
      if (statement.values.length !== STUDY_RESULT_COLUMNS.length) {
        throw new Error(`fake transport 行值列数应为 ${STUDY_RESULT_COLUMNS.length},收到 ${statement.values.length}`);
      }
      const row = statement.values as ResultExportRowValues;
      const key = `${row[0]}\u0000${row[1]}\u0000${row[7]}`;
      this.tables.get(table)!.set(key, [...row]);
      count += 1;
    }
    return count;
  }

  /** 按 (study_id, metric_key) 升序回读,便于幂等断言。 */
  readRows(table: string): ResultExportRowValues[] {
    return [...(this.tables.get(table)?.values() ?? [])].sort((left, right) =>
      `${left[0]}\u0000${left[1]}`.localeCompare(`${right[0]}\u0000${right[1]}`),
    );
  }
}

/** 内存 fake MQTT transport:留存最近一次发布,供测试断言 topic/qos/payload。 */
export class MemoryMqttTransport implements ResultMqttTransport {
  readonly kind = "fake" as const;
  readonly publications: Array<{ topic: string; payload: string; qos: 1 }> = [];
  ended = false;

  async publish(topic: string, payload: string, options: { qos: 1 }): Promise<void> {
    this.publications.push({ topic, payload, qos: options.qos });
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}
