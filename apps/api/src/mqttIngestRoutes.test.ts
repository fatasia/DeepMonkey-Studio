import { describe, expect, it } from "vitest";
import websocket from "@fastify/websocket";
import { DataEventBus } from "./dataEvents.js";
import { MqttIngestSupervisor } from "./mqttIngest.js";
import { registerMqttIngestRoutes } from "./mqttIngestRoutes.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function fakeClient() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const client: any = {
    async subscribeAsync() {},
    async endAsync() {},
    on(event: string, listener: (...args: any[]) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return client;
    },
    off(event: string, listener: (...args: any[]) => void) { listeners.get(event)?.delete(listener); return client; },
    emit(event: string, ...args: any[]) { for (const listener of listeners.get(event) ?? []) listener(...args); },
  };
  return client;
}

describe("MQTT ingest control routes", () => {
  it("starts, reports and stops an explicit session without duplicating preview", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-mqtt-ingest-"));
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await app.register(websocket, { options: { maxPayload: 256 * 1024, perMessageDeflate: false } });
    const client = fakeClient();
    const supervisor = new MqttIngestSupervisor(new DataEventBus(), async () => client);
    await registerMqttIngestRoutes(app, store, supervisor);
    await app.ready();
    await store.saveDataConnection("default", {
      id: "mqtt-1", projectId: "default", name: "现场 MQTT", type: "mqtt", enabled: true,
      config: { url: "mqtt://broker.test:1883", topic: "ahu/+/telemetry" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    });
    await store.saveDataset("default", {
      id: "dataset-1", projectId: "default", connectionId: "mqtt-1", name: "AHU", sourceKey: "ahu/+/telemetry", refreshSeconds: 1, fields: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    });
    const started = await app.inject({ method: "POST", url: "/api/projects/default/data-connections/mqtt-1/ingest/start", payload: { datasetId: "dataset-1" } });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ ok: true, stats: { status: "healthy" } });
    const status = await app.inject({ method: "GET", url: "/api/projects/default/data-connections/mqtt-1/ingest/status" });
    expect(status.json()).toMatchObject({ ok: true, stats: { status: "healthy" } });
    const stopped = await app.inject({ method: "POST", url: "/api/projects/default/data-connections/mqtt-1/ingest/stop" });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ ok: true, stopped: true });
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("persistent start/stop/status 走同一连接解析并发布到 DataEventBus", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-mqtt-persistent-"));
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await app.register(websocket, { options: { maxPayload: 256 * 1024, perMessageDeflate: false } });
    const bus = new DataEventBus();
    const received: unknown[] = [];
    bus.subscribe("default", undefined, (event) => received.push(event));
    const clients: ReturnType<typeof fakeClient>[] = [];
    const supervisor = new MqttIngestSupervisor(bus, async () => {
      const client = fakeClient();
      clients.push(client);
      return client;
    });
    await registerMqttIngestRoutes(app, store, supervisor);
    await app.ready();
    await store.saveDataConnection("default", {
      id: "mqtt-1", projectId: "default", name: "现场 MQTT", type: "mqtt", enabled: true,
      config: { url: "mqtt://broker.test:1883", topic: "ahu/+/telemetry", valuePath: "value", timestampPath: "ts", sequencePath: "seq" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    });
    await store.saveDataset("default", {
      id: "dataset-1", projectId: "default", connectionId: "mqtt-1", name: "AHU", sourceKey: "ahu/+/telemetry", refreshSeconds: 1, fields: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    });

    const started = await app.inject({
      method: "POST",
      url: "/api/projects/default/data-connections/mqtt-1/ingest/persistent/start",
      payload: { datasetId: "dataset-1" },
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ ok: true, status: { lifecycle: "healthy", protocol: "mqtt" } });

    // 经内存 broker 投递一条消息:持久会话 → DataEventBus → 订阅方
    clients[0].emit("message", "ahu/01/telemetry", JSON.stringify({ value: 7, ts: "2026-09-27T02:00:00.000Z", seq: 1 }));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ source: "mqtt/mqtt-1", value: 7, sequence: 1 });

    const status = await app.inject({ method: "GET", url: "/api/projects/default/data-connections/mqtt-1/ingest/persistent/status" });
    expect(status.json()).toMatchObject({ ok: true, status: { lifecycle: "healthy", published: 1, lastSequence: 1, gapReports: [] } });

    const stopped = await app.inject({ method: "POST", url: "/api/projects/default/data-connections/mqtt-1/ingest/persistent/stop" });
    expect(stopped.json()).toMatchObject({ ok: true, stopped: true });
    const afterStop = await app.inject({ method: "GET", url: "/api/projects/default/data-connections/mqtt-1/ingest/persistent/status" });
    expect(afterStop.json()).toMatchObject({ ok: true, status: null });

    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("OPC UA 端点不可达 fail-closed 显式报错(502),非订阅类型 400,404 保持", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-mqtt-persistent-opcua-fail-"));
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await app.register(websocket, { options: { maxPayload: 256 * 1024, perMessageDeflate: false } });
    const supervisor = new MqttIngestSupervisor(new DataEventBus(), async () => fakeClient());
    await registerMqttIngestRoutes(app, store, supervisor);
    await app.ready();
    await store.saveDataConnection("default", {
      id: "plc-1", projectId: "default", name: "PLC", type: "opcua", enabled: true,
      config: { url: "opc.tcp://127.0.0.1:1" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    });
    await store.saveDataConnection("default", {
      id: "pg-1", projectId: "default", name: "PG", type: "postgresql", enabled: true,
      config: { url: "postgresql://localhost/db" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    });
    await store.saveDataset("default", {
      id: "ds-plc", projectId: "default", connectionId: "plc-1", name: "PLC", sourceKey: "ns=2;s=Tag1", refreshSeconds: 1, fields: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    });
    const opcua = await app.inject({ method: "POST", url: "/api/projects/default/data-connections/plc-1/ingest/persistent/start", payload: { datasetId: "ds-plc" } });
    expect(opcua.statusCode).toBe(502);
    expect(opcua.json()).toMatchObject({ ok: false });
    expect(opcua.json().message).toContain("OPC UA endpoint 不可达");
    const postgres = await app.inject({ method: "POST", url: "/api/projects/default/data-connections/pg-1/ingest/persistent/start", payload: {} });
    expect(postgres.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/api/projects/default/data-connections/none/ingest/persistent/start", payload: {} });
    expect(missing.statusCode).toBe(404);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("OPC UA 持久订阅全链路:内嵌模拟 server → 202 → 值变更发布到 DataEventBus → status → stop", { timeout: 30_000 }, async () => {
    const { OPCUAServer, Variant, DataType, StatusCodes } = await import("node-opcua");
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-persistent-opcua-live-"));
    const server = new OPCUAServer({ port: 0 });
    await server.initialize();
    const ns = server.engine.addressSpace.getOwnNamespace();
    const tag = ns.addVariable({ organizedBy: server.engine.addressSpace.rootFolder.objects, browseName: "Tag1", dataType: "Double", value: new Variant({ dataType: DataType.Double, value: 0 }) });
    await server.start();
    const boundPort = Number(new URL(server.getEndpointUrl().replace(/^opc\.tcp/i, "http")).port);

    try {
      const store = new JsonStore(dataDir);
      await store.init();
      const app = createApiServer();
      await app.register(websocket, { options: { maxPayload: 256 * 1024, perMessageDeflate: false } });
      const bus = new DataEventBus();
      const received: unknown[] = [];
      bus.subscribe("default", undefined, (event) => received.push(event));
      const supervisor = new MqttIngestSupervisor(bus, async () => fakeClient());
      await registerMqttIngestRoutes(app, store, supervisor);
      await app.ready();
      await store.saveDataConnection("default", {
        id: "plc-1", projectId: "default", name: "PLC", type: "opcua", enabled: true,
        config: { url: `opc.tcp://127.0.0.1:${boundPort}`, samplingIntervalMs: 50 }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      });
      await store.saveDataset("default", {
        id: "ds-plc", projectId: "default", connectionId: "plc-1", name: "PLC", sourceKey: tag.nodeId.toString(), refreshSeconds: 1, fields: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      });

      const started = await app.inject({
        method: "POST",
        url: "/api/projects/default/data-connections/plc-1/ingest/persistent/start",
        payload: { datasetId: "ds-plc" },
      });
      expect(started.statusCode).toBe(202);
      expect(started.json()).toMatchObject({ ok: true, status: { lifecycle: "healthy", protocol: "opcua" } });

      // 等待初始值通知进入发布周期后再写值(写值早于首个采样tick会被当作基线吞掉)。
      await new Promise((resolve) => setTimeout(resolve, 800));
      tag.setValueFromSource(new Variant({ dataType: DataType.Double, value: 33 }), StatusCodes.Good);
      const deadline = Date.now() + 10_000;
      const targetValue = (event: unknown) => (event as { value?: unknown }).value === 33;
      while (!received.some(targetValue) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      const target = received.find(targetValue);
      expect(target).toBeDefined();
      expect(target).toMatchObject({ source: "opcua/plc-1", key: tag.nodeId.toString(), value: 33 });

      const status = await app.inject({ method: "GET", url: "/api/projects/default/data-connections/plc-1/ingest/persistent/status" });
      expect(status.json()).toMatchObject({ ok: true, status: { lifecycle: "healthy", protocol: "opcua" } });
      expect(status.json().status.published).toBeGreaterThanOrEqual(1);

      const stopped = await app.inject({ method: "POST", url: "/api/projects/default/data-connections/plc-1/ingest/persistent/stop" });
      expect(stopped.json()).toMatchObject({ ok: true, stopped: true });
      const afterStop = await app.inject({ method: "GET", url: "/api/projects/default/data-connections/plc-1/ingest/persistent/status" });
      expect(afterStop.json()).toMatchObject({ ok: true, status: null });

      await app.close();
    } finally {
      await server.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
