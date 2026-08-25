import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataEvent } from "@bim-studio/contracts";
import websocket from "@fastify/websocket";
import { DataEventBus, registerDataEventRoutes } from "./dataEvents.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";
import { registerSystemRoutes } from "./system.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("data event bus", () => {
  it("retains a bounded project stream and filters scene subscriptions", () => {
    const bus = new DataEventBus();
    const received: string[] = [];
    bus.subscribe("project-1", "scene-1", (event) => received.push(event.key));

    bus.publish(event("global"));
    bus.publish(event("matching", "scene-1"));
    bus.publish(event("other", "scene-2"));

    expect(received).toEqual(["global", "matching"]);
    expect(bus.latest("project-1", "scene-1").map((item) => item.key)).toEqual(["global", "matching"]);
  });

  it("broadcasts normalized REST events over the native websocket route", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-data-events-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await app.register(websocket, { options: { maxPayload: 256 * 1024, perMessageDeflate: false } });
    await registerDataEventRoutes(app, store);
    await app.ready();
    const socket = await app.injectWS("/api/projects/default/data/ws?sceneId=scene-1");
    const received = new Promise<DataEvent>((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()) as DataEvent)));

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/default/data/events",
      payload: { source: "mqtt/ahu-01", key: "alarm", value: true, sceneId: "scene-1", target: { modelId: "model-1" }, action: "visibility" }
    });

    expect(response.statusCode).toBe(202);
    await expect(received).resolves.toMatchObject({ projectId: "default", source: "mqtt/ahu-01", key: "alarm", value: true, sceneId: "scene-1" });
    expect((await app.inject({ method: "GET", url: "/api/projects/default/data/events/latest?sceneId=scene-1" })).json()).toHaveLength(1);

    socket.terminate();
    await app.close();
  });

  it("authenticates browser websocket subscriptions with the subprotocol token", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-data-auth-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await app.register(websocket, { options: { maxPayload: 256 * 1024, perMessageDeflate: false } });
    await registerSystemRoutes(app, store, dataDir);
    await registerDataEventRoutes(app, store);
    await app.ready();

    await expect(app.injectWS("/api/projects/default/data/ws")).rejects.toThrow(/401/);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
    const token = login.json().token as string;
    const socket = await app.injectWS("/api/projects/default/data/ws", { headers: { "sec-websocket-protocol": `bim-studio-auth.${token}` } });

    expect(socket.readyState).toBe(socket.OPEN);
    socket.terminate();
    await app.close();
  });
});

function event(key: string, sceneId?: string): DataEvent {
  return { id: key, projectId: "project-1", source: "test", key, value: true, timestamp: "2026-08-25T00:00:00.000Z", ...(sceneId ? { sceneId } : {}) };
}
