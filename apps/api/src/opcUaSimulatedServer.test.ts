/**
 * T24 OPC UA 切片:本地进程内模拟 server 联测(node-opcua 内嵌 server,非真实 PLC,如实声明)。
 *
 * 覆盖:正常订阅流(初始值通知→值变更/多节点)→ 断连检测(server.shutdown → connection_lost)→
 * 运行时既有退避重连 + 恢复对账(缺口报告 sequenceKnown:true/false 双路径)→ 泄漏审计。
 *
 * 确定性手段:源值经 setValueFromSource 显式携带受控 sourceTimestamp,写入间隔大于采样窗避免合并;
 * 恢复场景经测试内 TCP 代理注入断连(见恢复 describe 块说明),退避首试 3s 保证写入先于重连。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DataEvent, DataSubscriptionGapReport } from "@bim-studio/contracts";
import { MessageSecurityMode, SecurityPolicy } from "node-opcua-client";
import {
  PersistentSubscriptionSession,
  InMemoryCheckpointStore,
  type SourceResumeContext,
} from "./subscriptionRuntime.js";
import {
  createOpcUaSubscriptionSource,
  describeOpcUaSubscriptionSupport,
  projectOpcUaSample,
} from "./opcUaSubscriptionSource.js";
// 模拟 server harness 已抽至测试支持模块(2026-10-02 previewOpcUa 联动批),逐字搬移零行为变化。
import {
  reserveFreePort,
  sleep,
  startSimulatedServer,
  waitForCondition,
  type SimulatedServer,
} from "./opcUaSimulatedServer.js";

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

describe("OPC UA 模拟 server 联测:安全订阅接线(Sign + Basic256Sha256 端到端)", () => {
  /**
   * T24 接线验收:secure server(securityPolicies 声明 Basic256Sha256)↔ security 订阅源(默认签名客户端)。
   * 注(2026-10-02 preview 联动批实证):node-opcua 2.178 下该 server 仍恒声明 None 端点
   * (findMatchingEndpoints = None|None + Sign|SignAndEncrypt|Basic256Sha256),"None 客户端被拒"
   * 不成立——本用例的有效证据是下方 server 侧协商通道恒等断言(连接存活期观测),非端点声明面。
   * - 数据面:签名通道上 ≥3 个数据点(初始值 + 值变更,值逐点断言);
   * - 安全面:server 侧枚举真实建立的会话(engine.getSessions() → session.channel),
   *   断言协商结果为 Sign + Basic256Sha256(非客户端请求参数,是通道上的实际值);
   * - cleanup:source.dispose → server.shutdown → 证书根目录删除,全部在 finally 内。
   */
  it("security 配置订阅源经签名通道收发数据,server 侧会话安全策略为 Sign+Basic256Sha256", { timeout: 60_000 }, async () => {
    const clientRoot = await mkdtemp(path.join(tmpdir(), "opcua-source-cert-"));
    const server = await startSimulatedServer(0, { securityPolicies: ["Basic256Sha256"] });
    const secondNodeId = server.addTag("Tag2", 0);
    const samples: string[] = [];
    const lifecycle: string[] = [];
    const source = createOpcUaSubscriptionSource({
      endpointUrl: server.endpointUrl,
      nodeIds: [server.nodeId, secondNodeId],
      samplingIntervalMs: 50,
      publishingIntervalMs: 100,
      security: { certificateManagerRootDir: clientRoot, applicationName: "t24-wired-secure-source" },
    });
    try {
      source.onSample((sample) => samples.push(`${sample.topic}:${String(sample.value)}`));
      source.onLifecycle((event) => lifecycle.push(event.kind));
      await source.start();
      expect(lifecycle).toEqual(["ready"]);

      // 数据面:签名通道上的初始值通知(2)→ 值变更(2),共 4 点 ≥ 3。
      await waitForCondition(() => samples.length, (length) => length >= 2, 20_000, 100, "签名通道初始值通知");
      server.setValue(server.nodeId, 11);
      server.setValue(secondNodeId, 22);
      await waitForCondition(() => samples.length, (length) => length >= 4, 20_000, 100, "签名通道值变更通知");
      await sleep(250);
      expect(samples.length).toBeGreaterThanOrEqual(3);
      expect(samples.sort()).toEqual([
        `${server.nodeId}:0`,
        `${server.nodeId}:11`,
        `${secondNodeId}:0`,
        `${secondNodeId}:22`,
      ]);
      expect(source.stats().samplesEmitted).toBe(4);

      // 安全面:server 侧真实协商结果——每个活动会话通道均为 Sign + Basic256Sha256。
      const channelSecurity = server.listSessionChannelSecurity();
      expect(channelSecurity.length).toBeGreaterThanOrEqual(1);
      for (const channel of channelSecurity) {
        expect(channel.securityMode).toBe(MessageSecurityMode.Sign);
        expect(channel.securityPolicy).toBe(SecurityPolicy.Basic256Sha256);
      }
    } finally {
      await source.dispose();
      await server.shutdown();
      await rm(clientRoot, { recursive: true, force: true });
    }
  });

  it("describeOpcUaSubscriptionSupport:securityEnabled 条件声明切换,无参输出零变化", () => {
    const withoutSecurity = describeOpcUaSubscriptionSupport();
    const withSecurity = describeOpcUaSubscriptionSupport({ securityEnabled: true });
    expect(withSecurity.implemented).toBe(true);
    // securityEnabled:声明 Basic256Sha256 签名通道 + messageSecurityMode 可选面(sign|signAndEncrypt)
    // + 吊销链覆盖声明(2026-10-02 SignAndEncrypt/吊销链批,能力扩面后声明同步)。
    expect(withSecurity.limitations.some((item) => item.includes("Basic256Sha256"))).toBe(true);
    expect(withSecurity.limitations.some((item) => item.includes("signAndEncrypt"))).toBe(true);
    expect(withSecurity.limitations.some((item) => item.includes("CA/CRL 信任配置未接入产品连接表单"))).toBe(true);
    expect(withSecurity.limitations.some((item) => item.includes("仅有隔离服务端测试证据"))).toBe(true);
    // 无参调用(既有路由/编辑器):与接线前逐字一致——仍是 None 固定声明。
    expect(withoutSecurity.limitations.some((item) => item.includes("安全模式固定 None"))).toBe(true);
    expect(withoutSecurity.limitations.every((item) => !item.includes("Basic256Sha256"))).toBe(true);
    // 序列语义与公共限制两分支一致。
    expect(withoutSecurity.sequenceSemantics).toBe(withSecurity.sequenceSemantics);
    expect(withoutSecurity.limitations.filter((_, index) => index !== 1)).toEqual(
      withSecurity.limitations.filter((_, index) => index !== 1),
    );
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
