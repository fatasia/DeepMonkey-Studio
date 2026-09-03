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

const RESOURCE_PALETTES: ReadonlyArray<{ terms: readonly string[]; colors: ResourcePalette }> = [
  { terms: ["alarm", "fault", "risk", "hazard", "emergency", "offline", "downtime", "defect", "safety"], colors: { accent: "#e2766a", secondary: "#f0ad62" } },
  { terms: ["energy", "carbon", "environment", "emission", "water", "liquid", "tank"], colors: { accent: "#55ad82", secondary: "#4d9fbd" } },
  { terms: ["quality", "yield", "capability", "inspection"], colors: { accent: "#8679cf", secondary: "#55b092" } },
  { terms: ["maintenance", "health", "device", "motor", "valve", "robot", "asset", "equipment"], colors: { accent: "#4f9fbd", secondary: "#64b68e" } },
  { terms: ["production", "output", "capacity", "throughput", "order", "inventory", "logistics", "warehouse"], colors: { accent: "#4e88d0", secondary: "#53aa8b" } },
  { terms: ["gis", "map", "region", "route"], colors: { accent: "#48a29b", secondary: "#6c8fce" } },
  { terms: ["topology", "network", "communication", "process", "flow"], colors: { accent: "#559bb1", secondary: "#8b82c9" } },
  { terms: ["report", "table", "rank", "summary"], colors: { accent: "#6e91c8", secondary: "#6aae91" } },
];

const DEFAULT_RESOURCE_PALETTE: ResourcePalette = { accent: "#4f91c8", secondary: "#59ae8d" };

function resourcePalette(id: string, explicitColor?: string): ResourcePalette {
  const matched = RESOURCE_PALETTES.find(({ terms }) => terms.some((term) => id.includes(term)))?.colors
    ?? DEFAULT_RESOURCE_PALETTE;
  return explicitColor ? { ...matched, accent: explicitColor } : matched;
}

export function componentPreset(input: PresetInput): DashboardComponentPreset {
  const { previewFamily, previewMark, ...preset } = input;
  const palette = resourcePalette(preset.id, preset.widget.color);
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
