import { describe, expect, it } from "vitest";
import type { AiDataBinding, AiDataBindingRunRecord } from "@bim-studio/contracts";
import { failAiDataBindingRun, startAiDataBindingRun, succeedAiDataBindingRun } from "./aiDataBindingRunRecorder.js";

const binding: AiDataBinding = {
  id: "binding", projectId: "project", name: "SOC", datasetId: "dataset", capabilityId: "battery.model.predict",
  status: "active", features: [], window: { rows: 20 }, trigger: { type: "interval", seconds: 10 },
  quality: { minimumSamples: 1, maxAgeSeconds: 60, maximumMissingRate: 0.1 }, retry: { maxAttempts: 3, backoffSeconds: 5 },
  output: { type: "record" }, revision: 3, createdAt: "now", updatedAt: "now",
};

describe("AI data binding run recorder", () => {
  it("stores source evidence and only scalar output summaries", async () => {
    const records: AiDataBindingRunRecord[] = [];
    const store = { saveAiDataBindingRun: async (_projectId: string, run: AiDataBindingRunRecord) => { records.push(structuredClone(run)); return run; } } as never;
    const run = await startAiDataBindingRun(store, binding);
    const completed = await succeedAiDataBindingRun(store, run, binding, {
      datasetId: "dataset", datasetName: "BMS", connectionId: "c", connectionType: "kafka", rowCount: 20,
      fieldKeys: ["voltage"], sampledAt: "now", durationMs: 2,
    }, { summary: "SOC 正常", finalSoc: 82.1, curve: Array(10).fill(1) });
    expect(completed).toMatchObject({ status: "succeeded", bindingRevision: 3, input: { sampleCount: 20 }, output: { summary: "SOC 正常", metrics: { summary: "SOC 正常", finalSoc: 82.1 } } });
    expect(completed.output?.metrics).not.toHaveProperty("curve");
    expect(records).toHaveLength(2);
  });

  it("records compact retryable failures", async () => {
    const store = { saveAiDataBindingRun: async (_projectId: string, run: AiDataBindingRunRecord) => run } as never;
    const run = await startAiDataBindingRun(store, binding, 2);
    const failed = await failAiDataBindingRun(store, run, new Error("upstream\n offline"));
    expect(failed).toMatchObject({ status: "failed", attempt: 2, failure: { message: "upstream offline", retryable: true } });
  });
});
