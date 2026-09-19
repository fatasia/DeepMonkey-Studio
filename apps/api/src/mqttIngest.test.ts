import { describe, expect, it, vi } from "vitest";
import { DataEventBus } from "./dataEvents.js";
import { MqttIngestSession, MqttIngestSupervisor, type MqttMessageClient } from "./mqttIngest.js";

function fakeClient() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const client: MqttMessageClient & { emit: (event: string, ...args: any[]) => void; subscribed?: string } = {
    async subscribeAsync(topic) { client.subscribed = topic; },
    async endAsync() {},
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return client;
    },
    off(event, listener) { listeners.get(event)?.delete(listener); return client; },
    emit(event, ...args) { for (const listener of listeners.get(event) ?? []) listener(...args); },
  };
  return client;
}

const config = (overrides: Record<string, unknown> = {}) => ({
  connectionId: "conn-1",
  projectId: "project-1",
  url: "mqtt://broker.test:1883",
  mapping: { topic: "ahu/+/telemetry", valuePath: "value", timestampPath: "ts", sequencePath: "seq", action: "alarm" as const },
  ...overrides,
});

describe("MqttIngestSession", () => {
  it("reuses the existing DataEventBus contract and normalizes payloads", async () => {
    const client = fakeClient();
    const bus = new DataEventBus();
    const received: unknown[] = [];
    bus.subscribe("project-1", undefined, (event) => received.push(event));
    const session = new MqttIngestSession(config(), bus, async () => client);
    await session.start();
    expect(client.subscribed).toBe("ahu/+/telemetry");
    client.emit("message", "ahu/01/telemetry", JSON.stringify({ value: 42, ts: "2026-09-19T00:00:00Z", seq: 1 }));
    expect(received[0]).toMatchObject({ source: "mqtt/conn-1", key: "ahu/01/telemetry", value: 42, action: "alarm" });
    expect(session.snapshot()).toMatchObject({ status: "healthy", received: 1, published: 1 });
    await session.stop();
    expect(session.snapshot().status).toBe("stopped");
  });

  it("deduplicates identical topic/payload messages", async () => {
    const client = fakeClient();
    const bus = new DataEventBus();
    const publish = vi.spyOn(bus, "publish");
    const session = new MqttIngestSession(config(), bus, async () => client);
    await session.start();
    const payload = JSON.stringify({ value: 1, seq: 1 });
    client.emit("message", "ahu/01/telemetry", payload);
    client.emit("message", "ahu/01/telemetry", payload);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(session.snapshot().deduplicated).toBe(1);
  });

  it("allows the same value again after the short duplicate window", async () => {
    let clock = 1000;
    const client = fakeClient();
    const bus = new DataEventBus();
    const publish = vi.spyOn(bus, "publish");
    const session = new MqttIngestSession({ ...config(), now: () => clock }, bus, async () => client);
    await session.start();
    const payload = JSON.stringify({ value: 1, seq: 1 });
    client.emit("message", "ahu/01/telemetry", payload);
    clock += 1000;
    client.emit("message", "ahu/01/telemetry", payload);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(session.snapshot().deduplicated).toBe(0);
  });
  it("drops lower sequence values but accepts a newer sequence", async () => {
    const client = fakeClient();
    const bus = new DataEventBus();
    const publish = vi.spyOn(bus, "publish");
    const session = new MqttIngestSession(config(), bus, async () => client);
    await session.start();
    client.emit("message", "ahu/01/telemetry", JSON.stringify({ value: 2, seq: 2 }));
    client.emit("message", "ahu/01/telemetry", JSON.stringify({ value: 1, seq: 1 }));
    client.emit("message", "ahu/01/telemetry", JSON.stringify({ value: 3, seq: 3 }));
    expect(publish).toHaveBeenCalledTimes(2);
    expect(session.snapshot().droppedOutOfOrder).toBe(1);
  });

  it("drops timestamps older than the tolerance window", async () => {
    const client = fakeClient();
    const bus = new DataEventBus();
    const publish = vi.spyOn(bus, "publish");
    const session = new MqttIngestSession({ ...config(), outOfOrderToleranceMs: 10 }, bus, async () => client);
    await session.start();
    client.emit("message", "ahu/01/telemetry", JSON.stringify({ value: 2, ts: "2026-09-19T00:00:01.000Z", seq: 2 }));
    client.emit("message", "ahu/01/telemetry", JSON.stringify({ value: 1, ts: "2026-09-19T00:00:00.000Z", seq: 3 }));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(session.snapshot().droppedOutOfOrder).toBe(1);
  });

  it("records malformed and missing-value payloads without crashing the session", async () => {
    const client = fakeClient();
    const session = new MqttIngestSession(config(), new DataEventBus(), async () => client);
    await session.start();
    client.emit("message", "ahu/01/telemetry", "not-json");
    client.emit("message", "ahu/01/telemetry", JSON.stringify({ seq: 1 }));
    expect(session.snapshot()).toMatchObject({ parseFailures: 2, status: "healthy" });
  });

  it("marks connection errors degraded and counts reconnects", async () => {
    const client = fakeClient();
    const session = new MqttIngestSession(config(), new DataEventBus(), async () => client);
    await session.start();
    client.emit("error", new Error("broker unavailable"));
    client.emit("reconnect");
    expect(session.snapshot()).toMatchObject({ status: "degraded", reconnects: 1, lastError: "broker unavailable" });
  });

  it("cleans up a failed start so a supervisor can retry", async () => {
    const bus = new DataEventBus();
    const clients = [fakeClient(), fakeClient()];
    let attempt = 0;
    const supervisor = new MqttIngestSupervisor(bus, async () => {
      if (attempt++ === 0) throw new Error("offline");
      return clients[1];
    });
    await expect(supervisor.start("conn-1", config())).rejects.toThrow(/启动失败/);
    const retry = await supervisor.start("conn-1", config());
    expect(retry.snapshot().status).toBe("healthy");
    await supervisor.stopAll();
  });

  it("stops idempotently and does not publish after stop", async () => {
    const client = fakeClient();
    const bus = new DataEventBus();
    const publish = vi.spyOn(bus, "publish");
    const session = new MqttIngestSession(config(), bus, async () => client);
    await session.start();
    await session.stop();
    client.emit("message", "ahu/01/telemetry", JSON.stringify({ value: 1, seq: 1 }));
    expect(publish).not.toHaveBeenCalled();
    await session.stop();
  });
});
