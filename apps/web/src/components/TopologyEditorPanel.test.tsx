import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TopologyDocument } from "@bim-studio/contracts";
import { assessTopologyScadaRuntime } from "@bim-studio/studio-core";
import { ScadaRuntimeCard, TopologyEditorPanel, topologyEdgeAnimated, topologyEdgeLabel, topologyEdgeMedium, topologyEdgeStateClass, topologyNodeElevation, topologyPlanPositionFromProjected, topologyProjectedPosition } from "./TopologyEditorPanel";
import { TopologyExtensionField } from "./TopologyEditorPanelView";

const document: TopologyDocument = {
  id: "topology-line-1",
  name: "一号产线",
  nodes: [
    {
      id: "robot-1",
      kind: "controller",
      x: 120,
      y: 160,
      properties: {
        label: "码垛机器人",
        vendor: "示例厂商",
        dataBinding: { productType: "pipeline", productId: "pipeline-status", field: "running" }
      }
    }
  ],
  edges: []
};

describe("TopologyEditorPanel", () => {
  it("renders the lightweight workbench and its persisted nodes", () => {
    const html = renderToStaticMarkup(<TopologyEditorPanel locale="zh-CN" document={document} dataProducts={[
      { id: "pipeline-status", type: "pipeline", name: "设备实时状态", fields: ["running", "alarm"] }
    ]} onChange={() => undefined} />);

    expect(html).toContain("一号产线");
    expect(html).toContain("码垛机器人");
    expect(html).toContain("通用对象");
    expect(html).toContain("工艺设备");
    expect(html).toContain("搜索设备或类型");
    expect(html).toContain("工业泵");
    expect(html).toContain("SCADA");
    expect(html).toContain("数据驱动");
    expect(html).toContain("层级");
    expect(html).toContain("1 节点");
    expect(html).toContain("收起设备库");
    expect(html).toContain("收起属性面板");
  });

  it("gives extension property controls stable accessible names", () => {
    const html = renderToStaticMarkup(
      <TopologyExtensionField locale="zh-CN" name="vendor" value="示例厂商" onCommit={() => undefined} onRemove={() => undefined} />,
    );
    expect(html).toContain("扩展属性“vendor”的值");
    expect(html).toContain("删除扩展属性“vendor”");
  });

  it("keeps the canvas in its own grid column when both side panels collapse", () => {
    const css = readFileSync(new URL("./TopologyEditorPanel.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.topology-editor__palette\s*\{[^}]*grid-column:\s*1;/);
    expect(css).toMatch(/\.topology-editor__viewport\s*\{[^}]*grid-column:\s*2;/);
    expect(css).toMatch(/\.topology-editor__inspector\s*\{[^}]*grid-column:\s*3;/);
  });

  it("projects persisted elevation in 2.5D without changing plan coordinates", () => {
    const node = { x: 100, y: 200, properties: { elevation: 40 } };

    expect(topologyProjectedPosition(node, "2d")).toEqual({ x: 100, y: 200 });
    expect(topologyProjectedPosition(node, "2.5d")).toEqual({ x: 59, y: 218 });
    expect(topologyPlanPositionFromProjected({ x: 59, y: 218 }, 40, "2.5d")).toEqual({ x: 100, y: 200 });
    expect(topologyNodeElevation({ properties: { elevation: 900 } })).toBe(500);
    expect(topologyNodeElevation({ properties: { elevation: "invalid" } })).toBe(0);
  });

  it("renders SCADA flow medium, direction animation and endpoint health", () => {
    const edge = { properties: { label: "冷却水", medium: "water", animated: true } };
    expect(topologyEdgeLabel(edge)).toBe("冷却水");
    expect(topologyEdgeMedium(edge)).toBe("water");
    expect(topologyEdgeAnimated(edge)).toBe(true);
    expect(topologyEdgeStateClass({ state: "running" }, { state: "offline" })).toBe("is-offline");
    expect(topologyEdgeStateClass({ state: "alarm", alarm: { active: true, severity: "critical", message: "故障" } }, { state: "running" })).toBe("has-alarm");
  });

  it("renders English product copy from the same component", () => {
    const html = renderToStaticMarkup(<TopologyEditorPanel locale="en-US" document={document} onChange={() => undefined} />);
    expect(html).toContain("General");
    expect(html).toContain("Line &amp; logistics");
    expect(html).toContain("Topology / SCADA");
  });

  it("renders SCADA live value, operating state, and active alarm without persisting runtime data", () => {
    const scadaDocument: TopologyDocument = {
      ...document,
      nodes: [{
        id: "pump-1",
        kind: "pump",
        x: 100,
        y: 120,
        properties: { label: "循环泵 P-101", scada: { tag: "P-101.PV", unit: "bar", highAlarm: 6, alarmSeverity: "critical" } }
      }]
    };
    const html = renderToStaticMarkup(<TopologyEditorPanel locale="zh-CN" document={scadaDocument} runtimeStates={{
      "pump-1": { state: "alarm", value: 7.2, unit: "bar", alarm: { active: true, severity: "critical", message: "出口压力高高" } }
    }} onChange={() => undefined} />);

    expect(html).toContain("循环泵 P-101");
    expect(html).toContain("7.2 bar");
    expect(html).toContain("出口压力高高");
    expect(html).toContain("1</strong>告警");
    expect(JSON.stringify(scadaDocument)).not.toContain("7.2");
  });

  it("surfaces stale timestamps, bad value quality, runtime diagnostics and alarm acknowledgement", () => {
    const scadaDocument: TopologyDocument = {
      ...document,
      nodes: [
        { id: "pump-1", kind: "pump", x: 100, y: 120, properties: { label: "循环泵", scada: { tag: "P-101.PV", unit: "bar", alarmSeverity: "critical" } } },
        { id: "meter-1", kind: "meter", x: 320, y: 120, properties: { label: "流量计", scada: { tag: "FT-101.PV", unit: "m³/h", alarmSeverity: "warning" } } }
      ]
    };
    const html = renderToStaticMarkup(<TopologyEditorPanel
      locale="zh-CN"
      document={scadaDocument}
      runtimeNow={Date.parse("2026-08-27T10:00:00.000Z")}
      runtimeStaleAfterMs={60_000}
      runtimeStates={{
        "pump-1": {
          state: "alarm",
          value: 7.2,
          quality: "bad",
          updatedAt: "2026-08-27T09:58:00.000Z",
          alarm: { id: "alarm-1", active: true, acknowledged: false, severity: "critical", message: "出口压力高高" }
        }
      }}
      onAcknowledgeAlarm={() => undefined}
      onChange={() => undefined}
    />);

    expect(html).toContain("SCADA 运行诊断");
    expect(html).toContain("1</strong>失联");
    expect(html).toContain("1</strong>时效异常");
    expect(html).toContain("1</strong>质量异常");
    expect(html).toContain("质量无效");
    expect(html).toContain("数据已过期");
    expect(html).toContain("1 未确认");
  });

  it("renders acknowledgement state from the adapter snapshot", () => {
    const state = { state: "alarm", updatedAt: "2026-08-27T10:00:00.000Z", alarm: { active: true, acknowledged: true, severity: "critical", message: "出口压力高高" } } as const;
    const html = renderToStaticMarkup(<ScadaRuntimeCard locale="zh-CN" state={state} assessment={assessTopologyScadaRuntime(state, Date.parse("2026-08-27T10:00:10.000Z"), 60_000)} unit="bar" canAcknowledge={true} acknowledgePending={false} onAcknowledge={() => undefined} />);

    expect(html).toContain("已确认");
    expect(html).not.toContain("确认告警</button>");
  });
});
