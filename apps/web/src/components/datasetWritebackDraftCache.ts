import type { DataWritebackConfig, DataWritebackSnapshot } from "@bim-studio/contracts";
import { createWritebackDraft } from "./dashboardWritebackDraft";
import type { WritebackState } from "./datasetWritebackSession";

export interface CachedWritebackDraft { recordId: string; baseline: DataWritebackSnapshot; draft: Record<string, string> }
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const lifetime = 24 * 60 * 60 * 1000;
export const writebackDraftKey = (userId: string, projectId: string, datasetId: string, fixedRecordId?: string) =>
  `studio:record-draft:${JSON.stringify([userId, projectId, datasetId])}${fixedRecordId === undefined ? "" : `:${JSON.stringify(fixedRecordId)}`}`;

export function readWritebackDraft(storage: DraftStorage, key: string, config: DataWritebackConfig, now = Date.now()): CachedWritebackDraft | undefined {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null");
    if (!value || value.config !== JSON.stringify(config) || !Number.isFinite(value.savedAt) || now - value.savedAt > lifetime || value.savedAt > now
      || typeof value.recordId !== "string" || !/^[\p{L}\p{N}_-]{1,128}$/u.test(value.recordId)
      || typeof value.baseline?.version !== "string" || typeof value.baseline?.values !== "object" || !value.baseline.values
      || !value.draft || typeof value.draft !== "object" || Array.isArray(value.draft)
      || config.fields.some(field => typeof value.draft[field.key] !== "string" || value.draft[field.key].length > 4096)
      || Object.keys(value.draft).some(field => !config.fields.some(item => item.key === field))) return undefined;
    return { recordId: value.recordId, baseline: value.baseline, draft: value.draft };
  } catch { return undefined; }
}

export function saveWritebackDraft(storage: DraftStorage, key: string, config: DataWritebackConfig, state: WritebackState, now = Date.now()): boolean {
  try {
    const original = state.baseline ? createWritebackDraft(config, state.baseline) : {};
    const dirty = config.fields.some(field => state.draft[field.key] !== original[field.key]);
    if (!state.baseline || state.saved || (!dirty && !state.needsReconcile)) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ recordId: state.recordId, baseline: state.baseline, draft: state.draft, config: JSON.stringify(config), savedAt: now }));
    return true;
  } catch { return false; }
}
