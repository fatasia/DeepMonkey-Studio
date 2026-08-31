import type { DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { MongoClient } from "mongodb";
import { parse as parseCsv } from "csv-parse/sync";
import * as XLSX from "xlsx";
import * as amqp from "amqplib";
import * as snmp from "net-snmp";
import * as coap from "coap";
import {
  boundedInteger,
  connectionPassword,
  connectorUrl,
  kafkaBrokers,
  messageRow,
  normalizeRow,
  parseJsonObjectQuery,
  parseScalar,
  readonlyFluxQuery,
  readonlyPromQlQuery,
  readonlyQuery,
  requiredSource,
  sampleTimeout,
  selectHttpRows,
  selectMessageRows,
  waitForRows
} from "./dataIntegrationHelpers.js";

/** 数据源与消息系统的预览适配器。编排、重试和诊断由 dataIntegration.ts 统一负责。 */

export async function previewClickHouse(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const host = String(connection.config.host || "127.0.0.1");
  const port = Number(connection.config.port || 8123);
  const protocol = connection.config.secure === true ? "https" : "http";
  const endpoint = new URL(`${protocol}://${host}:${port}/`);
  const database = String(connection.config.database || "default").trim();
  if (database) endpoint.searchParams.set("database", database);
  endpoint.searchParams.set("default_format", "JSONEachRow");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-clickhouse-user": String(connection.config.user || "default"),
      "x-clickhouse-key": connectionPassword(connection, "CLICKHOUSE_PASSWORD")
    },
    body: readonlyQuery(dataset),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`ClickHouse HTTP ${response.status}: ${(await response.text()).trim() || response.statusText}`);
  const body = await response.text();
  return body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 100).map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ClickHouse 返回了非对象行");
    return normalizeRow(parsed as Record<string, unknown>);
  });
}

export async function previewMongoDb(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const host = String(connection.config.host || "127.0.0.1");
  const port = Number(connection.config.port || 27017);
  const database = String(connection.config.database || "").trim();
  const collection = String(dataset.sourceKey || "").trim();
  if (!database) throw new Error("MongoDB 连接缺少数据库名称");
  if (!collection) throw new Error("MongoDB 数据集缺少集合名称");
  const user = String(connection.config.user || "").trim();
  const isSrv = connection.config.secure === true;
  const endpoint = isSrv ? `mongodb+srv://${host}/${encodeURIComponent(database)}` : `mongodb://${host}:${port}/${encodeURIComponent(database)}`;
  const client = new MongoClient(endpoint, {
    ...(user ? { auth: { username: user, password: connectionPassword(connection, "MONGODB_PASSWORD") } } : {}),
    authSource: String(connection.config.authSource || database),
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
    tls: isSrv
  });
  try {
    await client.connect();
    const filter = parseJsonObjectQuery(dataset.query, "MongoDB 过滤条件");
    const rows = await client.db(database).collection(collection).find(filter).limit(100).toArray();
    return rows.map((row) => normalizeRow({ ...row, _id: String(row._id) }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function previewElasticsearch(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const host = String(connection.config.host || "127.0.0.1");
  const port = Number(connection.config.port || 9200);
  const index = String(dataset.sourceKey || "").trim();
  if (!index) throw new Error("Elasticsearch 数据集缺少索引名称");
  const protocol = connection.config.secure === true ? "https" : "http";
  const endpoint = new URL(`${protocol}://${host}:${port}/${encodeURIComponent(index)}/_search`);
  const user = String(connection.config.user || "").trim();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.authorization = `Basic ${Buffer.from(`${user}:${connectionPassword(connection, "ELASTICSEARCH_PASSWORD")}`).toString("base64")}`;
  const query = parseJsonObjectQuery(dataset.query, "Elasticsearch 查询");
  const requestedSize = typeof query.size === "number" && Number.isFinite(query.size) ? query.size : 100;
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...query, size: Math.min(Math.max(1, requestedSize), 100) }), signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Elasticsearch HTTP ${response.status}: ${(await response.text()).trim() || response.statusText}`);
  const result = await response.json() as { hits?: { hits?: Array<{ _id?: string; _index?: string; _score?: number; _source?: Record<string, unknown> }> } };
  return (result.hits?.hits ?? []).map((hit) => normalizeRow({ _id: hit._id ?? "", _index: hit._index ?? "", _score: hit._score ?? null, ...(hit._source ?? {}) }));
}

export async function previewInfluxDb(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const host = String(connection.config.host || "127.0.0.1");
  const port = Number(connection.config.port || 8086);
  const organization = String(connection.config.database || "").trim();
  if (!organization) throw new Error("InfluxDB 连接缺少组织名称");
  const protocol = connection.config.secure === true ? "https" : "http";
  const endpoint = new URL(`${protocol}://${host}:${port}/api/v2/query`);
  endpoint.searchParams.set("org", organization);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Token ${connectionPassword(connection, "INFLUXDB_TOKEN")}`, accept: "text/csv", "content-type": "application/vnd.flux" },
    body: readonlyFluxQuery(dataset.query),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`InfluxDB HTTP ${response.status}: ${(await response.text()).trim() || response.statusText}`);
  const rows = parseCsv(await response.text(), { columns: true, comment: "#", skip_empty_lines: true, relax_column_count: true, bom: true }) as Array<Record<string, string>>;
  return rows.slice(0, 100).map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "").map(([key, value]) => [key, parseScalar(value)])));
}

export async function previewPrometheus(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const host = String(connection.config.host || "127.0.0.1");
  const port = Number(connection.config.port || 9090);
  const protocol = connection.config.secure === true ? "https" : "http";
  const endpoint = new URL(`${protocol}://${host}:${port}/api/v1/query`);
  endpoint.searchParams.set("query", readonlyPromQlQuery(dataset.query));
  const user = String(connection.config.user || "").trim();
  const headers: Record<string, string> = {};
  if (user) headers.authorization = `Basic ${Buffer.from(`${user}:${connectionPassword(connection, "PROMETHEUS_PASSWORD")}`).toString("base64")}`;
  const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Prometheus HTTP ${response.status}: ${(await response.text()).trim() || response.statusText}`);
  const result = await response.json() as { status?: string; error?: string; data?: { resultType?: string; result?: Array<{ metric?: Record<string, string>; value?: [number, string]; values?: Array<[number, string]> }> } };
  if (result.status !== "success") throw new Error(result.error || "Prometheus 查询失败");
  return (result.data?.result ?? []).flatMap((series) => {
    const metric = series.metric ?? {};
    if (series.values) return series.values.slice(0, 100).map(([timestamp, value]) => ({ ...metric, timestamp: new Date(timestamp * 1000).toISOString(), value: parseScalar(value) }));
    if (series.value) return [{ ...metric, timestamp: new Date(series.value[0] * 1000).toISOString(), value: parseScalar(series.value[1]) }];
    return [];
  }).slice(0, 100);
}

export async function previewCsv(connection: DataConnectionRecord): Promise<Array<Record<string, unknown>>> {
  const response = await fetchExternalFile(connection, "CSV");
  const rows = parseCsv(await response.text(), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }) as Array<Record<string, string>>;
  return rows.slice(0, 100).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, parseScalar(value)])));
}

export async function previewExcel(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const response = await fetchExternalFile(connection, "Excel");
  const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: "buffer", cellDates: true });
  const sheetName = String(dataset.sourceKey || "").trim() || workbook.SheetNames[0];
  if (!sheetName || !workbook.Sheets[sheetName]) throw new Error(`Excel 找不到工作表“${sheetName || "(空)"}”`);
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: null, raw: false }).slice(0, 100).map(normalizeRow);
}

export async function previewAmqp(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const configuredUrl = String(connection.config.url || "").trim();
  const queue = String(dataset.sourceKey || "").trim();
  if (!configuredUrl) throw new Error("AMQP 连接缺少 Broker URL");
  if (!queue) throw new Error("AMQP 数据集缺少队列名称");
  const endpoint = new URL(configuredUrl);
  const user = String(connection.config.user || "").trim();
  if (user) {
    endpoint.username = user;
    endpoint.password = connectionPassword(connection, "AMQP_PASSWORD");
  }
  const client = await amqp.connect(endpoint.toString(), { timeout: 8_000 });
  let channel: amqp.Channel | undefined;
  try {
    channel = await client.createChannel();
    const message = await channel.get(queue, { noAck: false });
    if (!message) return [];
    try {
      const raw = message.content.toString("utf8").trim();
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return [parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed }];
    } catch {
      return [{ value: message.content.toString("utf8") }];
    } finally {
      channel.nack(message, false, true);
    }
  } finally {
    await channel?.close().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

export async function previewSnmp(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const configuredUrl = String(connection.config.url || "").trim();
  const oid = String(dataset.sourceKey || "").trim();
  if (!configuredUrl) throw new Error("SNMP 连接缺少设备地址");
  if (!oid) throw new Error("SNMP 数据集缺少 OID");
  const endpoint = new URL(configuredUrl);
  const host = endpoint.hostname;
  const port = Number(endpoint.port || 161);
  const session = snmp.createSession(host, connectionPassword(connection, "SNMP_COMMUNITY"), { port, timeout: 8_000, retries: 0, version: snmp.Version2c });
  try {
    const variable = await new Promise<snmp.Varbind>((resolve, reject) => session.get([oid], (error, values) => {
      if (error) reject(error);
      else if (!values?.[0]) reject(new Error("SNMP 未返回 OID 值"));
      else resolve(values[0]);
    }));
    if (snmp.isVarbindError(variable)) throw new Error(snmp.varbindError(variable));
    return [{ oid: variable.oid, value: Buffer.isBuffer(variable.value) ? variable.value.toString("utf8") : variable.value, type: variable.type }];
  } finally {
    session.close();
  }
}

export async function previewTcp(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const endpoint = connectorUrl(connection, ["tcp:"]);
  const socket = new net.Socket();
  const rows: Array<Record<string, unknown>> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("TCP 已连接，但采样窗口内没有收到消息")), sampleTimeout(connection));
      socket.once("error", reject);
      socket.on("data", (data) => {
        for (const line of data.toString("utf8").split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) rows.push(messageRow(line, { source: `${endpoint.hostname}:${endpoint.port || "0"}` }));
        if (rows.length) { clearTimeout(timeout); resolve(); }
      });
      socket.connect(Number(endpoint.port || 0), endpoint.hostname);
    });
    return selectMessageRows(rows, dataset.sourceKey);
  } finally {
    socket.destroy();
  }
}

export async function previewUdp(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const { createSocket } = await import("node:dgram");
  const endpoint = connectorUrl(connection, ["udp:"]);
  const port = Number(endpoint.port || 0);
  if (!port) throw new Error("UDP 连接必须指定监听端口");
  const socket = createSocket("udp4");
  const rows: Array<Record<string, unknown>> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("UDP 监听窗口内没有收到消息")), sampleTimeout(connection));
      socket.once("error", reject);
      socket.on("message", (message, remote) => {
        rows.push(messageRow(message.toString("utf8"), { source: `${remote.address}:${remote.port}` }));
        clearTimeout(timeout);
        resolve();
      });
      socket.bind(port, endpoint.hostname === "0.0.0.0" ? undefined : endpoint.hostname);
    });
    return selectMessageRows(rows, dataset.sourceKey);
  } finally {
    socket.close();
  }
}

export function previewSimulation(connection: DataConnectionRecord, dataset: DataDatasetRecord): Array<Record<string, unknown>> {
  const configuredUrl = String(connection.config.url || "sim://telemetry?rows=30&seed=42").trim();
  let endpoint: URL;
  try { endpoint = new URL(configuredUrl); } catch { throw new Error("模拟数据连接缺少有效 sim:// URL"); }
  if (endpoint.protocol !== "sim:") throw new Error("模拟数据连接必须使用 sim:// URL");
  const rows = boundedInteger(endpoint.searchParams.get("rows") || 30, 1, 100, "模拟数据行数");
  const configuredInterval = Number(endpoint.searchParams.get("interval") || 5);
  if (!Number.isFinite(configuredInterval) || configuredInterval <= 0) throw new Error("模拟数据 interval 必须是正数");
  const intervalSeconds = Math.max(0.1, Math.min(86_400, configuredInterval));
  const seed = Number(endpoint.searchParams.get("seed") || 42);
  if (!Number.isFinite(seed)) throw new Error("模拟数据 seed 必须是数字");
  const start = Date.parse(endpoint.searchParams.get("start") || "2026-01-01T00:00:00.000Z");
  if (!Number.isFinite(start)) throw new Error("模拟数据 start 必须是有效时间");
  let state = (Math.trunc(seed) >>> 0) || 1;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  const mode = endpoint.hostname || "telemetry";
  const generated = Array.from({ length: rows }, (_, index) => {
    const wave = Math.sin(index / 3.5) * 2.8;
    const temperature = Number((22 + wave + random() * 1.4).toFixed(2));
    const pressure = Number((101.3 + Math.cos(index / 4.5) * 4 + random() * 0.8).toFixed(2));
    const vibration = Number((0.12 + random() * 0.18 + (mode === "alarm" && index % 9 === 0 ? 0.9 : 0)).toFixed(3));
    return {
      recorded_at: new Date(start + index * intervalSeconds * 1000).toISOString(),
      device_id: `SIM-${String((index % 3) + 1).padStart(2, "0")}`,
      temperature,
      pressure,
      vibration,
      running: mode === "alarm" ? index % 11 !== 0 : index % 7 !== 0,
      quality: mode === "alarm" && index % 9 === 0 ? "alarm" : "good"
    };
  });
  return dataset.sourceKey?.trim() ? selectHttpRows({ items: generated }, dataset.sourceKey) : generated;
}

async function fetchExternalFile(connection: DataConnectionRecord, label: string): Promise<Response> {
  const url = String(connection.config.url || "").trim();
  if (!url) throw new Error(`${label} 连接缺少文件 URL`);
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status} ${response.statusText}`);
  return response;
}

export async function previewSqlServer(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const { default: sql } = await import("mssql");
  const pool = new sql.ConnectionPool({
    server: String(connection.config.host || "127.0.0.1"),
    port: Number(connection.config.port || 1433),
    database: String(connection.config.database || ""),
    user: String(connection.config.user || ""),
    password: connectionPassword(connection, "SQLSERVER_PASSWORD"),
    connectionTimeout: 8_000,
    requestTimeout: 8_000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 5_000 },
    options: {
      encrypt: connection.config.encrypt !== false,
      trustServerCertificate: connection.config.trustServerCertificate === true,
      enableArithAbort: true
    }
  });
  try {
    await pool.connect();
    const result = await pool.request().query(readonlyQuery(dataset));
    return (result.recordset ?? []).slice(0, 100).map((row) => normalizeRow(row as Record<string, unknown>));
  } finally {
    await pool.close().catch(() => undefined);
  }
}

export async function previewCoap(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const endpoint = connectorUrl(connection, ["coap:"]);
  const timeoutMs = sampleTimeout(connection);
  const response = await new Promise<{ code: string; contentFormat?: string; body: Buffer }>((resolve, reject) => {
    const request = coap.request({
      host: endpoint.hostname,
      port: Number(endpoint.port || 5683),
      pathname: endpoint.pathname || "/",
      method: "GET",
      confirmable: true,
      retrySend: 0,
      ...(endpoint.search ? { query: endpoint.search.slice(1) } : {})
    });
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error(`CoAP 请求超时（${timeoutMs}ms）`));
    }, timeoutMs);
    request.once("error", (error) => { clearTimeout(timer); reject(error); });
    request.once("response", (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", (error: unknown) => { clearTimeout(timer); reject(error); });
      incoming.once("end", () => {
        clearTimeout(timer);
        const contentFormat = incoming.headers?.["Content-Format"];
        resolve({ code: String(incoming.code || ""), ...(contentFormat ? { contentFormat: String(contentFormat) } : {}), body: Buffer.concat(chunks) });
      });
    });
    request.end();
  });
  if (!response.code.startsWith("2.")) throw new Error(`CoAP 返回码 ${response.code || "未知"}`);
  const text = response.body.toString("utf8").trim();
  if (!text) return [];
  let payload: unknown = text;
  if (response.contentFormat?.includes("json") || /^[\[{]/.test(text)) {
    try { payload = JSON.parse(text) as unknown; } catch { /* Text payloads are valid CoAP values. */ }
  }
  return selectHttpRows(payload, dataset.sourceKey);
}

export async function previewWebSocket(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const { default: WebSocket } = await import("ws");
  const url = connectorUrl(connection, ["ws:", "wss:"]);
  const rows: Array<Record<string, unknown>> = [];
  const socket = new WebSocket(url, { handshakeTimeout: sampleTimeout(connection) });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => rows.length ? resolve() : reject(new Error("WebSocket 已连接，但采样窗口内没有收到消息")), sampleTimeout(connection));
      socket.once("error", reject);
      socket.on("message", (data) => {
        rows.push(messageRow(data.toString(), { source: url.origin }));
        if (rows.length >= 100) { clearTimeout(timeout); resolve(); }
      });
    });
    return selectMessageRows(rows, dataset.sourceKey);
  } finally { socket.close(); }
}

export async function previewMqtt(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const { connectAsync } = await import("mqtt");
  const url = connectorUrl(connection, ["mqtt:", "mqtts:", "ws:", "wss:"]);
  const topic = requiredSource(dataset, "MQTT Topic");
  const client = await connectAsync(url.toString(), {
    connectTimeout: sampleTimeout(connection),
    clientId: `bim-studio-${randomUUID()}`,
    ...(connection.config.user ? { username: String(connection.config.user) } : {}),
    ...(connection.config.passwordEnv ? { password: connectionPassword(connection, "MQTT_PASSWORD") } : {})
  });
  const rows: Array<Record<string, unknown>> = [];
  try {
    await client.subscribeAsync(topic, { qos: 0 });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => rows.length ? resolve() : reject(new Error("MQTT 已订阅，但采样窗口内没有收到消息")), sampleTimeout(connection));
      client.on("error", reject);
      client.on("message", (messageTopic, payload) => {
        rows.push(messageRow(payload.toString("utf8"), { topic: messageTopic }));
        if (rows.length >= 100) { clearTimeout(timeout); resolve(); }
      });
    });
    return rows;
  } finally { await client.endAsync(); }
}

export async function previewKafka(connection: DataConnectionRecord, dataset: DataDatasetRecord): Promise<Array<Record<string, unknown>>> {
  const { Kafka, logLevel } = await import("kafkajs");
  const brokers = kafkaBrokers(connection);
  const topic = requiredSource(dataset, "Kafka Topic");
  const kafka = new Kafka({
    clientId: `bim-studio-${connection.projectId}`,
    brokers,
    logLevel: logLevel.NOTHING,
    ssl: connection.config.ssl === true,
    ...(connection.config.user && connection.config.passwordEnv ? { sasl: { mechanism: "plain", username: String(connection.config.user), password: connectionPassword(connection, "KAFKA_PASSWORD") } } : {})
  });
  const consumer = kafka.consumer({ groupId: String(connection.config.groupId || `bim-studio-preview-${randomUUID()}`) });
  const rows: Array<Record<string, unknown>> = [];
  try {
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: connection.config.fromBeginning === true });
    await consumer.run({ eachMessage: async ({ topic: messageTopic, partition, message }) => {
      rows.push(messageRow(message.value?.toString("utf8") ?? "", { topic: messageTopic, partition, offset: message.offset, key: message.key?.toString("utf8") ?? null, timestamp: message.timestamp }));
    }});
    await waitForRows(rows, sampleTimeout(connection), "Kafka 已订阅，但采样窗口内没有收到消息");
    return rows.slice(0, 100);
  } finally { await consumer.disconnect().catch(() => undefined); }
}

