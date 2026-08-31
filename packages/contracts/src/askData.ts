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

export interface AskDataQueryPlanningResult {
  status: "ready" | "needs-input";
  plan?: AskDataQueryPlan;
  issues: AskDataPlanningIssue[];
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
