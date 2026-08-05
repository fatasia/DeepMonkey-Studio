import { useEffect, useMemo, useState } from "react";
import { Activity, ExternalLink, GripVertical, PanelLeft, PanelRight, Plus, Settings2, Trash2, X } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import type { SceneDataMessage } from "../viewer/ViewerEngine";

type DashboardSide = "left" | "right";
type WidgetType = "value" | "gauge" | "status";
interface DashboardWidget { id: string; title: string; key: string; type: WidgetType; unit: string; }

const DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: "realtime-value", title: "实时数值", key: "value", type: "value", unit: "" },
  { id: "device-status", title: "设备状态", key: "status", type: "status", unit: "" }
];

export function SceneDashboardOverlay({ locale, sceneId, onClose }: { locale: AppLocale; sceneId: string; onClose: () => void }) {
  const [side, setSide] = useState<DashboardSide>(() => window.localStorage.getItem("bim-studio.dashboard-side") === "left" ? "left" : "right");
  const [width, setWidth] = useState(() => Math.min(560, Math.max(300, Number(window.localStorage.getItem("bim-studio.dashboard-width")) || 380)));
  const storageKey = `bim-studio.dashboard-widgets.${sceneId}`;
  const [widgets, setWidgets] = useState<DashboardWidget[]>(() => readWidgets(storageKey));
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [editing, setEditing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [draggingId, setDraggingId] = useState<string>();

  useEffect(() => setWidgets(readWidgets(storageKey)), [storageKey]);
  useEffect(() => window.localStorage.setItem(storageKey, JSON.stringify(widgets)), [storageKey, widgets]);
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/iot/ws/scene`);
    socket.addEventListener("open", () => setConnected(true));
    socket.addEventListener("close", () => setConnected(false));
    socket.addEventListener("error", () => setConnected(false));
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as SceneDataMessage;
        setValues((current) => ({ ...current, [message.key || "value"]: message.value, [`${message.source}.${message.key}`]: message.value }));
      } catch { /* ignore non-JSON heartbeat messages */ }
    });
    return () => socket.close();
  }, []);

  const resolvedWidgets = useMemo(() => widgets.map((widget) => ({ ...widget, value: values[widget.key] })), [widgets, values]);

  function changeSide(next: DashboardSide) {
    setSide(next);
    window.localStorage.setItem("bim-studio.dashboard-side", next);
  }

  function changeWidth(next: number) {
    setWidth(next);
    window.localStorage.setItem("bim-studio.dashboard-width", String(next));
  }

  function addWidget() {
    setWidgets((items) => [...items, { id: crypto.randomUUID(), title: tr(locale, "新指标", "New metric"), key: "value", type: "value", unit: "" }]);
    setEditing(true);
  }

  function updateWidget(id: string, patch: Partial<DashboardWidget>) {
    setWidgets((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function dropWidget(targetId: string) {
    if (!draggingId || draggingId === targetId) return;
    setWidgets((items) => {
      const source = items.find((item) => item.id === draggingId);
      if (!source) return items;
      const next = items.filter((item) => item.id !== draggingId);
      next.splice(Math.max(0, next.findIndex((item) => item.id === targetId)), 0, source);
      return next;
    });
    setDraggingId(undefined);
  }

  return <section className={`scene-dashboard-overlay ${side}`} style={{ width }} aria-label={tr(locale, "场景二维看板", "Scene dashboard")}>
    <header>
      <div><strong>{tr(locale, "场景数据看板", "Scene dashboard")}</strong><small className={connected ? "online" : ""}>{connected ? tr(locale, "实时连接", "Live") : tr(locale, "等待数据", "Waiting")}</small></div>
      <nav>
        <button className={editing ? "active" : ""} title={tr(locale, "编辑看板", "Edit dashboard")} onClick={() => setEditing((value) => !value)}><Settings2 size={14} /></button>
        <button className={side === "left" ? "active" : ""} title={tr(locale, "固定到左侧", "Dock left")} onClick={() => changeSide("left")}><PanelLeft size={14} /></button>
        <button className={side === "right" ? "active" : ""} title={tr(locale, "固定到右侧", "Dock right")} onClick={() => changeSide("right")}><PanelRight size={14} /></button>
        <a href="/node-red" target="_blank" rel="noreferrer" title={tr(locale, "编辑数据流程", "Edit data flows")}><ExternalLink size={14} /></a>
        <button title={tr(locale, "关闭", "Close")} onClick={onClose}><X size={15} /></button>
      </nav>
    </header>
    <div className="dashboard-canvas">
      {editing && <button className="dashboard-add-widget" onClick={addWidget}><Plus size={14} />{tr(locale, "添加指标", "Add metric")}</button>}
      <div className="dashboard-widget-grid">
        {resolvedWidgets.map((widget) => <article key={widget.id} draggable={editing} onDragStart={() => setDraggingId(widget.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropWidget(widget.id)}>
          {editing && <GripVertical className="dashboard-grip" size={14} />}
          {editing ? <div className="dashboard-widget-form">
            <input value={widget.title} onChange={(event) => updateWidget(widget.id, { title: event.target.value })} aria-label={tr(locale, "指标名称", "Metric name")} />
            <input value={widget.key} onChange={(event) => updateWidget(widget.id, { key: event.target.value })} placeholder="source.key / key" aria-label={tr(locale, "数据键", "Data key")} />
            <select value={widget.type} onChange={(event) => updateWidget(widget.id, { type: event.target.value as WidgetType })}><option value="value">{tr(locale, "数值", "Value")}</option><option value="gauge">{tr(locale, "仪表", "Gauge")}</option><option value="status">{tr(locale, "状态", "Status")}</option></select>
            <input value={widget.unit} onChange={(event) => updateWidget(widget.id, { unit: event.target.value })} placeholder={tr(locale, "单位", "Unit")} />
            <button onClick={() => setWidgets((items) => items.filter((item) => item.id !== widget.id))}><Trash2 size={13} /></button>
          </div> : <WidgetView locale={locale} widget={widget} />}
        </article>)}
      </div>
      {resolvedWidgets.length === 0 && <div className="dashboard-empty"><Activity size={24} /><strong>{tr(locale, "添加第一个指标", "Add your first metric")}</strong><span>{tr(locale, "Node-RED 负责接入与整理数据，这里负责拖拽排版和场景展示。", "Node-RED connects and shapes data; this panel handles lightweight layout and scene display.")}</span></div>}
    </div>
    <label className="dashboard-width"><span>{tr(locale, "宽度", "Width")}</span><input type="range" min="300" max="560" step="10" value={width} onChange={(event) => changeWidth(Number(event.target.value))} /><output>{width}px</output></label>
  </section>;
}

function WidgetView({ locale, widget }: { locale: AppLocale; widget: DashboardWidget & { value: unknown } }) {
  const numeric = typeof widget.value === "number" ? widget.value : Number(widget.value);
  const display = widget.value === undefined ? "—" : typeof widget.value === "object" ? JSON.stringify(widget.value) : String(widget.value);
  if (widget.type === "gauge") {
    const percent = Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0;
    return <div className="dashboard-gauge"><span>{widget.title}</span><div style={{ "--gauge-value": `${percent}%` } as React.CSSProperties}><strong>{display}</strong><small>{widget.unit}</small></div></div>;
  }
  if (widget.type === "status") return <div className={`dashboard-status ${Boolean(widget.value) ? "ok" : ""}`}><i /><span><small>{widget.title}</small><strong>{display === "—" ? tr(locale, "未知", "Unknown") : display}</strong></span></div>;
  return <div className="dashboard-value"><span>{widget.title}</span><strong>{display}<small>{widget.unit}</small></strong></div>;
}

function readWidgets(storageKey: string): DashboardWidget[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as DashboardWidget[] | null;
    return Array.isArray(parsed) ? parsed : DEFAULT_WIDGETS;
  } catch { return DEFAULT_WIDGETS; }
}
