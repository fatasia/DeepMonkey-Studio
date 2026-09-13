import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BatteryAnalysisReport } from "./BatteryAnalysisReport";

describe("BatteryAnalysisReport", () => {
  it("renders threshold, route and PINN physics evidence", () => {
    const html = renderToStaticMarkup(<BatteryAnalysisReport result={{
      predictedCycleLife: 1915,
      modelVersion: "batterymformer-spm-pinn-v9-fieldcal-seed7181",
      physicsArchitecture: "learnable-spm-pinn",
      runtimeExecution: { actual: "onnx", runtime: "rust-ort" },
      rulObservation: { lifetimeLowerBoundCycles: 100, targetThresholdPct: 80, targetSemantics: "right-censored-lower-bound" },
      expertRouting: {
        selectedExpert: "pinn", executedExperts: ["standard", "pinn"],
        routePath: ["标准寿命专家", "PINN 物理专家", "采纳 PINN"],
        reasons: ["标准专家未达到高置信"], disagreementRatio: 0.08,
        candidateComparison: {
          standard: { predictedCycleLife: 2050, confidence: "medium" },
          pinn: { predictedCycleLife: 1915, confidence: "high" },
        },
      },
      identifiedPhysicsParameters: {
        identifiabilityScore: 0.68, physicsBlendGate: 0.2, physicalFitScore: 0.82,
        physicalObservationRmse: 0.02, equivalentResistanceOhm: 0.0012,
        effectiveDiffusionTimeHours: [28.1, 29.2], normalizedFadeRatePerCycle: 0.0002,
        physicalTrajectoryCycleLife: 2100, ocvMinimumV: 2.8, ocvSpanV: 1.2, exchangeCRate: 1.1,
      },
      dataProfile: {
        rowCount: 8640,
        cycleCount: 30,
        cellCount: 96,
        ranges: { currentA: [-140, 110], voltageV: [2.9, 3.65], temperatureC: [20, 42], sohPct: [88, 98] },
        packAssessment: { meanSohPct: 94.1, weakestSohPct: 88, sohSpreadPct: 10, weakestCellId: "C087", weakestModuleId: "M08" },
      },
      rationale: ["物理与数据轨迹联合推理。"],
    }} />);
    expect(html).toContain("右删失 · 下限");
    expect(html).toContain("专家分歧");
    expect(html).toContain("2050 圈 · 中等置信");
    expect(html).toContain("1915 圈 · 高置信");
    expect(html).toContain("PINN 物理辨识");
    expect(html).toContain("Rust · ONNX Runtime");
    expect(html).toContain("等效内阻");
    expect(html).toContain("8,640 行 · 30 圈 · 96 电芯");
    expect(html).toContain("最弱电芯 SOH");
    expect(html).toContain("C087 · M08");
  });
});
