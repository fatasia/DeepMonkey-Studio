import { useState } from "react";
import { applyStudioCommand, type StudioCommand } from "@bim-studio/studio-core";
import type { ApplicationDocument, ApplicationObjectRef, ProjectRecord } from "@bim-studio/contracts";
import { DashboardWorkspace } from "../components/DashboardWorkspace";

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
      { id: "widget:title", kind: "data-widget", frame: { x: 64, y: 52, width: 720, height: 100 }, zIndex: 1, widget: { type: "text", title: "标题", key: "", unit: "", content: "智能制造 · 实时运营总览", fontSize: 38, fontWeight: 700, textColor: "#f2e7cb", backgroundOpacity: 0 } },
      { id: "widget:throughput", kind: "data-widget", frame: { x: 64, y: 190, width: 420, height: 210 }, zIndex: 2, widget: { type: "value", title: "今日产量", key: "throughput", unit: "件", color: "#d4a84f" } },
      { id: "widget:cycle", kind: "data-widget", frame: { x: 516, y: 190, width: 420, height: 210 }, zIndex: 3, widget: { type: "gauge", title: "平均节拍", key: "cycle", unit: "秒", min: 0, max: 120, color: "#68b7a4" } },
      { id: "widget:trend", kind: "data-widget", frame: { x: 64, y: 438, width: 872, height: 470 }, zIndex: 4, widget: { type: "line", title: "产线趋势", key: "trend", unit: "件", color: "#d4a84f" } },
      { id: "widget:overflow", kind: "data-widget", frame: { x: 3740, y: 920, width: 240, height: 120 }, zIndex: 5, widget: { type: "status", title: "越界诊断样例", key: "status", unit: "" } }
    ]
  }],
  topologies: [], scenes: [], geo: { providerIds: [], layers: [] },
  data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] },
  interactions: [], scripts: [], assets: [], timelines: [],
  publicationProfiles: [{ id: "browser", name: "浏览器发布", target: "browser-preview", entryPageId: "page:overview", renderer: "auto" }]
};

const project: ProjectRecord = { id: "visual-qa", name: "智能工厂运营中心", description: "Dashboard visual QA", models: [], createdAt: now, updatedAt: now };

export default function DashboardVisualQa() {
  const [application, setApplication] = useState(initialApplication);
  const [selection, setSelection] = useState<readonly ApplicationObjectRef[]>([]);
  const page = application.pages[0]!;
  const dispatch = (command: StudioCommand) => setApplication((current) => applyStudioCommand(current, command));

  return <DashboardWorkspace
    locale="zh-CN"
    application={application}
    project={project}
    page={page}
    rendererBackend="webgl"
    dirty
    canUndo={false}
    canRedo={false}
    busy={false}
    liveDataEnabled={false}
    selection={selection}
    variables={{ throughput: 18640, cycle: 72, status: "warning" }}
    filters={{}}
    onBack={() => undefined}
    onSelectPage={() => undefined}
    onEnterScene={() => undefined}
    onOpenTopology={() => undefined}
    onOpenData={() => undefined}
    onSelectionChange={setSelection}
    onFilterChange={() => undefined}
    onVariableChange={() => undefined}
    onObjectInteraction={() => undefined}
    onNodeInteraction={() => undefined}
    onCommand={dispatch}
    onUndo={() => undefined}
    onRedo={() => undefined}
    onSave={() => undefined}
    onPublish={() => undefined}
    onViewStateChange={() => undefined}
  />;
}
