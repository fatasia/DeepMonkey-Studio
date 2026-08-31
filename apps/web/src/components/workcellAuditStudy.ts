import type {
  IndustrialValidationStudyRecord,
  JsonValue,
  SaveIndustrialValidationStudyInput,
  SceneSnapshot,
  WorkcellAuditInput,
  WorkcellAuditResult,
} from "@bim-studio/contracts";
import { buildIndustrialStudyContext } from "./industrialStudyFingerprints";

const WORKCELL_ENGINE_ID = "manufacturing.workcell.audit";
const WORKCELL_ENGINE_VERSION = "1.1.0";

export function buildWorkcellAuditStudyInput({
  scene,
  result,
  scenarioInput,
  existing,
  completedAt = new Date().toISOString(),
}: {
  scene: SceneSnapshot;
  result: WorkcellAuditResult;
  scenarioInput: WorkcellAuditInput;
  existing?: IndustrialValidationStudyRecord;
  completedAt?: string;
}): SaveIndustrialValidationStudyInput {
  const actionableFindings = result.findings.filter((finding) => finding.severity !== "info").length;
  const failureCount = result.status === "passed"
    ? 0
    : Math.max(1, actionableFindings, result.incompleteObjectIds.length);

  return {
    title: `工位验证：${scene.name}`,
    sourceKind: "workcell-audit",
    studyType: "workcell-audit",
    // 保留最近若干证据指纹，让刷新后的任务卡仍能追溯历次体检输入与结果。
    sourceRefs: [...(existing?.sourceRefs ?? []), result.evidenceFingerprint],
    sceneId: scene.id,
    objectIds: result.validationDraft.objectIds,
    objective: result.validationDraft.objective,
    acceptanceCriteria: result.validationDraft.acceptanceCriteria,
    scenarioInput: structuredClone(scenarioInput) as unknown as JsonValue,
    execution: {
      engineId: WORKCELL_ENGINE_ID,
      engineVersion: WORKCELL_ENGINE_VERSION,
      deterministic: true,
    },
    context: buildIndustrialStudyContext(scene, WORKCELL_ENGINE_ID, WORKCELL_ENGINE_VERSION),
    ...(existing ? { baselineStudyId: existing.id, reproductionOf: existing.id } : {}),
    latestResult: {
      status: result.status === "passed" ? "passed" : "failed",
      scenarioId: `workcell-audit:${scene.id}`,
      evidenceFingerprint: result.evidenceFingerprint,
      failureCount,
      completedAt,
    },
  };
}

export function matchingWorkcellStudy(
  study: IndustrialValidationStudyRecord | undefined,
  sceneId: string,
): IndustrialValidationStudyRecord | undefined {
  return study?.sourceKind === "workcell-audit" && study.sceneId === sceneId ? study : undefined;
}
