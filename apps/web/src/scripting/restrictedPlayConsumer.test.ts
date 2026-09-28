import { describe, expect, it, vi } from "vitest";
import type { SceneInteractionScriptState } from "@bim-studio/contracts";
import { createRestrictedPlayConsumer } from "./restrictedPlayConsumer";
import { isRestrictedInteractionScript, parseRestrictedInteractionScript, RESTRICTED_GRAPH_PREFIX } from "./restrictedInteractionDocument";
import type { BehaviorGraph } from "./behaviorGraph";
import type { RestrictedCommandHost } from "./restrictedCommandAdapter";

const graph = (action: unknown = { type: "set-color", target: "model-1", color: "#123456" }): BehaviorGraph => ({
  id: "restricted.one", name: "受限图",
  nodes: [
    { id: "event", kind: "event", event: { kind: "scene-event", name: "interaction.click" } },
    { id: "condition", kind: "condition", expression: "event.payload.level >= 2" },
    { id: "action", kind: "action", action: action as BehaviorGraph["nodes"][number] & never },
  ],
  edges: [{ from: "event", to: "condition" }, { from: "condition", to: "action" }],
});
const script = (body: unknown = { schemaVersion: 1, graph: graph() }): SceneInteractionScriptState => ({
  id: "restricted.one", name: "受限图", enabled: true, target: { kind: "object", modelId: "model-1" },
  trigger: "click", code: RESTRICTED_GRAPH_PREFIX + JSON.stringify(body),
});
function host(action = vi.fn().mockResolvedValue(undefined)): RestrictedCommandHost {
  return { sceneId: "scene-1", engine: {
    listModels: () => [{ id: "model-1" }], executeInteractionAction: action,
  } as unknown as RestrictedCommandHost["engine"] };
}

describe("受限交互文档显式分域", () => {
  it("兼容可信作者 JS 且错误前缀永不回退可信 JS", () => {
    expect(isRestrictedInteractionScript({ code: "studio.scene.query()" })).toBe(false);
    expect(isRestrictedInteractionScript({ code: "  \n/* @bim-studio/restricted-graph/v1 */\n{}" })).toBe(true);
    expect(isRestrictedInteractionScript({ code: "/* @bim-studio/restricted-graph/v2 */\nalert(1)" })).toBe(true);
    const invalid = { ...script(), code: RESTRICTED_GRAPH_PREFIX.trimEnd() + "(invalid)" };
    expect(isRestrictedInteractionScript(invalid)).toBe(true);
    expect(() => parseRestrictedInteractionScript(invalid)).toThrow(/标记格式错误/);
    expect(() => parseRestrictedInteractionScript({ ...script(), code: RESTRICTED_GRAPH_PREFIX + "{" })).toThrow(/不会回退可信 JS/);
  });
  it("拒绝 schema/额外字段/未知动作/动作字段、可信预定义动作混入", () => {
    expect(() => parseRestrictedInteractionScript(script({ schemaVersion: 2, graph: graph() }))).toThrow(/schemaVersion/);
    expect(() => parseRestrictedInteractionScript(script({ schemaVersion: 1, graph: graph(), escape: true }))).toThrow(/顶层字段/);
    expect(() => parseRestrictedInteractionScript(script({ schemaVersion: 1, graph: graph({ type: "openUrl", url: "https://example.com" }) }))).toThrow(/白名单/);
    expect(() => parseRestrictedInteractionScript(script({ schemaVersion: 1, graph: graph({ type: "trace", message: "ok", code: "alert(1)" }) }))).toThrow(/白名单/);
    expect(() => parseRestrictedInteractionScript({ ...script(), actions: [{ id: "a", type: "openUrl", enabled: true }] })).toThrow(/不可混用/);
  });
  it("拒绝超大与过深文档，不接受函数调用或原型链访问", () => {
    expect(() => parseRestrictedInteractionScript({ ...script(), code: RESTRICTED_GRAPH_PREFIX + " ".repeat(65_537) })).toThrow(/上限/);
    expect(() => parseRestrictedInteractionScript(script({ schemaVersion: 1, graph: graph({ type: "emit-event", name: "x", payload: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: { n: { o: { p: 1 } } } } } } } } } } } } } } } } }) }))).toThrow(/嵌套/);
    const call = graph();
    const changed = { ...call, nodes: call.nodes.map((node) => node.kind === "condition" ? { ...node, expression: "Math.random()" } : node) };
    expect(() => parseRestrictedInteractionScript(script({ schemaVersion: 1, graph: changed }))).toThrow(/校验失败/);
  });
});

describe("受限 Play 消费者真实交互与取消", () => {
  it("只在 start 后接收精确 trigger/target/detail，走真实引擎动作，日志与命令有仿真时刻", async () => {
    const action = vi.fn().mockResolvedValue(undefined), onTrace = vi.fn(), onCommand = vi.fn();
    const consumer = createRestrictedPlayConsumer({ scripts: [script()], host: host(action), onTrace, onCommand });
    consumer.dispatchInteraction("click", { kind: "object", modelId: "model-1" }, { payload: { level: 3 } });
    consumer.start();
    consumer.advance(32);
    consumer.dispatchInteraction("click", { kind: "object", modelId: "different" }, { payload: { level: 3 } });
    consumer.dispatchInteraction("click", { kind: "object", modelId: "model-1" }, { test: true, payload: { level: 3 } });
    consumer.dispatchInteraction("click", { kind: "object", modelId: "model-1" }, { payload: { level: 1 } });
    consumer.dispatchInteraction("click", { kind: "object", modelId: "model-1" }, { payload: { level: 3 } });
    await Promise.resolve(); // command already started; stop drains this action, not later queued actions.
    await consumer.stop();
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0]?.[1]).toMatchObject({ type: "color", target: { kind: "object", modelId: "model-1" }, value: "#123456" });
    expect(onTrace.mock.lastCall?.[1]).toEqual(expect.arrayContaining([expect.objectContaining({ atMs: 32, outcome: "applied" })]));
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ status: "applied", atMs: 32 }));
    consumer.dispatchInteraction("click", { kind: "object", modelId: "model-1" }, { payload: { level: 3 } });
    expect(action).toHaveBeenCalledTimes(1);
  });
  it("首个异步动作排空后拒绝队列后续命令，重新 start 无旧状态", async () => {
    let resolve!: () => void;
    const action = vi.fn().mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const two = graph();
    const double = { ...two, nodes: [...two.nodes, { id: "action2", kind: "action", action: { type: "set-color", target: "model-1", color: "#abcdef" } }], edges: [...two.edges, { from: "condition", to: "action2" }] };
    const consumer = createRestrictedPlayConsumer({ scripts: [script({ schemaVersion: 1, graph: double })], host: host(action) });
    consumer.start();
    consumer.dispatchInteraction("click", { kind: "object", modelId: "model-1" }, { payload: { level: 3 } });
    await Promise.resolve();
    expect(action).toHaveBeenCalledTimes(1);
    const stopped = consumer.stop();
    expect(consumer.running).toBe(false);
    resolve();
    await stopped;
    expect(action).toHaveBeenCalledTimes(1);
    consumer.start();
    consumer.dispatchInteraction("click", { kind: "object", modelId: "model-1" }, { payload: { level: 3 } });
    await Promise.resolve();
    resolve();
    await consumer.stop();
    expect(action).toHaveBeenCalledTimes(2);
  });
  it("慢执行时有界队列拒绝溢出，而非无限积压", async () => {
    let release!: () => void;
    const execute = vi.fn().mockImplementation(() => new Promise<void>((done) => { release = done; }));
    const onError = vi.fn(), onTrace = vi.fn();
    const consumer = createRestrictedPlayConsumer({ scripts: [script()], host: host(execute), onError, onTrace });
    consumer.start();
    for (let index = 0; index < 1_026; index++) consumer.dispatchInteraction("click", { kind: "object", modelId: "model-1" }, { payload: { level: 3 } });
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("队列超过") }));
    expect(onTrace.mock.lastCall?.[1]).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "rejected", reason: expect.stringContaining("队列超过") })]));
    const stopping = consumer.stop();
    release();
    await stopping;
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("异步队列的命令时间戳固定为事件派发时刻，不随晚到的帧漂移", async () => {
    let resolve!: () => void;
    const execute = vi.fn().mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const onCommand = vi.fn();
    const consumer = createRestrictedPlayConsumer({ scripts: [script()], host: host(execute), onCommand });
    consumer.start();
    consumer.advance(10);
    consumer.dispatchInteraction("click", { kind: "object", modelId: "model-1" }, { payload: { level: 2 } });
    await Promise.resolve();
    consumer.advance(20);
    resolve();
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]?.[0].atMs).toBe(10);
    await consumer.stop();
  });
  it("tick 与数据变化按注入仿真时间驱动，stop 后停止时钟与派发", async () => {
    const action = vi.fn().mockResolvedValue(undefined), onCommand = vi.fn();
    const tickGraph: BehaviorGraph = {
      id: "restricted.tick", name: "仿真钟", nodes: [
        { id: "tick", kind: "event", event: { kind: "tick", intervalMs: 10 } },
        { id: "trace", kind: "action", action: { type: "trace", message: "tick" } },
        { id: "data", kind: "event", event: { kind: "data-change", key: "alarm" } },
        { id: "alarm", kind: "action", action: { type: "set-visibility", target: "model-1", mode: "hide" } },
      ], edges: [{ from: "tick", to: "trace" }, { from: "data", to: "alarm" }],
    };
    const consumer = createRestrictedPlayConsumer({ scripts: [script({ schemaVersion: 1, graph: tickGraph })], host: host(action), onCommand });
    consumer.start();
    consumer.advance(9);
    consumer.advance(1);
    consumer.applyData({ alarm: true });
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    await consumer.stop();
    expect(onCommand.mock.calls.map(([receipt]) => [receipt.command.kind, receipt.atMs])).toEqual([["trace", 10], ["set-visibility", 10]]);
    expect(action).toHaveBeenCalledTimes(1);
    consumer.advance(100);
    consumer.applyData({ alarm: false });
    expect(action).toHaveBeenCalledTimes(1);
  });
  it("校验缺失目标与显式音频端口，执行失败不吞轨迹", async () => {
    const missingGraph = graph({ type: "set-color", target: "missing", color: "#123456" });
    const missing = createRestrictedPlayConsumer({ scripts: [script({ schemaVersion: 1, graph: missingGraph })], host: host() });
    expect(() => missing.start()).toThrow(/不存在/);
    const audioGraph = graph({ type: "audio", command: "play", target: "model-1" });
    const onCommand = vi.fn(), onError = vi.fn();
    const consumer = createRestrictedPlayConsumer({ scripts: [script({ schemaVersion: 1, graph: audioGraph })], host: host(), onCommand, onError });
    consumer.start();
    consumer.dispatchInteraction("click", { kind: "object", modelId: "model-1" }, { payload: { level: 2 } });
    await Promise.resolve();
    await consumer.stop();
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected", reason: expect.stringContaining("音频端口") }));
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it("非法图拒绝启动且不执行任何动作；执行失败留 rejected 轨迹", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("端口不可用"));
    const bad = createRestrictedPlayConsumer({ scripts: [{ ...script(), code: RESTRICTED_GRAPH_PREFIX + "invalid" }], host: host(execute) });
    expect(() => bad.start()).toThrow(/JSON/);
    expect(bad.running).toBe(false);
    const onCommand = vi.fn(), onTrace = vi.fn(), onError = vi.fn();
    const consumer = createRestrictedPlayConsumer({ scripts: [script()], host: host(execute), onCommand, onTrace, onError });
    consumer.start();
    consumer.dispatchInteraction("click", { kind: "object", modelId: "model-1" }, { payload: { level: 2 } });
    await Promise.resolve();
    await consumer.stop();
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected", reason: "端口不可用" }));
    expect(onTrace.mock.lastCall?.[1]).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "rejected", reason: "端口不可用" })]));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
