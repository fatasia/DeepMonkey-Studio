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
}
