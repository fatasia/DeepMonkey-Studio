import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Activity, ExternalLink, GripVertical, PanelLeft, PanelRight, Plus, Settings2, Trash2, X } from "lucide-react";
import { GridStack, type GridStackNode } from "gridstack";
import "gridstack/dist/gridstack.min.css";
import * as echarts from "echarts/core";
import { BarChart, GaugeChart, LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { SceneDashboardState, SceneDashboardWidgetState, SceneDashboardWidgetType } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { subscribeSceneData } from "../sceneDataBridge";

echarts.use([BarChart, GaugeChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

interface MetricSample { time: number; value: number; }
interface DashboardMetric { value: unknown; samples: MetricSample[]; }

export function SceneDashboardOverlay({ locale, sceneId, state, readOnly = false, onChange, onClose }: {
  locale: AppLocale;
  sceneId: string;
  state: SceneDashboardState;
  readOnly?: boolean;
  onChange: (state: SceneDashboardState) => void;
  onClose: () => void;
}) {
  const [metrics, setMetrics] = useState<Record<string, DashboardMetric>>({});
  const [editing, setEditing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [selectedKey, setSelectedKey] = useState("value");
  const [selectedType, setSelectedType] = useState<SceneDashboardWidgetType>("value");
  const [selectedWidgetId, setSelectedWidgetId] = useState<string>();

  useEffect(() => { if (readOnly) setEditing(false); }, [readOnly]);
  useEffect(() => {
    return subscribeSceneData((message) => {
      if (message.sceneId && message.sceneId !== sceneId) return;
      const keys = [message.key || "value", message.source && message.key ? `${message.source}.${message.key}` : ""].filter(Boolean);
      setMetrics((current) => {
        const next = { ...current };
        for (const key of keys) {
          const numeric = toFiniteNumber(message.value);
          const previous = current[key];
          next[key] = {
            value: message.value,
            samples: numeric === undefined ? previous?.samples ?? [] : [...(previous?.samples ?? []), { time: Date.parse(message.timestamp) || Date.now(), value: numeric }].slice(-60)
          };
        }
        return next;
      });
    }, (status) => setConnected(status === "online"));
  }, [sceneId]);

  const availableKeys = useMemo(() => [...new Set(["value", "status", ...Object.keys(metrics), ...state.widgets.map((widget) => widget.key)])].sort(), [metrics, state.widgets]);
  const selectedWidget = state.widgets.find((widget) => widget.id === selectedWidgetId);

  function patchState(patch: Partial<SceneDashboardState>) {
    onChange({ ...state, ...patch });
  }

  function addWidget() {
    const chart = selectedType === "line" || selectedType === "bar";
    const widget: SceneDashboardWidgetState = {
      id: crypto.randomUUID(),
      title: selectedKey.split(".").at(-1) || tr(locale, "新指标", "New metric"),
      key: selectedKey || "value",
      type: selectedType,
      unit: "",
      x: 0,
      y: Number.MAX_SAFE_INTEGER,
      w: chart ? 2 : 1,
      h: chart ? 2 : selectedType === "gauge" ? 2 : 1,
      min: 0,
      max: 100,
      color: "#d4a84f"
    };
    patchState({ widgets: [...state.widgets, widget] });
    setSelectedWidgetId(widget.id);
  }

  function updateWidget(id: string, patch: Partial<SceneDashboardWidgetState>) {
    patchState({ widgets: state.widgets.map((widget) => widget.id === id ? { ...widget, ...patch } : widget) });
  }

  function updateLayout(nodes: GridStackNode[]) {
    const positions = new Map(nodes.flatMap((node) => node.id ? [[String(node.id), node] as const] : []));
    const widgets = state.widgets.map((widget) => {
      const node = positions.get(widget.id);
      return node ? { ...widget, x: node.x ?? widget.x, y: node.y ?? widget.y, w: node.w ?? widget.w, h: node.h ?? widget.h } : widget;
    });
    if (widgets.some((widget, index) => layoutChanged(widget, state.widgets[index]!))) patchState({ widgets });
  }

  return <section className={`scene-dashboard-overlay ${state.side} ${readOnly ? "read-only" : ""}`} style={{ width: state.width }} aria-label={tr(locale, "场景二维看板", "Scene dashboard") }>
    <header>
      <div><strong>{tr(locale, "场景数据看板", "Scene dashboard")}</strong><small className={connected ? "online" : ""}>{connected ? tr(locale, "实时连接", "Live") : tr(locale, "自动重连", "Reconnecting")}</small></div>
      <nav>
        {!readOnly && <button className={editing ? "active" : ""} title={tr(locale, "编辑看板", "Edit dashboard")} onClick={() => setEditing((value) => !value)}><Settings2 size={14} /></button>}
        <button className={state.side === "left" ? "active" : ""} title={tr(locale, "固定到左侧", "Dock left")} onClick={() => patchState({ side: "left" })}><PanelLeft size={14} /></button>
        <button className={state.side === "right" ? "active" : ""} title={tr(locale, "固定到右侧", "Dock right")} onClick={() => patchState({ side: "right" })}><PanelRight size={14} /></button>
        {!readOnly && <a href="/node-red" target="_blank" rel="noreferrer" title={tr(locale, "编辑数据流程", "Edit data flows")}><ExternalLink size={14} /></a>}
        {!readOnly && <button title={tr(locale, "关闭", "Close")} onClick={onClose}><X size={15} /></button>}
      </nav>
    </header>
    <div className={`dashboard-canvas ${editing ? "editing" : ""}`}>
      {editing && <div className="dashboard-quick-add"><div><span>1</span><label>{tr(locale, "数据键", "Data key")}</label><input list={`dashboard-keys-${sceneId}`} value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)} placeholder="source.key" /><datalist id={`dashboard-keys-${sceneId}`}>{availableKeys.map((key) => <option key={key} value={key} />)}</datalist></div><div><span>2</span><label>{tr(locale, "图表", "Chart")}</label><select value={selectedType} onChange={(event) => setSelectedType(event.target.value as SceneDashboardWidgetType)}>{widgetTypeOptions(locale)}</select></div><button onClick={addWidget}><Plus size={14} /><i>3</i>{tr(locale, "放入页面", "Add")}</button></div>}
      {editing && selectedWidget && <div className="dashboard-widget-editor"><span>{tr(locale, "当前组件", "Selected")}</span><input value={selectedWidget.title} onChange={(event) => updateWidget(selectedWidget.id, { title: event.target.value })} aria-label={tr(locale, "指标名称", "Metric name")} /><input list={`dashboard-keys-${sceneId}`} value={selectedWidget.key} onChange={(event) => updateWidget(selectedWidget.id, { key: event.target.value })} placeholder="source.key" aria-label={tr(locale, "数据键", "Data key")} /><select value={selectedWidget.type} onChange={(event) => updateWidget(selectedWidget.id, { type: event.target.value as SceneDashboardWidgetType })}>{widgetTypeOptions(locale)}</select><input value={selectedWidget.unit} onChange={(event) => updateWidget(selectedWidget.id, { unit: event.target.value })} placeholder={tr(locale, "单位", "Unit")} /><input className="dashboard-color" type="color" value={selectedWidget.color ?? "#d4a84f"} onChange={(event) => updateWidget(selectedWidget.id, { color: event.target.value })} /><button title={tr(locale, "删除组件", "Delete widget")} onClick={() => { patchState({ widgets: state.widgets.filter((widget) => widget.id !== selectedWidget.id) }); setSelectedWidgetId(undefined); }}><Trash2 size={12} /></button></div>}
      <DashboardGrid key={`${sceneId}:${editing}:${state.widgets.map((widget) => widget.id).join(",")}`} locale={locale} widgets={state.widgets} metrics={metrics} editable={editing && !readOnly} selectedWidgetId={selectedWidgetId} onSelect={setSelectedWidgetId} onLayoutChange={updateLayout} />
      {state.widgets.length === 0 && <div className="dashboard-empty"><Activity size={24} /><strong>{tr(locale, "添加第一个图表", "Add your first chart")}</strong><span>{tr(locale, "Node-RED 负责接入数据；这里只做可保存、可发布的轻量排版。", "Node-RED connects data; this panel provides lightweight, publishable layout.")}</span></div>}
    </div>
    {!readOnly && <label className="dashboard-width"><span>{tr(locale, "宽度", "Width")}</span><input type="range" min="320" max="720" step="10" value={state.width} onChange={(event) => patchState({ width: Number(event.target.value) })} /><output>{state.width}px</output></label>}
  </section>;
}

function DashboardGrid({ locale, widgets, metrics, editable, selectedWidgetId, onSelect, onLayoutChange }: {
  locale: AppLocale;
  widgets: SceneDashboardWidgetState[];
  metrics: Record<string, DashboardMetric>;
  editable: boolean;
  selectedWidgetId: string | undefined;
  onSelect: (id: string) => void;
  onLayoutChange: (nodes: GridStackNode[]) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const layoutHandlerRef = useRef(onLayoutChange);
  layoutHandlerRef.current = onLayoutChange;
  useLayoutEffect(() => {
    if (!gridRef.current) return;
    const grid = GridStack.init({ column: 2, cellHeight: 84, margin: 6, float: false, animate: true, staticGrid: !editable, handle: ".dashboard-drag-handle" }, gridRef.current);
    if (!grid) return;
    grid.on("change", (_event, nodes) => layoutHandlerRef.current(nodes));
    return () => { grid.destroy(false); };
  }, [editable]);
  return <div className="grid-stack dashboard-widget-grid" ref={gridRef}>{widgets.map((widget) => <div className="grid-stack-item" key={widget.id} gs-id={widget.id} gs-x={widget.x} gs-y={widget.y} gs-w={widget.w} gs-h={widget.h} gs-min-w="1" gs-max-w="2" gs-min-h="1">
    <article className={`grid-stack-item-content ${editable && selectedWidgetId === widget.id ? "selected" : ""}`} onClick={() => editable && onSelect(widget.id)}>
      {editable && <div className="dashboard-drag-handle" title={tr(locale, "拖动布局", "Drag layout")}><GripVertical size={13} /></div>}
      <WidgetView locale={locale} widget={widget} metric={metrics[widget.key]} compact={editable} />
    </article>
  </div>)}</div>;
}

function WidgetView({ locale, widget, metric, compact }: { locale: AppLocale; widget: SceneDashboardWidgetState; metric: DashboardMetric | undefined; compact: boolean }) {
  const display = metric?.value === undefined ? "—" : typeof metric.value === "object" ? JSON.stringify(metric.value) : String(metric.value);
  if (widget.type === "line" || widget.type === "bar" || widget.type === "gauge") return <DashboardChart widget={widget} metric={metric} compact={compact} />;
  if (widget.type === "status") return <div className={`dashboard-status ${Boolean(metric?.value) ? "ok" : ""}`}><i /><span><small>{widget.title}</small><strong>{display === "—" ? tr(locale, "未知", "Unknown") : display}</strong></span></div>;
  return <div className="dashboard-value"><span>{widget.title}</span><strong>{display}<small>{widget.unit}</small></strong></div>;
}

function DashboardChart({ widget, metric, compact }: { widget: SceneDashboardWidgetState; metric: DashboardMetric | undefined; compact: boolean }) {
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
    if (widget.type === "gauge") {
      chart.setOption({ animation: !compact, series: [{ type: "gauge", min: widget.min ?? 0, max: widget.max ?? 100, radius: "83%", progress: { show: true, width: 8, itemStyle: { color } }, axisLine: { lineStyle: { width: 8, color: [[1, "#2b353a"]] } }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, pointer: { show: false }, anchor: { show: false }, title: { offsetCenter: [0, "62%"], color: "#77858c", fontSize: 9 }, detail: { valueAnimation: !compact, offsetCenter: [0, "2%"], color: "#eef2f4", fontSize: 19, formatter: `{value}${widget.unit}` }, data: [{ value: toFiniteNumber(metric?.value) ?? 0, name: widget.title }] }] }, true);
      return;
    }
    chart.setOption({ animation: !compact, grid: { top: 25, right: 8, bottom: 18, left: 36 }, tooltip: { trigger: "axis", backgroundColor: "#171d20", borderColor: "#39464d", textStyle: { color: "#d9dfe2", fontSize: 9 } }, xAxis: { type: "category", data: samples.map((sample) => new Date(sample.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })), axisLabel: { color: "#657279", fontSize: 7, showMaxLabel: true }, axisLine: { lineStyle: { color: "#303b40" } }, axisTick: { show: false } }, yAxis: { type: "value", axisLabel: { color: "#657279", fontSize: 7 }, splitLine: { lineStyle: { color: "#252e33" } } }, series: [{ type: widget.type, data: samples.map((sample) => sample.value), smooth: widget.type === "line", showSymbol: false, itemStyle: { color }, lineStyle: { color, width: 2 }, areaStyle: widget.type === "line" ? { color, opacity: 0.1 } : undefined }] }, true);
  }, [compact, metric, widget]);
  return <div className="dashboard-chart" ref={ref} />;
}

function widgetTypeOptions(locale: AppLocale) {
  return <><option value="value">{tr(locale, "数值", "Value")}</option><option value="gauge">{tr(locale, "仪表", "Gauge")}</option><option value="status">{tr(locale, "状态", "Status")}</option><option value="line">{tr(locale, "趋势", "Trend")}</option><option value="bar">{tr(locale, "柱图", "Bar")}</option></>;
}

function toFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function layoutChanged(left: SceneDashboardWidgetState, right: SceneDashboardWidgetState): boolean {
  return left.x !== right.x || left.y !== right.y || left.w !== right.w || left.h !== right.h;
}
