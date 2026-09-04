import type { JsonValue } from "./application.js";
import type { DataDatasetField } from "./data.js";

/**
 * 语义层合同的统一聚合枚举。
 * 现有三处历史枚举（看板 DashboardAggregation、管道 aggregate 节点、AskData）通过
 * LEGACY_AGGREGATION_ALIASES 映射到本枚举；调用点迁移在 S1-003 进行，本文件只提供统一口径。
 */
export type SemanticAggregation = "count" | "countDistinct" | "sum" | "avg" | "min" | "max";

export const SEMANTIC_AGGREGATIONS: readonly SemanticAggregation[] = ["count", "countDistinct", "sum", "avg", "min", "max"];

/** 历史聚合字面量 → 统一枚举；"none" 表示"不聚合"，没有统一映射，映射表中省略。 */
export const LEGACY_AGGREGATION_ALIASES: Readonly<Record<string, SemanticAggregation>> = {
  // 看板 DashboardAggregation（dashboard.ts）
  count: "count",
  "distinct-count": "countDistinct",
  sum: "sum",
  average: "avg",
  minimum: "min",
  maximum: "max",
  // 管道 aggregate 节点（data.ts）中与看板重名的值已覆盖，额外值：avg/min/max
  avg: "avg",
  min: "min",
  max: "max",
};

/** 指标口径默认过滤；算子与 AskData 查询计划保持一致。 */
export interface SemanticMetricFilter {
  fieldKey: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in";
  value: JsonValue;
}

/** 集中定义的指标：一次定义，2D 绑定、联动、钻取与 AskData 共用同一口径。 */
export interface SemanticMetricDefinition {
  id: string;
  /** 模型内唯一标识符，供绑定引用。 */
  key: string;
  label: string;
  /** 业务口径的人话描述，编辑者与 AskData 共同可读。 */
  description?: string;
  /** 基础字段；与 expression 二选一。count/countDistinct 可省略。 */
  fieldKey?: string;
  /** 公式引擎表达式；与 fieldKey 二选一。 */
  expression?: string;
  aggregation: SemanticAggregation;
  unit?: string;
  decimalPlaces?: number;
  defaultFilters?: SemanticMetricFilter[];
}

export interface SemanticDimensionLevel {
  fieldKey: string;
  label: string;
}

/** 维度：可含有序钻取层级（浅→深），层级供钻取与级联参数使用。 */
export interface SemanticDimensionDefinition {
  id: string;
  key: string;
  label: string;
  /** 主字段；无层级时即钻取目标。 */
  fieldKey: string;
  hierarchy?: SemanticDimensionLevel[];
}

export interface SemanticParameterOption {
  value: JsonValue;
  label: string;
}

/** 页面级参数；parentKey 构成级联链（无环），选项可来自维度去重值。 */
export interface SemanticParameterDefinition {
  id: string;
  key: string;
  label: string;
  type: "text" | "number" | "datetime" | "option";
  parentKey?: string;
  optionsSource?:
    | { kind: "static"; options: SemanticParameterOption[] }
    | { kind: "dimension"; dimensionKey: string };
  defaultValue?: JsonValue;
}

export interface SemanticModelSource {
  kind: "dataset" | "pipeline";
  id: string;
  /**
   * 管道源的显式字段清单。管道输出字段目前只能在运行时推导，静态校验要求
   * 管道源填写本清单；数据集源忽略本字段，字段来自 dataset.fields + computedFields。
   */
  fields?: DataDatasetField[];
}

/** 语义模型：数据产品之上的指标/维度/参数集中定义。 */
export interface SemanticModelRecord {
  id: string;
  /** 项目内唯一名称。 */
  name: string;
  description?: string;
  source: SemanticModelSource;
  metrics: SemanticMetricDefinition[];
  dimensions: SemanticDimensionDefinition[];
  parameters: SemanticParameterDefinition[];
  /** 每次保存 +1；AskData 与绑定按 revision 失效缓存，对齐 datasetRevision 模式。 */
  revision: number;
  createdAt: string;
  updatedAt: string;
}
