import type { DataDatasetField } from "./data.js";

export type AskDataFilterOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in";
export type AskDataAggregationOperator = "count" | "sum" | "avg" | "min" | "max";

export interface AskDataFilter {
  field: string;
  operator: AskDataFilterOperator;
  value: unknown;
}

export interface AskDataAggregation {
  operator: AskDataAggregationOperator;
  field?: string;
  as: string;
}

/** AI 或页面只能提交该受限草案，不能提交任意 SQL。 */
export interface AskDataQueryPlanInput {
  datasetId: string;
  fields: string[];
  filters?: AskDataFilter[];
  timeWindow?: { field: string; start?: string; end?: string };
  groupBy?: string[];
  aggregations?: AskDataAggregation[];
  sort?: { field: string; direction: "asc" | "desc" };
  limit?: number;
}

export interface AskDataQueryPlan extends AskDataQueryPlanInput {
  schemaVersion: 1;
  datasetName: string;
  datasetRevision: string;
  resolvedFields: DataDatasetField[];
  limit: number;
  fingerprint: string;
}

export interface AskDataPlanningIssue {
  path: string;
  code: "dataset-not-found" | "field-not-found" | "field-type" | "invalid-window" | "invalid-plan";
  message: string;
}

/**
 * H-C5-T1：needs-input 且歧义在数据集选择时，服务端随响应透传的项目目录候选。
 * 只来自服务端真实目录（不虚构）；字段刻意收敛为浏览所需最小集。
 */
export interface AskDataQueryDatasetCandidate {
  id: string;
  name: string;
  updatedAt: string;
}

export interface AskDataQueryPlanningResult {
  status: "ready" | "needs-input";
  plan?: AskDataQueryPlan;
  issues: AskDataPlanningIssue[];
  /** 仅 needs-input 且歧义为 dataset-not-found 时由服务端目录透传；ready 或其他歧义不携带。 */
  candidates?: AskDataQueryDatasetCandidate[];
}

export interface AskDataQueryReadResult {
  planFingerprint: string;
  datasetId: string;
  datasetName: string;
  columns: DataDatasetField[];
  rows: Array<Record<string, unknown>>;
  matchedRows: number;
  returnedRows: number;
  truncated: boolean;
  sourceDurationMs: number;
  evidenceFingerprint: string;
}

export interface AskDataQueryDraftResult {
  planning: AskDataQueryPlanningResult;
  model: string;
  providerId: string;
}
