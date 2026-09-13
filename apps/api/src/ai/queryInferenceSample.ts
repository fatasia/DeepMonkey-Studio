import type { DataDatasetRecord } from "@bim-studio/contracts";
import { createDataQueryPlan, executeDataQuery } from "@bim-studio/data-query-plugin";

/** 样例数据只在请求内存中，使用正式计划校验与聚合引擎，不创建项目数据源。 */
export function runQuerySample(projectId: string) {
  const dataset: DataDatasetRecord = {
    id: "local-query-sample", projectId, connectionId: "local-sample", name: "合成设备温度",
    refreshSeconds: 0, createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    fields: [{ key: "device", label: "设备", type: "string" }, { key: "temperature", label: "温度", type: "number", unit: "°C" }],
  };
  const rows = [{ device: "设备 A", temperature: 40 }, { device: "设备 A", temperature: 44 }, { device: "设备 B", temperature: 52 }, { device: "设备 B", temperature: 60 }];
  const planned = createDataQueryPlan({ datasetId: dataset.id, fields: ["device", "temperature"], groupBy: ["device"], aggregations: [{ operator: "avg", field: "temperature", as: "mean_temperature" }], limit: 20 }, dataset);
  if (!planned.plan) throw new Error("内置查询样例计划未通过校验");
  const result = executeDataQuery(planned.plan, { dataset, fields: dataset.fields, rows, durationMs: 0 });
  return {
    engine: "data-query-plan-and-read", input: { dataset, rows }, output: { plan: planned.plan, result },
    metrics: [{ label: "输入行数", labelEn: "Input rows", value: String(rows.length) }, { label: "分组结果", labelEn: "Groups", value: String(result.returnedRows) }],
  };
}
