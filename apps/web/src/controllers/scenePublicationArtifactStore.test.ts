import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishedSceneRecord } from "@bim-studio/contracts";
import { createSceneArtifactRecord } from "./scenePublicationArtifactRecord";
import { restoreSceneArtifactRecords, saveSceneArtifactRecord } from "./scenePublicationArtifactStore";

const database = vi.hoisted(() => ({ records: new Map<string, unknown>(), read: vi.fn(), write: vi.fn() }));
vi.mock("../studio/recoveryDatabase", () => ({ readRecoveryRecords: database.read, writeRecoveryRecord: database.write }));

function record(target: "three-webview" | "deep-native" = "three-webview") {
  const publication: PublishedSceneRecord = { projectId: "p", sceneId: "s", name: "test", version: 1, publishedAt: "2026-09-15T00:00:00Z",
    snapshot: { schemaVersion: 1, id: "s", projectId: "p", name: "test", models: [], primitives: [], measurements: [],
      camera: { mode: "orbit", position: { x: 1, y: 1, z: 1 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "", updatedAt: "" } };
  return createSceneArtifactRecord(publication, { target, renderer: "webgl", toolbarVisible: true });
}

beforeEach(() => {
  database.records.clear(); vi.resetAllMocks();
  database.write.mockImplementation(async (value: { key: string }) => { database.records.set(value.key, structuredClone(value)); });
  database.read.mockImplementation(async (prefix: string) => [...database.records.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value)));
});

describe("scene artifact recovery storage", () => {
  it("isolates owners and delivery targets without storing a scene copy", async () => {
    await saveSceneArtifactRecord("alice", record());
    await saveSceneArtifactRecord("alice", record("deep-native"));
    await saveSceneArtifactRecord("bob", record());
    expect(database.records.size).toBe(3);
    expect(await restoreSceneArtifactRecords("alice", "p", "s")).toHaveLength(2);
    expect(await restoreSceneArtifactRecords("bob", "p", "s")).toHaveLength(1);
    expect(await restoreSceneArtifactRecords("alice", "other", "s")).toEqual([]);
    for (const value of database.records.values()) expect(value).not.toHaveProperty("record.snapshot");
  });

  it("persists interrupted status before returning recovery records and preserves terminal results", async () => {
    await saveSceneArtifactRecord("alice", { ...record(), status: "building", attemptId: 2 });
    await saveSceneArtifactRecord("alice", { ...record("deep-native"), status: "ready" });
    const recovered = await restoreSceneArtifactRecords("alice", "p", "s");
    expect(recovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "three-webview", status: "failed", errorCode: "interrupted", attemptId: 2 }),
      expect.objectContaining({ target: "deep-native", status: "ready" }),
    ]));
    expect(await restoreSceneArtifactRecords("alice", "p", "s")).toEqual(recovered);
  });

  it("does not hide database failures as empty history", async () => {
    database.read.mockRejectedValueOnce(new Error("storage blocked"));
    await expect(restoreSceneArtifactRecords("alice", "p", "s")).rejects.toThrow("storage blocked");
    database.write.mockRejectedValueOnce(new Error("quota"));
    await expect(saveSceneArtifactRecord("alice", record())).rejects.toThrow("quota");
  });

  it("rejects corrupt or mismatched namespace records before rewriting recovery state", async () => {
    for (const value of [null, {}, { key: "wrong", record: record() }, { key: "x", record: { ...record(), sceneId: "other" } }]) {
      database.read.mockResolvedValueOnce([value]);
      await expect(restoreSceneArtifactRecords("alice", "p", "s")).rejects.toThrow(/任务/);
    }
    expect(database.write).not.toHaveBeenCalled();
  });

  it("rejects missing owners and invalid records before touching storage", async () => {
    await expect(saveSceneArtifactRecord(" ", record())).rejects.toThrow(/身份/);
    await expect(saveSceneArtifactRecord("alice", { ...record(), attemptId: -1 })).rejects.toThrow(/无效/);
    expect(database.write).not.toHaveBeenCalled();
  });
});
