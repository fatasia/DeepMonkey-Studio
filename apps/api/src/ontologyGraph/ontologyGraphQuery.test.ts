import { describe, expect, it } from "vitest";
import type { OntologyPackage } from "@bim-studio/contracts";
import { newOntologyPackage, ontologyGraphNodeId } from "@bim-studio/contracts";
import { buildPublishablePackage } from "../ontology/ontologyStore.test.js";
import { buildOntologyGraphIndex, queryOntologyGraph, summarizeOntologyGraphScale } from "./ontologyGraphQuery.js";

/**
 * P0 包（Device→Event 关系 + diagnose_device 行动绑定 Device + Device→ds-devices 数据源）
 * 只有 2 跳深度；三跳链/环/方向语义用本文件扩展包覆盖。
 */

/** 三跳链 + 环：Site →(contains) Device →(reads) Metric →(describes) Site（环），加 Event 绑 Device。 */
function buildChainPackage(): OntologyPackage {
  const pkg = newOntologyPackage("manufacturing", "alice", "2026-09-29T08:00:00.000Z");
  pkg.id = "pkg-graph";
  pkg.name = "图谱链包";
  const object = (key: string) => ({
    id: `o-${key}`, key, label: key, domain: "manufacturing",
    primaryKeys: [`${key.toLowerCase()}_id`],
    properties: [{ key: `${key.toLowerCase()}_id`, label: key, type: "string" as const, confirmed: true }],
    sourceBindings: [], aliases: [], identityMappings: [], status: "published" as const, version: 1, owner: "alice",
  });
  pkg.objects = [object("Site"), object("Device"), object("Metric"), object("Sensor")];
  const relation = (id: string, key: string, sourceObject: string, targetObject: string) => ({
    id, key, label: key, sourceObject, targetObject,
    cardinality: "one-to-many" as const, direction: "directed" as const, properties: [],
    keyMapping: { sourceField: "", targetField: "" },
    source: { kind: "dataset" as const, sourceId: "ds", note: "链路印证" },
    evidence: [{ source: "抽样", recordedAt: "2026-09-29T08:00:00.000Z" }],
    status: "published" as const, version: 1,
  });
  pkg.relations = [
    relation("r1", "contains", "Site", "Device"),
    relation("r2", "reads", "Device", "Metric"),
    relation("r3", "describes", "Metric", "Site"), // 环
    relation("r4", "wired-to", "Sensor", "Device"),
  ];
  pkg.events = [{
    id: "e1", key: "device_down", label: "设备停机", boundObject: "Device",
    status: "published", version: 1,
  }];
  return pkg;
}

function objectNodeKeys(result: { nodes: Array<{ id: string }> }): string[] {
  return result.nodes.filter((node) => node.id.startsWith("object:")).map((node) => node.id).sort();
}

describe("ontology graph query（有限 BFS）", () => {
  it("P0 包一跳：root 对象拿到关系/行动/数据三类邻居（P0 fixture 无事件），dataset 为共享合并节点", () => {
    const pkg = buildPublishablePackage();
    const result = queryOntologyGraph(pkg, { root: { type: "object", id: "Device" }, depth: 1, limit: 50 });
    expect(objectNodeKeys(result)).toEqual(["object:Device", "object:Event"]);
    const kinds = result.nodes.map((node) => node.kind).sort();
    expect(kinds).toEqual(["action", "dataset", "object", "object"]);
    // 边：relation + action 绑定 + data 描述
    expect(result.edges.map((edge) => edge.kind).sort()).toEqual(["action", "data", "relation"]);
    expect(result.edges.find((edge) => edge.kind === "relation")).toMatchObject({ label: "device_triggers_event", direction: "directed", cardinality: "one-to-many", evidenceCount: 1 });
    expect(result.edges.find((edge) => edge.kind === "data")?.label).toBe("describes");
    expect(result.truncated).toBe(false);
    expect(result.root).toEqual({ type: "object", id: "Device" });
  });

  it("三跳链：一跳邻域含入边（describes 反向）；depth=3 收齐四对象；Sensor 经 wired-to 入边在 hop2 进入", () => {
    const pkg = buildChainPackage();
    const one = queryOntologyGraph(pkg, { root: { type: "object", id: "Site" }, depth: 1, limit: 50 });
    // describes(Metric→Site) 是 Site 的入边：both 口径下 Metric 是一跳邻居
    expect(objectNodeKeys(one)).toEqual(["object:Device", "object:Metric", "object:Site"]);

    const three = queryOntologyGraph(pkg, { root: { type: "object", id: "Site" }, depth: 3, limit: 50 });
    expect(objectNodeKeys(three).sort()).toEqual(["object:Device", "object:Metric", "object:Sensor", "object:Site"].sort());
    // 环边 describes(Metric→Site) 保留；Sensor 经 wired-to(Sensor→Device) 反向进入
    expect(three.edges.some((edge) => edge.label === "describes")).toBe(true);
    expect(three.edges.some((edge) => edge.label === "wired-to")).toBe(true);
  });

  it("环不重访：BFS 访问集合有界，truncated 不因环误报", () => {
    const pkg = buildChainPackage();
    const result = queryOntologyGraph(pkg, { root: { type: "object", id: "Site" }, depth: 3, limit: 50 });
    expect(result.truncated).toBe(false);
    expect(new Set(result.nodes.map((node) => node.id)).size).toBe(result.nodes.length);
  });

  it("direction=out 只跟 directed 关系出边；in 只跟入边；undirected 关系不受 direction 约束", () => {
    const pkg = buildChainPackage();
    const out = queryOntologyGraph(pkg, { root: { type: "object", id: "Device" }, depth: 1, direction: "out", limit: 50 });
    // out：reads(Device→Metric) 保留；contains(Site→Device) 与 wired-to(Sensor→Device) 是入边被排除
    expect(objectNodeKeys(out)).toEqual(["object:Device", "object:Metric"]);
    expect(out.edges.filter((edge) => edge.kind === "relation").map((edge) => edge.label)).toEqual(["reads"]);
    // 事件绑定边仍然可达（不受 direction 约束）
    expect(out.nodes.some((node) => node.kind === "event")).toBe(true);

    const inside = queryOntologyGraph(pkg, { root: { type: "object", id: "Device" }, depth: 1, direction: "in", limit: 50 });
    // in：contains(Site→Device) 与 wired-to(Sensor→Device) 都是入边（root Device 自身也在结果里）
    expect(objectNodeKeys(inside)).toEqual(["object:Device", "object:Sensor", "object:Site"]);
    expect(inside.edges.filter((edge) => edge.kind === "relation").map((edge) => edge.label)).toEqual(["contains", "wired-to"]);

    const both = queryOntologyGraph(pkg, { root: { type: "object", id: "Device" }, depth: 1, limit: 50 });
    expect(objectNodeKeys(both).sort()).toEqual(["object:Device", "object:Metric", "object:Sensor", "object:Site"].sort());

    // undirected 关系双向遍历，direction=out 也放行
    const undirected = structuredClone(pkg);
    undirected.relations[0]!.direction = "undirected";
    const result = queryOntologyGraph(undirected, { root: { type: "object", id: "Device" }, depth: 1, direction: "out", limit: 50 });
    expect(objectNodeKeys(result)).toEqual(["object:Device", "object:Metric", "object:Site"]);
  });

  it("relationTypes 白名单过滤关系边；不影响绑定边", () => {
    const pkg = buildChainPackage();
    const result = queryOntologyGraph(pkg, { root: { type: "object", id: "Site" }, depth: 2, relationTypes: ["contains"], limit: 50 });
    expect(objectNodeKeys(result)).toEqual(["object:Device", "object:Site"]);
    expect(result.edges.every((edge) => edge.kind !== "relation" || edge.relationKey === "contains")).toBe(true);
    expect(result.edges.some((edge) => edge.kind === "event")).toBe(true);
  });

  it("limit 截断：truncated=true，节点数不超上限，root 始终保留", () => {
    const pkg = buildChainPackage();
    const truncated = queryOntologyGraph(pkg, { root: { type: "object", id: "Site" }, depth: 3, limit: 2 });
    expect(truncated.nodes.length).toBeLessThanOrEqual(2);
    expect(truncated.truncated).toBe(true);
    // 结果按 id 排序；root 一定保留
    expect(truncated.nodes.map((node) => node.id)).toContain("object:Site");
  });

  it("includeActions/Events/Datasets 开关逐项生效；root 不存在抛 RangeError", () => {
    const pkg = buildPublishablePackage();
    const noActions = queryOntologyGraph(pkg, { root: { type: "object", id: "Device" }, depth: 1, includeActions: false, limit: 50 });
    expect(noActions.nodes.some((node) => node.kind === "action")).toBe(false);
    const noEvents = queryOntologyGraph(pkg, { root: { type: "object", id: "Device" }, depth: 1, includeEvents: false, limit: 50 });
    expect(noEvents.nodes.some((node) => node.kind === "event")).toBe(false);
    const noDatasets = queryOntologyGraph(pkg, { root: { type: "object", id: "Device" }, depth: 1, includeDatasets: false, limit: 50 });
    expect(noDatasets.nodes.some((node) => node.kind === "dataset")).toBe(false);

    expect(() => queryOntologyGraph(pkg, { root: { type: "object", id: "Missing" }, depth: 1, limit: 50 })).toThrow(RangeError);
    expect(() => queryOntologyGraph(pkg, { root: { type: "dataset", id: "missing-ds" }, depth: 1, limit: 50 })).toThrow(RangeError);
  });

  it("dataset 可作为 root（数据源视角反查对象）；空包 root 不存在抛错", () => {
    const pkg = buildPublishablePackage();
    const result = queryOntologyGraph(pkg, { root: { type: "dataset", id: "ds-devices" }, depth: 1, limit: 50 });
    expect(objectNodeKeys(result)).toEqual(["object:Device"]);
    expect(result.root).toEqual({ type: "dataset", id: "ds-devices" });

    const empty = newOntologyPackage("manufacturing", "alice");
    expect(() => queryOntologyGraph(empty, { root: { type: "object", id: "Device" }, depth: 1, limit: 50 })).toThrow(RangeError);
  });

  it("buildOntologyGraphIndex：节点确定性排序；行动节点带风险/审批三元组", () => {
    const pkg = buildPublishablePackage();
    const index = buildOntologyGraphIndex(pkg);
    const action = index.nodes.get(ontologyGraphNodeId("action", "diagnose_device"));
    expect(action).toMatchObject({ kind: "action", riskLevel: "low", effect: "read", approvalRequired: false });
    expect(index.nodes.get(ontologyGraphNodeId("object", "Device"))?.propertyCount).toBe(1);
    expect(index.nodes.get(ontologyGraphNodeId("dataset", "ds-devices"))?.label).toBe("ds-devices");
  });

  it("summarizeOntologyGraphScale：数据源按 sourceId 去重计数", () => {
    const pkg = buildPublishablePackage();
    pkg.objects[0]!.sourceBindings.push({ kind: "dataset", sourceId: "ds-devices", fieldMappings: [] });
    const scale = summarizeOntologyGraphScale(pkg);
    expect(scale).toEqual({ objects: 2, relations: 1, actions: 1, events: 0, datasets: 1 });
  });
});
