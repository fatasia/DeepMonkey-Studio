import type { DashboardDataWidgetConfig, SceneDashboardWidgetType, WidgetFrame } from "@bim-studio/contracts";

export type DashboardComponentPresetCategory =
  | "indicator"
  | "analysis"
  | "report"
  | "control"
  | "media"
  | "gis"
  | "topology"
  | "industrial"
  | "material";

export type DashboardPresetPreviewFamily =
  | "metric"
  | "chart"
  | "report"
  | "control"
  | "media"
  | "gis"
  | "topology"
  | "industrial"
  | "title"
  | "frame"
  | "badge"
  | "divider"
  | "light"
  | "ruler"
  | "scan"
  | "alarm";

export interface DashboardComponentPresetPreview {
  family: DashboardPresetPreviewFamily;
  /** 与预设 ID 同源，使每张卡片拥有稳定、可单独验收的预览变体。 */
  variant: string;
  /** 缩略图短标记用于区分同类型的不同业务用途，不参与运行时数据。 */
  mark: string;
}

export interface DashboardComponentPreset {
  id: string;
  category: DashboardComponentPresetCategory;
  zh: string;
  en: string;
  descriptionZh: string;
  descriptionEn: string;
  type: SceneDashboardWidgetType;
  frame?: Partial<Pick<WidgetFrame, "width" | "height">>;
  widget: Partial<DashboardDataWidgetConfig>;
  preview: DashboardComponentPresetPreview;
}
