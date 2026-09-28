/**
 * T24 切片:协议无关的持久订阅运行时。
 *
 * 职责(缺口 N2 首个切片,主计划 §9):
 * 1. 订阅生命周期治理:订阅建立 → checkpoint 持久化 → 断线检测 → 指数退避重连 → 订阅恢复 → 恢复后对账(缺口报告)。
 * 2. 断点续传语义:源序列号 + 源时间戳驱动的缺口检测;源无序列号时如实输出"完整性未知",不伪造连续性。
 * 3. 会话注册表:生成号(generation)、取消即释放、泄漏防护审计(定时器/监听器/活跃源计数,测试可直接断言)。
 *
 * 协议适配(WebSocket/MQTT/OPC UA)只实现 SubscriptionSource;本文件不包含任何网络 I/O。
 */
import { createHash, randomUUID } from "node:crypto";
import type { DataEvent, DataSubscriptionGapReport, DataSubscriptionLifecycle, DataSubscriptionStatus } from "@bim-studio/contracts";

/** 协议源交出的单个数据点;value 已由适配器解析为可序列化值。 */
export interface SourceSample {
  topic: string;
  value: unknown;
  /** 源时间戳(ISO 8601);适配器保证有值(缺失时落到采集时间)。 */
  timestamp: string;
  /** 源序列号;缺失表示源不保证序(例如未带 seq 的 MQTT 主题)。 */
  sequence?: number;
}

export type SourceLifecycleEvent =
  | { kind: "ready" }
  | { kind: "disconnected"; reason?: string }
  | { kind: "invalid-sample"; reason: string };

/**
 * 协议源抽象:一次 connect + subscribe 的封装。
 * 退避重连由会话驱动,每次重连通过 sourceFactory 重建全新实例,
 * 旧实例必须 dispose()——这是泄漏防护测试的断言点。
 */
export interface SubscriptionSource {
  readonly protocol: string;
  /** 建立连接并完成订阅;失败时抛错,由会话按退避策略重试。 */
  start(): Promise<void>;
  /** 释放连接对象与全部监听器;幂等。 */
  dispose(): Promise<void>;
  onSample(listener: (sample: SourceSample) => void): () => void;
  onLifecycle(listener: (event: SourceLifecycleEvent) => void): () => void;
  /** 适配器自身的解析失败等计数(不含在会话统计里的部分)。 */
  stats(): Record<string, number>;
}

/**
 * (重)连时交给 sourceFactory 的恢复上下文:
 * - 首次连接:checkpointStore 已加载的持久化位置(无 checkpoint 时两项均为 null);
 * - 退避重连:会话当前停留位置(断线前最后发布的样本)。
 * 无序列号语义的协议(MQTT)可忽略;OPC UA 等以时间戳为序的协议用它播种
 * 断线区间的缺口估计,避免重建实例后计数器从头开始导致旧样本被误放行。
 */
export interface SourceResumeContext {
  lastSequence: number | null;
  lastTimestamp: string | null;
}

export type SourceFactory = (resume: SourceResumeContext) => Promise<SubscriptionSource>;

/** 断点续传检查点:持久化"已确认收到"的源位置。 */
export interface SubscriptionCheckpoint {
  connectionId: string;
  generation: number;
  lastSequence: number | null;
  lastTimestamp: string | null;
  updatedAt: string;
}

export interface CheckpointStore {
  load(connectionId: string): Promise<SubscriptionCheckpoint | null>;
  save(checkpoint: SubscriptionCheckpoint): Promise<void>;
  clear(connectionId: string): Promise<void>;
}

/** 内存版 checkpoint;进程重启即失效——进程级持久化由 FileCheckpointStore 承担。 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly entries = new Map<string, SubscriptionCheckpoint>();

  async load(connectionId: string): Promise<SubscriptionCheckpoint | null> {
    return this.entries.get(connectionId) ?? null;
  }

  async save(checkpoint: SubscriptionCheckpoint): Promise<void> {
    this.entries.set(checkpoint.connectionId, { ...checkpoint });
  }

  async clear(connectionId: string): Promise<void> {
    this.entries.delete(connectionId);
  }

  size(): number {
    return this.entries.size;
  }
}

export interface BackoffPolicy {
  /** 首次重连延迟。 */
  baseMs: number;
  /** 延迟上限;7×24 语义下重试永不放弃,只封顶延迟。 */
  maxMs: number;
  /** 指数底数。 */
  factor: number;
  /** 抖动注入(返回追加毫秒);默认 0 便于确定性测试,生产可传随机抖动。 */
  jitterMs: (attempt: number) => number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitterMs: () => 0,
};

export interface GapWindow {
  fromSequence: number | null;
  toSequence: number | null;
  estimatedCount: number | null;
  fromTime: string;
  sequenceKnown: boolean;
  detectedAt: string;
}

export interface PersistentSubscriptionOptions {
  connectionId: string;
  projectId: string;
  protocol: string;
  sourceFactory: SourceFactory;
  /** SourceSample → DataEvent 投影(由各协议适配侧提供映射)。 */
  project: (sample: SourceSample) => DataEvent;
  /** 会话产出的事件出口(生产侧接到 DataEventBus.publish)。 */
  onEvent: (event: DataEvent) => void;
  /** 缺口报告出口(恢复对账时触发)。 */
  onGapReport?: (report: DataSubscriptionGapReport) => void;
  checkpointStore?: CheckpointStore;
  backoff?: Partial<BackoffPolicy>;
  /** 无序列号源的内容去重窗口;默认 250ms,与既有 MqttIngestSession 一致。 */
  dedupeWindowMs?: number;
  /** 缺口报告保留上限(有界内存);默认 100。 */
  maxGapReports?: number;
  now?: () => number;
}

export interface SubscriptionAudit {
  reconnectTimers: number;
  activeSources: number;
  sourceListeners: number;
  gapReports: number;
  trackedTopics: number;
  lifecycleListeners: number;
}

/**
 * 持久订阅会话。
 *
 * 序列对账规则(源有序列号时):
 * - seq == last+1 → 连续,发布并推进 checkpoint;
 * - seq <= last   → 重复/旧样本,幂等丢弃(deduplicated++),绝不重复发布;
 * - seq >  last+1 → [last+1, seq-1] 记为缺口并输出报告,然后发布新样本——不阻塞新鲜数据。
 * 源无序列号时:断线恢复后的首条样本触发 sequenceKnown=false 的缺口报告,
 * 声明断线区间完整性未知,而非假装连续。
 */
export class PersistentSubscriptionSession {
  private lifecycle: DataSubscriptionLifecycle = "idle";
  private generation = 0;
  private activeSource: SubscriptionSource | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private disposedSources = 0;

  private readonly stats = {
    received: 0,
    published: 0,
    deduplicated: 0,
    droppedOutOfOrder: 0,
    parseFailures: 0,
    reconnects: 0,
  };
  private lastSequence: number | null = null;
  private lastTimestamp: string | null = null;
  private lastMessageAt: string | undefined;
  private lastError: string | undefined;
  private nextReconnectAt: string | null = null;
  private attempt = 0;
  private awaitingResync = false;
  private disconnectReason: string | undefined;

  /** 有界的缺口窗口记录(检测即记录;与已确认的报告一一对应)。 */
  private readonly gapReports: DataSubscriptionGapReport[] = [];
  private gapReportsTruncated = 0;
  /** 无序列号源的指纹去重表(有界清理)。 */
  private readonly seenFingerprints = new Map<string, number>();
  /** 每主题的源时间戳水位(乱序丢弃判定)。 */
  private readonly topicWatermarks = new Map<string, number>();
  /** 每主题的序列水位(多主题场景按 topic 独立对账)。 */
  private readonly topicSequences = new Map<string, number>();
  private readonly unwinders: Array<() => void> = [];
  private readonly backoff: BackoffPolicy;
  private readonly checkpointStore: CheckpointStore;
  private readonly now: () => number;
  private readonly dedupeWindowMs: number;
  private readonly maxGapReports: number;

  constructor(private readonly options: PersistentSubscriptionOptions) {
    this.now = options.now ?? Date.now;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.checkpointStore = options.checkpointStore ?? new InMemoryCheckpointStore();
    this.dedupeWindowMs = options.dedupeWindowMs ?? 250;
    this.maxGapReports = options.maxGapReports ?? 100;
  }

  /** 订阅建立(首次或手动恢复调用;重连由内部退避循环驱动)。 */
  async start(): Promise<void> {
    if (this.stopped) throw new Error(`订阅会话已停止,不可重启(${this.options.connectionId});请通过注册表重新 start`);
    if (this.lifecycle !== "idle") return;
    this.lifecycle = "starting";
    const checkpoint = await this.checkpointStore.load(this.options.connectionId);
    if (checkpoint) {
      this.generation = checkpoint.generation;
      this.lastSequence = checkpoint.lastSequence;
      this.lastTimestamp = checkpoint.lastTimestamp;
      // 有历史位置说明是恢复运行:首轮就绪后必须对账。
      this.awaitingResync = true;
    }
    await this.connectSource();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const unwind of this.unwinders.splice(0)) unwind();
    const source = this.activeSource;
    this.activeSource = undefined;
    if (source) {
      await source.dispose();
      this.disposedSources += 1;
    }
    await this.persistCheckpoint();
    this.lifecycle = "stopped";
    this.nextReconnectAt = null;
  }

  snapshot(): DataSubscriptionStatus {
    return {
      connectionId: this.options.connectionId,
      projectId: this.options.projectId,
      protocol: this.options.protocol,
      lifecycle: this.lifecycle,
      generation: this.generation,
      ...this.stats,
      gapReports: [...this.gapReports],
      gapReportsTruncated: this.gapReportsTruncated,
      lastSequence: this.lastSequence,
      lastTimestamp: this.lastTimestamp,
      nextReconnectAt: this.nextReconnectAt,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      ...(this.lastMessageAt !== undefined ? { lastMessageAt: this.lastMessageAt } : {}),
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  gapReportList(): DataSubscriptionGapReport[] {
    return [...this.gapReports];
  }

  /**
   * 泄漏防护审计:取消后所有计数必须归零——测试直接断言本返回值。
   */
  audit(): SubscriptionAudit {
    return {
      reconnectTimers: this.reconnectTimer ? 1 : 0,
      activeSources: this.activeSource ? 1 : 0,
      sourceListeners: this.unwinders.length,
      gapReports: this.gapReports.length,
      trackedTopics: this.topicSequences.size + this.topicWatermarks.size + this.seenFingerprints.size,
      lifecycleListeners: this.unwinders.length,
    };
  }

  disposedSourceCount(): number {
    return this.disposedSources;
  }

  private async connectSource(): Promise<void> {
    let source: SubscriptionSource;
    try {
      source = await this.options.sourceFactory({ lastSequence: this.lastSequence, lastTimestamp: this.lastTimestamp });
    } catch (error) {
      this.scheduleReconnect(`source factory 失败: ${errorMessage(error)}`);
      return;
    }
    if (this.stopped) {
      await source.dispose();
      this.disposedSources += 1;
      return;
    }
    // 生成防护:重连期间若已有新源接管,立即丢弃旧源。
    if (this.activeSource) {
      await this.activeSource.dispose();
      this.disposedSources += 1;
    }
    this.activeSource = source;
    this.unwinders.push(
      source.onSample((sample) => {
        if (this.activeSource !== source || this.stopped) return;
        this.handleSample(sample);
      }),
      source.onLifecycle((event) => {
        if (this.activeSource !== source || this.stopped) return;
        this.handleLifecycle(event);
      }),
    );
    try {
      await source.start();
    } catch (error) {
      this.lastError = errorMessage(error);
      await this.dropSource();
      this.scheduleReconnect(`订阅建立失败: ${this.lastError}`);
    }
  }

  private handleLifecycle(event: SourceLifecycleEvent): void {
    if (event.kind === "ready") {
      this.attempt = 0;
      this.nextReconnectAt = null;
      this.generation += 1;
      this.stats.reconnects += this.lifecycle === "reconnecting" ? 1 : 0;
      this.lifecycle = "healthy";
      // 恢复后首条样本前先标记待对账;若断线期间无序列号,将以未知完整性上报。
      if (this.disconnectReason !== undefined) this.awaitingResync = true;
      this.disconnectReason = undefined;
      return;
    }
    if (event.kind === "invalid-sample") {
      this.stats.parseFailures += 1;
      this.lastError = event.reason;
      return;
    }
    // disconnected:立刻进入退避重连,不等 broker 心跳。
    this.lifecycle = "reconnecting";
    this.disconnectReason = event.reason;
    this.lastError = event.reason ?? this.lastError;
    this.scheduleReconnect(event.reason ?? "源断开");
  }

  private handleSample(sample: SourceSample): void {
    if (this.lifecycle === "idle" || this.lifecycle === "starting" || this.lifecycle === "stopped") return;
    this.stats.received += 1;
    const receivedAt = this.now();

    if (sample.sequence !== undefined) {
      // 有序列号的源:序列即权威顺序,直接按序列对账(不做时间水位丢弃,两类判序不混用)。
      // checkpoint 恢复后 topicSequences 为空:用全局 lastSequence 播种首个样本的topic 水位,
      // 保证重启/重连后旧样本仍被幂等丢弃。
      const seeded = this.topicSequences.size === 0 && this.lastSequence !== null ? this.lastSequence : undefined;
      const lastTopicSequence = this.topicSequences.get(sample.topic) ?? seeded;
      if (lastTopicSequence !== undefined) {
        if (sample.sequence <= lastTopicSequence) {
          // 断点续传幂等:重复或迟到的旧样本直接丢弃,不重复发布。
          this.stats.deduplicated += 1;
          return;
        }
        if (sample.sequence > lastTopicSequence + 1) {
          this.recordGap({
            fromSequence: lastTopicSequence + 1,
            toSequence: sample.sequence - 1,
            estimatedCount: sample.sequence - lastTopicSequence - 1,
            fromTime: this.lastTimestamp ?? new Date(receivedAt).toISOString(),
            sequenceKnown: true,
          });
        }
      }
      this.topicSequences.set(sample.topic, sample.sequence);
      this.lastSequence = sample.sequence;
      this.awaitingResync = false;
    } else {
      // 无序列号源:内容指纹去重(broker 重发同 payload 的重放)。
      const fingerprint = createHash("sha256").update(`${sample.topic}\0${JSON.stringify(sample.value)}`).digest("hex");
      const previousSeenAt = this.seenFingerprints.get(fingerprint);
      if (previousSeenAt !== undefined && receivedAt - previousSeenAt <= this.dedupeWindowMs) {
        this.stats.deduplicated += 1;
        return;
      }
      this.seenFingerprints.set(fingerprint, receivedAt);
      for (const [key, at] of this.seenFingerprints) {
        if (receivedAt - at > this.dedupeWindowMs) this.seenFingerprints.delete(key);
      }
      if (this.awaitingResync) {
        // 源无序列号:无法量化丢失区间,如实声明完整性未知。
        this.recordGap({
          fromSequence: null,
          toSequence: null,
          estimatedCount: null,
          fromTime: this.lastTimestamp ?? new Date(receivedAt).toISOString(),
          sequenceKnown: false,
        });
      }
      this.awaitingResync = false;

      // 源时间戳水位:乱序旧样本丢弃(容差 5s),与既有摄取语义一致。
      const timestampMs = Date.parse(sample.timestamp);
      if (Number.isFinite(timestampMs)) {
        const watermark = this.topicWatermarks.get(sample.topic) ?? 0;
        if (timestampMs + 5_000 < watermark) {
          this.stats.droppedOutOfOrder += 1;
          return;
        }
        this.topicWatermarks.set(sample.topic, Math.max(watermark, timestampMs));
      }
    }

    let event: DataEvent;
    try {
      event = this.options.project(sample);
    } catch (error) {
      this.stats.parseFailures += 1;
      this.lastError = errorMessage(error);
      return;
    }
    this.lastTimestamp = sample.timestamp;
    this.lastMessageAt = new Date(receivedAt).toISOString();
    this.options.onEvent(event);
    this.stats.published += 1;
    void this.persistCheckpoint();
  }

  private recordGap(window: Omit<DataSubscriptionGapReport, "id" | "connectionId" | "toTime" | "detectedAt">): void {
    const detectedAt = new Date(this.now()).toISOString();
    const report: DataSubscriptionGapReport = {
      id: randomUUID(),
      connectionId: this.options.connectionId,
      ...window,
      toTime: detectedAt,
      detectedAt,
    };
    this.gapReports.push(report);
    if (this.gapReports.length > this.maxGapReports) {
      this.gapReports.splice(0, this.gapReports.length - this.maxGapReports);
      this.gapReportsTruncated += 1;
    }
    this.options.onGapReport?.(report);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.lifecycle = "reconnecting";
    this.lastError = reason;
    const attempt = this.attempt;
    this.attempt += 1;
    const exponential = Math.min(this.backoff.baseMs * this.backoff.factor ** attempt, this.backoff.maxMs);
    const delay = exponential + this.backoff.jitterMs(attempt);
    this.nextReconnectAt = new Date(this.now() + delay).toISOString();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnectNow();
    }, delay);
    // 允许进程自然退出:重连定时器不阻止 unref 语义下的关闭(测试环境除外)。
    (this.reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async reconnectNow(): Promise<void> {
    if (this.stopped) return;
    await this.dropSource();
    await this.connectSource();
  }

  private async dropSource(): Promise<void> {
    for (const unwind of this.unwinders.splice(0)) unwind();
    const source = this.activeSource;
    this.activeSource = undefined;
    if (!source) return;
    try {
      await source.dispose();
    } catch (error) {
      this.lastError = errorMessage(error);
    }
    this.disposedSources += 1;
  }

  private async persistCheckpoint(): Promise<void> {
    try {
      await this.checkpointStore.save({
        connectionId: this.options.connectionId,
        generation: this.generation,
        lastSequence: this.lastSequence,
        lastTimestamp: this.lastTimestamp,
        updatedAt: new Date(this.now()).toISOString(),
      });
    } catch (error) {
      this.lastError = `checkpoint 持久化失败: ${errorMessage(error)}`;
    }
  }
}

/**
 * 会话注册表:同一 id 的重复 start 先停旧会话并递增生成号;
 * stop/stopAll 全量释放(源 + 定时器 + 监听器),为泄漏防护提供唯一入口。
 */
export class SubscriptionRegistry {
  private readonly sessions = new Map<string, { session: PersistentSubscriptionSession; generation: number }>();

  async start(id: string, options: PersistentSubscriptionOptions): Promise<PersistentSubscriptionSession> {
    const existing = this.sessions.get(id);
    if (existing) {
      await existing.session.stop();
      this.sessions.delete(id);
    }
    const generation = (existing?.generation ?? 0) + 1;
    const session = new PersistentSubscriptionSession(options);
    this.sessions.set(id, { session, generation });
    try {
      await session.start();
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
    return session;
  }

  async stop(id: string): Promise<boolean> {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    this.sessions.delete(id);
    await entry.session.stop();
    return true;
  }

  async stopAll(): Promise<void> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(entries.map(async (entry) => entry.session.stop()));
  }

  get(id: string): PersistentSubscriptionSession | null {
    return this.sessions.get(id)?.session ?? null;
  }

  generation(id: string): number | null {
    return this.sessions.get(id)?.generation ?? null;
  }

  size(): number {
    return this.sessions.size;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
