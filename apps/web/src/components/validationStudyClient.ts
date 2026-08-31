import type {
  IndustrialDiagnosisResult,
  IndustrialValidationStudyRecord,
  MaintenanceAssessmentRecord,
} from "@bim-studio/contracts";
import { api, type OperationsSnapshot } from "../api";

export function resolveDiagnosisValidationScene(
  deploymentSceneId: string | undefined,
  availableSceneIds: string[],
): string | undefined {
  if (deploymentSceneId) return deploymentSceneId;
  // 单场景项目没有选择歧义；多场景项目保留未绑定状态，避免把诊断错误关联到其他产线。
  return availableSceneIds.length === 1 ? availableSceneIds[0] : undefined;
}

export async function saveDiagnosisValidationStudy({
  projectId,
  assessment,
  diagnosis,
  existing,
  fallbackSceneId,
  fallbackObjectIds,
}: {
  projectId: string;
  assessment: MaintenanceAssessmentRecord;
  diagnosis: IndustrialDiagnosisResult;
  existing?: IndustrialValidationStudyRecord;
  fallbackSceneId?: string;
  fallbackObjectIds: string[];
}): Promise<IndustrialValidationStudyRecord> {
  const draft = diagnosis.validationDraft;
  const sceneId = draft.sceneId ?? fallbackSceneId;
  return api.saveValidationStudy(projectId, {
    ...(existing ? { id: existing.id, expectedRevision: existing.revision } : {}),
    title: `验证：${diagnosis.headline}`,
    sourceKind: "maintenance-diagnosis",
    sourceRefs: [assessment.id, diagnosis.evidenceFingerprint],
    ...(sceneId ? { sceneId } : {}),
    objectIds: draft.objectId ? [draft.objectId] : fallbackObjectIds,
    objective: draft.objective,
    acceptanceCriteria: draft.acceptanceCriteria,
  });
}

export function withValidationStudy(
  snapshot: OperationsSnapshot,
  study: IndustrialValidationStudyRecord,
): OperationsSnapshot {
  return {
    ...snapshot,
    validationStudies: [study, ...snapshot.validationStudies.filter((item) => item.id !== study.id)],
  };
}
