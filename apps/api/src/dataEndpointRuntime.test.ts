import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import websocket from "@fastify/websocket";
import type { DataEndpointDefinition, DataPipelineDefinition } from "@bim-studio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { hashDataApiKey } from "./dataEndpointAuth.js";
import { registerDataEndpointRuntime } from "./dataEndpointRuntime.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("external data endpoint runtime", () => {
  it("requires endpoint API keys and enforces request budgets", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-data-endpoint-"));
    directories.push(directory);
    const store = new JsonStore(directory);
    await store.init();
    const now = new Date().toISOString();
    await store.saveDataConnection("default", { id: "connection", projectId: "default", name: "HTTP", type: "http", enabled: true, config: { url: "/api/demo/sensors" }, createdAt: now, updatedAt: now });
    await store.saveDataset("default", { id: "dataset", projectId: "default", connectionId: "connection", name: "设备", refreshSeconds: 5, fields: [], createdAt: now, updatedAt: now });
    const pipeline: DataPipelineDefinition = { id: "pipeline", projectId: "default", name: "设备流", nodes: [{ id: "source", type: "source", name: "源", datasetId: "dataset", position: { x: 0, y: 0 } }, { id: "output", type: "output", name: "输出", position: { x: 220, y: 0 } }], edges: [{ id: "edge", sourceNodeId: "source", targetNodeId: "output" }], createdAt: now, updatedAt: now };
    await store.saveDataPipeline("default", pipeline);
    const endpoint: DataEndpointDefinition = { id: "endpoint", projectId: "default", name: "设备 API", kind: "rest", slug: "devices", pipelineId: "pipeline", enabled: true, apiKeyHint: "••••secret", method: "GET", requestsPerMinute: 1, createdAt: now, updatedAt: now };
    await store.saveDataEndpoint("default", endpoint, hashDataApiKey("bsp_secret"));
    await store.removeDataPipeline("default", "pipeline");

    const app = createApiServer();
    await app.register(websocket);
    await registerDataEndpointRuntime(app, store, loadConfig());

    expect((await app.inject({ method: "GET", url: "/runtime/data/default/rest/devices" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/runtime/data/default/rest/devices", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/runtime/data/default/rest/devices", headers: { authorization: "Bearer bsp_secret" } })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/runtime/data/default/rest/devices", headers: { authorization: "Bearer bsp_secret" } })).statusCode).toBe(429);

    const socket = await app.injectWS("/runtime/data/default/ws/missing", { headers: { "sec-websocket-protocol": "bim-studio-key.invalid" } });
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    expect(await closed).toBe(4401);
    await store.removeProject("default");
    expect(store.getDataEndpointSecretHash("endpoint")).toBeUndefined();
    await app.close();
  });
});
