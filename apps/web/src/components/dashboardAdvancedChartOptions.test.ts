import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import { dashboardAdvancedChartOption, dashboardBoxplotSummary } from "./dashboardAdvancedChartOptions";
import type { DashboardAnalysisResult } from "./dashboardAnalytics";
import type { DashboardChartPalette } from "./dashboardReadableChartOptions";

const palette: DashboardChartPalette = {
  accent: "#d4a84f",
  text: "#eef2f4",
  muted: "#7d8b91",
  line: "#303b40",
  surface: "#172126",
  series: ["#4e9fd1", "#62b88f", "#d8785f", "#9a7bd1"],
  rise: "#e06a5f",
  fall: "#4fae7e",
};

function widgetOf(type: DashboardDataWidgetConfig["type"], patch: Partial<DashboardDataWidgetConfig> = {}): DashboardDataWidgetConfig {
  return { title: "测试图表", key: "test", type, unit: "", ...patch };
}

const analysis: DashboardAnalysisResult = {
  rows: [],
  categories: ["甲班", "乙班", "丙班"],
  series: [{ name: "产量", values: [120, 90, 60] }],
  value: 60,
};

describe("dashboardAdvancedChartOptions", () => {
  it("builds a wordcloud option with weights mapped through plugin fields and accent-first colors", () => {
    const option = dashboardAdvancedChartOption(widgetOf("wordcloud", { analysis: { dimensionField: "keyword", measureField: "count", aggregation: "count" } }), analysis, palette, false);
    const series = (option as { series: Array<Record<string, unknown>> }).series[0]!;
    // 插件注册名是驼峰 series.wordCloud,小写会被 ECharts 判为未知系列
    expect(series.type).toBe("wordCloud");
    const words = series.data as Array<{ name: string; value: number; textStyle: { color: string } }>;
    expect(words.map((word) => word.name)).toEqual(["甲班", "乙班", "丙班"]);
    expect(words[0]!.textStyle.color).toBe(palette.accent);
    // colors = [accent, ...series],index 2 → colors[2] 即 series[1]
    expect(words[2]!.textStyle.color).toBe(palette.series[1]);
  });

  it("filters zero-weight words out of the cloud", () => {
    const empty = dashboardAdvancedChartOption(widgetOf("wordcloud"), { ...analysis, series: [{ name: "产量", values: [0, 0, 0] }] }, palette, false);
    expect((empty as { series: Array<{ data: unknown[] }> }).series[0]!.data).toHaveLength(0);
  });

  it("summarizes boxplot distributions as tukey five numbers with interpolation", () => {
    expect(dashboardBoxplotSummary([3, 1, 5, 2, 4])).toEqual([1, 2, 3, 4, 5]);
    expect(dashboardBoxplotSummary([2, 4])).toEqual([2, 2.5, 3, 3.5, 4]);
    expect(dashboardBoxplotSummary([])).toBeUndefined();
  });

  it("aggregates raw rows per dimension into boxplot series", () => {
    const rows = [
      { batch: "A", value: 10 }, { batch: "A", value: 20 }, { batch: "A", value: 30 },
      { batch: "B", value: 5 }, { batch: "B", value: 15 },
    ];
    const option = dashboardAdvancedChartOption(
      widgetOf("boxplot", { analysis: { dimensionField: "batch", measureField: "value", aggregation: "none" } }),
      { rows, categories: ["A", "B"], series: [{ name: "value", values: [20, 10] }], value: 15 },
      palette,
      false,
    );
    const optionRecord = option as { series: Array<{ type: string; data: Array<[number, number, number, number, number] | undefined> }> };
    expect(optionRecord.series[0]!.type).toBe("boxplot");
    expect(optionRecord.series[0]!.data[0]).toEqual([10, 15, 20, 25, 30]);
    expect(optionRecord.series[0]!.data[1]).toEqual([5, 7.5, 10, 12.5, 15]);
  });

  it("builds waterfall stacking with transparent placeholders and rise/fall semantic colors", () => {
    const option = dashboardAdvancedChartOption(
      widgetOf("waterfall", { analysis: { dimensionField: "date", measureField: "quantity", aggregation: "sum" } }),
      { ...analysis, series: [{ name: "库存", values: [100, 20, -30] }] },
      palette,
      false,
    );
    const [placeholder, bars] = (option as { series: Array<Record<string, unknown>> }).series as [Record<string, unknown>, Record<string, unknown>];
    expect(placeholder.stack).toBe("waterfall");
    // 占位=变化前的较低累计值:[0, min(100,120)=100, min(120,90)=90]
    expect(placeholder.data).toEqual([0, 100, 90]);
    const items = bars.data as Array<{ value: number; itemStyle: { color: string } }>;
    expect(items.map((item) => item.value)).toEqual([100, 20, 30]);
    expect(items[0]!.itemStyle.color).toBe(palette.accent);
    expect(items[1]!.itemStyle.color).toBe(palette.rise);
    expect(items[2]!.itemStyle.color).toBe(palette.fall);
  });

  it("stacks polar bar series on the polar coordinate system", () => {
    const option = dashboardAdvancedChartOption(
      widgetOf("polarBar", { chart: { showLegend: true }, analysis: { dimensionField: "line", seriesField: "product", measureField: "output", aggregation: "sum" } }),
      { ...analysis, series: [{ name: "A 品", values: [1, 2, 3] }, { name: "B 品", values: [4, 5, 6] }] },
      palette,
      false,
    );
    const optionRecord = option as {
      series: Array<{ type: string; coordinateSystem: string; stack: string }>;
      angleAxis: { type: string; data: string[] };
      radiusAxis: { type: string };
    };
    expect(optionRecord.series).toHaveLength(2);
    expect(optionRecord.series.every((item) => item.type === "bar" && item.coordinateSystem === "polar" && item.stack === "total")).toBe(true);
    expect(optionRecord.angleAxis.data).toEqual(["甲班", "乙班", "丙班"]);
  });

  it("returns undefined for non-advanced widget types", () => {
    expect(dashboardAdvancedChartOption(widgetOf("bar"), analysis, palette, false)).toBeUndefined();
  });
});

describe("echarts-wordcloud compatibility with ECharts 6 (node ssr)", () => {
  it("registers the plugin and runs init+setOption without throwing", async () => {
    // 先在纯 node 环境(无 window)加载 echarts,让 zrender 的运行环境判定固化为 node;
    const [{ init, use }, { SVGRenderer }] = await Promise.all([import("echarts/core"), import("echarts/renderers")]);
    use(SVGRenderer);
    // 再补插件模块 import 时的最小 window/document stub:layout 会探测 canvas 2d 上下文与 setImmediate,
    // wordcloud2.js 还会调用容器的事件 API,统一用 noop 兜底 Proxy。
    const context = new Proxy<Record<PropertyKey, unknown>>({
      measureText: () => ({ width: 8 }),
      canvas: null,
    }, {
      get: (target, property) => {
        if (property in target) return target[property];
        if (property === "getImageData") return (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(Math.max(4, (width | 0) * (height | 0) * 4)) });
        return () => undefined;
      },
      set: () => true,
    });
    const element = () => new Proxy<Record<PropertyKey, unknown>>({ tagName: "CANVAS", width: 0, height: 0, getContext: () => context }, {
      get: (target, property) => (property in target ? target[property] : () => undefined),
      set: (target, property, value) => { target[property] = value; return true; },
    });
    vi.stubGlobal("document", {
      createElement: (tag: string) => element(),
    });
    vi.stubGlobal("window", { setImmediate: globalThis.setImmediate });
    await import("echarts-wordcloud");
    const chart = init(null, null, { renderer: "svg", ssr: true, width: 400, height: 300 });
    expect(() =>
      chart.setOption({
        series: [{
          type: "wordCloud",
          shape: "circle",
          sizeRange: [10, 30],
          data: [{ name: "点检", value: 99 }, { name: "巡检", value: 61 }],
        }],
      }, true),
    ).not.toThrow();
    // 词云布局按分片异步执行,让分片回调跑完再收尾,异步异常也能暴露到断言阶段
    await new Promise((resolve) => setTimeout(resolve, 300));
    chart.dispose();
    vi.unstubAllGlobals();
  });
});
