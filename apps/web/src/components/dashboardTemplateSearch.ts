import type { AppLocale } from "../i18n";
import { DASHBOARD_TEMPLATES } from "./dashboardTemplateCatalog";
import { resolveTemplateGroup } from "./dashboardTemplateGroups";

/**
 * 模板检索:group 传行业分组 id(见 dashboardTemplateGroups)或 "all";
 * 收藏模板置顶(收藏筛选由调用方完成);查询词覆盖标题/行业/目标/描述/指标与特征标签。
 */
export function searchDashboardTemplates(locale: AppLocale, query: string, group: string, favorites: readonly string[]) {
  const normalized = query.trim().toLocaleLowerCase();
  return DASHBOARD_TEMPLATES.filter(template => {
    if (group !== "all" && resolveTemplateGroup(template.domainId)?.id !== group) return false;
    return !normalized || [template.zh, template.en, template.categoryZh, template.categoryEn,
      template.goalZh, template.goalEn, template.descriptionZh, template.descriptionEn,
      ...(template.tags ?? []).flatMap(tag => [tag.zh, tag.en]),
      ...template.metrics.flatMap(metric => [metric.zh, metric.en])].join(" ").toLocaleLowerCase().includes(normalized);
  }).sort((left, right) => Number(favorites.includes(right.id)) - Number(favorites.includes(left.id)));
}
