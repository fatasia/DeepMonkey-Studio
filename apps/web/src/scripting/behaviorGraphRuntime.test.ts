import { describe, expect, it } from "vitest";
import { validateBehaviorGraph, type BehaviorGraph, type BehaviorGraphNode } from "./behaviorGraph";
import { BehaviorGraphRuntime, BEHAVIOR_GRAPH_RUNTIME_LIMITS } from "./behaviorGraphRuntime";
import { BehaviorTraceLog, MonotonicBehaviorClock } from "./behaviorTraceLog";

/** 构图辅助:校验通过才返回编译图(测试图自身错误立即暴露)。 */
function compile(graph: BehaviorGraph) {
  const result = validateBehaviorGraph(graph);
  if (!result.valid) throw new Error(`测试图非法:${result.issues.map((issue) => issue.message).join(";")}`);
  return result.graph;
}

const clock = () => new MonotonicBehaviorClock();

/** 传感器>80 → 动画 + 设值 + 显式轨迹。 */
function thresholdGraph(): BehaviorGraph {
  return {
    id: "guard",
    name: "超限联动",
    nodes: [
      { id: "on-data", kind: "event", event: { kind: "data-change", key: "temperature" } },
      { id: "over", kind: "condition", expression: "values.temperature > 80" },
      { id: "play", kind: "action", action: { type: "animate", target: "valve", command: "play" } },
      { id: "mark", kind: "action", action: { type: "set-value", key: "alarmLevel", expression: "values.temperature - 80" } },
      { id: "note", kind: "action", action: { type: "trace", message: "超限记录", valueExpression: "values.temperature" } },
    ],
    edges: [
      { from: "on-data", to: "over" },
      { from: "over", to: "play" },
      { from: "over", to: "mark" },
      { from: "over", to: "note" },
    ],
  };
}

describe("BehaviorGraphRuntime 事件→条件→动作", () => {
  it("条件为真:输出命令、更新变量空间、落 applied 轨迹", () => {
    const runtime = new BehaviorGraphRuntime({ graph: compile(thresholdGraph()), clock: clock() });
    const result = runtime.applyData({ temperature: 95 });
    expect(result.status).toBe("completed");
    expect(result.commands).toContainEqual({ kind: "animate", target: "valve", command: "play" });
    expect(result.commands).toContainEqual({ kind: "set-value", key: "alarmLevel", value: 15 });
    expect(runtime.getValue("alarmLevel")).toBe(15);
    const applied = result.entries.filter((entry) => entry.outcome === "applied");
    expect(applied.map((entry) => entry.actionNodeId)).toStrictEqual(["play", "mark", "note"]);
    expect(applied[1]).toMatchObject({ action: "set-value", target: "alarmLevel", before: "undefined", after: "15" });
  });

  it("条件为假:一条 skipped 轨迹、零命令、零动作", () => {
    const runtime = new BehaviorGraphRuntime({ graph: compile(thresholdGraph()), clock: clock() });
    const result = runtime.applyData({ temperature: 20 });
    expect(result.status).toBe("completed");
    expect(result.commands).toStrictEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ actionNodeId: "over", outcome: "skipped", reason: "condition-false" });
  });

  it("事件命名空间:scene-event 的 payload 可被条件读取", () => {
    const graph: BehaviorGraph = {
      id: "payload",
      name: "payload",
      nodes: [
        { id: "ev", kind: "event", event: { kind: "scene-event", name: "collisionStart" } },
        { id: "hard", kind: "condition", expression: "event.payload.impact > 5" },
        { id: "act", kind: "action", action: { type: "set-visibility", target: "car", mode: "hide" } },
      ],
      edges: [
        { from: "ev", to: "hard" },
        { from: "hard", to: "act" },
      ],
    };
    const runtime = new BehaviorGraphRuntime({ graph: compile(graph), clock: clock() });
    expect(runtime.dispatchEvent("collisionStart", { impact: 2 }).commands).toStrictEqual([]);
    expect(runtime.dispatchEvent("collisionStart", { impact: 9 }).commands).toStrictEqual([
      { kind: "set-visibility", target: "car", mode: "hide" },
    ]);
    expect(runtime.dispatchEvent("unrelated").status).toBe("no-match");
  });

  it("条件语义错误按判假留痕,不终止兄弟分支", () => {
    const graph: BehaviorGraph = {
      id: "err",
      name: "err",
      nodes: [
        { id: "ev", kind: "event", event: { kind: "scene-event", name: "go" } },
        { id: "bad", kind: "condition", expression: "values.missing > 1" },
        { id: "lost", kind: "action", action: { type: "trace", message: "would-have-run" } },
        { id: "ok", kind: "condition", expression: "1 == 1" },
        { id: "act", kind: "action", action: { type: "trace", message: "still-runs" } },
      ],
      edges: [
        { from: "ev", to: "bad" },
        { from: "bad", to: "lost" },
        { from: "ev", to: "ok" },
        { from: "ok", to: "act" },
      ],
    };
    const runtime = new BehaviorGraphRuntime({ graph: compile(graph), clock: clock() });
    const result = runtime.dispatchEvent("go");
    expect(result.status).toBe("completed");
    // bad 分支判假:lost 不执行;ok 分支正常执行。
    expect(result.commands).toStrictEqual([{ kind: "trace", message: "still-runs" }]);
    expect(result.entries.find((entry) => entry.actionNodeId === "bad")).toMatchObject({ outcome: "skipped" });
    expect(result.entries.find((entry) => entry.actionNodeId === "lost")).toBeUndefined();
  });
});

describe("BehaviorGraphRuntime 有界性", () => {
  it("emit-event 重入链在深度内工作,超深被拒绝", () => {
    // 链:ev→a1(emit step2)→…;重入深度 2 允许一级重入,第二级拒绝。
    const graph: BehaviorGraph = {
      id: "chain",
      name: "chain",
      nodes: [
        { id: "start", kind: "event", event: { kind: "scene-event", name: "step1" } },
        { id: "on-1", kind: "event", event: { kind: "scene-event", name: "step2" } },
        { id: "on-2", kind: "event", event: { kind: "scene-event", name: "step3" } },
        { id: "emit-2", kind: "action", action: { type: "emit-event", name: "step2" } },
        { id: "emit-3", kind: "action", action: { type: "emit-event", name: "step3" } },
        { id: "leaf", kind: "action", action: { type: "trace", message: "leaf" } },
      ],
      edges: [
        { from: "start", to: "emit-2" },
        { from: "on-1", to: "emit-3" },
        { from: "on-2", to: "leaf" },
      ],
    };
    const limits = { maxEventReentryDepth: 2 };
    const runtime = new BehaviorGraphRuntime({ graph: compile(graph), clock: clock(), limits });
    const result = runtime.dispatchEvent("step1");
    // step1(深度1) → emit step2 → step2(深度2) → emit step3 → step3(深度3 > 2)拒绝,leaf 不执行。
    expect(result.entries.find((entry) => entry.actionNodeId === "leaf" && entry.outcome === "applied")).toBeUndefined();
    expect(result.entries.filter((entry) => entry.outcome === "rejected")).toHaveLength(1);
    expect(result.entries.find((entry) => entry.outcome === "rejected")?.reason).toContain("重入深度");

    const generous = new BehaviorGraphRuntime({ graph: compile(graph), clock: clock(), limits: { maxEventReentryDepth: 4 } });
    const deep = generous.dispatchEvent("step1");
    expect(deep.entries.find((entry) => entry.actionNodeId === "leaf")).toMatchObject({ outcome: "applied" });
  });

  it("emit-event 无匹配事件节点被拒绝", () => {
    const graph: BehaviorGraph = {
      id: "dangling",
      name: "dangling",
      nodes: [
        { id: "ev", kind: "event", event: { kind: "scene-event", name: "go" } },
        { id: "act", kind: "action", action: { type: "emit-event", name: "nobody-listens" } },
      ],
      edges: [{ from: "ev", to: "act" }],
    };
    const runtime = new BehaviorGraphRuntime({ graph: compile(graph), clock: clock() });
    const result = runtime.dispatchEvent("go");
    expect(result.entries[0]).toMatchObject({ outcome: "rejected", reason: expect.stringContaining("没有匹配") });
  });

  it("动作数上限:超限动作被拒绝并留痕", () => {
    const nodes: BehaviorGraphNode[] = [{ id: "ev", kind: "event", event: { kind: "scene-event", name: "go" } }];
    const edgeList: { from: string; to: string }[] = [];
    const actionCount = 5;
    for (let index = 0; index < actionCount; index += 1) {
      nodes.push({ id: `a${index}`, kind: "action", action: { type: "trace", message: `m${index}` } });
      edgeList.push({ from: "ev", to: `a${index}` });
    }
    const runtime = new BehaviorGraphRuntime({
      graph: compile({ id: "cap", name: "cap", nodes, edges: edgeList }),
      clock: clock(),
      limits: { maxActionsPerDispatch: 3 },
    });
    const result = runtime.dispatchEvent("go");
    expect(result.commands).toHaveLength(3);
    expect(result.entries.filter((entry) => entry.outcome === "applied")).toHaveLength(3);
    expect(result.entries.filter((entry) => entry.outcome === "rejected")).toHaveLength(2);
  });

  it("步数预算耗尽:budget-exceeded 中止,已产生命令保留,轨迹留 rejected", () => {
    const graph = thresholdGraph();
    const runtime = new BehaviorGraphRuntime({
      graph: compile(graph),
      clock: clock(),
      limits: { maxStepsPerDispatch: 3 }, // 条件(3节点)+第一个动作(2节点)后耗尽
    });
    const result = runtime.applyData({ temperature: 95 });
    expect(result.status).toBe("budget-exceeded");
    expect(result.reason).toContain("步数预算");
    expect(result.commands.length).toBeLessThan(3);
    expect(result.entries.some((entry) => entry.outcome === "rejected" && (entry.reason ?? "").includes("步数预算"))).toBe(true);
  });
});

describe("BehaviorGraphRuntime tick 与数据变化", () => {
  it("advance 按间隔触发 tick;重置后调度归零(变量须先初始化——未知标识符是硬错误)", () => {
    const graph: BehaviorGraph = {
      id: "tick",
      name: "tick",
      nodes: [
        { id: "t", kind: "event", event: { kind: "tick", intervalMs: 100 } },
        { id: "count", kind: "action", action: { type: "set-value", key: "beats", expression: "values.beats + 1" } },
      ],
      edges: [{ from: "t", to: "count" }],
    };
    const runtime = new BehaviorGraphRuntime({ graph: compile(graph), clock: clock() });
    // 变量空间先初始化(未初始化标识符被求值器拒绝,审计优先)。
    expect(runtime.applyData({ beats: 0 }).status).toBe("completed");
    expect(runtime.advance(50).status).toBe("no-match");
    expect(runtime.advance(60).commands).toHaveLength(1); // 累计 110ms ≥ 100
    expect(runtime.getValue("beats")).toBe(1);
    runtime.advance(200);
    expect(runtime.getValue("beats")).toBe(3);
    runtime.reset();
    expect(runtime.getValues()).toStrictEqual({});
    runtime.applyData({ beats: 0 });
    expect(runtime.advance(150).commands).toHaveLength(1); // 重置后 100ms 阈值重新计时
  });

  it("tick 追赶上限:积压快进丢弃并留痕", () => {
    const graph: BehaviorGraph = {
      id: "flood",
      name: "flood",
      nodes: [
        { id: "t", kind: "event", event: { kind: "tick", intervalMs: 10 } },
        { id: "act", kind: "action", action: { type: "trace", message: "tick" } },
      ],
      edges: [{ from: "t", to: "act" }],
    };
    const runtime = new BehaviorGraphRuntime({
      graph: compile(graph),
      clock: clock(),
      limits: { maxTickCatchUp: 4 },
    });
    const result = runtime.advance(1_000); // 100 个周期,只补 4 个
    expect(result.commands).toHaveLength(4);
    expect(result.entries.some((entry) => entry.outcome === "rejected" && (entry.reason ?? "").includes("追赶上限"))).toBe(true);
  });

  it("applyData 只对变化键派发;值不变不触发", () => {
    const runtime = new BehaviorGraphRuntime({ graph: compile(thresholdGraph()), clock: clock() });
    const first = runtime.applyData({ temperature: 50, humidity: 30 });
    expect(first.status).toBe("completed"); // temperature 键变化(尽管条件为假)
    const same = runtime.applyData({ temperature: 50 });
    expect(same.status).toBe("no-match");
    expect(same.commands).toStrictEqual([]);
    const changed = runtime.applyData({ humidity: 99 });
    // humidity 变化已入变量空间(数据面 ⊇ 规则监听面),但图未监听该键 → 零命令。
    expect(changed.status).toBe("completed");
    expect(changed.commands).toStrictEqual([]);
    expect(runtime.getValue("humidity")).toBe(99);
  });
});

describe("BehaviorGraphRuntime 确定性", () => {
  it("同图同初态同事件序列 → 命令与轨迹逐字段全等", () => {
    const run = (): { commands: unknown[]; trace: unknown[] } => {
      const trace = new BehaviorTraceLog({ clock: clock() });
      const runtime = new BehaviorGraphRuntime({ graph: compile(thresholdGraph()), trace, clock: new MonotonicBehaviorClock() });
      const commands: unknown[] = [];
      for (const value of [95, 50, 81, 81]) {
        commands.push(...runtime.applyData({ temperature: value }).commands);
        commands.push(...runtime.advance(16).commands);
      }
      return { commands, trace: trace.snapshot() };
    };
    const first = run();
    const second = run();
    expect(first.commands).toStrictEqual(second.commands);
    expect(first.trace).toStrictEqual(second.trace);
    // 场景断言:95 与 81 各触发一次 set-value;第二个 81 值未变不派发 → 共 2 次。
    expect(first.commands.filter((command) => (command as { key?: string }).key === "alarmLevel")).toHaveLength(2);
  });

  it("运行时限制默认值未被放宽(防漂移哨兵)", () => {
    expect(BEHAVIOR_GRAPH_RUNTIME_LIMITS).toStrictEqual({
      maxActionsPerDispatch: 64,
      maxEventReentryDepth: 4,
      maxStepsPerDispatch: 20_000,
      maxTickCatchUp: 16,
    });
  });

  it("inputs 注入只读输入参与条件求值", () => {
    const graph: BehaviorGraph = {
      id: "inputs",
      name: "inputs",
      nodes: [
        { id: "ev", kind: "event", event: { kind: "scene-event", name: "check" } },
        { id: "cond", kind: "condition", expression: "inputs.rated > 100" },
        { id: "act", kind: "action", action: { type: "trace", message: "over-rated" } },
      ],
      edges: [
        { from: "ev", to: "cond" },
        { from: "cond", to: "act" },
      ],
    };
    const runtime = new BehaviorGraphRuntime({ graph: compile(graph), clock: clock() });
    expect(runtime.dispatchEvent("check", undefined, { rated: 50 }).commands).toStrictEqual([]);
    expect(runtime.dispatchEvent("check", undefined, { rated: 150 }).commands).toHaveLength(1);
  });
});
