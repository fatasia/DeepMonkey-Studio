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
});
