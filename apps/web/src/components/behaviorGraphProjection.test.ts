import { describe, expect, it } from "vitest";
import { RESTRICTED_GRAPH_PREFIX } from "../scripting/restrictedInteractionDocument";
import {
  projectBehaviorGraphScript,
  type ProjectedGraphNode,
} from "./behaviorGraphProjection";

function graphScript(graph: unknown): string {
  return RESTRICTED_GRAPH_PREFIX + JSON.stringify({ schemaVersion: 1, graph });
}

/** 带回线的最小合法图:数据变化→条件→动作;tick→emit-event 回线到同名场景事件。 */
function validGraph(): Record<string, unknown> {
  return {
    id: "valve-guard",
    name: "阀门联动",
    nodes: [
      { id: "on-data", kind: "event", event: { kind: "data-change", key: "temperature" } },
      { id: "on-alarm", kind: "event", event: { kind: "scene-event", name: "alarm" } },
      { id: "tick", kind: "event", event: { kind: "tick", intervalMs: 1_000 } },
      { id: "over-limit", kind: "condition", expression: "values.temperature > 80" },
      { id: "open-valve", kind: "action", action: { type: "animate", target: "valve-1", command: "play" } },
      { id: "heartbeat", kind: "action", action: { type: "emit-event", name: "alarm" } },
      { id: "log", kind: "action", action: { type: "trace", message: "报警" } },
    ],
    edges: [
      { from: "on-data", to: "over-limit" },
      { from: "over-limit", to: "open-valve" },
      { from: "tick", to: "heartbeat" },
      { from: "on-alarm", to: "log" },
    ],
  };
}

describe("projectBehaviorGraphScript 合法图投影", () => {
  const projection = projectBehaviorGraphScript(graphScript(validGraph()));

  it("合法图:valid、节点三分类计数、预算透传", () => {
    expect(projection.valid).toBe(true);
    expect(projection.parseError).toBeUndefined();
    expect(projection.graphId).toBe("valve-guard");
    expect(projection.stats.nodeCount).toBe(7);
    expect(projection.stats.eventCount).toBe(3);
    expect(projection.stats.conditionCount).toBe(1);
    expect(projection.stats.actionCount).toBe(3);
    expect(projection.issues).toStrictEqual([]);
    expect(projection.budgets).toMatchObject({ maxNodes: 256, maxEdges: 1024, maxDepth: 16, maxStepsPerDispatch: 20_000, maxActionsPerDispatch: 64, maxEventReentryDepth: 4, maxTickCatchUp: 16 });
  });

  it("dagre 布局:event 层在上、action 层在下,坐标全部有限且互不重合", () => {
    expect(projection.positions.size).toBe(7);
    const byId = new Map(projection.nodes.map((node) => [node.rfId, node]));
    const yOf = (id: string) => projection.positions.get(id)!.y;
    expect(yOf("on-data")).toBeLessThan(yOf("over-limit"));
    expect(yOf("over-limit")).toBeLessThan(yOf("open-valve"));
    for (const node of projection.nodes) {
      const position = projection.positions.get(node.rfId)!;
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
    }
    expect(new Set(projection.nodes.map((node: ProjectedGraphNode) => node.rfId)).size).toBe(7);
    expect(byId.get("open-valve")?.title).toContain("animate");
  });

  it("emit-event 回线:合成 reentry 边指向同名 scene-event 事件节点,不占原始边下标", () => {
    const reentry = projection.edges.filter((edge) => edge.kind === "reentry");
    expect(reentry).toHaveLength(1);
    expect(reentry[0]).toMatchObject({ index: -1, from: "heartbeat", to: "on-alarm" });
    expect(projection.edges.filter((edge) => edge.kind === "flow")).toHaveLength(4);
  });

  it("纯函数:同输入两次投影产出完全一致(确定性布局)", () => {
    const again = projectBehaviorGraphScript(graphScript(validGraph()));
    expect(again.nodes).toStrictEqual(projection.nodes);
    expect(again.edges).toStrictEqual(projection.edges);
    expect([...again.positions.entries()]).toStrictEqual([...projection.positions.entries()]);
  });

  it("深度统计:event 起最长路径按边数计", () => {
    expect(projection.stats.maxDepth).toBe(2); // on-data → over-limit → open-valve
  });
});

describe("projectBehaviorGraphScript 非法图 issue 定位", () => {
  it("环:graph 级 issue + 环上节点高亮(权威 message 的回入点节点)", () => {
    const graph = validGraph();
    graph.edges = [
      { from: "on-data", to: "over-limit" },
      { from: "over-limit", to: "open-valve" },
      { from: "tick", to: "heartbeat" },
      { from: "on-alarm", to: "log" },
      { from: "over-limit", to: "on-data" },
    ];
    const projection = projectBehaviorGraphScript(graphScript(graph));
    expect(projection.valid).toBe(false);
    const cycle = projection.graphIssues.find((issue) => issue.code === "cycle");
    expect(cycle).toBeDefined();
    // 校验器 DFS 的环 message 从回入点起报;视图按既有节点 id 过滤提取,不自行重算环。
    expect(cycle?.message).toContain("on-data");
    expect(projection.cycleNodeIds.every((id) => projection.nodes.some((node) => node.id === id))).toBe(true);
    expect(projection.cycleNodeIds).toContain("on-data");
  });

  it("孤立动作节点:unreachable 定位到节点;死分支 dead-end 定位到条件节点", () => {
    const graph = validGraph();
    graph.nodes = [...(graph.nodes as unknown[]), { id: "orphan", kind: "action", action: { type: "trace", message: "没人到我" } }];
    graph.edges = [
      { from: "on-data", to: "over-limit" },
      { from: "over-limit", to: "orphan" },
      { from: "tick", to: "heartbeat" },
      { from: "on-alarm", to: "log" },
      { from: "on-data", to: "dead-branch" },
    ];
    graph.nodes = [...(graph.nodes as unknown[]), { id: "dead-branch", kind: "condition", expression: "1" }];
    const projection = projectBehaviorGraphScript(graphScript(graph));
    expect(projection.nodeIssues.get("orphan")).toBeUndefined(); // 已被 dead-branch 边连上,不再孤立
    expect(projection.nodeIssues.get("dead-branch")?.some((issue) => issue.code === "dead-end")).toBe(true);
    expect(projection.nodeIssues.get("open-valve")?.some((issue) => issue.code === "unreachable")).toBe(true);
  });

  it("白名单外动作参数:set-color 非法颜色定位到动作节点", () => {
    const graph = {
      id: "bad-color",
      name: "坏颜色",
      nodes: [
        { id: "evt", kind: "event", event: { kind: "scene-event", name: "go" } },
        { id: "paint", kind: "action", action: { type: "set-color", target: "wall-1", color: "red" } },
      ],
      edges: [{ from: "evt", to: "paint" }],
    };
    const projection = projectBehaviorGraphScript(graphScript(graph));
    const issues = projection.nodeIssues.get("paint") ?? [];
    expect(issues.some((issue) => issue.code === "invalid-action" && issue.message.includes("#RRGGBB"))).toBe(true);
  });

  it("边引用不存在节点:unknown-node-ref 落在对应原始边下标,该边不进画布", () => {
    const graph = validGraph();
    graph.edges = [
      { from: "on-data", to: "ghost" },
      { from: "on-data", to: "over-limit" },
      { from: "over-limit", to: "open-valve" },
      { from: "tick", to: "heartbeat" },
      { from: "on-alarm", to: "log" },
    ];
    const projection = projectBehaviorGraphScript(graphScript(graph));
    expect(projection.edgeIssues.get(0)?.some((issue) => issue.code === "unknown-node-ref")).toBe(true);
    expect(projection.edges.some((edge) => edge.index === 0)).toBe(false);
    expect(projection.edges.some((edge) => edge.index === 1)).toBe(true);
    expect(projection.edgeIssues.get(1)).toBeUndefined();
  });

  it("重复 id 与自环:duplicate-id 定位到节点、self-loop 定位到边,React Flow 节点 id 仍唯一", () => {
    const graph = {
      id: "dups",
      name: "重复",
      nodes: [
        { id: "a", kind: "event", event: { kind: "scene-event", name: "go" } },
        { id: "a", kind: "action", action: { type: "trace", message: "重名" } },
      ],
      edges: [{ from: "a", to: "a" }],
    };
    const projection = projectBehaviorGraphScript(graphScript(graph));
    expect(projection.nodeIssues.get("a")?.some((issue) => issue.code === "duplicate-id")).toBe(true);
    expect(projection.edgeIssues.get(0)?.some((issue) => issue.code === "self-loop")).toBe(true);
    const rfIds = projection.nodes.map((node) => node.rfId);
    expect(new Set(rfIds).size).toBe(rfIds.length);
    expect(rfIds).toContain("a::dup1");
  });

  it("超深链:depth-exceeded 为图级 issue,深度统计如实显示", () => {
    const nodes: unknown[] = [{ id: "root", kind: "event", event: { kind: "scene-event", name: "go" } }];
    const edges: unknown[] = [];
    for (let index = 0; index < 20; index += 1) {
      const id = `c${index}`;
      nodes.push({ id, kind: "condition", expression: "1" });
      edges.push({ from: index === 0 ? "root" : `c${index - 1}`, to: id });
    }
    const projection = projectBehaviorGraphScript(graphScript({ id: "deep", name: "超深", nodes, edges }));
    expect(projection.stats.maxDepth).toBe(20);
    expect(projection.graphIssues.some((issue) => issue.code === "depth-exceeded")).toBe(true);
  });
});

describe("projectBehaviorGraphScript 文档级错误(权威解析器 message 原样透传)", () => {
  it("缺标记:明确报未声明受限域", () => {
    const projection = projectBehaviorGraphScript("console.log(1)");
    expect(projection.valid).toBe(false);
    expect(projection.parseError).toContain("受限行为图域");
    expect(projection.nodes).toHaveLength(0);
  });

  it("坏 JSON:透传『不会回退可信 JS』语义", () => {
    const projection = projectBehaviorGraphScript(`${RESTRICTED_GRAPH_PREFIX}{not-json`);
    expect(projection.valid).toBe(false);
    expect(projection.parseError).toContain("不会回退可信 JS");
  });

  it("schemaVersion 非法:透传权威报错,宽容提取不臆测未知 schema(空投影)", () => {
    const body = JSON.stringify({ schemaVersion: 2, graph: validGraph() });
    const projection = projectBehaviorGraphScript(RESTRICTED_GRAPH_PREFIX + body);
    expect(projection.parseError).toContain("schemaVersion");
    expect(projection.nodes).toHaveLength(0);
    expect(projection.positions.size).toBe(0);
  });

  it("未知版本标记:保留在受限域内,不回退可信 JS", () => {
    const projection = projectBehaviorGraphScript("/* @bim-studio/restricted-graph/v2 */\nalert(1)");
    expect(projection.valid).toBe(false);
    expect(projection.parseError).toBeTruthy();
    expect(projection.nodes).toHaveLength(0);
  });
});

describe("projectBehaviorGraphScript 256 节点上限夹具", () => {
  /** 8 条链 ×(1 event + 15 condition + 1 终端 action)+ 120 个条件叶 action = 256 节点,深度恰为 16。 */
  function maxScaleGraph(): Record<string, unknown> {
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    for (let chain = 0; chain < 8; chain += 1) {
      const root = `evt-${chain}`;
      nodes.push({ id: root, kind: "event", event: { kind: "data-change", key: `k${chain}` } });
      let previous = root;
      for (let depth = 1; depth <= 15; depth += 1) {
        const id = `cond-${chain}-${depth}`;
        nodes.push({ id, kind: "condition", expression: `values.k${chain} > ${depth}` });
        edges.push({ from: previous, to: id });
        previous = id;
      }
      const terminal = `act-${chain}`;
      nodes.push({ id: terminal, kind: "action", action: { type: "trace", message: `chain ${chain}` } });
      edges.push({ from: previous, to: terminal });
      for (let leaf = 0; leaf < 15; leaf += 1) {
        const leafId = `leaf-${chain}-${leaf}`;
        nodes.push({ id: leafId, kind: "action", action: { type: "trace", message: `${chain}/${leaf}` } });
        edges.push({ from: `cond-${chain}-${leaf + 1}`, to: leafId });
      }
    }
    return { id: "max-scale", name: "上限夹具", nodes, edges };
  }

  it("256 节点 / 248 边全部布局,坐标唯一有限,且为合法图", () => {
    const started = performance.now();
    const projection = projectBehaviorGraphScript(graphScript(maxScaleGraph()));
    const elapsedMs = performance.now() - started;
    expect(projection.valid).toBe(true);
    expect(projection.stats.nodeCount).toBe(256);
    expect(projection.stats.edgeCount).toBe(248);
    expect(projection.stats.maxDepth).toBe(16);
    expect(projection.positions.size).toBe(256);
    const coordinates = [...projection.positions.values()].map((position) => `${position.x}:${position.y}`);
    expect(new Set(coordinates).size).toBe(256);
    for (const { x, y } of projection.positions.values()) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
    // 投影开销留痕(报告口径):不设硬阈值断言,真机交互帧率归浏览器验收。
    console.info(`[behaviorGraphProjection] 256 节点投影耗时 ${elapsedMs.toFixed(1)}ms`);
  });
});
