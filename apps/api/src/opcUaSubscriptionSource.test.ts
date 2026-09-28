import { describe, expect, it } from "vitest";
import type { SourceSample } from "./subscriptionRuntime.js";
import {
  createOpcUaSubscriptionSource,
  describeOpcUaSubscriptionSupport,
  projectOpcUaSample,
  type OpcUaDataValueLike,
  type OpcUaSubscriptionSourceConfig,
} from "./opcUaSubscriptionSource.js";

type ChangedListener = (dataValue: OpcUaDataValueLike) => void;

/** 可控假客户端栈:connect→session→subscription→monitoredItem,事件由测试显式触发。 */
function createFakeOpcUaStack(failures?: { connect?: Error; session?: Error; subscription?: Error }) {
  const callOrder: string[] = [];
  const monitorParams: Array<{ nodeId: string; attributeId: number; samplingInterval: number; queueSize: number; timestampsToReturn: number }> = [];
  const clientListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const sessionListeners = new Map<string, Set<() => void>>();
  const subscriptionListeners = new Map<string, Set<() => void>>();
  const changedListeners = new Map<string, ChangedListener>();
  let terminationRequested = false;

  const client = {
    connect: async () => {
      if (failures?.connect) throw failures.connect;
      callOrder.push("connect");
    },
    createSession: async () => {
      if (failures?.session) throw failures.session;
      callOrder.push("createSession");
      return {
        createSubscription: async () => {
          if (failures?.subscription) throw failures.subscription;
          callOrder.push("createSubscription");
          return {
            monitor: async (item: { nodeId: string; attributeId: number }, parameters: { samplingInterval: number; queueSize: number }, timestampsToReturn: number) => {
              monitorParams.push({ nodeId: item.nodeId, attributeId: item.attributeId, samplingInterval: parameters.samplingInterval, queueSize: parameters.queueSize, timestampsToReturn });
              return {
                on: (_event: "changed", listener: ChangedListener) => {
                  changedListeners.set(item.nodeId, listener);
                },
              };
            },
            on: (event: "terminated", listener: () => void) => {
              subscriptionListeners.set(event, (subscriptionListeners.get(event) ?? new Set()).add(listener));
            },
            terminate: async () => {
              terminationRequested = true;
              callOrder.push("terminate");
            },
          };
        },
        on: (event: "session_closed" | "keepalive_failure", listener: () => void) => {
          sessionListeners.set(event, (sessionListeners.get(event) ?? new Set()).add(listener));
        },
        close: async () => {
          callOrder.push("sessionClose");
        },
      };
    },
    disconnect: async () => {
      callOrder.push("disconnect");
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      clientListeners.set(event, (clientListeners.get(event) ?? new Set()).add(listener));
    },
  };

  const stack = {
    deps: { createClient: () => client },
    callOrder,
    monitorParams,
    terminationRequested: () => terminationRequested,
    emitChanged: (topic: string, dataValue: OpcUaDataValueLike) => changedListeners.get(topic)?.(dataValue),
    emitConnectionLost: () => clientListeners.get("connection_lost")?.forEach((listener) => listener()),
    emitSessionClosed: () => sessionListeners.get("session_closed")?.forEach((listener) => listener()),
    emitKeepaliveFailure: () => sessionListeners.get("keepalive_failure")?.forEach((listener) => listener()),
    emitSubscriptionTerminated: () => subscriptionListeners.get("terminated")?.forEach((listener) => listener()),
  };
  return stack;
}

const dv = (value: unknown, sourceTimestamp?: string, statusCode?: unknown, serverTimestamp?: string): OpcUaDataValueLike => ({
  value: { value },
  ...(sourceTimestamp !== undefined ? { sourceTimestamp: new Date(sourceTimestamp) } : {}),
  ...(serverTimestamp !== undefined ? { serverTimestamp: new Date(serverTimestamp) } : {}),
  ...(statusCode !== undefined ? { statusCode } : {}),
});

async function startSource(config: Partial<OpcUaSubscriptionSourceConfig>, stack: ReturnType<typeof createFakeOpcUaStack>) {
  const samples: SourceSample[] = [];
  const lifecycle: string[] = [];
  const source = createOpcUaSubscriptionSource({
    endpointUrl: "opc.tcp://127.0.0.1:4840",
    nodeIds: ["ns=2;s=Tag1"],
    ...config,
    deps: stack.deps,
  });
  source.onSample((sample) => samples.push(sample));
  source.onLifecycle((event) => lifecycle.push(event.kind));
  await source.start();
  return { source, samples, lifecycle };
}

const GOOD = { isGoodish: () => true };
const BAD = { isGoodish: () => false, name: "BadInternalError" };

describe("OpcUaSubscriptionSource:配置 fail-closed", () => {
  it("endpointUrl 非 opc.tcp:// 显式拒绝", () => {
    expect(() => createOpcUaSubscriptionSource({ endpointUrl: "mqtt://broker:1883", nodeIds: ["ns=2;s=T"] })).toThrow("opc.tcp://");
  });

  it("nodeIds 为空显式拒绝", () => {
    expect(() => createOpcUaSubscriptionSource({ endpointUrl: "opc.tcp://127.0.0.1:4840", nodeIds: [] })).toThrow("NodeId");
  });

  it("相对 id 未提供 namespace 显式拒绝,绝不静默展开成 ns=NaN", () => {
    expect(() => createOpcUaSubscriptionSource({ endpointUrl: "opc.tcp://127.0.0.1:4840", nodeIds: ["Tag1"] })).toThrow("namespace");
    expect(() => createOpcUaSubscriptionSource({ endpointUrl: "opc.tcp://127.0.0.1:4840", nodeIds: ["Tag1"], namespace: 3 })).not.toThrow();
  });
});

describe("OpcUaSubscriptionSource:建立与生命周期", () => {
  it("start 按 connect→session→subscription→monitor 顺序建立,ready 恰好一次", async () => {
    const stack = createFakeOpcUaStack();
    const { source, lifecycle } = await startSource({ nodeIds: ["ns=2;s=Tag1", "ns=2;i=1001"] }, stack);
    expect(stack.callOrder).toEqual(["connect", "createSession", "createSubscription"]);
    expect(stack.monitorParams).toHaveLength(2);
    expect(stack.monitorParams[0]).toMatchObject({ nodeId: "ns=2;s=Tag1", attributeId: 13, timestampsToReturn: 2, samplingInterval: 0 });
    expect(lifecycle).toEqual(["ready"]);
    await source.dispose();
  });

  it("samplingIntervalMs 与 queueSize 传入 MonitoredItem 参数", async () => {
    const stack = createFakeOpcUaStack();
    const { source } = await startSource({ samplingIntervalMs: 250, queueSize: 20 }, stack);
    expect(stack.monitorParams[0]).toMatchObject({ samplingInterval: 250, queueSize: 20 });
    await source.dispose();
  });

  it("endpoint 不可达/会话被拒/订阅失败均显式抛错并携带 endpoint", async () => {
    for (const [failure, fragment] of [
      [{ connect: new Error("ECONNREFUSED") }, "endpoint 不可达"],
      [{ session: new Error("BadUserAccessDenied") }, "会话建立失败"],
      [{ subscription: new Error("BadTooManySessions") }, "订阅建立失败"],
    ] as const) {
      const stack = createFakeOpcUaStack(failure);
      const source = createOpcUaSubscriptionSource({ endpointUrl: "opc.tcp://plc:4840", nodeIds: ["ns=2;s=T"], deps: stack.deps });
      await expect(source.start()).rejects.toThrow(`${fragment}(opc.tcp://plc:4840)`);
      // 失败实例由运行时经 sourceFactory 重建,同一实例不再复用(与 MQTT 适配器同语义)。
      await expect(source.start()).rejects.toThrow("已启动");
      await source.dispose();
    }
  });

  it("connection_lost/会话关闭/订阅终止/keepalive 失效 → disconnected(仅一次)", async () => {
    for (const trigger of ["connectionLost", "sessionClosed", "subscriptionTerminated", "keepalive"] as const) {
      const stack = createFakeOpcUaStack();
      const { source, lifecycle } = await startSource({}, stack);
      if (trigger === "connectionLost") {
        stack.emitConnectionLost();
        stack.emitConnectionLost();
      } else if (trigger === "sessionClosed") {
        stack.emitSessionClosed();
      } else if (trigger === "subscriptionTerminated") {
        stack.emitSubscriptionTerminated();
      } else {
        stack.emitKeepaliveFailure();
      }
      const disconnects = lifecycle.filter((kind) => kind === "disconnected");
      expect(disconnects).toHaveLength(1);
      await source.dispose();
    }
  });

  it("dispose 幂等:连接对象释放、迟到值不外发、dispose 后 start 拒绝", async () => {
    const stack = createFakeOpcUaStack();
    const { source, samples, lifecycle } = await startSource({}, stack);
    await source.dispose();
    await source.dispose();
    expect(stack.callOrder).toContain("sessionClose");
    expect(stack.callOrder).toContain("disconnect");
    expect(stack.terminationRequested()).toBe(true);
    stack.emitChanged("ns=2;s=Tag1", dv(1, "2026-09-27T00:00:01.000Z"));
    expect(samples).toHaveLength(0);
    await expect(source.start()).rejects.toThrow("已释放");
    expect(lifecycle).toEqual(["ready"]);
  });
});

describe("OpcUaSubscriptionSource:序列推导(可靠时间戳路径)", () => {
  it("严格递增 sourceTimestamp → sequence 连续 1,2,3;值为合约归一化结果", async () => {
    const stack = createFakeOpcUaStack();
    const { source, samples } = await startSource({}, stack);
    stack.emitChanged("ns=2;s=Tag1", dv(1, "2026-09-27T00:00:01.000Z"));
    stack.emitChanged("ns=2;s=Tag1", dv(true, "2026-09-27T00:00:01.100Z"));
    stack.emitChanged("ns=2;s=Tag1", dv(9007199254740993n, "2026-09-27T00:00:01.200Z"));
    expect(samples.map((s) => s.sequence)).toEqual([1, 2, 3]);
    expect(samples[1].value).toBe(true);
    expect(samples[2].value).toBe("9007199254740993"); // BigInt 超出安全整数 → 合约按字符串保留,不失真
    expect(samples[0].timestamp).toBe("2026-09-27T00:00:01.000Z");
    await source.dispose();
  });

  it("同 sourceTimestamp 同值重发 → 丢弃(staleDuplicates),不外发", async () => {
    const stack = createFakeOpcUaStack();
    const { source, samples } = await startSource({}, stack);
    stack.emitChanged("ns=2;s=Tag1", dv(7, "2026-09-27T00:00:01.000Z"));
    stack.emitChanged("ns=2;s=Tag1", dv(7, "2026-09-27T00:00:01.000Z"));
    expect(samples).toHaveLength(1);
    expect(source.stats().staleDuplicates).toBe(1);
    await source.dispose();
  });

  it("同 sourceTimestamp 不同值 → 不带 sequence 外发(绝不给重复序列号)", async () => {
    const stack = createFakeOpcUaStack();
    const { source, samples } = await startSource({}, stack);
    stack.emitChanged("ns=2;s=Tag1", dv(7, "2026-09-27T00:00:01.000Z"));
    stack.emitChanged("ns=2;s=Tag1", dv(8, "2026-09-27T00:00:01.000Z"));
    expect(samples).toHaveLength(2);
    expect(samples[0].sequence).toBe(1);
    expect(samples[1].sequence).toBeUndefined();
    await source.dispose();
  });

  it("时间戳倒退 → droppedStale 丢弃;声明周期时流内跳变按 Δt/周期-1 估计并跳号", async () => {
    const stack = createFakeOpcUaStack();
    const { source, samples } = await startSource({ samplingIntervalMs: 100 }, stack);
    stack.emitChanged("ns=2;s=Tag1", dv(1, "2026-09-27T00:00:01.000Z")); // seq 1
    stack.emitChanged("ns=2;s=Tag1", dv(2, "2026-09-27T00:00:00.900Z")); // 倒退 → 丢弃
    stack.emitChanged("ns=2;s=Tag1", dv(3, "2026-09-27T00:00:01.100Z")); // 连续 → seq 2
    stack.emitChanged("ns=2;s=Tag1", dv(4, "2026-09-27T00:00:02.000Z")); // Δ900ms → 估计 8 丢失 → seq 11
    expect(samples.map((s) => s.sequence)).toEqual([1, 2, 11]);
    expect(source.stats().droppedStale).toBe(1);
    await source.dispose();
  });

  it("未声明周期时流内跳变仍连续计数(不伪造丢失点数)", async () => {
    const stack = createFakeOpcUaStack();
    const { source, samples } = await startSource({}, stack);
    stack.emitChanged("ns=2;s=Tag1", dv(1, "2026-09-27T00:00:01.000Z"));
    stack.emitChanged("ns=2;s=Tag1", dv(2, "2026-09-27T00:00:05.000Z"));
    expect(samples.map((s) => s.sequence)).toEqual([1, 2]);
    await source.dispose();
  });

  it("sourceTimestamp 缺失时兜底 serverTimestamp;两者皆缺落采集时间且不带 sequence(降级路径)", async () => {
    const stack = createFakeOpcUaStack();
    const { source, samples } = await startSource({}, stack);
    stack.emitChanged("ns=2;s=Tag1", dv(1, undefined, GOOD, "2026-09-27T00:00:01.000Z"));
    stack.emitChanged("ns=2;s=Tag1", dv(2));
    expect(samples).toHaveLength(2);
    expect(samples[0].timestamp).toBe("2026-09-27T00:00:01.000Z");
    expect(samples[0].sequence).toBe(1);
    expect(samples[1].sequence).toBeUndefined();
    expect(Number.isFinite(Date.parse(samples[1].timestamp))).toBe(true);
    await source.dispose();
  });
});

describe("OpcUaSubscriptionSource:恢复对账(resume 上下文)", () => {
  it("有周期声明:恢复后首样本按时间差估计丢失并跳号(sequenceKnown:true 的输入)", async () => {
    const stack = createFakeOpcUaStack();
    const { source, samples } = await startSource(
      {
        samplingIntervalMs: 100,
        resume: { lastSequence: 10, lastTimestamp: "2026-09-27T00:00:01.000Z" },
      },
      stack,
    );
    stack.emitChanged("ns=2;s=Tag1", dv(1, "2026-09-27T00:00:01.500Z")); // Δ500ms → 估计 4 丢失 → seq 15
    stack.emitChanged("ns=2;s=Tag1", dv(2, "2026-09-27T00:00:01.600Z")); // 连续 → seq 16
    expect(samples.map((s) => s.sequence)).toEqual([15, 16]);
    await source.dispose();
  });

  it("无周期声明:恢复后首样本不带 sequence(完整性未知),次样本从 checkpoint 连续处恢复", async () => {
    const stack = createFakeOpcUaStack();
    const { source, samples } = await startSource(
      { resume: { lastSequence: 10, lastTimestamp: "2026-09-27T00:00:01.000Z" } },
      stack,
    );
    stack.emitChanged("ns=2;s=Tag1", dv(1, "2026-09-27T00:00:01.500Z"));
    stack.emitChanged("ns=2;s=Tag1", dv(2, "2026-09-27T00:00:01.600Z"));
    expect(samples[0].sequence).toBeUndefined();
    expect(samples[1].sequence).toBe(11);
    await source.dispose();
  });

  it("恢复后早于基准的陈旧重放 → 丢弃", async () => {
    const stack = createFakeOpcUaStack();
    const { source, samples } = await startSource(
      {
        samplingIntervalMs: 100,
        resume: { lastSequence: 10, lastTimestamp: "2026-09-27T00:00:01.000Z" },
      },
      stack,
    );
    stack.emitChanged("ns=2;s=Tag1", dv(0, "2026-09-27T00:00:00.500Z"));
    stack.emitChanged("ns=2;s=Tag1", dv(1, "2026-09-27T00:00:01.300Z"));
    expect(samples).toHaveLength(1);
    expect(samples[0].sequence).toBe(13); // Δ300ms → 估计 2 丢失 → 10+3
    expect(source.stats().droppedStale).toBe(1);
    await source.dispose();
  });
});

describe("OpcUaSubscriptionSource:质量与解析", () => {
  it("Bad 状态码计 badQuality 并以 invalid-sample 上报,不外发", async () => {
    const stack = createFakeOpcUaStack();
    const { source, samples, lifecycle } = await startSource({}, stack);
    stack.emitChanged("ns=2;s=Tag1", dv(1, "2026-09-27T00:00:01.000Z", BAD));
    expect(samples).toHaveLength(0);
    expect(source.stats().badQuality).toBe(1);
    expect(lifecycle.filter((k) => k === "invalid-sample")).toHaveLength(1);
    await source.dispose();
  });

  it("不可序列化值计 parseFailures;多节点按 nodeId 独立对账", async () => {
    const stack = createFakeOpcUaStack();
    const { source, samples } = await startSource({ nodeIds: ["ns=2;s=A", "ns=2;s=B"] }, stack);
    stack.emitChanged("ns=2;s=A", dv({ nested: true }, "2026-09-27T00:00:01.000Z"));
    stack.emitChanged("ns=2;s=A", dv(1, "2026-09-27T00:00:01.000Z"));
    stack.emitChanged("ns=2;s=B", dv(5, "2026-09-27T00:00:01.000Z"));
    expect(samples.map((s) => s.topic)).toEqual(["ns=2;s=A", "ns=2;s=B"]);
    expect(samples.map((s) => s.sequence)).toEqual([1, 2]);
    expect(source.stats().parseFailures).toBe(1);
    await source.dispose();
  });
});

describe("OpcUaSubscriptionSource:支持度描述与投影", () => {
  it("支持度描述如实标注已实现与限制(SubscriptionTransfer/安全模式/估计语义)", () => {
    const support = describeOpcUaSubscriptionSupport();
    expect(support.implemented).toBe(true);
    expect(support.sequenceSemantics).toContain("sourceTimestamp");
    expect(support.limitations.some((item) => item.includes("SubscriptionTransfer"))).toBe(true);
    expect(support.limitations.some((item) => item.includes("estimatedCount"))).toBe(true);
  });

  it("projectOpcUaSample:id 确定性、source 缺省、sequence/scene 透传", () => {
    const config = { connectionId: "plc-1", projectId: "p1", sceneId: "scene-9" } as const;
    const sample: SourceSample = { topic: "ns=2;s=Tag1", value: 3, timestamp: "2026-09-27T00:00:01.000Z", sequence: 4 };
    const a = projectOpcUaSample(config, sample);
    const b = projectOpcUaSample(config, sample);
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ source: "opcua/plc-1", key: "ns=2;s=Tag1", value: 3, sequence: 4, sceneId: "scene-9", projectId: "p1" });
    const c = projectOpcUaSample(config, { topic: "ns=2;s=Tag1", value: 3, timestamp: "2026-09-27T00:00:01.000Z" });
    expect("sequence" in c).toBe(false);
  });
});
