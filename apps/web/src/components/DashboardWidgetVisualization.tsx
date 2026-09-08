import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AlertTriangle, Ban, DatabaseZap, LoaderCircle } from "lucide-react";
import type { EChartsType } from "echarts/core";
import type { DashboardDataWidgetConfig, JsonValue } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import {
  analyzeDashboardMetric,
  buildDashboardReport,
  conditionalStyle,
  formatDashboardReportValue,
  sortDashboardReportRows,
  type DashboardAnalysisResult,
} from "./dashboardAnalytics";
import type { DashboardMetric } from "./DashboardWidgetRuntime";
import { DashboardReportExport } from "./DashboardReportExport";
import { dashboardReadableChartOptions, readDashboardChartPalette } from "./dashboardReadableChartOptions";
import {
  dashboardColorWithOpacity as colorWithOpacity,
  dashboardJsonRecord as jsonRecord,
  dashboardJsonValue as jsonValue,
  finiteDashboardNumber as toFiniteNumber,
} from "./dashboardWidgetValues";

export function DashboardDrillChart({
  widget,
  metric,
  analysis: baseAnalysis,
  compact,
  onDataInteraction,
  onAnimationStart,
  onAnimationEnd,
}: {
  widget: DashboardDataWidgetConfig;
  metric: DashboardMetric | undefined;
  analysis: DashboardAnalysisResult;
  compact: boolean;
  onDataInteraction: (payload: JsonValue) => void;
  onAnimationStart: () => void;
  onAnimationEnd: () => void;
}) {
  const fields = widget.analysis?.drillFields?.filter(Boolean) ?? [];
  const [trail, setTrail] = useState<Array<{ field: string; value: string }>>([]);
  useEffect(() => {
    setTrail([]);
  }, [fields.join("\u0000")]);
  const level = Math.min(trail.length, Math.max(0, fields.length - 1));
  const filteredRows = filterDashboardDrillRows(metric?.rows ?? [], trail);
  const drillMetric = metric && fields.length > 0 ? { ...metric, rows: filteredRows } : metric;
  const drillWidget: DashboardDataWidgetConfig = fields.length > 0 && widget.analysis ? { ...widget, analysis: { ...widget.analysis, dimensionField: fields[level]! } } : widget;
  const analysis = fields.length > 0 ? analyzeDashboardMetric(drillWidget, drillMetric) : baseAnalysis;
  const canDrill = !compact && fields.length > 1 && level < fields.length - 1;
  function handleInteraction(payload: JsonValue) {
    onDataInteraction(widget.semanticBinding && payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload, semanticField: fields[level] ?? widget.analysis?.dimensionField ?? "", semanticPath: [...trail, { field: fields[level] ?? widget.analysis?.dimensionField ?? "", value: dashboardLinkageValue(payload) ?? null }] } : payload);
    const value = dashboardLinkageValue(payload);
    if (canDrill && (typeof value === "string" || typeof value === "number")) setTrail((current) => [...current, { field: fields[level]!, value: String(value) }]);
  }
  function navigateTrail(next: typeof trail) {
    setTrail(next);
    if (widget.semanticBinding) onDataInteraction({ name: next.at(-1)?.value ?? "", semanticField: next.at(-1)?.field ?? fields[0] ?? "", semanticPath: next });
  }
  return (
    <div className="dashboard-drill-chart">
      {widget.fontSize && <header className="dashboard-chart-heading">
        <strong title={widget.title}>{widget.title}</strong>
        {widget.unit && <span>{widget.unit}</span>}
      </header>}
      <DashboardChart
        widget={drillWidget}
        metric={drillMetric}
        analysis={analysis}
        compact={compact}
        onDataInteraction={handleInteraction}
        onAnimationStart={onAnimationStart}
        onAnimationEnd={onAnimationEnd}
      />
      {(fields.length > 1 || widget.semanticBinding) && !compact && (
        <nav aria-label="钻取路径">
          <button
            aria-label="返回上一级"
            disabled={trail.length === 0}
            onClick={(event) => {
              event.stopPropagation();
              navigateTrail(trail.slice(0, -1));
            }}
          >
            ‹
          </button>
          <button
            aria-label={widget.semanticBinding ? "清除联动条件" : undefined}
            className={trail.length === 0 ? "active" : ""}
            onClick={(event) => {
              event.stopPropagation();
              navigateTrail([]);
            }}
          >
            {fields[0]}
          </button>
          {trail.map((item, index) => (
            <button
              className={index === trail.length - 1 ? "active" : ""}
              key={`${item.field}:${item.value}:${index}`}
              onClick={(event) => {
                event.stopPropagation();
                navigateTrail(trail.slice(0, index + 1));
              }}
            >
              {item.value}
            </button>
          ))}
          <small>{fields[level]}</small>
        </nav>
      )}
    </div>
  );
}

export function filterDashboardDrillRows(rows: Array<Record<string, unknown>>, trail: readonly { field: string; value: string }[]): Array<Record<string, unknown>> {
  return trail.length === 0 ? rows : rows.filter((row) => trail.every((item) => String(readDashboardPath(row, item.field) ?? "") === item.value));
}

function readDashboardPath(row: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, segment) => (current && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined), row);
}

export interface DashboardHierarchyNode {
  name: string;
  value: number;
  children?: DashboardHierarchyNode[];
}

export function buildDashboardHierarchy(rows: readonly Record<string, unknown>[], fields: readonly string[], valueField: string): DashboardHierarchyNode[] {
  if (fields.length === 0 || rows.length === 0) return [];
  const roots: DashboardHierarchyNode[] = [];
  for (const row of rows) {
    const path = fields.map((field) => readDashboardPath(row, field)).filter((value) => value !== undefined && value !== null && String(value).trim());
    if (path.length === 0) continue;
    const value = toFiniteNumber(readDashboardPath(row, valueField)) ?? 1;
    let level = roots;
    for (let index = 0; index < path.length; index++) {
      const name = String(path[index]);
      let node = level.find((candidate) => candidate.name === name);
      if (!node) {
        node = { name, value: 0 };
        level.push(node);
      }
      node.value += value;
      if (index < path.length - 1) {
        node.children ??= [];
        level = node.children;
      }
    }
  }
  return roots;
}

export function DashboardReportTable({
  locale,
  widget,
  metric,
  compact,
  onDataInteraction,
}: {
  locale: AppLocale;
  widget: DashboardDataWidgetConfig;
  metric: DashboardMetric | undefined;
  compact: boolean;
  onDataInteraction: (payload: JsonValue) => void;
}) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ column: string; direction: "asc" | "desc" }>();
  const report = buildDashboardReport(widget, metric);
  const pageSize = Math.max(1, widget.report?.pageSize ?? 8);
  const pageCount = Math.max(1, Math.ceil(report.rows.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const sortedRows = sort ? sortDashboardReportRows(report.rows, sort.column, sort.direction) : report.rows;
  const visibleRows = sortedRows.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const rowNumberOffset = safePage * pageSize;
  const tableClass = [
    widget.report?.freezeFirstColumn ? "freeze-first-column" : "",
    widget.report?.showRowNumbers ? "has-row-numbers" : "",
    widget.report?.stripedRows ? "striped" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="dashboard-mini-table dashboard-report-table">
      <header>
        <strong>{widget.title}</strong>
        {!compact && <DashboardReportExport report={{ ...report, rows: sortedRows }} title={widget.title} locale={locale} />}
      </header>
      <div className="dashboard-report-scroll">
        <table className={tableClass}>
          <thead>
            <tr>
              {widget.report?.showRowNumbers && <th className="report-row-number">#</th>}
              {report.columns.map((column) => (
                <th key={column}>
                  <button
                    title={tr(locale, "点击排序", "Click to sort")}
                    onClick={(event) => {
                      event.stopPropagation();
                      setPage(0);
                      setSort((current) => (current?.column === column ? { column, direction: current.direction === "asc" ? "desc" : "asc" } : { column, direction: "asc" }));
                    }}
                  >
                    {column}
                    <i>{sort?.column === column ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</i>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => {
              const style = conditionalStyle(widget.conditionalRules, row);
              return (
                <tr
                  key={index}
                  className={style.animation === "pulse" ? "conditional-pulse" : ""}
                  style={style.visible === false ? { display: "none" } : { color: style.color, backgroundColor: style.backgroundColor, fontWeight: style.fontWeight }}
                  onClick={() => {
                    if (!compact) onDataInteraction({ data: jsonRecord(row), index: rowNumberOffset + index });
                  }}
                >
                  {widget.report?.showRowNumbers && <td className="report-row-number">{rowNumberOffset + index + 1}</td>}
                  {report.columns.map((column) => (
                    <td key={column}>{formatDashboardReportValue(row[column], widget, locale)}</td>
                  ))}
                </tr>
              );
            })}
            {report.grandTotal && (
              <tr className="dashboard-report-total">
                {widget.report?.showRowNumbers && <td className="report-row-number" />}
                {report.columns.map((column, index) => (
                  <td key={column}>{index === 0 ? tr(locale, "总计", "Total") : formatDashboardReportValue(report.grandTotal?.[column], widget, locale)}</td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <footer>
          <button
            disabled={safePage === 0}
            onClick={(event) => {
              event.stopPropagation();
              setPage(Math.max(0, safePage - 1));
            }}
          >
            ‹
          </button>
          <span>
            {safePage + 1} / {pageCount}
          </span>
          <button
            disabled={safePage >= pageCount - 1}
            onClick={(event) => {
              event.stopPropagation();
              setPage(Math.min(pageCount - 1, safePage + 1));
            }}
          >
            ›
          </button>
        </footer>
      )}
    </div>
  );
}

export function applyDashboardFilters(
  rows: Array<Record<string, unknown>>,
  filters: Readonly<Record<string, JsonValue>>,
  widgets: readonly DashboardDataWidgetConfig[],
): Array<Record<string, unknown>> {
  const active = widgets
    .filter((widget) => widget.type === "filter")
    .flatMap((widget) => {
      const value = filters[widget.key];
      if (widget.parentFilterKey) {
        const parentValue = filters[widget.parentFilterKey];
        if (parentValue === undefined || parentValue === null || parentValue === "" || /^(全部|all)$/i.test(String(parentValue))) return [];
      }
      if (value === undefined || value === null || value === "" || /^(全部|all)$/i.test(String(value))) return [];
      return [{ field: widget.filterField?.trim() || widget.key, value, match: widget.filterMatch ?? (widget.filterMode === "text" ? "contains" : "exact") }];
    });
  if (active.length === 0) return rows;
  return rows.filter((row) =>
    active.every(({ field, value, match }) => {
      if (!(field in row)) return true;
      const candidate = String(row[field] ?? "");
      if (Array.isArray(value)) return value.some((item) => candidate === String(item));
      return match === "contains" ? candidate.toLocaleLowerCase().includes(String(value).toLocaleLowerCase()) : candidate === String(value);
    }),
  );
}

export function dashboardLinkageValue(payload: JsonValue): JsonValue | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload ?? undefined;
  if (typeof payload.name === "string" && payload.name) return payload.name;
  if (payload.value !== undefined && payload.value !== null) return payload.value;
  return payload.data ?? undefined;
}

export function DashboardDesignState({ locale, state }: { locale: AppLocale; state: Exclude<NonNullable<DashboardDataWidgetConfig["designState"]>, "auto"> }) {
  const content = {
    empty: [<DatabaseZap size={20} />, tr(locale, "暂无数据", "No data")],
    loading: [<LoaderCircle className="spin" size={20} />, tr(locale, "数据加载中", "Loading data")],
    partial: [<AlertTriangle size={20} />, tr(locale, "部分数据可用", "Partial data")],
    error: [<AlertTriangle size={20} />, tr(locale, "数据错误", "Data error")],
    forbidden: [<Ban size={20} />, tr(locale, "无权查看", "No permission")],
  }[state];
  return content ? (
    <div className={`dashboard-design-state ${state}`}>
      {content[0]}
      <span>{content[1]}</span>
    </div>
  ) : null;
}

export function widgetBackground(widget: DashboardDataWidgetConfig): string {
  return colorWithOpacity(widget.backgroundColor ?? "#172126", widget.backgroundOpacity ?? 0.86);
}

export function widgetBackgroundStyle(widget: DashboardDataWidgetConfig): CSSProperties {
  const fit = widget.componentBackgroundImageFit ?? "cover";
  return {
    backgroundColor: widgetBackground(widget),
    ...(widget.componentBackgroundImageUrl
      ? {
          backgroundImage: `url(${JSON.stringify(widget.componentBackgroundImageUrl)})`,
          backgroundSize: fit === "stretch" ? "100% 100%" : fit === "original" ? "auto" : fit,
          backgroundPosition: widget.componentBackgroundImagePosition ?? "center",
          backgroundRepeat: widget.componentBackgroundImageRepeat ? "repeat" : "no-repeat",
        }
      : {}),
  };
}

function DashboardChart({
  widget,
  metric,
  analysis,
  compact,
  onDataInteraction,
  onAnimationStart,
  onAnimationEnd,
}: {
  widget: DashboardDataWidgetConfig;
  metric: DashboardMetric | undefined;
  analysis: DashboardAnalysisResult;
  compact: boolean;
  onDataInteraction: (payload: JsonValue) => void;
  onAnimationStart: () => void;
  onAnimationEnd: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [geoJson, setGeoJson] = useState<unknown>();
  useEffect(() => {
    if (widget.type !== "map" || !widget.map?.geoJsonUrl) {
      setGeoJson(undefined);
      return;
    }
    let cancelled = false;
    void api
      .getExternalJson(widget.map.geoJsonUrl)
      .then((value) => {
        if (!cancelled) setGeoJson(value);
      })
      .catch(() => {
        if (!cancelled) setGeoJson(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [widget.map?.geoJsonUrl, widget.type]);
  useEffect(() => {
    if (!ref.current) return;
    const element = ref.current;
    let disposed = false;
    let resize: ResizeObserver | undefined;
    void Promise.all([import("echarts/core"), import("echarts/charts"), import("echarts/components"), import("echarts/renderers")]).then(
      ([echarts, charts, components, renderers]) => {
        if (disposed) return;
        echarts.use([
          charts.BarChart,
          charts.GaugeChart,
          charts.LineChart,
          charts.PieChart,
          charts.ScatterChart,
          charts.EffectScatterChart,
          charts.RadarChart,
          charts.FunnelChart,
          charts.SankeyChart,
          charts.SunburstChart,
          charts.TreemapChart,
          charts.GraphChart,
          charts.MapChart,
          components.GridComponent,
          components.GeoComponent,
          components.VisualMapComponent,
          components.RadarComponent,
          components.TooltipComponent,
          components.LegendComponent,
          renderers.CanvasRenderer,
        ]);
        const chart = echarts.init(element, undefined, { renderer: "canvas" });
        chartRef.current = chart;
        resize = new ResizeObserver(() => chart.resize());
        resize.observe(element);
        setReady(true);
      },
    );
    return () => {
      disposed = true;
      resize?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = undefined;
    };
  }, []);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || compact) return;
    const handle = (raw: unknown) => {
      const params = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      onDataInteraction({ name: String(params.name ?? ""), value: jsonValue(params.value), index: Number(params.dataIndex ?? -1), data: jsonValue(params.data) });
    };
    chart.on("click", handle);
    return () => {
      chart.off("click", handle);
    };
  }, [compact, onDataInteraction, ready]);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const color = widget.color ?? "#d4a84f";
    const samples = metric?.samples ?? [];
    const categories = analysis.categories.length ? analysis.categories : samples.map((_, index) => String(index + 1));
    const seriesValues = analysis.series.length ? analysis.series : [{ name: widget.title, values: samples.map((sample) => sample.value) }];
    if (!compact) {
      onAnimationStart();
      chart.off("finished");
      const finish = () => {
        chart.off("finished", finish);
        onAnimationEnd();
      };
      chart.on("finished", finish);
    }
    const readableOption = ref.current && dashboardReadableChartOptions(widget, categories, seriesValues, readDashboardChartPalette(ref.current), compact);
    if (readableOption) { chart.setOption(readableOption, true); return; }
    if (widget.type === "gauge") {
      chart.setOption(
        {
          animation: !compact,
          series: [
            {
              type: "gauge",
              min: widget.min ?? 0,
              max: widget.max ?? 100,
              radius: "83%",
              progress: { show: true, width: 8, itemStyle: { color } },
              axisLine: { lineStyle: { width: 8, color: [[1, "#2b353a"]] } },
              axisTick: { show: false },
              splitLine: { show: false },
              axisLabel: { show: false },
              pointer: { show: false },
              anchor: { show: false },
              title: { offsetCenter: [0, "62%"], color: "#77858c", fontSize: 9 },
              detail: { valueAnimation: !compact, offsetCenter: [0, "2%"], color: "#eef2f4", fontSize: 19, formatter: `{value}${widget.unit}` },
              data: [{ value: toFiniteNumber(metric?.value) ?? 0, name: widget.title }],
            },
          ],
        },
        true,
      );
      return;
    }
    if (widget.type === "pie") {
      chart.setOption(
        {
          animation: !compact,
          tooltip: { trigger: "item" },
          series: [
            {
              type: "pie",
              radius: ["48%", "72%"],
              label: { show: false },
              data: categories.slice(-20).map((name, index) => ({ name, value: seriesValues[0]?.values[index] ?? 0 })),
              itemStyle: { borderColor: "#172126", borderWidth: 2 },
            },
          ],
        },
        true,
      );
      return;
    }
    if (widget.type === "radar") {
      const values = samples.slice(-6).map((sample) => sample.value);
      chart.setOption(
        {
          animation: !compact,
          tooltip: {},
          radar: {
            indicator: values.map((_, index) => ({ name: String(index + 1), max: Math.max(100, ...values) })),
            splitLine: { lineStyle: { color: "#344149" } },
            splitArea: { areaStyle: { color: ["transparent", "rgba(52,65,73,.18)"] } },
            axisName: { color: "#7d8b91", fontSize: 8 },
          },
          series: [{ type: "radar", data: [{ value: values }], lineStyle: { color }, itemStyle: { color }, areaStyle: { color, opacity: 0.22 } }],
        },
        true,
      );
      return;
    }
    if (widget.type === "funnel") {
      chart.setOption(
        {
          animation: !compact,
          tooltip: { trigger: "item" },
          series: [
            {
              type: "funnel",
              left: "12%",
              width: "76%",
              top: 12,
              bottom: 8,
              label: { color: "#a9b5ba", fontSize: 8 },
              data: samples.slice(-6).map((sample, index) => ({ name: String(index + 1), value: sample.value })),
            },
          ],
        },
        true,
      );
      return;
    }
    if (widget.type === "scatter") {
      chart.setOption(
        {
          animation: !compact,
          grid: { top: 12, right: 12, bottom: 20, left: 34 },
          tooltip: { trigger: "item" },
          xAxis: { axisLabel: { color: "#657279", fontSize: 7 }, splitLine: { lineStyle: { color: "#252e33" } } },
          yAxis: { axisLabel: { color: "#657279", fontSize: 7 }, splitLine: { lineStyle: { color: "#252e33" } } },
          series: [{ type: "scatter", symbolSize: 8, itemStyle: { color }, data: samples.map((sample, index) => [index, sample.value]) }],
        },
        true,
      );
      return;
    }
    if (widget.type === "map") {
      const mapName = widget.map?.mapName || "studio-custom-map";
      if (!geoJson) {
        chart.setOption(
          {
            animation: false,
            title: {
              text: widget.map?.geoJsonUrl ? "GeoJSON 加载中…" : "请配置 GeoJSON",
              left: "center",
              top: "center",
              textStyle: { color: "#81939b", fontSize: 10, fontWeight: "normal" },
            },
            series: [],
          },
          true,
        );
        return;
      }
      const chartApi = chart as unknown as { __studioMapRegistered?: string };
      if (chartApi.__studioMapRegistered !== mapName) {
        // ECharts keeps registerMap on the core namespace; the chart instance does not.
        // The dynamic import below is intentionally local to keep map support lazy.
        void import("echarts/core").then((core) => {
          core.registerMap(mapName, geoJson as never);
          chartApi.__studioMapRegistered = mapName;
          chart.setOption({ series: [{ type: "map", map: mapName, data: [] }] });
        });
      }
      const regionField = widget.map?.regionField || widget.analysis?.dimensionField || "name";
      const valueField = widget.map?.valueField || widget.analysis?.measureField || widget.field || "value";
      chart.setOption(
        {
          animation: !compact,
          tooltip: { trigger: "item" },
          visualMap: {
            min: 0,
            max: Math.max(1, ...analysis.rows.map((row) => toFiniteNumber(row[valueField]) ?? 0)),
            left: "left",
            bottom: 6,
            textStyle: { color: "#a7b5ba", fontSize: 8 },
          },
          series: [
            {
              type: "map",
              map: mapName,
              roam: true,
              label: { show: false },
              data: analysis.rows.flatMap((row) => (row[regionField] === undefined ? [] : [{ name: String(row[regionField]), value: toFiniteNumber(row[valueField]) ?? 0 }])),
            },
          ],
        },
        true,
      );
      return;
    }
    if (widget.type === "sunburst" || widget.type === "treemap") {
      const hierarchyFields = widget.analysis?.drillFields?.filter(Boolean).length
        ? widget.analysis.drillFields.filter(Boolean)
        : [widget.analysis?.dimensionField].filter((field): field is string => Boolean(field));
      const hierarchy = buildDashboardHierarchy(metric?.rows ?? analysis.rows, hierarchyFields, widget.analysis?.measureField ?? widget.field ?? "value");
      const data = hierarchy.length > 0 ? hierarchy : categories.map((name, index) => ({ name, value: seriesValues[0]?.values[index] ?? 0 }));
      chart.setOption(
        {
          animation: !compact,
          tooltip: { trigger: "item" },
          series: [{ type: widget.type, radius: widget.type === "sunburst" ? ["15%", "88%"] : undefined, data, label: { color: "#d9e1e4", fontSize: 9 } }],
        },
        true,
      );
      return;
    }
    if (widget.type === "sankey" || widget.type === "graph") {
      const sourceField = widget.analysis?.dimensionField ?? "source";
      const targetField = widget.analysis?.seriesField ?? "target";
      const valueField = widget.analysis?.measureField ?? widget.field ?? "value";
      const links = analysis.rows.flatMap((row) =>
        row[sourceField] !== undefined && row[targetField] !== undefined
          ? [{ source: String(row[sourceField]), target: String(row[targetField]), value: toFiniteNumber(row[valueField]) ?? 1 }]
          : [],
      );
      const nodes = [...new Set(links.flatMap((link) => [link.source, link.target]))].map((name) => ({ name }));
      chart.setOption(
        {
          animation: !compact,
          tooltip: { trigger: "item" },
          series: [
            {
              type: widget.type,
              data: nodes,
              links,
              roam: widget.type === "graph",
              layout: widget.type === "graph" ? "force" : undefined,
              emphasis: { focus: "adjacency" },
              lineStyle: { color: "gradient", opacity: 0.55 },
              label: { color: "#d9e1e4", fontSize: 8 },
            },
          ],
        },
        true,
      );
      return;
    }
    const palette = [color, "#4e9fd1", "#62b88f", "#d8785f", "#9a7bd1", "#d6c35c"];
    const secondaryNames = new Set(widget.chart?.secondaryAxisSeries?.map((name) => name.trim()).filter(Boolean) ?? []);
    const comboFallbackIndex = widget.type === "combo" ? Math.max(0, seriesValues.length - 1) : -1;
    const hasSecondaryAxis = widget.type === "combo";
    chart.setOption(
      {
        animation: !compact,
        color: palette,
        legend: widget.chart?.showLegend ? { top: 2, right: 8, textStyle: { color: "#8c9ba1", fontSize: 8 } } : undefined,
        grid: { top: widget.chart?.showLegend ? 31 : 25, right: hasSecondaryAxis ? 38 : 8, bottom: 18, left: 36 },
        tooltip: { trigger: "axis", backgroundColor: "#171d20", borderColor: "#39464d", textStyle: { color: "#d9dfe2", fontSize: 9 } },
        xAxis: {
          type: "category",
          data: categories,
          axisLabel: { color: "#657279", fontSize: 7, showMaxLabel: true },
          axisLine: { lineStyle: { color: "#303b40" } },
          axisTick: { show: false },
        },
        yAxis: hasSecondaryAxis
          ? [
              { type: "value", axisLabel: { color: "#657279", fontSize: 7 }, splitLine: { lineStyle: { color: "#252e33" } } },
              { type: "value", axisLabel: { color: "#657279", fontSize: 7 }, splitLine: { show: false } },
            ]
          : { type: "value", axisLabel: { color: "#657279", fontSize: 7 }, splitLine: { lineStyle: { color: "#252e33" } } },
        series: seriesValues.map((item, index) => {
          const comboLine = widget.type === "combo" && (secondaryNames.size > 0 ? secondaryNames.has(item.name) : index === comboFallbackIndex);
          const seriesType = comboLine || widget.type === "line" || widget.type === "area" ? "line" : "bar";
          const seriesColor = palette[index % palette.length];
          return {
            name: item.name,
            type: seriesType,
            yAxisIndex: comboLine ? 1 : 0,
            data: item.values,
            stack: widget.chart?.stacked && !comboLine ? "total" : undefined,
            smooth: seriesType === "line",
            showSymbol: false,
            label: { show: widget.chart?.showDataLabels ?? false, position: seriesType === "bar" ? "top" : "top", color: "#aebbc0", fontSize: 8 },
            itemStyle: { color: seriesColor },
            lineStyle: { color: seriesColor, width: 2 },
            areaStyle: widget.type === "area" ? { color: seriesColor, opacity: 0.28 } : undefined,
          };
        }),
      },
      true,
    );
  }, [analysis, compact, geoJson, metric, onAnimationEnd, onAnimationStart, ready, widget]);
  return <div className="dashboard-chart" ref={ref} />;
}
