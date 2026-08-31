import { describe, expect, it } from "vitest";
import type { AiDataBinding } from "@bim-studio/contracts";
import { prepareAiBindingSnapshot } from "./aiDataBindingRuntime.js";

const binding: AiDataBinding = {
  id: "binding-1", projectId: "project-1", name: "电池状态", datasetId: "dataset-1",
  capabilityId: "battery.model.predict", status: "active",
  entity: { keyField: "cell", selectedKeys: ["cell-2"] },
  time: { field: "time", order: "asc" },
  features: [{ modelField: "voltage", sourceField: "voltageMv", scale: 0.001, required: true }],
  window: { rows: 2 }, trigger: { type: "interval", seconds: 30 },
  quality: { minimumSamples: 2, maxAgeSeconds: 60, maximumMissingRate: 0 },
  retry: { maxAttempts: 3, backoffSeconds: 5 }, output: { type: "record" },
  revision: 1, createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
};

describe("AI data binding runtime", () => {
  it("filters an entity, orders and windows records, then maps units", () => {
    const now = Date.parse("2026-08-31T00:01:00.000Z");
    const result = prepareAiBindingSnapshot(binding, {
      records: [
        { cell: "cell-2", time: "2026-08-31T00:00:50.000Z", voltageMv: 3300 },
        { cell: "cell-1", time: "2026-08-31T00:00:55.000Z", voltageMv: 3400 },
        { cell: "cell-2", time: "2026-08-31T00:00:40.000Z", voltageMv: 3200 },
      ],
      numericRows: [],
      evidence: { datasetId: "dataset-1", datasetName: "BMS", connectionId: "c", connectionType: "kafka", rowCount: 3, fieldKeys: [], sampledAt: "", durationMs: 1 },
    }, now);
    expect(result.records).toHaveLength(2);
    expect(Number(result.records[0]?.voltage)).toBeCloseTo(3.2);
    expect(Number(result.records[1]?.voltage)).toBeCloseTo(3.3);
    expect(result.numericRows).toEqual(result.records);
  });

  it("rejects stale or incomplete required inputs", () => {
    const snapshot = {
      records: [{ cell: "cell-2", time: "2026-08-31T00:00:00.000Z", voltageMv: 3300 }], numericRows: [],
      evidence: { datasetId: "dataset-1", datasetName: "BMS", connectionId: "c", connectionType: "http" as const, rowCount: 1, fieldKeys: [], sampledAt: "", durationMs: 1 },
    };
    expect(() => prepareAiBindingSnapshot({ ...binding, quality: { ...binding.quality, minimumSamples: 1 } }, snapshot, Date.parse("2026-08-31T00:02:00.000Z"))).toThrow("数据已过期");
    expect(() => prepareAiBindingSnapshot({ ...binding, quality: { ...binding.quality, minimumSamples: 2 } }, snapshot, Date.parse("2026-08-31T00:00:30.000Z"))).toThrow("有效样本不足");
  });
});
