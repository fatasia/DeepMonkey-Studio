import { describe, expect, it, vi } from "vitest";
import type { AiDataBinding, DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import { BatteryInferenceScheduler } from "./batteryInferenceScheduler.js";

const now = new Date().toISOString();
const dataset: DataDatasetRecord = {
  id: "bms", projectId: "project-1", connectionId: "kafka", name: "BMS 遥测", refreshSeconds: 1,
  fields: [{ key: "voltage", label: "电压", type: "number" }], createdAt: now, updatedAt: now,
};
const connection: DataConnectionRecord = {
  id: "kafka", projectId: "project-1", name: "BMS Kafka", type: "kafka", enabled: true, config: {}, createdAt: now, updatedAt: now,
};
const binding: AiDataBinding = {
  id: "battery-binding", projectId: "project-1", name: "SOC 周期估计", datasetId: dataset.id,
  capabilityId: "battery.model.predict", status: "active", parameters: { model: "socformer", chemistry: "lfp" },
  features: [{ modelField: "voltage", sourceField: "voltage", required: true }], window: { rows: 2 },
  trigger: { type: "interval", seconds: 10 }, quality: { minimumSamples: 1, maxAgeSeconds: 60, maximumMissingRate: 0 },
  retry: { maxAttempts: 3, backoffSeconds: 2 }, output: { type: "record" }, revision: 1, createdAt: now, updatedAt: now,
};

describe("battery inference scheduler", () => {
  it("runs the formal plugin route on the configured interval and keeps evidence", async () => {
    const invoke = vi.fn(async () => ({ status: "completed" as const, decisionStatus: "production" as const, output: { finalSoc: 72 }, evidence: [], warnings: [] }));
    const onResult = vi.fn();
    const scheduler = new BatteryInferenceScheduler({
      store: {
        listProjects: () => [{ id: "project-1" }], listAiDataBindings: () => [binding],
        listDataConnections: () => [connection],
        saveAiDataBindingRun: async (_projectId: string, run: unknown) => run,
      } as never,
      host: { invoke } as never,
      dataQuerySource: {
        getDataset: () => dataset,
        readDataset: async () => ({ dataset, fields: dataset.fields, rows: [{ voltage: 3.3 }, { voltage: 3.4 }], durationMs: 4 }),
      } as never,
      onResult,
    });
    await scheduler.tick(1_000);
    await scheduler.tick(5_000);
    await scheduler.tick(11_000);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith("battery.model.predict", expect.objectContaining({ input: expect.objectContaining({ model: "socformer", records: [{ voltage: 3.3 }, { voltage: 3.4 }] }) }));
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ sourceEvidence: expect.objectContaining({ connectionType: "kafka" }) }));
  });

  it("skips manual bindings and isolates repeated failures", async () => {
    const invoke = vi.fn(async () => { throw new Error("model offline"); });
    const onError = vi.fn();
    let current = { ...binding, trigger: { type: "manual" } as const };
    const scheduler = new BatteryInferenceScheduler({
      store: {
        listProjects: () => [{ id: "project-1" }], listAiDataBindings: () => [current], listDataConnections: () => [connection],
        saveAiDataBindingRun: async (_projectId: string, run: unknown) => run,
      } as never,
      host: { invoke } as never,
      dataQuerySource: { getDataset: () => dataset, readDataset: async () => ({ dataset, fields: dataset.fields, rows: [{ voltage: 3.3 }], durationMs: 1 }) } as never,
      onError,
    });
    await scheduler.tick(1_000);
    expect(invoke).not.toHaveBeenCalled();
    current = { ...binding, trigger: { type: "interval", seconds: 1 } };
    await scheduler.tick(2_000);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), binding.id);
  });
});
