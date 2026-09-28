/**
 * T24 OPC UA 切片:本地进程内模拟 server 联测(node-opcua 内嵌 server,非真实 PLC,如实声明)。
 *
 * 覆盖:正常订阅流(初始值通知→值变更/多节点)→ 断连检测(server.shutdown → connection_lost)→
 * 运行时既有退避重连 + 恢复对账(缺口报告 sequenceKnown:true/false 双路径)→ 泄漏审计。
 *
 * 确定性手段:源值经 setValueFromSource 显式携带受控 sourceTimestamp,写入间隔大于采样窗避免合并;
 * 恢复场景经测试内 TCP 代理注入断连(见恢复 describe 块说明),退避首试 3s 保证写入先于重连。
 */
import { describe, expect, it } from "vitest";
import type { DataEvent, DataSubscriptionGapReport } from "@bim-studio/contracts";
import {
  PersistentSubscriptionSession,
  InMemoryCheckpointStore,
  type SourceResumeContext,
} from "./subscriptionRuntime.js";
import { createOpcUaSubscriptionSource, projectOpcUaSample } from "./opcUaSubscriptionSource.js";

interface SimulatedServer {
  endpointUrl: string;
  boundPort: number;
  nodeId: string;
  addTag: (browseName: string, initial: number) => string;
  setValue: (nodeId: string, value: number, timestampMs?: number) => void;
  shutdown: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startSimulatedServer(port: number): Promise<SimulatedServer> {
  const { OPCUAServer, Variant, DataType, StatusCodes } = await import("node-opcua");
  const server = new OPCUAServer({ port });
  await server.initialize();
  const ns = server.engine.addressSpace.getOwnNamespace();
  const variables = new Map<string, { setValue: (value: number, timestampMs?: number) => void }>();
  const addTag = (browseName: string, initial: number): string => {
    const variable = ns.addVariable({
      organizedBy: server.engine.addressSpace.rootFolder.objects,
      browseName,
      dataType: "Double",
      value: new Variant({ dataType: DataType.Double, value: initial }),
    });
    variables.set(variable.nodeId.toString(), {
      setValue: (value, timestampMs) =>
        variable.setValueFromSource(new Variant({ dataType: DataType.Double, value }), StatusCodes.Good, timestampMs !== undefined ? new Date(timestampMs) : undefined),
    });
    return variable.nodeId.toString();
  };
  const firstNodeId = addTag("Tag1", 0);
  await server.start();
  // port=0 时内核分配临时端口:必须从 server 实际绑定地址解析,不能用入参。
  const boundPort = Number(new URL(server.getEndpointUrl().replace(/^opc\.tcp/i, "http")).port);
  return {
    endpointUrl: `opc.tcp://127.0.0.1:${boundPort}`,
    boundPort,
    nodeId: firstNodeId,
    addTag,
    setValue: (nodeId, value, timestampMs) => variables.get(nodeId)?.setValue(value, timestampMs),
    shutdown: () => server.shutdown(),
  };
}

/** 先起一个临时 server 占位拿空闲端口,关掉后把端口还给调用方。 */
async function reserveFreePort(): Promise<number> {
  const probe = await startSimulatedServer(0);
  const port = probe.boundPort;
  await probe.shutdown();
  return port;
}

function waitForCondition<T>(
  probe: () => T,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  stepMs = 100,
  label = "unlabeled",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const value = probe();
      if (predicate(value)) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`等待条件超时(${timeoutMs}ms): ${label}`));
        return;
      }
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

describe("OPC UA 模拟 server 联测:适配器层(真实内嵌 server)", () => {
  it("正常流:初始值通知 → 值变更 → 多节点独立;同值不产生新通知(源语义)", { timeout: 30_000 }, async () => {
    const port = await reserveFreePort();
    const server = await startSimulatedServer(port);
    const secondNodeId = server.addTag("Tag2", 0);
    const samples: string[] = [];
    let readyEvents = 0;
    const source = createOpcUaSubscriptionSource({
      endpointUrl: server.endpointUrl,
      nodeIds: [server.nodeId, secondNodeId],
      samplingIntervalMs: 50,
      publishingIntervalMs: 100,
    });
    source.onSample((sample) => samples.push(`${sample.topic}:${String(sample.value)}`));
    source.onLifecycle((event) => {
      if (event.kind === "ready") readyEvents += 1;
    });
    await source.start();
    expect(readyEvents).toBe(1);
    // 初始值通知(每节点一条)。
    await waitForCondition(() => samples.length, (length) => length >= 2, 10_000, 100, "初始值通知");
    server.setValue(server.nodeId, 11);
    server.setValue(secondNodeId, 22);
    await waitForCondition(() => samples.length, (length) => length >= 4, 10_000, 100, "值变更通知");
    await sleep(250);
    expect(samples.sort()).toEqual([
      `${server.nodeId}:0`,
      `${server.nodeId}:11`,
      `${secondNodeId}:0`,
      `${secondNodeId}:22`,
    ]);
    expect(source.stats().samplesEmitted).toBe(4);

    await source.dispose();
    await server.shutdown();
  });

  it("断连:server.shutdown → disconnected 生命周期(真实 socket 断开检测)", { timeout: 30_000 }, async () => {
    const port = await reserveFreePort();
    const server = await startSimulatedServer(port);
    const lifecycle: string[] = [];
    const source = createOpcUaSubscriptionSource({ endpointUrl: server.endpointUrl, nodeIds: [server.nodeId] });
    source.onLifecycle((event) => lifecycle.push(event.kind));
    await source.start();
    await server.shutdown();
    await waitForCondition(
      () => lifecycle.join(","),
      (joined) => joined.includes("disconnected"),
      10_000,
      100,
      "disconnected 生命周期",
    );
    expect(lifecycle).toEqual(["ready", "disconnected"]);
    await source.dispose();
  });
});

describe("OPC UA 模拟 server 联测:运行时恢复对账(退避重连 + 缺口报告)", () => {
  /**
   * 断连注入方式:模拟 server 常驻,客户端经测试内 TCP 代理连接;
   * 销毁代理上游 socket 即产生真实 TCP 断开(client 侧 connection_lost),
   * 恢复=运行时经同一代理重连到同一活 server——无 OS 端口重绑竞态。
   * 断线期间的"丢失更新"通过直接改写常驻 server 变量值模拟(重连后新订阅的首条通知即其当前值)。
   */
  async function runRecoveryScenario(options: { samplingIntervalMs?: number } = {}) {
    const { createServer, connect } = await import("node:net");
    type Socket = import("node:net").Socket;
    const server = await startSimulatedServer(0);
    const nodeId = server.nodeId;
    const upstreams = new Set<Socket>();
    const proxy = createServer((clientSocket) => {
      const upstream = connect(server.boundPort, "127.0.0.1");
      upstreams.add(upstream);
      const cleanup = () => {
        upstreams.delete(upstream);
        clientSocket.destroy();
        upstream.destroy();
      };
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      clientSocket.on("error", cleanup);
      upstream.on("error", cleanup);
      upstream.on("close", cleanup);
    });
    const proxyPort = await new Promise<number>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", () => {
        const address = proxy.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });

    const events: DataEvent[] = [];
    const gaps: DataSubscriptionGapReport[] = [];
    const checkpoints = new InMemoryCheckpointStore();
    const factories: SourceResumeContext[] = [];
    let disposedSources = 0;

    const session = new PersistentSubscriptionSession({
      connectionId: "plc-sim",
      projectId: "p1",
      protocol: "opcua",
      sourceFactory: async (resume) => {
        factories.push(resume);
        const source = createOpcUaSubscriptionSource({
          endpointUrl: `opc.tcp://127.0.0.1:${proxyPort}`,
          nodeIds: [nodeId],
          ...(options.samplingIntervalMs !== undefined ? { samplingIntervalMs: options.samplingIntervalMs } : {}),
          ...(resume.lastSequence !== null || resume.lastTimestamp !== null ? { resume } : {}),
        });
        const originalDispose = source.dispose.bind(source);
        source.dispose = async () => {
          disposedSources += 1;
          await originalDispose();
        };
        return source;
      },
      project: (sample) => projectOpcUaSample({ connectionId: "plc-sim", projectId: "p1" }, sample),
      onEvent: (event) => events.push(event),
      onGapReport: (report) => gaps.push(report),
      checkpointStore: checkpoints,
      // 首次重试 3s:重连发起前"销毁连接 + 写入断线期间更新"必已完成。
      backoff: { baseMs: 3_000, maxMs: 9_000, factor: 2, jitterMs: () => 0 },
    });
    await session.start();

    // 断线前:初始值通知(真实时钟)→ 写 1(未来 2s)→ 写 2(+100ms,连续)。
    // 声明了周期时,初始值→写 1 的时间跳变会被如实估计为一次流内缺口(正确行为);
    // 因此断言以断线前最后一条已发布事件(events[2])的序列与 server 盖章时间戳为基准。
    await waitForCondition(() => events.length, (length) => length >= 1, 10_000, 100, "初始值通知");
    const scenarioStart = Date.now();
    server.setValue(nodeId, 1, scenarioStart + 2_000);
    await sleep(250);
    server.setValue(nodeId, 2, scenarioStart + 2_100);
    await waitForCondition(() => events.length, (length) => length >= 3, 10_000, 100, "断线前 3 条事件");

    // 断线:销毁代理上游 socket(真实 TCP 断开)→ connection_lost → 运行时退避;
    // 同时在常驻 server 写入断线期间的更新(值 3),重连后新订阅首条通知即携带它。
    for (const upstream of [...upstreams]) upstream.destroy();
    const lostUpdateAt = scenarioStart + 2_700;
    server.setValue(nodeId, 3, lostUpdateAt);
    await waitForCondition(
      () => session.snapshot().lifecycle,
      (lifecycle) => lifecycle === "reconnecting",
      10_000, 100, "断线进入退避",
    );
    await waitForCondition(
      () => session.snapshot().lifecycle,
      (lifecycle) => lifecycle === "healthy",
      20_000, 100, "恢复 healthy",
    );
    await waitForCondition(() => events.length, (length) => length >= 4, 10_000, 100, "恢复后事件");
    await session.stop();
    proxy.close();
    await server.shutdown();

    return { events, gaps, factories, disposedSources, session, lostUpdateAt };
  }

  it("声明更新周期:恢复后首样本按时间差跳号,缺口报告 sequenceKnown:true", { timeout: 60_000 }, async () => {
    const { events, gaps, factories, disposedSources, session, lostUpdateAt } = await runRecoveryScenario({ samplingIntervalMs: 100 });
    // 断线前最后一条已发布样本:S(序列)与 checkpoint 时间戳(server 原样盖章)。
    const lastPreDisconnect = events[2];
    const checkpointTimestampMs = Date.parse(lastPreDisconnect.timestamp);
    const s = lastPreDisconnect.sequence as number;
    // 初始值(真实时钟)→ 写 1 的跳变被如实估计为一次流内缺口(缺失量取决于起动时刻,不断言数值)。
    expect(gaps).toHaveLength(2);
    expect(gaps[0].fromSequence).toBe(2);
    expect(gaps[0].sequenceKnown).toBe(true);
    // 恢复后首样本:Δ(checkpoint 基准 → 断线期间更新 +2.7s)=600ms → 估计 5 点丢失 → S+5+1。
    expect(events[3].sequence).toBe(s + 6);
    expect(Date.parse(events[3].timestamp)).toBe(lostUpdateAt);
    expect(gaps[1]).toMatchObject({
      connectionId: "plc-sim",
      fromSequence: s + 1,
      toSequence: s + 5,
      estimatedCount: 5,
      sequenceKnown: true,
    });
    expect(Date.parse(gaps[1].fromTime)).toBe(checkpointTimestampMs);
    // 重连工厂拿到了运行时注入的恢复位置(checkpoint 语义)。
    expect(factories.at(-1)).toMatchObject({ lastSequence: s, lastTimestamp: lastPreDisconnect.timestamp });
    // 泄漏审计:结构资源全零;两个源实例(初始 + 恢复)均被 dispose。
    expect(session.audit()).toMatchObject({ reconnectTimers: 0, activeSources: 0, sourceListeners: 0 });
    expect(disposedSources).toBeGreaterThanOrEqual(2);
  });

  it("未声明周期:恢复后首样本降级无序列,缺口报告 sequenceKnown:false(完整性未知)", { timeout: 60_000 }, async () => {
    const { events, gaps, session, lostUpdateAt } = await runRecoveryScenario();
    // 无周期声明:时间跳变不伪造缺失量,流内序列连续 1,2,3;恢复后首样本无序列。
    expect(events).toHaveLength(4);
    expect(events.slice(0, 3).map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events[3].sequence).toBeUndefined();
    expect(Date.parse(events[3].timestamp)).toBe(lostUpdateAt);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      fromSequence: null,
      toSequence: null,
      estimatedCount: null,
      sequenceKnown: false,
    });
    expect(Date.parse(gaps[0].fromTime)).toBe(Date.parse(events[2].timestamp));
    expect(session.audit()).toMatchObject({ reconnectTimers: 0, activeSources: 0, sourceListeners: 0 });
  });
});
