import {
  assertApplicationDocument,
  migrateSceneSnapshotV1,
  type DashboardDataWidgetConfig,
  type SceneDashboardWidgetType,
  type SceneSnapshot,
} from "@bim-studio/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import pure3dFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { DASHBOARD_ANALYSIS_PRESETS_2 } from "./dashboardAnalysisPresets2";
import { DASHBOARD_ANALYSIS_PRESETS_3 } from "./dashboardAnalysisPresets3";
import { DASHBOARD_DECORATION_PRESETS_2 } from "./dashboardDecorationPresets2";
import { DASHBOARD_GAUGE_THRESHOLD_PRESETS } from "./dashboardGaugeThresholdPresets";
import { DASHBOARD_GIS_REGION_PRESETS } from "./dashboardGisRegionPresets";
import { DASHBOARD_GIS_VARIANT_PRESETS } from "./dashboardGisVariantPresets";
import { DASHBOARD_INDUSTRY_KPI_PRESETS } from "./dashboardIndustryKpiPresets";
import { DASHBOARD_INDUSTRY_KPI_PRESETS_2 } from "./dashboardIndustryKpiPresets2";
import { DASHBOARD_INDUSTRY_KPI_PRESETS_3 } from "./dashboardIndustryKpiPresets3";
import { DASHBOARD_CONTROL_PRESETS_3 } from "./dashboardControlPresets3";
import { DASHBOARD_DECORATION_PRESETS_3 } from "./dashboardDecorationPresets3";
import { DASHBOARD_REPORT_PRESETS_2 } from "./dashboardReportPresets2";
import { DASHBOARD_REPORT_PRESETS_3 } from "./dashboardReportPresets3";
import { DASHBOARD_UTILITY_PRESETS_2 } from "./dashboardUtilityPresets2";

import { DASHBOARD_COMPONENT_PRESETS } from "./DashboardComponentCatalog";
import { DashboardComponentPreview } from "./DashboardComponentPreview";
import { createDefaultDataWidget, DATA_WIDGET_CATEGORIES, DATA_WIDGET_TYPES, DECORATION_ASSETS } from "./dashboardWorkspaceModel";

const functionalPresets = DASHBOARD_COMPONENT_PRESETS.filter((preset) => preset.category !== "material");
const decorationPresets = DASHBOARD_COMPONENT_PRESETS.filter((preset) => preset.category === "material");

describe("DashboardComponentCatalog", () => {
  it("meets the commercial functional and decoration coverage gates", () => {
    expect(functionalPresets.length).toBeGreaterThanOrEqual(370);
    expect(decorationPresets.length).toBeGreaterThanOrEqual(120);
    expect(DASHBOARD_COMPONENT_PRESETS.length).toBeGreaterThanOrEqual(520);
    expect(new Set(DASHBOARD_COMPONENT_PRESETS.map((preset) => preset.id)).size).toBe(DASHBOARD_COMPONENT_PRESETS.length);

    const requiredCategories = ["indicator", "analysis", "report", "control", "media", "gis", "topology", "industrial", "material"];
    expect(new Set(DASHBOARD_COMPONENT_PRESETS.map((preset) => preset.category))).toEqual(new Set(requiredCategories));
  });

  it("keeps no (type+family+mark) cluster with three or more members — anti-filler gate", () => {
    // 聚类审计门禁:同 type+family+mark 的簇 ≥3 即判定为凑数,直接打回。
    const clusters = new Map<string, string[]>();
    for (const preset of DASHBOARD_COMPONENT_PRESETS) {
      const key = `${preset.type}|${preset.preview.family}|${preset.preview.mark}`;
      clusters.set(key, [...(clusters.get(key) ?? []), preset.id]);
    }
    const violations = [...clusters.entries()].filter(([, ids]) => ids.length >= 3);
    expect(
      violations.map(([key, ids]) => `${key} x${ids.length} (${ids.join(", ")})`),
    ).toEqual([]);
  });

  it("covers every 2D runtime type except the dedicated 3D Unity viewport", () => {
    const functionalTypes = new Set(functionalPresets.map((preset) => preset.type));
    const requiredTypes = DATA_WIDGET_TYPES.filter((type) => type !== "decoration" && type !== "unity");
    expect(requiredTypes.every((type) => functionalTypes.has(type))).toBe(true);

    const categorizedTypes = new Set(DATA_WIDGET_CATEGORIES.flatMap((category) => category.types));
    expect(categorizedTypes).toEqual(new Set(DATA_WIDGET_TYPES));
    expect(DECORATION_ASSETS.length).toBeGreaterThanOrEqual(12);
  });

  it("ships purposeful defaults and a stable preview for every preset", () => {
    expect(DASHBOARD_COMPONENT_PRESETS.every((preset) => preset.zh.trim() && preset.descriptionZh.trim())).toBe(true);
    expect(DASHBOARD_COMPONENT_PRESETS.every((preset) => preset.widget.title?.trim())).toBe(true);
    expect(new Set(DASHBOARD_COMPONENT_PRESETS.map((preset) => preset.preview.variant)).size).toBe(DASHBOARD_COMPONENT_PRESETS.length);
    expect(DASHBOARD_COMPONENT_PRESETS.every((preset) => preset.widget.color === preset.preview.accent)).toBe(true);
    expect(new Set(functionalPresets.map((preset) => preset.widget.color)).size).toBeGreaterThanOrEqual(5);

    for (const preset of DASHBOARD_COMPONENT_PRESETS) {
      const html = renderToStaticMarkup(createElement(DashboardComponentPreview, {
        type: preset.type,
        preview: preset.preview,
        ...(preset.widget.decorationStyle ? { decorationStyle: preset.widget.decorationStyle } : {}),
      }));
      expect(html).toContain(`data-preview-variant="${preset.id}"`);
      expect(html).toContain("dashboard-library-preview-mark");
      expect(html).toContain(`--preview-accent:${preset.preview.accent}`);
    }
  });

  it("produces application-valid editable default configurations", () => {
    const application = migrateSceneSnapshotV1(pure3dFixture as SceneSnapshot);
    const page = application.pages[0]!;
    page.nodes = DASHBOARD_COMPONENT_PRESETS.map((preset, index) => ({
      id: `catalog:${preset.id}`,
      name: preset.id,
      kind: "data-widget" as const,
      frame: { x: 0, y: 0, width: preset.frame?.width ?? 420, height: preset.frame?.height ?? 240 },
      zIndex: index + 1,
      widget: fullWidget(preset.type, preset.widget),
    }));

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("keeps the wave-A family sizes on their agreed quotas", () => {
    // 行业 KPI 族 = 主批 40(规格配额)+ 扩展 20(补齐 420+ 目标)+ 波次 F 补深 40。
    expect(DASHBOARD_INDUSTRY_KPI_PRESETS.length).toBe(40);
    expect(DASHBOARD_INDUSTRY_KPI_PRESETS_2.length).toBe(20);
    expect(DASHBOARD_GAUGE_THRESHOLD_PRESETS.length).toBe(16);
    expect(DASHBOARD_GIS_REGION_PRESETS.length).toBe(16);
    expect(DASHBOARD_REPORT_PRESETS_3.length).toBe(14);
    expect(DASHBOARD_CONTROL_PRESETS_3.length).toBe(12);
    expect(DASHBOARD_DECORATION_PRESETS_3.length).toBe(24);
    expect(DASHBOARD_ANALYSIS_PRESETS_3.length).toBe(28);
  });

  it("keeps the wave-F family sizes on their agreed quotas", () => {
    // 波次 F(2026-09-12):行业 KPI 补深 40 / 真实图表 30 / 地图变体 12 / 报表 +4 / 控件 +4 / 装饰 +10。
    expect(DASHBOARD_INDUSTRY_KPI_PRESETS_3.length).toBe(40);
    expect(DASHBOARD_GIS_VARIANT_PRESETS.length).toBe(12);
    expect(DASHBOARD_ANALYSIS_PRESETS_2.length).toBe(54);
    expect(DASHBOARD_REPORT_PRESETS_2.length).toBe(12);
    expect(DASHBOARD_UTILITY_PRESETS_2.length).toBe(12);
    expect(DASHBOARD_DECORATION_PRESETS_2.length).toBe(36);
    // 四类真实高级图表在目录中保持可用深度(词云/箱线/瀑布/极坐标各 ≥8)。
    for (const type of ["wordcloud", "boxplot", "waterfall", "polarBar"] as const) {
      const count = DASHBOARD_COMPONENT_PRESETS.filter((preset) => preset.type === type).length;
      expect(count, `${type} should keep at least 8 real-type presets`).toBeGreaterThanOrEqual(8);
    }
  });

  it("grounds industry KPI units and thresholds in real industry semantics", () => {
    // 抽查行业口径:浊度 NTU ≤1、线损率 >6% 预警、产销差 >12% 预警、药占比 >30% 关注。
    const turbidity = DASHBOARD_INDUSTRY_KPI_PRESETS.find((preset) => preset.id === "turbidity-kpi");
    expect(turbidity?.widget.unit).toBe("NTU");
    expect(turbidity?.widget.conditionalRules?.[0]?.value).toBe(1);

    const lineLoss = DASHBOARD_INDUSTRY_KPI_PRESETS.find((preset) => preset.id === "power-line-loss-kpi");
    expect(lineLoss?.widget.unit).toBe("%");
    expect(lineLoss?.widget.conditionalRules?.[0]?.operator).toBe("gt");
    expect(lineLoss?.widget.conditionalRules?.[0]?.value).toBe(6);

    const nrw = DASHBOARD_INDUSTRY_KPI_PRESETS.find((preset) => preset.id === "water-nrw-kpi");
    expect(nrw?.widget.conditionalRules?.[0]?.value).toBe(12);

    const drugRatio = DASHBOARD_INDUSTRY_KPI_PRESETS_2.find((preset) => preset.id === "drug-ratio-kpi");
    expect(drugRatio?.widget.unit).toBe("%");
    expect(drugRatio?.widget.conditionalRules?.[0]?.value).toBe(30);
  });

  it("renders distinct gauge dials and map cartography marks for the threshold and region families", () => {
    // 仪表阈值族:每款 mark 都应命中独立构图(GaugeDial 渲染出分段/双针等变体结构)。
    const gaugeMarks = DASHBOARD_GAUGE_THRESHOLD_PRESETS.map((preset) => preset.preview.mark);
    expect(new Set(gaugeMarks).size).toBe(gaugeMarks.length);
    for (const preset of DASHBOARD_GAUGE_THRESHOLD_PRESETS) {
      const html = renderToStaticMarkup(createElement(DashboardComponentPreview, { type: "gauge", preview: preset.preview }));
      // 变体构图总是带显式 em 数值(默认构图同样带,但分段表应含 dasharray 分段或 guide 线)
      expect(html).toContain("<em");
    }
    // 区域地图族:18 款地图预设(16 gis + 2 分析增强)全部命中 mark 构图变体。
    const mapMarks = DASHBOARD_GIS_REGION_PRESETS.map((preset) => preset.preview.mark);
    expect(new Set(mapMarks).size).toBe(mapMarks.length);
    // 波次 F 地图变体族 12 款同样 mark 全唯一,与区域族不共享任何 mark。
    const variantMarks = DASHBOARD_GIS_VARIANT_PRESETS.map((preset) => preset.preview.mark);
    expect(new Set(variantMarks).size).toBe(variantMarks.length);
    expect(variantMarks.filter((mark) => mapMarks.includes(mark))).toEqual([]);
  });
});

function fullWidget(
  type: SceneDashboardWidgetType,
  patch: Partial<DashboardDataWidgetConfig>,
): DashboardDataWidgetConfig {
  return { ...createDefaultDataWidget("zh-CN", type), ...structuredClone(patch) };
}
