import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardPageDocument } from "@bim-studio/contracts";
import { createDashboardTemplateNodes } from "./dashboardTemplateCatalog";
import { DashboardWidgetView } from "./DashboardWidgetRuntime";
import { INDUSTRY_TEMPLATE_PACKS, packPageSample } from "./industryTemplatePackCatalog";
import { applyPackPageSample } from "./industryPackSampleApply";
import { buildDashboardSampleMetric } from "./dashboardSampleMetrics";
import { analyzeDashboardMetric } from "./dashboardAnalytics";

const PAGE: DashboardPageDocument = { id: "page:render", name: "测试页", width: 1920, height: 1080, viewportFit: "contain", nodes: [] };
const callbacks = { onDataInteraction: () => {}, onAnimationStart: () => {}, onAnimationEnd: () => {} };

describe("industry pack actual widget rendering", () => {
  it("五页真实渲染 table、全部字段和记录，而不是只验证 report 配置", () => {
    const pack = INDUSTRY_TEMPLATE_PACKS[0]!;
    for (const locale of ["zh-CN", "en-US"] as const) for (const page of pack.pages) {
      const spec = packPageSample(pack, page);
      const nodes = applyPackPageSample(createDashboardTemplateNodes(locale, PAGE, page.templateId, 0), locale, spec, pack.linkageFieldZh, pack.linkageFieldEn);
      const widget = nodes[8]!.widget;
      const metric = buildDashboardSampleMetric(widget, widget.sampleData!.rows);
      const html = renderToStaticMarkup(<DashboardWidgetView locale={locale} widget={widget} metric={metric} compact={false} {...callbacks} />);
      expect(html).toContain("dashboard-report-table");
      expect(html).not.toContain("dashboard-rank-widget");
      for (const column of spec.columns) expect(html).toContain(`${column.key}<i>`);
      for (const row of widget.sampleData!.rows) {
        for (const value of Object.values(row)) if (typeof value === "string") expect(html).toContain(`>${value}</td>`);
      }
      expect(html).toContain('>CSV</button>');
      expect(html).toContain('>Excel</button>');
      expect(metric.rows).toEqual(widget.sampleData!.rows);
    }
  });

  it("数字卡只改变展示，原始平均值、示例行和图表计算均不变", () => {
    const pack = INDUSTRY_TEMPLATE_PACKS[0]!;
    const page = pack.pages.find(candidate => candidate.templateId === "maintenance-operations")!;
    const spec = packPageSample(pack, page);
    const nodes = applyPackPageSample(createDashboardTemplateNodes("zh-CN", PAGE, page.templateId, 0), "zh-CN", spec, pack.linkageFieldZh, pack.linkageFieldEn);
    const widget = nodes.find(node => node.widget.type === "value" && node.widget.analysis?.aggregation === "average")!.widget;
    const rows = widget.sampleData!.rows.filter(row => row["产线"] === "B");
    const metric = buildDashboardSampleMetric(widget, rows);
    const before = structuredClone(metric);
    const html = renderToStaticMarkup(<DashboardWidgetView locale="zh-CN" widget={widget} metric={metric} compact={false} {...callbacks} />);
    expect(html).toContain('title="2.6666666666666665">2.67<small>');
    expect(metric).toEqual(before);
    expect(metric.value).toBe(8 / 3);
    const chart = nodes[7]!.widget;
    expect(analyzeDashboardMetric(chart, buildDashboardSampleMetric(chart, chart.sampleData!.rows)).series[0]!.values).toEqual([14, 7, 6.5]);
  });
});
