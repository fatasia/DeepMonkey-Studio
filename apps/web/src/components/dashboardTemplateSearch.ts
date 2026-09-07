import type { AppLocale } from "../i18n";
import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";

export function searchDashboardTemplates(locale: AppLocale, query: string, category: string, favorites: readonly string[]) {
  const normalized = query.trim().toLocaleLowerCase();
  return DASHBOARD_TEMPLATES.filter(template => {
    const label = locale === "zh-CN" ? template.categoryZh : template.categoryEn;
    if (category !== "all" && category !== label && !(category === "favorites" && favorites.includes(template.id))) return false;
    return !normalized || [template.zh, template.en, template.categoryZh, template.categoryEn,
      template.goalZh, template.goalEn, template.descriptionZh, template.descriptionEn,
      ...template.metrics.flatMap(metric => [metric.zh, metric.en])].join(" ").toLocaleLowerCase().includes(normalized);
  }).sort((left, right) => Number(favorites.includes(right.id)) - Number(favorites.includes(left.id)));
}
