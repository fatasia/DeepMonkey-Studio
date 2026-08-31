import { describe, expect, it } from "vitest";
import {
  assessBatteryInputDomain,
  attachBatteryInferenceEvidence,
  createBatteryInferenceContext,
  runBatteryInferenceWithTimeout,
} from "./batteryInferenceGovernance.js";

describe("battery inference governance", () => {
  it("distinguishes declared supported input from inferred and physical outliers", () => {
    const supported = assessBatteryInputDomain({
      model: "socformer",
      fileName: "cell.csv",
      chemistry: "ncm",
      nominalCapacityAh: 100,
      records: signalRecords(),
    });
    const inferred = assessBatteryInputDomain({
      model: "socformer",
      fileName: "NMC-cell.csv",
      nominalCapacityAh: 100,
      records: signalRecords(),
    });
    const outlier = assessBatteryInputDomain({
      model: "socformer",
      fileName: "cell.csv",
      chemistry: "ncm",
      nominalCapacityAh: 100,
      records: [{ time: 0, voltage: 4, current: -10, temperature: 200 }, ...signalRecords()],
    });
    expect(supported.status).toBe("supported");
    expect(inferred).toMatchObject({ status: "indeterminate", metrics: { chemistrySource: "inferred" } });
    expect(outlier).toMatchObject({ status: "out-of-domain", metrics: { rangeViolations: 1 } });
  });

  it("creates reproducible input fingerprints without reusing trace ids", () => {
    const input = { model: "socformer" as const, fileName: "cell.csv", records: signalRecords() };
    const first = createBatteryInferenceContext(input, "python-service", []);
    const second = createBatteryInferenceContext(input, "python-service", []);
    expect(first.inputFingerprint).toMatch(/^[a-f\d]{64}$/);
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
    expect(first.traceId).not.toBe(second.traceId);
  });

  it("preserves confidence from the Python service response envelope", () => {
    const input = { model: "socformer" as const, fileName: "cell.csv", records: signalRecords() };
    const context = createBatteryInferenceContext(input, "python-service", []);
    const output = attachBatteryInferenceEvidence(
      { model: "socformer", variant: "standard", result: { finalSoc: 0.5, confidence: "high" } },
      context,
      { actualRuntime: "python-service", fellBack: false },
    );

    expect(output.inferenceEvidence).toMatchObject({ confidence: "high" });
  });

  it("aborts a hanging ONNX operation at the configured budget", async () => {
    let runtimeSignal: AbortSignal | undefined;
    await expect(runBatteryInferenceWithTimeout(
      (signal) => {
        runtimeSignal = signal;
        return new Promise<never>(() => undefined);
      },
      5,
    )).rejects.toThrow("电池 ONNX 推理超时（5ms）");
    expect(runtimeSignal?.aborted).toBe(true);
  });
});

function signalRecords() {
  return [
    { time: 0, voltage: 4.2, current: -10, temperature: 25 },
    { time: 60, voltage: 4.1, current: -10, temperature: 25 },
  ];
}
