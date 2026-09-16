import type { DashboardDataWidgetConfig, DataDatasetField } from "@bim-studio/contracts";

interface MetricSample {
  time: number;
  value: number;
}
export interface DashboardMetric {
  value: unknown;
  samples: MetricSample[];
  rows?: Array<Record<string, unknown>>;
  semanticWidget?: DashboardDataWidgetConfig;
  semanticError?: string;
  /** 参数查询草稿只重算本次取数快照，不修改正式筛选或触发额外网络读取。 */
  semanticSource?: { rows: Record<string, unknown>[]; fields: readonly DataDatasetField[] };
}
