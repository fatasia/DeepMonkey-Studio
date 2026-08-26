import type { AddressInfo } from "node:net";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "./serverOptions.js";
import { industrialDemoSnapshot, registerIndustrialDemoRoutes } from "./industrialDemo.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("industrial demo telemetry", () => {
  it("is deterministic for a fixed timestamp and contains dashboard and AGV evidence", () => {
    const timestamp = Date.parse("2026-08-26T03:30:00.000Z");
    const first = industrialDemoSnapshot(timestamp);
    const second = industrialDemoSnapshot(timestamp);

    expect(second).toEqual(first);
    expect(first.factory.target).toBe(960);
    expect(first.agvs).toHaveLength(2);
    expect(first.agvs[0]?.position).toEqual({ x: -12, y: 0.55, z: -5 });
    expect(first.equipment.map((item) => item.equipmentId)).toEqual(["robot-a", "cnc-07", "conveyor-02"]);
    expect(first.history).toHaveLength(24);
  });

  it("publishes the same schema over public HTTP and WebSocket routes", async () => {
    const app = createApiServer();
    await app.register(websocket);
    await registerIndustrialDemoRoutes(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    closers.push(() => app.close());
    const port = (app.server.address() as AddressInfo).port;

    const response = await app.inject({ method: "GET", url: "/api/public/demo/industrial" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: "simulated-live", seed: "industrial-v1" });

    const client = new WebSocket(`ws://127.0.0.1:${port}/api/public/demo/industrial/ws`);
    closers.push(async () => client.close());
    const payload = await new Promise<Record<string, unknown>>((resolve, reject) => {
      client.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
      client.once("error", reject);
    });
    expect(payload).toMatchObject({ mode: "simulated-live", seed: "industrial-v1" });
    expect(payload.agvs).toEqual(expect.any(Array));
  });
});
