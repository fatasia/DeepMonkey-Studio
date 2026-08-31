import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BatteryOnnxEquivalenceManifest } from "@bim-studio/contracts";
import type { BatteryOnnxDeployment } from "./batteryOnnxDeployment.js";
import { prepareBatteryMformerInput, type BatteryMformerModelMetadata } from "./batteryMformerPreprocessing.js";
import { completeBatteryMformerPrediction } from "./batteryMformerPostprocessing.js";
import { BatteryMformerOnnxRuntime } from "./batteryMformerOnnxRuntime.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const model: BatteryMformerModelMetadata = {
  earlyCycles: 10,
  curveLength: 8,
  conditionEmbeddingSize: 4,
  predictionLength: 20,
  eolThreshold: 0.8,
  confidenceGate: { passed: true, test_mape: 1.2, test_mae: 0.01, training_datasets: ["CALB"] },
};

describe("BatteryMFormer ONNX runtime", () => {
  it("preserves multimodal masks, curve tensors and observed health", () => {
    const prepared = prepareBatteryMformerInput(batteryInput(), model);
    expect(prepared.curves).toHaveLength(10 * 4 * 8);
    expect(prepared.curveMask).toEqual(Float32Array.from({ length: 10 }, () => 1));
    expect(prepared.sohInput).toHaveLength(10);
    expect(prepared.cycleFeatures).toHaveLength(20);
    expect([...prepared.curves].every(Number.isFinite)).toBe(true);
    expect([...prepared.cycleFeatures].every(Number.isFinite)).toBe(true);
    expect(prepared.observedSohFull).toHaveLength(12);
  });

  it("keeps right-censored lifetime as a lower bound", () => {
    const input = batteryInput();
    input.records[0] = { ...input.records[0], rulEventObserved: "false", lifetimeLowerBoundCycles: 30 };
    const prepared = prepareBatteryMformerInput(input, model);
    const result = completeBatteryMformerPrediction(
      Array.from({ length: 20 }, (_, index) => 1 - index / 19),
      input,
      prepared,
      model,
      "exact-batterylife",
      "batterymformer-expanded",
    );
    expect(result).toMatchObject({ predictedCycleLife: 30, confidence: "high", modelVersion: "batterymformer-expanded" });
    expect((result.warnings as string[]).join(" ")).toContain("真实寿命仅知大于等于");
  });

  it("rejects observations outside the exported trajectory range", () => {
    const input = batteryInput();
    input.records = input.records.map((record) => ({ ...record, cycle: record.cycle + 100 }));
    const prepared = prepareBatteryMformerInput(input, model);
    expect(() => completeBatteryMformerPrediction(
      Array.from({ length: 20 }, () => 0.5), input, prepared, model, "centroid", "batterymformer-expanded",
    )).toThrow("观测循环全部超出模型轨迹范围");
  });

  it("loads the signed embedding bundle and runs the five-input session", async () => {
    const fixture = await runtimeFixture();
    const run = vi.fn(async () => ({
      soh_trajectory: { data: Float32Array.from({ length: 20 }, (_, index) => 1 - index / 19) },
    }));
    const runtime = new BatteryMformerOnnxRuntime(fixture.deployment, {
      createSession: async () => ({
        inputNames: ["curves", "curve_mask", "condition_embedding", "soh_input", "cycle_features"],
        outputNames: ["soh_trajectory"],
        run,
      }),
    });
    const result = await runtime.predict(batteryInput());
    expect(result).toMatchObject({ confidence: "high", modelVersion: "batterymformer-expanded" });
    const feeds = run.mock.calls[0]?.[0] as Record<string, { data: Float32Array }>;
    expect([...feeds.condition_embedding!.data]).toEqual([1, 2, 3, 4]);
  });

  it("rejects a modified condition embedding bundle", async () => {
    const fixture = await runtimeFixture();
    await writeFile(fixture.bundlePath, Buffer.alloc(32, 7));
    const runtime = new BatteryMformerOnnxRuntime(fixture.deployment, {
      createSession: async () => ({
        inputNames: ["curves", "curve_mask", "condition_embedding", "soh_input", "cycle_features"],
        outputNames: ["soh_trajectory"],
        run: async () => ({ soh_trajectory: { data: Float32Array.from({ length: 20 }, () => 0.5) } }),
      }),
    });
    await expect(runtime.predict(batteryInput())).rejects.toThrow("工况嵌入哈希");
  });
});

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), "battery-mformer-runtime-"));
  cleanup.push(root);
  const artifactPath = join(root, "batterymformer.onnx");
  const runtimeAdapterPath = join(root, "batterymformer.runtime-adapter.json");
  const bundlePath = join(root, "batterymformer.condition-embeddings.f32");
  const embedding = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const bundle = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  const adapter = {
    schemaVersion: 1,
    modelId: "battery.batterymformer",
    modelVersion: "batterymformer-expanded",
    kind: "batterymformer-multimodal-v1",
    session: { inputs: ["curves", "curve_mask", "condition_embedding", "soh_input", "cycle_features"], output: "soh_trajectory" },
    model,
    conditionEmbeddings: {
      fileName: "batterymformer.condition-embeddings.f32",
      sha256: digest(bundle),
      sizeBytes: bundle.length,
      rows: 2,
      columns: 4,
      keys: ["CALB_fixture.pkl", "CALB_other.pkl"],
      fallbackPrefix: "CALB_",
    },
  };
  const adapterBytes = Buffer.from(JSON.stringify(adapter));
  await writeFile(artifactPath, "fixture");
  await writeFile(runtimeAdapterPath, adapterBytes);
  await writeFile(bundlePath, bundle);
  const manifest = approvedManifest(adapterBytes.length);
  const deployment: BatteryOnnxDeployment = {
    enabled: true,
    requestedModels: ["batterymformer"],
    manifests: [manifest],
    models: { batterymformer: { manifest, artifactPath, runtimeAdapterPath } },
    diagnostics: [],
  };
  return { root, bundlePath, deployment };
}

function approvedManifest(adapterBytes: number): BatteryOnnxEquivalenceManifest {
  return {
    schemaVersion: 1,
    modelId: "battery.batterymformer",
    source: { modelVersion: "batterymformer-expanded", checkpointSha256: "a".repeat(64) },
    artifact: { fileName: "batterymformer.onnx", sha256: "b".repeat(64), sizeBytes: 7, opset: 18, precision: "fp32" },
    runtimeAdapter: { fileName: "batterymformer.runtime-adapter.json", sha256: "d".repeat(64), sizeBytes: adapterBytes, schemaVersion: 1 },
    contract: { input: "multimodal-v1", output: "trajectory-v1", preprocessing: "mformer-pre-v1", postprocessing: "mformer-post-v1" },
    validation: {
      outputs: [
        { task: "soh", samples: 29, maxAbsoluteError: 0, meanAbsoluteError: 0, allowedMaxAbsoluteError: 0.001, allowedMeanAbsoluteError: 0.0001 },
        { task: "rul", samples: 29, maxAbsoluteError: 0, meanAbsoluteError: 0, allowedMaxAbsoluteError: 0.001, allowedMeanAbsoluteError: 0.0001 },
      ],
      boundaryCases: 1, boundaryPassed: 1, outOfDomainCases: 1, outOfDomainPassed: 1,
      invalidInputCases: 1, invalidInputRejected: 1, repeatRuns: 3, maxRepeatDrift: 0, allowedRepeatDrift: 1e-7,
      businessReplayCases: 3, businessReplayPassed: 3,
    },
    approval: { decisionStatus: "production-approved", independentDatasetSplit: true, externalLockboxCases: 1, approvedBy: "board", approvedAt: "2026-08-29T00:00:00Z", evidenceFingerprint: "c".repeat(64) },
    generatedAt: "2026-08-29T00:00:00Z",
  };
}

function batteryInput() {
  return {
    model: "batterymformer" as const,
    fileName: "CALB_fixture.csv",
    chemistry: "lfp" as const,
    nominalCapacityAh: 100,
    targetCapacityRetention: 80,
    records: Array.from({ length: 12 }, (_, cycleIndex) => cycleRows(cycleIndex + 1)).flat(),
  };
}

function cycleRows(cycle: number) {
  const soh = 1 - (cycle - 1) * 0.01;
  return [
    { cycle, time: 0, voltage: 3, current: 20, chargeCapacityAh: 0, capacityAh: 0, soh, sourceDataset: "CALB" },
    { cycle, time: 10, voltage: 3.5, current: 20, chargeCapacityAh: 50, capacityAh: 0, soh, sourceDataset: "CALB" },
    { cycle, time: 20, voltage: 4.1, current: 20, chargeCapacityAh: 100, capacityAh: 0, soh, sourceDataset: "CALB" },
    { cycle, time: 30, voltage: 4, current: -20, chargeCapacityAh: 100, capacityAh: 0, soh, sourceDataset: "CALB" },
    { cycle, time: 40, voltage: 3.5, current: -20, chargeCapacityAh: 100, capacityAh: 50, soh, sourceDataset: "CALB" },
    { cycle, time: 50, voltage: 3, current: -20, chargeCapacityAh: 100, capacityAh: 100, soh, sourceDataset: "CALB" },
  ];
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
