// PLC Live 模式(OPC UA 实连)单元测试:一律走内存 fake transport,不依赖真实 PLC,
// 也不依赖 node-opcua-client(插件包声明 optional peer,测试环境天然缺失)。
// 隔离纪律:Live 证据(non-deterministic)与确定性 Replay 的 evidenceFingerprint 轨迹严格分型。
import { describe, expect, it } from "vitest";
import type { OpcUaLiveBinding, OpcUaLiveEndpoint, OpcUaLiveSample } from "@bim-studio/contracts";
import { runVirtualDebugScenario } from "./engine.js";
import {
  connectOpcUaLive,
  createInMemoryOpcUaTransport,
  createNodeOpcUaLiveTransport,
  OPC_UA_SUPPORT_NOT_INSTALLED,
  sampleOpcUaLiveWindow,
  type OpcUaLiveTransport,
} from "./opcUaLive.js";

const endpoint: OpcUaLiveEndpoint = {
  endpointUrl: "opc.tcp://127.0.0.1:4840",
  securityMode: "None",
  namespace: 3,
};

const bindings: OpcUaLiveBinding[] = [
  { signal: "motorRunning", nodeId: "ns=3;s=Channel1.Motor" },
  { signal: "startCommand", nodeId: "Tag1" },
  { signal: "counter", nodeId: "1001" },
];

/** 测试时钟:毫秒步进,保证 Live 时间戳可断言但语义仍是"真实时钟形态"。 */
function stepClock(startMs = 1_000): () => Date {
  let current = startMs;
  return () => new Date((current += 10));
}

describe("Live 会话:采样、快照与命令下发(fake transport)", () => {
  it("发布采样进入快照与回调;相对 id 按端点 namespace 展开为完整 NodeId", async () => {
    const transport = createInMemoryOpcUaTransport({ now: stepClock() });
    const seen: OpcUaLiveSample[] = [];
    const states: string[] = [];
    const session = await connectOpcUaLive(endpoint, bindings, {
      transport,
      now: stepClock(),
      onSample: (sample) => seen.push(sample),
      onSessionState: (state) => states.push(state.status),
    });

    expect(session.state()).toMatchObject({ status: "connected" });
    expect(states).toEqual(["connecting", "connected"]);
    transport.publish("motorRunning", true);
    transport.publish("counter", 42);
    expect(session.sampleCount()).toBe(2);
    expect(session.snapshot()).toEqual({ motorRunning: true, counter: 42 });
    expect(seen[0]).toMatchObject({ signal: "motorRunning", nodeId: "ns=3;s=Channel1.Motor", value: true });
    expect(seen[1]).toMatchObject({ signal: "counter", nodeId: "ns=3;i=1001", value: 42 });
    expect(seen.every((sample) => !Number.isNaN(Date.parse(sample.timestamp)))).toBe(true);
  });

  it("writeSignal 按绑定映射 NodeId 下发并自动回读;未绑定信号显式拒绝", async () => {
    const transport = createInMemoryOpcUaTransport({ now: stepClock() });
    const session = await connectOpcUaLive(endpoint, bindings, { transport, now: stepClock() });

    await session.writeSignal("startCommand", true);
    expect(transport.writes()).toEqual([{ nodeId: "ns=3;s=Tag1", value: true, at: expect.any(String) }]);
    expect(session.snapshot().startCommand).toBe(true);

    await expect(session.writeSignal("unknownSignal", 1)).rejects.toThrow("未绑定 OPC UA NodeId");
  });

  it("写命令被 PLC 拒绝时错误上抛且写入不入账", async () => {
    const transport = createInMemoryOpcUaTransport({ now: stepClock(), failOnWrite: "BadUserAccessDenied" });
    const session = await connectOpcUaLive(endpoint, bindings, { transport, now: stepClock() });
    await expect(session.writeSignal("startCommand", true)).rejects.toThrow("BadUserAccessDenied");
    expect(transport.writes()).toEqual([]);
    expect(session.snapshot().startCommand).toBeUndefined();
  });
});

describe("Live 证据链:non-deterministic,与 Replay 指纹严格隔离", () => {
  it("close() 产出完整 Live 证据;幂等;关闭后拒发写命令", async () => {
    const transport = createInMemoryOpcUaTransport({ now: stepClock() });
    const session = await connectOpcUaLive(endpoint, bindings, { transport, now: stepClock() });
    transport.publish("motorRunning", true);
    transport.publish("motorRunning", false);

    const evidence = await session.close();
    expect(evidence).toEqual({
      mode: "live",
      endpoint: "opc.tcp://127.0.0.1:4840",
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      sampleCount: 2,
      nonDeterministic: true,
    });
    expect(Date.parse(evidence.startedAt)).toBeLessThanOrEqual(Date.parse(evidence.endedAt));
    expect(session.state().status).toBe("disconnected");
    expect(transport.disconnectCalls()).toBe(1);
    await expect(session.writeSignal("startCommand", true)).rejects.toThrow("Live 会话已关闭");

    const again = await session.close();
    expect(again).toEqual(evidence);
    expect(transport.disconnectCalls()).toBe(1);
    expect(session.evidence()).toEqual(evidence);
  });

  it("Live 证据键集与确定性 VirtualDebugResult 不相交,禁止混入黄金轨迹", async () => {
    const transport = createInMemoryOpcUaTransport({ now: stepClock() });
    const session = await connectOpcUaLive(endpoint, bindings, { transport, now: stepClock() });
    const evidence = await session.close();
    expect(Object.keys(evidence).sort()).toEqual(
      ["endedAt", "endpoint", "mode", "nonDeterministic", "sampleCount", "startedAt"],
    );
    const replay = runVirtualDebugScenario({
      id: "live-isolation-guard",
      durationMs: 100,
      tickMs: 50,
      commands: [{ atMs: 0, type: "start" }],
      assertions: [{ id: "interlock", expression: "running-implies-motor" }],
    });
    expect(replay.status).toBe("passed");
    expect(Object.keys(replay)).toContain("evidenceFingerprint");
    expect(JSON.stringify(evidence)).not.toContain("evidenceFingerprint");
    expect(JSON.stringify(evidence)).not.toContain('"trace"');
  });

  it("Replay 基线保持确定性:同一场景两次运行指纹逐字节一致", () => {
    const buildScenario = () => ({
      id: "determinism-guard",
      durationMs: 100,
      tickMs: 50,
      commands: [{ atMs: 0, type: "start" as const }],
      faults: [{ atMs: 50, code: "e-stop" }],
      assertions: [{ id: "alarm-on-fault", expression: "fault-implies-alarm" as const }],
    });
    expect(runVirtualDebugScenario(buildScenario()).evidenceFingerprint)
      .toBe(runVirtualDebugScenario(buildScenario()).evidenceFingerprint);
  });
});

describe("Live 会话状态机:失败路径同样可审计", () => {
  it("连接失败进入 error 状态,证据 sampleCount=0,写命令拒绝", async () => {
    const transport = createInMemoryOpcUaTransport({ now: stepClock(), failOnConnect: "连接被端点拒绝" });
    const session = await connectOpcUaLive(endpoint, bindings, { transport, now: stepClock() });
    expect(session.state()).toMatchObject({ status: "error", message: "连接被端点拒绝" });
    await expect(session.writeSignal("startCommand", true)).rejects.toThrow("Live 会话未连接");
    const evidence = await session.close();
    expect(evidence.sampleCount).toBe(0);
    expect(evidence.nonDeterministic).toBe(true);
    expect(session.warnings().some((item) => item.includes("连接失败"))).toBe(true);
  });

  it("不支持的 OPC UA 值类型进入告警流且按 nodeId 去重,不污染采样", async () => {
    const stub: OpcUaLiveTransport = {
      kind: "stub",
      connect: async () => {},
      subscribe: (_resolved, emit) => {
        emit({ kind: "unsupported-value", signal: "motorRunning", nodeId: "ns=3;s=Channel1.Motor", received: "ExtensionObject" });
        emit({ kind: "unsupported-value", signal: "motorRunning", nodeId: "ns=3;s=Channel1.Motor", received: "ExtensionObject" });
      },
      write: async () => {},
      disconnect: async () => {},
    };
    const session = await connectOpcUaLive(endpoint, bindings, { transport: stub, now: stepClock() });
    expect(session.sampleCount()).toBe(0);
    expect(session.snapshot()).toEqual({});
    expect(session.warnings().filter((item) => item.includes("不支持的 OPC UA 值类型"))).toHaveLength(1);
  });

  it("有界采样窗口返回证据与快照;durationMs 非法时显式拒绝", async () => {
    const transport = createInMemoryOpcUaTransport({ now: stepClock() });
    const result = await sampleOpcUaLiveWindow({ endpoint, bindings, durationMs: 20, transport, now: stepClock() });
    expect(result.evidence.mode).toBe("live");
    expect(result.evidence.sampleCount).toBe(0);
    expect(result.state.status).toBe("disconnected");
    await expect(sampleOpcUaLiveWindow({ endpoint, bindings, durationMs: 0, transport })).rejects.toThrow("durationMs");
  });
});

describe("可选拓展边界:依赖缺失显式报错;真实适配器失败路径可审计", () => {
  it("依赖缺失(注入不存在的模块说明符)时默认路径进入 error 状态并带安装指引", async () => {
    const session = await connectOpcUaLive(endpoint, bindings, {
      now: stepClock(),
      transportModuleSpecifier: "@bim-studio/opcua-stub-not-installed",
    });
    expect(session.state()).toMatchObject({ status: "error" });
    expect(session.state().message).toContain("OPC UA 支持未安装");
    expect(session.warnings().join("\n")).toContain("OPC UA 支持未安装");
    expect(session.transportKind).toBe("node-opcua");
    const evidence = await session.close();
    expect(evidence.sampleCount).toBe(0);
    expect(evidence.nonDeterministic).toBe(true);
  });

  it("createNodeOpcUaLiveTransport 对缺失模块抛出带安装指引的错误", async () => {
    await expect(createNodeOpcUaLiveTransport({ moduleSpecifier: "@bim-studio/opcua-stub-not-installed" }))
      .rejects.toThrow(OPC_UA_SUPPORT_NOT_INSTALLED);
  });

  it("真实 node-opcua 适配器连接不可达端口时进入 error 状态,证据仍可审计", async () => {
    const deadEndpoint: OpcUaLiveEndpoint = { endpointUrl: "opc.tcp://127.0.0.1:1", securityMode: "None", namespace: 3 };
    const session = await connectOpcUaLive(deadEndpoint, bindings, { now: stepClock() });
    expect(session.state().status).toBe("error");
    expect(session.state().message).toBeTruthy();
    const evidence = await session.close();
    expect(evidence.endpoint).toBe("opc.tcp://127.0.0.1:1");
    expect(evidence.sampleCount).toBe(0);
  }, 20_000);
});
