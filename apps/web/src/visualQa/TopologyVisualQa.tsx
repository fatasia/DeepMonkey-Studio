import { useState } from "react";
import type { TopologyDocument, TopologyScadaRuntimeState } from "@bim-studio/contracts";
import { TopologyEditorPanel } from "../components/TopologyEditorPanel";

const now = "2026-09-05T00:00:00Z";
const full: TopologyDocument = { id: "qa-topology", name: "拓扑视图边界夹具", edges: [], nodes: [
  { id: "elevated", kind: "pump", x: 24, y: 24, properties: { label: "高位泵", elevation: 500 } },
  { id: "unknown", kind: "meter", x: 600, y: 250, properties: { label: "未知仪表" } },
  { id: "offline", kind: "agv", x: 1400, y: 750, properties: { label: "离线车辆" } },
  { id: "alarm", kind: "valve", x: 750, y: 500, properties: { label: "告警阀门" } },
] };
const states: Record<string, TopologyScadaRuntimeState> = {
  unknown: { state: "unknown", quality: "uncertain", updatedAt: now },
  offline: { state: "offline", quality: "bad", updatedAt: now },
  alarm: { state: "alarm", quality: "good", updatedAt: "2026-09-04T23:00:00Z", alarm: { id: "qa-alarm", active: true, severity: "critical", message: "测试阀门告警" } },
};

// 仅 DEV/显式 QA 构建；修改留在 React 内存，不接 API、自动保存或真实运行器。
export default function TopologyVisualQa() {
  const [document, setDocument] = useState(full);
  const [changes, setChanges] = useState(0);
  return <div style={{ height: "100%", display: "grid", gridTemplateRows: "40px minmax(0,1fr)" }}>
    <div role="toolbar" aria-label="拓扑测试夹具" style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <button onClick={() => setDocument({ ...full, id: "qa-empty", nodes: [] })}>空拓扑夹具</button>
      <button onClick={() => setDocument({ ...full, id: "qa-small", nodes: full.nodes.slice(0, 1) })}>单节点夹具</button>
      <button onClick={() => setDocument(full)}>恢复完整夹具</button>
      <output aria-label="文档修改次数">{changes}</output>
      <output aria-label="拓扑快照" hidden>{JSON.stringify(document)}</output>
    </div>
    <TopologyEditorPanel locale="zh-CN" document={document} runtimeStates={states} runtimeNow={Date.parse(now)}
      onChange={next => { setDocument(next); setChanges(count => count + 1); }} />
  </div>;
}
