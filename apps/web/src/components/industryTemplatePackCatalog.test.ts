import { describe, expect, it } from "vitest";
import type { DashboardPageDocument } from "@bim-studio/contracts";
import { createDashboardTemplateNodes, DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";
import { INDUSTRY_TEMPLATE_PACKS, packPageSample, packPageTemplate } from "./industryTemplatePackCatalog";
import { applyPackPageSample } from "./industryPackSampleApply";
import { validateIndustryTemplatePack } from "./industryTemplatePackTypes";
import { MANUFACTURING_PACK_SAMPLES } from "./industryPackManufacturing";
import { analyzeDashboardMetric, buildDashboardReport, formatDashboardReportValue } from "./dashboardAnalytics";
import { buildDashboardSampleMetric } from "./dashboardSampleMetrics";

const KNOWN_IDS = DASHBOARD_TEMPLATES.map((template) => template.id);
const PAGE: DashboardPageDocument = { id: "page:test", name: "测试页", width: 1920, height: 1080, viewportFit: "contain", nodes: [] };

describe("industryTemplatePackCatalog", () => {
  it("目录加载即校验通过，包与示例规格一一对应", () => {
    expect(INDUSTRY_TEMPLATE_PACKS.length).toBeGreaterThanOrEqual(1);
    for (const pack of INDUSTRY_TEMPLATE_PACKS) {
      expect(() => validateIndustryTemplatePack(pack, KNOWN_IDS)).not.toThrow();
      for (const page of pack.pages) {
        expect(packPageSample(pack, page)).toBeDefined();
      }
    }
  });

  it("示例行长度与列定义一致，且联动维度是第一列并在每行出现", () => {
    for (const spec of Object.values(MANUFACTURING_PACK_SAMPLES)) {
      const linkageKey = spec.columns[0]!.key;
      expect(spec.filterKey.length).toBeGreaterThan(0);
      expect(spec.filterOptions.length).toBeGreaterThan(1);
      for (const row of spec.rowValues) {
        expect(row.length).toBe(spec.columns.length);
        expect(row[0]).toEqual(expect.any(String));
        expect(String(row[0]).trim().length).toBeGreaterThan(0);
        expect(spec.filterOptions).toContain(row[0]);
      }
      // 每页示例行数在合同限额内（100 行）。
      expect(spec.rowValues.length).toBeLessThanOrEqual(100);
    }
  });

  it("同包所有页面共享同一联动参数键与联动字段", () => {
    const pack = INDUSTRY_TEMPLATE_PACKS[0]!;
    const linkageField = pack.linkageFieldZh;
    for (const page of pack.pages) {
      expect(packPageSample(pack, page).filterKey).toBe(pack.linkageParameterKey);
      expect(packPageSample(pack, page).columns[0]!.key).toBe(linkageField);
    }
  });

  it("包工作流首尾相接覆盖全部页面且使用包级参数", () => {
    const pack = INDUSTRY_TEMPLATE_PACKS[0]!;
    const visited = new Set<string>([pack.entryTemplateId]);
    for (const step of pack.workflows) {
      expect(step.linkageParameterKey).toBe(pack.linkageParameterKey);
      visited.add(step.from);
      visited.add(step.to);
    }
    expect([...visited].sort()).toEqual(pack.pages.map((page) => page.templateId).sort());
  });

  it("校验器拒绝坏包：孤立页面、缺失模板、工作流断链", () => {
    const base = INDUSTRY_TEMPLATE_PACKS[0]!;
    const brokenPage = { ...base, id: "broken-1", pages: [...base.pages, { templateId: "operations", nameZh: "孤立页", nameEn: "Orphan" }] };
    expect(() => validateIndustryTemplatePack(brokenPage, KNOWN_IDS)).toThrow(/不在工作流可达集内/);
    const missingTemplate = { ...base, id: "broken-2", pages: [...base.pages.slice(1)] , entryTemplateId: "not-exists" };
    expect(() => validateIndustryTemplatePack(missingTemplate, KNOWN_IDS)).toThrow(/入口页不在页集|页面模板不存在/);
    const emptyFlow = { ...base, id: "broken-3", workflows: [] };
    expect(() => validateIndustryTemplatePack(emptyFlow, KNOWN_IDS)).toThrow(/至少一条/);
  });

  it("applyPackPageSample 为 9 节点绑定示例：筛选器用包级 key，指标/图表/明细各就位", () => {
    const pack = INDUSTRY_TEMPLATE_PACKS[0]!;
    for (const page of pack.pages) {
      const nodes = createDashboardTemplateNodes("zh-CN", PAGE, page.templateId, 0);
      const applied = applyPackPageSample(nodes, "zh-CN", packPageSample(pack, page), pack.linkageFieldZh, pack.linkageFieldEn);
      expect(applied).toHaveLength(9);
      const [titleNode, filterNode, ...rest] = applied;
      expect(titleNode!.widget.content).toContain("制造设备运行包");
      expect(filterNode!.widget.key).toBe(pack.linkageParameterKey);
      expect(filterNode!.widget.filterField).toBe(pack.linkageFieldZh);
      expect(filterNode!.widget.options![0]).toBe("全部");
      const metrics = rest.slice(0, 4);
      for (const metric of metrics) {
        expect(metric.widget.type).toBe("value");
        expect(metric.widget.sampleData?.rows.length).toBeGreaterThan(0);
        expect(new Set(metric.widget.sampleData!.rows.map((row) => row[pack.linkageFieldZh])).size).toBeGreaterThan(1);
      }
      const charts = rest.slice(4, 6);
      for (const [index, chart] of charts.entries()) {
        expect(["bar", "line", "area", "pie", "combo"]).toContain(chart.widget.type);
        const spec = packPageSample(pack, page);
        expect(chart.widget.analysis?.dimensionField).toBe((index === 0 ? spec.primary : spec.secondary).dimensionField);
      }
      const detail = rest[6]!;
      // report 配置不会改变渲染分支；旧测试只验数据，漏掉工厂继承的 rank。
      expect(detail.widget.type).toBe("table");
      expect(detail.widget.report?.mode).toBe("detail");
      // 数据组件共享页面级 sourceId，支持整组改数。
      const sourceIds = new Set(applied.slice(2).map((node) => node.widget.sampleData?.sourceId));
      expect(sourceIds.size).toBe(1);
    }
  });

  it("重复应用生成独立 sourceId，重复导入不共享示例快照", () => {
    const pack = INDUSTRY_TEMPLATE_PACKS[0]!;
    const page = pack.pages[0]!;
    const spec = packPageSample(pack, page);
    const first = applyPackPageSample(createDashboardTemplateNodes("zh-CN", PAGE, page.templateId, 0), "zh-CN", spec, pack.linkageFieldZh, pack.linkageFieldEn);
    const second = applyPackPageSample(createDashboardTemplateNodes("zh-CN", PAGE, page.templateId, 0), "zh-CN", spec, pack.linkageFieldZh, pack.linkageFieldEn);
    expect(first[2]!.widget.sampleData!.sourceId).not.toBe(second[2]!.widget.sampleData!.sourceId);
    expect(first[2]!.id).not.toBe(second[2]!.id);
  });

  it("包示例在英文 locale 下标题本地化，数据列键保持稳定", () => {
    const pack = INDUSTRY_TEMPLATE_PACKS[0]!;
    const page = pack.pages[0]!;
    const applied = applyPackPageSample(createDashboardTemplateNodes("en-US", PAGE, page.templateId, 0), "en-US", packPageSample(pack, page), pack.linkageFieldZh, pack.linkageFieldEn);
    expect(applied[0]!.widget.content).toContain("Manufacturing pack");
    expect(applied[1]!.widget.title).toBe("Line");
    // 数据列键是数据层标识，不随界面语言漂移；筛选字段与行数据一致。
    const dataKey = packPageSample(pack, page).columns[0]!.key;
    expect(applied[1]!.widget.filterField).toBe(dataKey);
    expect(Object.keys(applied[2]!.widget.sampleData!.rows[0]!)[0]).toBe(dataKey);
  });

  it("每页 KPI 使用自身业务标题/单位，不继承布局工厂的旧指标", () => {
    const pack = INDUSTRY_TEMPLATE_PACKS[0]!;
    for (const locale of ["zh-CN", "en-US"] as const) for (const page of pack.pages) {
      const spec = packPageSample(pack, page);
      const nodes = applyPackPageSample(createDashboardTemplateNodes(locale, PAGE, page.templateId, 0), locale, spec, pack.linkageFieldZh, pack.linkageFieldEn);
      spec.metrics.forEach((metric, index) => {
        const widget = nodes[index + 2]!.widget;
        expect(widget.title).toBe(locale === "zh-CN" ? metric.titleZh : metric.titleEn);
        expect(widget.unit).toBe(locale === "zh-CN" ? metric.unit : metric.unitEn ?? metric.unit);
        expect(widget.analysis?.measureField).toBe(metric.field);
        expect(widget.sampleData!.rows.every(row => typeof row[metric.field] === "number")).toBe(true);
      });
      expect(nodes[8]!.widget.unit).toBe("");
    }
  });

  it("质量图展示九个批次的百分比而不是按产线相加到 300%", () => {
    const spec = MANUFACTURING_PACK_SAMPLES["production-quality"]!;
    const nodes = applyPackPageSample(createDashboardTemplateNodes("zh-CN", PAGE, spec.templateId, 0), "zh-CN", spec, "产线", "Line");
    const widget = nodes[7]!.widget;
    const metric = buildDashboardSampleMetric(widget, widget.sampleData!.rows);
    const analysis = analyzeDashboardMetric(widget, metric);
    expect(analysis.categories).toHaveLength(9);
    expect(analysis.categories[0]).toBe("批次A-0901");
    expect(analysis.series[0]!.values).toEqual([98.6, 98.3, 98.6, 96, 94.2, 95.2, 97, 96.5, 97]);
    expect(analyzeDashboardMetric(widget, buildDashboardSampleMetric(widget, widget.sampleData!.rows.filter(row => row["产线"] === "B"))).categories).toHaveLength(3);
  });

  it("维护类型图真实按工单类型聚合，明细保留非整数工时", () => {
    const spec = MANUFACTURING_PACK_SAMPLES["maintenance-operations"]!;
    const nodes = applyPackPageSample(createDashboardTemplateNodes("zh-CN", PAGE, spec.templateId, 0), "zh-CN", spec, "产线", "Line");
    const widget = nodes[7]!.widget;
    const analysis = analyzeDashboardMetric(widget, buildDashboardSampleMetric(widget, widget.sampleData!.rows));
    expect(analysis.categories).toEqual(["抢修", "检修", "保养"]);
    expect(analysis.series[0]!.values).toEqual([14, 7, 6.5]);
    const detail = nodes[8]!.widget;
    const report = buildDashboardReport(detail, buildDashboardSampleMetric(detail, detail.sampleData!.rows));
    expect(report.rows.find(row => row["工单"] === "WO-106")?.["工时"]).toBe(1.5);
    expect(formatDashboardReportValue(1.5, detail, "zh-CN")).toBe("1.50");
  });

  it("跨页产量、良率与活动告警有一致的演示口径", () => {
    const rows = (id: string) => {
      const spec = MANUFACTURING_PACK_SAMPLES[id]!;
      return spec.rowValues.map(values => Object.fromEntries(spec.columns.map((column, index) => [column.key, values[index]])));
    };
    const quality = rows("production-quality");
    const assets = rows("maintenance-asset");
    const alarms = rows("production-risk");
    for (const overview of rows("production")) {
      const batches = quality.filter(row => row["产线"] === overview["产线"]);
      const output = batches.reduce((sum, row) => sum + Number(row["产量"]), 0);
      const defects = batches.reduce((sum, row) => sum + Number(row["不良数"]), 0);
      expect(output).toBe(overview["产量"]);
      expect(Number(((output - defects) / output * 100).toFixed(1))).toBe(overview["良率"]);
      expect(assets.filter(row => row["产线"] === overview["产线"]).reduce((sum, row) => sum + Number(row["告警"]), 0)).toBe(overview["告警"]);
      expect(alarms.filter(row => row["产线"] === overview["产线"]).reduce((sum, row) => sum + Number(row["活动"]), 0)).toBe(overview["告警"]);
    }
    for (const batch of quality) {
      expect(Number(((Number(batch["产量"]) - Number(batch["不良数"])) / Number(batch["产量"]) * 100).toFixed(1))).toBe(batch["良率"]);
      expect(batch["验收达标"]).toBe(Number(Number(batch["良率"]) >= 96.5));
    }
  });
});
