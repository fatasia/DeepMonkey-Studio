import { describe, expect, it } from "vitest";
import type { DataWritebackConfig } from "@bim-studio/contracts";
import { DatasetWritebackSession } from "./datasetWritebackSession";
import { readWritebackDraft, saveWritebackDraft, writebackDraftKey } from "./datasetWritebackDraftCache";
const config: DataWritebackConfig = { version: 1, recordPath: "/records/{id}", fields: [{ key: "n", type: "number" }] };
const snapshot = { version: '"v1"', values: { n: 1 } };
const cache = () => { const entries = new Map<string, string>(); return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } }; };
describe("writeback draft cache", () => {
  it("isolates user/project/dataset and restores only as a pending reconciliation", async () => {
    const storage = cache(), key = writebackDraftKey("user", "project", "dataset");
    const session = new DatasetWritebackSession(config, { read: async () => snapshot, write: async () => snapshot });
    await session.read("one"); session.edit("n", "3");
    expect(saveWritebackDraft(storage, key, config, session.getSnapshot(), 100)).toBe(true);
    const restored = readWritebackDraft(storage, key, config, 101);
    expect(restored?.draft.n).toBe("3");
    for (const other of [writebackDraftKey("other", "project", "dataset"), writebackDraftKey("user", "other", "dataset"), writebackDraftKey("user", "project", "other")]) expect(readWritebackDraft(storage, other, config, 101)).toBeUndefined();
    const next = new DatasetWritebackSession(config, { read: async () => snapshot, write: async () => snapshot }, restored);
    next.review(); expect(next.getSnapshot().phase).toBe("editing"); expect(next.getSnapshot().needsReconcile).toBe(true);
    expect(readWritebackDraft(storage, key, config, 100 + 86_400_001)).toBeUndefined();
    expect(readWritebackDraft(storage, key, { ...config, recordPath: "/changed/{id}" }, 101)).toBeUndefined();
  });
  it("removes clean drafts and reports storage errors without breaking editing", async () => {
    const storage = cache(); storage.setItem("draft", "stale");
    const session = new DatasetWritebackSession(config, { read: async () => snapshot, write: async () => snapshot });
    await session.read("one"); saveWritebackDraft(storage, "draft", config, session.getSnapshot()); expect(storage.getItem("draft")).toBeNull();
    session.edit("n", "3");
    expect(saveWritebackDraft({ ...storage, setItem: () => { throw new Error("quota"); } }, "draft", config, session.getSnapshot())).toBe(false);
    expect(session.getSnapshot().draft.n).toBe("3");
  });
});
