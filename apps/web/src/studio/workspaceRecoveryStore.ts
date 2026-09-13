import type { ApplicationDocument, SceneSnapshot } from "@bim-studio/contracts";
import { readRecoveryRecord, removeRecoveryRecord, writeRecoveryRecord } from "./recoveryDatabase";

export interface WorkspaceRecoveryDraft {
  schemaVersion: 1;
  key: string;
  projectId: string;
  applicationId?: string;
  sceneId: string;
  baseRevision?: number;
  savedAt: string;
  scene: SceneSnapshot;
}

export function workspaceRecoveryKey(projectId: string, applicationId: string | undefined, sceneId: string): string {
  return `${projectId}:${applicationId ?? "legacy"}:${sceneId}`;
}

export function createWorkspaceRecoveryDraft(
  projectId: string,
  application: ApplicationDocument | undefined,
  scene: SceneSnapshot,
  savedAt = new Date().toISOString()
): WorkspaceRecoveryDraft {
  return {
    schemaVersion: 1,
    key: workspaceRecoveryKey(projectId, application?.metadata.id, scene.id),
    projectId,
    // 应用只保留身份与基线版本，避免恢复副本重复存储整份工作区。
    ...(application ? { applicationId: application.metadata.id, baseRevision: application.metadata.revision } : {}),
    sceneId: scene.id,
    savedAt,
    scene: structuredClone(scene)
  };
}

/** 仅时间戳变化不构成可恢复内容，避免成功保存后反复弹出空恢复提示。 */
export function hasRecoverableWorkspaceChanges(draft: WorkspaceRecoveryDraft, serverScene: SceneSnapshot): boolean {
  return comparableScene(draft.scene) !== comparableScene(serverScene);
}

function comparableScene(scene: SceneSnapshot): string {
  const { updatedAt: _updatedAt, ...value } = structuredClone(scene);
  // 加载器将这些可选集合缺省为[]；只消除已知空集合，不归一化配置、null或数值。
  for (const key of ["annotations", "cameraViews", "assetBindings", "selectionSets", "interactions"] as const) {
    if (Array.isArray(value[key]) && value[key]?.length === 0) delete value[key];
  }
  // API / IndexedDB 可按不同顺序生成同一对象；仅规范键序，数组与实际数值保持原样。
  return JSON.stringify(value, (_key: string, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  });
}

/** 保存恢复副本失败不能阻断正式保存；调用方可根据布尔值记录诊断。 */
export async function writeWorkspaceRecoveryDraft(draft: WorkspaceRecoveryDraft): Promise<boolean> {
  try {
    await writeRecoveryRecord(draft);
    return true;
  } catch {
    return false;
  }
}

export async function readWorkspaceRecoveryDraft(projectId: string, applicationId: string | undefined, sceneId: string): Promise<WorkspaceRecoveryDraft | undefined> {
  try {
    const value = await readRecoveryRecord(workspaceRecoveryKey(projectId, applicationId, sceneId));
    return isWorkspaceRecoveryDraft(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function deleteWorkspaceRecoveryDraft(projectId: string, applicationId: string | undefined, sceneId: string): Promise<void> {
  try {
    await removeRecoveryRecord(workspaceRecoveryKey(projectId, applicationId, sceneId));
  } catch {
    // 隐私模式或存储不可用时无需阻断页面操作。
  }
}

export function isWorkspaceRecoveryDraft(value: unknown): value is WorkspaceRecoveryDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<WorkspaceRecoveryDraft>;
  return draft.schemaVersion === 1
    && typeof draft.key === "string"
    && typeof draft.projectId === "string"
    && typeof draft.sceneId === "string"
    && typeof draft.savedAt === "string"
    && draft.scene?.schemaVersion === 1
    && draft.scene.id === draft.sceneId;
}

export function downloadWorkspaceRecoveryDraft(draft: WorkspaceRecoveryDraft): void {
  const blob = new Blob([`${JSON.stringify(draft, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileName(draft.scene.name)}-${draft.sceneId.slice(0, 8)}-recovery.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFileName(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 80) || "scene";
}
