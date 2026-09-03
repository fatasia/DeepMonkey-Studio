import type { PlantLiteStudyRecord, PlantLiteStudyRequest } from "@bim-studio/contracts";
import { plantLiteModelIssues } from "./plantLiteModelEditing";

const STORAGE_PREFIX = "bim-studio:plant-lite-draft:";
const MAX_DRAFT_LENGTH = 1_000_000;

interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Study 快照可恢复为可编辑输入；对比关系和结果字段不污染下一次手工运行。 */
export function plantLiteRequestFromStudy(study: PlantLiteStudyRecord): PlantLiteStudyRequest | undefined {
  const request: PlantLiteStudyRequest = {
    name: study.name,
    templateId: study.templateId,
    ...(study.model ? { model: structuredClone(study.model) } : {}),
    ...(study.agvCount !== undefined ? { agvCount: study.agvCount } : {}),
    ...(study.bufferCapacity !== undefined ? { bufferCapacity: study.bufferCapacity } : {}),
    seed: study.seed,
    replications: study.replications,
    limits: structuredClone(study.execution.limits),
    ...(study.execution.trace ? { trace: structuredClone(study.execution.trace) } : {}),
    ...(study.acceptanceTargets ? { acceptanceTargets: structuredClone(study.acceptanceTargets) } : {}),
  };
  return plantLiteModelIssues(request).length === 0 ? request : undefined;
}

export function readPlantLiteDraft(projectId: string, storage = browserStorage()): PlantLiteStudyRequest | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(storageKey(projectId));
    if (!raw || raw.length > MAX_DRAFT_LENGTH) return undefined;
    const request = JSON.parse(raw) as PlantLiteStudyRequest;
    return plantLiteModelIssues(request).length === 0 ? request : undefined;
  } catch {
    return undefined;
  }
}

export function writePlantLiteDraft(projectId: string, request: PlantLiteStudyRequest, storage = browserStorage()): boolean {
  if (!storage || plantLiteModelIssues(request).length > 0) return false;
  try {
    const raw = JSON.stringify(request);
    if (raw.length > MAX_DRAFT_LENGTH) return false;
    storage.setItem(storageKey(projectId), raw);
    return true;
  } catch {
    return false;
  }
}

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

function browserStorage(): DraftStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
