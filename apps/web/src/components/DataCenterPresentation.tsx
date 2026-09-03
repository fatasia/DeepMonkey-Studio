import type { ReactNode } from "react";
import { Database, Globe2, Radio, Table2 } from "lucide-react";
import type { DataConnectionRecord, DataConnectionType, DataConnectorDiagnostics, DataDatasetPreview } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export const SQL_CONNECTIONS = new Set<DataConnectionType>(["postgresql", "mysql", "mariadb", "tidb", "doris", "starrocks", "sqlserver", "oracle", "tdengine", "clickhouse"]);

export const DATABASE_CONNECTIONS = new Set<DataConnectionType>([...SQL_CONNECTIONS, "mongodb", "elasticsearch", "influxdb", "prometheus"]);

export const JSON_QUERY_CONNECTORS = new Set<DataConnectionType>(["mongodb", "elasticsearch"]);

export const QUERY_CONNECTORS = new Set<DataConnectionType>([...SQL_CONNECTIONS, ...JSON_QUERY_CONNECTORS, "influxdb", "prometheus", "http"]);

export const FILE_CONNECTORS = new Set<DataConnectionType>(["csv", "excel"]);

export const CONNECTOR_REQUIRED = new Set<DataConnectionType>();

export const WRITABLE_CONNECTIONS = new Set<DataConnectionType>(["bacnet", "s7", "ethernet-ip", "serial", "simulation"]);

export function DatasetPreview({ locale, preview, datasetName }: { locale: AppLocale; preview?: DataDatasetPreview; datasetName?: string }) {
  if (!preview)
    return (
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
  return (
    <div className="data-preview-table">
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
          {preview.rows.slice(0, 20).map((row, index) => (
            <tr key={index}>
              {preview.fields.map((field) => (
                <td key={field.key}>{formatCell(row[field.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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

export function formatCell(value: unknown) {
  if (value === null || value === undefined) return "—";
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
