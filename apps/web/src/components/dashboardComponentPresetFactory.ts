import type { DashboardDataWidgetConfig, SceneDashboardWidgetType } from "@bim-studio/contracts";
import type {
  DashboardComponentPreset,
  DashboardComponentPresetCategory,
  DashboardPresetPreviewFamily,
} from "./dashboardComponentPresetTypes";

type PresetInput = Omit<DashboardComponentPreset, "preview"> & {
  previewFamily: DashboardPresetPreviewFamily;
  previewMark: string;
};

interface ResourcePalette {
  accent: string;
  secondary: string;
}

/**
 * 资源库 family 级配色语言(对标外部参考 大屏参考 组件面板:分组可凭色相定位,组内仍有节奏):
 * 业务指标=琥珀金、分析图表=青、业务报表=蓝紫、交互控件=天蓝、媒体监控=青蓝、
 * GIS=绿松石、工业拓扑=蓝+紫、工业状态=青绿+金、矢量装饰=金+青。
 * 这里的颜色是「组件自身的数据系列色」(插入画布后仍然生效),不属于 UI 主题硬编码;
 * 瓷砖、文字、边框等界面色一律走 styles 里的 CSS 令牌。
 */
const FAMILY_PALETTES: Readonly<Record<DashboardComponentPresetCategory, ResourcePalette>> = {
  indicator: { accent: "#e7b45a", secondary: "#ee8f5c" },
  analysis: { accent: "#3ec2b4", secondary: "#5a9cf5" },
  report: { accent: "#8b8ef2", secondary: "#58b6d8" },
  control: { accent: "#57acf0", secondary: "#8f97f0" },
  media: { accent: "#4cb4dd", secondary: "#dfa05e" },
  gis: { accent: "#43c39c", secondary: "#5aa6ee" },
  topology: { accent: "#57a5e6", secondary: "#b48ae6" },
  industrial: { accent: "#5ec4a4", secondary: "#dcb258" },
  material: { accent: "#d8a84e", secondary: "#68bec6" },
};

/**
 * 装饰素材按子家族(标题/边框/角标/分隔/标尺/光带/扫描/告警)给出多彩但成体系的配色,
 * 避免「资源」页整屏同色;装饰预设显式传入的 color 仍然优先。
 */
const DECORATION_PALETTES: Readonly<Record<DashboardPresetPreviewFamily, ResourcePalette>> = {
  metric: FAMILY_PALETTES.indicator,
  chart: FAMILY_PALETTES.analysis,
  report: FAMILY_PALETTES.report,
  control: FAMILY_PALETTES.control,
  media: FAMILY_PALETTES.media,
  gis: FAMILY_PALETTES.gis,
  topology: FAMILY_PALETTES.topology,
  industrial: FAMILY_PALETTES.industrial,
  title: { accent: "#e0a44e", secondary: "#e8785c" },
  frame: { accent: "#52b2c8", secondary: "#58a0e8" },
  badge: { accent: "#e89850", secondary: "#f0c05c" },
  divider: { accent: "#6a9fe8", secondary: "#58c0d0" },
  ruler: { accent: "#55c0a2", secondary: "#58a8e8" },
  light: { accent: "#f0c25a", secondary: "#f09a5c" },
  scan: { accent: "#4cc4d4", secondary: "#58a8e8" },
  alarm: { accent: "#ee7a68", secondary: "#f0a95a" },
};

/**
 * 语义二级覆盖:告警=红、能源=绿、质量=紫、生产=蓝、设备=青绿,跨分组保持同一语义同色
 * (西门子水位:语义色全系统唯一),且保证同一分组的相邻卡片也有可辨识差异。
 */
const SEMANTIC_PALETTES: ReadonlyArray<{ terms: readonly string[]; colors: ResourcePalette }> = [
  { terms: ["alarm", "fault", "critical", "hazard", "emergency", "offline", "downtime", "risk", "overdue"], colors: { accent: "#ee7a68", secondary: "#f0a95a" } },
  { terms: ["energy", "carbon", "environment", "emission", "water", "liquid", "tank"], colors: { accent: "#52c18a", secondary: "#4fb3c8" } },
  { terms: ["quality", "yield", "defect", "capability", "inspection"], colors: { accent: "#a083e8", secondary: "#d583b4" } },
  { terms: ["production", "output", "capacity", "throughput", "order", "inventory", "logistics", "warehouse"], colors: { accent: "#559ce8", secondary: "#e0b45c" } },
  { terms: ["maintenance", "health", "device", "motor", "valve", "robot", "asset", "equipment"], colors: { accent: "#45bfa8", secondary: "#5a9cf5" } },
];

function resourcePalette(
  id: string,
  category: DashboardComponentPresetCategory,
  previewFamily: DashboardPresetPreviewFamily,
  explicitColor?: string,
): ResourcePalette {
  const semantic = SEMANTIC_PALETTES.find(({ terms }) => terms.some((term) => id.includes(term)))?.colors;
  const matched = category === "material"
    ? semantic ?? DECORATION_PALETTES[previewFamily] ?? FAMILY_PALETTES.material
    : semantic ?? FAMILY_PALETTES[category] ?? FAMILY_PALETTES.analysis;
  return explicitColor ? { ...matched, accent: explicitColor } : matched;
}

export function componentPreset(input: PresetInput): DashboardComponentPreset {
  const { previewFamily, previewMark, ...preset } = input;
  const palette = resourcePalette(preset.id, preset.category, previewFamily, preset.widget.color);
  return {
    ...preset,
    widget: { ...preset.widget, color: palette.accent },
    preview: {
      family: previewFamily,
      variant: preset.id,
      mark: previewMark,
      accent: palette.accent,
      secondary: palette.secondary,
    },
  };
}

export function metricPreset(
  id: string,
  zh: string,
  en: string,
  descriptionZh: string,
  type: Extract<SceneDashboardWidgetType, "value" | "digital-flip" | "liquid-fill" | "progress" | "status" | "gauge">,
  key: string,
  field: string,
  unit: string,
  widget: Partial<DashboardDataWidgetConfig> = {},
): DashboardComponentPreset {
  return componentPreset({
    id, category: "indicator", zh, en, descriptionZh, descriptionEn: en,
    type, previewFamily: "metric", previewMark: zh.slice(0, 4),
    widget: { title: zh, key, field, unit, ...widget },
  });
}

export function analysisPreset(
  id: string,
  zh: string,
  en: string,
  descriptionZh: string,
  type: SceneDashboardWidgetType,
  key: string,
  dimensionField: string,
  measureField: string,
  widget: Partial<DashboardDataWidgetConfig> = {},
): DashboardComponentPreset {
  return componentPreset({
    id, category: "analysis", zh, en, descriptionZh, descriptionEn: en,
    type, frame: { width: type === "pie" || type === "radar" ? 380 : 520, height: 300 },
    previewFamily: type === "map" ? "gis" : "chart", previewMark: zh.slice(0, 4),
    widget: {
      title: zh,
      key,
      analysis: { dimensionField, measureField, aggregation: "sum", sort: "none" },
      ...widget,
    },
  });
}

export function reportPreset(
  id: string,
  zh: string,
  en: string,
  descriptionZh: string,
  type: Extract<SceneDashboardWidgetType, "table" | "scroll-table" | "rank">,
  key: string,
  widget: Partial<DashboardDataWidgetConfig>,
): DashboardComponentPreset {
  return componentPreset({
    id, category: "report", zh, en, descriptionZh, descriptionEn: en, type,
    frame: { width: type === "rank" ? 380 : 620, height: 320 },
    previewFamily: "report", previewMark: zh.slice(0, 4),
    widget: { title: zh, key, ...widget },
  });
}

export function utilityPreset(input: {
  id: string;
  category: Exclude<DashboardComponentPresetCategory, "indicator" | "analysis" | "report" | "material">;
  zh: string;
  en: string;
  descriptionZh: string;
  type: SceneDashboardWidgetType;
  key: string;
  previewFamily: DashboardPresetPreviewFamily;
  frame?: DashboardComponentPreset["frame"];
  widget?: Partial<DashboardDataWidgetConfig>;
}): DashboardComponentPreset {
  const { frame, widget, ...preset } = input;
  return componentPreset({
    ...preset,
    descriptionEn: input.en,
    previewMark: input.zh.slice(0, 4),
    ...(frame ? { frame } : {}),
    widget: { title: input.zh, key: input.key, ...(widget ?? {}) },
  });
}

export function decorationPreset(input: {
  id: string;
  zh: string;
  en: string;
  descriptionZh: string;
  family: Extract<DashboardPresetPreviewFamily, "title" | "frame" | "badge" | "divider" | "light" | "ruler" | "scan" | "alarm">;
  mark: string;
  style: NonNullable<DashboardDataWidgetConfig["decorationStyle"]>;
  content: string;
  width: number;
  height: number;
  color?: string;
  widget?: Partial<DashboardDataWidgetConfig>;
}): DashboardComponentPreset {
  return componentPreset({
    id: input.id,
    category: "material",
    zh: input.zh,
    en: input.en,
    descriptionZh: input.descriptionZh,
    descriptionEn: input.en,
    type: "decoration",
    frame: { width: input.width, height: input.height },
    previewFamily: input.family,
    previewMark: input.mark,
    widget: {
      title: input.zh,
      content: input.content,
      decorationStyle: input.style,
      color: input.color ?? "#d4a84f",
      backgroundOpacity: 0,
      ...input.widget,
    },
  });
}
