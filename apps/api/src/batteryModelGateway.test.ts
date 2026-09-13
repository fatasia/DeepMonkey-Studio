import { describe, expect, it } from "vitest";
import type { BatteryOnnxEquivalenceManifest } from "@bim-studio/contracts";
import { createBatteryModelGateway, type BatteryTransport } from "./batteryModelGateway.js";

class RecordingTransport implements BatteryTransport {
  calls: Array<{ path: string; method: string; body?: unknown }> = [];

  async request(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
    this.calls.push({ path, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
    return path === "/research/release/status"
      ? { status: "shadow-only", productionOutputEnabled: false }
      : { ok: true, path };
  }
}

describe("battery model gateway", () => {
  it("keeps Python as the default runtime when no ONNX policy is requested", async () => {
    const transport = new RecordingTransport();
    const gateway = createBatteryModelGateway({ transport });
    const result = await gateway.predict({ model: "socformer", fileName: "soc.csv", records: [{ soc: 0.5 }] });
    expect(transport.calls[0]?.path).toBe("/predict");
    expect(result.runtimeExecution).toMatchObject({ requested: "python-service", actual: "python-service", fellBack: false });
  });

  it("does not activate an ONNX model without a production-approved manifest", async () => {
    const transport = new RecordingTransport();
    let onnxCalls = 0;
    const gateway = createBatteryModelGateway({
      transport,
      runtimeByModel: { socformer: "onnx" },
      onnxManifests: [{ ...approvedSocManifest(), approval: { decisionStatus: "candidate", independentDatasetSplit: false, externalLockboxCases: 0 } }],
      onnxRuntime: { async predict() { onnxCalls += 1; return { estimatedSoc: 50 }; } }
    });
    const result = await gateway.predict({ model: "socformer", fileName: "soc.csv", records: [{ soc: 0.5 }] });
    expect(onnxCalls).toBe(0);
    expect(transport.calls[0]?.path).toBe("/predict");
    expect(result.runtimeExecution).toMatchObject({ requested: "onnx", actual: "python-service", fellBack: true });
  });

  it("activates ONNX independently for a model with complete approval evidence", async () => {
    const transport = new RecordingTransport();
    const gateway = createBatteryModelGateway({
      transport,
      runtimeByModel: { socformer: "onnx" },
      onnxManifests: [approvedSocManifest()],
      onnxRuntime: { async predict() { return { estimatedSoc: 49.8 }; } }
    });
    const result = await gateway.predict({ model: "socformer", fileName: "soc.csv", records: [{ soc: 0.5 }] });
    expect(transport.calls).toHaveLength(0);
    expect(result).toMatchObject({ estimatedSoc: 49.8, runtimeExecution: { requested: "onnx", actual: "onnx", fellBack: false } });
  });

  it("returns signed model identity and normalization contracts for an ONNX decision", async () => {
    const transport = new RecordingTransport();
    const gateway = createBatteryModelGateway({
      transport,
      runtimeByModel: { socformer: "onnx" },
      onnxManifests: [approvedSocManifest()],
      onnxRuntime: { async predict() { return { estimatedSoc: 49.8, confidence: "high" }; } }
    });
    const result = await gateway.predict({
      model: "socformer",
      fileName: "cell.csv",
      chemistry: "ncm",
      nominalCapacityAh: 100,
      records: [{ time: 0, voltage: 4.2, current: -10 }, { time: 60, voltage: 4.1, current: -10 }],
    });
    expect(result.inferenceEvidence).toMatchObject({
      schemaVersion: 1,
      authority: "primary",
      requestedRuntime: "onnx",
      actualRuntime: "onnx",
      fellBack: false,
      confidence: "high",
      domain: { status: "supported" },
      model: {
        modelId: "battery.socformer",
        modelVersion: "socformer-li-hybrid-v2",
        checkpointSha256: "a".repeat(64),
        artifactSha256: "b".repeat(64),
        runtimeAdapterSha256: "d".repeat(64),
        inputContract: "socformer-normalized-sequence-window-v1",
        normalizationVersion: "socformer-sequence-anchor-v1",
        postprocessingVersion: "socformer-hybrid-soc-product-v1",
      },
    });
  });

  it("falls back to Python when an approved ONNX runtime fails", async () => {
    const transport = new RecordingTransport();
    const gateway = createBatteryModelGateway({
      transport,
      runtimeByModel: { socformer: "onnx" },
      onnxManifests: [approvedSocManifest()],
      onnxRuntime: { async predict() { throw new Error("模型制品加载失败"); } }
    });
    const result = await gateway.predict({ model: "socformer", fileName: "soc.csv", records: [{ soc: 0.5 }] });
    expect(transport.calls[0]?.path).toBe("/predict");
    expect(result.runtimeExecution).toMatchObject({ requested: "onnx", actual: "python-service", fellBack: true, reason: expect.stringContaining("模型制品加载失败") });
  });

  it("falls back to Python when ONNX exceeds its latency budget", async () => {
    const transport = new RecordingTransport();
    const gateway = createBatteryModelGateway({
      transport,
      onnxTimeoutMs: 5,
      runtimeByModel: { socformer: "onnx" },
      onnxManifests: [approvedSocManifest()],
      onnxRuntime: { async predict() { return new Promise<Record<string, unknown>>(() => undefined); } }
    });
    const result = await gateway.predict({ model: "socformer", fileName: "soc.csv", records: [{ soc: 0.5 }] });
    expect(result.runtimeExecution).toMatchObject({ actual: "python-service", fellBack: true, reason: expect.stringContaining("超时") });
    expect(result.inferenceEvidence).toMatchObject({
      actualRuntime: "python-service",
      fellBack: true,
      fallbackReason: expect.stringContaining("超时"),
    });
  });

  it("does not execute ONNX for input outside hard physical boundaries", async () => {
    const transport = new RecordingTransport();
    let onnxCalls = 0;
    const gateway = createBatteryModelGateway({
      transport,
      runtimeByModel: { socformer: "onnx" },
      onnxManifests: [approvedSocManifest()],
      onnxRuntime: { async predict() { onnxCalls += 1; return { estimatedSoc: 50 }; } }
    });
    const result = await gateway.predict({
      model: "socformer",
      fileName: "soc.csv",
      chemistry: "ncm",
      nominalCapacityAh: 100,
      records: [{ time: 0, voltage: 4.2, current: -10, temperature: 200 }],
    });
    expect(onnxCalls).toBe(0);
    expect(result.inferenceEvidence).toMatchObject({
      actualRuntime: "python-service",
      fellBack: true,
      domain: { status: "out-of-domain" },
    });
  });

  it("falls back when the signed adapter detects normalized feature drift", async () => {
    const transport = new RecordingTransport();
    const gateway = createBatteryModelGateway({
      transport,
      runtimeByModel: { socformer: "onnx" },
      onnxManifests: [approvedSocManifest()],
      onnxRuntime: { async predict() {
        return {
          estimatedSoc: 50,
          confidence: "low",
          domainAssessment: {
            status: "out-of-domain",
            reasons: ["归一化特征漂移"],
            metrics: { extremeRatio: 0.4 },
          },
        };
      } }
    });
    const result = await gateway.predict({
      model: "socformer",
      fileName: "cell.csv",
      chemistry: "ncm",
      nominalCapacityAh: 100,
      records: [{ time: 0, voltage: 4.2, current: -10 }, { time: 60, voltage: 4.1, current: -10 }],
    });
    expect(transport.calls[0]?.path).toBe("/predict");
    expect(result.runtimeExecution).toMatchObject({
      actual: "python-service",
      fellBack: true,
      reason: expect.stringContaining("归一化特征漂移"),
    });
    expect(result.inferenceEvidence).toMatchObject({ domain: { status: "out-of-domain" } });
  });

  it("treats a malformed ONNX output as a runtime failure and falls back", async () => {
    const transport = new RecordingTransport();
    const gateway = createBatteryModelGateway({
      transport,
      runtimeByModel: { socformer: "onnx" },
      onnxManifests: [approvedSocManifest()],
      onnxRuntime: { async predict() { return null as unknown as Record<string, unknown>; } }
    });
    const result = await gateway.predict({ model: "socformer", fileName: "soc.csv", records: [{ soc: 0.5 }] });
    expect(transport.calls[0]?.path).toBe("/predict");
    expect(result.runtimeExecution).toMatchObject({ actual: "python-service", fellBack: true, reason: expect.stringContaining("返回格式无效") });
  });

  it("preserves the BatteryMFormer PINN physics variant", async () => {
    const transport = new RecordingTransport();
    let onnxCalls = 0;
    const gateway = createBatteryModelGateway({
      transport,
      runtimeByModel: { batterymformer: "onnx" },
      onnxRuntime: { async predict() { onnxCalls += 1; return {}; } },
    });
    const result = await gateway.predict({
      model: "batterymformer",
      variant: "physics",
      fileName: "cycles.csv",
      records: [{ cycle: 1, capacity: 98 }],
      chemistry: "lfp"
    });
    expect(transport.calls[0]).toMatchObject({ path: "/predict", body: { model: "batterymformer", variant: "physics" } });
    expect(onnxCalls).toBe(0);
    expect(result.inferenceEvidence).toMatchObject({
      authority: "advisory",
      routingPolicy: "routed-expert-python",
      requestedRuntime: "onnx",
      actualRuntime: "python-service",
    });
    expect(result).toMatchObject({ decisionAuthority: "production-route" });
  });

  it("uses the original risk gate to promote PINN through the production route", async () => {
    const transport = new RoutedPredictionTransport();
    const gateway = createBatteryModelGateway({ transport });
    const result = await gateway.predict({
      model: "batterymformer",
      routingMode: "dynamic",
      fileName: "cycles.csv",
      records: [{ cycle: 1, capacity: 98 }],
      chemistry: "lfp",
    });
    expect(transport.calls.map((call) => (call.body as { variant: string }).variant)).toEqual(["standard", "physics"]);
    expect(result).toMatchObject({
      predictedCycleLife: 1900,
      decisionAuthority: "production-route",
      expertRouting: {
        authority: "production-route",
        selectedExpert: "pinn",
        reviewRequired: false,
      },
    });
  });

  it("accepts the service percentage contract and rejects ratio-shaped retention", async () => {
    const transport = new RecordingTransport();
    const gateway = createBatteryModelGateway({ transport });
    await gateway.predict({
      model: "batterymformer",
      fileName: "cycles.csv",
      records: [{ cycle: 1, capacity: 98 }],
      targetCapacityRetention: 80
    });
    expect(transport.calls[0]).toMatchObject({ body: { target_capacity_retention: 80 } });
    await expect(gateway.predict({
      model: "batterymformer",
      fileName: "cycles.csv",
      records: [{ cycle: 1, capacity: 98 }],
      targetCapacityRetention: 0.8
    })).rejects.toThrow("50–100");
  });

  it("delegates PINO/TwinMoE simulation to the existing digital-twin runtime", async () => {
    const transport = new RecordingTransport();
    const gateway = createBatteryModelGateway({ transport });
    await gateway.simulateTwin({
      twinId: "twin-12345678",
      executionMode: "dynamic",
      segments: [{ durationMinutes: 30, currentCRate: 0.5, ambientTemperatureC: 35 }]
    });
    expect(transport.calls[0]).toEqual({
      path: "/research/digital-twin/simulate-short-horizon",
      method: "POST",
      body: {
        twin_id: "twin-12345678",
        scenario_name: "未来工况",
        resolution_minutes: 1,
        segments: [{ duration_minutes: 30, current_c_rate: 0.5, ambient_temperature_c: 35 }],
        execution_mode: "dynamic",
        commit: false
      }
    });
  });

  it("rejects simulation values outside the source runtime contract", async () => {
    const gateway = createBatteryModelGateway({ transport: new RecordingTransport() });
    await expect(gateway.simulateTwin({
      twinId: "short",
      segments: [{ durationMinutes: 1, currentCRate: 0.5 }]
    })).rejects.toThrow("至少 8 个字符");
    await expect(gateway.simulateTwin({
      twinId: "twin-12345678",
      scenarioName: "场".repeat(81),
      segments: [{ durationMinutes: 1, currentCRate: 0.5 }]
    })).rejects.toThrow("不能超过 80 个字符");
    await expect(gateway.simulateTwin({
      twinId: "twin-12345678",
      resolutionMinutes: 0.1,
      segments: [{ durationMinutes: 30, currentCRate: 0.5 }]
    })).rejects.toThrow("0.25–10");
    await expect(gateway.simulateTwin({
      twinId: "twin-12345678",
      segments: [
        { durationMinutes: 70, currentCRate: 0.5 },
        { durationMinutes: 60, currentCRate: -0.5 },
      ],
    })).rejects.toThrow("总时长不能超过 120 分钟");
  });

  it("commits the TwinMoE-selected PINO state instead of the baseline state", async () => {
    const transport = new RoutedTwinTransport();
    const gateway = createBatteryModelGateway({ transport });
    const result = await gateway.simulateTwin({
      twinId: "twin-12345678",
      executionMode: "dynamic",
      commit: true,
      segments: [{ durationMinutes: 4, currentCRate: 0.5 }],
    });
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]).toMatchObject({
      path: "/research/digital-twin/simulate-short-horizon",
      body: { execution_mode: "dynamic", commit: false },
    });
    expect(transport.calls[1]).toMatchObject({
      path: "/research/digital-twin/assimilate-cycle",
      body: { twin_id: "twin-12345678", soc: 0.68, temperature_c: 31 },
    });
    expect(result).toMatchObject({
      primaryEngine: "spm-pino-transformer",
      summary: { finalSocPct: 68, selectedExpert: "pino" },
      commitSource: "selected-production-route",
    });
  });

  it("keeps release status and twin evidence available for audit", async () => {
    const transport = new RecordingTransport();
    const gateway = createBatteryModelGateway({ transport });
    await gateway.releaseStatus();
    await gateway.twinEvidence("twin/audit");
    expect(transport.calls.map((call) => call.path)).toEqual([
      "/research/release/status",
      "/research/digital-twin/twin%2Faudit/evidence"
    ]);
  });

  it("rejects physics mode for models without a PINN runtime", async () => {
    const gateway = createBatteryModelGateway({ transport: new RecordingTransport() });
    await expect(gateway.predict({ model: "socformer", variant: "physics", fileName: "soc.csv", records: [{ soc: 0.5 }] })).rejects.toThrow("仅适用于 BatteryMFormer");
  });
});

class RoutedPredictionTransport extends RecordingTransport {
  override async request(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
    this.calls.push({ path, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
    const variant = (init.body as { variant?: string } | undefined)?.variant ?? "standard";
    return {
      model: "batterymformer",
      variant,
      result: {
        predictedCycleLife: variant === "physics" ? 1900 : 2000,
        confidence: variant === "physics" ? "high" : "medium",
        analysisFeatures: {
          advancedModel: "batterymformer",
          advancedModelUsed: true,
          advancedModelVariant: variant,
          trend: { maxObservedCycle: 100, averageFitR2: 0.8 },
        },
      },
    };
  }
}

class RoutedTwinTransport extends RecordingTransport {
  override async request(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
    this.calls.push({ path, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
    if (path === "/research/digital-twin/simulate-short-horizon") {
      return {
        candidateEngine: "spm-pino-transformer",
        routing: { shadowCandidateQualified: true, operatorWeight: 0.8 },
        evidence: { fallbackActivated: false },
        summary: { finalSocPct: 70, candidateFinalSocPct: 68 },
        points: [{ baselineSocPct: 70, baselineVoltageV: 3.4, pinoSocPct: 68, pinoVoltageV: 3.38, temperatureC: 31 }],
      };
    }
    return { twinId: "twin-12345678", soc: 0.68, temperatureC: 31 };
  }
}

function approvedSocManifest(): BatteryOnnxEquivalenceManifest {
  return {
    schemaVersion: 1,
    modelId: "battery.socformer",
    source: { modelVersion: "socformer-li-hybrid-v2", checkpointSha256: "a".repeat(64) },
    artifact: { fileName: "socformer.onnx", sha256: "b".repeat(64), sizeBytes: 100, opset: 18, precision: "fp32" },
    runtimeAdapter: { fileName: "socformer.runtime-adapter.json", sha256: "d".repeat(64), sizeBytes: 200, schemaVersion: 1 },
    contract: {
      input: "socformer-normalized-sequence-window-v1",
      output: "soc-fraction-v1",
      preprocessing: "socformer-sequence-anchor-v1",
      postprocessing: "socformer-hybrid-soc-product-v1",
    },
    validation: {
      outputs: [{ task: "soc", samples: 70, maxAbsoluteError: 0.0001, meanAbsoluteError: 0.00001, allowedMaxAbsoluteError: 0.001, allowedMeanAbsoluteError: 0.0001 }],
      boundaryCases: 8, boundaryPassed: 8, outOfDomainCases: 4, outOfDomainPassed: 4,
      invalidInputCases: 6, invalidInputRejected: 6, repeatRuns: 5, maxRepeatDrift: 0, allowedRepeatDrift: 1e-7,
      businessReplayCases: 3, businessReplayPassed: 3
    },
    approval: {
      decisionStatus: "production-approved", independentDatasetSplit: true, externalLockboxCases: 1,
      approvedBy: "battery-release-board", approvedAt: "2026-08-29T00:00:00.000Z", evidenceFingerprint: "c".repeat(64)
    },
    generatedAt: "2026-08-29T00:00:00.000Z"
  };
}
