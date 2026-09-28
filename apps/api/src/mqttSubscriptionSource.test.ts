import { describe, expect, it, vi } from "vitest";
import { createMqttSubscriptionSource, type MqttSubscriptionSourceConfig } from "./mqttSubscriptionSource.js";
import type { MqttMessageClient } from "./mqttIngest.js";
import type { SourceLifecycleEvent, SourceSample } from "./subscriptionRuntime.js";

/**
 * 内存模拟 broker:可控连接、订阅、投递(topic, payload, packet 三参,与 mqtt.js 一致)、
 * 断线(close)与重上线(重建客户端),供断点续传语义做确定性测试。
 */
class InMemoryBroker {
  client: MqttMessageClient & { emit: (event: string, ...args: unknown[]) => void; subscribed?: string } | undefined;
  connectCount = 0;
  endCount = 0;
  online = true;

  connect = vi.fn(async (): Promise<MqttMessageClient> => {
    if (!this.online) throw new Error("broker 离线");
    this.connectCount += 1;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const client: MqttMessageClient & { emit: (event: string, ...args: unknown[]) => void; subscribed?: string } = {
      async subscribeAsync(topic) {
        client.subscribed = topic;
      },
      async endAsync() {},
      on(event, listener) {
        const set = listeners.get(event) ?? new Set();
        set.add(listener as (...args: unknown[]) => void);
        listeners.set(event, set);
        return client;
      },
      off(event, listener) {
        listeners.get(event)?.delete(listener as (...args: unknown[]) => void);
        return client;
      },
      emit(event, ...args) {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      },
    };
    client.endAsync = async () => {
      this.endCount += 1;
    };
    this.client = client;
    return client;
  });

  publish(topic: string, payload: string, packet?: { properties?: { userProperties?: Record<string, unknown> } }): void {
    this.client?.emit("message", topic, payload, packet);
  }

  dropConnection(): void {
    this.client?.emit("close");
  }
}

function config(broker: InMemoryBroker, overrides: Partial<MqttSubscriptionSourceConfig> = {}): MqttSubscriptionSourceConfig {
  return {
    url: "mqtt://broker.test:1883",
    topic: "ahu/+/telemetry",
    valuePath: "value",
    timestampPath: "ts",
    sequencePath: "seq",
    connect: broker.connect,
    ...overrides,
  };
}

async function collect(source: ReturnType<typeof createMqttSubscriptionSource>) {
  const samples: SourceSample[] = [];
  const lifecycle: SourceLifecycleEvent[] = [];
  source.onSample((sample) => samples.push(sample));
  source.onLifecycle((event) => lifecycle.push(event));
  return { samples, lifecycle };
}

describe("MqttSubscriptionSource(内存 broker)", () => {
  it("连接 + 订阅 → ready;负载字段映射为样本(value/timestamp/sequence)", async () => {
    const broker = new InMemoryBroker();
    const source = createMqttSubscriptionSource(config(broker));
    const { samples, lifecycle } = await collect(source);
    await source.start();
    expect(broker.client?.subscribed).toBe("ahu/+/telemetry");
    expect(lifecycle).toEqual([{ kind: "ready" }]);
    broker.publish("ahu/01/telemetry", JSON.stringify({ value: 42, ts: "2026-09-27T01:00:00.000Z", seq: 7 }));
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ topic: "ahu/01/telemetry", value: 42, timestamp: "2026-09-27T01:00:00.000Z", sequence: 7 });
    await source.dispose();
  });

  it("MQTT 5 用户属性序列号优先于负载字段", async () => {
    const broker = new InMemoryBroker();
    const source = createMqttSubscriptionSource(config(broker));
    const { samples } = await collect(source);
    await source.start();
    broker.publish(
      "ahu/01/telemetry",
      JSON.stringify({ value: 1, seq: 10 }),
      { properties: { userProperties: { seq: "99" } } },
    );
    expect(samples[0].sequence).toBe(99);
    await source.dispose();
  });

  it("非 JSON 与缺 valuePath → invalid-sample,源不崩溃且计数", async () => {
    const broker = new InMemoryBroker();
    const source = createMqttSubscriptionSource(config(broker));
    const { samples, lifecycle } = await collect(source);
    await source.start();
    broker.publish("ahu/01/telemetry", "not-json");
    broker.publish("ahu/01/telemetry", JSON.stringify({ seq: 1 }));
    expect(samples).toHaveLength(0);
    expect(lifecycle.filter((event) => event.kind === "invalid-sample")).toHaveLength(2);
    expect(source.stats().parseFailures).toBe(2);
    await source.dispose();
  });

  it("close → disconnected;dispose 后迟到消息不再外发且连接对象释放", async () => {
    const broker = new InMemoryBroker();
    const source = createMqttSubscriptionSource(config(broker));
    const { samples, lifecycle } = await collect(source);
    await source.start();
    broker.dropConnection();
    expect(lifecycle.at(-1)).toMatchObject({ kind: "disconnected" });
    await source.dispose();
    expect(broker.endCount).toBe(1);
    broker.publish("ahu/01/telemetry", JSON.stringify({ value: 1, seq: 1 }));
    expect(samples).toHaveLength(0);
    await source.dispose();
    expect(broker.endCount).toBe(1);
  });

  it("重复 start 被拒绝;重上线由上层经新实例完成(broker 恢复后可再次连接)", async () => {
    const broker = new InMemoryBroker();
    const source = createMqttSubscriptionSource(config(broker));
    await source.start();
    await expect(source.start()).rejects.toThrow(/已启动/);
    await source.dispose();
    broker.online = false;
    const offline = createMqttSubscriptionSource(config(broker));
    await expect(offline.start()).rejects.toThrow(/离线/);
    broker.online = true;
    const recovered = createMqttSubscriptionSource(config(broker));
    const { lifecycle } = await collect(recovered);
    await recovered.start();
    expect(lifecycle).toEqual([{ kind: "ready" }]);
    expect(broker.connectCount).toBe(2);
    await recovered.dispose();
  });
});
