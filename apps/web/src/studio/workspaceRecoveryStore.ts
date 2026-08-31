import type { ApplicationDocument, SceneSnapshot } from "@bim-studio/contracts";

const DATABASE_NAME = "bim-studio-recovery";
const STORE_NAME = "workspace-drafts";
const DATABASE_VERSION = 1;

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

/** 保存恢复副本失败不能阻断正式保存；调用方可根据布尔值记录诊断。 */
export async function writeWorkspaceRecoveryDraft(draft: WorkspaceRecoveryDraft): Promise<boolean> {
  try {
    const database = await openDatabase();
    await completeRequest(database, "readwrite", (store) => store.put(draft));
    return true;
  } catch {
    return false;
  }
}

export async function readWorkspaceRecoveryDraft(projectId: string, applicationId: string | undefined, sceneId: string): Promise<WorkspaceRecoveryDraft | undefined> {
  try {
    const database = await openDatabase();
    const value = await completeRequest(database, "readonly", (store) => store.get(workspaceRecoveryKey(projectId, applicationId, sceneId)));
    return isWorkspaceRecoveryDraft(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function deleteWorkspaceRecoveryDraft(projectId: string, applicationId: string | undefined, sceneId: string): Promise<void> {
  try {
    const database = await openDatabase();
    await completeRequest(database, "readwrite", (store) => store.delete(workspaceRecoveryKey(projectId, applicationId, sceneId)));
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

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) return Promise.reject(new Error("IndexedDB unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Cannot open recovery database"));
  });
}

function completeRequest<T>(database: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = run(transaction.objectStore(STORE_NAME));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error("Recovery database request failed"));
    // 以事务提交完成为成功点，避免页面刷新时只完成请求、尚未真正落盘。
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("Recovery database transaction aborted")); };
  });
}

function safeFileName(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 80) || "scene";
}
