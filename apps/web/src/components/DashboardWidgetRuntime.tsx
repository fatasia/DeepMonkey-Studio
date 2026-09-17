import type { DashboardMetric } from "./dashboardMetricTypes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Globe2 } from "lucide-react";
import { resolveDeviceSignal, type DashboardDataWidgetConfig, type DataDatasetField, type DataPipelineDefinition, type DataDatasetRecord, type JsonValue, type SemanticModelRecord } from "@bim-studio/contracts";
import { DeviceSignalView } from "./DeviceSignalView";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { publishLocalSceneData, subscribeSceneData } from "../sceneDataBridge";
import { DirectBindingRuntime } from "../directBindingRuntime";
import { DashboardDigitalFlip, DashboardLiquidFill, DashboardScrollTable } from "./DashboardIndustrialWidgets";
import { DashboardImage, DashboardMonitor, DashboardVideo } from "./DashboardMediaPlayer";
import { analyzeDashboardMetric, conditionalStyle } from "./dashboardAnalytics";
import { formatDashboardMetricDisplay } from "./dashboardMetricDisplay";
import { mergeDirectBindingMetric, mergeProductMetrics } from "./dashboardMetrics";
import { buildDashboardSampleMetric, dashboardSampleFilterWidgets } from "./dashboardSampleMetrics";
import { resolveSemanticWidget } from "./dashboardSemanticBinding";
import { buildSemanticMetric } from "./dashboardSemanticMetrics";
import { buildDashboardDataProductRefreshPlans } from "./dataRefreshPolicy";
import { DashboardDatasetRefreshQueue, type DashboardRefreshResult } from "./dashboardDatasetRefreshQueue";
import { dashboardJsonRecord as jsonRecord, dashboardJsonValue as jsonValue, finiteDashboardNumber as toFiniteNumber } from "./dashboardWidgetValues";
import { applyDashboardFilters, DashboardDesignState, DashboardDrillChart, DashboardReportTable } from "./DashboardWidgetVisualization";

export {
  applyDashboardFilters,
  buildDashboardHierarchy,
  dashboardLinkageValue,
  filterDashboardDrillRows,
  widgetBackground,
  widgetBackgroundStyle,
} from "./DashboardWidgetVisualization";

export type { DashboardMetric } from "./dashboardMetricTypes";

const NO_SEMANTIC_MODELS: SemanticModelRecord[] = [];

export function useDashboardMetrics(
  projectId: string,
  sourceWidgets: readonly DashboardDataWidgetConfig[],
  sceneId?: string,
  filters: Readonly<Record<string, JsonValue>> = {},
  liveDataEnabled = true,
  semanticModels: readonly SemanticModelRecord[] = NO_SEMANTIC_MODELS,
) {
  const resolved = useMemo(() => sourceWidgets.map((widget) => resolveSemanticWidget(widget, semanticModels)), [sourceWidgets, semanticModels]);
  const widgets = useMemo(() => resolved.filter((entry) => !entry.error).map((entry) => entry.widget), [resolved]);
  const [metrics, setMetrics] = useState<Record<string, DashboardMetric>>({});
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [pipelines, setPipelines] = useState<DataPipelineDefinition[]>([]);
  const [fieldsByProduct, setFieldsByProduct] = useState<Record<string, DataDatasetField[]>>({});
  const [statusByProduct, setStatusByProduct] = useState<Record<string, "loading" | "ready" | "error">>({});
  const [catalogError, setCatalogError] = useState(false);
  const [catalogResolved, setCatalogResolved] = useState(false);
  const [connected, setConnected] = useState(false);
  const datasetRefresh = useRef<((datasetId: string) => Promise<DashboardRefreshResult>) | undefined>(undefined);
  const refreshDataset = useCallback((datasetId: string) => datasetRefresh.current?.(datasetId) ?? Promise.resolve<DashboardRefreshResult>("cancelled"), []);

  useEffect(() => {
    if (!widgets.some((widget) => widget.datasetId || widget.pipelineId || widget.type === "record-form")) {
      setCatalogError(false);
      setCatalogResolved(false);
      return;
    }
    let cancelled = false;
    setCatalogError(false);
    setCatalogResolved(false);
    void Promise.all([api.listDatasets(projectId), api.listDataPipelines(projectId)])
      .then(([nextDatasets, nextPipelines]) => {
        if (cancelled) return;
        setDatasets(nextDatasets);
        setPipelines(nextPipelines);
        setFieldsByProduct((current) => ({
          ...current,
          ...Object.fromEntries(nextDatasets.map((dataset) => [`dataset:${dataset.id}`, dataset.fields])),
        }));
        setCatalogResolved(true);
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogError(true);
          setCatalogResolved(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, widgets]);

  useEffect(() => {
    const directWidgets = widgets.filter((widget) => widget.directBinding);
    if (directWidgets.length === 0) return;
    const stops = directWidgets.map((widget) => {
      const binding = widget.directBinding!;
      const statusKey = `direct:${widget.key}`;
      return new DirectBindingRuntime(
        binding,
        {},
        {
          onValue: (value, data) => setMetrics((current) => mergeDirectBindingMetric(current, widget.key, value, data, Date.now())),
          onStatus: (status) => setStatusByProduct((current) => ({ ...current, [statusKey]: status === "online" ? "ready" : status === "error" ? "error" : "loading" })),
        },
      ).start();
    });
    return () => stops.forEach((stop) => stop());
  }, [widgets]);

  useEffect(() => {
    if (!catalogResolved) return;
    const plans = buildDashboardDataProductRefreshPlans(widgets, datasets, pipelines);
    if (plans.length === 0) return;
    let cancelled = false;
    const timers: number[] = [];
    const refresh = async (plan: (typeof plans)[number]) => {
      setStatusByProduct((current) => ({ ...current, [plan.key]: "loading" }));
      try {
        const preview = plan.kind === "dataset" ? await api.previewDataset(projectId, plan.id) : await api.previewDataPipeline(projectId, plan.id);
        if ("status" in preview && preview.status === "error") throw new Error(preview.error || "数据管道运行失败");
        if (cancelled) return;
        const rows = applyDashboardFilters(preview.rows, filters, widgets.filter((widget) => !widget.semanticBinding));
        setFieldsByProduct((current) => ({ ...current, [plan.key]: preview.fields }));
        setStatusByProduct((current) => ({ ...current, [plan.key]: "ready" }));
        setMetrics((current) => ({ ...mergeProductMetrics(current, plan.id, preview.fields, rows), ...Object.fromEntries(
          widgets.filter((widget) => widget.semanticBinding && (plan.kind === "dataset" ? widget.datasetId === plan.id : widget.pipelineId === plan.id))
            .map((widget) => [widget.key, buildSemanticMetric(widget, semanticModels, preview.rows, preview.fields, widgets, filters)]),
        ) }));
      } catch (reason) {
        if (!cancelled) {
          setStatusByProduct((current) => ({ ...current, [plan.key]: "error" }));
          setMetrics((current) => ({ ...current, ...Object.fromEntries(widgets.filter((widget) => widget.semanticBinding && (widget.datasetId === plan.id || widget.pipelineId === plan.id)).map((widget) => [widget.key, { value: undefined, samples: [], semanticWidget: widget, semanticError: "语义数据源运行失败，请检查数据中心并重试。" }])) }));
        }
        throw reason;
      }
    };
    const queue = new DashboardDatasetRefreshQueue(key => refresh(plans.find(plan => plan.key === key)!));
    const refreshOneDataset = (datasetId: string) => {
      const plan = plans.find(item => item.kind === "dataset" && item.id === datasetId);
      return plan ? queue.request(plan.key, true) : Promise.resolve<DashboardRefreshResult>("cancelled");
    };
    datasetRefresh.current = refreshOneDataset;
    for (const plan of plans) {
      void queue.request(plan.key);
      if (plan.refreshSeconds > 0) timers.push(window.setInterval(() => void queue.request(plan.key), plan.refreshSeconds * 1_000));
    }
    return () => {
      cancelled = true;
      queue.dispose();
      if (datasetRefresh.current === refreshOneDataset) datasetRefresh.current = undefined;
      for (const timer of timers) window.clearInterval(timer);
    };
  }, [catalogResolved, datasets, filters, pipelines, projectId, widgets, semanticModels]);

  useEffect(() => {
    // 确定性视觉验收和离线嵌入场景不应建立会重试的现场数据连接。
    if (!liveDataEnabled) return;
    return subscribeSceneData(
      projectId,
      (message) => {
        if (sceneId && message.sceneId && message.sceneId !== sceneId) return;
        setMetrics((current) => updateMetricMap(current, message.source, message.key || "value", message.value, Date.parse(message.timestamp) || Date.now()));
      },
      (status) => setConnected(status === "online"),
    );
  }, [liveDataEnabled, projectId, sceneId]);

  const visibleMetrics = useMemo(() => ({ ...metrics,
    ...Object.fromEntries(widgets.filter(widget => widget.sampleData).map(widget => [widget.key,
      buildDashboardSampleMetric(widget, applyDashboardFilters(widget.sampleData!.rows, filters, dashboardSampleFilterWidgets(widget, widgets)) as NonNullable<DashboardDataWidgetConfig["sampleData"]>["rows"])])),
    ...Object.fromEntries(resolved.filter((entry) => entry.widget.semanticBinding).map((entry) => {
    const error = entry.error ?? (catalogError ? "语义数据目录读取失败，请刷新页面重试。" : undefined);
    const metric = metrics[entry.widget.key];
    return [entry.widget.key, error ? { value: undefined, samples: [], semanticError: error } : JSON.stringify(metric?.semanticWidget?.semanticBinding) === JSON.stringify(entry.widget.semanticBinding) ? metric! : { value: undefined, samples: [] }];
  })) }), [metrics, resolved, catalogError, widgets, filters]);
  return { metrics: visibleMetrics, datasets, pipelines, fieldsByProduct, statusByProduct, catalogError, connected, refreshDataset } as const;
}

export function DashboardWidgetView({
  projectId,
  locale,
  widget,
  metric,
  compact,
  filters = {},
  filterValue,
  onFilterChange,
  onDataInteraction,
  onAnimationStart,
  onAnimationEnd,
}: {
  projectId?: string;
  locale: AppLocale;
  widget: DashboardDataWidgetConfig;
  metric: DashboardMetric | undefined;
  compact: boolean;
  filters?: Readonly<Record<string, JsonValue>>;
  filterValue?: JsonValue;
  onFilterChange?: (key: string, value: JsonValue | undefined) => void;
  onDataInteraction: (payload: JsonValue) => void;
  onAnimationStart: () => void;
  onAnimationEnd: () => void;
}) {
  if (widget.semanticBinding && (!metric?.semanticWidget || metric.semanticError)) return <div className="dashboard-data-binding-state" role={metric?.semanticError ? "alert" : "status"}>{metric?.semanticError ?? tr(locale, "正在读取语义数据…", "Loading semantic data…")}</div>;
  widget = metric?.semanticWidget ?? widget;
  const analysis = analyzeDashboardMetric(widget, metric);
  const display = analysis.value === undefined ? "—" : typeof analysis.value === "object" ? JSON.stringify(analysis.value) : String(analysis.value);
  const valueStyle = conditionalStyle(widget.conditionalRules, analysis.rows[0] ?? {}, analysis.value);
  if (widget.type === "text")
    return (
      <div className="dashboard-text-widget" style={{ color: widget.textColor, fontSize: widget.fontSize, fontWeight: widget.fontWeight, textAlign: widget.textAlign }}>
        {widget.content || widget.title}
      </div>
    );
  if (widget.type === "shape")
    return (
      <div
        className={`dashboard-shape-widget ${widget.shape ?? "rectangle"}`}
        style={{ background: widget.color, borderColor: widget.borderColor, borderWidth: widget.borderWidth }}
      >
        <span>{widget.content}</span>
      </div>
    );
  if (widget.type === "decoration")
    return (
      <div className={`dashboard-decoration-widget ${widget.decorationStyle ?? "title"}`} style={{ color: widget.color }}>
        <i />
        <strong>{widget.content || widget.title}</strong>
        <i />
      </div>
    );
  if (compact && widget.designState && widget.designState !== "auto") return <DashboardDesignState locale={locale} state={widget.designState} />;
  if (widget.type === "image")
    return (
      <div className="dashboard-image-widget">
        <DashboardImage widget={widget} locale={locale} />
      </div>
    );
  if (widget.type === "video")
    return (
      <div className="dashboard-video-widget">
        <DashboardVideo widget={widget} locale={locale} compact={compact} />
      </div>
    );
  if (widget.type === "monitor")
    return (
      <div className={`dashboard-monitor-widget ${compact ? "editing" : ""}`}>
        <DashboardMonitor widget={widget} locale={locale} compact={compact} />
      </div>
    );
  if (widget.type === "url") {
    const url = embeddableUrl(widget.url);
    return (
      <div className={`dashboard-webpage ${compact ? "editing" : ""}`}>
        {url ? (
          <iframe src={url} title={widget.title || tr(locale, "嵌入网页", "Embedded web page")} loading="lazy" allow="fullscreen; autoplay; clipboard-read; clipboard-write" />
        ) : (
          <div>
            <Globe2 size={22} />
            <strong>{widget.title}</strong>
            <span>{tr(locale, "编辑组件并填写 HTTP(S) 或站内网页地址", "Edit the widget and enter an HTTP(S) or local URL")}</span>
          </div>
        )}
        {compact && <i>{tr(locale, "编辑模式下网页交互已暂停", "Web page interaction is paused while editing")}</i>}
      </div>
    );
  }
  if (widget.type === "digital-flip")
    return <DashboardDigitalFlip widget={widget} analysis={analysis} compact={compact} onActivate={() => onDataInteraction({ value: jsonValue(analysis.value) })} />;
  if (widget.type === "liquid-fill")
    return <DashboardLiquidFill locale={locale} widget={widget} analysis={analysis} compact={compact} onActivate={() => onDataInteraction({ value: jsonValue(analysis.value) })} />;
  if (["line", "area", "bar", "combo", "pie", "scatter", "radar", "funnel", "gauge", "sankey", "sunburst", "treemap", "graph", "map", "wordcloud", "boxplot", "waterfall", "polarBar"].includes(widget.type))
    return (
      <DashboardDrillChart
        widget={widget}
        metric={metric}
        analysis={analysis}
        compact={compact}
        onDataInteraction={onDataInteraction}
        onAnimationStart={onAnimationStart}
        onAnimationEnd={onAnimationEnd}
      />
    );
  if (widget.type === "progress") {
    const value = Math.max(widget.min ?? 0, Math.min(widget.max ?? 100, toFiniteNumber(analysis.value) ?? 0));
    const ratio = (value - (widget.min ?? 0)) / Math.max(1, (widget.max ?? 100) - (widget.min ?? 0));
    return (
      <div
        className={`dashboard-progress-widget ${valueStyle.animation === "pulse" ? "conditional-pulse" : ""}`}
        style={valueStyle.visible === false ? { display: "none" } : { color: valueStyle.color, backgroundColor: valueStyle.backgroundColor, fontWeight: valueStyle.fontWeight }}
      >
        <header>
          <span>{widget.title}</span>
          <strong>
            {value}
            {widget.unit}
          </strong>
        </header>
        <div>
          <i style={{ width: `${ratio * 100}%`, background: valueStyle.color ?? widget.color }} />
        </div>
      </div>
    );
  }
  if (widget.type === "filter") {
    const options = widget.options ?? [];
    const parentMissing = Boolean(widget.parentFilterKey && filters[widget.parentFilterKey] === undefined);
    const mode = widget.filterMode ?? "select";
    const selected = filterValue === undefined ? (options[0] ?? "") : String(filterValue);
    return (
      <label className="dashboard-filter-widget">
        <span>
          {widget.title}
          {widget.filterField && <small>{widget.filterField}</small>}
        </span>
        {mode === "multi-select" ? (
          <select
            multiple
            disabled={compact || parentMissing}
            value={Array.isArray(filterValue) ? filterValue.map(String) : []}
            onChange={(event) => {
              const values = Array.from(event.currentTarget.selectedOptions)
                .map((option) => option.value)
                .filter((value) => !/^(全部|all)$/i.test(value));
              onFilterChange?.(widget.key, values.length > 0 ? values : undefined);
            }}
          >
            {options.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        ) : mode === "text" || mode === "date" ? (
          <input
            type={mode === "date" ? "date" : "text"}
            disabled={compact || parentMissing}
            value={filterValue === undefined || filterValue === null ? "" : String(filterValue)}
            placeholder={mode === "text" ? tr(locale, "输入筛选值", "Enter filter value") : undefined}
            onChange={(event) => onFilterChange?.(widget.key, event.target.value || undefined)}
          />
        ) : (
          <select
            disabled={compact || parentMissing}
            value={selected}
            onChange={(event) => {
              const value = event.target.value;
              onFilterChange?.(widget.key, value === options[0] && /^(全部|all)$/i.test(value) ? undefined : value);
            }}
          >
            {options.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        )}
        {parentMissing && <em>{tr(locale, "请先选择上级条件", "Select the parent filter first")}</em>}
      </label>
    );
  }
  if (widget.type === "rank")
    return (
      <div className="dashboard-rank-widget">
        <strong>{widget.title}</strong>
        {analysis.rows.slice(0, 6).map((row, index) => {
          const value = widget.field ? row[widget.field] : Object.values(row)[0];
          const style = conditionalStyle(widget.conditionalRules, row, value);
          return (
            <div
              className={style.animation === "pulse" ? "conditional-pulse" : ""}
              style={style.visible === false ? { display: "none" } : { color: style.color, backgroundColor: style.backgroundColor, fontWeight: style.fontWeight }}
              key={index}
              onClick={() => {
                if (!compact) onDataInteraction({ data: jsonRecord(row), index });
              }}
            >
              <em>{index + 1}</em>
              <span>{String(row.name ?? row.label ?? row.device ?? `#${index + 1}`)}</span>
              <b>{String(value ?? "—")}</b>
            </div>
          );
        })}
      </div>
    );
  if (widget.type === "table" && metric?.rows?.length === 0) return <DashboardDesignState locale={locale} state="empty" />;
  if (widget.type === "table") return <DashboardReportTable locale={locale} widget={widget} metric={metric} compact={compact} onDataInteraction={onDataInteraction} />;
  if (widget.type === "scroll-table")
    return (
      <DashboardScrollTable
        locale={locale}
        widget={widget}
        metric={metric}
        compact={compact}
        onRowInteraction={(row, index) => onDataInteraction({ data: jsonRecord(row), index })}
      />
    );
  if (widget.type === "status") {
    const signal=resolveDeviceSignal(analysis.value,widget.signalRule);
    const target=signal.target;
    return valueStyle.visible === false ? null : <DeviceSignalView locale={locale} title={widget.title} signal={signal}
      {...(!compact && projectId && target ? {onLocate:()=>publishLocalSceneData({source:"dashboard",key:`${widget.key}:locate`,value:true,sceneId:target.sceneId,target:{modelId:target.modelId,...(target.layerId?{layerId:target.layerId}:{})},action:"focus",timestamp:new Date().toISOString()},projectId)}:{})} />;
  }
  return (
    <div
      className={`dashboard-value ${valueStyle.animation === "pulse" ? "conditional-pulse" : ""}`}
      data-dashboard-capture="value"
      data-capture-background=""
      style={valueStyle.visible === false ? { display: "none" } : { color: valueStyle.color, backgroundColor: valueStyle.backgroundColor, fontWeight: valueStyle.fontWeight }}
    >
      <span data-capture-role="title">{widget.title}</span>
      <strong data-capture-role="value" title={typeof analysis.value === "number" && Number.isFinite(analysis.value) ? String(analysis.value) : undefined}>
        {formatDashboardMetricDisplay(analysis.value, widget, locale)}
        <small data-capture-role="unit">{widget.unit}</small>
      </strong>
    </div>
  );
}

function updateMetricMap(current: Record<string, DashboardMetric>, source: string | undefined, key: string, value: unknown, time: number): Record<string, DashboardMetric> {
  const next = { ...current };
  for (const metricKey of [key, source ? `${source}.${key}` : ""].filter(Boolean)) {
    const numeric = toFiniteNumber(value);
    const previous = current[metricKey];
    next[metricKey] = { value, samples: numeric === undefined ? (previous?.samples ?? []) : [...(previous?.samples ?? []), { time, value: numeric }].slice(-60) };
  }
  return next;
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
