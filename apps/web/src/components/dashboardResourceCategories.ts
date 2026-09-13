import type { DashboardComponentPreset } from "./DashboardComponentCatalog";

export type DashboardResourceCategoryKey = "data" | "interaction" | "spatial" | "media" | "visual";

/** 资源页与二维编辑器共用同一套分类语义，避免同一资源在两个入口被归到不同位置。 */
export const DASHBOARD_RESOURCE_CATEGORIES: ReadonlyArray<{ key: DashboardResourceCategoryKey; zh: string; en: string }> = [
  { key: "data", zh: "数据组件", en: "Data" },
  { key: "interaction", zh: "交互组件", en: "Interaction" },
  { key: "spatial", zh: "空间组件", en: "Spatial" },
  { key: "media", zh: "媒体组件", en: "Media" },
  { key: "visual", zh: "视觉素材", en: "Visuals" },
];

export function dashboardPresetResourceCategory(category: DashboardComponentPreset["category"]): DashboardResourceCategoryKey {
  if (category === "indicator" || category === "analysis" || category === "report") return "data";
  if (category === "control") return "interaction";
  if (category === "gis" || category === "topology" || category === "industrial") return "spatial";
  if (category === "material") return "visual";
  return "media";
}
