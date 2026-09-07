import { describe, expect, it } from "vitest";
import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";
import { searchDashboardTemplates } from "./dashboardTemplateSearch";

describe("template search", () => {
  it("preserves the catalog and returns recoverable empty searches", () => {
    const ids = DASHBOARD_TEMPLATES.map(item => item.id);
    expect(searchDashboardTemplates("zh-CN", "not-a-template-91832", "all", [])).toEqual([]);
    expect(searchDashboardTemplates("zh-CN", "", "favorites", [])).toEqual([]);
    expect(searchDashboardTemplates("zh-CN", " ", "all", [])).toHaveLength(ids.length);
    expect(DASHBOARD_TEMPLATES.map(item => item.id)).toEqual(ids);
  });
  it("combines bilingual query, category, and favorites without dropping metadata", () => {
    const item = DASHBOARD_TEMPLATES[0]!;
    expect(searchDashboardTemplates("en-US", ` ${item.en.toUpperCase()} `, item.categoryEn, [item.id])).toContain(item);
    expect(searchDashboardTemplates("zh-CN", item.zh, "favorites", [item.id])).toEqual([item]);
  });
});
