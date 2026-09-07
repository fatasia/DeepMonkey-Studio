import type {
  DashboardDataWidgetConfig,
  DashboardDataWidgetNode,
  DashboardPageDocument,
  SceneDashboardWidgetType,
  WidgetFrame,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import type { DashboardTemplateDefinition } from "./dashboardTemplateTypes";
import { applyProductionSample } from "./dashboardProductionSample";

export function buildDashboardTemplateNodes(
  locale: AppLocale,
  page: DashboardPageDocument,
  template: DashboardTemplateDefinition,
  startZ: number,
): DashboardDataWidgetNode[] {
  const geometry = dashboardGeometry(page, template.layout.primaryRatio);
  const nodes: DashboardDataWidgetNode[] = [];
  const title = tr(locale, template.zh, template.en);
  const groupId = `group:${crypto.randomUUID()}`;
  const make = createNodeFactory(locale, template, title, groupId, startZ, nodes);

  nodes.push(make("decoration", title, geometry.title, {
    content: title,
    decorationStyle: template.layout.decorationStyle,
    backgroundOpacity: 0,
    key: `${template.id}.title`,
  }));
  nodes.push(make("filter", tr(locale, template.filterZh, template.filterEn), geometry.filter, {
    key: `${template.id}.filter`,
    filterField: template.filterField,
    options: [
      tr(locale, "全部", "All"),
      tr(locale, "正常", "Normal"),
      tr(locale, "预警", "Warning"),
      tr(locale, "告警", "Alarm"),
    ],
  }));
  template.metrics.forEach((metric, index) => {
    nodes.push(make(template.layout.metricTypes[index]!, tr(locale, metric.zh, metric.en), geometry.metrics[index]!, {
      key: `${template.id}.${metric.dataKey}`,
      unit: metric.unit,
      ...(index === 3 ? alertRules(template.id) : {}),
    }));
  });
  nodes.push(make(template.layout.primaryChart, tr(locale, template.layout.primaryTitleZh, template.layout.primaryTitleEn), geometry.primary, {
    key: `${template.id}.primary.${template.layout.primaryChart}`,
    ...(template.layout.primaryChart === "combo" ? { chart: { showLegend: true } } : {}),
  }));
  nodes.push(make(template.layout.secondaryChart, tr(locale, template.layout.secondaryTitleZh, template.layout.secondaryTitleEn), geometry.secondary, {
    key: `${template.id}.secondary.${template.layout.secondaryChart}`,
  }));
  nodes.push(make(template.layout.detailType, tr(locale, template.detailZh, template.detailEn), geometry.detail, {
    key: `${template.id}.detail.${template.layout.detailType}`,
  }));

  return template.id === "production" ? applyProductionSample(nodes, locale) : nodes;
}

function dashboardGeometry(page: DashboardPageDocument, primaryRatio: number) {
  const margin = Math.min(40, Math.max(12, Math.floor(Math.min(page.width, page.height) * 0.04)));
  const gap = Math.min(20, Math.max(8, Math.floor(margin / 2)));
  const width = Math.max(1, page.width - margin * 2);
  const metricWidth = (width - gap * 3) / 4;
  const titleHeight = Math.min(60, Math.max(28, page.height * 0.09));
  const metricTop = margin + titleHeight + gap;
  const metricHeight = Math.max(1, Math.min(94, page.height * 0.14));
  const chartTop = metricTop + metricHeight + gap;
  const availableHeight = Math.max(1, page.height - chartTop - margin);
  const chartHeight = Math.max(1, Math.min(360, availableHeight * 0.62));
  const primaryWidth = width * primaryRatio - gap / 2;
  const bottom = chartTop + chartHeight + gap;
  const filterWidth = Math.min(210, Math.max(1, width * 0.25));
  const filterHeight = Math.min(40, titleHeight);
  return {
    title: { x: margin, y: margin, width: width - filterWidth - gap, height: titleHeight },
    filter: { x: margin + width - filterWidth, y: margin, width: filterWidth, height: filterHeight },
    metrics: Array.from({ length: 4 }, (_, index) => ({
      x: margin + index * (metricWidth + gap),
      y: metricTop,
      width: metricWidth,
      height: metricHeight,
    })),
    primary: { x: margin, y: chartTop, width: primaryWidth, height: chartHeight },
    secondary: { x: margin + primaryWidth + gap, y: chartTop, width: width - primaryWidth - gap, height: chartHeight },
    detail: { x: margin, y: bottom, width, height: Math.max(1, page.height - bottom - margin) },
  };
}

function createNodeFactory(
  locale: AppLocale,
  template: DashboardTemplateDefinition,
  title: string,
  groupId: string,
  startZ: number,
  nodes: DashboardDataWidgetNode[],
) {
  return (
    type: SceneDashboardWidgetType,
    name: string,
    frame: WidgetFrame,
    patch: Partial<DashboardDataWidgetConfig> = {},
  ): DashboardDataWidgetNode => ({
    id: `widget:${crypto.randomUUID()}`,
    name: `${name}-${nodes.length + 1}`,
    kind: "data-widget",
    groupId,
    groupName: title,
    frame,
    zIndex: startZ + nodes.length,
    widget: {
      ...defaultTemplateWidget(locale, type),
      title: name,
      color: template.accent,
      backgroundColor: template.surface,
      backgroundOpacity: 0.9,
      ...patch,
    },
  });
}

function alertRules(templateId: string): Partial<DashboardDataWidgetConfig> {
  return {
    conditionalRules: [
      {
        id: `${templateId}-alert`,
        operator: "gt",
        value: 0,
        color: "#ff7d6b",
        backgroundColor: "#381a1b",
        fontWeight: 700,
        animation: "pulse",
      },
    ],
  };
}

function defaultTemplateWidget(locale: AppLocale, type: SceneDashboardWidgetType): DashboardDataWidgetConfig {
  const labels: Partial<Record<SceneDashboardWidgetType, [string, string]>> = {
    value: ["指标卡", "Metric"],
    "digital-flip": ["数字翻牌", "Digital flip"],
    progress: ["进度", "Progress"],
    status: ["状态", "Status"],
    line: ["折线图", "Line"],
    area: ["面积图", "Area"],
    bar: ["柱状图", "Bar"],
    combo: ["双轴组合图", "Dual-axis combo"],
    scatter: ["散点图", "Scatter"],
    radar: ["雷达图", "Radar"],
    gauge: ["仪表盘", "Gauge"],
    sankey: ["桑基图", "Sankey"],
    sunburst: ["旭日图", "Sunburst"],
    treemap: ["矩形树图", "Treemap"],
    map: ["地图", "Map"],
    funnel: ["漏斗图", "Funnel"],
    rank: ["排行", "Ranking"],
    table: ["明细表", "Table"],
    "scroll-table": ["滚动表格", "Scrolling table"],
    filter: ["筛选器", "Filter"],
    decoration: ["标题", "Title"],
  };
  const label = labels[type] ?? ["组件", "Widget"];
  return {
    title: tr(locale, label[0], label[1]),
    key: type,
    type,
    unit: "",
    color: "#d7aa4d",
    backgroundColor: "#171f22",
    backgroundOpacity: 0.9,
    ...(type === "progress" || type === "gauge" ? { min: 0, max: 100 } : {}),
  };
}
