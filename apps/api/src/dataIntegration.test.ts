import { describe, expect, it } from "vitest";
import type { DataDatasetRecord } from "@bim-studio/contracts";
import { applyComputedFields, inferFieldType } from "./dataIntegration.js";

const dataset: DataDatasetRecord = {
  id: "dataset:computed",
  projectId: "project:1",
  connectionId: "connection:1",
  name: "设备数据",
  refreshSeconds: 5,
  fields: [],
  computedFields: [
    { id: "field:fahrenheit", key: "fahrenheit", label: "华氏温度", type: "number", formula: "ROUND(temperature * 1.8 + 32, 1)" },
    { id: "field:state", key: "state", label: "运行状态", type: "string", formula: "IF(running, 'RUN', 'STOP')" },
    { id: "field:summary", key: "summary", label: "摘要", type: "string", formula: "CONCAT(device_id, ':', state)" }
  ],
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z"
};

describe("computed dataset fields", () => {
  it("evaluates formulas in declared order without mutating source rows", () => {
    const rows = [{ device_id: "AHU-01", temperature: 23.25, running: true }];
    const result = applyComputedFields(rows, dataset);
    expect(result).toEqual([{ device_id: "AHU-01", temperature: 23.25, running: true, fahrenheit: 73.9, state: "RUN", summary: "AHU-01:RUN" }]);
    expect(rows[0]).not.toHaveProperty("fahrenheit");
  });

  it("does not mistake equipment identifiers for dates", () => {
    expect(inferFieldType("AHU-01")).toBe("string");
    expect(inferFieldType("2026-08-25T17:00:00+08:00")).toBe("datetime");
  });
});
