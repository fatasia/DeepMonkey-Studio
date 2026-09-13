import type { EChartsCoreOption } from "echarts/core";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";

export interface DashboardChartPalette {
  accent: string;
  text: string;
  muted: string;
  line: string;
  surface: string;
  series: string[];
  width?: number;
  /** 瀑布等增量图的变化语义色,随主题令牌联动(行业惯例:升红降绿)。 */
  rise?: string | undefined;
  fall?: string | undefined;
}

/** 新模板的显式设计字号，不重写缺省旧图表，也不改变原始聚合值。 */
export function dashboardReadableChartOptions(
  widget: DashboardDataWidgetConfig,
  categories: string[],
  values: Array<{ name: string; values: Array<number | null> }>,
  palette: DashboardChartPalette,
  compact: boolean,
): EChartsCoreOption | undefined {
  if (!widget.fontSize || !Number.isFinite(widget.fontSize) || !["bar", "line", "area", "combo", "pie"].includes(widget.type)) return undefined;
  const fontSize = widget.fontSize;
  const showLegend = widget.chart?.showLegend ?? widget.type === "pie";
  const colors = [widget.color ?? palette.accent, ...palette.series];
  const tooltip = { trigger: widget.type === "pie" ? "item" : "axis", backgroundColor: palette.surface, borderColor: palette.line, textStyle: { color: palette.text, fontSize } };
  const legend = { show: showLegend, type: "scroll", bottom: 0, left: "center", textStyle: { color: palette.text, fontSize }, itemWidth: fontSize, itemHeight: fontSize * .55 };
  if (widget.type === "pie") return {
    animation: !compact, color: colors, tooltip, legend,
    series: [{ type: "pie", radius: (palette.width ?? Infinity) < fontSize * 18 ? ["26%", "42%"] : ["36%", "58%"], center: ["50%", showLegend ? "43%" : "50%"],
      label: { show: widget.chart?.showDataLabels ?? false, color: palette.text, fontSize, formatter: dashboardPiePercentLabel },
      labelLine: { length: 12, length2: 8, lineStyle: { color: palette.muted } },
      data: categories.slice(0, 20).map((name, index) => ({ name, value: values[0]?.values[index] ?? 0 })),
      itemStyle: { borderColor: palette.surface, borderWidth: 2 },
    }],
  };
  const secondaryNames = new Set(widget.chart?.secondaryAxisSeries ?? []);
  const combo = widget.type === "combo";
  const axis = { type: "value", axisLabel: { color: palette.muted, fontSize }, splitLine: { lineStyle: { color: palette.line } } };
  return {
    animation: !compact, color: colors, tooltip, legend,
    grid: { top: fontSize * 1.2, right: fontSize, bottom: fontSize * (showLegend ? 2.4 : .8), left: fontSize * .5, containLabel: true },
    xAxis: { type: "category", data: categories, axisLabel: { color: palette.muted, fontSize, hideOverlap: true }, axisTick: { show: false }, axisLine: { lineStyle: { color: palette.line } } },
    yAxis: combo ? [axis, { ...axis, splitLine: { show: false } }] : axis,
    series: values.map((item, index) => {
      const secondary = combo && (secondaryNames.size ? secondaryNames.has(item.name) : index === values.length - 1);
      const type = secondary || ["line", "area"].includes(widget.type) ? "line" : "bar";
      return { name: item.name, type, yAxisIndex: secondary ? 1 : 0, data: item.values,
        stack: widget.chart?.stacked && !secondary ? "total" : undefined,
        showSymbol: false, smooth: type === "line",
        label: { show: widget.chart?.showDataLabels ?? false, position: "top", color: palette.text, fontSize },
        areaStyle: widget.type === "area" ? { opacity: .22 } : undefined,
      };
    }),
  };
}

export function readDashboardChartPalette(element: HTMLElement): DashboardChartPalette {
  const style = getComputedStyle(element);
  const authored = getComputedStyle(element.closest(".dashboard-native-widget") ?? element);
  const token = (name: string) => style.getPropertyValue(name).trim();
  // 商用大屏系列色阶:语义色(--info/--success/--warning/--danger)打底,后四色为其邻近色相延伸
  // (紫=info 邻域、青=info→success 过渡、橙=warning→danger 过渡、洋红=紫邻域),中等饱和明度,深浅主题均可读。
  // 若未来在 base.css 补充 --chart-series-5..8 令牌,将自动优先于内置值。
  const series = ["--info", "--success", "--warning", "--danger"].map(token);
  series.push("#9b8cf2", "#45c3c9", "#e08b5c", "#c974b8");
  return { accent: token("--accent"), text: authored.color, muted: authored.color, line: token("--line"), surface: authored.backgroundColor, width: element.clientWidth,
    rise: token("--danger") || undefined,
    fall: token("--success") || undefined,
    // 相邻系列色相跳开、整体明度渐进;同屏系列纪律仍为 ≤6,超出以备选色循环兜底。
    series };
}

/** 标签只缩短显示精度；tooltip、原行及聚合值保留原精度。 */
export function dashboardPiePercentLabel(value: { percent?: number }): string {
  return Number.isFinite(value.percent) ? `${Number(value.percent!.toFixed(1))}%` : "—";
}
