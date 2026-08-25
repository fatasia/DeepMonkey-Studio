import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Box,
  Database,
  Eye,
  Layers3,
  LayoutDashboard,
  Minus,
  Plus,
  Redo2,
  Rocket,
  Save,
  Undo2,
  Workflow
} from "lucide-react";
import type { ApplicationDocument, ApplicationObjectRef, DashboardDataWidgetConfig, DashboardPageDocument, ProjectRecord, SceneDashboardWidgetType, SceneInteractionTarget, SceneInteractionTrigger, WidgetFrame, WidgetNode } from "@bim-studio/contracts";
import {
  createDeleteDashboardNodeCommand,
  createInsertDashboardNodeCommand,
  createRenameDashboardPageCommand,
  createUpdateDashboardDataWidgetCommand,
  createUpdateDashboardNodeFrameCommand,
  type StudioCommand
} from "@bim-studio/studio-core";
import { translate as tr, type AppLocale } from "../i18n";
import { normalizeDashboardViewState, type DashboardViewState } from "../studio/workspaceRoute";
import { SceneViewportPreview } from "./SceneViewportPreview";
import { InteractionFlowInspector } from "./InteractionFlowInspector";
import { DashboardWidgetView, useDashboardMetrics, widgetBackground, type DashboardMetric } from "./DashboardWidgetRuntime";
import type { RendererBackend } from "../viewer/ViewerEngine";

const DATA_WIDGET_TYPES: SceneDashboardWidgetType[] = ["value", "gauge", "status", "line", "area", "bar", "pie", "table", "image", "video", "monitor", "url"];

export interface DashboardWorkspaceProps {
  locale: AppLocale;
  application: ApplicationDocument;
  project: ProjectRecord;
  page: DashboardPageDocument;
  rendererBackend: RendererBackend;
  initialView?: DashboardViewState;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  selection: readonly ApplicationObjectRef[];
  onBack: () => void;
  onSelectPage: (pageId: string, view: DashboardViewState) => void;
  onEnterScene: (sceneId: string, view: DashboardViewState) => void;
  onOpenData: () => void;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
  onObjectInteraction: (sceneId: string, trigger: SceneInteractionTrigger, target: SceneInteractionTarget) => void;
  onNodeInteraction: (nodeId: string, trigger?: SceneInteractionTrigger) => void;
  onCommand: (command: StudioCommand) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onPublish: () => void;
  onPreview: () => void;
  onViewStateChange: (view: DashboardViewState) => void;
}

export function DashboardWorkspace({
  locale,
  application,
  project,
  page,
  rendererBackend,
  initialView,
  dirty,
  canUndo,
  canRedo,
  busy,
  selection,
  onBack,
  onSelectPage,
  onEnterScene,
  onOpenData,
  onSelectionChange,
  onObjectInteraction,
  onNodeInteraction,
  onCommand,
  onUndo,
  onRedo,
  onSave,
  onPublish,
  onPreview,
  onViewStateChange
}: DashboardWorkspaceProps) {
  const normalizedInitialView = useMemo(() => normalizeDashboardViewState(initialView), [page.id]);
  const [zoom, setZoom] = useState(normalizedInitialView.zoom);
  const [selectedNodeIds, setSelectedNodeIds] = useState(normalizedInitialView.selectedNodeIds);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageNameCommitRef = useRef(page.name);
  const selectedNode = page.nodes.find((node) => selectedNodeIds.includes(node.id));
  const dataWidgetConfigs = useMemo(() => page.nodes.flatMap((node) => node.kind === "data-widget" ? [node.widget] : []), [page.nodes]);
  const { metrics, connected } = useDashboardMetrics(project.id, dataWidgetConfigs);

  useEffect(() => {
    const widgetIds = selection.filter((item) => item.kind === "widget").map((item) => item.id);
    if (widgetIds.length > 0) setSelectedNodeIds(widgetIds.filter((id) => page.nodes.some((node) => node.id === id)));
  }, [selection, page.id]);

  useEffect(() => {
    setZoom(normalizedInitialView.zoom);
    setSelectedNodeIds(normalizedInitialView.selectedNodeIds.filter((id) => page.nodes.some((node) => node.id === id)));
    pageNameCommitRef.current = page.name;
    const frame = window.requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      scrollRef.current.scrollLeft = normalizedInitialView.scrollLeft;
      scrollRef.current.scrollTop = normalizedInitialView.scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [page.id]);

  useEffect(() => {
    emitViewState();
  }, [zoom, selectedNodeIds]);

  function currentView(): DashboardViewState {
    return {
      zoom,
      scrollLeft: scrollRef.current?.scrollLeft ?? normalizedInitialView.scrollLeft,
      scrollTop: scrollRef.current?.scrollTop ?? normalizedInitialView.scrollTop,
      selectedNodeIds
    };
  }

  function emitViewState() {
    onViewStateChange(currentView());
  }

  function selectNode(node: WidgetNode, additive: boolean) {
    setSelectedNodeIds((current) => {
      const next = additive
        ? current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id]
        : [node.id];
      onSelectionChange(next.map((id) => ({ kind: "widget", id })));
      onNodeInteraction(node.id);
      return next;
    });
  }

  function updateSelectedFrame(field: keyof WidgetFrame, value: number) {
    if (!selectedNode || !Number.isFinite(value)) return;
    const next = {
      ...selectedNode.frame,
      [field]: field === "width" || field === "height" ? Math.max(1, Math.round(value)) : Math.round(value)
    };
    onCommand(createUpdateDashboardNodeFrameCommand(page.id, selectedNode.id, next));
  }

  function commitPageName(value: string) {
    const name = value.trim();
    if (!name || name === pageNameCommitRef.current) return;
    pageNameCommitRef.current = name;
    onCommand(createRenameDashboardPageCommand(page.id, name));
  }

  function addDataWidget(type: SceneDashboardWidgetType) {
    const id = `widget:${crypto.randomUUID()}`;
    const index = page.nodes.filter((node) => node.kind === "data-widget").length;
    const wide = ["line", "area", "bar", "pie", "table", "image", "video", "monitor", "url"].includes(type);
    const node: WidgetNode = {
      id,
      kind: "data-widget",
      frame: { x: 48 + index % 4 * 28, y: 48 + index % 4 * 28, width: wide ? 420 : 260, height: wide || type === "gauge" ? 240 : 140 },
      zIndex: Math.max(0, ...page.nodes.map((item) => item.zIndex)) + 1,
      widget: defaultDataWidget(locale, type)
    };
    onCommand(createInsertDashboardNodeCommand(page.id, node));
    setSelectedNodeIds([id]);
    onSelectionChange([{ kind: "widget", id }]);
  }

  function updateDataWidget(patch: Partial<DashboardDataWidgetConfig>) {
    if (!selectedNode || selectedNode.kind !== "data-widget") return;
    onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, { ...selectedNode.widget, ...patch }));
  }

  return <main className="dashboard-workspace">
    <header className="dashboard-workspace-topbar">
      <button className="dashboard-back" onClick={onBack}><ArrowLeft size={16} />{tr(locale, "项目", "Project")}</button>
      <div className="dashboard-workspace-title"><LayoutDashboard size={17} /><div><strong>{application.metadata.name}</strong><span>{dirty ? tr(locale, "有未保存修改", "Unsaved changes") : tr(locale, "所有修改已保存", "All changes saved")}</span></div></div>
      <nav className="workspace-mode-switch" aria-label={tr(locale, "编辑模式", "Editor mode")}>
        <button className="active"><LayoutDashboard size={14} />{tr(locale, "二维设计", "2D design")}</button>
        <button disabled title={tr(locale, "M5 提供独立拓扑编辑器", "The topology editor arrives in M5")}><Workflow size={14} />{tr(locale, "拓扑", "Topology")}</button>
        <button onClick={() => application.scenes[0] && onEnterScene(application.scenes[0].id, currentView())}><Box size={14} />{tr(locale, "三维场景", "3D scenes")}</button>
        <button onClick={onOpenData}><Database size={14} />{tr(locale, "数据", "Data")}</button>
        <button onClick={onPreview}><Eye size={14} />{tr(locale, "预览", "Preview")}</button>
      </nav>
      <div className="dashboard-workspace-actions">
        <button disabled={!canUndo || busy} title={tr(locale, "撤销", "Undo")} onClick={onUndo}><Undo2 size={15} /></button>
        <button disabled={!canRedo || busy} title={tr(locale, "重做", "Redo")} onClick={onRedo}><Redo2 size={15} /></button>
        <button disabled={!dirty || busy} onClick={onSave}><Save size={15} />{tr(locale, "保存", "Save")}</button>
        <button className="primary" disabled={busy} onClick={onPublish}><Rocket size={15} />{tr(locale, "发布", "Publish")}</button>
      </div>
    </header>

    <aside className="dashboard-pages-panel">
      <header><span className="eyebrow">APPLICATION</span><strong>{tr(locale, "页面与图层", "Pages & layers")}</strong></header>
      <section>
        <div className="dashboard-panel-label"><span>{tr(locale, "页面", "Pages")}</span><small>{application.pages.length}</small></div>
        {application.pages.map((candidate) => <button key={candidate.id} className={candidate.id === page.id ? "active" : ""} onClick={() => onSelectPage(candidate.id, currentView())}><LayoutDashboard size={14} /><span>{candidate.name}</span><small>{candidate.nodes.length}</small></button>)}
      </section>
      <section className="dashboard-component-library">
        <div className="dashboard-panel-label"><span>{tr(locale, "组件", "Components")}</span><small>{connected ? tr(locale, "实时", "Live") : tr(locale, "离线", "Offline")}</small></div>
        <div>{DATA_WIDGET_TYPES.map((type) => <button key={type} onClick={() => addDataWidget(type)}><Plus size={11} /><span>{dataWidgetTypeLabel(locale, type)}</span></button>)}</div>
      </section>
      <section>
        <div className="dashboard-panel-label"><span>{tr(locale, "图层", "Layers")}</span><small>{page.nodes.length}</small></div>
        {[...page.nodes].sort((left, right) => right.zIndex - left.zIndex).map((node) => <button key={node.id} className={selectedNodeIds.includes(node.id) ? "active" : ""} onClick={(event) => selectNode(node, event.ctrlKey || event.metaKey)}>{node.kind === "scene-viewport" ? <Box size={14} /> : <Layers3 size={14} />}<span>{nodeLabel(node)}</span><small>{node.zIndex}</small></button>)}
      </section>
    </aside>

    <section className="dashboard-design-surface">
      <div className="dashboard-canvas-toolbar">
        <span>{page.width} × {page.height}</span>
        <div><button onClick={() => setZoom((value) => Math.max(0.1, Number((value - 0.1).toFixed(2))))}><Minus size={13} /></button><output>{Math.round(zoom * 100)}%</output><button onClick={() => setZoom((value) => Math.min(2, Number((value + 0.1).toFixed(2))))}><Plus size={13} /></button></div>
      </div>
      <div className="dashboard-canvas-scroll" ref={scrollRef} onScroll={emitViewState} onClick={(event) => { if (event.target === event.currentTarget) { setSelectedNodeIds([]); onSelectionChange([]); } }}>
        <div className="dashboard-artboard-stage" style={{ width: page.width * zoom, height: page.height * zoom }}>
          <div className="dashboard-artboard" style={{ width: page.width, height: page.height, transform: `scale(${zoom})` }}>
            {page.nodes.map((node) => <DashboardNode key={node.id} application={application} project={project} node={node} metric={node.kind === "data-widget" ? metrics[node.widget.key] : undefined} selected={selectedNodeIds.includes(node.id)} locale={locale} rendererBackend={rendererBackend} onSelectionChange={onSelectionChange} onObjectInteraction={onObjectInteraction} onInteraction={(trigger) => onNodeInteraction(node.id, trigger)} onSelect={(additive) => selectNode(node, additive)} onEnterScene={(sceneId) => onEnterScene(sceneId, currentView())} />)}
          </div>
        </div>
      </div>
    </section>

    <aside className="dashboard-inspector-panel">
      <header><span className="eyebrow">INSPECTOR</span><strong>{tr(locale, "属性", "Properties")}</strong></header>
      <section className="dashboard-inspector-section">
        <label><span>{tr(locale, "页面名称", "Page name")}</span><input defaultValue={page.name} key={page.id} onBlur={(event) => commitPageName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
      </section>
      {selectedNode ? <>
        <section className="dashboard-inspector-section">
          <div className="dashboard-selection-heading"><span>{selectedNode.kind === "scene-viewport" ? <Box size={15} /> : <Layers3 size={15} />}</span><div><strong>{nodeLabel(selectedNode)}</strong><small>{selectedNode.id}</small></div></div>
          <div className="dashboard-frame-grid">{(["x", "y", "width", "height"] as const).map((field) => <label key={field}><span>{field.toUpperCase()}</span><input type="number" value={selectedNode.frame[field]} onChange={(event) => updateSelectedFrame(field, Number(event.target.value))} /></label>)}</div>
        </section>
        {selectedNode.kind === "scene-viewport" && <section className="dashboard-inspector-section"><div className="dashboard-readonly-property"><span>{tr(locale, "三维场景", "3D scene")}</span><strong>{sceneName(application, selectedNode.sceneId)}</strong></div><div className="dashboard-readonly-property"><span>{tr(locale, "渲染方式", "Render mode")}</span><strong>{selectedNode.renderMode}</strong></div><button className="dashboard-enter-scene" onClick={() => onEnterScene(selectedNode.sceneId, currentView())}><Box size={15} />{tr(locale, "进入三维编辑", "Open 3D editor")}</button></section>}
        {selectedNode.kind === "data-widget" && <section className="dashboard-inspector-section dashboard-data-widget-properties">
          <label><span>{tr(locale, "类型", "Type")}</span><select value={selectedNode.widget.type} onChange={(event) => updateDataWidget({ type: event.target.value as SceneDashboardWidgetType })}>{DATA_WIDGET_TYPES.map((type) => <option key={type} value={type}>{dataWidgetTypeLabel(locale, type)}</option>)}</select></label>
          <label><span>{tr(locale, "标题", "Title")}</span><input defaultValue={selectedNode.widget.title} key={`${selectedNode.id}:title:${selectedNode.widget.title}`} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.widget.title) updateDataWidget({ title: event.currentTarget.value }); }} /></label>
          <label><span>{tr(locale, "数据键", "Data key")}</span><input defaultValue={selectedNode.widget.key} key={`${selectedNode.id}:key:${selectedNode.widget.key}`} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.widget.key) updateDataWidget({ key: event.currentTarget.value }); }} /></label>
          <label><span>{tr(locale, "单位", "Unit")}</span><input defaultValue={selectedNode.widget.unit} key={`${selectedNode.id}:unit:${selectedNode.widget.unit}`} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.widget.unit) updateDataWidget({ unit: event.currentTarget.value }); }} /></label>
          <label><span>{tr(locale, "强调色", "Accent")}</span><input type="color" value={selectedNode.widget.color ?? "#d4a84f"} onChange={(event) => updateDataWidget({ color: event.target.value })} /></label>
          <button className="dashboard-delete-node" onClick={() => { onCommand(createDeleteDashboardNodeCommand(page.id, selectedNode.id)); setSelectedNodeIds([]); onSelectionChange([]); }}><Minus size={13} />{tr(locale, "删除组件", "Delete component")}</button>
        </section>}
        <InteractionFlowInspector locale={locale} application={application} source={{ kind: "widget", id: selectedNode.id }} onCommand={onCommand} onTest={(trigger) => onNodeInteraction(selectedNode.id, trigger)} />
      </> : <div className="dashboard-no-selection"><Layers3 size={24} /><span>{tr(locale, "选择页面中的组件以编辑属性", "Select a component on the page to edit its properties")}</span></div>}
    </aside>
  </main>;
}

function DashboardNode({ application, project, node, metric, selected, locale, rendererBackend, onSelectionChange, onObjectInteraction, onInteraction, onSelect, onEnterScene }: {
  application: ApplicationDocument;
  project: ProjectRecord;
  node: WidgetNode;
  metric: DashboardMetric | undefined;
  selected: boolean;
  locale: AppLocale;
  rendererBackend: RendererBackend;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
  onObjectInteraction: (sceneId: string, trigger: SceneInteractionTrigger, target: SceneInteractionTarget) => void;
  onInteraction: (trigger: SceneInteractionTrigger) => void;
  onSelect: (additive: boolean) => void;
  onEnterScene: (sceneId: string) => void;
}) {
  const style = { left: node.frame.x, top: node.frame.y, width: node.frame.width, height: node.frame.height, zIndex: node.zIndex };
  useEffect(() => {
    if (node.kind !== "data-widget") return;
    const task = window.setTimeout(() => onInteraction("load"), 0);
    return () => window.clearTimeout(task);
  }, [node.id]);
  if (node.kind === "scene-viewport") {
    const scene = application.scenes.find((candidate) => candidate.id === node.sceneId);
    return <article className={`dashboard-node dashboard-scene-viewport ${selected ? "selected" : ""}`} style={style} onClick={(event) => { event.stopPropagation(); onSelect(event.ctrlKey || event.metaKey); }} onDoubleClick={() => onEnterScene(node.sceneId)}>
      {scene && node.renderMode !== "static-placeholder"
        ? <SceneViewportPreview locale={locale} node={node} scene={scene} project={project} rendererBackend={rendererBackend} onSelectionChange={onSelectionChange} onObjectInteraction={(trigger, target) => onObjectInteraction(scene.id, trigger, target)} />
        : <div className="dashboard-scene-grid" />}
      <div className="dashboard-scene-summary"><span><Box size={36} /></span><strong>{scene?.name ?? node.sceneId}</strong><small>{scene ? `${scene.models.length + scene.primitives.length} ${tr(locale, "个场景对象", "scene objects")}` : tr(locale, "场景引用缺失", "Missing scene reference")}</small><button onClick={(event) => { event.stopPropagation(); onEnterScene(node.sceneId); }}>{tr(locale, "进入三维编辑", "Open 3D editor")}</button></div>
      <div className="dashboard-node-badge">3D · {node.renderMode}</div>
    </article>;
  }
  if (node.kind === "data-widget") return <article className={`dashboard-node dashboard-native-widget ${selected ? "selected" : ""}`} style={{ ...style, background: widgetBackground(node.widget), color: node.widget.textColor ?? "#eef2f4" }} onClick={(event) => { event.stopPropagation(); onSelect(event.ctrlKey || event.metaKey); }} onPointerEnter={() => onInteraction("pointerEnter")} onPointerLeave={() => onInteraction("pointerLeave")}>
    <DashboardWidgetView locale={locale} widget={node.widget} metric={metric} compact onAnimationStart={() => onInteraction("animationStart")} onAnimationEnd={() => onInteraction("animationEnd")} />
    <div className="dashboard-node-badge">{dataWidgetTypeLabel(locale, node.widget.type)}</div>
  </article>;
  return <article className={`dashboard-node dashboard-legacy-panel ${selected ? "selected" : ""}`} style={style} onClick={(event) => { event.stopPropagation(); onSelect(event.ctrlKey || event.metaKey); }}>
    <header><LayoutDashboard size={24} /><div><strong>{tr(locale, "数据看板", "Data dashboard")}</strong><small>{node.state.widgets.length} {tr(locale, "个组件", "widgets")}</small></div></header>
    <div className="dashboard-legacy-widget-grid">{node.state.widgets.slice(0, 8).map((widget) => <div key={widget.id}><small>{widget.type}</small><strong>{widget.title}</strong></div>)}</div>
  </article>;
}

function nodeLabel(node: WidgetNode): string {
  if (node.kind === "scene-viewport") return `3D · ${node.sceneId}`;
  if (node.kind === "data-widget") return node.widget.title;
  return "数据看板";
}

function sceneName(application: ApplicationDocument, sceneId: string): string {
  return application.scenes.find((scene) => scene.id === sceneId)?.name ?? sceneId;
}

function defaultDataWidget(locale: AppLocale, type: SceneDashboardWidgetType): DashboardDataWidgetConfig {
  const media = type === "image" || type === "video" || type === "monitor" || type === "url";
  return {
    title: dataWidgetTypeLabel(locale, type),
    key: media ? "" : "value",
    type,
    unit: "",
    color: "#d4a84f",
    backgroundColor: "#172126",
    backgroundOpacity: 0.86,
    ...(type === "gauge" ? { min: 0, max: 100 } : {}),
    ...(type === "image" ? { imageFit: "cover" as const } : {}),
    ...(type === "video" ? { videoFit: "contain" as const, videoAutoplay: true, videoMuted: true } : {}),
    ...(type === "monitor" ? { monitorProtocol: "hls" as const, videoFit: "cover" as const, videoAutoplay: true, videoMuted: true } : {}),
    ...(type === "url" ? { url: "https://example.com" } : {})
  };
}

function dataWidgetTypeLabel(locale: AppLocale, type: SceneDashboardWidgetType): string {
  const labels: Record<SceneDashboardWidgetType, [string, string]> = {
    value: ["数值", "Value"], gauge: ["仪表", "Gauge"], status: ["状态", "Status"], line: ["折线", "Line"], area: ["面积", "Area"], bar: ["柱图", "Bar"], pie: ["饼图", "Pie"], table: ["表格", "Table"], image: ["图片", "Image"], video: ["视频", "Video"], monitor: ["监控", "Monitor"], url: ["网页", "Web page"]
  };
  return tr(locale, ...labels[type]);
}
