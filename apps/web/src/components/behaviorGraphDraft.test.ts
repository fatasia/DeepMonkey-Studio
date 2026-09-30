/**
 * G2-S2a 行为图草案变换层测试(纯函数,无 DOM)。
 *
 * 覆盖:调色板全集实例化、确定性 id、连线合法性(端型/自环/重边/环)、删除级联、
 * 序列化幂等与无损往返、保存门禁(非法 0 落库)、直写守卫、表达式行/列定位。
 * 权威仲裁始终是 parseRestrictedInteractionScript / validateBehaviorGraph,
 * 本套测试证明变换层的输出与权威口径一致。
 */
import { describe, expect, it } from "vitest";
import {
  BEHAVIOR_PALETTE,
  addDraftNode,
  asDraftActionPatch,
  connectDraftEdge,
  connectIllegalReason,
  createNodeForEntry,
  defaultNodePosition,
  emptyBehaviorGraph,
  expressionIssueOf,
  formatExpressionMessage,
  gateBehaviorGraphCode,
  guardRestrictedCodeWrite,
  nextNodeId,
  parseDraftGraph,
  removeDraftEdge,
  removeDraftNodes,
  replaceDraftNode,
  serializeBehaviorGraph,
  snapToGrid,
  type DraftGraph,
} from "./behaviorGraphDraft";
import { RESTRICTED_GRAPH_PREFIX } from "../scripting/restrictedInteractionDocument";
import { compileExpression } from "../scripting/restrictedEvaluator";

/** 最小合法拓扑:事件→条件→动作(动作参数经 overrides 注入)。 */
function wiredGraph(actionType: string, actionParams: Record<string, unknown>): DraftGraph {
  const base = emptyBehaviorGraph();
  const event = createNodeForEntry("data-change", "evt-1", base)!;
  const condition = createNodeForEntry("condition", "cond-1", base)!;
  const action = createNodeForEntry(actionType, "act-1", base)!;
  return {
    ...base,
    nodes: [event, condition, { ...action, action: { ...(action.action ?? {}), ...actionParams } }],
    edges: [{ from: "evt-1", to: "cond-1" }, { from: "cond-1", to: "act-1" }],
  };
}

function traceGraph(): DraftGraph {
  return wiredGraph("trace", { message: "报警" });
}

describe("调色板目录(T31 白名单全集,零新增语义)", () => {
  it("13 个条目:3 事件 + 1 条件 + 9 动作,id 唯一且全部可实例化", () => {
    expect(BEHAVIOR_PALETTE).toHaveLength(13);
    expect(BEHAVIOR_PALETTE.filter((entry) => entry.group === "event")).toHaveLength(3);
    expect(BEHAVIOR_PALETTE.filter((entry) => entry.group === "condition")).toHaveLength(1);
    expect(BEHAVIOR_PALETTE.filter((entry) => entry.group === "action")).toHaveLength(9);
    const ids = new Set(BEHAVIOR_PALETTE.map((entry) => entry.id));
    expect(ids.size).toBe(13);
    const graph = emptyBehaviorGraph();
    for (const entry of BEHAVIOR_PALETTE) {
      expect(createNodeForEntry(entry.id, `node-${entry.id}`, graph)).toBeDefined();
    }
  });

  it("未知条目不产生节点(拒绝即拒绝,不猜)", () => {
    expect(createNodeForEntry("not-in-whitelist", "x", emptyBehaviorGraph())).toBeUndefined();
    expect(addDraftNode(emptyBehaviorGraph(), "not-in-whitelist").nodeId).toBeUndefined();
  });
});

describe("节点变换:确定性 id、删除级联、序列化幂等", () => {
  it("nextNodeId 取最小未占用后缀;同输入同输出", () => {
    const graph = emptyBehaviorGraph();
    const first = addDraftNode(graph, "data-change");
    expect(first.nodeId).toBe("data-change-1");
    const second = addDraftNode(first.graph, "data-change");
    expect(second.nodeId).toBe("data-change-2");
    expect(addDraftNode(graph, "data-change").nodeId).toBe("data-change-1");
  });

  it("默认 id 全部匹配权威 id 规则(字母数字_.:-,≤64)", () => {
    let current: DraftGraph = emptyBehaviorGraph();
    for (const entry of BEHAVIOR_PALETTE) {
      const result = addDraftNode(current, entry.id);
      expect(result.nodeId).toMatch(/^[A-Za-z0-9_.:\-]{1,64}$/);
      current = result.graph;
    }
  });

  it("removeDraftNodes 级联清理关联边,无关节点不动", () => {
    const graph = traceGraph();
    const removed = removeDraftNodes(graph, ["cond-1"]);
    expect(removed.nodes.map((node) => node.id)).toEqual(["evt-1", "act-1"]);
    expect(removed.edges).toEqual([]);
    expect(removeDraftNodes(graph, []).edges).toEqual(graph.edges);
  });

  it("serializeBehaviorGraph 幂等:serialize(parse(text)) === text(规范形)", () => {
    const text = serializeBehaviorGraph(traceGraph());
    expect(serializeBehaviorGraph(parseDraftGraph(text).graph!)).toBe(text);
  });

  it("replaceDraftNode 改参数 → 权威门禁同步翻转(坏色拒、好色过)", () => {
    const bad = replaceDraftNode(traceGraph(), "act-1", {
      id: "act-1", kind: "action", action: { type: "set-color", target: "wall-1", color: "red" },
    });
    expect(gateBehaviorGraphCode(serializeBehaviorGraph(bad)).ok).toBe(false);
    const good = replaceDraftNode(bad, "act-1", {
      id: "act-1", kind: "action", action: { type: "set-color", target: "wall-1", color: "#ff4057" },
    });
    expect(gateBehaviorGraphCode(serializeBehaviorGraph(good)).ok).toBe(true);
  });

  it("可选键空值整键移除(严格 hasKeys 不容忍多余/空形态)", () => {
    const patched = asDraftActionPatch({ type: "animate", command: "play", target: "pump-1" }, { target: "" });
    expect(Object.keys(patched).sort()).toEqual(["command", "type"]);
    const kept = asDraftActionPatch({ type: "set-visibility", target: "", mode: "toggle" }, { target: "" });
    expect(kept.target).toBe(""); // 必需目标动作保留空串,由校验器以 issue 引导补全
    const dropped = asDraftActionPatch({ type: "trace", message: "x", valueExpression: "1" }, { valueExpression: undefined });
    expect("valueExpression" in dropped).toBe(false);
  });
});

describe("连线合法性(与 T31 校验器规则同源,即时反馈文案)", () => {
  const graph = traceGraph();

  it("动作节点出边拒绝(叶节点),理由与校验器口径一致", () => {
    const result = connectDraftEdge(graph, "act-1", "cond-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("必须为叶");
    expect(connectIllegalReason(graph, "act-1", "cond-1")).toContain("叶");
  });

  it("自环、重复边拒绝", () => {
    expect(connectIllegalReason(graph, "cond-1", "cond-1")).toContain("自环");
    expect(connectIllegalReason(graph, "evt-1", "cond-1")).toContain("重复边");
  });

  it("事件节点不接受入边;对动作的合法连入通过", () => {
    expect(connectIllegalReason(graph, "cond-1", "evt-1")).toContain("入口");
    expect(connectDraftEdge(graph, "evt-1", "act-1").ok).toBe(true);
  });

  it("成环连线拒绝:条件链回连被拦,理由指向 emit-event 回线", () => {
    const base = addDraftNode(traceGraph(), "condition");
    const chain = connectDraftEdge(base.graph, "cond-1", base.nodeId!);
    expect(chain.ok).toBe(true);
    const cyclic = connectDraftEdge(chain.ok ? chain.graph : base.graph, chain.ok ? base.nodeId! : "cond-1", "cond-1");
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) expect(cyclic.reason).toContain("环");
  });

  it("纯函数:拒绝路径不改入参文档", () => {
    const before = serializeBehaviorGraph(graph);
    connectDraftEdge(graph, "act-1", "cond-1");
    connectDraftEdge(graph, "cond-1", "evt-1");
    expect(serializeBehaviorGraph(graph)).toBe(before);
  });
});

describe("保存门禁:非法文档 0 条落库(权威解析器仲裁)", () => {
  it("空图合法可保存(新建行为图的开箱状态)", () => {
    expect(gateBehaviorGraphCode(serializeBehaviorGraph(emptyBehaviorGraph())).ok).toBe(true);
  });

  it("孤立事件节点(dead-end)被门禁拒绝,message 权威透传", () => {
    const graph = addDraftNode(emptyBehaviorGraph(), "data-change").graph;
    const gate = gateBehaviorGraphCode(serializeBehaviorGraph(graph));
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.message).toContain("没有任何出边");
  });

  it("坏 JSON 被门禁拒绝且不回退可信 JS", () => {
    const gate = gateBehaviorGraphCode(`${RESTRICTED_GRAPH_PREFIX}{"schemaVersion":1,`);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.message).toContain("JSON 格式错误");
  });

  it("wiredGraph 语义字段无损往返:serialize → 权威解析 → 逐字段相等", () => {
    const graph = wiredGraph("trace", { message: "报警", valueExpression: "value + 1" });
    const text = serializeBehaviorGraph(graph);
    expect(gateBehaviorGraphCode(text).ok).toBe(true);
    const reparsed = parseDraftGraph(text).graph!;
    expect(reparsed.nodes.map((node) => node.id)).toEqual(graph.nodes.map((node) => node.id));
    expect(reparsed.edges).toEqual(graph.edges);
    expect(reparsed.nodes.find((node) => node.id === "act-1")?.action).toEqual(graph.nodes.find((node) => node.id === "act-1")?.action);
  });

  it("9 类动作参数齐全时逐一过门禁(全拓扑:event→condition→action)", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["set-value", { key: "level", expression: "value + 1" }],
      ["emit-event", { name: "alarm" }],
      ["animate", { command: "play", target: "pump-1" }],
      ["set-visibility", { target: "pump-1", mode: "toggle" }],
      ["set-color", { target: "pump-1", color: "#ff4057" }],
      ["set-opacity", { target: "pump-1", expression: "0.5" }],
      ["audio", { command: "play" }],
      ["trace", { message: "报警" }],
      ["engine-command", { command: "camera.fly-to", params: { modelId: "pump-1" } }],
    ];
    for (const [type, params] of cases) {
      const gate = gateBehaviorGraphCode(serializeBehaviorGraph(wiredGraph(type, params)));
      expect(gate.ok, `${type} 应过门禁${gate.ok ? "" : `:${(gate as { message: string }).message}`}`).toBe(true);
    }
  });

  it("直写守卫:非法受限文本被拦、合法放行、可信 JS 通道不拦", () => {
    expect(guardRestrictedCodeWrite("api.log(1);")).toBeUndefined();
    expect(guardRestrictedCodeWrite(`${RESTRICTED_GRAPH_PREFIX}not-json`)).toContain("JSON 格式错误");
    expect(guardRestrictedCodeWrite(serializeBehaviorGraph(traceGraph()))).toBeUndefined();
  });
});

describe("表达式即时校验:行/列定位与消息呈现", () => {
  it("单行表达式错误定位到列", () => {
    const issue = expressionIssueOf("value +* 2");
    expect(issue).toBeDefined();
    expect(issue!.line).toBe(1);
    expect(issue!.column).toBeGreaterThan(1);
  });

  it("多行表达式错误定位到行", () => {
    const issue = expressionIssueOf("value > 1\n&& (value < 10\n+ )");
    expect(issue).toBeDefined();
    expect(issue!.line).toBeGreaterThanOrEqual(2);
  });

  it("合法表达式零 issue;空串零 issue", () => {
    expect(expressionIssueOf("values.temperature > 80")).toBeUndefined();
    expect(expressionIssueOf("")).toBeUndefined();
    expect(() => compileExpression("values.temperature > 80")).not.toThrow();
  });

  it("formatExpressionMessage 剥掉重复的“(偏移 N)”定位段", () => {
    expect(formatExpressionMessage("意外的 token “*”(偏移 8)")).toBe("意外的 token “*”");
    expect(formatExpressionMessage("普通错误")).toBe("普通错误");
  });
});

describe("坐标与边删除:吸附、默认槽位确定性、越界安全", () => {
  it("snapToGrid 落点吸附 20px 网格", () => {
    expect(snapToGrid({ x: 137, y: -13 })).toEqual({ x: 140, y: -20 });
    expect(snapToGrid({ x: 10, y: 10 })).toEqual({ x: 20, y: 20 });
  });

  it("defaultNodePosition 同文档同位置(点击新增不漂移)", () => {
    const graph = traceGraph();
    expect(defaultNodePosition(graph)).toEqual(defaultNodePosition(parseDraftGraph(serializeBehaviorGraph(graph)).graph!));
  });

  it("removeDraftEdge 按下标删除,越界安全", () => {
    const graph = traceGraph();
    expect(removeDraftEdge(graph, 0).edges).toHaveLength(1);
    expect(removeDraftEdge(graph, 99).edges).toHaveLength(2);
  });

  it("nextNodeId 命名空间互不干扰(已占用的 evt-1/cond-1 被跳过)", () => {
    const graph = parseDraftGraph(serializeBehaviorGraph(traceGraph())).graph!;
    expect(nextNodeId(graph, "evt")).toBe("evt-2");
    expect(nextNodeId(graph, "cond")).toBe("cond-2");
    expect(nextNodeId(graph, "pump")).toBe("pump-1");
  });
});
