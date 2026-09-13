import type {
  DashboardDataWidgetNode,
  DashboardPageDocument,
  SceneDashboardWidgetType,
} from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { buildDashboardTemplateNodes } from "./dashboardTemplateLayoutBuilder";
import { DASHBOARD_TEMPLATE_DOMAINS } from "./dashboardTemplateDomainPacks";
import { DASHBOARD_TEMPLATE_LAYOUTS } from "./dashboardTemplateLayouts";
import type {
  DashboardTemplateDefinition,
  DashboardTemplateDomain,
  DashboardTemplateLayout,
  DashboardTemplateMetric,
  DashboardTemplateTag,
  DashboardTemplateView,
} from "./dashboardTemplateTypes";
import { resolveTemplateSuite } from "./dashboardTemplateSuites";
import { DASHBOARD_TEMPLATE_VIEWS } from "./dashboardTemplateViews";

/** 保留 string 兼容性，调用方可保存任意模板 ID 并在缺失时安全回退。 */
export type DashboardTemplateKind = string;

/** 图型标签双语对照:值即布局里真实出现的组件类型,禁止无中生有的能力标签。须在目录求值前声明。 */
const CHART_TAG_LABELS: Partial<Record<SceneDashboardWidgetType, [string, string]>> = {
  combo: ["双轴组合", "Dual-axis combo"],
  area: ["面积趋势", "Area trend"],
  line: ["负荷曲线", "Line trend"],
  bar: ["渐变柱图", "Gradient bars"],
  scatter: ["散点分布", "Scatter"],
  radar: ["雷达评分", "Radar"],
  gauge: ["仪表盘", "Gauge"],
  sankey: ["桑基流向", "Sankey flow"],
  sunburst: ["旭日结构", "Sunburst"],
  treemap: ["矩形树图", "Treemap"],
  map: ["地图态势", "Map"],
  funnel: ["漏斗转化", "Funnel"],
  pie: ["占比环形", "Donut"],
};

const DETAIL_TAG_LABELS: Record<DashboardTemplateLayout["detailType"], [string, string]> = {
  table: ["含明细表", "Data table"],
  rank: ["含排行榜", "Ranking"],
  "scroll-table": ["滚动表格", "Scrolling table"],
};

/**
 * 2026-09-12 质量审计裁删的"凑数模板":这些域没有真实的供应链业务,
 * "供需协同"视角的指标组合(受理流量/出入流量/门诊流量冒充供需流量)明显空洞,
 * 保留会有凑数感(诚实条款:见 docs/delivery-report-2026-09-12.md 裁删清单)。
 */
const PRUNED_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  "government-supply",
  "education-supply",
  "healthcare-supply",
]);

/**
 * 模板由行业域、业务视角和布局组成。行业数据键和目标均不同，布局由视角选择，
 * 因此不会通过换色或改名制造伪差异。
 */
export const DASHBOARD_TEMPLATES: readonly DashboardTemplateDefinition[] =
  DASHBOARD_TEMPLATE_DOMAINS.flatMap((domain) =>
    DASHBOARD_TEMPLATE_VIEWS.map((view) => createTemplate(domain, view)),
  ).filter((template) => !PRUNED_TEMPLATE_IDS.has(template.id));

export function createDashboardTemplateNodes(
  locale: AppLocale,
  page: DashboardPageDocument,
  kind: DashboardTemplateKind,
  startZ: number,
): DashboardDataWidgetNode[] {
  const template = DASHBOARD_TEMPLATES.find((candidate) => candidate.id === kind)
    ?? DASHBOARD_TEMPLATES[0]!;
  return buildDashboardTemplateNodes(locale, page, template, startZ);
}

function createTemplate(
  domain: DashboardTemplateDomain,
  view: DashboardTemplateView,
): DashboardTemplateDefinition {
  const layout = findLayout(view.layoutId);
  const metrics = createMetrics(domain, view);

  return {
    id: view.id === "executive" ? domain.id : `${domain.id}-${view.id}`,
    domainId: domain.id,
    viewId: view.id,
    zh: `${domain.nameZh} · ${view.nameZh}`,
    en: `${domain.nameEn} · ${view.nameEn}`,
    categoryZh: domain.categoryZh,
    categoryEn: domain.categoryEn,
    descriptionZh: `${view.goalZh} 重点指标：${metrics.map((metric) => metric.zh).join("、")}。`,
    descriptionEn: `${view.goalEn} Focus metrics: ${metrics.map((metric) => metric.en).join(", ")}.`,
    goalZh: view.goalZh,
    goalEn: view.goalEn,
    metrics,
    filterField: view.filterField,
    filterZh: view.filterZh,
    filterEn: view.filterEn,
    detailZh: view.detailZh,
    detailEn: view.detailEn,
    layout,
    accent: domain.accent,
    surface: domain.surface,
    tags: createTemplateTags(layout),
    tier: "standard",
    ...(resolveTemplateSuite(domain.id) ? { suite: resolveTemplateSuite(domain.id)!.id } : {}),
  };
}

/** 特征标签 3-4 个:主图 + 次图 + 明细形态 + (布局含状态位时的)告警能力,全部来自布局结构。 */
function createTemplateTags(layout: DashboardTemplateLayout): readonly DashboardTemplateTag[] {
  const labels: (readonly [string, string])[] = [
    ...(CHART_TAG_LABELS[layout.primaryChart] ? [CHART_TAG_LABELS[layout.primaryChart]!] : []),
    ...(CHART_TAG_LABELS[layout.secondaryChart] ? [CHART_TAG_LABELS[layout.secondaryChart]!] : []),
    DETAIL_TAG_LABELS[layout.detailType],
  ];
  if (layout.metricTypes.includes("status")) labels.push(["状态告警", "Alert rules"]);
  return labels.map(([zh, en]) => ({ zh, en }));
}

function createMetrics(
  domain: DashboardTemplateDomain,
  view: DashboardTemplateView,
): DashboardTemplateDefinition["metrics"] {
  const [first, second, third, fourth] = view.metricRoles;
  return [
    createMetric(domain, view, first),
    createMetric(domain, view, second),
    createMetric(domain, view, third),
    createMetric(domain, view, fourth),
  ];
}

function createMetric(
  domain: DashboardTemplateDomain,
  view: DashboardTemplateView,
  role: DashboardTemplateMetric["role"],
): DashboardTemplateMetric {
  return {
    role,
    ...domain.metrics[role],
    dataKey: `${domain.id}.${view.id}.${role}`,
  };
}

function findLayout(id: DashboardTemplateView["layoutId"]): DashboardTemplateLayout {
  const layout = DASHBOARD_TEMPLATE_LAYOUTS.find((candidate) => candidate.id === id);
  if (!layout) {
    throw new Error(`缺少仪表板布局: ${id}`);
  }
  return layout;
}
