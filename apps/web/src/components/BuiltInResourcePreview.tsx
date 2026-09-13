import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { DashboardDataWidgetConfig, JsonValue } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { INDUSTRIAL_PREFAB_CATALOG } from "../prefabs/industrialPrefabCatalog";
import { createIndustrialPrefabInstance, industrialPrefabPrimitiveVisual } from "../prefabs/industrialPrefabInstance";
import { DASHBOARD_COMPONENT_PRESETS } from "./DashboardComponentCatalog";
import { DASHBOARD_TEMPLATES } from "./dashboardTemplateCatalog";
import { buildDashboardTemplateNodes } from "./dashboardTemplateLayoutBuilder";
import { createDefaultDataWidget } from "./dashboardWorkspaceModel";
import { buildDashboardSampleMetric, withDashboardSampleData } from "./dashboardSampleMetrics";
import type { BuiltInAssetKind } from "./BuiltInAssetBrowser";
import "./ProjectResourceDialogs.css";

const WidgetView = lazy(() => import("./DashboardWidgetRuntime").then(module => ({ default: module.DashboardWidgetView })));

/** 浏览与插入复用组件和几何工厂，交互状态仅存在于弹窗内。 */
export function BuiltInResourcePreview({ id, name, kind, locale, onClose }: { id: string; name: string; kind: BuiltInAssetKind; locale: AppLocale; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; dialog.current?.showModal(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  return <dialog ref={dialog} className="project-resource-dialog" aria-label={tr(locale, `浏览 ${name}`, `Browse ${name}`)} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2>{name}</h2><button type="button" aria-label={tr(locale, "关闭资源浏览", "Close asset preview")} onClick={onClose}><X size={18} /></button></header>
    <div className="project-resource-preview-content">{kind === "prefab" ? <PrefabPreview id={id} locale={locale} /> : <WidgetPreview id={id} kind={kind} locale={locale} />}</div>
    <footer>{kind === "prefab" ? tr(locale, "拖动旋转 · 滚轮缩放", "Drag to orbit · Scroll to zoom") : tr(locale, "内置样例数据 · 筛选与交互仅在本次浏览生效", "Built-in sample data · Interactions apply to this preview only")}</footer>
  </dialog>;
}

function WidgetPreview({ id, kind, locale }: { id: string; kind: "2d" | "template"; locale: AppLocale }) {
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [filters, setFilters] = useState<Record<string, JsonValue>>({});
  const nodes = useMemo(() => {
    if (kind === "template") {
      const template = DASHBOARD_TEMPLATES.find(item => item.id === id);
      return template ? buildDashboardTemplateNodes(locale, { id: "preview", name: "preview", width: 1920, height: 1080, viewportFit: "contain", nodes: [] }, template, 0) : [];
    }
    const preset = DASHBOARD_COMPONENT_PRESETS.find(item => item.id === id);
    return preset ? [{ id, frame: { x: 0, y: 0, width: 640, height: 360 }, widget: { ...createDefaultDataWidget(locale, preset.type), ...preset.widget } }] : [];
  }, [id, kind, locale]);
  const width = kind === "template" ? 1920 : 640, height = kind === "template" ? 1080 : 360;
  useLayoutEffect(() => {
    if (!host.current) return;
    const element = host.current;
    const fit = () => setScale(Math.max(.01, Math.min((element.clientWidth - 32) / width, (element.clientHeight - 32) / height)));
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(element); return () => resize.disconnect();
  }, [width, height]);
  return <div ref={host} className="builtin-live-preview"><div style={{ position: "relative", width: width * scale, height: height * scale }}><div style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left", position: "relative" }}>
    <Suspense fallback={<span role="status">{tr(locale, "正在加载…", "Loading…")}</span>}>
      {nodes.map(node => <div key={node.id} className="builtin-widget-preview" style={{ left: node.frame.x, top: node.frame.y, width: node.frame.width, height: node.frame.height }}><PreviewWidget locale={locale} source={node.widget} filters={filters} onFilter={(key, value) => setFilters(current => { const next = { ...current }; if (value === undefined) delete next[key]; else next[key] = value; return next; })} /></div>)}
    </Suspense>
  </div></div></div>;
}

function PreviewWidget({ locale, source, filters, onFilter }: { locale: AppLocale; source: DashboardDataWidgetConfig; filters: Record<string, JsonValue>; onFilter: (key: string, value: JsonValue | undefined) => void }) {
  const widget = useMemo(() => source.sampleData ? source : withDashboardSampleData(source), [source]);
  const metric = useMemo(() => buildDashboardSampleMetric(widget, widget.sampleData?.rows ?? []), [widget]);
  return <WidgetView locale={locale} widget={widget} metric={metric} compact={false} filters={filters} {...(filters[widget.key] !== undefined ? { filterValue: filters[widget.key] } : {})} onFilterChange={onFilter} onDataInteraction={() => undefined} onAnimationStart={() => undefined} onAnimationEnd={() => undefined} />;
}

function PrefabPreview({ id, locale }: { id: string; locale: AppLocale }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const definition = INDUSTRIAL_PREFAB_CATALOG.find(item => item.id === id);
    if (!definition || !host.current) return;
    let closed = false;
    let dispose: (() => void) | undefined;
    const container = host.current;
    void import("../viewer/ViewerEngine").then(async ({ ViewerEngine }) => {
      const engine = await ViewerEngine.create(container, "webgl");
      if (closed) { engine.dispose(); return; }
      dispose = () => engine.dispose();
      engine.setReadOnly(true); engine.setInteractionScripts([]);
      const visual = industrialPrefabPrimitiveVisual(definition.kind);
      const color = getComputedStyle(container).getPropertyValue("--accent").trim();
      engine.createPrimitive(id, definition.name, visual.primitive, color);
      engine.setIndustrialPrefabState(id, createIndustrialPrefabInstance(definition, { x: 0, y: 0, z: 0 }));
      engine.focusModel(id); setLoading(false);
    }).catch(reason => { if (!closed) { setLoading(false); setError(reason instanceof Error ? reason.message : String(reason)); } });
    return () => { closed = true; dispose?.(); };
  }, [id]);
  return <div className="appearance-resource-preview"><div ref={host} className="appearance-resource-canvas" />{loading && <span className="resource-preview-feedback" role="status">{tr(locale, "正在加载…", "Loading…")}</span>}{error && <span className="resource-preview-feedback" role="alert">{error}</span>}</div>;
}
