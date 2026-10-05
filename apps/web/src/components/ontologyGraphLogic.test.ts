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
  computeGraphClusters,
  computeNeighborhoodHighlight,
  graphClusterKeyOf,
  GRAPH_CLUSTER_THRESHOLD,
  GRAPH_COMPACT_BREAKPOINT,
  GRAPH_NODE_KIND_META,
  GRAPH_NODE_KIND_ORDER,
  GRAPH_STATUS_META,
  projectClusteredGraph,
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

describe("Semantica 刀1:治理态形+色双编码元数据", () => {
  it("四态各自具备形状与语义类,且互不重复", () => {
    const shapes = Object.values(GRAPH_STATUS_META).map((meta) => meta.shape);
    expect(new Set(shapes).size).toBe(4);
    expect(GRAPH_STATUS_META.published.shape).toBe("circle");
    expect(GRAPH_STATUS_META.review.shape).toBe("diamond");
    expect(GRAPH_STATUS_META.draft.shape).toBe("square");
    expect(GRAPH_STATUS_META.retired.shape).toBe("ghost");
    expect(GRAPH_STATUS_META.published.css).toBe("is-published");
  });
});

describe("Semantica 刀1:关联链路高亮(1 跳强 + 2 跳弱)", () => {
  const edges = [
    edge("e1", "object:A", "object:B"),
    edge("e2", "object:B", "object:C"),
    edge("e3", "object:C", "object:D"),
    edge("e4", "object:X", "object:Y"),
  ];
  it("1 跳邻居与关联边强高亮,2 跳进次级集,孤立边不受影响", () => {
    const highlight = computeNeighborhoodHighlight(edges, "object:B");
    expect(highlight.nodes.has("object:A")).toBe(true);
    expect(highlight.nodes.has("object:C")).toBe(true);
    expect(highlight.edges.has("e1")).toBe(true);
    expect(highlight.edges.has("e2")).toBe(true);
    expect(highlight.secondary.has("object:D")).toBe(true);
    expect(highlight.edges.has("e3")).toBe(true);
    expect(highlight.nodes.has("object:X")).toBe(false);
    expect(highlight.edges.has("e4")).toBe(false);
  });
  it("maxHops=1 时次级集为空;未关联节点只含自身", () => {
    const one = computeNeighborhoodHighlight(edges, "object:A", 1);
    expect(one.secondary.size).toBe(0);
    expect(one.nodes.has("object:B")).toBe(true);
    const lone = computeNeighborhoodHighlight(edges, "object:X");
    expect(lone.nodes.has("object:Y")).toBe(true);
    expect(lone.secondary.size).toBe(0);
  });
});

describe("Semantica 刀1:大图 LOD 聚簇", () => {
  const many = [
    node("object", "A", "对象A"),
    node("object", "B", "对象B"),
    node("dataset", "ds1", "数据源"),
    node("action", "act1", "行动"),
  ].map((item, index) => ({ ...item, status: (index % 2 === 0 ? "published" : "draft") as OntologyGraphNode["status"] }));
  many[0] = { ...many[0]!, domain: "manufacturing" };
  many[1] = { ...many[1]!, domain: "manufacturing" };
  const clusterEdges = [edge("c1", "object:A", "object:B"), edge("c2", "object:A", "dataset:ds1"), edge("c3", "dataset:ds1", "action:act1")];

  it("阈值内不聚合;超阈值按对象域/类型聚簇并带治理态分布", () => {
    expect(computeGraphClusters(many, 10)).toBeUndefined();
    expect(GRAPH_CLUSTER_THRESHOLD).toBe(500);
    const clusters = computeGraphClusters(many, 3)!;
    expect(clusters).toHaveLength(3); // 对象(manufacturing) + 数据 + 行动
    const objectCluster = clusters.find((item) => item.key === "manufacturing")!;
    expect(objectCluster.kind).toBe("object");
    expect(objectCluster.memberIds.sort()).toEqual(["object:A", "object:B"]);
    expect(objectCluster.statusCounts.map((item) => item.status).sort()).toEqual(["draft", "published"]);
  });
  it("graphClusterKeyOf:对象按域(缺省未分域),其余按类型", () => {
    expect(graphClusterKeyOf(node("object", "C"))).toEqual({ kind: "object", key: "unfiled" });
    expect(graphClusterKeyOf(node("event", "e1"))).toEqual({ kind: "event", key: "event" });
  });
  it("收起投影:成员替换为簇伪节点,跨簇边重映射并去重聚合,簇内边消失", () => {
    const clusters = computeGraphClusters(many, 3)!;
    const projection = projectClusteredGraph(many, clusterEdges, clusters, new Set());
    const ids = projection.nodes.map((item) => item.id);
    expect(ids).toContain("cluster:object:manufacturing");
    expect(ids).not.toContain("object:A");
    expect(projection.clusterOf.get("object:A")).toBe("cluster:object:manufacturing");
    const ids2 = projection.edges.map((item) => item.id);
    expect(ids2).not.toContain("c1"); // 簇内边不占画布
    const cross = projection.edges.find((item) => item.source === "cluster:object:manufacturing");
    expect(cross).toBeDefined();
    // 多条同向同标签边聚合出 ×N 计数
    const duplicated = projectClusteredGraph(
      many,
      [edge("d1", "object:A", "dataset:ds1", "relation", "same"), edge("d2", "object:B", "dataset:ds1", "relation", "same")],
      clusters,
      new Set(),
    );
    const merged = duplicated.edges.find((item) => item.target === "cluster:dataset:dataset");
    expect(merged?.aggregatedCount).toBe(2);
  });
  it("展开投影:被展开簇还原成员原节点,其余簇保持聚合", () => {
    const clusters = computeGraphClusters(many, 3)!;
    const objectCluster = clusters.find((item) => item.key === "manufacturing")!;
    const projection = projectClusteredGraph(many, clusterEdges, clusters, new Set([objectCluster.id]));
    const ids = projection.nodes.map((item) => item.id);
    expect(ids).toContain("object:A");
    expect(ids).toContain("object:B");
    expect(ids).toContain("cluster:dataset:dataset");
    const cross = projection.edges.find((item) => item.id === "c2");
    expect(cross?.target).toBe("cluster:dataset:dataset");
  });
});
