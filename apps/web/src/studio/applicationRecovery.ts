import { assertApplicationDocument, type ApplicationDocument, type ScriptModule } from "@bim-studio/contracts";
import { readRecoveryRecord, removeRecoveryRecord, writeRecoveryRecord } from "./recoveryDatabase";

export interface ApplicationRecoveryDraft {
  schemaVersion: 1;
  kind: "application-recovery";
  key: string;
  savedAt: string;
  document: ApplicationDocument;
}

export function applicationRecoveryKey(document: ApplicationDocument): string {
  return `application:${document.metadata.projectId}:${document.metadata.id}`;
}
export function applicationRecoveryFingerprint(document: ApplicationDocument): string {
  const { revision: _revision, updatedAt: _updatedAt, ...metadata } = document.metadata;
  return JSON.stringify({ ...document, metadata }, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  });
}
export function applicationRecoveryDocument(document: ApplicationDocument, pendingScript?: ScriptModule): ApplicationDocument {
  const snapshot = structuredClone(document);
  if (pendingScript) {
    const index = snapshot.scripts.findIndex(script => script.id === pendingScript.id);
    if (index >= 0) snapshot.scripts[index] = structuredClone(pendingScript);
    else snapshot.scripts.push(structuredClone(pendingScript));
  }
  return snapshot;
}
export function restoredApplicationDocument(draft: ApplicationRecoveryDraft, server: ApplicationDocument): ApplicationDocument {
  if (draft.key !== applicationRecoveryKey(server)) throw new Error("恢复副本不属于当前应用");
  return { ...structuredClone(draft.document), metadata: { ...draft.document.metadata,
    id: server.metadata.id, projectId: server.metadata.projectId, revision: server.metadata.revision,
    createdAt: server.metadata.createdAt, updatedAt: server.metadata.updatedAt } };
}
export async function readApplicationRecovery(document: ApplicationDocument): Promise<ApplicationRecoveryDraft | undefined> {
  const raw = await readRecoveryRecord(applicationRecoveryKey(document));
  if (!raw || typeof raw !== "object") return;
  const value = raw as Partial<ApplicationRecoveryDraft>;
  if (value.kind !== "application-recovery" || value.schemaVersion !== 1 || value.key !== applicationRecoveryKey(document)
    || typeof value.savedAt !== "string") return;
  try { assertApplicationDocument(value.document); } catch { return; }
  if (value.document.metadata.id !== document.metadata.id || value.document.metadata.projectId !== document.metadata.projectId) return;
  return value as ApplicationRecoveryDraft;
}
export async function writeApplicationRecovery(document: ApplicationDocument): Promise<void> {
  await writeRecoveryRecord({ kind: "application-recovery", schemaVersion: 1, key: applicationRecoveryKey(document),
    savedAt: new Date().toISOString(), document: structuredClone(document) } as ApplicationRecoveryDraft);
}
export async function discardApplicationRecovery(document: ApplicationDocument): Promise<void> {
  await removeRecoveryRecord(applicationRecoveryKey(document));
}
