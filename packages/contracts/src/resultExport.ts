/**
 * 仿真结果导出合同(Plant 平替 P2 尾巴,对位 Plant Simulation 开放接口清单中的 MQTT/SQL/ODBC 项)。
 *
 * 定位是"导出器":仿真完成后把 Study 结果一次性发布到外部系统,是仿真后动作;
 * 与规格排除项(实时现场网络连接)不冲突——本层不做实时流订阅,不做远程控制,
 * 也不承担仿真执行期间与现场设备的数据交换。
 *
 * 注入防语法拼接:SQL 值一律参数占位,表名只允许严格标识符(见 assertSqlTableName);
 * MQTT 主题按协议校验(发布主题禁通配符、禁 $ 保留前缀、禁 NUL)。
 */

export type ResultExportTargetKind = "mqtt" | "sql";

export type ResultExportFormat = "json" | "rows";

/** 导出目标:MQTT 指单主题,SQL 指结果表(study_results 结构,主键 study_id+metric_key+provenance)。 */
export interface ResultExportTarget {
  kind: ResultExportTargetKind;
  topicOrTable: string;
  /** MQTT 用 json;SQL 用 rows。组合不匹配在校验时直接拒绝,避免语义含混。 */
  format: ResultExportFormat;
  /** false 时 payload 不含指纹字段,SQL 行 fingerprint 列为 null。 */
  includeFingerprints: boolean;
}

/** 导出回执:publishedAt 取调用方时钟;payloadSha256 是所发布 JSON 的 sha256(payload 不含时间戳,同输入稳定)。 */
export interface ResultExportReceipt {
  target: ResultExportTarget;
  publishedAt: string;
  /** MQTT = 指标数;SQL = 实际 UPSERT 语句数(一行一指标)。 */
  itemCount: number;
  /** fake 仅在测试注入的内存 transport 上出现。 */
  transport: "mqtt" | "sql" | "fake";
  evidence: {
    payloadSha256: string;
  };
}

const MQTT_TOPIC_MAX_BYTES = 65535;
const SQL_IDENTIFIER_MAX_LENGTH = 128;
const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** 发布主题合法性(MQTT 3.1.1/5):发布端禁止通配符,$ 前缀为 broker 保留,NUL 非法。 */
export function assertMqttPublishTopic(topic: unknown, path = "mqttTopic"): asserts topic is string {
  if (typeof topic !== "string" || topic.length === 0) throw new Error(`${path} 必须是非空字符串`);
  if (topic.includes("\u0000")) throw new Error(`${path} 不允许包含 NUL 字符`);
  if (topic.includes("+") || topic.includes("#")) throw new Error(`${path} 是发布主题,不允许包含通配符 + 或 #`);
  if (topic.startsWith("$")) throw new Error(`${path} 不允许以 $ 开头($ 前缀为 broker 保留主题)`);
  if (new TextEncoder().encode(topic).length > MQTT_TOPIC_MAX_BYTES) {
    throw new Error(`${path} 超过 MQTT 协议 ${MQTT_TOPIC_MAX_BYTES} 字节上限`);
  }
}

/** SQL 表名只允许 [schema.]identifier 形式的严格标识符;通过校验后拼接 SQL 是安全的(值仍走参数占位)。 */
export function assertSqlTableName(name: unknown, path = "sqlTableName"): asserts name is string {
  if (typeof name !== "string" || name.length === 0) throw new Error(`${path} 必须是非空字符串`);
  if (name.length > SQL_IDENTIFIER_MAX_LENGTH) {
    throw new Error(`${path} 超过 ${SQL_IDENTIFIER_MAX_LENGTH} 字符上限`);
  }
  if (!SQL_IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`${path} 只允许 [schema.]表名 形式的字母/数字/下划线标识符,收到:${name}`);
  }
}

export function assertResultExportTarget(value: unknown, path = "resultExportTarget"): asserts value is ResultExportTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是目标对象`);
  const target = value as Record<string, unknown>;
  if (target.kind !== "mqtt" && target.kind !== "sql") throw new Error(`${path}.kind 必须是 mqtt 或 sql`);
  if (target.format !== "json" && target.format !== "rows") throw new Error(`${path}.format 必须是 json 或 rows`);
  if (target.kind === "mqtt" && target.format !== "json") throw new Error(`${path}: MQTT 目标必须使用 json 格式`);
  if (target.kind === "sql" && target.format !== "rows") throw new Error(`${path}: SQL 目标必须使用 rows 格式`);
  if (typeof target.includeFingerprints !== "boolean") throw new Error(`${path}.includeFingerprints 必须是布尔值`);
  if (target.kind === "mqtt") assertMqttPublishTopic(target.topicOrTable, `${path}.topicOrTable`);
  else assertSqlTableName(target.topicOrTable, `${path}.topicOrTable`);
}
