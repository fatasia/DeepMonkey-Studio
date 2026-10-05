import { useCallback, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Database, Globe2, LoaderCircle, Radio, RotateCcw, Table2 } from "lucide-react";
import type { DataConnectionRecord, DataConnectionType, DataConnectorDiagnostics, DataDatasetPreview, DataDatasetRecord, DataFieldType } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { datasetFieldStats, connectorTrendBars, PREVIEW_ROW_HEIGHT, visibleRowRange, type ConnectorTrendSample, type DatasetFieldStat } from "./dataCenterWorkbenchLogic";

export const SQL_CONNECTIONS = new Set<DataConnectionType>(["postgresql", "mysql", "mariadb", "tidb", "doris", "starrocks", "sqlserver", "oracle", "tdengine", "clickhouse"]);

export const DATABASE_CONNECTIONS = new Set<DataConnectionType>([...SQL_CONNECTIONS, "mongodb", "elasticsearch", "influxdb", "prometheus"]);

export const JSON_QUERY_CONNECTORS = new Set<DataConnectionType>(["mongodb", "elasticsearch"]);

export const QUERY_CONNECTORS = new Set<DataConnectionType>([...SQL_CONNECTIONS, ...JSON_QUERY_CONNECTORS, "influxdb", "prometheus", "http"]);

export const FILE_CONNECTORS = new Set<DataConnectionType>(["csv", "excel"]);

export const CONNECTOR_REQUIRED = new Set<DataConnectionType>();

export const WRITABLE_CONNECTIONS = new Set<DataConnectionType>(["bacnet", "s7", "ethernet-ip", "serial", "simulation"]);

/** 字段统计徽章行：类型徽章 + 样例值 + 空值率（无行时不谎报 0%）。 */
export function FieldStatBadges({ stats, locale }: { stats: DatasetFieldStat[]; locale: AppLocale }) {
  return (
    <div className="data-field-stats" role="list" aria-label={tr(locale, "字段统计", "Field statistics")}>
      {stats.map((stat) => {
        const sample = stat.type === "datetime" && stat.sample ? formatCell(stat.sample, "datetime", locale) : stat.sample;
        return (
        <span key={stat.key} role="listitem" className="data-field-stat" title={`${stat.key} · ${stat.type}${sample ? ` · ${tr(locale, "样例", "e.g.")} ${sample}` : ""}`}>
          <code className={`data-field-type is-${stat.type}`}>{fieldTypeBadge(stat.type, locale)}</code>
          <strong>{stat.key}</strong>
          {sample && <small title={sample}>{sample}</small>}
          <small className={`data-field-nullrate${stat.nullRate !== undefined && stat.nullRate >= 0.5 ? " is-high" : ""}`}>
            {stat.nullRate === undefined ? tr(locale, "无行", "no rows") : tr(locale, `空值 ${(stat.nullRate * 100).toFixed(0)}%`, `${(stat.nullRate * 100).toFixed(0)}% null`)}
          </small>
        </span>
        );
      })}
    </div>
  );
}

/** 类型徽章文字（数值/文本/时间/布尔/枚举/JSON 六类；西门子纪律：图标位由色+文字承担）。 */
export function fieldTypeBadge(type: DataFieldType, locale: AppLocale): string {
  const known: Partial<Record<DataFieldType, { zh: string; en: string }>> = {
    number: { zh: "数值", en: "num" },
    string: { zh: "文本", en: "text" },
    datetime: { zh: "时间", en: "time" },
    boolean: { zh: "布尔", en: "bool" },
    json: { zh: "JSON", en: "json" },
  };
  const badge = known[type];
  return badge ? tr(locale, badge.zh, badge.en) : type;
}

/** 连接监控迷你趋势条：本会话诊断快照的延迟柱(失败快照标警示色);样本 <2 如实标注采集中。 */
export function ConnectorTrendBars({ samples, locale }: { samples: ConnectorTrendSample[]; locale: AppLocale }) {
  const bars = connectorTrendBars(samples);
  const failureCount = bars.filter((bar) => bar.failures > 0).length;
  return (
    <div className="data-connector-trend">
      <span className="data-connector-trend-caption">
        {samples.length < 2
          ? tr(locale, `延迟趋势 · 样本采集中(${samples.length}/2)——执行连接测试或刷新后累积`, `Latency trend · collecting samples (${samples.length}/2) — run a connection test or refresh`)
          : tr(locale, `延迟趋势 · 最近 ${samples.length} 次快照${failureCount > 0 ? ` · ${failureCount} 次带失败` : ""}`, `Latency trend · last ${samples.length} snapshots${failureCount > 0 ? ` · ${failureCount} with failures` : ""}`)}
      </span>
      <span className="data-connector-trend-bars" role="img" aria-label={samples.length < 2 ? tr(locale, "样本采集中", "Collecting samples") : tr(locale, `${samples.length} 个延迟样本`, `${samples.length} latency samples`)}>
        {bars.map((bar, index) => (
          <i
            key={index}
            className={bar.failures > 0 ? "has-failure" : ""}
            style={{ height: `${Math.max(8, Math.round(bar.latency * 100))}%` }}
            title={`${bar.latencyMs} ms · ${tr(locale, "失败", "failures")} ${bar.failures}`}
          />
        ))}
      </span>
    </div>
  );
}

export function DatasetPreview({ locale, preview, datasetName, busy, error, onRetry }: {
  locale: AppLocale;
  preview?: DataDatasetPreview;
  datasetName?: string;
  /** 加载态：骨架行（形状贴合最终表格），与其余消费方缺省行为兼容。 */
  busy?: boolean;
  /** 查询失败态：可操作重试；排障信息不截断。 */
  error?: string;
  onRetry?: () => void;
}) {
  if (error)
    return (
      <div className="data-preview-error" role="alert">
        <AlertTriangle size={20} />
        <strong>{tr(locale, "查询失败", "Query failed")}</strong>
        <span>{error}</span>
        {onRetry && (
          <button onClick={onRetry}>
            <RotateCcw size={13} />
            {tr(locale, "重试查询", "Retry query")}
          </button>
        )}
      </div>
    );
  if (!preview)
    return busy ? (
      <div className="data-preview-skeleton" role="status" aria-label={tr(locale, "正在查询", "Querying")}>
        <p><LoaderCircle className="spin" size={14} /> {tr(locale, "正在运行查询…", "Running query…")}</p>
        <div className="data-preview-skeleton-table" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div key={row} className="data-preview-skeleton-row">
              {[0, 1, 2, 3, 4].map((cell) => <i key={cell} style={{ animationDelay: `${(row * 5 + cell) * 40}ms` }} />)}
            </div>
          ))}
        </div>
      </div>
    ) : (
      <div className="data-preview-empty">
        <Table2 size={30} />
        <strong>{datasetName ? tr(locale, "尚未运行查询", "Query not run yet") : tr(locale, "选择一个数据集", "Select a dataset")}</strong>
        <span>
          {datasetName
            ? tr(locale, `运行“${datasetName}”后将在此显示字段和前 100 行数据。`, `Run “${datasetName}” to show inferred fields and up to 100 rows here.`)
            : tr(locale, "从左侧选择数据集，然后运行查询。", "Select a dataset on the left, then run its query.")}
        </span>
      </div>
    );
  const stats = datasetFieldStats(preview.fields, preview.rows);
  return (
    <div className="data-preview-table">
      <FieldStatBadges stats={stats} locale={locale} />
      <PreviewTable locale={locale} preview={preview} />
    </div>
  );
}

/** 预览表体：固定行高虚拟滚动（上限 100 行仍按窗口渲染，滚动不卡）。 */
export function PreviewTable({ locale, preview }: { locale: AppLocale; preview: DataDatasetPreview }) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(PREVIEW_VIEWPORT_DEFAULT);
  const attach = useCallback((element: HTMLDivElement | null) => {
    if (element) setViewportHeight(element.clientHeight || PREVIEW_VIEWPORT_DEFAULT);
  }, []);
  const { start, end } = visibleRowRange({ scrollTop, viewportHeight, total: preview.rows.length });
  const rows = preview.rows.slice(start, end);
  return (
    <div
      ref={attach}
      className="data-preview-scroll"
      onScroll={(event) => setScrollTop((event.target as HTMLDivElement).scrollTop)}
    >
      <table>
        <thead>
          <tr>
            {preview.fields.map((field) => (
              <th key={field.key}>
                <span>{field.label}</span>
                <small>
                  {field.type}
                  {field.unit ? ` · ${field.unit}` : ""}
                </small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {start > 0 && <tr style={{ height: start * PREVIEW_ROW_HEIGHT }} aria-hidden="true"><td colSpan={preview.fields.length} /></tr>}
          {rows.map((row, index) => (
            <tr key={start + index}>
              {preview.fields.map((field) => (
                <td key={field.key} title={field.type === "datetime" ? String(row[field.key] ?? "") : undefined}>{formatCell(row[field.key], field.type, locale)}</td>
              ))}
            </tr>
          ))}
          {end < preview.rows.length && <tr style={{ height: (preview.rows.length - end) * PREVIEW_ROW_HEIGHT }} aria-hidden="true"><td colSpan={preview.fields.length} /></tr>}
        </tbody>
      </table>
      {preview.rows.length > 0 && (
        <p className="data-preview-rows-hint">
          {tr(locale, `显示第 ${start + 1}–${end} 行 / 共 ${preview.rows.length} 行`, `Rows ${start + 1}–${end} of ${preview.rows.length}`)}
        </p>
      )}
    </div>
  );
}

/** 预览区可视高度缺省值（挂载后以容器实测为准）。 */
const PREVIEW_VIEWPORT_DEFAULT = 420;

export function FlowStep({ icon, index, title, caption }: { icon: ReactNode; index: string; title: string; caption: string }) {
  return (
    <div>
      <b>{index}</b>
      {icon}
      <span>
        <strong>{title}</strong>
        <small>{caption}</small>
      </span>
    </div>
  );
}

export function ConnectionIcon({ type }: { type: DataConnectionType }) {
  return type === "http" || FILE_CONNECTORS.has(type) ? <Globe2 size={18} /> : SQL_CONNECTIONS.has(type) ? <Database size={18} /> : <Radio size={18} />;
}

export function connectionLabel(type: DataConnectionType) {
  return (
    {
      postgresql: "PostgreSQL",
      mysql: "MySQL",
      mariadb: "MariaDB",
      tidb: "TiDB",
      doris: "Apache Doris",
      starrocks: "StarRocks",
      sqlserver: "Microsoft SQL Server",
      oracle: "Oracle",
      tdengine: "TDengine",
      clickhouse: "ClickHouse",
      mongodb: "MongoDB",
      elasticsearch: "Elasticsearch / OpenSearch",
      influxdb: "InfluxDB",
      prometheus: "Prometheus",
      csv: "CSV file / URL",
      excel: "Excel file / URL",
      http: "HTTP API",
      websocket: "WebSocket",
      mqtt: "MQTT",
      opcua: "OPC UA",
      modbus: "Modbus TCP",
      bacnet: "BACnet",
      tcp: "TCP",
      udp: "UDP",
      serial: "Serial",
      s7: "Siemens S7",
      "ethernet-ip": "EtherNet/IP",
      snmp: "SNMP v1/v2c",
      amqp: "AMQP / RabbitMQ",
      kafka: "Kafka",
      coap: "CoAP",
      simulation: "模拟数据",
    } as Record<DataConnectionType, string>
  )[type];
}

export function connectorStatusLabel(status: DataConnectorDiagnostics["status"] | undefined, locale: AppLocale): string {
  return status === "healthy"
    ? tr(locale, "健康", "Healthy")
    : status === "degraded"
      ? tr(locale, "已重连", "Recovered")
      : status === "offline"
        ? tr(locale, "离线", "Offline")
        : tr(locale, "待检测", "Idle");
}

export function databaseLabel(type: DataConnectionType, locale: AppLocale): string {
  return type === "oracle"
    ? "Service / SID"
    : type === "influxdb"
      ? tr(locale, "组织", "Organization")
      : type === "prometheus"
        ? tr(locale, "租户（可选）", "Tenant (optional)")
        : tr(locale, "数据库", "Database");
}

export function connectionSummary(connection: DataConnectionRecord) {
  return String(connection.config.url || connection.config.database || connection.config.serviceName || connection.config.host || "实时连接");
}

export function formatCell(value: unknown, fieldType?: DataFieldType, locale: AppLocale = "zh-CN") {
  if (value === null || value === undefined) return "—";
  if (fieldType === "datetime" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const time = new Date(value);
    if (Number.isFinite(time.getTime())) return time.toLocaleString(locale, {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function defaultPort(type: DataConnectionType) {
  return (
    (
      {
        postgresql: 5432,
        mysql: 3306,
        mariadb: 3306,
        tidb: 4000,
        doris: 9030,
        starrocks: 9030,
        sqlserver: 1433,
        oracle: 1521,
        tdengine: 6041,
        clickhouse: 8123,
        mongodb: 27017,
        elasticsearch: 9200,
        influxdb: 8086,
        prometheus: 9090,
      } as Partial<Record<DataConnectionType, number>>
    )[type] ?? 0
  );
}

export function defaultPasswordEnv(type: DataConnectionType) {
  return (
    (
      {
        postgresql: "POSTGRES_PASSWORD",
        mysql: "MYSQL_PASSWORD",
        mariadb: "MARIADB_PASSWORD",
        tidb: "TIDB_PASSWORD",
        doris: "DORIS_PASSWORD",
        starrocks: "STARROCKS_PASSWORD",
        sqlserver: "SQLSERVER_PASSWORD",
        oracle: "ORACLE_PASSWORD",
        tdengine: "TDENGINE_PASSWORD",
        clickhouse: "CLICKHOUSE_PASSWORD",
        mongodb: "MONGODB_PASSWORD",
        elasticsearch: "ELASTICSEARCH_PASSWORD",
        influxdb: "INFLUXDB_TOKEN",
        prometheus: "PROMETHEUS_PASSWORD",
        mqtt: "MQTT_PASSWORD",
        kafka: "KAFKA_PASSWORD",
        amqp: "AMQP_PASSWORD",
        opcua: "OPCUA_PASSWORD",
        snmp: "SNMP_COMMUNITY",
      } as Partial<Record<DataConnectionType, string>>
    )[type] ?? ""
  );
}

export function extractReadOnlySql(answer: string) {
  const fenced = answer.match(/```(?:sql)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const sql = (fenced || answer).trim().replace(/;+\s*$/, "");
  if (!/^(select|with|explain)\b/i.test(sql) || /\b(insert|update|delete|merge|drop|alter|truncate|create|grant|revoke|call|execute)\b/i.test(sql)) return "";
  return sql;
}

export function connectionTypeOptions(locale: AppLocale) {
  return (
    <>
      <optgroup label="Development">
        <option value="simulation">模拟数据 · 可切换真实源</option>
      </optgroup>
      <optgroup label="File">
        <option value="csv">CSV file / URL</option>
        <option value="excel">Excel file / URL</option>
      </optgroup>
      <optgroup label="API / Messaging">
        <option value="http">HTTP API</option>
        <option value="websocket">WebSocket</option>
        <option value="mqtt">MQTT</option>
        <option value="kafka">Kafka</option>
        <option value="amqp">AMQP / RabbitMQ</option>
        <option value="coap">CoAP</option>
      </optgroup>
      <optgroup label="Database / Analytics">
        <option value="postgresql">PostgreSQL</option>
        <option value="mysql">MySQL</option>
        <option value="mariadb">MariaDB</option>
        <option value="tidb">TiDB</option>
        <option value="doris">Apache Doris</option>
        <option value="starrocks">StarRocks</option>
        <option value="sqlserver">Microsoft SQL Server</option>
        <option value="oracle">Oracle</option>
        <option value="tdengine">TDengine</option>
        <option value="clickhouse">ClickHouse</option>
        <option value="mongodb">MongoDB</option>
        <option value="elasticsearch">Elasticsearch / OpenSearch</option>
        <option value="influxdb">InfluxDB</option>
        <option value="prometheus">Prometheus</option>
      </optgroup>
      <optgroup label="Industrial / IoT">
        <option value="opcua">OPC UA</option>
        <option value="modbus">Modbus TCP</option>
        <option value="snmp">SNMP v1/v2c</option>
        <option value="tcp">TCP telemetry</option>
        <option value="udp">UDP telemetry</option>
        <option value="bacnet">BACnet</option>
        <option value="s7">Siemens S7</option>
        <option value="ethernet-ip">EtherNet/IP</option>
        <option value="serial">Serial</option>
      </optgroup>
    </>
  );
}

export function defaultConnectorUrl(type: DataConnectionType): string {
  return (
    (
      {
        simulation: "sim://telemetry?rows=30&seed=42",
        csv: "https://example.com/telemetry.csv",
        excel: "https://example.com/telemetry.xlsx",
        http: "/api/demo/sensors",
        websocket: "wss://stream.example.com/data",
        mqtt: "mqtt://broker.example.com:1883",
        kafka: "kafka://broker-1.example.com:9092,broker-2.example.com:9092",
        amqp: "amqp://broker.example.com:5672/",
        coap: "coap://device.example.com:5683/telemetry",
        snmp: "udp://device.example.com:161",
        tcp: "tcp://device.example.com:5000",
        udp: "udp://0.0.0.0:5001",
        opcua: "opc.tcp://plc.example.com:4840",
        modbus: "modbus://plc.example.com:502",
        bacnet: "bacnet://device.example.com:47808",
        s7: "s7://plc.example.com:102?rack=0&slot=2",
        "ethernet-ip": "eip://plc.example.com:44818?slot=0",
        serial: "serial://COM3?baudRate=9600&dataBits=8&stopBits=1&parity=none",
      } as Partial<Record<DataConnectionType, string>>
    )[type] ?? `${type}://...`
  );
}

export function defaultDatasetQuery(type: DataConnectionType): string {
  return type === "http"
    ? ""
    : type === "sqlserver"
    ? "SELECT TOP (100) * FROM your_table"
    : type === "mongodb"
      ? "{}"
      : type === "elasticsearch"
        ? '{"query":{"match_all":{}}}'
        : type === "influxdb"
          ? 'from(bucket: "telemetry") |> range(start: -1h) |> limit(n: 100)'
          : type === "prometheus"
            ? "up"
            : "SELECT * FROM your_table LIMIT 100";
}

export function defaultDatasetSourceKey(type: DataConnectionType): string {
  return type === "mongodb"
    ? "collection_name"
    : type === "elasticsearch"
      ? "index_name"
      : type === "excel"
        ? "Sheet1"
        : type === "amqp"
          ? "telemetry.queue"
          : type === "snmp"
            ? "1.3.6.1.2.1.1.3.0"
            : type === "bacnet"
              ? "8,1,85"
              : type === "s7"
                ? "DB1,REAL0"
                : type === "ethernet-ip"
                  ? "Tag1"
                  : type === "tcp" || type === "udp" || type === "coap" || type === "serial" || type === "simulation"
                    ? ""
                    : "items";
}

export function writeAddressPlaceholder(type: DataConnectionType): string {
  return type === "bacnet" ? "8,1,85" : type === "s7" ? "DB1,REAL0" : type === "ethernet-ip" ? "Temperature" : type === "serial" ? "raw" : "pump.start";
}

export function parseWriteValue(value: string): unknown {
  const text = value.trim();
  if (!text) return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function datasetSourceLabel(type: DataConnectionType, locale: AppLocale): string {
  return type === "mqtt" || type === "kafka"
    ? "Topic"
    : type === "amqp"
      ? tr(locale, "队列", "Queue")
      : type === "snmp"
        ? "OID"
        : type === "bacnet"
          ? "BACnet 属性"
          : type === "s7"
            ? "S7 地址"
            : type === "ethernet-ip"
              ? "EtherNet/IP Tag"
              : type === "serial"
                ? tr(locale, "帧路径（可选）", "Frame path (optional)")
                : type === "opcua"
                  ? "NodeId"
                  : type === "modbus"
                    ? tr(locale, "寄存器范围", "Register range")
                    : type === "mongodb"
                      ? tr(locale, "集合", "Collection")
                      : type === "elasticsearch"
                        ? tr(locale, "索引", "Index")
                        : type === "excel"
                          ? tr(locale, "工作表", "Sheet")
                          : type === "tcp" || type === "udp" || type === "simulation"
                            ? tr(locale, "JSON 数据路径（可选）", "JSON data path (optional)")
                            : tr(locale, "数据路径", "Data path");
}

export function datasetSourcePlaceholder(type: DataConnectionType): string {
  return type === "mqtt"
    ? "factory/+/telemetry"
    : type === "kafka"
      ? "device-telemetry"
      : type === "amqp"
        ? "factory.telemetry"
        : type === "snmp"
          ? "1.3.6.1.2.1.1.3.0"
          : type === "bacnet"
            ? "8,1,85（可用分号分隔多个）"
            : type === "s7"
              ? "DB1,REAL0;M0"
              : type === "ethernet-ip"
                ? "Temperature,MotorSpeed"
                : type === "serial"
                  ? "（串口收到 JSON 时可填路径）"
                  : type === "opcua"
                    ? "ns=2;s=Machine.Temperature"
                    : type === "modbus"
                      ? "holding:0:10"
                      : type === "mongodb"
                        ? "device_events"
                        : type === "elasticsearch"
                          ? "device-events-*"
                          : type === "excel"
                            ? "Sheet1"
                            : "items";
}
