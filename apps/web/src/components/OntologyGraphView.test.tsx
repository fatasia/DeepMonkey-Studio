import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OntologyGraphResult, OntologyPackage } from "@bim-studio/contracts";
import OntologyGraphInspector from "./OntologyGraphInspector";
import OntologyGraphView, { GraphListMode } from "./OntologyGraphView";
import { buildGraphListCards } from "./ontologyGraphLogic";

function fixturePackage(): OntologyPackage {
  return {
    schemaVersion: 1,
    id: "pkg-1",
    name: "产线设备本体",
    domain: "manufacturing",
    version: 2,
    revision: 5,
    objects: [
      {
        id: "o1", key: "Device", label: "设备", domain: "manufacturing",
        primaryKeys: ["device_id"],
        properties: [
          { key: "device_id", label: "设备编号", type: "string", confirmed: true },
          { key: "temperature", label: "温度", type: "number", confirmed: false },
        ],
        sourceBindings: [{ kind: "dataset", sourceId: "ds-devices", fieldMappings: [{ propertyKey: "device_id", fieldKey: "device_id" }], schemaFingerprint: "abc123def456" }],
        aliases: ["machine"], identityMappings: [], status: "published", version: 2, owner: "alice",
      },
    ],
    relations: [
      {
        id: "r1", key: "device_triggers_event", label: "设备触发事件",
        sourceObject: "Device", targetObject: "Event",
        cardinality: "one-to-many", direction: "directed", properties: [],
        keyMapping: { sourceField: "device_id", targetField: "event_id" },
        source: { kind: "dataset", sourceId: "ds-devices", note: "工单外键印证" },
        validTime: { from: "2026-01-01" },
        evidence: [{ source: "ds-devices 抽样", sampleCount: 42, recordedAt: "2026-09-29T08:00:00.000Z" }],
        status: "published", version: 2,
      },
    ],
    actions: [
      {
        id: "a1", key: "diagnose_device", label: "设备诊断", boundObject: "Device",
        inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: {} },
        toolBinding: { kind: "capability", id: "cap.diagnosis", version: "1.0.0" },
        preconditions: [{ label: "设备在线" }], effect: "read", riskLevel: "low",
        approvalRequired: false, idempotencyRequired: false,
        impactScope: ["Device"], authorizedScopes: ["project:read"],
        evidenceRequired: true, status: "published", version: 2,
      },
    ],
    events: [{ id: "e1", key: "device_down", label: "设备停机", boundObject: "Device", status: "published", version: 2 }],
    metrics: [], identityMappings: [], goldenQuestions: [], policies: [], evidence: [],
    impactReviewed: true, impactReviewedBy: "bob",
    status: "published", owner: "alice",
    createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T08:00:00.000Z",
  };
}

function fixtureResult(): OntologyGraphResult {
  return {
    packageId: "pkg-1",
    packageStatus: "published",
    packageVersion: 2,
    packageUpdatedAt: "2026-09-29T08:00:00.000Z",
    root: { type: "object", id: "Device" },
    depth: 1,
    nodes: [
      { id: "object:Device", kind: "object", key: "Device", label: "设备", status: "published", version: 2, propertyCount: 2, sourceCount: 1 },
      { id: "object:Event", kind: "object", key: "Event", label: "维护事件", status: "published", version: 2, propertyCount: 1 },
      { id: "action:diagnose_device", kind: "action", key: "diagnose_device", label: "设备诊断", status: "published", version: 2, effect: "read", riskLevel: "low", approvalRequired: false },
    ],
    edges: [
      { id: "rel:r1", source: "object:Device", target: "object:Event", kind: "relation", label: "device_triggers_event", direction: "directed", status: "published", cardinality: "one-to-many", evidenceCount: 1 },
      { id: "act:a1", source: "action:diagnose_device", target: "object:Device", kind: "action", label: "acts-on", direction: "directed", status: "published", evidenceCount: 0 },
    ],
    truncated: false,
    elapsedMs: 3.4,
  };
}

describe("OntologyGraphView（SSR 静态渲染）", () => {
  it("加载态：工具条 + loading status，不渲染 React Flow 画布", () => {
    const html = renderToStaticMarkup(<OntologyGraphView projectId="p1" locale="zh-CN" />);
    expect(html).toContain("本体图谱");
    expect(html).toContain("正在加载本体包");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("react-flow");
    expect(html).not.toContain("ontology-graph-canvas");
  });

  it("工具条具备深度/方向/类型/状态筛选与搜索入口（交互清单可见）", () => {
    const html = renderToStaticMarkup(<OntologyGraphView projectId="p1" locale="zh-CN" />);
    expect(html).toContain("展开深度");
    expect(html).toContain("1 跳");
    expect(html).toContain("双向");
    expect(html).toContain("搜索对象/数据/行动/事件");
    expect(html).toContain("数据");
    expect(html).toContain("已发布");
  });
});

describe("GraphListMode（480px 紧凑模式）", () => {
  it("卡片列表渲染节点+邻居路径标签，不含画布；高亮/选中态类名可见；空邻居给引导文案", () => {
    const result = fixtureResult();
    const isolated = { id: "dataset:ds-orphan", kind: "dataset" as const, key: "ds-orphan", label: "孤立数据源", status: "draft" as const, version: 1, sourceCount: 0 };
    const cards = buildGraphListCards([...result.nodes, isolated], result.edges);
    const html = renderToStaticMarkup(
      <GraphListMode cards={cards} locale="zh-CN" highlightIds={new Set(["object:Event"])} selectedId="object:Device" onSelectNode={() => undefined} onFollow={() => undefined} />,
    );
    expect(html).toContain("ontology-graph-listmode");
    expect(html).toContain("设备诊断");
    expect(html).toContain("device_triggers_event");
    expect(html).toContain("无邻接关系"); // 孤立数据源卡给引导文案
    expect(html).toContain("is-highlighted");
    expect(html).toContain("is-selected");
    expect(html).not.toContain("react-flow");
  });
});

describe("OntologyGraphInspector（检查器）", () => {
  it("未选中：操作引导而非空白", () => {
    const html = renderToStaticMarkup(<OntologyGraphInspector pkg={fixturePackage()} selection={undefined} node={undefined} edge={undefined} locale="zh-CN" onFocusRoot={() => undefined} onCollapse={() => undefined} onReset={() => undefined} />);
    expect(html).toContain("点击节点或边");
    expect(html).toContain("重置视图");
  });

  it("对象节点：属性/来源/关系/可用行动/事件/证据逐节可见；待确认属性标注", () => {
    const node = fixtureResult().nodes.find((item) => item.id === "object:Device")!;
    const html = renderToStaticMarkup(<OntologyGraphInspector pkg={fixturePackage()} selection={{ kind: "node", id: "object:Device" }} node={node} edge={undefined} locale="zh-CN" onFocusRoot={() => undefined} onCollapse={() => undefined} onReset={() => undefined} />);
    expect(html).toContain("属性 (2)");
    expect(html).toContain("待确认");
    expect(html).toContain("来源绑定");
    expect(html).toContain("ds-devices");
    expect(html).toContain("关系 (出 1 / 入 0)");
    expect(html).toContain("可用行动 (1)");
    expect(html).toContain("事件 (1)");
    expect(html).toContain("以此为根展开");
    expect(html).toContain("折叠邻居");
  });

  it("行动节点：效果/风险/审批/能力绑定三重编码 + Harness 接入说明（不做假按钮）", () => {
    const node = fixtureResult().nodes.find((item) => item.id === "action:diagnose_device")!;
    const html = renderToStaticMarkup(<OntologyGraphInspector pkg={fixturePackage()} selection={{ kind: "node", id: "action:diagnose_device" }} node={node} edge={undefined} locale="zh-CN" onFocusRoot={() => undefined} onCollapse={() => undefined} onReset={() => undefined} />);
    expect(html).toContain("效果");
    expect(html).toContain("风险");
    expect(html).toContain("cap.diagnosis");
    expect(html).toContain("受控执行走 Harness 审批链");
  });

  it("关系边：定义/方向/基数/键映射/来源理由/有效时间/证据全量展示", () => {
    const edge = fixtureResult().edges.find((item) => item.id === "rel:r1")!;
    const html = renderToStaticMarkup(<OntologyGraphInspector pkg={fixturePackage()} selection={{ kind: "edge", id: "rel:r1" }} node={undefined} edge={edge} locale="zh-CN" onFocusRoot={() => undefined} onCollapse={() => undefined} onReset={() => undefined} />);
    expect(html).toContain("关系定义");
    expect(html).toContain("one-to-many");
    expect(html).toContain("device_id → event_id");
    expect(html).toContain("工单外键印证");
    expect(html).toContain("证据 (1)");
    expect(html).toContain("N=42");
  });

  it("dataset 节点：反查消费对象与绑定类型", () => {
    const node = { id: "dataset:ds-devices", kind: "dataset" as const, key: "ds-devices", label: "ds-devices", status: "published" as const, version: 2 };
    const html = renderToStaticMarkup(<OntologyGraphInspector pkg={fixturePackage()} selection={{ kind: "node", id: "dataset:ds-devices" }} node={node} edge={undefined} locale="zh-CN" onFocusRoot={() => undefined} onCollapse={() => undefined} onReset={() => undefined} />);
    expect(html).toContain("消费对象 (1)");
    expect(html).toContain("设备");
  });
});
