import { useState, useSyncExternalStore } from "react";
import { ApplicationStore, type StudioCommand } from "@bim-studio/studio-core";
import type { ApplicationDocument, ApplicationObjectRef, ProjectRecord } from "@bim-studio/contracts";
import { DashboardWorkspace } from "../components/DashboardWorkspace";
import { useGlobalDialogEscape } from "../hooks/useGlobalDialogEscape";

const now = "2026-08-25T12:00:00.000Z";
const initialApplication: ApplicationDocument = {
  schemaVersion: 2,
  metadata: { id: "visual-qa", projectId: "visual-qa", name: "智能工厂运营中心", revision: 1, createdAt: now, updatedAt: now },
  pages: [{
    id: "page:overview",
    name: "生产总览",
    width: 3840,
    height: 1080,
    viewportFit: "contain",
    nodes: [
      { id: "widget:title", kind: "data-widget", frame: { x: 80, y: 46, width: 3680, height: 92 }, zIndex: 1, widget: { type: "text", title: "标题", key: "", unit: "", content: "智能制造 · 实时运营总览", fontSize: 40, fontWeight: 700, textColor: "#e6ecef", backgroundOpacity: 0 } },
      { id: "widget:throughput", kind: "data-widget", frame: { x: 80, y: 166, width: 896, height: 246 }, zIndex: 2, widget: { type: "value", title: "今日产量", key: "throughput", unit: "件", color: "#3ec6c1" } },
      { id: "widget:cycle", kind: "data-widget", frame: { x: 1008, y: 166, width: 896, height: 246 }, zIndex: 3, widget: { type: "gauge", title: "平均节拍", key: "cycle", unit: "秒", min: 0, max: 120, color: "#59c58d" } },
      { id: "widget:oee", kind: "data-widget", frame: { x: 1936, y: 166, width: 896, height: 246 }, zIndex: 4, widget: { type: "progress", title: "综合设备效率", key: "oee", unit: "%", min: 0, max: 100, color: "#65aee8" } },
      { id: "widget:alerts", kind: "data-widget", frame: { x: 2864, y: 166, width: 896, height: 246 }, zIndex: 5, widget: { type: "status", title: "产线状态", key: "status", unit: "", color: "#d8ac52" } },
      { id: "widget:trend", kind: "data-widget", frame: { x: 80, y: 444, width: 2360, height: 526 }, zIndex: 6, widget: { type: "line", title: "产量与节拍趋势", key: "trend", unit: "件", color: "#3ec6c1" } },
      { id: "widget:energy", kind: "data-widget", frame: { x: 2472, y: 444, width: 1288, height: 246 }, zIndex: 7, widget: { type: "bar", title: "工序能耗", key: "energy", unit: "kWh", color: "#65aee8" } },
      { id: "widget:quality", kind: "data-widget", frame: { x: 2472, y: 722, width: 1288, height: 248 }, zIndex: 8, widget: { type: "table", title: "质量与异常明细", key: "quality", unit: "", color: "#59c58d" } },
      { id: "widget:overflow", kind: "data-widget", frame: { x: 3740, y: 936, width: 180, height: 94 }, zIndex: 9, widget: { type: "status", title: "越界诊断样例", key: "status", unit: "" } }
    ]
  }],
  topologies: [{
    id: "topology:assembly-line",
    name: "总装线设备拓扑",
    nodes: [
      { id: "pump-1", kind: "pump", x: 120, y: 120, properties: { label: "循环泵 P-101" } },
      { id: "plc-1", kind: "plc", x: 420, y: 120, properties: { label: "控制柜 PLC-01" } },
    ],
    edges: [{ id: "signal-1", sourceNodeId: "pump-1", targetNodeId: "plc-1", properties: { medium: "signal" } }],
  }], scenes: [], geo: { providerIds: [], layers: [] },
  data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] },
  interactions: [], scripts: [], assets: [], timelines: [],
  publicationProfiles: [{ id: "browser", name: "浏览器发布", target: "browser-preview", entryPageId: "page:overview", renderer: "auto" }]
};

const project: ProjectRecord = { id: "visual-qa", name: "智能工厂运营中心", description: "Dashboard visual QA", models: [], createdAt: now, updatedAt: now };

export default function DashboardVisualQa() {
  useGlobalDialogEscape();
  const [store] = useState(() => new ApplicationStore(initialApplication));
  const state = useSyncExternalStore((listener) => store.subscribe(listener), () => store.getState());
  const application = state.document!;
  const [selection, setSelection] = useState<readonly ApplicationObjectRef[]>([]);
  const [pageId, setPageId] = useState(initialApplication.pages[0]!.id);
  const page = application.pages.find((item) => item.id === pageId) ?? application.pages[0]!;
  const dispatch = (command: StudioCommand) => store.dispatch(command);

  return <DashboardWorkspace
    locale="zh-CN"
    application={application}
    project={project}
    page={page}
    rendererBackend="webgl"
    dirty
    canUndo={state.canUndo}
    canRedo={state.canRedo}
    busy={false}
    liveDataEnabled={false}
    selection={selection}
    variables={{ throughput: 18640, cycle: 72, oee: 86.4, status: "warning", energy: 318, quality: 98.7 }}
    filters={{}}
    onBack={() => undefined}
    onSelectPage={(id) => { setPageId(id); setSelection([]); }}
    onEnterScene={() => undefined}
    onOpenTopology={() => undefined}
    onOpenData={() => undefined}
    onSelectionChange={setSelection}
    onFilterChange={() => undefined}
    onVariableChange={() => undefined}
    onObjectInteraction={() => undefined}
    onNodeInteraction={() => undefined}
    onCommand={dispatch}
    onUndo={() => { store.undo(); }}
    onRedo={() => { store.redo(); }}
    onSave={() => undefined}
    onPublish={() => undefined}
    onViewStateChange={() => undefined}
  />;
}
