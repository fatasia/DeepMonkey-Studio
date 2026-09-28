/**
 * T24 切片:MQTT 协议源适配器——把 mqtt.js 客户端封装为 SubscriptionSource。
 *
 * 序列号来源优先级:
 * 1. MQTT 5 用户属性(packet.properties.userProperties,键按 userPropertySequenceKeys 尝试);
 * 2. 负载 JSON 的 sequencePath 字段;
 * 3. 均缺失 → sample.sequence 为 undefined,会话按"完整性未知"口径对账。
 *
 * 每次重连由会话经 sourceFactory 重建全新实例;旧实例 dispose() 释放全部监听器与连接对象。
 */
import type { MqttConnect } from "./mqttIngest.js";
import { readNumber, readPath } from "./mqttIngest.js";
import type { SourceLifecycleEvent, SourceSample, SubscriptionSource } from "./subscriptionRuntime.js";

export interface MqttSubscriptionSourceConfig {
  url: string;
  topic: string;
  qos?: 0 | 1 | 2;
  clientId?: string;
  user?: string;
  password?: string;
  valuePath?: string;
  timestampPath?: string;
  sequencePath?: string;
  /** MQTT 5 用户属性中代表源序列号的候选键,按序尝试;默认 ["seq","sequence"]。 */
  userPropertySequenceKeys?: string[];
  connect: MqttConnect;
}

const DEFAULT_SEQUENCE_KEYS = ["seq", "sequence"];

export function createMqttSubscriptionSource(config: MqttSubscriptionSourceConfig): SubscriptionSource {
  let client: Awaited<ReturnType<MqttConnect>> | undefined;
  let started = false;
  let disposed = false;
  const sampleListeners = new Set<(sample: SourceSample) => void>();
  const lifecycleListeners = new Set<(event: SourceLifecycleEvent) => void>();
  const stats: { parseFailures: number } = { parseFailures: 0 };
  const sequenceKeys = config.userPropertySequenceKeys ?? DEFAULT_SEQUENCE_KEYS;

  const emitSample = (sample: SourceSample): void => {
    for (const listener of sampleListeners) listener(sample);
  };
  const emitLifecycle = (event: SourceLifecycleEvent): void => {
    for (const listener of lifecycleListeners) listener(event);
  };

  const onMessage = (...args: unknown[]): void => {
    const topic = args[0] as string;
    const rawPayload = args[1] as Uint8Array | string;
    const packet = args[2] as { properties?: { userProperties?: Record<string, unknown> } } | undefined;
    const raw = typeof rawPayload === "string" ? rawPayload : Buffer.from(rawPayload).toString("utf8");
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      stats.parseFailures += 1;
      emitLifecycle({ kind: "invalid-sample", reason: `MQTT 负载不是合法 JSON(topic=${topic})` });
      return;
    }
    if (!input || typeof input !== "object") {
      stats.parseFailures += 1;
      emitLifecycle({ kind: "invalid-sample", reason: `MQTT 负载必须是 JSON 对象(topic=${topic})` });
      return;
    }
    const value = config.valuePath ? readPath(input, config.valuePath) : input;
    if (value === undefined) {
      stats.parseFailures += 1;
      emitLifecycle({ kind: "invalid-sample", reason: `缺少 valuePath: ${config.valuePath}` });
      return;
    }
    const timestampValue = config.timestampPath ? readPath(input, config.timestampPath) : undefined;
    const timestamp =
      timestampValue !== undefined && Number.isFinite(Date.parse(String(timestampValue)))
        ? new Date(String(timestampValue)).toISOString()
        : new Date().toISOString();
    emitSample({
      topic,
      value,
      timestamp,
      ...readSequence(input, packet, sequenceKeys, config.sequencePath),
    });
  };
  const onClose = (): void => {
    emitLifecycle({ kind: "disconnected", reason: "MQTT 连接关闭" });
  };
  const onError = (error: unknown): void => {
    emitLifecycle({ kind: "disconnected", reason: error instanceof Error ? error.message : String(error) });
  };

  return {
    protocol: "mqtt",
    async start() {
      if (started) throw new Error("MQTT 订阅源已启动;重连请通过 sourceFactory 重建实例");
      started = true;
      if (disposed) throw new Error("MQTT 订阅源已释放");
      client = await config.connect(config.url, {
        clientId: config.clientId ?? "bim-studio-subscription",
        ...(config.user ? { username: config.user } : {}),
        ...(config.password ? { password: config.password } : {}),
      });
      client.on("message", onMessage);
      client.on("close", onClose);
      client.on("error", onError);
      await client.subscribeAsync(config.topic, { qos: config.qos ?? 0 });
      emitLifecycle({ kind: "ready" });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const current = client;
      client = undefined;
      sampleListeners.clear();
      lifecycleListeners.clear();
      if (!current) return;
      current.off?.("message", onMessage);
      current.off?.("close", onClose);
      current.off?.("error", onError);
      await current.endAsync(true);
    },
    onSample(listener) {
      sampleListeners.add(listener);
      return () => sampleListeners.delete(listener);
    },
    onLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    stats: () => ({ ...stats }),
  };
}

function readSequence(
  input: unknown,
  packet: { properties?: { userProperties?: Record<string, unknown> } } | undefined,
  sequenceKeys: string[],
  sequencePath?: string,
): { sequence: number } | Record<string, never> {
  const userProperties = packet?.properties?.userProperties;
  if (userProperties) {
    for (const key of sequenceKeys) {
      const raw = userProperties[key];
      const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : undefined;
      if (value !== undefined && Number.isFinite(value)) return { sequence: value };
    }
  }
  const fromPayload = readNumber(input, sequencePath);
  if (fromPayload !== undefined) return { sequence: fromPayload };
  return {};
}
