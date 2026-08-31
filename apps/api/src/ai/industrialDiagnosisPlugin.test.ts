import { describe, expect, it } from "vitest";
import type { IndustrialDiagnosisInput } from "@bim-studio/contracts";
import { composeIndustrialDiagnosis } from "./industrialDiagnosisPlugin.js";

function input(overrides: Partial<IndustrialDiagnosisInput["assessment"]> = {}): IndustrialDiagnosisInput {
  return {
    assessment: {
      id: "assessment-1", projectId: "project-1", deploymentId: "deployment-1", modelId: "model-1", modelVersion: "2.0.0",
      generatedAt: "2026-08-29T00:00:00.000Z", decisionStatus: "shadow", score: 0.82, riskLevel: "critical",
      dataQuality: 0.96, driftScore: 0.42, sampleCount: 240,
      topContributors: [{ feature: "bearing_vibration", value: 1.8 }, { feature: "motor_temp", value: 1.2 }],
      message: "风险升高", evidenceFingerprint: "a".repeat(64), ...overrides
    },
    model: { id: "model-1", name: "轴承退化模型", version: "2.0.0", algorithm: "IsolationForest", modelKind: "anomaly", benchmarkOnly: false, productionEligible: false },
    asset: { id: "motor-01", name: "一号电机", sceneId: "scene-1", objectIds: ["object-1"] }
  };
}

describe("industrial diagnosis plugin", () => {
  it("turns model evidence into ranked hypotheses and executable next actions", () => {
    const result = composeIndustrialDiagnosis(input());
    expect(result.headline).toContain("高风险");
    expect(result.hypotheses[0]).toMatchObject({ rank: 1, title: "旋转部件振动异常", status: "candidate" });
    expect(result.actions.map((item) => item.kind)).toEqual(["inspect", "simulate", "create-case"]);
    expect(result.semanticGraph.nodes.some((node) => node.kind === "signal")).toBe(true);
    expect(result.limitations).toContain("模型尚未通过生产发布门禁");
  });

  it("does not fabricate root-cause hypotheses when data is insufficient", () => {
    const result = composeIndustrialDiagnosis(input({ decisionStatus: "insufficient-data", score: undefined, riskLevel: "unknown", dataQuality: 0.42, message: "有效数据不足" }));
    expect(result.hypotheses).toEqual([]);
    expect(result.actions[0]?.kind).toBe("validate-data");
    expect(result.headline).toContain("先修复数据");
  });

  it("keeps normal assessments in monitoring instead of creating unnecessary work", () => {
    const result = composeIndustrialDiagnosis(input({ riskLevel: "normal", score: 0.08 }));
    expect(result.hypotheses).toEqual([]);
    expect(result.actions.map((item) => item.kind)).toEqual(["monitor"]);
    expect(result.summary).toContain("保持现有监测频率");
  });
});
