import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import dgram from "node:dgram";
import * as coap from "coap";
import * as XLSX from "xlsx";
import type { DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import {
  applyComputedFields,
  hasBuiltInDataConnector,
  hasWritableDataConnector,
  inferFieldType,
  listConnectorDiagnostics,
  previewDataset,
  writeDataPoint,
} from "./dataIntegration.js";
import { dataConnectionErrorMessage, inferFields as inferDatasetFields } from "./dataIntegrationHelpers.js";

afterEach(() => vi.unstubAllGlobals());

const dataset: DataDatasetRecord = {
  id: "dataset:computed",
  projectId: "project:1",
  connectionId: "connection:1",
  name: "设备数据",
  refreshSeconds: 5,
  fields: [],
  computedFields: [
    { id: "field:fahrenheit", key: "fahrenheit", label: "华氏温度", type: "number", formula: "ROUND(temperature * 1.8 + 32, 1)" },
    { id: "field:state", key: "state", label: "运行状态", type: "string", formula: "IF(running, 'RUN', 'STOP')" },
    { id: "field:summary", key: "summary", label: "摘要", type: "string", formula: "CONCAT(device_id, ':', state)" },
  ],
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

describe("computed dataset fields", () => {
  it("discovers sparse fields across the sampled rows instead of trusting only row one", () => {
    expect(inferDatasetFields([{ device: "A", temperature: null }, { device: "B", temperature: 24, alarm: true }])).toEqual([
      { key: "device", label: "device", type: "string" },
      { key: "temperature", label: "temperature", type: "number" },
      { key: "alarm", label: "alarm", type: "boolean" },
    ]);
  });

  it("turns localized PostgreSQL authentication output into actionable product copy", () => {
    expect(dataConnectionErrorMessage(new Error('psql: error: �û� "postgres" Password ��֤ʧ��'), "postgresql"))
      .toBe("PostgreSQL 身份验证失败，请检查用户名与密码环境变量");
  });
  it("advertises only connectors backed by executable preview implementations", () => {
    for (const type of [
      "postgresql",
      "mysql",
      "mariadb",
      "tidb",
      "doris",
      "starrocks",
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
      "simulation",
    ] as const)
      expect(hasBuiltInDataConnector(type)).toBe(true);
    for (const type of ["bacnet", "s7", "ethernet-ip", "serial"] as const) expect(hasBuiltInDataConnector(type)).toBe(true);
    for (const type of ["bacnet", "s7", "ethernet-ip", "serial", "simulation"] as const) expect(hasWritableDataConnector(type)).toBe(true);
    expect(hasWritableDataConnector("kafka")).toBe(false);
  });
  it("evaluates formulas in declared order without mutating source rows", async () => {
    const rows = [{ device_id: "AHU-01", temperature: 23.25, running: true }];
    const result = await applyComputedFields(rows, dataset);
    expect(result).toEqual([{ device_id: "AHU-01", temperature: 23.25, running: true, fahrenheit: 73.9, state: "RUN", summary: "AHU-01:RUN" }]);
    expect(rows[0]).not.toHaveProperty("fahrenheit");
  });

  it("does not mistake equipment identifiers for dates", () => {
    expect(inferFieldType("AHU-01")).toBe("string");
    expect(inferFieldType("2026-08-25T17:00:00+08:00")).toBe("datetime");
  });

  it("evaluates isolated JavaScript fields after formula fields", async () => {
    const scriptedDataset: DataDatasetRecord = {
      ...dataset,
      computedFields: [
        { id: "formula", key: "celsiusRounded", label: "摄氏温度", type: "number", formula: "ROUND(temperature, 1)" },
        { id: "script", key: "summary", label: "摘要", type: "string", mode: "script", formula: "return `${input.deviceId}: ${input.celsiusRounded}°C`;" },
      ],
    };

    await expect(applyComputedFields([{ deviceId: "AHU-01", temperature: 26.44 }], scriptedDataset)).resolves.toEqual([
      { deviceId: "AHU-01", temperature: 26.44, celsiusRounded: 26.4, summary: "AHU-01: 26.4°C" },
    ]);
  });

  it("reads CSV URLs with inferred scalar values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("device,temperature,running\nAHU-01,23.5,true\n", { status: 200 })),
    );
    const preview = await previewDataset({} as never, connection("csv", { url: "https://example.test/telemetry.csv" }), sourceDataset());
    expect(preview.rows).toEqual([{ device: "AHU-01", temperature: 23.5, running: true }]);
    expect(preview.fields.map((field) => field.type)).toEqual(["string", "number", "boolean"]);
  });

  it("reads the selected Excel sheet from a URL", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ device: "AHU-02", pressure: 101.2 }]), "Telemetry");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes, { status: 200 })),
    );
    const preview = await previewDataset({} as never, connection("excel", { url: "https://example.test/telemetry.xlsx" }), sourceDataset({ sourceKey: "Telemetry" }));
    expect(preview.rows).toEqual([{ device: "AHU-02", pressure: "101.2" }]);
  });

  it("reads a JSON line sent by a TCP telemetry source", async () => {
    const server = net.createServer((socket) => socket.end('{"device":"AHU-03","temperature":24.1}\n'));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to reserve test TCP port");
    try {
      const preview = await previewDataset({} as never, connection("tcp", { url: `tcp://127.0.0.1:${address.port}` }), sourceDataset({ sourceKey: "" }));
      expect(preview.rows).toEqual([{ device: "AHU-03", temperature: 24.1, $source: `127.0.0.1:${address.port}` }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("generates deterministic simulation rows that can be switched to a real source later", async () => {
    const first = await previewDataset({} as never, connection("simulation", { url: "sim://telemetry?rows=3&seed=7" }), sourceDataset({ sourceKey: "" }));
    const second = await previewDataset({} as never, connection("simulation", { url: "sim://telemetry?rows=3&seed=7" }), sourceDataset({ sourceKey: "" }));
    expect(first.rows).toEqual(second.rows);
    expect(first.rows).toHaveLength(3);
    expect(first.rows[0]).toMatchObject({ device_id: "SIM-01", running: false, quality: "good" });
    expect(first.fields.map((field) => field.key)).toEqual(["recorded_at", "device_id", "temperature", "pressure", "vibration", "running", "quality"]);
  });

  it("refreshes a saved schema while preserving field labels and units", async () => {
    const preview = await previewDataset(
      {} as never,
      connection("simulation", { url: "sim://telemetry?rows=1&seed=7" }),
      sourceDataset({
        sourceKey: "",
        fields: [{ key: "temperature", label: "温度", type: "number", unit: "°C" }],
      }),
    );

    expect(preview.fields.find((field) => field.key === "temperature")).toEqual({ key: "temperature", label: "温度", type: "number", unit: "°C" });
    expect(preview.fields.some((field) => field.key === "device_id")).toBe(true);
  });

  it("rejects invalid simulation intervals instead of emitting invalid timestamps", async () => {
    await expect(previewDataset({} as never, connection("simulation", { url: "sim://telemetry?interval=oops" }), sourceDataset({ sourceKey: "" }))).rejects.toThrow(
      "interval 必须是正数",
    );
  });

  it("retries transient HTTP failures with the connection policy", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503, statusText: "Busy" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ device: "AHU-04", temperature: 25 }] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const preview = await previewDataset(
      { port: 4100 } as never,
      connection("http", { url: "https://example.test/telemetry", retryAttempts: 1, retryDelayMs: 100 }),
      sourceDataset({ sourceKey: "items" }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(preview.rows).toEqual([{ device: "AHU-04", temperature: 25 }]);
    expect(listConnectorDiagnostics("project:1")).toContainEqual(
      expect.objectContaining({ connectionId: "connection:http", status: "degraded", reconnects: expect.any(Number), consecutiveFailures: 0 }),
    );
  });

  it("reads authenticated POST APIs without storing the bearer token", async () => {
    vi.stubEnv("FACTORY_HTTP_TOKEN", "runtime-secret");
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init).toMatchObject({
        method: "POST",
        headers: { authorization: "Bearer runtime-secret", "content-type": "application/json" },
        body: '{"line":"A"}',
      });
      return new Response(JSON.stringify({ data: { items: [{ device: "M-01", vibration: 0.18 }] } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const preview = await previewDataset(
      { port: 4100 } as never,
      connection("http", { url: "https://example.test/query", method: "POST", authMode: "bearer", passwordEnv: "FACTORY_HTTP_TOKEN" }),
      sourceDataset({ sourceKey: "data.items", query: '{"line":"A"}' }),
    );
    expect(preview.rows).toEqual([{ device: "M-01", vibration: 0.18 }]);
  });

  it("records industrial downlink writes in connector diagnostics", async () => {
    const writable = connection("simulation", { url: "sim://telemetry?seed=9" });
    await expect(writeDataPoint(writable, { address: "pump.start", value: true })).resolves.toMatchObject({ address: "pump.start", value: true });
    expect(listConnectorDiagnostics("project:1")).toContainEqual(expect.objectContaining({ connectionId: "connection:simulation", status: "healthy", totalWrites: 1 }));
  });

  it("reads JSON payloads from a CoAP resource", async () => {
    const reservation = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => reservation.bind(0, "127.0.0.1", resolve));
    const reservedAddress = reservation.address();
    const port = reservedAddress.port;
    await new Promise<void>((resolve) => reservation.close(resolve));
    const server = coap.createServer();
    server.on("request", (_request, response) => {
      response.setOption("Content-Format", "application/json");
      response.end(JSON.stringify({ items: [{ device: "AHU-05", temperature: 26.2 }] }));
    });
    await new Promise<void>((resolve, reject) => server.listen(port, "127.0.0.1", (error) => (error ? reject(error) : resolve())));
    try {
      const preview = await previewDataset({} as never, connection("coap", { url: `coap://127.0.0.1:${port}/telemetry` }), sourceDataset({ sourceKey: "items" }));
      expect(preview.rows).toEqual([{ device: "AHU-05", temperature: 26.2 }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

function connection(type: DataConnectionRecord["type"], config: DataConnectionRecord["config"]): DataConnectionRecord {
  return {
    id: `connection:${type}`,
    projectId: "project:1",
    name: type,
    type,
    enabled: true,
    config,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function sourceDataset(patch: Partial<DataDatasetRecord> = {}): DataDatasetRecord {
  return {
    id: "dataset:source",
    projectId: "project:1",
    connectionId: "connection:source",
    name: "Source",
    refreshSeconds: 0,
    fields: [],
    ...patch,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}
