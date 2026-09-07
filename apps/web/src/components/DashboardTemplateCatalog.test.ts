import { describe, expect, it } from "vitest";
import type { DashboardPageDocument } from "@bim-studio/contracts";
import { createDashboardTemplateNodes, DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";

const page = { id: "dashboard", name: "Dashboard", width: 1920, height: 1080, viewportFit: "contain", nodes: [] } as DashboardPageDocument;

describe("DashboardTemplateCatalog", () => {
  it("offers more than one hundred industry, view, and layout combinations", () => {
    expect(DASHBOARD_TEMPLATES.length).toBeGreaterThanOrEqual(100);
    expect(DASHBOARD_TEMPLATES).toHaveLength(120);
    expect(new Set(DASHBOARD_TEMPLATES.map((template) => template.id)).size).toBe(DASHBOARD_TEMPLATES.length);
    expect(new Set(DASHBOARD_TEMPLATES.map((template) => template.domainId)).size).toBe(12);
    expect(new Set(DASHBOARD_TEMPLATES.map((template) => template.viewId)).size).toBe(10);
    for (const industry of ["production", "logistics", "energy", "safety", "maintenance", "construction"]) {
      expect(DASHBOARD_TEMPLATES.filter((template) => template.domainId === industry)).toHaveLength(10);
    }
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
