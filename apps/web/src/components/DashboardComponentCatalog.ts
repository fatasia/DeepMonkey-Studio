import type { AppLocale } from "../i18n";
import { DASHBOARD_ANALYSIS_PRESETS } from "./dashboardAnalysisPresets";
import { DASHBOARD_ANALYSIS_PRESETS_2 } from "./dashboardAnalysisPresets2";
import { DASHBOARD_ANALYSIS_PRESETS_3 } from "./dashboardAnalysisPresets3";
import { DASHBOARD_CONTROL_PRESETS_3 } from "./dashboardControlPresets3";
import { DASHBOARD_DECORATION_PRESETS_2 } from "./dashboardDecorationPresets2";
import { DASHBOARD_DECORATION_PRESETS_3 } from "./dashboardDecorationPresets3";
import { DASHBOARD_DECORATION_EFFECT_PRESETS } from "./dashboardDecorationEffectPresets";
import { DASHBOARD_DECORATION_FRAME_PRESETS } from "./dashboardDecorationFramePresets";
import { DASHBOARD_DECORATION_LINE_PRESETS } from "./dashboardDecorationLinePresets";
import { DASHBOARD_DECORATION_TITLE_PRESETS } from "./dashboardDecorationTitlePresets";
import { DASHBOARD_GAUGE_THRESHOLD_PRESETS } from "./dashboardGaugeThresholdPresets";
import { DASHBOARD_GIS_REGION_PRESETS } from "./dashboardGisRegionPresets";
import { DASHBOARD_GIS_VARIANT_PRESETS } from "./dashboardGisVariantPresets";
import { DASHBOARD_INDICATOR_PRESETS } from "./dashboardIndicatorPresets";
import { DASHBOARD_INDICATOR_PRESETS_2 } from "./dashboardIndicatorPresets2";
import { DASHBOARD_INDUSTRY_KPI_PRESETS } from "./dashboardIndustryKpiPresets";
import { DASHBOARD_INDUSTRY_KPI_PRESETS_2 } from "./dashboardIndustryKpiPresets2";
import { DASHBOARD_INDUSTRY_KPI_PRESETS_3 } from "./dashboardIndustryKpiPresets3";
import { DASHBOARD_REPORT_PRESETS } from "./dashboardReportPresets";
import { DASHBOARD_REPORT_PRESETS_2 } from "./dashboardReportPresets2";
import { DASHBOARD_REPORT_PRESETS_3 } from "./dashboardReportPresets3";
import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { DASHBOARD_UTILITY_PRESETS } from "./dashboardUtilityPresets";
import { DASHBOARD_UTILITY_PRESETS_2 } from "./dashboardUtilityPresets2";

export type {
  DashboardComponentPreset,
  DashboardComponentPresetCategory,
  DashboardComponentPresetPreview,
  DashboardPresetPreviewFamily,
} from "./dashboardComponentPresetTypes";

/**
 * 统一入口保持旧调用方式稳定；实际预设按领域维护，避免目录再次演变成巨型文件。
 * 每个条目是可编辑、可绑定的数据组件，而非不可维护的截图或锁死模板。
 * 素材数量波次 A(2026-09-12)新增:行业 KPI 60 / 仪表阈值 16 / 区域地图 16 /
 * 报表形态 14 / 控件 12 / 装饰造型 24 / 分析增强 28。
 * 素材数量波次 F(2026-09-12)新增:行业 KPI 补深 40(含半导体行业组)/
 * 真实图表 30(词云/箱线/瀑布/极坐标)/ 地图变体 12 / 装饰造型 10 /
 * 报表与控件变体 8,目录总量 420 → 520。
 */
export const DASHBOARD_COMPONENT_PRESETS: readonly DashboardComponentPreset[] = [
  ...DASHBOARD_INDICATOR_PRESETS,
  ...DASHBOARD_INDICATOR_PRESETS_2,
  ...DASHBOARD_INDUSTRY_KPI_PRESETS,
  ...DASHBOARD_INDUSTRY_KPI_PRESETS_2,
  ...DASHBOARD_INDUSTRY_KPI_PRESETS_3,
  ...DASHBOARD_ANALYSIS_PRESETS,
  ...DASHBOARD_ANALYSIS_PRESETS_2,
  ...DASHBOARD_ANALYSIS_PRESETS_3,
  ...DASHBOARD_GAUGE_THRESHOLD_PRESETS,
  ...DASHBOARD_REPORT_PRESETS,
  ...DASHBOARD_REPORT_PRESETS_2,
  ...DASHBOARD_REPORT_PRESETS_3,
  ...DASHBOARD_CONTROL_PRESETS_3,
  ...DASHBOARD_UTILITY_PRESETS,
  ...DASHBOARD_UTILITY_PRESETS_2,
  ...DASHBOARD_GIS_REGION_PRESETS,
  ...DASHBOARD_GIS_VARIANT_PRESETS,
  ...DASHBOARD_DECORATION_TITLE_PRESETS,
  ...DASHBOARD_DECORATION_FRAME_PRESETS,
  ...DASHBOARD_DECORATION_LINE_PRESETS,
  ...DASHBOARD_DECORATION_EFFECT_PRESETS,
  ...DASHBOARD_DECORATION_PRESETS_2,
  ...DASHBOARD_DECORATION_PRESETS_3,
] as const;

export function dashboardComponentPresetText(
  preset: DashboardComponentPreset,
  locale: AppLocale,
): { label: string; description: string } {
  return locale === "zh-CN"
    ? { label: preset.zh, description: preset.descriptionZh }
    : { label: preset.en, description: preset.descriptionEn };
}
