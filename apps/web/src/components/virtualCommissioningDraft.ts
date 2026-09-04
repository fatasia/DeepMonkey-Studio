import type {
  IndustrialDiagnosisValidationDraft,
  IndustrialValidationStudyRecord,
  SceneSnapshot,
  VirtualDebugSignalBinding,
} from "@bim-studio/contracts";
import { virtualDebugObjectOptions } from "./virtualCommissioningModel";

export const VIRTUAL_DEBUG_SIGNALS = ["motorRunning", "alarm", "speedSetpoint"] as const;

export function defaultVirtualDebugBindings(
  scene: SceneSnapshot | undefined,
  preferredObjectId?: string,
): VirtualDebugSignalBinding[] {
  const options = virtualDebugObjectOptions(scene);
  const target = options.find((item) => item.id === preferredObjectId) ?? options[0];
  if (!scene || !target) return [];
  return [
    createVirtualDebugBinding(1, "motorRunning", scene.id, target.id, target.kind),
    createVirtualDebugBinding(2, "alarm", scene.id, target.id, target.kind),
  ];
}

export function createVirtualDebugBinding(
  index: number,
  signal: string,
  sceneId: string,
  objectId: string,
  objectKind: "model" | "primitive",
): VirtualDebugSignalBinding {
  return {
    id: `binding-${index}-${signal}`,
    signal,
    label: signal,
    presentation: signal === "alarm" ? "alarm" : signal === "motorRunning" ? "running" : "value",
    target: { sceneId, objectId, objectKind },
  };
}

export function isVirtualDebugControlSignal(signal: string): signal is (typeof VIRTUAL_DEBUG_SIGNALS)[number] {
  return (VIRTUAL_DEBUG_SIGNALS as readonly string[]).includes(signal);
}

export function validationDraftFromStudy(
  study: IndustrialValidationStudyRecord,
): IndustrialDiagnosisValidationDraft {
  return {
    // 每条 Study 运行都是独立证据；不能用继承的首个 sourceRef 把不同运行误判为同一草稿。
    sourceAssessmentId: `study:${study.id}:v${study.revision}`,
    objective: study.objective,
    signals: ["motorRunning", "alarm"],
    acceptanceCriteria: study.acceptanceCriteria,
    ...(study.sceneId ? { sceneId: study.sceneId } : {}),
    ...(study.objectIds[0] ? { objectId: study.objectIds[0] } : {}),
  };
}

export function downloadVirtualDebugEvidence(fileName: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
