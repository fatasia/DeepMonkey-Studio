import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Ban, Cctv, DatabaseZap, Globe2, Image as ImageIcon, LoaderCircle, Video } from "lucide-react";
import type { EChartsType } from "echarts/core";
import type { DashboardDataWidgetConfig, DataDatasetPreview, DataDatasetRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { subscribeSceneData } from "../sceneDataBridge";

interface MetricSample { time: number; value: number; }
export interface DashboardMetric { value: unknown; samples: MetricSample[]; rows?: Array<Record<string, unknown>>; }

export function useDashboardMetrics(projectId: string, widgets: readonly DashboardDataWidgetConfig[], sceneId?: string) {
  const [metrics, setMetrics] = useState<Record<string, DashboardMetric>>({});
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.listDatasets(projectId).then((items) => { if (!cancelled) setDatasets(items); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    const ids = [...new Set(widgets.map((widget) => widget.datasetId).filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return;
    let cancelled = false;
    const refresh = async () => {
      const previews = await Promise.all(ids.map((id) => api.previewDataset(projectId, id).catch(() => undefined)));
      if (!cancelled) setMetrics((current) => previews.reduce((next, preview) => preview ? mergeDatasetMetrics(next, preview) : next, current));
    };
    void refresh();
    const seconds = Math.max(2, Math.min(...ids.map((id) => datasets.find((item) => item.id === id)?.refreshSeconds || 5)));
    const timer = window.setInterval(() => void refresh(), seconds * 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [datasets, projectId, widgets]);

  useEffect(() => subscribeSceneData((message) => {
    if (sceneId && message.sceneId && message.sceneId !== sceneId) return;
    setMetrics((current) => updateMetricMap(current, message.source, message.key || "value", message.value, Date.parse(message.timestamp) || Date.now()));
  }, (status) => setConnected(status === "online")), [sceneId]);

  return { metrics, datasets, connected } as const;
}

export function DashboardWidgetView({ locale, widget, metric, compact, onAnimationStart, onAnimationEnd }: {
  locale: AppLocale;
  widget: DashboardDataWidgetConfig;
  metric: DashboardMetric | undefined;
  compact: boolean;
  onAnimationStart: () => void;
  onAnimationEnd: () => void;
}) {
  const display = metric?.value === undefined ? "—" : typeof metric.value === "object" ? JSON.stringify(metric.value) : String(metric.value);
  if (widget.type === "text") return <div className="dashboard-text-widget" style={{ color: widget.textColor, fontSize: widget.fontSize, fontWeight: widget.fontWeight, textAlign: widget.textAlign }}>{widget.content || widget.title}</div>;
  if (widget.type === "shape") return <div className={`dashboard-shape-widget ${widget.shape ?? "rectangle"}`} style={{ background: widget.color, borderColor: widget.borderColor, borderWidth: widget.borderWidth }}><span>{widget.content}</span></div>;
  if (compact && widget.designState && widget.designState !== "auto") return <DashboardDesignState locale={locale} state={widget.designState} />;
  if (widget.type === "image") return <div className="dashboard-image-widget">{widget.imageUrl ? <img src={widget.imageUrl} alt={widget.title} style={{ objectFit: widget.imageFit ?? "cover" }} /> : <div><ImageIcon size={22} /><span>{tr(locale, "从资源库选择图片", "Choose an image from assets")}</span></div>}</div>;
  if (widget.type === "video") return <div className="dashboard-video-widget">{widget.videoUrl ? <StreamVideo src={widget.videoUrl} fit={widget.videoFit ?? "contain"} autoplay={widget.videoAutoplay !== false} muted={widget.videoMuted !== false} controls /> : <div><Video size={23} /><span>{tr(locale, "从资源库选择本地视频", "Choose a local video from assets")}</span></div>}</div>;
  if (widget.type === "monitor") {
    if (widget.monitorProtocol === "webrtc") return <div className={`dashboard-monitor-widget ${compact ? "editing" : ""}`}>{widget.videoUrl ? <iframe src={embeddableUrl(widget.videoUrl)} title={widget.title} allow="autoplay; fullscreen" /> : <div><Cctv size={23} /><span>{tr(locale, "填写监控地址并应用", "Enter a monitor source and apply")}</span></div>}{compact && <i>{tr(locale, "编辑时已暂停画面交互", "Interaction paused while editing")}</i>}</div>;
    return <div className="dashboard-monitor-widget">{widget.videoUrl ? <StreamVideo src={widget.videoUrl} fit={widget.videoFit ?? "cover"} autoplay={widget.videoAutoplay !== false} muted={widget.videoMuted !== false} controls={!compact} /> : <div><Cctv size={23} /><span>{tr(locale, "填写监控地址并应用", "Enter a monitor source and apply")}</span></div>}</div>;
  }
  if (widget.type === "url") {
    const url = embeddableUrl(widget.url);
    return <div className={`dashboard-webpage ${compact ? "editing" : ""}`}>{url ? <iframe src={url} title={widget.title || tr(locale, "嵌入网页", "Embedded web page")} loading="lazy" allow="fullscreen; autoplay; clipboard-read; clipboard-write" /> : <div><Globe2 size={22} /><strong>{widget.title}</strong><span>{tr(locale, "编辑组件并填写 HTTP(S) 或站内网页地址", "Edit the widget and enter an HTTP(S) or local URL")}</span></div>}{compact && <i>{tr(locale, "编辑模式下网页交互已暂停", "Web page interaction is paused while editing")}</i>}</div>;
  }
  if (["line", "area", "bar", "pie", "gauge"].includes(widget.type)) return <DashboardChart widget={widget} metric={metric} compact={compact} onAnimationStart={onAnimationStart} onAnimationEnd={onAnimationEnd} />;
  if (widget.type === "table") return <div className="dashboard-mini-table"><strong>{widget.title}</strong><table><tbody>{(metric?.rows ?? []).slice(0, 8).map((row, index) => <tr key={index}><td>{String(row.recorded_at ?? row.time ?? index + 1)}</td><td>{String(widget.field ? row[widget.field] ?? "—" : Object.values(row)[0] ?? "—")}</td></tr>)}</tbody></table></div>;
  if (widget.type === "status") return <div className={`dashboard-status ${Boolean(metric?.value) ? "ok" : ""}`}><i /><span><small>{widget.title}</small><strong>{display === "—" ? tr(locale, "未知", "Unknown") : display}</strong></span></div>;
  return <div className="dashboard-value"><span>{widget.title}</span><strong>{display}<small>{widget.unit}</small></strong></div>;
}

function DashboardDesignState({ locale, state }: { locale: AppLocale; state: Exclude<NonNullable<DashboardDataWidgetConfig["designState"]>, "auto"> }) {
  const content = {
    empty: [<DatabaseZap size={20} />, tr(locale, "暂无数据", "No data")],
    loading: [<LoaderCircle className="spin" size={20} />, tr(locale, "数据加载中", "Loading data")],
    partial: [<AlertTriangle size={20} />, tr(locale, "部分数据可用", "Partial data")],
    error: [<AlertTriangle size={20} />, tr(locale, "数据错误", "Data error")],
    forbidden: [<Ban size={20} />, tr(locale, "无权查看", "No permission")]
  }[state];
  return content ? <div className={`dashboard-design-state ${state}`}>{content[0]}<span>{content[1]}</span></div> : null;
}

export function widgetBackground(widget: DashboardDataWidgetConfig): string {
  return colorWithOpacity(widget.backgroundColor ?? "#172126", widget.backgroundOpacity ?? 0.86);
}

function StreamVideo({ src, fit, autoplay, muted, controls }: { src: string; fit: "cover" | "contain" | "fill"; autoplay: boolean; muted: boolean; controls: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (/\.m3u8(?:$|\?)/i.test(src)) {
      let disposed = false;
      let player: { destroy: () => void } | undefined;
      void import("hls.js").then(({ default: Hls }) => {
        if (disposed || !Hls.isSupported()) return;
        const hls = new Hls({ lowLatencyMode: true, backBufferLength: 30, maxBufferLength: 12 });
        player = hls;
        hls.loadSource(src);
        hls.attachMedia(video);
      });
      return () => { disposed = true; player?.destroy(); };
    }
    video.src = src;
    return () => { video.removeAttribute("src"); video.load(); };
  }, [src]);
  return <video ref={ref} style={{ objectFit: fit }} autoPlay={autoplay} muted={muted} controls={controls} playsInline preload="metadata" />;
}

function DashboardChart({ widget, metric, compact, onAnimationStart, onAnimationEnd }: { widget: DashboardDataWidgetConfig; metric: DashboardMetric | undefined; compact: boolean; onAnimationStart: () => void; onAnimationEnd: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | undefined>(undefined);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const element = ref.current;
    let disposed = false;
    let resize: ResizeObserver | undefined;
    void Promise.all([
      import("echarts/core"),
      import("echarts/charts"),
      import("echarts/components"),
      import("echarts/renderers")
    ]).then(([echarts, charts, components, renderers]) => {
      if (disposed) return;
      echarts.use([charts.BarChart, charts.GaugeChart, charts.LineChart, charts.PieChart, components.GridComponent, components.TooltipComponent, renderers.CanvasRenderer]);
      const chart = echarts.init(element, undefined, { renderer: "canvas" });
      chartRef.current = chart;
      resize = new ResizeObserver(() => chart.resize());
      resize.observe(element);
      setReady(true);
    });
    return () => { disposed = true; resize?.disconnect(); chartRef.current?.dispose(); chartRef.current = undefined; };
  }, []);
  useEffect(() => {
    const chart = chartRef.current;
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
  }, [compact, metric, onAnimationEnd, onAnimationStart, ready, widget]);
  return <div className="dashboard-chart" ref={ref} />;
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
