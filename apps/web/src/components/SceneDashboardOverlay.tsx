import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Activity, Cctv, ChevronLeft, ChevronRight, Database, ExternalLink, Globe2, GripVertical, Image as ImageIcon, LayoutGrid, Palette, PanelLeft, PanelRight, Pause, Play, Plus, Settings2, SlidersHorizontal, Trash2, Upload, Video, Zap, X } from "lucide-react";
import Hls from "hls.js";
import { GridStack, type GridStackNode } from "gridstack";
import "gridstack/dist/gridstack.min.css";
import * as echarts from "echarts/core";
import { BarChart, GaugeChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { DataDatasetPreview, DataDatasetRecord, ProjectAssetRecord, SceneDashboardState, SceneDashboardWidgetState, SceneDashboardWidgetType, SceneInteractionScriptState, SceneInteractionTrigger } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { api } from "../api";
import { subscribeSceneData } from "../sceneDataBridge";
import { InteractionEditor, type InteractionChoiceOption, type InteractionTargetOption } from "./InteractionEditor";

echarts.use([BarChart, GaugeChart, LineChart, PieChart, GridComponent, TooltipComponent, CanvasRenderer]);

interface MetricSample { time: number; value: number; }
interface DashboardMetric { value: unknown; samples: MetricSample[]; rows?: Array<Record<string, unknown>>; }

export function SceneDashboardOverlay({ locale, projectId, sceneId, state, interactions, targetOptions, sceneOptions, cameraViewOptions, readOnly = false, onChange, onInteractionsChange, onWidgetInteraction, onTestInteraction, onClose }: {
  locale: AppLocale;
  projectId: string;
  sceneId: string;
  state: SceneDashboardState;
  interactions: SceneInteractionScriptState[];
  targetOptions: InteractionTargetOption[];
  sceneOptions: InteractionChoiceOption[];
  cameraViewOptions: InteractionChoiceOption[];
  readOnly?: boolean;
  onChange: (state: SceneDashboardState) => void;
  onInteractionsChange: (interactions: SceneInteractionScriptState[]) => void;
  onWidgetInteraction: (trigger: SceneInteractionTrigger, widget: SceneDashboardWidgetState, originalEvent?: Event) => void;
  onTestInteraction: (script: SceneInteractionScriptState, widget: SceneDashboardWidgetState) => void;
  onClose: () => void;
}) {
  const [metrics, setMetrics] = useState<Record<string, DashboardMetric>>({});
  const [editing, setEditing] = useState(false);
  const [editSection, setEditSection] = useState<"components" | "properties" | "appearance" | "events">("components");
  const [connected, setConnected] = useState(false);
  const [selectedKey, setSelectedKey] = useState("value");
  const [selectedType, setSelectedType] = useState<SceneDashboardWidgetType>("value");
  const [selectedWidgetId, setSelectedWidgetId] = useState<string>();
  const [demoEnabled, setDemoEnabled] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [imageAssets, setImageAssets] = useState<ProjectAssetRecord[]>([]);
  const [videoAssets, setVideoAssets] = useState<ProjectAssetRecord[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [selectedField, setSelectedField] = useState("");
  const imageUploadRef = useRef<HTMLInputElement>(null);
  const videoUploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (readOnly) setEditing(false); }, [readOnly]);
  useEffect(() => {
    let cancelled = false;
    void api.listDatasets(projectId).then((items) => {
      if (cancelled) return;
      setDatasets(items);
      const first = items[0];
      if (first) { setSelectedDatasetId((current) => current || first.id); setSelectedField((current) => current || first.fields[0]?.key || ""); }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId]);
  useEffect(() => {
    let cancelled = false;
    void api.listAssets(projectId).then((items) => {
      if (cancelled) return;
      setImageAssets(items.filter((item) => item.kind === "image"));
      setVideoAssets(items.filter((item) => item.kind === "video"));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId]);
  useEffect(() => {
    const ids = [...new Set(state.widgets.map((widget) => widget.datasetId).filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return;
    let cancelled = false;
    const refresh = async () => {
      const previews = await Promise.all(ids.map((id) => api.previewDataset(projectId, id).catch(() => undefined)));
      if (cancelled) return;
      setMetrics((current) => previews.reduce((next, preview) => preview ? mergeDatasetMetrics(next, preview) : next, current));
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), Math.max(2, Math.min(...ids.map((id) => datasets.find((item) => item.id === id)?.refreshSeconds || 5))) * 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [datasets, projectId, state.widgets]);
  useEffect(() => {
    return subscribeSceneData((message) => {
      if (message.sceneId && message.sceneId !== sceneId) return;
      setMetrics((current) => updateMetricMap(current, message.source, message.key || "value", message.value, Date.parse(message.timestamp) || Date.now()));
    }, (status) => setConnected(status === "online"));
  }, [sceneId]);
  useEffect(() => {
    if (!demoEnabled) return;
    let tick = 0;
    const update = () => {
      const value = Math.round(52 + Math.sin(tick++ * 0.42) * 27 + Math.random() * 6);
      const now = Date.now();
      setMetrics((current) => updateMetricMap(updateMetricMap(current, "demo", "value", value, now), "demo", "status", value < 82, now));
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [demoEnabled]);

  const availableKeys = useMemo(() => [...new Set(["value", "status", ...Object.keys(metrics), ...state.widgets.map((widget) => widget.key)])].sort(), [metrics, state.widgets]);
  const selectedWidget = state.widgets.find((widget) => widget.id === selectedWidgetId);
  const selectedDataset = datasets.find((dataset) => dataset.id === selectedDatasetId);

  function patchState(patch: Partial<SceneDashboardState>) {
    onChange({ ...state, ...patch });
  }

  function addWidget(type: SceneDashboardWidgetType = selectedType) {
    setSelectedType(type);
    const chart = ["line", "area", "bar", "pie"].includes(type);
    const webpage = type === "url";
    const image = type === "image";
    const video = type === "video";
    const monitor = type === "monitor";
    const nextRow = state.widgets.reduce((maximum, widget) => Math.max(maximum, widget.y + widget.h), 0);
    const widget: SceneDashboardWidgetState = {
      id: crypto.randomUUID(),
      title: webpage ? tr(locale, "网页", "Web page") : image ? tr(locale, "图片", "Image") : video ? tr(locale, "本地视频", "Local video") : monitor ? tr(locale, "实时监控", "Live monitor") : selectedDataset?.fields.find((field) => field.key === selectedField)?.label || selectedKey.split(".").at(-1) || tr(locale, "新指标", "New metric"),
      key: selectedDataset && selectedField ? `${selectedDataset.id}.${selectedField}` : selectedKey || "value",
      type,
      unit: "",
      x: 0,
      y: nextRow,
      w: chart || webpage || image || video || monitor ? 2 : 1,
      h: webpage || video || monitor || type === "table" ? 3 : chart || image ? 2 : type === "gauge" ? 2 : 1,
      min: 0,
      max: 100,
      color: "#d4a84f",
      ...(selectedDataset && selectedField && !webpage ? { datasetId: selectedDataset.id, field: selectedField } : {}),
      ...(webpage ? { url: "https://example.com" } : {}),
      ...(image && imageAssets[0] ? { assetId: imageAssets[0].id, imageUrl: imageAssets[0].url, imageFit: "cover" as const } : {}),
      ...(video ? { ...(videoAssets[0] ? { assetId: videoAssets[0].id, videoUrl: videoAssets[0].url } : {}), videoFit: "contain" as const, videoAutoplay: true, videoMuted: true } : {}),
      ...(monitor ? { monitorProtocol: "hls" as const, videoFit: "cover" as const, videoAutoplay: true, videoMuted: true } : {})
    };
    patchState({ widgets: [...state.widgets, widget] });
    setSelectedWidgetId(widget.id);
    setEditSection("properties");
  }

  async function uploadDashboardImage(file: File | undefined) {
    if (!file) return;
    try {
      const asset = await api.uploadImageAsset(projectId, file);
      setImageAssets((items) => [asset, ...items]);
      if (selectedWidget) updateWidget(selectedWidget.id, { type: "image", assetId: asset.id, imageUrl: asset.url, imageFit: selectedWidget.imageFit ?? "cover" });
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (imageUploadRef.current) imageUploadRef.current.value = "";
    }
  }

  async function uploadDashboardVideo(file: File | undefined) {
    if (!file) return;
    try {
      const asset = await api.uploadVideoAsset(projectId, file);
      setVideoAssets((items) => [asset, ...items]);
      if (selectedWidget) updateWidget(selectedWidget.id, { type: "video", assetId: asset.id, videoUrl: asset.url, videoFit: selectedWidget.videoFit ?? "contain", videoAutoplay: true, videoMuted: true });
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (videoUploadRef.current) videoUploadRef.current.value = "";
    }
  }

  async function resolveDashboardMonitor(sourceUrl: string, protocol: "hls" | "webrtc") {
    if (!selectedWidget) return;
    const resolved = await api.resolveLiveMonitor(sourceUrl, protocol);
    updateWidget(selectedWidget.id, { type: "monitor", monitorSourceUrl: sourceUrl, monitorProtocol: protocol, videoUrl: protocol === "hls" ? resolved.hlsUrl : resolved.webRtcUrl, videoAutoplay: true, videoMuted: true });
  }

  function applyExampleDashboard() {
    const postgres = datasets.find((dataset) => dataset.id === "example-postgresql-metrics");
    const http = datasets.find((dataset) => dataset.id === "example-http-metrics");
    if (!postgres || !http) return;
    patchState({ widgets: [
      { id: crypto.randomUUID(), title: "设备温度", key: `${postgres.id}.temperature`, datasetId: postgres.id, field: "temperature", type: "area", unit: "℃", x: 0, y: 0, w: 2, h: 2, color: "#e0ad49" },
      { id: crypto.randomUUID(), title: "管网压力", key: `${postgres.id}.pressure`, datasetId: postgres.id, field: "pressure", type: "gauge", unit: "kPa", x: 0, y: 2, w: 1, h: 2, min: 80, max: 120, color: "#58a9e6" },
      { id: crypto.randomUUID(), title: "HTTP 实时温度", key: `${http.id}.temperature`, datasetId: http.id, field: "temperature", type: "value", unit: "℃", x: 1, y: 2, w: 1, h: 1, color: "#67d19a" },
      { id: crypto.randomUUID(), title: "设备运行", key: `${http.id}.running`, datasetId: http.id, field: "running", type: "status", unit: "", x: 1, y: 3, w: 1, h: 1, color: "#67d19a" }
    ] });
  }

  if (collapsed) return <button className={`scene-dashboard-collapsed ${state.side} ${readOnly ? "icon-only" : ""}`} aria-label={tr(locale, "展开数据看板", "Expand dashboard")} title={tr(locale, "展开数据看板", "Expand dashboard")} onClick={() => setCollapsed(false)}>{state.side === "left" ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}<Database size={14} />{!readOnly && <span>{tr(locale, "数据看板", "Dashboard")}</span>}</button>;

  function updateWidget(id: string, patch: Partial<SceneDashboardWidgetState>) {
    patchState({ widgets: state.widgets.map((widget) => widget.id === id ? { ...widget, ...patch } : widget) });
  }

  function deleteWidget(id: string) {
    patchState({ widgets: state.widgets.filter((widget) => widget.id !== id) });
    onInteractionsChange(interactions.filter((script) => script.target.kind !== "widget" || script.target.widgetId !== id));
    setSelectedWidgetId(undefined);
  }

  function updateLayout(nodes: GridStackNode[]) {
    const positions = new Map(nodes.flatMap((node) => node.id ? [[String(node.id), node] as const] : []));
    const widgets = state.widgets.map((widget) => {
      const node = positions.get(widget.id);
      return node ? { ...widget, x: node.x ?? widget.x, y: node.y ?? widget.y, w: node.w ?? widget.w, h: node.h ?? widget.h } : widget;
    });
    if (widgets.some((widget, index) => layoutChanged(widget, state.widgets[index]!))) patchState({ widgets });
  }

  return <section className={`scene-dashboard-overlay ${state.side} ${readOnly ? "read-only" : ""}`} style={{ width: state.width, background: colorWithOpacity(state.backgroundColor ?? "#11191d", state.backgroundOpacity ?? 0.94), backdropFilter: `blur(${state.blur ?? 14}px)`, borderRadius: state.borderRadius ?? 10 }} aria-label={tr(locale, "场景二维看板", "Scene dashboard") }>
    <header>
      <div><strong>{tr(locale, "场景数据看板", "Scene dashboard")}</strong><small className={connected ? "online" : ""}>{connected ? tr(locale, "实时连接", "Live") : tr(locale, "自动重连", "Reconnecting")}</small></div>
      <nav>
        {!readOnly && <button className={demoEnabled ? "active" : ""} title={tr(locale, demoEnabled ? "停止演示数据" : "启动演示数据", demoEnabled ? "Stop demo data" : "Start demo data")} onClick={() => setDemoEnabled((value) => !value)}>{demoEnabled ? <Pause size={13} /> : <Play size={13} />}</button>}
        {!readOnly && <button className={editing ? "active" : ""} title={tr(locale, "编辑看板", "Edit dashboard")} onClick={() => setEditing((value) => !value)}><Settings2 size={14} /></button>}
        <button title={tr(locale, "收起看板", "Collapse dashboard")} onClick={() => setCollapsed(true)}>{state.side === "left" ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}</button>
        <button className={state.side === "left" ? "active" : ""} title={tr(locale, "固定到左侧", "Dock left")} onClick={() => patchState({ side: "left" })}><PanelLeft size={14} /></button>
        <button className={state.side === "right" ? "active" : ""} title={tr(locale, "固定到右侧", "Dock right")} onClick={() => patchState({ side: "right" })}><PanelRight size={14} /></button>
        {!readOnly && <a href="/data" target="_blank" rel="noreferrer" title={tr(locale, "数据中心", "Data center")}><Database size={14} /></a>}
        {!readOnly && <button title={tr(locale, "关闭", "Close")} onClick={onClose}><X size={15} /></button>}
      </nav>
    </header>
    {!readOnly && <><input ref={imageUploadRef} hidden type="file" accept=".jpg,.jpeg,.png,.webp,.gif,.svg" onChange={(event) => void uploadDashboardImage(event.target.files?.[0])} /><input ref={videoUploadRef} hidden type="file" accept=".mp4,.webm,.ogv,.mov" onChange={(event) => void uploadDashboardVideo(event.target.files?.[0])} /></>}
    <div className={`dashboard-canvas ${editing ? "editing" : ""}`}>
      {editing && <div className="dashboard-editor-shell"><nav className="dashboard-editor-tabs"><button className={editSection === "components" ? "active" : ""} onClick={() => setEditSection("components")}><LayoutGrid size={13} />{tr(locale, "组件", "Components")}</button><button className={editSection === "properties" ? "active" : ""} disabled={!selectedWidget} onClick={() => setEditSection("properties")}><SlidersHorizontal size={13} />{tr(locale, "属性", "Properties")}</button><button className={editSection === "appearance" ? "active" : ""} onClick={() => setEditSection("appearance")}><Palette size={13} />{tr(locale, "外观", "Appearance")}</button><button className={editSection === "events" ? "active" : ""} disabled={!selectedWidget} onClick={() => setEditSection("events")}><Zap size={13} />{tr(locale, "事件", "Events")}</button></nav>
        {editSection === "components" && <section className="dashboard-edit-panel dashboard-components-panel"><div className="dashboard-dataset-binding"><label><span>{tr(locale, "数据集", "Dataset")}</span><select value={selectedDatasetId} onChange={(event) => { const id = event.target.value; setSelectedDatasetId(id); const dataset = datasets.find((item) => item.id === id); setSelectedField(dataset?.fields[0]?.key ?? ""); }}><option value="">{tr(locale, "手填数据键", "Manual data key")}</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></label>{selectedDataset ? <label><span>{tr(locale, "字段", "Field")}</span><select value={selectedField} onChange={(event) => setSelectedField(event.target.value)}>{selectedDataset.fields.map((field) => <option key={field.key} value={field.key}>{field.label} · {field.type}</option>)}</select></label> : <label><span>{tr(locale, "数据键", "Data key")}</span><input list={`dashboard-keys-${sceneId}`} value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)} placeholder="source.key" /><datalist id={`dashboard-keys-${sceneId}`}>{availableKeys.map((key) => <option key={key} value={key} />)}</datalist></label>}</div><div className="dashboard-component-strip">{dashboardWidgetTypes(locale).map((item) => <button key={item.type} className={selectedType === item.type ? "active" : ""} onClick={() => addWidget(item.type)}><Plus size={10} />{item.label}</button>)}</div><button className="dashboard-example-button" onClick={applyExampleDashboard} disabled={!datasets.some((item) => item.id === "example-postgresql-metrics")}>{tr(locale, "载入示例布局", "Load sample layout")}</button></section>}
        {editSection === "properties" && <section className="dashboard-edit-panel">{selectedWidget ? <WidgetPropertiesEditor locale={locale} sceneId={sceneId} widget={selectedWidget} imageAssets={imageAssets} videoAssets={videoAssets} onChange={(patch) => updateWidget(selectedWidget.id, patch)} onDelete={() => deleteWidget(selectedWidget.id)} onUploadImage={() => imageUploadRef.current?.click()} onUploadVideo={() => videoUploadRef.current?.click()} onResolveMonitor={resolveDashboardMonitor} /> : <EditorEmpty locale={locale} />}</section>}
        {editSection === "appearance" && <section className="dashboard-edit-panel dashboard-appearance-panel"><div className="dashboard-appearance-group"><strong>{tr(locale, "看板", "Dashboard")}</strong><label><span>{tr(locale, "背景", "Background")}</span><input type="color" value={state.backgroundColor ?? "#11191d"} onChange={(event) => patchState({ backgroundColor: event.target.value })} /></label><RangeField label={tr(locale, "透明度", "Opacity")} value={state.backgroundOpacity ?? 0.94} min={0} max={1} step={0.05} onChange={(value) => patchState({ backgroundOpacity: value })} /><RangeField label={tr(locale, "模糊", "Blur")} value={state.blur ?? 14} min={0} max={30} step={1} onChange={(value) => patchState({ blur: value })} /><RangeField label={tr(locale, "圆角", "Radius")} value={state.borderRadius ?? 10} min={0} max={24} step={1} onChange={(value) => patchState({ borderRadius: value })} /></div>{selectedWidget && <div className="dashboard-appearance-group"><strong>{tr(locale, "当前组件", "Selected widget")}</strong><label><span>{tr(locale, "背景", "Background")}</span><input type="color" value={selectedWidget.backgroundColor ?? "#172126"} onChange={(event) => updateWidget(selectedWidget.id, { backgroundColor: event.target.value })} /></label><label><span>{tr(locale, "文字", "Text")}</span><input type="color" value={selectedWidget.textColor ?? "#eef2f4"} onChange={(event) => updateWidget(selectedWidget.id, { textColor: event.target.value })} /></label><label><span>{tr(locale, "图表", "Chart")}</span><input type="color" value={selectedWidget.color ?? "#d4a84f"} onChange={(event) => updateWidget(selectedWidget.id, { color: event.target.value })} /></label><RangeField label={tr(locale, "组件透明", "Widget opacity")} value={selectedWidget.backgroundOpacity ?? 0.72} min={0} max={1} step={0.05} onChange={(value) => updateWidget(selectedWidget.id, { backgroundOpacity: value })} /></div>}</section>}
        {editSection === "events" && <section className="dashboard-edit-panel dashboard-events-panel">{selectedWidget ? <InteractionEditor locale={locale} target={{ kind: "widget", widgetId: selectedWidget.id }} targetName={selectedWidget.title} interactions={interactions} targetOptions={targetOptions} sceneOptions={sceneOptions} cameraViewOptions={cameraViewOptions} onChange={onInteractionsChange} onTest={(script) => onTestInteraction(script, selectedWidget)} /> : <EditorEmpty locale={locale} />}</section>}
      </div>}
      <DashboardGrid key={`${sceneId}:${editing}:${state.widgets.map((widget) => widget.id).join(",")}`} locale={locale} widgets={state.widgets} metrics={metrics} editable={editing && !readOnly} selectedWidgetId={selectedWidgetId} onSelect={(id) => { setSelectedWidgetId(id); setEditSection("properties"); }} onLayoutChange={updateLayout} onWidgetInteraction={onWidgetInteraction} />
      {state.widgets.length === 0 && <div className="dashboard-empty"><Activity size={24} /><strong>{tr(locale, "添加第一个图表", "Add your first chart")}</strong><span>{tr(locale, "Node-RED 负责接入数据；这里只做可保存、可发布的轻量排版。", "Node-RED connects data; this panel provides lightweight, publishable layout.")}</span></div>}
    </div>
    {!readOnly && <label className="dashboard-width"><span>{tr(locale, "宽度", "Width")}</span><input type="range" min="320" max="720" step="10" value={state.width} onChange={(event) => patchState({ width: Number(event.target.value) })} /><output>{state.width}px</output></label>}
  </section>;
}

function RangeField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <label className="dashboard-range-field"><span>{label}</span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /><output>{step < 1 ? `${Math.round(value * 100)}%` : value}</output></label>;
}

function EditorEmpty({ locale }: { locale: AppLocale }) {
  return <div className="dashboard-editor-empty"><SlidersHorizontal size={19} /><span>{tr(locale, "先在下方画布选择一个组件", "Select a widget on the canvas below")}</span></div>;
}

function WidgetPropertiesEditor({ locale, sceneId, widget, imageAssets, videoAssets, onChange, onDelete, onUploadImage, onUploadVideo, onResolveMonitor }: {
  locale: AppLocale;
  sceneId: string;
  widget: SceneDashboardWidgetState;
  imageAssets: ProjectAssetRecord[];
  videoAssets: ProjectAssetRecord[];
  onChange: (patch: Partial<SceneDashboardWidgetState>) => void;
  onDelete: () => void;
  onUploadImage: () => void;
  onUploadVideo: () => void;
  onResolveMonitor: (sourceUrl: string, protocol: "hls" | "webrtc") => Promise<void>;
}) {
  const [monitorSource, setMonitorSource] = useState(widget.monitorSourceUrl ?? "");
  const [monitorBusy, setMonitorBusy] = useState(false);
  const [monitorError, setMonitorError] = useState<string>();
  useEffect(() => { setMonitorSource(widget.monitorSourceUrl ?? ""); setMonitorError(undefined); }, [widget.id, widget.monitorSourceUrl]);

  function changeType(type: SceneDashboardWidgetType) {
    onChange({
      type,
      ...(type === "url" && !widget.url ? { url: "https://example.com" } : {}),
      ...(type === "video" ? { videoFit: widget.videoFit ?? "contain", videoAutoplay: widget.videoAutoplay ?? true, videoMuted: widget.videoMuted ?? true } : {}),
      ...(type === "monitor" ? { monitorProtocol: widget.monitorProtocol ?? "hls", videoFit: widget.videoFit ?? "cover", videoAutoplay: true, videoMuted: true } : {})
    });
  }

  async function applyMonitor() {
    if (!monitorSource.trim()) return;
    setMonitorBusy(true);
    setMonitorError(undefined);
    try { await onResolveMonitor(monitorSource.trim(), widget.monitorProtocol ?? "hls"); }
    catch (reason) { setMonitorError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setMonitorBusy(false); }
  }

  return <div className="dashboard-widget-editor">
    <label><span>{tr(locale, "组件名称", "Name")}</span><input value={widget.title} onChange={(event) => onChange({ title: event.target.value })} /></label>
    <label><span>{tr(locale, "组件类型", "Type")}</span><select value={widget.type} onChange={(event) => changeType(event.target.value as SceneDashboardWidgetType)}>{widgetTypeOptions(locale)}</select></label>
    {widget.type === "url" && <label className="wide"><span>{tr(locale, "网页地址", "Web page URL")}</span><input value={widget.url ?? ""} onChange={(event) => onChange({ url: event.target.value })} placeholder="https://example.com/dashboard" /></label>}
    {widget.type === "image" && <div className="dashboard-media-source wide"><select value={widget.assetId ?? ""} onChange={(event) => { const asset = imageAssets.find((item) => item.id === event.target.value); onChange(asset ? { assetId: asset.id, imageUrl: asset.url } : { assetId: "", imageUrl: "" }); }}><option value="">{tr(locale, "选择资源库图片", "Choose an image")}</option>{imageAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select><button onClick={onUploadImage}><Upload size={12} />{tr(locale, "上传", "Upload")}</button><FitSelect locale={locale} value={widget.imageFit ?? "cover"} onChange={(imageFit) => onChange({ imageFit })} /></div>}
    {widget.type === "video" && <><div className="dashboard-media-source wide"><select value={widget.assetId ?? ""} onChange={(event) => { const asset = videoAssets.find((item) => item.id === event.target.value); onChange(asset ? { assetId: asset.id, videoUrl: asset.url } : { assetId: "", videoUrl: "" }); }}><option value="">{tr(locale, "选择资源库视频", "Choose a video")}</option>{videoAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select><button onClick={onUploadVideo}><Upload size={12} />{tr(locale, "上传", "Upload")}</button><FitSelect locale={locale} value={widget.videoFit ?? "contain"} onChange={(videoFit) => onChange({ videoFit })} /></div><VideoBehavior locale={locale} widget={widget} onChange={onChange} /></>}
    {widget.type === "monitor" && <div className="dashboard-monitor-source wide"><div><select value={widget.monitorProtocol ?? "hls"} onChange={(event) => onChange({ monitorProtocol: event.target.value as "hls" | "webrtc" })}><option value="hls">HLS / LL-HLS</option><option value="webrtc">WebRTC</option></select><input value={monitorSource} onChange={(event) => setMonitorSource(event.target.value)} placeholder="rtsp://、rtmp://、srt:// 或 HLS/WHEP 地址" /><button disabled={monitorBusy || !monitorSource.trim()} onClick={() => void applyMonitor()}>{monitorBusy ? tr(locale, "连接中", "Connecting") : tr(locale, "应用", "Apply")}</button></div><small>{tr(locale, "RTSP、RTMP、SRT 等地址会自动转换为浏览器可播放格式。", "RTSP, RTMP and SRT sources are converted into a browser-playable stream.")}</small>{monitorError && <em>{monitorError}</em>}<div className="dashboard-monitor-options"><FitSelect locale={locale} value={widget.videoFit ?? "cover"} onChange={(videoFit) => onChange({ videoFit })} /><VideoBehavior locale={locale} widget={widget} onChange={onChange} /></div></div>}
    {!['url', 'image', 'video', 'monitor'].includes(widget.type) && <><label><span>{tr(locale, "数据键", "Data key")}</span><input list={`dashboard-keys-${sceneId}`} value={widget.key} onChange={(event) => onChange({ key: event.target.value })} /></label><label><span>{tr(locale, "单位", "Unit")}</span><input value={widget.unit} onChange={(event) => onChange({ unit: event.target.value })} /></label></>}
    <button className="dashboard-delete-widget" onClick={onDelete}><Trash2 size={12} />{tr(locale, "删除组件", "Delete widget")}</button>
  </div>;
}

function FitSelect({ locale, value, onChange }: { locale: AppLocale; value: "cover" | "contain" | "fill"; onChange: (value: "cover" | "contain" | "fill") => void }) {
  return <select value={value} onChange={(event) => onChange(event.target.value as "cover" | "contain" | "fill")}><option value="cover">{tr(locale, "铺满", "Cover")}</option><option value="contain">{tr(locale, "完整", "Contain")}</option><option value="fill">{tr(locale, "拉伸", "Fill")}</option></select>;
}

function VideoBehavior({ locale, widget, onChange }: { locale: AppLocale; widget: SceneDashboardWidgetState; onChange: (patch: Partial<SceneDashboardWidgetState>) => void }) {
  return <div className="dashboard-video-behavior"><label><input type="checkbox" checked={widget.videoAutoplay !== false} onChange={(event) => onChange({ videoAutoplay: event.target.checked })} />{tr(locale, "自动播放", "Autoplay")}</label><label><input type="checkbox" checked={widget.videoMuted !== false} onChange={(event) => onChange({ videoMuted: event.target.checked })} />{tr(locale, "静音", "Muted")}</label></div>;
}

function updateMetricMap(current: Record<string, DashboardMetric>, source: string | undefined, key: string, value: unknown, time: number): Record<string, DashboardMetric> {
  const next = { ...current };
  for (const metricKey of [key, source ? `${source}.${key}` : ""].filter(Boolean)) {
    const numeric = toFiniteNumber(value);
    const previous = current[metricKey];
    next[metricKey] = { value, samples: numeric === undefined ? previous?.samples ?? [] : [...(previous?.samples ?? []), { time, value: numeric }].slice(-60) };
  }
  return next;
}

function DashboardGrid({ locale, widgets, metrics, editable, selectedWidgetId, onSelect, onLayoutChange, onWidgetInteraction }: {
  locale: AppLocale;
  widgets: SceneDashboardWidgetState[];
  metrics: Record<string, DashboardMetric>;
  editable: boolean;
  selectedWidgetId: string | undefined;
  onSelect: (id: string) => void;
  onLayoutChange: (nodes: GridStackNode[]) => void;
  onWidgetInteraction: (trigger: SceneInteractionTrigger, widget: SceneDashboardWidgetState, originalEvent?: Event) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const layoutHandlerRef = useRef(onLayoutChange);
  layoutHandlerRef.current = onLayoutChange;
  const loadedWidgetIds = useRef(new Set<string>());
  useEffect(() => {
    for (const widget of widgets) {
      if (loadedWidgetIds.current.has(widget.id)) continue;
      loadedWidgetIds.current.add(widget.id);
      queueMicrotask(() => onWidgetInteraction("load", widget));
    }
  }, [onWidgetInteraction, widgets]);
  useLayoutEffect(() => {
    if (!gridRef.current) return;
    const grid = GridStack.init({ column: 2, cellHeight: 84, margin: 6, float: false, animate: true, staticGrid: !editable, handle: ".dashboard-drag-handle" }, gridRef.current);
    if (!grid) return;
    grid.on("change", (_event, nodes) => layoutHandlerRef.current(nodes));
    return () => { grid.destroy(false); };
  }, [editable]);
  return <div className="grid-stack dashboard-widget-grid" ref={gridRef}>{widgets.map((widget) => <div className="grid-stack-item" key={widget.id} gs-id={widget.id} gs-x={widget.x} gs-y={widget.y} gs-w={widget.w} gs-h={widget.h} gs-min-w="1" gs-max-w="2" gs-min-h="1">
    <article className={`grid-stack-item-content ${editable && selectedWidgetId === widget.id ? "selected" : ""}`} style={{ background: colorWithOpacity(widget.backgroundColor ?? "#172126", widget.backgroundOpacity ?? 0.72), color: widget.textColor ?? "#eef2f4" }} onClick={(event) => editable ? onSelect(widget.id) : onWidgetInteraction("click", widget, event.nativeEvent)} onPointerEnter={(event) => { if (!editable) onWidgetInteraction("pointerEnter", widget, event.nativeEvent); }} onPointerLeave={(event) => { if (!editable) onWidgetInteraction("pointerLeave", widget, event.nativeEvent); }}>
      {editable && <div className="dashboard-drag-handle" title={tr(locale, "拖动布局", "Drag layout")}><GripVertical size={13} /></div>}
      <WidgetView locale={locale} widget={widget} metric={metrics[widget.key]} compact={editable} onAnimationStart={() => onWidgetInteraction("animationStart", widget)} onAnimationEnd={() => onWidgetInteraction("animationEnd", widget)} />
    </article>
  </div>)}</div>;
}

function WidgetView({ locale, widget, metric, compact, onAnimationStart, onAnimationEnd }: { locale: AppLocale; widget: SceneDashboardWidgetState; metric: DashboardMetric | undefined; compact: boolean; onAnimationStart: () => void; onAnimationEnd: () => void }) {
  const display = metric?.value === undefined ? "—" : typeof metric.value === "object" ? JSON.stringify(metric.value) : String(metric.value);
  if (widget.type === "image") return <div className="dashboard-image-widget">{widget.imageUrl ? <img src={widget.imageUrl} alt={widget.title} style={{ objectFit: widget.imageFit ?? "cover" }} /> : <div><ImageIcon size={22} /><span>{tr(locale, "从资源库选择图片", "Choose an image from assets")}</span></div>}</div>;
  if (widget.type === "video") return <div className="dashboard-video-widget">{widget.videoUrl ? <StreamVideo src={widget.videoUrl} fit={widget.videoFit ?? "contain"} autoplay={widget.videoAutoplay !== false} muted={widget.videoMuted !== false} controls /> : <div><Video size={23} /><span>{tr(locale, "从资源库选择本地视频", "Choose a local video from assets")}</span></div>}</div>;
  if (widget.type === "monitor") {
    if (widget.monitorProtocol === "webrtc") return <div className={`dashboard-monitor-widget ${compact ? "editing" : ""}`}>{widget.videoUrl ? <iframe src={embeddableUrl(widget.videoUrl)} title={widget.title} allow="autoplay; fullscreen" /> : <div><Cctv size={23} /><span>{tr(locale, "填写监控地址并应用", "Enter a monitor source and apply")}</span></div>}{compact && <i>{tr(locale, "编辑时已暂停画面交互", "Interaction paused while editing")}</i>}</div>;
    return <div className="dashboard-monitor-widget">{widget.videoUrl ? <StreamVideo src={widget.videoUrl} fit={widget.videoFit ?? "cover"} autoplay={widget.videoAutoplay !== false} muted={widget.videoMuted !== false} controls={!compact} /> : <div><Cctv size={23} /><span>{tr(locale, "填写监控地址并应用", "Enter a monitor source and apply")}</span></div>}</div>;
  }
  if (widget.type === "url") {
    const url = embeddableUrl(widget.url);
    return <div className={`dashboard-webpage ${compact ? "editing" : ""}`}>
      {url ? <iframe src={url} title={widget.title || tr(locale, "嵌入网页", "Embedded web page")} loading="lazy" allow="fullscreen; autoplay; clipboard-read; clipboard-write" /> : <div><Globe2 size={22} /><strong>{widget.title}</strong><span>{tr(locale, "编辑组件并填写 HTTP(S) 或站内网页地址", "Edit the widget and enter an HTTP(S) or local URL")}</span></div>}
      {compact && <i>{tr(locale, "编辑模式下网页交互已暂停", "Web page interaction is paused while editing")}</i>}
    </div>;
  }
  if (["line", "area", "bar", "pie", "gauge"].includes(widget.type)) return <DashboardChart widget={widget} metric={metric} compact={compact} onAnimationStart={onAnimationStart} onAnimationEnd={onAnimationEnd} />;
  if (widget.type === "table") return <div className="dashboard-mini-table"><strong>{widget.title}</strong><table><tbody>{(metric?.rows ?? []).slice(0, 8).map((row, index) => <tr key={index}><td>{String(row.recorded_at ?? row.time ?? index + 1)}</td><td>{String(widget.field ? row[widget.field] ?? "—" : Object.values(row)[0] ?? "—")}</td></tr>)}</tbody></table></div>;
  if (widget.type === "status") return <div className={`dashboard-status ${Boolean(metric?.value) ? "ok" : ""}`}><i /><span><small>{widget.title}</small><strong>{display === "—" ? tr(locale, "未知", "Unknown") : display}</strong></span></div>;
  return <div className="dashboard-value"><span>{widget.title}</span><strong>{display}<small>{widget.unit}</small></strong></div>;
}

function StreamVideo({ src, fit, autoplay, muted, controls }: { src: string; fit: "cover" | "contain" | "fill"; autoplay: boolean; muted: boolean; controls: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (/\.m3u8(?:$|\?)/i.test(src) && Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true, backBufferLength: 30, maxBufferLength: 12 });
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => hls.destroy();
    }
    video.src = src;
    return () => { video.removeAttribute("src"); video.load(); };
  }, [src]);
  return <video ref={ref} style={{ objectFit: fit }} autoPlay={autoplay} muted={muted} controls={controls} playsInline preload="metadata" />;
}

function DashboardChart({ widget, metric, compact, onAnimationStart, onAnimationEnd }: { widget: SceneDashboardWidgetState; metric: DashboardMetric | undefined; compact: boolean; onAnimationStart: () => void; onAnimationEnd: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "canvas" });
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(ref.current);
    return () => { resize.disconnect(); chart.dispose(); };
  }, []);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.getInstanceByDom(ref.current);
    if (!chart) return;
    const color = widget.color ?? "#d4a84f";
    const samples = metric?.samples ?? [];
    if (!compact) {
      onAnimationStart();
      chart.off("finished");
      const finish = () => { chart.off("finished", finish); onAnimationEnd(); };
      chart.on("finished", finish);
    }
    if (widget.type === "gauge") {
      chart.setOption({ animation: !compact, series: [{ type: "gauge", min: widget.min ?? 0, max: widget.max ?? 100, radius: "83%", progress: { show: true, width: 8, itemStyle: { color } }, axisLine: { lineStyle: { width: 8, color: [[1, "#2b353a"]] } }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, pointer: { show: false }, anchor: { show: false }, title: { offsetCenter: [0, "62%"], color: "#77858c", fontSize: 9 }, detail: { valueAnimation: !compact, offsetCenter: [0, "2%"], color: "#eef2f4", fontSize: 19, formatter: `{value}${widget.unit}` }, data: [{ value: toFiniteNumber(metric?.value) ?? 0, name: widget.title }] }] }, true);
      return;
    }
    if (widget.type === "pie") {
      chart.setOption({ animation: !compact, tooltip: { trigger: "item" }, series: [{ type: "pie", radius: ["48%", "72%"], label: { show: false }, data: samples.slice(-8).map((sample, index) => ({ name: String(index + 1), value: sample.value })), itemStyle: { borderColor: "#172126", borderWidth: 2 } }] }, true);
      return;
    }
    const seriesType = widget.type === "area" ? "line" : widget.type;
    chart.setOption({ animation: !compact, grid: { top: 25, right: 8, bottom: 18, left: 36 }, tooltip: { trigger: "axis", backgroundColor: "#171d20", borderColor: "#39464d", textStyle: { color: "#d9dfe2", fontSize: 9 } }, xAxis: { type: "category", data: samples.map((sample) => new Date(sample.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })), axisLabel: { color: "#657279", fontSize: 7, showMaxLabel: true }, axisLine: { lineStyle: { color: "#303b40" } }, axisTick: { show: false } }, yAxis: { type: "value", axisLabel: { color: "#657279", fontSize: 7 }, splitLine: { lineStyle: { color: "#252e33" } } }, series: [{ type: seriesType, data: samples.map((sample) => sample.value), smooth: widget.type === "line" || widget.type === "area", showSymbol: false, itemStyle: { color }, lineStyle: { color, width: 2 }, areaStyle: widget.type === "area" ? { color, opacity: 0.28 } : undefined }] }, true);
  }, [compact, metric, widget]);
  return <div className="dashboard-chart" ref={ref} />;
}

function widgetTypeOptions(locale: AppLocale) {
  return <><option value="value">{tr(locale, "数值", "Value")}</option><option value="gauge">{tr(locale, "仪表", "Gauge")}</option><option value="status">{tr(locale, "状态", "Status")}</option><option value="line">{tr(locale, "折线", "Line")}</option><option value="area">{tr(locale, "面积", "Area")}</option><option value="bar">{tr(locale, "柱图", "Bar")}</option><option value="pie">{tr(locale, "饼图", "Pie")}</option><option value="table">{tr(locale, "表格", "Table")}</option><option value="image">{tr(locale, "图片", "Image")}</option><option value="video">{tr(locale, "本地视频", "Local video")}</option><option value="monitor">{tr(locale, "实时监控", "Live monitor")}</option><option value="url">{tr(locale, "网页", "Web page")}</option></>;
}

function dashboardWidgetTypes(locale: AppLocale): Array<{ type: SceneDashboardWidgetType; label: string }> {
  return [
    { type: "value", label: tr(locale, "数值", "Value") },
    { type: "gauge", label: tr(locale, "仪表", "Gauge") },
    { type: "line", label: tr(locale, "趋势", "Trend") },
    { type: "area", label: tr(locale, "面积", "Area") },
    { type: "bar", label: tr(locale, "柱图", "Bar") },
    { type: "pie", label: tr(locale, "饼图", "Pie") },
    { type: "table", label: tr(locale, "表格", "Table") },
    { type: "status", label: tr(locale, "状态", "Status") },
    { type: "image", label: tr(locale, "图片", "Image") },
    { type: "video", label: tr(locale, "视频", "Video") },
    { type: "monitor", label: tr(locale, "监控", "Monitor") },
    { type: "url", label: tr(locale, "网页", "Web page") }
  ];
}

function mergeDatasetMetrics(current: Record<string, DashboardMetric>, preview: DataDatasetPreview): Record<string, DashboardMetric> {
  const next = { ...current };
  for (const field of preview.fields) {
    const numericRows = [...preview.rows].reverse().flatMap((row, index) => {
      const value = toFiniteNumber(row[field.key]);
      if (value === undefined) return [];
      const rawTime = row.recorded_at ?? row.time ?? row.timestamp;
      const time = typeof rawTime === "string" || typeof rawTime === "number" ? Date.parse(String(rawTime)) : Number.NaN;
      return [{ time: Number.isFinite(time) ? time : Date.now() - (preview.rows.length - index) * 1_000, value }];
    });
    next[`${preview.dataset.id}.${field.key}`] = { value: preview.rows[0]?.[field.key], samples: numericRows.slice(-60), rows: preview.rows };
  }
  return next;
}

function colorWithOpacity(color: string, opacity: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const value = Number.parseInt(match[1]!, 16);
  return `rgba(${value >> 16},${value >> 8 & 255},${value & 255},${Math.max(0, Math.min(1, opacity))})`;
}

function embeddableUrl(value: string | undefined): string | undefined {
  const input = value?.trim();
  if (!input) return undefined;
  if (input.startsWith("/")) return input;
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function toFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function layoutChanged(left: SceneDashboardWidgetState, right: SceneDashboardWidgetState): boolean {
  return left.x !== right.x || left.y !== right.y || left.w !== right.w || left.h !== right.h;
}
