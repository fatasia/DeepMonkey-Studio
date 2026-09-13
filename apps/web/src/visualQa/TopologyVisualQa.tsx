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
const spatial: TopologyDocument = { id:"qa-spatial",name:"冷却水站 · 工艺拓扑",nodes:[
  {id:"p1",kind:"pump",x:120,y:120,properties:{label:"循环泵 P-101",zone:"冷却循环",scada:{tag:"P101",unit:"bar"}}},
  {id:"v1",kind:"valve",x:440,y:120,properties:{label:"调节阀 V-101",zone:"冷却循环",scada:{tag:"V101",unit:"%"}}},
  {id:"t1",kind:"tank",x:760,y:120,properties:{label:"缓冲罐 T-101",zone:"冷却循环",scada:{tag:"T101",unit:"m³"}}},
  {id:"m1",kind:"meter",x:120,y:500,properties:{label:"流量计 FT-101",zone:"监测与控制",scada:{tag:"FT101",unit:"m³/h"}}},
  {id:"c1",kind:"plc",x:440,y:500,properties:{label:"控制柜 PLC-01",zone:"监测与控制"}},
  {id:"s1",kind:"server",x:760,y:500,properties:{label:"边缘服务器",zone:"监测与控制"}},
],edges:[
  {id:"pv",sourceNodeId:"p1",targetNodeId:"v1",properties:{medium:"water",animated:true,label:"供水"}},
  {id:"vt",sourceNodeId:"v1",targetNodeId:"t1",properties:{medium:"water",animated:true}},
  {id:"mc",sourceNodeId:"m1",targetNodeId:"c1",properties:{medium:"signal"}},
  {id:"cs",sourceNodeId:"c1",targetNodeId:"s1",properties:{medium:"signal",animated:true}},
] };
const spatialStates: Record<string,TopologyScadaRuntimeState> = {
  p1:{state:"running",value:4.2,unit:"bar",updatedAt:now,quality:"good"},
  v1:{state:"warning",value:82,unit:"%",updatedAt:now,quality:"good",alarm:{active:true,severity:"warning",message:"阀门开度偏高"}},
  t1:{state:"idle",value:24.6,unit:"m³",updatedAt:now,quality:"good"},
  m1:{state:"running",value:128.4,unit:"m³/h",updatedAt:now,quality:"good"},
  c1:{state:"running",updatedAt:now,quality:"good"},
  s1:{state:"offline",updatedAt:now,quality:"bad"},
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
      <button onClick={() => setDocument(spatial)}>工业空间夹具</button>
      <output aria-label="文档修改次数">{changes}</output>
      <output aria-label="拓扑快照" hidden>{JSON.stringify(document)}</output>
    </div>
    <TopologyEditorPanel locale="zh-CN" document={document} runtimeStates={document.id === spatial.id ? spatialStates : states} runtimeNow={Date.parse(now)}
      onChange={next => { setDocument(next); setChanges(count => count + 1); }} />
  </div>;
}
