import type { AppLocale } from "../i18n";
import { DASHBOARD_ANALYSIS_PRESETS } from "./dashboardAnalysisPresets";
import { DASHBOARD_DECORATION_EFFECT_PRESETS } from "./dashboardDecorationEffectPresets";
import { DASHBOARD_DECORATION_FRAME_PRESETS } from "./dashboardDecorationFramePresets";
import { DASHBOARD_DECORATION_LINE_PRESETS } from "./dashboardDecorationLinePresets";
import { DASHBOARD_DECORATION_TITLE_PRESETS } from "./dashboardDecorationTitlePresets";
import { DASHBOARD_INDICATOR_PRESETS } from "./dashboardIndicatorPresets";
import { DASHBOARD_REPORT_PRESETS } from "./dashboardReportPresets";
import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { DASHBOARD_UTILITY_PRESETS } from "./dashboardUtilityPresets";

export type {
  DashboardComponentPreset,
  DashboardComponentPresetCategory,
  DashboardComponentPresetPreview,
  DashboardPresetPreviewFamily,
} from "./dashboardComponentPresetTypes";

/**
 * 统一入口保持旧调用方式稳定；实际预设按领域维护，避免目录再次演变成巨型文件。
 * 每个条目是可编辑、可绑定的数据组件，而非不可维护的截图或锁死模板。
 */
export const DASHBOARD_COMPONENT_PRESETS: readonly DashboardComponentPreset[] = [
  ...DASHBOARD_INDICATOR_PRESETS,
  ...DASHBOARD_ANALYSIS_PRESETS,
  ...DASHBOARD_REPORT_PRESETS,
  ...DASHBOARD_UTILITY_PRESETS,
  ...DASHBOARD_DECORATION_TITLE_PRESETS,
  ...DASHBOARD_DECORATION_FRAME_PRESETS,
  ...DASHBOARD_DECORATION_LINE_PRESETS,
  ...DASHBOARD_DECORATION_EFFECT_PRESETS,
] as const;

export function dashboardComponentPresetText(
  preset: DashboardComponentPreset,
  locale: AppLocale,
): { label: string; description: string } {
  return locale === "zh-CN"
    ? { label: preset.zh, description: preset.descriptionZh }
    : { label: preset.en, description: preset.descriptionEn };
}
