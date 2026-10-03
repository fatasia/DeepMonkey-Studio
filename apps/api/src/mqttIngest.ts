import { createHash } from "node:crypto";
import type { DataEvent, DataEventAction, DataEventTarget, DataSubscriptionStatus } from "@bim-studio/contracts";
import { DataEventBus } from "./dataEvents.js";
import { createMqttSubscriptionSource } from "./mqttSubscriptionSource.js";
import {
  createOpcUaSubscriptionSource,
  projectOpcUaSample,
  type OpcUaIngestConfig,
} from "./opcUaSubscriptionSource.js";
import {
  InMemoryCheckpointStore,
  SubscriptionRegistry,
  type CheckpointStore,
  type PersistentSubscriptionOptions,
  type PersistentSubscriptionSession,
  type SourceSample,
} from "./subscriptionRuntime.js";

export interface MqttMessageClient {
  subscribeAsync(topic: string, options?: { qos?: 0 | 1 | 2 }): Promise<unknown>;
  endAsync(force?: boolean): Promise<unknown>;
  on(event: "message" | "error" | "reconnect" | "close", listener: (...args: any[]) => void): this;
  off?(event: "message" | "error" | "reconnect" | "close", listener: (...args: any[]) => void): this;
}

export type MqttConnect = (url: string, options: Record<string, unknown>) => Promise<MqttMessageClient>;

export interface MqttIngestMapping {
  topic: string;
  source?: string;
  key?: string;
  valuePath?: string;
  timestampPath?: string;
  sequencePath?: string;
  sceneId?: string;
  target?: DataEventTarget;
  action?: DataEventAction;
  qos?: 0 | 1 | 2;
}

export interface MqttIngestConfig {
  connectionId: string;
  projectId: string;
  url: string;
  user?: string;
  password?: string;
  clientId?: string;
  reconnectPeriodMs?: number;
  mapping: MqttIngestMapping;
  /** Older samples are dropped when their timestamp is behind the accepted watermark. */
  outOfOrderToleranceMs?: number;
  now?: () => number;
}

export interface MqttIngestStats {
  status: "idle" | "connecting" | "healthy" | "degraded" | "stopped";
  received: number;
  published: number;
  deduplicated: number;
  droppedOutOfOrder: number;
  parseFailures: number;
  reconnects: number;
  lastError?: string;
  lastMessageAt?: string;
}

export class MqttIngestSession {
  private client: MqttMessageClient | undefined;
  private readonly stats: MqttIngestStats = {
    status: "idle", received: 0, published: 0, deduplicated: 0,
    droppedOutOfOrder: 0, parseFailures: 0, reconnects: 0,
  };
  private readonly seen = new Map<string, number>();
  private readonly latestSequence = new Map<string, number>();
  private latestTimestamp = 0;
  private readonly now: () => number;
  private readonly dedupeWindowMs = 250;

  constructor(
    private readonly config: MqttIngestConfig,
    private readonly bus: DataEventBus,
    private readonly connect: MqttConnect,
  ) {
    this.now = config.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.client) return;
    this.stats.status = "connecting";
    try {
      this.client = await this.connect(this.config.url, {
        clientId: this.config.clientId ?? `bim-studio-ingest-${this.config.connectionId}`,
        reconnectPeriod: this.config.reconnectPeriodMs ?? 1_000,
        ...(this.config.user ? { username: this.config.user } : {}),
        ...(this.config.password ? { password: this.config.password } : {}),
      });
      this.client.on("message", this.onMessage);
      this.client.on("error", this.onError);
      this.client.on("reconnect", this.onReconnect);
      await this.client.subscribeAsync(this.config.mapping.topic, { qos: this.config.mapping.qos ?? 0 });
      this.stats.status = "healthy";
    } catch (error) {
      this.stats.status = "degraded";
      this.stats.lastError = errorMessage(error);
      throw new Error(`MQTT 持续摄取启动失败(${this.config.connectionId}): ${this.stats.lastError}`);
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) {
      this.stats.status = "stopped";
      return;
    }
    for (const [event, listener] of [["message", this.onMessage], ["error", this.onError], ["reconnect", this.onReconnect]] as const) {
      client.off?.(event, listener);
    }
    await client.endAsync(true);
    this.stats.status = "stopped";
  }

  snapshot(): MqttIngestStats {
    return { ...this.stats };
  }

  private readonly onMessage = (topic: string, payload: Uint8Array | string): void => {
    this.stats.received += 1;
    const raw = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
    const fingerprint = createHash("sha256").update(`${topic}\0${raw}`).digest("hex");
    const receivedAt = this.now();
    const previousSeenAt = this.seen.get(fingerprint);
    if (previousSeenAt !== undefined && receivedAt - previousSeenAt <= this.dedupeWindowMs) {
      this.stats.deduplicated += 1;
      return;
    }
    this.seen.set(fingerprint, receivedAt);
    for (const [key, at] of this.seen) {
      if (receivedAt - at > this.dedupeWindowMs) this.seen.delete(key);
    }
    try {
      const input: unknown = JSON.parse(raw);
      const event = this.normalize(topic, input);
      if (!event) return;
      const sequence = readNumber(input, this.config.mapping.sequencePath);
      if (sequence !== undefined) {
        const previous = this.latestSequence.get(topic);
        if (previous !== undefined && sequence < previous) {
          this.stats.droppedOutOfOrder += 1;
          return;
        }
        this.latestSequence.set(topic, sequence);
      }
      const timestampMs = Date.parse(event.timestamp);
      const tolerance = this.config.outOfOrderToleranceMs ?? 5_000;
      if (timestampMs + tolerance < this.latestTimestamp) {
        this.stats.droppedOutOfOrder += 1;
        return;
      }
      this.latestTimestamp = Math.max(this.latestTimestamp, timestampMs);
      this.bus.publish(event);
      this.stats.published += 1;
      this.stats.lastMessageAt = new Date(this.now()).toISOString();
    } catch (error) {
      this.stats.parseFailures += 1;
      this.stats.lastError = errorMessage(error);
    }
  };

  private normalize(topic: string, input: unknown): DataEvent | undefined {
    if (!input || typeof input !== "object") throw new Error("MQTT payload 必须是 JSON 对象");
    const value = this.config.mapping.valuePath ? readPath(input, this.config.mapping.valuePath) : input;
    if (value === undefined) throw new Error(`缺少 valuePath: ${this.config.mapping.valuePath}`);
    const timestampValue = readPath(input, this.config.mapping.timestampPath);
    const timestamp = timestampValue !== undefined && Number.isFinite(Date.parse(String(timestampValue)))
      ? new Date(String(timestampValue)).toISOString()
      : new Date(this.now()).toISOString();
    return {
      id: createHash("sha256").update(`${this.config.projectId}:${topic}:${timestamp}:${JSON.stringify(value)}`).digest("hex").slice(0, 32),
      projectId: this.config.projectId,
      source: this.config.mapping.source ?? `mqtt/${this.config.connectionId}`,
      key: this.config.mapping.key ?? topic,
      value,
      timestamp,
      ...(this.config.mapping.sceneId ? { sceneId: this.config.mapping.sceneId } : {}),
      ...(this.config.mapping.target ? { target: this.config.mapping.target } : {}),
      ...(this.config.mapping.action ? { action: this.config.mapping.action } : {}),
    };
  }

  private readonly onError = (error: unknown): void => {
    this.stats.status = "degraded";
    this.stats.lastError = errorMessage(error);
  };

  private readonly onReconnect = (): void => {
    this.stats.status = "degraded";
    this.stats.reconnects += 1;
  };
}

export class MqttIngestSupervisor {
  private readonly sessions = new Map<string, MqttIngestSession>();
  private readonly persistent = new SubscriptionRegistry();
  private readonly checkpoints: CheckpointStore;

  constructor(private readonly bus: DataEventBus, private readonly connect: MqttConnect, options?: { checkpointStore?: CheckpointStore }) {
    this.checkpoints = options?.checkpointStore ?? new InMemoryCheckpointStore();
  }

  async start(id: string, config: MqttIngestConfig): Promise<MqttIngestSession> {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const session = new MqttIngestSession(config, this.bus, this.connect);
    this.sessions.set(id, session);
    try {
      await session.start();
      return session;
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
  }

  async stop(id: string): Promise<boolean> {
    // 同时治理简单会话与持久会话:同一连接 id 只允许一种活动会话。
    let stopped = false;
    const legacy = this.sessions.get(id);
    if (legacy) {
      this.sessions.delete(id);
      await legacy.stop();
      stopped = true;
    }
    if (await this.persistent.stop(id)) stopped = true;
    return stopped;
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all([this.persistent.stopAll(), ...sessions.map((session) => session.stop())]);
  }

  snapshot(id: string): MqttIngestStats | null {
    return this.sessions.get(id)?.snapshot() ?? null;
  }

  /**
   * T24 持久订阅:显式生命周期治理(断线检测 → 指数退避 → 订阅恢复 → 缺口对账)。
   * 与简单会话互斥:同 id 先停已有会话再启动持久订阅。
   */
  async startPersistent(id: string, config: MqttIngestConfig, options?: PersistentStartOptions): Promise<PersistentSubscriptionSession> {
    const session = await this.persistent.start(id, {
      connectionId: config.connectionId,
      projectId: config.projectId,
      protocol: "mqtt",
      sourceFactory: async () =>
        createMqttSubscriptionSource({
          url: config.url,
          topic: config.mapping.topic,
          ...(config.mapping.qos !== undefined ? { qos: config.mapping.qos } : {}),
          clientId: config.clientId ?? `bim-studio-subscription-${config.connectionId}`,
          ...(config.user ? { user: config.user } : {}),
          ...(config.password ? { password: config.password } : {}),
          ...(config.mapping.valuePath ? { valuePath: config.mapping.valuePath } : {}),
          ...(config.mapping.timestampPath ? { timestampPath: config.mapping.timestampPath } : {}),
          ...(config.mapping.sequencePath ? { sequencePath: config.mapping.sequencePath } : {}),
          ...(options?.userPropertySequenceKeys ? { userPropertySequenceKeys: options.userPropertySequenceKeys } : {}),
          connect: this.connect,
        }),
      project: (sample) => projectSample(config, sample),
      onEvent: (event) => this.bus.publish(event),
      ...(options?.onGapReport ? { onGapReport: options.onGapReport } : {}),
      checkpointStore: options?.checkpointStore ?? this.checkpoints,
      ...(options?.backoff ? { backoff: options.backoff } : {}),
      ...(config.now ? { now: config.now } : {}),
      ...(options?.dedupeWindowMs !== undefined ? { dedupeWindowMs: options.dedupeWindowMs } : {}),
      ...(options?.maxGapReports !== undefined ? { maxGapReports: options.maxGapReports } : {}),
    });
    // 简单会话与持久会话互斥:持久订阅接管后移除同 id 的简单会话。
    if (this.sessions.has(id)) {
      const legacy = this.sessions.get(id);
      this.sessions.delete(id);
      await legacy?.stop();
    }
    return session;
  }

  persistentSnapshot(id: string): DataSubscriptionStatus | null {
    return this.persistent.get(id)?.snapshot() ?? null;
  }

  async stopPersistent(id: string): Promise<boolean> {
    return this.persistent.stop(id);
  }

  persistentSize(): number {
    return this.persistent.size();
  }

  /**
   * T24 OPC UA 切片:OPC UA 持久订阅(MonitoredItem 数据变更订阅)。
   * 与 MQTT 持久订阅共享注册表/checkpoint/事件总线与同 id 互斥语义;
   * sourceFactory 接收运行时注入的 resume 上下文,用于断线区间的缺口估计。
   */
  async startPersistentOpcUa(id: string, config: OpcUaIngestConfig, options?: PersistentStartOptions): Promise<PersistentSubscriptionSession> {
    const session = await this.persistent.start(id, {
      connectionId: config.connectionId,
      projectId: config.projectId,
      protocol: "opcua",
      sourceFactory: async (resume) =>
        createOpcUaSubscriptionSource({
          endpointUrl: config.endpointUrl,
          nodeIds: config.nodeIds,
          ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
          ...(config.user ? { user: config.user } : {}),
          ...(config.password ? { password: config.password } : {}),
          ...(config.samplingIntervalMs !== undefined ? { samplingIntervalMs: config.samplingIntervalMs } : {}),
          ...(config.publishingIntervalMs !== undefined ? { publishingIntervalMs: config.publishingIntervalMs } : {}),
          ...(config.queueSize !== undefined ? { queueSize: config.queueSize } : {}),
          ...(config.security ? { security: config.security } : {}),
          ...(resume.lastSequence !== null || resume.lastTimestamp !== null ? { resume } : {}),
        }),
      project: (sample) => projectOpcUaSample(config, sample),
      onEvent: (event) => this.bus.publish(event),
      ...(options?.onGapReport ? { onGapReport: options.onGapReport } : {}),
      checkpointStore: options?.checkpointStore ?? this.checkpoints,
      ...(options?.backoff ? { backoff: options.backoff } : {}),
      ...(config.now ? { now: config.now } : {}),
      ...(options?.dedupeWindowMs !== undefined ? { dedupeWindowMs: options.dedupeWindowMs } : {}),
      ...(options?.maxGapReports !== undefined ? { maxGapReports: options.maxGapReports } : {}),
    });
    // 简单会话与持久会话互斥:持久订阅接管后移除同 id 的简单会话。
    if (this.sessions.has(id)) {
      const legacy = this.sessions.get(id);
      this.sessions.delete(id);
      await legacy?.stop();
    }
    return session;
  }
}

export interface PersistentStartOptions {
  checkpointStore?: CheckpointStore;
  onGapReport?: (report: import("@bim-studio/contracts").DataSubscriptionGapReport) => void;
  backoff?: Partial<import("./subscriptionRuntime.js").BackoffPolicy>;
  dedupeWindowMs?: number;
  maxGapReports?: number;
  /** MQTT 5 用户属性序列号候选键;默认 ["seq","sequence"]。 */
  userPropertySequenceKeys?: string[];
}

/** SourceSample → DataEvent 投影:与简单会话 normalize 同一合同(id/字段派生一致)。 */
function projectSample(config: MqttIngestConfig, sample: SourceSample): DataEvent {
  const id = createHash("sha256")
    .update(`${config.projectId}:${sample.topic}:${sample.timestamp}:${JSON.stringify(sample.value)}`)
    .digest("hex")
    .slice(0, 32);
  return {
    id,
    projectId: config.projectId,
    source: config.mapping.source ?? `mqtt/${config.connectionId}`,
    key: config.mapping.key ?? sample.topic,
    value: sample.value,
    timestamp: sample.timestamp,
    ...(sample.sequence !== undefined ? { sequence: sample.sequence } : {}),
    ...(config.mapping.sceneId ? { sceneId: config.mapping.sceneId } : {}),
    ...(config.mapping.target ? { target: config.mapping.target } : {}),
    ...(config.mapping.action ? { action: config.mapping.action } : {}),
  };
}

export function readPath(input: unknown, path?: string): unknown {
  if (!path) return undefined;
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, input);
}

export function readNumber(input: unknown, path?: string): number | undefined {
  const value = readPath(input, path);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
