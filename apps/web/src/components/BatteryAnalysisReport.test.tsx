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
        packAssessment: {
          meanSohPct: 94.1, weakestSohPct: 88, sohSpreadPct: 10, weakestCellId: "C087", weakestModuleId: "M08",
          riskLevel: "high", riskReasons: ["SOH 极差 10.0%", "末端压差 96 mV"],
          conclusion: "Pack 已出现显著不一致，C087 正在限制可用容量与能量。",
          recommendations: ["优先复测 C087（M08）的容量、内阻与采样线。"],
          finding: "C087 / M08 限制 Pack 可用能力",
          resistanceSpreadPct: 31.2, voltageSpreadMv: 96, temperatureSpreadC: 5.4, capacityCvPct: 2.1,
          topologyLabel: "96S1P", packCapacityAh: 88, packEnergyKwh: 27.03, energyLossPct: 12,
          weakestCells: [
            { cellId: "C087", moduleId: "M08", sohPct: 88, capacityDeviationPct: -5.2 },
            { cellId: "C052", moduleId: "M05", sohPct: 92.4 },
          ],
        },
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
    expect(html).toContain("Pack 一致性诊断");
    expect(html).toContain("高风险");
    expect(html).toContain("96 mV");
    expect(html).toContain("96S1P");
    expect(html).toContain("C087 / M08 限制 Pack 可用能力");
    expect(html).toContain("容量偏差 -5.2%");
  });
});
