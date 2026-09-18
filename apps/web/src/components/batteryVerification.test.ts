import { describe, expect, it } from "vitest";
import {
  batteryCombinedConfidence,
  batteryConfidenceDiagnostics,
  batteryVerificationChecks,
  mergeUniqueText,
} from "./batteryVerification";

function checkById(checks: ReturnType<typeof batteryVerificationChecks>, id: string) {
  return checks.find(check => check.id === id);
}

describe("batteryVerificationChecks", () => {
  it("passes the SOC balance when coulomb integration matches the model trajectory", () => {
    const checks = batteryVerificationChecks({
      nominalCapacityAh: 100,
      soc: {
        initialSoc: 80, finalSoc: 90.4,
        points: [0, 1200, 2400, 3600].map(time => ({ time, current: 10, estimatedSoc: 80 })),
      },
    });
    const check = checkById(checks, "soc-balance");
    expect(check?.status).toBe("pass");
    expect(check?.value).toContain("残差 0.40%");
  });

  it("recognizes discharge-positive current convention instead of forcing a failure", () => {
    const checks = batteryVerificationChecks({
      nominalCapacityAh: 100,
      soc: {
        initialSoc: 80, finalSoc: 70.3,
        points: [0, 1200, 2400, 3600].map(time => ({ time, current: 10, estimatedSoc: 75 })),
      },
    });
    const check = checkById(checks, "soc-balance");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("放电为正");
  });

  it("flags a real SOC residual beyond 5 points for review", () => {
    const checks = batteryVerificationChecks({
      nominalCapacityAh: 100,
      soc: {
        initialSoc: 80, finalSoc: 80,
        points: [0, 1800, 3600].map(time => ({ time, current: 10, estimatedSoc: 85 })),
      },
    });
    expect(checkById(checks, "soc-balance")?.status).toBe("review");
  });

  it("marks the SOC balance as pending instead of inventing a capacity", () => {
    const checks = batteryVerificationChecks({
      soc: { initialSoc: 80, finalSoc: 70, points: [{ time: 0, current: 5 }, { time: 10, current: 5 }] },
    });
    const check = checkById(checks, "soc-balance");
    expect(check?.status).toBe("unknown");
    expect(check?.value).toBe("待核验");
  });

  it("cross-checks current SOH between BMSFormer and the BatteryMFormer observed anchor", () => {
    const rul = {
      sohCurve: [{ cycle: 1, soh: 95 }, { cycle: 100, soh: 91.5 }, { cycle: 300, soh: 80 }],
      rulObservation: { observedSurvivalCycles: 100 },
    };
    const pass = batteryVerificationChecks({ soh: { currentSoh: 90 }, rul });
    expect(checkById(pass, "soh-cross-model")?.status).toBe("pass");
    const review = batteryVerificationChecks({ soh: { currentSoh: 85 }, rul });
    const check = checkById(review, "soh-cross-model");
    expect(check?.status).toBe("review");
    expect(check?.value).toContain("6.5 pp");
  });

  it("omits cross-model and extrapolation checks without RUL output", () => {
    const checks = batteryVerificationChecks({ soh: { currentSoh: 90 } });
    expect(checkById(checks, "soh-cross-model")).toBeUndefined();
    expect(checkById(checks, "life-extrapolation")).toBeUndefined();
  });

  it("applies the 4x extrapolation rule against observed cycles", () => {
    const pass = batteryVerificationChecks({
      rul: { predictedCycleLife: 500, rulObservation: { observedSurvivalCycles: 100 } },
    });
    expect(checkById(pass, "life-extrapolation")?.status).toBe("pass");
    const review = batteryVerificationChecks({
      rul: { predictedCycleLife: 600, rulObservation: { observedSurvivalCycles: 100 } },
    });
    expect(checkById(review, "life-extrapolation")?.value).toBe("5.00×");
    expect(checkById(review, "life-extrapolation")?.status).toBe("review");
  });

  it("treats right-censored lifetime as a trustworthy lower bound", () => {
    const checks = batteryVerificationChecks({
      rul: {
        predictedCycleLife: 900,
        rulObservation: { targetSemantics: "right-censored-lower-bound", lifetimeLowerBoundCycles: 700, targetThresholdPct: 80 },
      },
    });
    const check = checkById(checks, "life-boundary");
    expect(check?.status).toBe("pass");
    expect(check?.value).toContain("≥700 圈");
  });

  it("compares routed experts against a public reference EOL", () => {
    const checks = batteryVerificationChecks({
      referenceCycleLife: 378,
      rul: {
        predictedCycleLife: 400,
        expertRouting: {
          candidateComparison: {
            standard: { predictedCycleLife: 400 },
            pinn: { predictedCycleLife: 370 },
          },
        },
      },
    });
    const check = checkById(checks, "life-boundary");
    expect(check?.status).toBe("pass");
    expect(check?.value).toContain("PINN 影子专家更接近 · 参考 378 圈");
    const review = batteryVerificationChecks({ referenceCycleLife: 200, rul: { predictedCycleLife: 400 } });
    expect(checkById(review, "life-boundary")?.status).toBe("review");
  });
});

describe("batteryConfidenceDiagnostics", () => {
  it("prefers gate-related warnings and keeps version and runtime honest", () => {
    const diagnostics = batteryConfidenceDiagnostics({
      soc: { confidence: "high", modelVersion: "socformer-v3", warnings: [], runtimeExecution: { actual: "onnx" } },
      rul: {
        confidence: "medium",
        modelVersion: "batterymformer-v9",
        warnings: ["输入超出覆盖范围，已保留趋势基线。", "常规提示"],
      },
    });
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ name: "SOCFormer", version: "socformer-v3", runtime: "ONNX Runtime" });
    expect(diagnostics[0]?.reason).toContain("high 门槛");
    expect(diagnostics[1]?.reason).toContain("覆盖范围");
  });
});

describe("mergeUniqueText / batteryCombinedConfidence", () => {
  it("deduplicates warnings in original order", () => {
    expect(mergeUniqueText(["a", "b"], ["b", "c"], undefined)).toEqual(["a", "b", "c"]);
  });

  it("never raises combined confidence above the weakest model", () => {
    expect(batteryCombinedConfidence({
      soc: { confidence: "high" },
      soh: { confidence: "medium" },
      rul: { confidence: "high" },
    })).toBe("medium");
    expect(batteryCombinedConfidence({})).toBeUndefined();
  });
});
