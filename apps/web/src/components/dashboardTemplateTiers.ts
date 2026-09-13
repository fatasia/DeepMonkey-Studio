import { INDUSTRY_TEMPLATE_PACKS } from "./industryTemplatePackCatalog";
import type { DashboardTemplateDefinition, DashboardTemplateTier } from "./dashboardTemplateTypes";

/**
 * 行业包分层解析:被任一行业深度包页面引用的模板视为"行业包"层,其余为"标准"层。
 * 定义上的 tier 字段只是静态默认,展示一律以本模块的解析结果为准(单一事实来源)。
 */
const INDUSTRY_PACK_TEMPLATE_IDS: ReadonlySet<string> = new Set(
  INDUSTRY_TEMPLATE_PACKS.flatMap((pack) => pack.pages.map((page) => page.templateId)),
);

export function resolveTemplateTier(templateId: string): DashboardTemplateTier {
  return INDUSTRY_PACK_TEMPLATE_IDS.has(templateId) ? "industry" : "standard";
}

export function templateTierLabel(tier: DashboardTemplateTier, locale: "zh-CN" | "en-US"): string {
  return locale === "zh-CN" ? (tier === "industry" ? "行业包" : "标准") : tier === "industry" ? "Industry pack" : "Standard";
}

/**
 * 推荐排序(精选,不造假热度):行业包优先,其次布局组件丰富度(特征标签数,由真实结构推导),
 * 再次保持目录定义顺序。无浏览量/下载数等我们并不拥有的热度数据。
 */
export function rankRecommendedTemplates(templates: readonly DashboardTemplateDefinition[]): DashboardTemplateDefinition[] {
  return [...templates].sort((left, right) => {
    const leftIndustry = resolveTemplateTier(left.id) === "industry";
    const rightIndustry = resolveTemplateTier(right.id) === "industry";
    if (leftIndustry !== rightIndustry) return leftIndustry ? -1 : 1;
    return (right.tags?.length ?? 0) - (left.tags?.length ?? 0);
  });
}
