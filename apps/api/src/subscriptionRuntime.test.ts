import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataEvent, DataSubscriptionGapReport } from "@bim-studio/contracts";
import {
  InMemoryCheckpointStore,
  PersistentSubscriptionSession,
  SubscriptionRegistry,
  type PersistentSubscriptionOptions,
  type SourceFactory,
  type SourceResumeContext,
  type SourceLifecycleEvent,
  type SourceSample,
  type SubscriptionSource,
} from "./subscriptionRuntime.js";

/**
 * 可编程的内存源:测试直接驱动 ready/disconnected/样本事件,
 * 退避用假定时器推进,全程确定性、无真实网络。
 */
class ScriptedSource implements SubscriptionSource {
  readonly protocol = "scripted";
  startCount = 0;
  disposeCount = 0;
  startImpl: () => Promise<void> = async () => {
    this.startCount += 1;
  };
  private readonly sampleListeners = new Set<(sample: SourceSample) => void>();
  private readonly lifecycleListeners = new Set<(event: SourceLifecycleEvent) => void>();

  start(): Promise<void> {
    return this.startImpl();
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }

  onSample(listener: (sample: SourceSample) => void): () => void {
    this.sampleListeners.add(listener);
    return () => this.sampleListeners.delete(listener);
  }

  onLifecycle(listener: (event: SourceLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  stats(): Record<string, number> {
    return {};
  }

  emitSample(sample: SourceSample): void {
    for (const listener of this.sampleListeners) listener(sample);
  }

  emitLifecycle(event: SourceLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) listener(event);
  }
}

function harness(overrides: { checkpointStore?: InMemoryCheckpointStore } = {}) {
  const sources: ScriptedSource[] = [];
  const resumeCalls: SourceResumeContext[] = [];
  const factory: SourceFactory = async (resume) => {
    resumeCalls.push(resume);
    const source = new ScriptedSource();
    sources.push(source);
    return source;
  };
  const events: DataEvent[] = [];
  const gaps: DataSubscriptionGapReport[] = [];
  const baseTime = Date.parse("2026-09-27T00:00:00.000Z");
  let tick = 0;
  const options: PersistentSubscriptionOptions = {
    connectionId: "conn-1",
    projectId: "project-1",
    protocol: "scripted",
    sourceFactory: factory,
    project: (sample) => ({
      id: `evt-${sample.sequence ?? sample.timestamp}`,
      projectId: "project-1",
      source: "scripted/conn-1",
      key: sample.topic,
      value: sample.value,
      timestamp: sample.timestamp,
      ...(sample.sequence !== undefined ? { sequence: sample.sequence } : {}),
    }),
    onEvent: (event) => events.push(event),
    onGapReport: (report) => gaps.push(report),
    checkpointStore: overrides.checkpointStore ?? new InMemoryCheckpointStore(),
    backoff: { baseMs: 10, factor: 2 },
    now: () => baseTime + tick++,
  };
  const session = new PersistentSubscriptionSession(options);
  return { session, options, sources, events, gaps, resumeCalls };
}

const sample = (sequence: number, topic = "t/1", timestamp = new Date(Date.parse("2026-09-27T00:00:00.000Z") + sequence * 1000).toISOString()): SourceSample => ({
  topic,
  value: { v: sequence },
  timestamp,
  sequence,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PersistentSubscriptionSession 生命周期", () => {
  it("订阅建立 → 样本发布 → checkpoint 持久化", async () => {
    const { session, sources, events } = harness();
    await session.start();
    expect(sources).toHaveLength(1);
    sources[0].emitLifecycle({ kind: "ready" });
    expect(session.snapshot()).toMatchObject({ lifecycle: "healthy", generation: 1 });
    sources[0].emitSample(sample(1));
    sources[0].emitSample(sample(2));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ sequence: 1, key: "t/1" });
    expect(session.snapshot()).toMatchObject({ published: 2, lastSequence: 2 });
    await session.stop();
  });

  it("断线 → 指数退避(10/20/40ms)→ 订阅恢复 → reconnects 计数", async () => {
    const { session, sources } = harness();
    await session.start();
    sources[0].emitLifecycle({ kind: "ready" });

    sources[0].emitLifecycle({ kind: "disconnected", reason: "broker 掉线" });
    expect(session.snapshot().lifecycle).toBe("reconnecting");
    expect(session.snapshot().nextReconnectAt).not.toBeNull();

    // 第 1 次重连延迟 baseMs * factor^0 = 10ms
    await vi.advanceTimersByTimeAsync(10);
    expect(sources).toHaveLength(2);
    sources[1].emitLifecycle({ kind: "disconnected", reason: "又断了" });

    // 第 2 次 = 10 * 2 = 20ms
    await vi.advanceTimersByTimeAsync(20);
    expect(sources).toHaveLength(3);
    sources[2].emitLifecycle({ kind: "disconnected", reason: "第三次" });

    // 第 3 次 = 10 * 2^2 = 40ms
    await vi.advanceTimersByTimeAsync(40);
    expect(sources).toHaveLength(4);
    sources[3].emitLifecycle({ kind: "ready" });
    const status = session.snapshot();
    expect(status).toMatchObject({ lifecycle: "healthy", reconnects: 1 });
    expect(status.nextReconnectAt).toBeNull();
    await session.stop();
  });

  it("source.start 抛错同样进入退避,不放弃(7×24 语义)", async () => {
    const sources: ScriptedSource[] = [];
    const events: DataEvent[] = [];
    let firstCall = true;
    const session = new PersistentSubscriptionSession({
      connectionId: "conn-2",
      projectId: "project-1",
      protocol: "scripted",
      sourceFactory: async () => {
        const source = new ScriptedSource();
        if (firstCall) {
          firstCall = false;
          source.startImpl = async () => {
            source.startCount += 1;
            throw new Error("连接被拒");
          };
        }
        sources.push(source);
        return source;
      },
      project: (s) => ({ id: "x", projectId: "p", source: "s", key: s.topic, value: s.value, timestamp: s.timestamp }),
      onEvent: (event) => events.push(event),
      backoff: { baseMs: 5 },
    });
    await session.start();
    expect(session.snapshot().lifecycle).toBe("reconnecting");
    expect(sources[0].disposeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(5);
    sources[1].emitLifecycle({ kind: "ready" });
    expect(session.snapshot()).toMatchObject({ lifecycle: "healthy" });
    await session.stop();
  });

  it("旧源在重连后被 dispose,旧源的迟到样本被忽略", async () => {
    const { session, sources, events } = harness();
    await session.start();
    sources[0].emitLifecycle({ kind: "ready" });
    sources[0].emitLifecycle({ kind: "disconnected" });
    await vi.advanceTimersByTimeAsync(10);
    sources[1].emitLifecycle({ kind: "ready" });
    expect(sources[0].disposeCount).toBe(1);
    sources[0].emitSample(sample(99));
    expect(events).toHaveLength(0);
    sources[1].emitSample(sample(1));
    expect(events).toHaveLength(1);
    await session.stop();
  });
});

describe("断点续传语义(缺口报告/幂等)", () => {
  it("恢复后序列跳变 → 输出缺口报告 [last+1, seq-1] 并继续发布新样本", async () => {
    const { session, sources, events, gaps } = harness();
    await session.start();
    sources[0].emitLifecycle({ kind: "ready" });
    sources[0].emitSample(sample(1));
    sources[0].emitSample(sample(2));
    sources[0].emitLifecycle({ kind: "disconnected", reason: "broker 掉线" });
    await vi.advanceTimersByTimeAsync(10);
    sources[1].emitLifecycle({ kind: "ready" });
    sources[1].emitSample(sample(5));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ connectionId: "conn-1", fromSequence: 3, toSequence: 4, estimatedCount: 2, sequenceKnown: true });
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 5]);
    expect(session.snapshot()).toMatchObject({ published: 3, deduplicated: 0 });
    await session.stop();
  });

  it("重复消息幂等:流内与恢复后 seq <= last 均不重复发布", async () => {
    const { session, sources, events } = harness();
    await session.start();
    sources[0].emitLifecycle({ kind: "ready" });
    sources[0].emitSample(sample(1));
    sources[0].emitSample(sample(2));
    sources[0].emitSample(sample(2));
    sources[0].emitSample(sample(1));
    sources[0].emitLifecycle({ kind: "disconnected" });
    await vi.advanceTimersByTimeAsync(10);
    sources[1].emitLifecycle({ kind: "ready" });
    sources[1].emitSample(sample(2));
    sources[1].emitSample(sample(3));
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(session.snapshot()).toMatchObject({ deduplicated: 3 });
    await session.stop();
  });

  it("流内跳变同样记录缺口(不阻塞新鲜数据)", async () => {
    const { session, sources, gaps } = harness();
    await session.start();
    sources[0].emitLifecycle({ kind: "ready" });
    sources[0].emitSample(sample(1));
    sources[0].emitSample(sample(10));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ fromSequence: 2, toSequence: 9, estimatedCount: 8 });
    await session.stop();
  });

  it("无序列号源:恢复后输出完整性未知的缺口报告,不伪造连续性", async () => {
    const { session, sources, gaps, events } = harness();
    await session.start();
    sources[0].emitLifecycle({ kind: "ready" });
    sources[0].emitSample({ topic: "t/1", value: 1, timestamp: "2026-09-27T00:00:01.000Z" });
    sources[0].emitLifecycle({ kind: "disconnected", reason: "掉线" });
    await vi.advanceTimersByTimeAsync(10);
    sources[1].emitLifecycle({ kind: "ready" });
    sources[1].emitSample({ topic: "t/1", value: 2, timestamp: "2026-09-27T00:00:30.000Z" });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ fromSequence: null, toSequence: null, estimatedCount: null, sequenceKnown: false });
    expect(events).toHaveLength(2);
    await session.stop();
  });

  it("checkpoint 恢复:新会话基于持久化位置幂等丢弃旧样本并对账缺口", async () => {
    const checkpointStore = new InMemoryCheckpointStore();
    const first = harness({ checkpointStore });
    await first.session.start();
    first.sources[0].emitLifecycle({ kind: "ready" });
    first.sources[0].emitSample(sample(5));
    await first.session.stop();
    expect(await checkpointStore.load("conn-1")).toMatchObject({ lastSequence: 5 });

    const second = harness({ checkpointStore });
    await second.session.start();
    second.sources[0].emitLifecycle({ kind: "ready" });
    second.sources[0].emitSample(sample(4));
    second.sources[0].emitSample(sample(9));
    expect(second.events.map((event) => event.sequence)).toEqual([9]);
    expect(second.gaps).toHaveLength(1);
    expect(second.gaps[0]).toMatchObject({ fromSequence: 6, toSequence: 8, estimatedCount: 3 });
    expect(second.session.snapshot().deduplicated).toBe(1);
    await second.session.stop();
  });

  it("缺口报告有界:超过上限合并计数,不随时间无界增长", async () => {
    const { session, sources } = harness();
    await session.start();
    sources[0].emitLifecycle({ kind: "ready" });
    let seq = 1;
    for (let i = 0; i < 250; i += 1) {
      sources[0].emitSample(sample(seq));
      seq += 10;
    }
    const status = session.snapshot();
    expect(status.gapReports).toHaveLength(100);
    expect(status.gapReportsTruncated).toBeGreaterThan(0);
    await session.stop();
  });
});

describe("sourceFactory 恢复上下文(OPC UA 等时间戳序列源依赖)", () => {
  it("首次连接携带 checkpoint 位置;断线重连携带会话当前位置", async () => {
    vi.useFakeTimers();
    const store = new InMemoryCheckpointStore();
    await store.save({
      connectionId: "conn-1",
      generation: 4,
      lastSequence: 42,
      lastTimestamp: "2026-09-26T23:59:59.000Z",
      updatedAt: "2026-09-26T23:59:59.000Z",
    });
    const h = harness({ checkpointStore: store });
    await h.session.start();
    // 首连:checkpoint 已加载,工厂拿到恢复位置。
    expect(h.resumeCalls[0]).toEqual({ lastSequence: 42, lastTimestamp: "2026-09-26T23:59:59.000Z" });
    h.sources[0].emitLifecycle({ kind: "ready" });
    h.sources[0].emitSample(sample(43));
    h.sources[0].emitLifecycle({ kind: "disconnected", reason: "测试断开" });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.sources.length).toBeGreaterThanOrEqual(2);
    // 重连:工厂拿到断线前最后发布位置。
    expect(h.resumeCalls.at(-1)).toEqual({ lastSequence: 43, lastTimestamp: expect.any(String) });
    // 泄漏防护:清理后归零。
    await h.session.stop();
    vi.useRealTimers();
  });

  it("无 checkpoint 时首连上下文为 null 位", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.start();
    expect(h.resumeCalls[0]).toEqual({ lastSequence: null, lastTimestamp: null });
    await h.session.stop();
    vi.useRealTimers();
  });
});

describe("泄漏防护与注册表", () => {
  it("stop 后:审计归零、迟到样本被忽略、重连定时器不再触发", async () => {
    const { session, sources, events } = harness();
    await session.start();
    sources[0].emitLifecycle({ kind: "ready" });
    sources[0].emitLifecycle({ kind: "disconnected" });
    await session.stop();
    expect(session.audit()).toEqual({
      reconnectTimers: 0,
      activeSources: 0,
      sourceListeners: 0,
      gapReports: 0,
      trackedTopics: 0,
      lifecycleListeners: 0,
    });
    expect(session.disposedSourceCount()).toBe(1);
    const factoryCallsBefore = sources.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources).toHaveLength(factoryCallsBefore);
    sources[0].emitSample(sample(1));
    expect(events).toHaveLength(0);
    expect(session.snapshot().lifecycle).toBe("stopped");
  });

  it("注册表生成号:同 id 重启递增 generation 并停掉旧会话", async () => {
    const registry = new SubscriptionRegistry();
    const first = harness();
    const second = harness();
    await registry.start("conn-1", first.options);
    const firstRegistrySession = registry.get("conn-1")!;
    expect(registry.generation("conn-1")).toBe(1);
    await registry.start("conn-1", second.options);
    expect(registry.generation("conn-1")).toBe(2);
    // 旧的注册表会话已被 stop(生成号治理)。
    expect(firstRegistrySession.snapshot().lifecycle).toBe("stopped");
    expect(firstRegistrySession.audit().activeSources).toBe(0);
    expect(registry.get("conn-1")).not.toBe(firstRegistrySession);
    // 新会话已建立连接,等待源 ready 事件前的生命周期是 starting;就绪后 healthy。
    expect(registry.get("conn-1")!.snapshot().lifecycle).toBe("starting");
    second.sources[0].emitLifecycle({ kind: "ready" });
    expect(registry.get("conn-1")!.snapshot().lifecycle).toBe("healthy");
    await registry.stopAll();
    expect(registry.size()).toBe(0);
    expect(registry.get("conn-1")).toBeNull();
  });

  it("stopAll 释放全部会话(源 dispose + 审计归零)", async () => {
    const registry = new SubscriptionRegistry();
    const a = harness();
    const b = harness();
    await registry.start("a", a.options);
    await registry.start("b", b.options);
    const sessionA = registry.get("a")!;
    const sessionB = registry.get("b")!;
    await registry.stopAll();
    expect(a.sources[0].disposeCount).toBe(1);
    expect(b.sources[0].disposeCount).toBe(1);
    expect(sessionA.audit().activeSources).toBe(0);
    expect(sessionB.audit().activeSources).toBe(0);
    expect(sessionA.snapshot().lifecycle).toBe("stopped");
    expect(sessionB.snapshot().lifecycle).toBe("stopped");
    expect(registry.size()).toBe(0);
  });
});

describe("7×24 压测(10k+ 消息循环)", () => {
  it("10k 消息 + 25 轮断线/恢复循环:计数精确、缺口对账正确、泄漏指标归零", async () => {
    const { session, sources, events, gaps } = harness();
    await session.start();
    sources[0].emitLifecycle({ kind: "ready" });

    let seq = 1;
    let published = 0;
    const totalCycles = 25;
    const perCycle = 400;
    const heapStart = process.memoryUsage().heapUsed;
    for (let cycle = 0; cycle < totalCycles; cycle += 1) {
      const active = sources[sources.length - 1];
      for (let i = 0; i < perCycle; i += 1) {
        active.emitSample(sample(seq));
        seq += 1;
        published += 1;
      }
      active.emitLifecycle({ kind: "disconnected", reason: `循环掉线 #${cycle}` });
      await vi.advanceTimersByTimeAsync(10);
      const next = sources[sources.length - 1];
      next.emitLifecycle({ kind: "ready" });
      // 恢复后序列跳变 3:首轮前无缺口,此后每轮对账一份缺口报告
      if (cycle > 0) {
        next.emitSample(sample(seq + 3));
        seq += 4;
        published += 1;
      }
    }
    const status = session.snapshot();
    expect(status.published).toBe(published);
    expect(events).toHaveLength(published);
    expect(status.received).toBe(published);
    expect(status.reconnects).toBe(totalCycles);
    expect(gaps).toHaveLength(totalCycles - 1);
    expect(gaps[0]).toMatchObject({ estimatedCount: 3, sequenceKnown: true });
    // 结构有界:缺口窗口封顶 100 内、无重连定时器残留、活跃源恰 1 个、监听器恒为 2(样本+生命周期)
    expect(status.gapReports.length).toBeLessThanOrEqual(100);
    expect(session.audit()).toMatchObject({ reconnectTimers: 0, activeSources: 1, sourceListeners: 2, trackedTopics: 1 });
    await session.stop();
    expect(session.audit().activeSources).toBe(0);
    const heapEnd = process.memoryUsage().heapUsed;
    // 真实断言在内部结构有界(上方);heap 差值仅记录用于报告(GC 时机不可控,不作硬断言)
    void heapStart;
    void heapEnd;
  }, 30_000);

  it("20k 消息单轮灌入(含 200 条重复穿插):幂等路径高频执行,内部结构 O(1)", async () => {
    const { session, sources, events } = harness();
    await session.start();
    sources[0].emitLifecycle({ kind: "ready" });
    // process.hrtime 不受 vi.useFakeTimers 影响,给出真实耗时
    const startedAt = process.hrtime.bigint();
    for (let seq = 1; seq <= 20_000; seq += 1) {
      sources[0].emitSample(sample(seq));
      if (seq % 100 === 0) sources[0].emitSample(sample(seq));
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    expect(events).toHaveLength(20_000);
    expect(session.snapshot().deduplicated).toBe(200);
    expect(session.audit().trackedTopics).toBeLessThanOrEqual(2);
    expect(elapsedMs).toBeLessThan(20_000);
    await session.stop();
  }, 30_000);
});
