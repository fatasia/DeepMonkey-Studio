import { describe, expect, it } from "vitest";
import type { DashboardPageDocument } from "@bim-studio/contracts";
import { createDashboardTemplateNodes, DASHBOARD_TEMPLATES } from "./dashboardTemplateCatalog";
import { resolveTemplateGroup } from "./dashboardTemplateGroups";
import { DASHBOARD_TEMPLATE_SUITES, suiteStats } from "./dashboardTemplateSuites";
import { resolveTemplateTier } from "./dashboardTemplateTiers";
import { INDUSTRY_TEMPLATE_PACKS } from "./industryTemplatePackCatalog";

const page = { id: "dashboard", name: "Dashboard", width: 1920, height: 1080, viewportFit: "contain", nodes: [] } as DashboardPageDocument;

describe("DashboardTemplateCatalog", () => {
  it("offers curated industry, view, and layout combinations across thirty-two domains", () => {
    // 2026-09-12 质量审计:30 域裁删餐饮/文娱 2 同质域 + 3 个"供需协同"凑数模板,300 → 277。
    // 2026-09-12 波次 B:新增电力交易/化工安全/冷链物流/会展活动 4 域(+40),317 = 32 域 × 10 视角 − 3 个已裁删模板
    // (规格写作 320 系按 32×10 整算;按"裁删不回退、宁缺毋滥"原则,已裁删的 3 个凑数模板不予恢复)。
    expect(DASHBOARD_TEMPLATES.length).toBeGreaterThanOrEqual(100);
    expect(DASHBOARD_TEMPLATES).toHaveLength(317);
    expect(new Set(DASHBOARD_TEMPLATES.map((template) => template.id)).size).toBe(DASHBOARD_TEMPLATES.length);
    expect(new Set(DASHBOARD_TEMPLATES.map((template) => template.domainId)).size).toBe(32);
    expect(new Set(DASHBOARD_TEMPLATES.map((template) => template.viewId)).size).toBe(10);
    for (const industry of ["production", "logistics", "energy", "safety", "maintenance", "construction",
      "retail", "finance", "telecom", "transport", "tourism", "agriculture",
      "power-grid", "petrochemical", "automotive", "semiconductor", "pharma", "realestate",
      "environment", "water", "campus", "quality", "warehouse", "carbon", "operations",
      "power-trading", "chem-safety", "cold-chain", "expo"]) {
      expect(DASHBOARD_TEMPLATES.filter((template) => template.domainId === industry)).toHaveLength(10);
    }
    // 无供应链业务的域裁掉"供需协同"凑数模板后为 9 视角(诚实少数,不凑整)。
    for (const trimmed of ["healthcare", "government", "education"]) {
      expect(DASHBOARD_TEMPLATES.filter((template) => template.domainId === trimmed)).toHaveLength(9);
    }
    expect(DASHBOARD_TEMPLATES.some((template) => template.domainId === "catering")).toBe(false);
    expect(DASHBOARD_TEMPLATES.some((template) => template.domainId === "sports")).toBe(false);
    expect(DASHBOARD_TEMPLATES.some((template) => template.id === "government-supply")).toBe(false);
  });
  it("keeps every domain inside exactly one semantic group and one theme suite, with honest feature tags", () => {
    for (const template of DASHBOARD_TEMPLATES) {
      const group = resolveTemplateGroup(template.domainId);
      expect(group, `missing group for ${template.domainId}`).toBeDefined();
      expect(template.suite, `missing suite for ${template.domainId}`).toBeTruthy();
      expect(template.tags?.length).toBeGreaterThanOrEqual(3);
      expect(template.tags?.length).toBeLessThanOrEqual(4);
      // 标签必须可追溯到布局结构:明细形态至少占一位。
      expect(template.tags?.some((tag) => tag.zh.includes(template.layout.detailType === "table" ? "表" : template.layout.detailType === "rank" ? "排行" : "表格"))).toBe(true);
    }
    expect(new Set(DASHBOARD_TEMPLATES.map((template) => resolveTemplateGroup(template.domainId)!.id)).size).toBeLessThanOrEqual(9);
  });
  it("marks industry-pack templates and keeps the rest standard", () => {
    const packReferenced = new Set(INDUSTRY_TEMPLATE_PACKS.flatMap((pack) => pack.pages.map((page) => page.templateId)));
    const tiered = DASHBOARD_TEMPLATES.filter((template) => resolveTemplateTier(template.id) === "industry");
    expect(packReferenced.size).toBeGreaterThan(0);
    expect(tiered.length).toBeGreaterThan(0);
    expect(tiered.length).toBeLessThan(DASHBOARD_TEMPLATES.length);
    for (const template of tiered) expect(packReferenced.has(template.id)).toBe(true);
  });
  it("organizes all thirty-two domains into theme suites with honest stats", () => {
    for (const suite of DASHBOARD_TEMPLATE_SUITES) {
      const stats = suiteStats(suite, DASHBOARD_TEMPLATES);
      expect(stats.count).toBeGreaterThan(0);
      expect(stats.chartKinds).toBeGreaterThan(0);
      expect(stats.chartKinds).toBeLessThanOrEqual(7);
    }
    const covered = new Set(DASHBOARD_TEMPLATE_SUITES.flatMap((suite) => suite.domainIds));
    expect(covered.size).toBe(32);
    expect(new Set(DASHBOARD_TEMPLATES.map((template) => template.suite)).size).toBe(DASHBOARD_TEMPLATE_SUITES.length);
  });

  it.each(DASHBOARD_TEMPLATES)("builds editable $id nodes inside the page", (template) => {
    const nodes = createDashboardTemplateNodes("zh-CN", page, template.id, 5);
    expect(nodes).toHaveLength(9);
    expect(nodes[0]?.widget.type).toBe("decoration");
    expect(nodes[1]?.widget).toMatchObject({ type: "filter", filterField: template.id === "production" ? "产线" : template.filterField });
    expect(nodes.some((node) => node.widget.type === (template.id === "production" ? "bar" : template.layout.primaryChart))).toBe(true);
    expect(nodes.some((node) => node.widget.type === template.layout.secondaryChart)).toBe(true);
    expect(new Set(nodes.map((node) => node.groupId)).size).toBe(1);
    expect(nodes[0]?.groupId).toMatch(/^group:/);
    expect(new Set(nodes.map((node) => node.groupName))).toEqual(new Set([template.zh]));
    expect(nodes.every((node) => node.frame.x >= 0 && node.frame.y >= 0 && node.frame.x + node.frame.width <= page.width && node.frame.y + node.frame.height <= page.height)).toBe(true);
    expect(nodes.map((node) => node.zIndex)).toEqual(nodes.map((_, index) => index + 5));
    expect(nodes.every((node) => node.kind === "data-widget" && !node.locked && Boolean(node.name) && Boolean(node.widget.title))).toBe(true);
    expect(new Set(nodes.map((node) => node.widget.key)).size).toBe(nodes.length);
    expect(new Set(template.metrics.map((metric) => metric.dataKey)).size).toBe(4);
  });

  it("ships alert semantics in each generated plan", () => {
    const safety = createDashboardTemplateNodes("zh-CN", page, "safety-risk", 0);
    const alert = safety.find((node) => node.widget.conditionalRules?.length);
    expect(alert?.widget).toMatchObject({
      conditionalRules: [{ operator: "gt", value: 0, animation: "pulse" }],
    });
  });

  it("ships one editable production sample without shared identities or overlapping headers", () => {
    const first = createDashboardTemplateNodes("zh-CN", page, "production", 0);
    const second = createDashboardTemplateNodes("zh-CN", page, "production", 0);
    expect(first[0]?.widget.content).toContain("示例");
    expect(first.filter(node => node.widget.sampleData)).toHaveLength(7);
    expect(new Set(first.slice(2).map(node => node.widget.sampleData?.sourceId)).size).toBe(1);
    expect(first[2]?.widget.sampleData?.sourceId).not.toBe(second[2]?.widget.sampleData?.sourceId);
    expect(first[0]!.frame.x + first[0]!.frame.width).toBeLessThan(first[1]!.frame.x);
    expect(first[2]?.widget.sampleData?.rows[0]?.["产量"]).toBe(1080);
    expect(first[3]?.widget.analysis?.aggregation).toBe("average");
  });
});
