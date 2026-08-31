import { describe, expect, it } from "vitest";
import type { AskDataQueryPlanInput, DataDatasetPreview, DataDatasetRecord } from "@bim-studio/contracts";
import { createDataQueryPlan, executeDataQuery, validateDataQueryPlan } from "./queryEngine.js";

const dataset: DataDatasetRecord = {
  id: "telemetry", projectId: "project", connectionId: "simulation", name: "设备遥测", refreshSeconds: 10,
  fields: [
    { key: "device", label: "设备", type: "string" },
    { key: "timestamp", label: "时间", type: "datetime" },
    { key: "temperature", label: "温度", type: "number", unit: "°C" },
  ],
  createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
};

describe("controlled data query", () => {
  it("plans and executes grouped aggregates with evidence", () => {
    const input: AskDataQueryPlanInput = {
      datasetId: dataset.id, fields: ["device", "temperature"], groupBy: ["device"],
      aggregations: [{ operator: "avg", field: "temperature", as: "avgTemperature" }],
      sort: { field: "avgTemperature", direction: "desc" }, limit: 10,
    };
    const planned = createDataQueryPlan(input, dataset);
    expect(planned.status).toBe("ready");
    const result = executeDataQuery(planned.plan!, preview());
    expect(result.rows).toEqual([{ device: "A", avgTemperature: 35 }, { device: "B", avgTemperature: 20 }]);
    expect(result.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("blocks unknown fields and nonnumeric aggregation", () => {
    expect(createDataQueryPlan({ datasetId: dataset.id, fields: ["missing"] }, dataset).issues[0]?.code).toBe("field-not-found");
    expect(createDataQueryPlan({ datasetId: dataset.id, fields: ["device"], aggregations: [{ operator: "avg", field: "device", as: "average" }] }, dataset).issues[0]?.code).toBe("field-type");
    expect(createDataQueryPlan({ datasetId: dataset.id, fields: ["temperature"], filters: [{ field: "temperature", operator: "gt", value: "hot" }] }, dataset).issues[0]?.message).toContain("类型不一致");
  });

  it("rejects a modified or stale plan before reading", () => {
    const plan = createDataQueryPlan({ datasetId: dataset.id, fields: ["temperature"] }, dataset).plan!;
    expect(validateDataQueryPlan({ ...plan, limit: 500 }, dataset).status).toBe("needs-input");
    expect(validateDataQueryPlan(plan, { ...dataset, updatedAt: "new" }).status).toBe("needs-input");
  });
});

function preview(): DataDatasetPreview {
  return {
    dataset, fields: dataset.fields, durationMs: 3,
    rows: [
      { device: "A", timestamp: "2026-08-30T00:00:00Z", temperature: 30 },
      { device: "A", timestamp: "2026-08-30T01:00:00Z", temperature: 40 },
      { device: "B", timestamp: "2026-08-30T00:00:00Z", temperature: 20 },
    ],
  };
}
