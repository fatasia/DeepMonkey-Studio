import { describe, expect, it } from "vitest";
import {
  applyTwinProductionRoute,
  physicsRiskReasons,
  selectLifeExpert,
  twinCommitState,
  unwrapBatteryPrediction,
} from "./batteryExpertRouting.js";

describe("battery expert production routing", () => {
  it("unwraps the Python service envelope without losing runtime evidence", () => {
    expect(unwrapBatteryPrediction({
      model: "batterymformer",
      variant: "standard",
      result: { predictedCycleLife: 1800, confidence: "high" },
      runtimeExecution: { actual: "python-service" },
      inferenceEvidence: { traceId: "trace-1" },
    })).toMatchObject({
      predictedCycleLife: 1800,
      serviceVariant: "standard",
      runtimeExecution: { actual: "python-service" },
      inferenceEvidence: { traceId: "trace-1" },
    });
  });

  it("keeps the source physical-risk triggers and selects a healthy PINN result", () => {
    const standard = lifeResult("standard", 2000, "medium", 100);
    const physics = lifeResult("physics", 1900, "high", 100);
    const reasons = physicsRiskReasons(standard);
    const decision = selectLifeExpert("dynamic", standard, physics, reasons);
    expect(reasons).toEqual(expect.arrayContaining([
      "寿命外推超过已观测区间 4 倍",
      "标准专家未达到高置信",
    ]));
    expect(decision.evidence).toMatchObject({
      authority: "production-route",
      selectedExpert: "pinn",
      reviewRequired: false,
    });
    expect(decision.selected.predictedCycleLife).toBe(1900);
  });

  it("does not blend experts when their disagreement exceeds the protection threshold", () => {
    const decision = selectLifeExpert(
      "dynamic",
      lifeResult("standard", 1000, "medium", 100),
      lifeResult("physics", 1400, "high", 100),
      ["标准专家未达到高置信"],
    );
    expect(decision.evidence).toMatchObject({ selectedExpert: "standard", reviewRequired: true });
    expect(decision.evidence.candidateComparison).toMatchObject({
      standard: { predictedCycleLife: 1000, confidence: "medium" },
      pinn: { predictedCycleLife: 1400, confidence: "high" },
    });
    expect(decision.selected.predictedCycleLife).toBe(1000);
  });

  it("reports only the PINN expert for an explicit physics run", () => {
    const physics = lifeResult("physics", 1900, "high", 100);
    const decision = selectLifeExpert("physics", physics, physics, ["用户明确选择物理专家"]);
    expect(decision.evidence).toMatchObject({
      selectedExpert: "pinn",
      executedExperts: ["pinn"],
      routePath: ["PINN 物理专家", "采纳 PINN"],
    });
    expect(decision.evidence.disagreementRatio).toBeUndefined();
  });

  it("promotes a qualified PINO route and commits the selected trajectory", () => {
    const routed = applyTwinProductionRoute({
      candidateEngine: "spm-pino-transformer",
      routing: { shadowCandidateQualified: true, operatorWeight: 0.8 },
      evidence: { fallbackActivated: false },
      summary: { finalSocPct: 70, candidateFinalSocPct: 68 },
      points: [{ baselineSocPct: 70, baselineVoltageV: 3.4, pinoSocPct: 68, pinoVoltageV: 3.38, temperatureC: 31 }],
    }, "dynamic");
    expect(routed).toMatchObject({
      status: "production-routed",
      primaryEngine: "spm-pino-transformer",
      summary: { finalSocPct: 68, selectedExpert: "pino" },
      routing: { authority: "production-route", adoptedAsPrimary: true, selectedExpert: "pino" },
    });
    expect(twinCommitState(routed)).toEqual({ soc: 0.68, temperatureC: 31 });
  });

  it("keeps the deterministic baseline when the dynamic router does not qualify PINO", () => {
    const routed = applyTwinProductionRoute({
      candidateEngine: "spm-pino-transformer",
      routing: { shadowCandidateQualified: false, operatorWeight: 0.2 },
      evidence: { fallbackActivated: false },
      summary: { finalSocPct: 70, candidateFinalSocPct: 68 },
      points: [{ baselineSocPct: 70, baselineVoltageV: 3.4, pinoSocPct: 68, pinoVoltageV: 3.38 }],
    }, "dynamic");
    expect(routed).toMatchObject({
      primaryEngine: "electro-thermal-baseline",
      summary: { finalSocPct: 70, selectedExpert: "electrothermal" },
      routing: { adoptedAsPrimary: false },
    });
  });
});

function lifeResult(
  variant: "standard" | "physics",
  predictedCycleLife: number,
  confidence: "high" | "medium" | "low",
  observedCycles: number,
): Record<string, unknown> {
  return {
    serviceVariant: variant,
    predictedCycleLife,
    confidence,
    analysisFeatures: {
      advancedModel: "batterymformer",
      advancedModelUsed: true,
      advancedModelVariant: variant,
      trend: { maxObservedCycle: observedCycles, averageFitR2: 0.8 },
    },
  };
}
