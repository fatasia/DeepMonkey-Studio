import type {
  DashboardDataWidgetConfig,
  DashboardDataWidgetNode,
  DashboardSampleData,
  SceneDashboardWidgetType,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export type SampleCellValue = string | number | boolean | null;

/** 一个示例列的类型定义；数值列参与求和/平均，文本列做维度。 */
export interface PackSampleColumn {
  key: string;
  type: "string" | "number" | "boolean";
}

/** 图表页签名：主图/次图共用行数据，仅维度与度量不同。 */
export interface PackSampleChart {
  type: Extract<SceneDashboardWidgetType, "bar" | "line" | "area" | "pie" | "combo">;
  dimensionField: string;
  measureField?: string;
  titleZh: string;
  titleEn: string;
  unit?: string;
  unitEn?: string;
  aggregation?: "sum" | "average";
}

interface PackSampleMetric {
  field: string;
  aggregation: "sum" | "average";
  titleZh: string;
  titleEn: string;
  unit: string;
  unitEn?: string;
}

/**
 * 一页行业包示例：布局工厂固定产出 9 节点（标题/筛选/4指标/主图/次图/明细），
 * 本规格按节点序号补示例数据；行数据必须包含包级联动字段，值域跨页一致。
 */
export interface PackPageSampleSpec {
  templateId: string;
  titleZh: string;
  titleEn: string;
  /** 联动筛选器共享 key；同包所有页一致才会跨页联动。 */
  filterKey: string;
  filterOptions: readonly string[];
  metrics: readonly [
    PackSampleMetric, PackSampleMetric, PackSampleMetric, PackSampleMetric,
  ];
  primary: PackSampleChart;
  secondary: PackSampleChart;
  detailTitleZh: string;
  detailTitleEn: string;
  columns: readonly PackSampleColumn[];
  /** 行数据按 columns 顺序给值的紧凑数组；构造函数负责展开成对象。 */
  rowValues: readonly (readonly SampleCellValue[])[];
}

/**
 * 把页面示例应用到布局工厂产出的节点。数据组件共享页面级 sourceId（整组改数），
 * 筛选器使用包级固定 key（跨页联动），复制页面时由既有 isolate 逻辑分别处理。
 * 单模板插入遗留的字段（如 applyProductionSample）在此被逐项覆盖，不残留。
 */
export function applyPackPageSample(
  nodes: DashboardDataWidgetNode[],
  locale: AppLocale,
  spec: PackPageSampleSpec,
  linkageFieldZh: string,
  linkageFieldEn: string,
): DashboardDataWidgetNode[] {
  if (nodes.length !== 9) {
    throw new Error(`行业包示例期望 9 个模板节点，实际 ${nodes.length}: ${spec.templateId}`);
  }
  const keys = spec.columns.map((column) => column.key);
  const rows: DashboardSampleData["rows"] = spec.rowValues.map((values) => {
    if (values.length !== keys.length) {
      throw new Error(`行业包示例行长度不一致: ${spec.templateId}`);
    }
    return Object.fromEntries(keys.map((key, index) => [key, values[index]!]));
  });
  const sourceId = `pack-page:${spec.templateId}:${crypto.randomUUID()}`;
  const sample = (measureField: string, aggregation: "sum" | "average" | "none"): Partial<DashboardDataWidgetConfig> => ({
    sampleData: { sourceId, columns: spec.columns.map((column) => ({ ...column })), rows: structuredClone(rows) },
    field: measureField,
    analysis: { measureField, aggregation },
  });
  return nodes.map((node, index) => {
    const widget = { ...node.widget };
    delete widget.conditionalRules;
    // 示例模板使用应用主题；不覆盖用户画布中已保存的颜色。
    delete widget.color;
    delete widget.backgroundColor;
    if (index === 0) {
      widget.content = widget.title = tr(locale, spec.titleZh, spec.titleEn);
    } else if (index === 1) {
      widget.key = spec.filterKey;
      widget.title = tr(locale, linkageFieldZh, linkageFieldEn);
      widget.filterField = spec.columns[0]!.key;
      widget.options = [...spec.filterOptions];
    } else if (index >= 2 && index <= 5) {
      const metric = spec.metrics[index - 2]!;
      Object.assign(widget, sample(metric.field, metric.aggregation));
      widget.type = "value";
      widget.title = tr(locale, metric.titleZh, metric.titleEn);
      widget.unit = tr(locale, metric.unit, metric.unitEn ?? metric.unit);
    } else if (index === 6 || index === 7) {
      const chart = index === 6 ? spec.primary : spec.secondary;
      const aggregation = chart.aggregation ?? "sum";
      Object.assign(widget, sample(chart.measureField ?? chart.dimensionField, aggregation));
      widget.type = chart.type;
      widget.title = tr(locale, chart.titleZh, chart.titleEn);
      widget.unit = tr(locale, chart.unit ?? "", chart.unitEn ?? chart.unit ?? "");
      widget.analysis = { measureField: chart.measureField ?? chart.dimensionField, aggregation, dimensionField: chart.dimensionField };
      widget.chart = { showLegend: chart.type === "pie" || chart.type === "combo", showDataLabels: true };
    } else {
      Object.assign(widget, sample(spec.columns[spec.columns.length - 1]!.key, "none"));
      widget.type = "table";
      widget.title = tr(locale, spec.detailTitleZh, spec.detailTitleEn);
      widget.unit = "";
      // 明细含工时与百分比，不能沿用整数精度丢失业务数值。
      widget.report = { mode: "detail", pageSize: 10, stripedRows: true, valueFormat: "number", decimalPlaces: 2 };
    }
    return { ...node, groupName: tr(locale, spec.titleZh, spec.titleEn), widget };
  });
}
