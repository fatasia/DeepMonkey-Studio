import type { DataConnectionRecord, DataConnectorDiagnostics, DataDatasetField, DataDatasetPreview, DataDatasetRecord } from "@bim-studio/contracts";
import net from "node:net";
import mysql from "mysql2/promise";
import oracledb from "oracledb";
import type { AppConfig } from "./config.js";
import {
  applyComputedFields,
  boundedInteger,
  connectionPassword,
  connectorUrl,
  dataConnectionErrorMessage,
  inferFields,
  isRetryablePreviewError,
  normalizeProtocolValue,
  normalizeRow,
  parseRows,
  readonlyQuery,
  requiredSource,
  runPostgres,
  sampleTimeout,
  selectHttpRows,
} from "./dataIntegrationHelpers.js";
import {
  previewAmqp,
  previewClickHouse,
  previewCoap,
  previewCsv,
  previewElasticsearch,
  previewExcel,
  previewInfluxDb,
  previewKafka,
  previewMongoDb,
  previewMqtt,
  previewPrometheus,
  previewSimulation,
  previewSnmp,
  previewSqlServer,
  previewTcp,
  previewUdp,
  previewWebSocket,
} from "./dataIntegrationPreviewAdapters.js";
// 保持历史 API 导出稳定，数据计算工具的实现已移到独立模块。
export { applyComputedFields, inferFieldType } from "./dataIntegrationHelpers.js";

const MYSQL_PROTOCOL_CONNECTORS = new Set<DataConnectionRecord["type"]>(["mysql", "mariadb", "tidb", "doris", "starrocks"]);

export const BUILT_IN_DATA_CONNECTORS = new Set<DataConnectionRecord["type"]>([
  "postgresql",
  ...MYSQL_PROTOCOL_CONNECTORS,
  "sqlserver",
  "oracle",
  "tdengine",
  "clickhouse",
  "mongodb",
  "elasticsearch",
  "influxdb",
  "prometheus",
  "csv",
  "excel",
  "http",
  "websocket",
  "mqtt",
  "kafka",
  "amqp",
  "opcua",
  "modbus",
  "snmp",
  "tcp",
  "udp",
  "coap",
  "bacnet",
  "s7",
  "ethernet-ip",
  "serial",
  "simulation",
]);
export function hasBuiltInDataConnector(type: DataConnectionRecord["type"]): boolean {
  return BUILT_IN_DATA_CONNECTORS.has(type);
}
export const WRITABLE_DATA_CONNECTORS = new Set<DataConnectionRecord["type"]>(["bacnet", "s7", "ethernet-ip", "serial", "simulation"]);
export function hasWritableDataConnector(type: DataConnectionRecord["type"]): boolean {
  return WRITABLE_DATA_CONNECTORS.has(type);
}
const connectorDiagnostics = new Map<string, DataConnectorDiagnostics>();

export function listConnectorDiagnostics(projectId: string): DataConnectorDiagnostics[] {
  return [...connectorDiagnostics.values()].filter((item) => item.projectId === projectId).map((item) => structuredClone(item));
}

function diagnosticsFor(connection: DataConnectionRecord): DataConnectorDiagnostics {
  const existing = connectorDiagnostics.get(connection.id);
  if (existing) return existing;
  const created: DataConnectorDiagnostics = {
    connectionId: connection.id,
    projectId: connection.projectId,
    type: connection.type,
    status: "idle",
    totalReads: 0,
    totalWrites: 0,
    totalFailures: 0,
    consecutiveFailures: 0,
    reconnects: 0,
  };
  connectorDiagnostics.set(connection.id, created);
  return created;
}

function recordConnectorSuccess(connection: DataConnectionRecord, operation: "read" | "write", latencyMs: number, reconnects = 0): void {
  const state = diagnosticsFor(connection);
  if (operation === "read") state.totalReads += 1;
  else state.totalWrites += 1;
  state.status = reconnects > 0 ? "degraded" : "healthy";
  state.consecutiveFailures = 0;
  state.reconnects += reconnects;
  state.lastLatencyMs = Math.round(latencyMs);
  state.lastSuccessAt = new Date().toISOString();
  delete state.lastError;
}

function recordConnectorFailure(connection: DataConnectionRecord, error: unknown, latencyMs: number): void {
  const state = diagnosticsFor(connection);
  state.status = "offline";
  state.totalFailures += 1;
  state.consecutiveFailures += 1;
  state.lastLatencyMs = Math.round(latencyMs);
  state.lastFailureAt = new Date().toISOString();
  state.lastError = dataConnectionErrorMessage(error, connection.type);
}

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
  const retryAttempts = boundedInteger(connection.config.retryAttempts ?? 0, 0, 10, "连接重试次数");
  const configuredRetryDelay = Number(connection.config.retryDelayMs ?? 250);
  const retryDelayMs = Number.isFinite(configuredRetryDelay) ? Math.min(10_000, Math.max(100, configuredRetryDelay)) : 250;
  const retryMaxDelayMs = Math.max(retryDelayMs, finiteBetween(connection.config.retryMaxDelayMs, 10_000, 100, 60_000));
  const retryMultiplier = finiteBetween(connection.config.retryMultiplier, 2, 1, 5);
  const retryJitter = finiteBetween(connection.config.retryJitter, 0.15, 0, 0.5);
  let rows: Array<Record<string, unknown>> | undefined;
  let lastError: unknown;
  let reconnects = 0;
  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    try {
      rows = await previewDatasetAttempt(config, connection, dataset);
      break;
    } catch (error) {
      lastError = error;
      if (attempt >= retryAttempts || !isRetryablePreviewError(error)) {
        recordConnectorFailure(connection, error, performance.now() - startedAt);
        throw error;
      }
      reconnects += 1;
      const exponentialDelay = Math.min(retryMaxDelayMs, retryDelayMs * retryMultiplier ** attempt);
      const jitteredDelay = exponentialDelay * (1 + (Math.random() * 2 - 1) * retryJitter);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, jitteredDelay)));
    }
  }
  if (!rows) {
    const error = lastError instanceof Error ? lastError : new Error("数据连接预览失败");
    recordConnectorFailure(connection, error, performance.now() - startedAt);
    throw error;
  }
  rows = await applyComputedFields(rows, dataset);
  const inferredFields = inferFields(rows);
  const sourceFields = inferredFields.map((field) => {
    const saved = dataset.fields.find((candidate) => candidate.key === field.key);
    return saved ? { ...field, label: saved.label || field.label, ...(saved.unit ? { unit: saved.unit } : {}) } : field;
  });
  const computedFields = (dataset.computedFields ?? []).map(({ key, label, type }) => ({ key, label, type }));
  const fields = [...sourceFields.filter((field) => !computedFields.some((computed) => computed.key === field.key)), ...computedFields];
  const durationMs = performance.now() - startedAt;
  recordConnectorSuccess(connection, "read", durationMs, reconnects);
  return { dataset: { ...dataset, fields }, fields, rows: rows.slice(0, 100), durationMs };
}

function finiteBetween(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

async function previewDatasetAttempt(config: AppConfig, connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  let rows: Array<Record<string, unknown>>;
  if (connection.type === "postgresql") rows = await previewPostgres(config, connection, dataset);
  else if (MYSQL_PROTOCOL_CONNECTORS.has(connection.type)) rows = await previewMysql(connection, dataset);
  else if (connection.type === "sqlserver") rows = await previewSqlServer(connection, dataset);
  else if (connection.type === "oracle") rows = await previewOracle(connection, dataset);
  else if (connection.type === "tdengine") rows = await previewTdengine(connection, dataset);
  else if (connection.type === "clickhouse") rows = await previewClickHouse(connection, dataset);
  else if (connection.type === "mongodb") rows = await previewMongoDb(connection, dataset);
  else if (connection.type === "elasticsearch") rows = await previewElasticsearch(connection, dataset);
  else if (connection.type === "influxdb") rows = await previewInfluxDb(connection, dataset);
  else if (connection.type === "prometheus") rows = await previewPrometheus(connection, dataset);
  else if (connection.type === "csv") rows = await previewCsv(connection);
  else if (connection.type === "excel") rows = await previewExcel(connection, dataset);
  else if (connection.type === "amqp") rows = await previewAmqp(connection, dataset);
  else if (connection.type === "snmp") rows = await previewSnmp(connection, dataset);
  else if (connection.type === "tcp") rows = await previewTcp(connection, dataset);
  else if (connection.type === "udp") rows = await previewUdp(connection, dataset);
  else if (connection.type === "coap") rows = await previewCoap(connection, dataset);
  else if (connection.type === "simulation") rows = previewSimulation(connection, dataset);
  else if (connection.type === "http") rows = await previewHttp(config, connection, dataset);
  else if (connection.type === "websocket") rows = await previewWebSocket(connection, dataset);
  else if (connection.type === "mqtt") rows = await previewMqtt(connection, dataset);
  else if (connection.type === "kafka") rows = await previewKafka(connection, dataset);
  else if (connection.type === "opcua") rows = await previewOpcUa(connection, dataset);
  else if (connection.type === "modbus") rows = await previewModbus(connection, dataset);
  else if (connection.type === "bacnet") rows = await previewBacnet(connection, dataset);
  else if (connection.type === "s7") rows = await previewS7(connection, dataset);
  else if (connection.type === "ethernet-ip") rows = await previewEthernetIp(connection, dataset);
  else if (connection.type === "serial") rows = await previewSerial(connection, dataset);
  else throw new Error(`当前预览器暂不支持 ${connection.type}；请安装对应连接器插件`);
  return rows;
}

export async function demoSensorRows(config: AppConfig): Promise<Array<Record<string, unknown>>> {
  const output = await runPostgres(
    config.metadata.postgres,
    `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text FROM (SELECT recorded_at, device_id, temperature, pressure, running FROM bim_studio_demo_metrics ORDER BY recorded_at DESC LIMIT 30) t;`,
    true,
  );
  return parseRows(output);
}

async function previewPostgres(config: AppConfig, connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const query = readonlyQuery(dataset);
  const wrapped = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text FROM (${query.replace(/;+\s*$/, "")}) t;`;
  const passwordEnv = String(connection.config.passwordEnv || "POSTGRES_PASSWORD");
  // 内置示例始终跟随当前运行时数据库配置；历史项目里的默认用户名不能让首次体验失效。
  const postgres = connection.id === "example-postgresql"
    ? config.metadata.postgres
    : {
        host: String(connection.config.host || config.metadata.postgres.host),
        port: Number(connection.config.port || config.metadata.postgres.port),
        database: String(connection.config.database || config.metadata.postgres.database),
        user: String(connection.config.user || config.metadata.postgres.user),
        password: process.env[passwordEnv] ?? config.metadata.postgres.password,
        psqlPath: config.metadata.postgres.psqlPath,
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
    dateStrings: true,
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
  const client = await oracledb.getConnection({
    user: String(connection.config.user || ""),
    password: connectionPassword(connection, "ORACLE_PASSWORD"),
    connectString: `${host}:${port}/${serviceName}`,
  });
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
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8", authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` },
    body: readonlyQuery(dataset),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`TDengine HTTP ${response.status} ${response.statusText}`);
  const result = (await response.json()) as { code?: number; desc?: string; column_meta?: Array<[string, string, number]>; data?: unknown[][] };
  if (result.code && result.code !== 0) throw new Error(result.desc || `TDengine 查询失败：${result.code}`);
  const columns = result.column_meta?.map((column) => column[0]) ?? [];
  return (result.data ?? []).slice(0, 100).map((values) => Object.fromEntries(columns.map((column, index) => [column, values[index]])));
}

async function previewHttp(config: AppConfig, connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const configuredUrl = String(connection.config.url || "").trim();
  if (!configuredUrl) throw new Error("HTTP 连接缺少 URL");
  if (configuredUrl === "/api/demo/sensors") return selectHttpRows({ items: await demoSensorRows(config) }, dataset.sourceKey);
  const url = configuredUrl.startsWith("/") ? `http://127.0.0.1:${config.port}${configuredUrl}` : configuredUrl;
  const method = String(connection.config.method || "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new Error("HTTP 数据连接只允许 GET 或 POST");
  const headers = httpConnectionHeaders(connection);
  let body = method === "POST" ? dataset.query?.trim() : undefined;
  if (body) {
    try { body = JSON.stringify(JSON.parse(body) as unknown); }
    catch { throw new Error("HTTP POST 数据集的请求体必须是合法 JSON"); }
  }
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(sampleTimeout(connection)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return selectHttpRows(await response.json(), dataset.sourceKey);
}

function httpConnectionHeaders(connection: DataConnectionRecord): Record<string, string> {
  const authMode = String(connection.config.authMode || "none");
  if (authMode === "none") return {};
  const secret = connectionPassword(connection, "HTTP_API_TOKEN");
  if (authMode === "bearer") return { authorization: `Bearer ${secret}` };
  if (authMode === "basic") {
    const user = String(connection.config.user || "").trim();
    if (!user) throw new Error("HTTP Basic 鉴权缺少用户");
    return { authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}` };
  }
  if (authMode === "api-key") {
    const headerName = String(connection.config.headerName || "x-api-key").trim().toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(headerName)) throw new Error("HTTP API Key 请求头名称无效");
    return { [headerName]: secret };
  }
  throw new Error(`不支持的 HTTP 鉴权方式：${authMode}`);
}

async function previewOpcUa(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const { OPCUAClient, AttributeIds, MessageSecurityMode, SecurityPolicy, UserTokenType } = await import("node-opcua-client");
  const endpoint = connectorUrl(connection, ["opc.tcp:"]).toString();
  const nodeIds = requiredSource(dataset, "OPC UA NodeId")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const client = OPCUAClient.create({
    endpointMustExist: false,
    connectionStrategy: { initialDelay: 250, maxDelay: 1_000, maxRetry: 1 },
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
  });
  try {
    await client.connect(endpoint);
    const session = await client.createSession(
      connection.config.user ? { type: UserTokenType.UserName, userName: String(connection.config.user), password: connectionPassword(connection, "OPCUA_PASSWORD") } : undefined,
    );
    try {
      const values = await session.read(nodeIds.map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value })));
      return nodeIds.map((nodeId, index) => ({
        nodeId,
        value: normalizeProtocolValue(values[index]?.value.value),
        status: values[index]?.statusCode.name ?? "Unknown",
        sourceTimestamp: values[index]?.sourceTimestamp?.toISOString() ?? null,
      }));
    } finally {
      await session.close();
    }
  } finally {
    await client.disconnect();
  }
}

async function previewModbus(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const { client } = await import("jsmodbus");
  const url = connectorUrl(connection, ["modbus:", "modbus+tcp:", "tcp:"]);
  const [kind = "holding", addressText = "0", quantityText = "1"] = requiredSource(dataset, "Modbus 地址（例如 holding:0:10）").split(":");
  const address = boundedInteger(addressText, 0, 65_535, "Modbus 起始地址");
  const quantity = boundedInteger(quantityText, 1, 125, "Modbus 数量");
  const socket = new net.Socket();
  const modbus = new client.TCP(socket, boundedInteger(connection.config.unitId ?? 1, 0, 255, "Modbus Unit ID"), sampleTimeout(connection));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.setTimeout(sampleTimeout(connection), () => reject(new Error("Modbus TCP 连接超时")));
      socket.connect(Number(url.port || 502), url.hostname);
    });
    const response =
      kind === "input"
        ? await modbus.readInputRegisters(address, quantity)
        : kind === "coil"
          ? await modbus.readCoils(address, quantity)
          : kind === "discrete"
            ? await modbus.readDiscreteInputs(address, quantity)
            : await modbus.readHoldingRegisters(address, quantity);
    const body = response.response.body as unknown as { valuesAsArray?: Array<number | boolean> };
    return (body.valuesAsArray ?? []).map((value, index) => ({ address: address + index, value, kind, unitId: modbus.unitId }));
  } finally {
    socket.destroy();
  }
}

/** Read one or more BACnet properties. sourceKey: objectType,instance,propertyId[,arrayIndex]. */
async function previewBacnet(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const endpoint = connectorUrl(connection, ["bacnet:"]);
  const entries = requiredSource(dataset, "BACnet 属性（objectType,instance,propertyId）")
    .split(/[;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const bacnetModule = (await import("bacstack")) as unknown as { default?: new (options?: Record<string, unknown>) => any; enum?: Record<string, unknown> };
  const Bacnet = bacnetModule.default ?? (bacnetModule as unknown as new (options?: Record<string, unknown>) => any);
  const client = new Bacnet({ port: Number(connection.config.localPort || 47808), apduTimeout: sampleTimeout(connection) });
  const target = endpoint.port ? `${endpoint.hostname}:${endpoint.port}` : endpoint.hostname;
  try {
    const rows: Array<Record<string, unknown>> = [];
    for (const entry of entries.slice(0, 100)) {
      const [typeText, instanceText, propertyText, arrayIndexText] = entry.split(/[,:]/).map((value) => value.trim());
      const type = boundedInteger(typeText, 0, 255, "BACnet objectType");
      const instance = boundedInteger(instanceText, 0, 4_194_303, "BACnet instance");
      const propertyId = boundedInteger(propertyText, 0, 255, "BACnet propertyId");
      const arrayIndex = arrayIndexText === undefined || arrayIndexText === "" ? undefined : boundedInteger(arrayIndexText, 0, 4_294_967_295, "BACnet arrayIndex");
      const result = await new Promise<any>((resolve, reject) =>
        client.readProperty(target, { type, instance }, propertyId, arrayIndex === undefined ? {} : { arrayIndex }, (error: unknown, value: unknown) =>
          error ? reject(error) : resolve(value),
        ),
      );
      const rawValue = result?.values ?? result?.value ?? result;
      rows.push({ objectType: type, instance, propertyId, ...(arrayIndex === undefined ? {} : { arrayIndex }), value: normalizeProtocolValue(rawValue) });
    }
    return rows;
  } finally {
    client.close();
  }
}

/** Read S7 PLC items. sourceKey is a semicolon/newline separated list such as DB1,REAL0 or M0. */
async function previewS7(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const endpoint = connectorUrl(connection, ["s7:"]);
  const items = requiredSource(dataset, "S7 地址")
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 100);
  const module = (await import("nodes7")) as unknown as { default?: new () => any };
  const Plc = module.default ?? (module as unknown as new () => any);
  const plc = new Plc();
  const params = {
    host: endpoint.hostname,
    port: Number(endpoint.port || 102),
    rack: Number(endpoint.searchParams.get("rack") || connection.config.rack || 0),
    slot: Number(endpoint.searchParams.get("slot") || connection.config.slot || 2),
    timeout: sampleTimeout(connection),
  };
  try {
    await new Promise<void>((resolve, reject) => plc.initiateConnection(params, (error: unknown) => (error ? reject(error) : resolve())));
    plc.addItems(items);
    const values = await new Promise<Record<string, unknown>>((resolve, reject) =>
      plc.readAllItems((error: unknown, data: unknown) => (error ? reject(error) : resolve((data ?? {}) as Record<string, unknown>))),
    );
    return items.map((address) => ({ address, value: normalizeProtocolValue(values[address]) }));
  } finally {
    await new Promise<void>((resolve) => plc.dropConnection?.(() => resolve()));
  }
}

/** Read Allen-Bradley tags over EtherNet/IP. sourceKey is a comma/newline separated tag list. */
async function previewEthernetIp(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const endpoint = connectorUrl(connection, ["eip:", "ethernet-ip:", "ethernetip:"]);
  const tags = requiredSource(dataset, "EtherNet/IP Tag")
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 100);
  const module = (await import("st-ethernet-ip")) as unknown as { Controller: new () => any; Tag: new (...args: any[]) => any };
  const controller = new module.Controller();
  try {
    await controller.connect(endpoint.hostname, Number(endpoint.searchParams.get("slot") || connection.config.slot || 0));
    const rows: Array<Record<string, unknown>> = [];
    for (const name of tags) {
      const tag = new module.Tag(name);
      await controller.readTag(tag);
      rows.push({ tag: name, value: normalizeProtocolValue(tag.value) });
    }
    return rows;
  } finally {
    const disconnectResult = controller.disconnect?.();
    if (disconnectResult && typeof disconnectResult.then === "function") await disconnectResult.catch(() => undefined);
  }
}

/** Sample a serial port. The first received frame is returned as text/JSON or base64. */
async function previewSerial(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const endpoint = connectorUrl(connection, ["serial:"]);
  const { SerialPort } = await import("serialport");
  const portPath = decodeURIComponent(endpoint.hostname || endpoint.pathname.replace(/^\//, ""));
  if (!portPath) throw new Error("串口连接必须指定端口，例如 serial://COM3");
  const baudRate = boundedInteger(endpoint.searchParams.get("baudRate") || connection.config.baudRate || 9_600, 1, 4_000_000, "串口波特率");
  const dataBits = boundedInteger(endpoint.searchParams.get("dataBits") || connection.config.dataBits || 8, 5, 8, "串口数据位") as 5 | 6 | 7 | 8;
  const stopBits = Number(endpoint.searchParams.get("stopBits") || connection.config.stopBits || 1) as 1 | 1.5 | 2;
  if (![1, 1.5, 2].includes(stopBits)) throw new Error("串口停止位必须是 1、1.5 或 2");
  const port = new SerialPort({
    path: portPath,
    baudRate,
    dataBits,
    stopBits,
    parity: (endpoint.searchParams.get("parity") || connection.config.parity || "none") as "none" | "even" | "mark" | "odd" | "space",
    autoOpen: false,
  });
  try {
    await new Promise<void>((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())));
    const frame = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("串口采样窗口内没有收到数据")), sampleTimeout(connection));
      port.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      port.once("data", (data: Buffer) => {
        clearTimeout(timer);
        resolve(Buffer.from(data));
      });
    });
    const text = frame.toString("utf8").trim();
    let value: unknown = text;
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        /* binary/text payload */
      }
    }
    return [{ port: portPath, value: typeof value === "string" && !text ? frame.toString("base64") : normalizeProtocolValue(value), bytes: frame.length }];
  } finally {
    await new Promise<void>((resolve) => port.close(() => resolve()));
  }
}

export interface DataPointWriteRequest {
  address: string;
  value: unknown;
  propertyId?: number;
  priority?: number;
}

/**
 * Write one point through a configured industrial connector. This is the
 * server-side counterpart to scene scripts' data.write permission; callers
 * should still enforce project/user authorization before invoking it.
 */
export async function writeDataPoint(connection: DataConnectionRecord, request: DataPointWriteRequest): Promise<{ address: string; value: unknown; writtenAt: string }> {
  const startedAt = performance.now();
  const address = request.address?.trim();
  if (!address) throw new Error("写入地址不能为空");
  try {
    if (connection.type === "bacnet") await writeBacnet(connection, address, request);
    else if (connection.type === "s7") await writeS7(connection, address, request.value);
    else if (connection.type === "ethernet-ip") await writeEthernetIp(connection, address, request.value);
    else if (connection.type === "serial") await writeSerial(connection, address, request.value);
    else if (connection.type !== "simulation") throw new Error(`${connection.type} 当前不支持安全点位写入`);
    recordConnectorSuccess(connection, "write", performance.now() - startedAt);
    return { address, value: normalizeProtocolValue(request.value), writtenAt: new Date().toISOString() };
  } catch (error) {
    recordConnectorFailure(connection, error, performance.now() - startedAt);
    throw error;
  }
}

async function writeBacnet(connection: DataConnectionRecord, address: string, request: DataPointWriteRequest): Promise<void> {
  const endpoint = connectorUrl(connection, ["bacnet:"]);
  const [typeText, instanceText, propertyText] = address.split(/[,:]/).map((value) => value.trim());
  const type = boundedInteger(typeText, 0, 255, "BACnet objectType");
  const instance = boundedInteger(instanceText, 0, 4_194_303, "BACnet instance");
  const propertyId = request.propertyId ?? boundedInteger(propertyText, 0, 255, "BACnet propertyId");
  const bacnetModule = (await import("bacstack")) as unknown as { default?: new (options?: Record<string, unknown>) => any; enum?: { ApplicationTags?: Record<string, number> } };
  const Bacnet = bacnetModule.default ?? (bacnetModule as unknown as new (options?: Record<string, unknown>) => any);
  const client = new Bacnet({ port: Number(connection.config.localPort || 47808), apduTimeout: sampleTimeout(connection) });
  const target = endpoint.port ? `${endpoint.hostname}:${endpoint.port}` : endpoint.hostname;
  const tags = bacnetModule.enum?.ApplicationTags ?? {};
  const tag =
    typeof request.value === "boolean"
      ? (tags.BOOLEAN ?? 1)
      : typeof request.value === "number"
        ? Number.isInteger(request.value)
          ? (tags.SIGNED_INTEGER ?? 3)
          : (tags.REAL ?? 4)
        : (tags.CHARACTER_STRING ?? 7);
  try {
    await new Promise<void>((resolve, reject) =>
      client.writeProperty(
        target,
        { type, instance },
        propertyId,
        [{ type: tag, value: request.value }],
        { ...(request.priority ? { priority: boundedInteger(request.priority, 1, 16, "BACnet 优先级") } : {}) },
        (error: unknown) => (error ? reject(error) : resolve()),
      ),
    );
  } finally {
    client.close();
  }
}

async function writeS7(connection: DataConnectionRecord, address: string, value: unknown): Promise<void> {
  const endpoint = connectorUrl(connection, ["s7:"]);
  const module = (await import("nodes7")) as unknown as { default?: new () => any };
  const Plc = module.default ?? (module as unknown as new () => any);
  const plc = new Plc();
  try {
    await new Promise<void>((resolve, reject) =>
      plc.initiateConnection(
        {
          host: endpoint.hostname,
          port: Number(endpoint.port || 102),
          rack: Number(endpoint.searchParams.get("rack") || connection.config.rack || 0),
          slot: Number(endpoint.searchParams.get("slot") || connection.config.slot || 2),
          timeout: sampleTimeout(connection),
        },
        (error: unknown) => (error ? reject(error) : resolve()),
      ),
    );
    await new Promise<void>((resolve, reject) => {
      const result = plc.writeItems(address, value, (error: unknown) => (error ? reject(error) : resolve()));
      if (result === 1) reject(new Error("S7 上一条写入仍在队列中"));
    });
  } finally {
    await new Promise<void>((resolve) => plc.dropConnection?.(() => resolve()));
  }
}

async function writeEthernetIp(connection: DataConnectionRecord, address: string, value: unknown): Promise<void> {
  const endpoint = connectorUrl(connection, ["eip:", "ethernet-ip:", "ethernetip:"]);
  const module = (await import("st-ethernet-ip")) as unknown as { Controller: new () => any; Tag: new (...args: any[]) => any };
  const controller = new module.Controller();
  try {
    await controller.connect(endpoint.hostname, Number(endpoint.searchParams.get("slot") || connection.config.slot || 0));
    await controller.writeTag(new module.Tag(address), value);
  } finally {
    const result = controller.disconnect?.();
    if (result && typeof result.then === "function") await result.catch(() => undefined);
  }
}

async function writeSerial(connection: DataConnectionRecord, address: string, value: unknown): Promise<void> {
  const endpoint = connectorUrl(connection, ["serial:"]);
  const { SerialPort } = await import("serialport");
  const portPath = decodeURIComponent(endpoint.hostname || endpoint.pathname.replace(/^\//, ""));
  if (!portPath) throw new Error("串口连接必须指定端口");
  const baudRate = boundedInteger(endpoint.searchParams.get("baudRate") || connection.config.baudRate || 9_600, 1, 4_000_000, "串口波特率");
  const payload = address === "raw" ? (typeof value === "string" ? value : JSON.stringify(value)) : JSON.stringify({ address, value });
  const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });
  try {
    await new Promise<void>((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) =>
      port.write(payload, (error) => (error ? reject(error) : port.drain((drainError) => (drainError ? reject(drainError) : resolve())))),
    );
  } finally {
    await new Promise<void>((resolve) => port.close(() => resolve()));
  }
}
