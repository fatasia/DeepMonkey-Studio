import type {
  DashboardDataWidgetConfig,
  SceneDashboardWidgetType,
} from "@bim-studio/contracts";

export type DashboardMetricRole =
  | "volume"
  | "efficiency"
  | "quality"
  | "risk"
  | "asset"
  | "energy"
  | "flow"
  | "cost"
  | "service"
  | "carbon";

export type DashboardTemplateLayoutId =
  | "executive-trend"
  | "throughput-board"
  | "quality-explorer"
  | "risk-map"
  | "asset-health"
  | "energy-mix"
  | "supply-flow"
  | "service-funnel"
  | "finance-portfolio"
  | "sustainability-scorecard";

export interface DashboardTemplateMetric {
  role: DashboardMetricRole;
  zh: string;
  en: string;
  unit: string;
  dataKey: string;
}

export interface DashboardTemplateDomain {
  id: string;
  nameZh: string;
  nameEn: string;
  categoryZh: string;
  categoryEn: string;
  accent: string;
  surface: string;
  metrics: Record<DashboardMetricRole, Omit<DashboardTemplateMetric, "role" | "dataKey">>;
}

/** 特征标签:必须从布局结构诚实推导(图型/明细形态/告警能力),禁止虚构功能。 */
export interface DashboardTemplateTag {
  zh: string;
  en: string;
}

/** 商用分层:industry=被行业深度包引用的模板,standard=标准模板。展示文案由解析模块统一给出。 */
export type DashboardTemplateTier = "industry" | "standard";

export interface DashboardTemplateView {
  id: string;
  nameZh: string;
  nameEn: string;
  goalZh: string;
  goalEn: string;
  metricRoles: readonly [DashboardMetricRole, DashboardMetricRole, DashboardMetricRole, DashboardMetricRole];
  filterField: string;
  filterZh: string;
  filterEn: string;
  detailZh: string;
  detailEn: string;
  layoutId: DashboardTemplateLayoutId;
}

export interface DashboardTemplateLayout {
  id: DashboardTemplateLayoutId;
  primaryChart: SceneDashboardWidgetType;
  secondaryChart: SceneDashboardWidgetType;
  primaryTitleZh: string;
  primaryTitleEn: string;
  secondaryTitleZh: string;
  secondaryTitleEn: string;
  detailType: "rank" | "table" | "scroll-table";
  metricTypes: readonly [
    DashboardMetricWidgetType,
    DashboardMetricWidgetType,
    DashboardMetricWidgetType,
    DashboardMetricWidgetType,
  ];
  primaryRatio: number;
  decorationStyle: NonNullable<DashboardDataWidgetConfig["decorationStyle"]>;
}

type DashboardMetricWidgetType = "value" | "digital-flip" | "progress" | "status";

export interface DashboardTemplateDefinition {
  id: string;
  domainId: string;
  viewId: string;
  zh: string;
  en: string;
  categoryZh: string;
  categoryEn: string;
  descriptionZh: string;
  descriptionEn: string;
  goalZh: string;
  goalEn: string;
  metrics: readonly [
    DashboardTemplateMetric,
    DashboardTemplateMetric,
    DashboardTemplateMetric,
    DashboardTemplateMetric,
  ];
  filterField: string;
  filterZh: string;
  filterEn: string;
  detailZh: string;
  detailEn: string;
  layout: DashboardTemplateLayout;
  accent: string;
  surface: string;
  /** 特征标签(2-4 个,由目录工厂从布局结构推导),供卡片展示与搜索联动。 */
  tags?: readonly DashboardTemplateTag[];
  /** 静态默认 standard;行业包归属由 dashboardTemplateTiers 按行业包目录动态解析,展示一律用解析结果。 */
  tier?: DashboardTemplateTier;
  /** 主题套件 id(外部参考 visuals 页"主题套件"聚合层的对标,见 dashboardTemplateSuites)。 */
  suite?: string;
}
