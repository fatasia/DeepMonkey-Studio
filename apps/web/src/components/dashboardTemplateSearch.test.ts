import { describe, expect, it } from "vitest";
import { DASHBOARD_TEMPLATES } from "./dashboardTemplateCatalog";
import { resolveTemplateGroup } from "./dashboardTemplateGroups";
import { rankRecommendedTemplates, resolveTemplateTier } from "./dashboardTemplateTiers";
import { searchDashboardTemplates } from "./dashboardTemplateSearch";

describe("template search", () => {
  it("preserves the catalog and returns recoverable empty searches", () => {
    const ids = DASHBOARD_TEMPLATES.map(item => item.id);
    expect(searchDashboardTemplates("zh-CN", "not-a-template-91832", "all", [])).toEqual([]);
    expect(searchDashboardTemplates("zh-CN", " ", "all", [])).toHaveLength(ids.length);
    expect(DASHBOARD_TEMPLATES.map(item => item.id)).toEqual(ids);
  });
  it("combines bilingual query, industry group, and favorites without dropping metadata", () => {
    const item = DASHBOARD_TEMPLATES[0]!;
    const group = resolveTemplateGroup(item.domainId)!.id;
    expect(searchDashboardTemplates("en-US", ` ${item.en.toUpperCase()} `, group, [item.id])).toContain(item);
    expect(searchDashboardTemplates("zh-CN", item.zh, group, [])).toContain(item);
    const favoritesInGroup = searchDashboardTemplates("zh-CN", "", group, [item.id]);
    expect(favoritesInGroup[0]).toBe(item);
  });
  it("matches derived feature tags and ranks packs first in the recommended order", () => {
    const tagged = searchDashboardTemplates("zh-CN", "含排行榜", "all", []);
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((template) => template.tags?.some((tag) => tag.zh === "含排行榜"))).toBe(true);
    const ranked = rankRecommendedTemplates(DASHBOARD_TEMPLATES);
    const firstStandard = ranked.findIndex((template) => resolveTemplateTier(template.id) === "standard");
    expect(ranked.slice(0, firstStandard).every((template) => resolveTemplateTier(template.id) === "industry")).toBe(true);
    expect(ranked.length).toBe(DASHBOARD_TEMPLATES.length);
  });
});
