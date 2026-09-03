import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MaintenanceAssessmentRecord } from "@bim-studio/contracts";
import { AssessmentCard } from "./operationsPresentation";

const assessment: MaintenanceAssessmentRecord = {
  id: "assessment-1",
  projectId: "project-1",
  deploymentId: "deployment-1",
  modelId: "model-1",
  modelVersion: "1.0.0",
  generatedAt: "2026-09-03T00:00:00.000Z",
  riskLevel: "warning",
  decisionStatus: "shadow",
  score: 0.784,
  dataQuality: 0.96,
  driftScore: 1.23,
  sampleCount: 432,
  message: "轴承振动持续偏离基线，需要优先验证。",
  topContributors: [
    { feature: "bearing_vibration", value: 1.8 },
    { feature: "motor_temperature", value: 1.2 },
    { feature: "current_rms", value: 0.6 },
  ],
  evidenceFingerprint: "sha256:test",
};

describe("AssessmentCard", () => {
  it("uses compact visual metrics instead of a dense sentence for risk evidence", () => {
    const html = renderToStaticMarkup(
      <AssessmentCard assessment={assessment} busy={false} onDiagnose={vi.fn()} onCase={vi.fn()} />,
    );
    expect(html).toContain('aria-label="风险评分 78.4%"');
    expect(html).toContain('aria-label="风险贡献因子对比"');
    expect(html).toContain("数据完整率");
    expect(html).toContain("bearing_vibration");
    expect(html).toContain("AI 诊断与下一步");
  });
});
