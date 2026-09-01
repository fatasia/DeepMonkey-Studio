import type {
  IndustrialDiagnosisResult,
  IndustrialValidationStudyRecord,
  MaintenanceAssessmentRecord,
} from "@bim-studio/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import {
  resolveDiagnosisValidationScene,
  saveDiagnosisValidationStudy,
} from "./validationStudyClient";

vi.mock("../api", () => ({ api: { saveValidationStudy: vi.fn() } }));

const assessment: MaintenanceAssessmentRecord = {
  id: "assessment-1",
  projectId: "project-1",
  deploymentId: "deployment-1",
  modelId: "model-1",
  modelVersion: "1.0.0",
  generatedAt: "2026-08-31T08:00:00.000Z",
  decisionStatus: "validated",
  score: 0.82,
  riskLevel: "warning",
  dataQuality: 0.98,
  driftScore: 0.03,
  sampleCount: 60,
  topContributors: [{ feature: "temperature", value: 0.72 }],
  message: "轴承温度异常",
  evidenceFingerprint: "assessment-evidence",
};

function diagnosis(sceneId?: string): IndustrialDiagnosisResult {
  return {
    generatedBy: "industrial-diagnosis-plugin",
    reasoningMode: "evidence-orchestration",
    severity: "warning",
    decisionStatus: "validated",
    confidence: 0.86,
    headline: "轴承温升需复核",
    summary: "建议在虚拟调试中复核联锁逻辑",
    facts: ["温度超过基线"],
    hypotheses: [],
    actions: [],
    validationDraft: {
      sourceAssessmentId: assessment.id,
      objective: "复核设备联锁与故障复位",
      signals: ["temperature"],
      acceptanceCriteria: ["故障正确锁存", "复位后恢复运行"],
      ...(sceneId ? { sceneId } : {}),
    },
    semanticGraph: { nodes: [], edges: [] },
    limitations: [],
    evidenceFingerprint: "diagnosis-evidence",
  };
}

const savedStudy = {
  id: "study-1",
  projectId: "project-1",
  revision: 1,
} as IndustrialValidationStudyRecord;

describe("saveDiagnosisValidationStudy", () => {
  beforeEach(() => {
    vi.mocked(api.saveValidationStudy).mockReset().mockResolvedValue(savedStudy);
  });

  it("keeps the deployed scene context when the AI draft omits it", async () => {
    await saveDiagnosisValidationStudy({
      projectId: "project-1",
      assessment,
      diagnosis: diagnosis(),
      fallbackSceneId: "deployed-scene",
      fallbackObjectIds: ["bearing-1"],
    });

    expect(api.saveValidationStudy).toHaveBeenCalledWith("project-1", expect.objectContaining({
      studyType: "virtual-commissioning",
      sceneId: "deployed-scene",
      objectIds: ["bearing-1"],
    }));
  });

  it("prefers the scene explicitly selected by the AI validation draft", async () => {
    await saveDiagnosisValidationStudy({
      projectId: "project-1",
      assessment,
      diagnosis: diagnosis("draft-scene"),
      fallbackSceneId: "deployed-scene",
      fallbackObjectIds: [],
    });

    expect(api.saveValidationStudy).toHaveBeenCalledWith("project-1", expect.objectContaining({
      sceneId: "draft-scene",
    }));
  });
});

describe("resolveDiagnosisValidationScene", () => {
  it("uses the deployed scene before considering workspace defaults", () => {
    expect(resolveDiagnosisValidationScene("deployed-scene", ["scene-1"])).toBe("deployed-scene");
  });

  it("automatically binds the only available scene", () => {
    expect(resolveDiagnosisValidationScene(undefined, ["scene-1"])).toBe("scene-1");
  });

  it("does not guess when multiple scenes are available", () => {
    expect(resolveDiagnosisValidationScene(undefined, ["scene-1", "scene-2"])).toBeUndefined();
  });
});
