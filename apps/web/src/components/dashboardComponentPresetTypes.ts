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
  /** 来自素材预设自身的主色，缩略图与插入后的组件保持一致。 */
  accent: string;
  /** 素材自身的辅助色，不跟随工作台主题色。 */
  secondary: string;
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
  /** 组件类型由顶层 type 唯一承载；widget 不允许再带 type，防止双入口漂移。 */
  widget: Partial<Omit<DashboardDataWidgetConfig, "type">>;
  preview: DashboardComponentPresetPreview;
}
