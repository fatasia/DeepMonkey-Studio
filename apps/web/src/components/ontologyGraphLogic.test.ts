import { describe, expect, it } from "vitest";
import type { OntologyGraphEdge, OntologyGraphNode, OntologyGraphResult } from "@bim-studio/contracts";
import { ontologyGraphNodeId } from "@bim-studio/contracts";
import {
  actionRiskPresentation,
  applyGraphFilters,
  buildGraphListCards,
  collapseNeighborhood,
  computeIncidentEdges,
  computePathBetween,
  findGraphTargets,
  forceLayout,
  GRAPH_COMPACT_BREAKPOINT,
  GRAPH_NODE_KIND_META,
  GRAPH_NODE_KIND_ORDER,
  shouldUseCompactGraph,
} from "./ontologyGraphLogic";

function node(kind: OntologyGraphNode["kind"], key: string, label = key): OntologyGraphNode {
  return {
    id: ontologyGraphNodeId(kind, key),
    kind,
    key,
    label,
    status: "published",
    version: 1,
    ...(kind === "object" ? { propertyCount: 2, sourceCount: 1 } : {}),
    ...(kind === "action" ? { effect: "read", riskLevel: "low" as const, approvalRequired: false } : {}),
    ...(key === "press-07" ? { aliases: ["压机七号"] } : {}),
  };
}

function edge(id: string, source: string, target: string, kind: OntologyGraphEdge["kind"] = "relation", label = id): OntologyGraphEdge {
  return { id, source, target, kind, label, direction: "directed", status: "published", evidenceCount: 1 };
}

/** Site →(contains) Device →(reads) Metric 的两跳链 + Event 绑定 Device + ds 数据源。 */
function fixtureResult(): OntologyGraphResult {
  return {
    packageId: "pkg-1",
    packageStatus: "published",
    packageVersion: 1,
    packageUpdatedAt: "2026-09-29T08:00:00.000Z",
    root: { type: "object", id: "Site" },
    depth: 2,
    nodes: [
      node("object", "Site"), node("object", "Device"), node("object", "Metric"),
      node("action", "diagnose"), node("event", "down"), node("dataset", "ds-devices"),
      node("object", "press-07", "压机 07"),
    ],
    edges: [
      edge("rel:r1", "object:Site", "object:Device", "relation", "contains"),
      edge("rel:r2", "object:Device", "object:Metric", "relation", "reads"),
      edge("act:a1", "action:diagnose", "object:Device", "action", "acts-on"),
      edge("evt:e1", "event:down", "object:Device", "event", "triggers-on"),
      edge("data:d1", "dataset:ds-devices", "object:Device", "data", "describes"),
    ],
    truncated: false,
    elapsedMs: 1.2,
  };
}

describe("ontology graph logic", () => {
  it("类型元数据覆盖四类且顺序稳定（分色与图标按 kind 查表）", () => {
    expect(GRAPH_NODE_KIND_ORDER).toEqual(["object", "dataset", "action", "event"]);
    for (const kind of GRAPH_NODE_KIND_ORDER) {
      expect(GRAPH_NODE_KIND_META[kind].css).toMatch(/^is-/);
      expect(GRAPH_NODE_KIND_META[kind].zh.length).toBeGreaterThan(0);
      expect(GRAPH_NODE_KIND_META[kind].en.length).toBeGreaterThan(0);
    }
  });

  it("风险呈现：high/critical 归 high 档，medium 归 medium，缺省 low", () => {
    expect(actionRiskPresentation("critical")).toMatchObject({ tone: "high" });
    expect(actionRiskPresentation("high")).toMatchObject({ tone: "high" });
    expect(actionRiskPresentation("medium")).toMatchObject({ tone: "medium" });
    expect(actionRiskPresentation("low")).toMatchObject({ tone: "low" });
  });

  it("力导向确定性：同输入同输出；节点落在画布界内；连通对距离近于孤岛对", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const edges = [{ source: "a", target: "b" }, { source: "b", target: "c" }];
    const first = forceLayout(ids, edges, { width: 800, height: 600 });
    const second = forceLayout(ids, edges, { width: 800, height: 600 });
    expect([...first.entries()]).toEqual([...second.entries()]);
    for (const position of first.values()) {
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.x).toBeLessThanOrEqual(800);
      expect(position.y).toBeGreaterThanOrEqual(0);
      expect(position.y).toBeLessThanOrEqual(600);
    }
    const distance = (a: string, b: string) => {
      const pa = first.get(a)!;
      const pb = first.get(b)!;
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    };
    // 相连 a-b 应比任意跨分量对更近（允许统计意义的宽松界：0.6 倍）
    const crossPair = Math.min(distance("a", "d"), distance("c", "e"));
    expect(distance("a", "b")).toBeLessThan(crossPair * 0.9);
    // 单节点/空输入不炸
    expect(forceLayout(["x"], [], { width: 100, height: 100 }).get("x")).toBeDefined();
    expect(forceLayout([], [], { width: 100, height: 100 }).size).toBe(0);
  });

  it("本地筛选：类型/状态未勾选节点与其关联边一起隐藏", () => {
    const result = fixtureResult();
    const filtered = applyGraphFilters(result, {
      kinds: new Set(["object"]),
      statuses: new Set(["published"]),
    });
    // 保留结果输入顺序（排序责任在服务端 BFS 输出）
    expect(filtered.nodes.map((item) => item.id)).toEqual(["object:Site", "object:Device", "object:Metric", "object:press-07"]);
    expect(filtered.edges.map((item) => item.id)).toEqual(["rel:r1", "rel:r2"]);
    const draftFiltered = applyGraphFilters(result, {
      kinds: new Set(["object", "action"]),
      statuses: new Set(["draft"]),
    });
    expect(draftFiltered.nodes).toEqual([]);
    expect(draftFiltered.edges).toEqual([]);
  });

  it("搜索定位：label/key/别名命中（大小写不敏感），上限 8 条，空词返回空", () => {
    const result = fixtureResult();
    expect(findGraphTargets(result, "").length).toBe(0);
    expect(findGraphTargets(result, "  ").length).toBe(0);
    expect(findGraphTargets(result, "PRESS").map((item) => item.id)).toEqual(["object:press-07"]);
    expect(findGraphTargets(result, "压机七号").map((item) => item.id)).toEqual(["object:press-07"]);
    expect(findGraphTargets(result, "de").map((item) => item.id)).toEqual(["object:Device", "dataset:ds-devices"]);
    // 上限 8
    const big: OntologyGraphResult = { ...result, nodes: Array.from({ length: 12 }, (_, index) => node("object", `o${index}`)) };
    expect(findGraphTargets(big, "o")).toHaveLength(8);
  });

  it("路径高亮：root→target 最短路径含沿途节点与边；不可达 undefined；同点仅自身", () => {
    const result = fixtureResult();
    const path = computePathBetween(result, "object:Site", "object:Metric");
    expect(path).toBeDefined();
    expect([...path!.nodes].sort()).toEqual(["object:Device", "object:Metric", "object:Site"].sort());
    expect([...path!.edges].sort()).toEqual(["rel:r1", "rel:r2"].sort());
    expect(computePathBetween(result, "object:Site", "object:Site")).toEqual({ nodes: new Set(["object:Site"]), edges: new Set() });
    expect(computePathBetween(result, "object:Site", "action:diagnose")).toBeDefined();
    expect(computePathBetween(result, "object:Site", "missing:node")).toBeUndefined();
    expect(computePathBetween(result, "nope", "object:Site")).toBeUndefined();
  });

  it("点击节点高亮相邻边；邻域折叠保留 root 与自身", () => {
    const result = fixtureResult();
    const incident = computeIncidentEdges(result.edges, "object:Device");
    expect([...incident].sort()).toEqual(["act:a1", "data:d1", "evt:e1", "rel:r1", "rel:r2"].sort());
    expect(computeIncidentEdges(result.edges, "object:Missing").size).toBe(0);

    const visible = new Set(result.nodes.map((item) => item.id));
    const collapsed = collapseNeighborhood(visible, result.edges, "object:Device", new Set(["object:Site"]));
    expect(collapsed.has("object:Device")).toBe(true); // 自身保留
    expect(collapsed.has("object:Site")).toBe(true); // keep 保留
    expect(collapsed.has("object:Metric")).toBe(false);
    expect(collapsed.has("action:diagnose")).toBe(false);
    expect(collapsed.has("event:down")).toBe(false);
  });

  it("480px 判定：≤480 为紧凑，>480 与 undefined 为画布", () => {
    expect(shouldUseCompactGraph(320)).toBe(true);
    expect(GRAPH_COMPACT_BREAKPOINT).toBe(480);
    expect(shouldUseCompactGraph(480)).toBe(true);
    expect(shouldUseCompactGraph(481)).toBe(false);
    expect(shouldUseCompactGraph(undefined)).toBe(false);
  });

  it("紧凑卡片：每个节点一张卡，邻居路径按边配对双向可见", () => {
    const result = fixtureResult();
    const cards = buildGraphListCards(result.nodes, result.edges);
    expect(cards).toHaveLength(result.nodes.length);
    const device = cards.find((card) => card.node.id === "object:Device")!;
    expect(device.neighbors.map((item) => item.edge.id).sort()).toEqual(["act:a1", "data:d1", "evt:e1", "rel:r1", "rel:r2"].sort());
    const site = cards.find((card) => card.node.id === "object:Site")!;
    expect(site.neighbors.map((item) => item.node.id)).toEqual(["object:Device"]);
    // 类型序：object 在前，dataset 靠后
    expect(cards[0]!.node.kind).toBe("object");
  });
});
