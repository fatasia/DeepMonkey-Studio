import { describe, expect, it } from "vitest";
import {
  BEHAVIOR_GRAPH_LIMITS,
  validateBehaviorGraph,
  type BehaviorEngineCommandName,
  type BehaviorGraph,
} from "./behaviorGraph";

/** 传感器超限→触发动作的最小合法图(主计划 §9 T31 示例场景)。
 *  注意:表达式经点路径取值,数据键须无点(点键只能存储、不能在表达式引用,报告已记此边界)。 */
function thresholdGraph(): BehaviorGraph {
  return {
    id: "valve-guard",
    name: "传感器超限联动",
    nodes: [
      { id: "on-data", kind: "event", event: { kind: "data-change", key: "temperature" } },
      { id: "over-limit", kind: "condition", expression: "values.temperature > 80" },
      { id: "open-valve", kind: "action", action: { type: "animate", target: "valve-1", command: "play" } },
    ],
    edges: [
      { from: "on-data", to: "over-limit" },
      { from: "over-limit", to: "open-valve" },
    ],
  };
}

describe("validateBehaviorGraph 合法图", () => {
  it("合法图通过并产出编译产物(邻接表/条件编译/节点分类)", () => {
    const result = validateBehaviorGraph(thresholdGraph());
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.graph.eventNodes.map((node) => node.id)).toStrictEqual(["on-data"]);
    expect(result.graph.outgoing.get("on-data")).toStrictEqual(["over-limit"]);
    expect(result.graph.conditionExpressions.get("over-limit")?.source).toBe("values.temperature > 80");
    expect(result.graph.actionNodes.has("open-valve")).toBe(true);
    expect(result.graph.nodeKinds.get("over-limit")).toBe("condition");
  });

  it("多事件分支图通过(scene-event + tick)", () => {
    const graph: BehaviorGraph = {
      id: "multi",
      name: "多事件",
      nodes: [
        { id: "tick", kind: "event", event: { kind: "tick", intervalMs: 1_000 } },
        { id: "alarm", kind: "event", event: { kind: "scene-event", name: "alarm" } },
        { id: "heartbeat", kind: "action", action: { type: "trace", message: "心跳" } },
        { id: "on-alarm", kind: "action", action: { type: "audio", command: "play" } },
      ],
      edges: [
        { from: "tick", to: "heartbeat" },
        { from: "alarm", to: "on-alarm" },
      ],
    };
    expect(validateBehaviorGraph(graph).valid).toBe(true);
  });
});

describe("validateBehaviorGraph 结构校验", () => {
  it("环被拒绝并给出路径(条件节点之间构环;动作是叶,环无法经过动作)", () => {
    const graph = thresholdGraph();
    const cyclic: BehaviorGraph = {
      ...graph,
      nodes: [...graph.nodes, { id: "loop-back", kind: "condition", expression: "1" }],
      edges: [...graph.edges, { from: "over-limit", to: "loop-back" }, { from: "loop-back", to: "over-limit" }],
    };
    const result = validateBehaviorGraph(cyclic);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const cycle = result.issues.find((issue) => issue.code === "cycle");
    expect(cycle).toBeDefined();
    expect(cycle?.message).toContain("over-limit");
  });

  it("自环/重复边/未知端点被拒绝", () => {
    const graph = thresholdGraph();
    const result = validateBehaviorGraph({
      ...graph,
      edges: [
        ...graph.edges,
        { from: "open-valve", to: "open-valve" },
        { from: "on-data", to: "over-limit" },
        { from: "ghost", to: "open-valve" },
      ],
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("self-loop");
    expect(codes).toContain("duplicate-edge");
    expect(codes).toContain("unknown-node-ref");
  });

  it("深度超限被拒绝", () => {
    const chainLength = BEHAVIOR_GRAPH_LIMITS.maxDepth + 1;
    const nodes: BehaviorGraph["nodes"] = [
      { id: "ev", kind: "event", event: { kind: "scene-event", name: "go" } },
      ...Array.from({ length: chainLength }, (_, index): BehaviorGraph["nodes"][number] => ({
        id: `c${index}`,
        kind: "condition",
        expression: "1",
      })),
    ];
    const edgeList: { from: string; to: string }[] = [{ from: "ev", to: "c0" }];
    for (let index = 0; index < chainLength - 1; index += 1) edgeList.push({ from: `c${index}`, to: `c${index + 1}` });
    const result = validateBehaviorGraph({ id: "deep", name: "deep", nodes, edges: edgeList });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.some((issue) => issue.code === "depth-exceeded")).toBe(true);
  });

  it("孤立节点(不可达)与死事件/死分支被拒绝", () => {
    const graph = thresholdGraph();
    const result = validateBehaviorGraph({
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: "lonely-action", kind: "action", action: { type: "trace", message: "孤立" } },
        // isolated-event 无出边 → 死事件;dead-event 有出边 → 不算死,但 dead-condition 无出边 → 死分支。
        { id: "isolated-event", kind: "event", event: { kind: "tick", intervalMs: 500 } },
        { id: "dead-event", kind: "event", event: { kind: "scene-event", name: "lost" } },
        { id: "dead-condition", kind: "condition", expression: "1" },
      ],
      edges: [...graph.edges, { from: "dead-event", to: "dead-condition" }],
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const codes = result.issues.map((issue) => issue.code);
    // lonely-action 不可达;isolated-event 与 dead-condition 无出边。
    expect(codes.filter((code) => code === "unreachable").length).toBe(1);
    expect(codes.filter((code) => code === "dead-end").length).toBe(2);
  });

  it("动作节点出边被拒绝(动作必须为叶)", () => {
    const graph = thresholdGraph();
    const result = validateBehaviorGraph({
      ...graph,
      edges: [...graph.edges, { from: "open-valve", to: "over-limit" }],
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.some((issue) => issue.code === "dead-end" && issue.message.includes("必须为叶"))).toBe(true);
  });

  it("id 非法/重复被拒绝", () => {
    const graph = thresholdGraph();
    const result = validateBehaviorGraph({
      ...graph,
      nodes: [...graph.nodes, { id: "on-data", kind: "action", action: { type: "trace", message: "x" } }],
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.some((issue) => issue.code === "duplicate-id")).toBe(true);

    const invalidId = validateBehaviorGraph({ ...graph, id: "非法 id!" });
    expect(invalidId.valid).toBe(false);
  });

  it("节点数超限被拒绝", () => {
    const nodes: BehaviorGraph["nodes"] = Array.from(
      { length: BEHAVIOR_GRAPH_LIMITS.maxNodes + 1 },
      (_, index): BehaviorGraph["nodes"][number] => ({
        id: `n${index}`,
        kind: "event",
        event: { kind: "scene-event", name: `e${index}` },
      }),
    );
    const result = validateBehaviorGraph({ id: "big", name: "big", nodes, edges: [] });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.some((issue) => issue.code === "limit-exceeded")).toBe(true);
  });
});

describe("validateBehaviorGraph 动作与事件白名单", () => {
  it("颜色/键名/事件名/tick 间隔/表达式非法被拒绝", () => {
    const graph: BehaviorGraph = {
      id: "bad-params",
      name: "bad",
      nodes: [
        { id: "ev", kind: "event", event: { kind: "tick", intervalMs: 1 } },
        { id: "color", kind: "action", action: { type: "set-color", target: "m1", color: "red" } },
        { id: "value", kind: "action", action: { type: "set-value", key: "bad key", expression: "1 +" } },
        { id: "emit", kind: "action", action: { type: "emit-event", name: "" } },
        { id: "cond", kind: "condition", expression: "eval()" },
      ],
      edges: [
        { from: "ev", to: "color" },
        { from: "ev", to: "value" },
        { from: "ev", to: "emit" },
        { from: "ev", to: "cond" },
      ],
    };
    const result = validateBehaviorGraph(graph);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const messages = result.issues.map((issue) => issue.message).join("\n");
    expect(result.issues.some((issue) => issue.code === "invalid-event")).toBe(true);
    expect(messages).toContain("#RRGGBB");
    expect(messages).toContain("set-value");
    expect(messages).toContain("emit-event");
    expect(messages).toContain("不允许函数调用");
  });

  it("引擎命令白名单与 params 序列化上限", () => {
    const build = (command: BehaviorEngineCommandName, params: Record<string, unknown>): BehaviorGraph => ({
      id: "engine",
      name: "engine",
      nodes: [
        { id: "ev", kind: "event", event: { kind: "scene-event", name: "go" } },
        { id: "act", kind: "action", action: { type: "engine-command", command, params } },
        { id: "cond", kind: "condition", expression: "1" },
      ],
      edges: [
        { from: "ev", to: "cond" },
        { from: "cond", to: "act" },
      ],
    });
    expect(validateBehaviorGraph(build("camera.fly-to", { durationMs: 800 })).valid).toBe(true);

    const unknown = validateBehaviorGraph(build("shell.exec" as BehaviorEngineCommandName, {}));
    expect(unknown.valid).toBe(false);
    if (!unknown.valid) expect(unknown.issues.some((issue) => issue.message.includes("白名单"))).toBe(true);

    const oversized = validateBehaviorGraph(
      build("data.apply", { blob: "x".repeat(BEHAVIOR_GRAPH_LIMITS.maxEngineCommandParamsJson + 10) }),
    );
    expect(oversized.valid).toBe(false);
  });

  it("targetExists 注入:目标不存在被拒绝;未注入则跳过", () => {
    const graph = thresholdGraph();
    const withResolver = validateBehaviorGraph(graph, { targetExists: () => false });
    expect(withResolver.valid).toBe(false);
    if (!withResolver.valid) expect(withResolver.issues.some((issue) => issue.message.includes("不存在"))).toBe(true);

    expect(validateBehaviorGraph(graph, { targetExists: () => true }).valid).toBe(true);
    expect(validateBehaviorGraph(graph).valid).toBe(true);
  });
});
