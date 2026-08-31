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

export function componentPreset(input: PresetInput): DashboardComponentPreset {
  const { previewFamily, previewMark, ...preset } = input;
  return { ...preset, preview: { family: previewFamily, variant: preset.id, mark: previewMark } };
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
