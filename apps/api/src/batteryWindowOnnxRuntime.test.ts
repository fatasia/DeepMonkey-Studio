import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BatteryOnnxEquivalenceManifest } from "@bim-studio/contracts";
import type { BatteryOnnxDeployment } from "./batteryOnnxDeployment.js";
import { BatteryWindowOnnxRuntime } from "./batteryWindowOnnxRuntime.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("battery window ONNX runtime", () => {
  it("runs BMSFormer with the approved adapter and reuses the session", async () => {
    const fixture = await runtimeFixture("bmsformer", bmsAdapter());
    const run = vi.fn(async () => ({ output: { data: Float32Array.of(0.987276) } }));
    const createSession = vi.fn(async () => ({ inputNames: ["input"], outputNames: ["output"], run }));
    const runtime = new BatteryWindowOnnxRuntime(fixture.deployment, { createSession });
    const input = { model: "bmsformer" as const, fileName: "lfp.csv", chemistry: "lfp" as const, records: bmsRecords() };
    expect(await runtime.predict(input)).toMatchObject({ currentSoh: 98.728, confidence: "high" });
    await runtime.predict(input);
    expect(createSession).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs SOCFormer and returns the product-level blended series", async () => {
    const fixture = await runtimeFixture("socformer", socAdapter());
    const values = Float32Array.from({ length: 61 }, () => 0.5);
    const runtime = new BatteryWindowOnnxRuntime(fixture.deployment, {
      createSession: async () => ({ inputNames: ["input"], outputNames: ["output"], run: async () => ({ output: { data: values } }) }),
    });
    const result = await runtime.predict({
      model: "socformer",
      fileName: "nmc.csv",
      chemistry: "ncm",
      nominalCapacityAh: 100,
      records: socRecords(),
    });
    expect(result).toMatchObject({ initialSoc: 90, finalSoc: 10, confidence: "high" });
    expect(result.points).toHaveLength(61);
  });

  it("rejects an adapter whose version differs from the signed manifest", async () => {
    const fixture = await runtimeFixture("bmsformer", { ...bmsAdapter(), modelVersion: "wrong" });
    const runtime = new BatteryWindowOnnxRuntime(fixture.deployment, {
      createSession: async () => ({ inputNames: ["input"], outputNames: ["output"], run: async () => ({ output: { data: Float32Array.of(0.9) } }) }),
    });
    await expect(runtime.predict({ model: "bmsformer", fileName: "lfp.csv", records: bmsRecords() })).rejects.toThrow("版本不一致");
  });

  it("rejects an out-of-range SOC blend weight instead of silently clamping signed metadata", async () => {
    const adapter = socAdapter();
    adapter.model.deepCorrectionWeight = 1.5;
    const fixture = await runtimeFixture("socformer", adapter);
    const runtime = new BatteryWindowOnnxRuntime(fixture.deployment, {
      createSession: async () => ({ inputNames: ["input"], outputNames: ["output"], run: async () => ({ output: { data: Float32Array.of(0.5) } }) }),
    });
    await expect(runtime.predict({
      model: "socformer", fileName: "ncm.csv", nominalCapacityAh: 100, records: socRecords(),
    })).rejects.toThrow("必须在 0–1 范围内");
  });
});

async function runtimeFixture(model: "bmsformer" | "socformer", adapter: object) {
  const root = await mkdtemp(join(tmpdir(), "battery-window-runtime-"));
  cleanup.push(root);
  const artifactPath = join(root, `${model}.onnx`);
  const runtimeAdapterPath = join(root, `${model}.runtime-adapter.json`);
  await writeFile(artifactPath, "fixture");
  await writeFile(runtimeAdapterPath, JSON.stringify(adapter));
  const manifest = manifestFor(model);
  const deployment: BatteryOnnxDeployment = {
    enabled: true,
    requestedModels: [model],
    manifests: [manifest],
    models: { [model]: { manifest, artifactPath, runtimeAdapterPath } },
    diagnostics: [],
  };
  return { root, deployment };
}

function manifestFor(model: "bmsformer" | "socformer"): BatteryOnnxEquivalenceManifest {
  const isSoc = model === "socformer";
  return {
    schemaVersion: 1,
    modelId: `battery.${model}`,
    source: { modelVersion: isSoc ? "socformer-li-hybrid-v2" : "bmsformer-li-multichem-v2", checkpointSha256: "a".repeat(64) },
    artifact: { fileName: `${model}.onnx`, sha256: "b".repeat(64), sizeBytes: 7, opset: 18, precision: "fp32" },
    runtimeAdapter: { fileName: `${model}.runtime-adapter.json`, sha256: "d".repeat(64), sizeBytes: 10, schemaVersion: 1 },
    contract: { input: "input-v1", output: "output-v1", preprocessing: "pre-v1", postprocessing: "post-v1" },
    validation: {
      outputs: [{ task: isSoc ? "soc" : "soh", samples: 70, maxAbsoluteError: 0, meanAbsoluteError: 0, allowedMaxAbsoluteError: 0.001, allowedMeanAbsoluteError: 0.0001 }],
      boundaryCases: 1, boundaryPassed: 1, outOfDomainCases: 1, outOfDomainPassed: 1,
      invalidInputCases: 1, invalidInputRejected: 1, repeatRuns: 3, maxRepeatDrift: 0, allowedRepeatDrift: 1e-7,
      businessReplayCases: 3, businessReplayPassed: 3,
    },
    approval: { decisionStatus: "production-approved", independentDatasetSplit: true, externalLockboxCases: 1, approvedBy: "board", approvedAt: "2026-08-29T00:00:00Z", evidenceFingerprint: "c".repeat(64) },
    generatedAt: "2026-08-29T00:00:00Z",
  };
}

function bmsAdapter() {
  return {
    schemaVersion: 1, modelId: "battery.bmsformer", modelVersion: "bmsformer-li-multichem-v2", kind: "bmsformer-window-v1",
    session: { inputs: ["input"], output: "output" },
    model: {
      windowSize: 20, inputFeatures: 6,
      featureNames: ["observed_soh", "log1p_charge_duration_s", "log1p_discharge_duration_s", "log1p_relative_upper_charge_duration_s", "log1p_relative_mid_discharge_duration_s", "voltage_span_v"],
      featureMean: [0, 0, 0, 0, 0, 0], featureStd: [1, 1, 1, 1, 1, 1], chemistryScope: ["lfp", "ncm"], confidenceGate: { passed: true },
    },
  };
}

function socAdapter() {
  return {
    schemaVersion: 1, modelId: "battery.socformer", modelVersion: "socformer-li-hybrid-v2", kind: "socformer-window-v1",
    session: { inputs: ["input"], output: "output" },
    model: {
      windowSize: 16, inputFeatures: 7,
      featureNames: ["normalized_voltage", "c_rate", "temperature_c", "phase", "coulomb_soc_anchor", "delta_time_s", "is_lfp"],
      featureMean: [0, 0, 25, 0, 0, 60, 0], featureStd: [1, 1, 1, 1, 1, 1, 1], deepCorrectionWeight: 0.2,
      chemistryScope: ["lfp", "ncm"], confidenceGate: { passed: true, max_test_mae: 0.03 }, testMae: 0.018,
    },
  };
}

function bmsRecords() {
  return Array.from({ length: 20 }, (_, index) => [
    { cycle: index + 1, time: 0, voltage: 3, current: 10, capacityAh: 100 - index * 0.1, soh: 1 - index * 0.001 },
    { cycle: index + 1, time: 10, voltage: 3.4, current: 10, capacityAh: 100 - index * 0.1, soh: 1 - index * 0.001 },
    { cycle: index + 1, time: 20, voltage: 4.2, current: 10, capacityAh: 100 - index * 0.1, soh: 1 - index * 0.001 },
    { cycle: index + 1, time: 30, voltage: 4.1, current: -10, capacityAh: 100 - index * 0.1, soh: 1 - index * 0.001 },
    { cycle: index + 1, time: 40, voltage: 3.5, current: -10, capacityAh: 100 - index * 0.1, soh: 1 - index * 0.001 },
    { cycle: index + 1, time: 50, voltage: 3, current: -10, capacityAh: 100 - index * 0.1, soh: 1 - index * 0.001 },
  ]).flat();
}

function socRecords() {
  return Array.from({ length: 61 }, (_, index) => ({ time: index * 60, voltage: 4.2 - index * 0.02, current: -100, temperature: 25, capacityAh: index / 60 * 100, chargeCapacityAh: 0 }));
}
