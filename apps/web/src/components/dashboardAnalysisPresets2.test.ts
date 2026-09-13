import { describe, expect, it } from "vitest";
import { DASHBOARD_ANALYSIS_PRESETS_2 } from "./dashboardAnalysisPresets2";

/** 词云/箱线/瀑布/极坐标四个预设已从"最接近类型"映射回正为真实图表类型,id 保持稳定。 */
const RESTORED_PRESETS: Array<{ id: string; type: string; zh: string }> = [
  { id: "keyword-frequency-rank", type: "wordcloud", zh: "反馈关键词词云" },
  { id: "tolerance-limit-line", type: "boxplot", zh: "工序公差箱线分布" },
  { id: "cumulative-transfer-combo", type: "waterfall", zh: "库存结转瀑布" },
  { id: "grouped-series-bar", type: "polarBar", zh: "产线构成极坐标柱" },
];

describe("dashboardAnalysisPresets2", () => {
  it("maps the four formerly-approximated presets onto real chart types while keeping ids stable", () => {
    for (const restored of RESTORED_PRESETS) {
      const preset = DASHBOARD_ANALYSIS_PRESETS_2.find((item) => item.id === restored.id);
      expect(preset, restored.id).toBeDefined();
      expect(preset!.type, restored.id).toBe(restored.type);
      expect(preset!.zh, restored.id).toBe(restored.zh);
      expect(preset!.descriptionZh.trim()).not.toBe("");
    }
  });

  it("keeps the preset count unchanged so downstream references survive", () => {
    // 波次 F 起该文件扩展为 54(原 24 + 真实图表 30),既有 id 不迁移不删除。
    expect(DASHBOARD_ANALYSIS_PRESETS_2).toHaveLength(54);
  });

  it("uses real data semantics for the restored presets", () => {
    const wordcloud = DASHBOARD_ANALYSIS_PRESETS_2.find((preset) => preset.id === "keyword-frequency-rank")!;
    expect(wordcloud.widget.analysis?.limit).toBeGreaterThanOrEqual(30);
    expect(wordcloud.widget.analysis?.seriesField).toBeUndefined();

    const boxplot = DASHBOARD_ANALYSIS_PRESETS_2.find((preset) => preset.id === "tolerance-limit-line")!;
    // 箱线的语义是按分组聚合原始分布,不再借 bound 系列画上下限
    expect(boxplot.widget.analysis?.dimensionField).toBe("batch");
    expect(boxplot.widget.analysis?.seriesField).toBeUndefined();

    const waterfall = DASHBOARD_ANALYSIS_PRESETS_2.find((preset) => preset.id === "cumulative-transfer-combo")!;
    // 瀑布语义是单系列逐期净变化,不再用双轴折线表达结余
    expect(waterfall.widget.analysis?.seriesField).toBeUndefined();
    expect(waterfall.widget.chart?.secondaryAxisSeries).toBeUndefined();

    const polarBar = DASHBOARD_ANALYSIS_PRESETS_2.find((preset) => preset.id === "grouped-series-bar")!;
    expect(polarBar.widget.analysis?.seriesField).toBe("product");
    expect(polarBar.widget.chart?.showLegend).toBe(true);
  });
});
