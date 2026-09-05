import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PublishedSceneRecord } from "@bim-studio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./jsonStore.js";
import { withCurrentScenePublication } from "./scenePublicationHistory.js";

const legacy: PublishedSceneRecord = {
  sceneId: "legacy", projectId: "default", name: "旧发布快照", publishedAt: "2026-08-01T00:00:00Z",
  snapshot: { schemaVersion: 1, id: "legacy", projectId: "default", name: "旧发布快照",
    camera: { position: { x: 5, y: 5, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [], primitives: [], measurements: [], createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" },
};
class LegacyStore extends JsonStore {
  seedLegacy() { this.document.publishedScenes = [structuredClone(legacy)]; this.document.scenePublicationHistory = []; }
}
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-legacy-publication-"));
  directories.push(directory);
  const store = new LegacyStore(directory);
  await store.init();
  store.seedLegacy();
  return { store, databasePath: path.join(directory, "database.json") };
}

describe("legacy scene publication history", () => {
  it("returns the actual legacy snapshot without a write or invented version number", async () => {
    const { store, databasePath } = await setup();
    const before = await readFile(databasePath, "utf8");
    const history = store.listScenePublications("legacy");
    expect(history).toEqual([legacy]);
    history[0]!.snapshot.name = "外部修改";
    expect(store.getPublication("legacy")).toEqual(legacy);
    expect(await readFile(databasePath, "utf8")).toBe(before);
    expect(store.listScenePublications("other")).toEqual([]);
  });
  it("preserves the old snapshot when publishing and increments the known sequence", async () => {
    const { store } = await setup();
    await store.savePublication({ ...legacy, publishedAt: "2026-09-05T00:00:00Z" });
    expect(store.listScenePublications("legacy").map(item => item.version)).toEqual([2, undefined]);
    expect(store.listScenePublications("legacy")[1]).toEqual(legacy);
  });
  it("retains the legacy snapshot when unpublishing", async () => {
    const { store } = await setup();
    expect(await store.removePublication("legacy")).toBe(true);
    expect(store.getPublication("legacy")).toBeUndefined();
    expect(store.listScenePublications("legacy")).toEqual([legacy]);
    expect(await store.removePublication("legacy")).toBe(false);
  });
  it("does not duplicate a known snapshot or replace its recorded version", () => {
    const recorded = { ...legacy, version: 7 };
    expect(withCurrentScenePublication([recorded], legacy)).toEqual([recorded]);
    expect(withCurrentScenePublication([], undefined)).toEqual([]);
    expect(withCurrentScenePublication([{ ...recorded, sceneId: "other" }], legacy)).toHaveLength(2);
  });
});
