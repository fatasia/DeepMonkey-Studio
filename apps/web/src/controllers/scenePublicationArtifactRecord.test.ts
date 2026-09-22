import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishedSceneRecord } from "@bim-studio/contracts";
import { createEvidenceFingerprint } from "@bim-studio/studio-core";
import { createSceneArtifactRecord, recoverSceneArtifactRecord, resolveSceneArtifactPublication, type SceneArtifactOptions } from "./scenePublicationArtifactRecord";

const options: SceneArtifactOptions = { target: "three-webview", renderer: "webgl", toolbarVisible: false };
const NOW = "2026-09-15T12:00:00.000Z";
afterEach(() => vi.useRealTimers());
function publication(): PublishedSceneRecord {
  return { projectId: "project-1", sceneId: "scene-1", name: "发布场景", version: 3, publishedAt: NOW,
    snapshot: { schemaVersion: 1, projectId: "project-1", id: "scene-1", name: "发布场景", models: [], primitives: [], measurements: [],
      camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } },
      createdAt: NOW, updatedAt: NOW, publishedAt: NOW } };
}

describe("scene artifact record", () => {
  it("separates standalone EXE identity from archive delivery for both clients", () => {
    const archive = createSceneArtifactRecord(publication(), { ...options, target: "deep-native" });
    const executable = createSceneArtifactRecord(publication(), { ...options, target: "deep-native", format: "executable" });
    expect(executable.key).not.toBe(archive.key); expect(recoverSceneArtifactRecord(executable).format).toBe("executable");
    const webview = createSceneArtifactRecord(publication(), { ...options, format: "executable" });
    expect(webview.format).toBe("executable"); expect(webview.key).not.toBe(createSceneArtifactRecord(publication(), options).key);
  });
  it("freezes branding for exact retry and separates custom identities without changing the default key", () => {
    const source = publication(), branding = { applicationName: "客户园区" };
    const original = createSceneArtifactRecord(source, options);
    const branded = createSceneArtifactRecord(source, { ...options, branding });
    branding.applicationName = "changed";
    expect(branded.branding?.applicationName).toBe("客户园区");
    expect(branded.key).not.toBe(original.key);
    expect(createSceneArtifactRecord(source, { ...options, branding: {} }).key).toBe(original.key);
    expect(recoverSceneArtifactRecord(branded).branding).toEqual({ applicationName: "客户园区" });
    expect(() => recoverSceneArtifactRecord({ ...branded, branding: { applicationName: "tampered" } })).toThrow();
  });
  it("stores only stable publication metadata and the existing snapshot fingerprint", () => {
    const source = publication();
    const record = createSceneArtifactRecord(source, options);
    expect(record).toMatchObject({ schemaVersion: 1, projectId: source.projectId, sceneId: source.sceneId,
      publicationVersion: 3, publishedAt: NOW, target: "three-webview", renderer: "webgl", toolbarVisible: false,
      status: "preparing", attemptId: 0, snapshotFingerprint: createEvidenceFingerprint(source.snapshot) });
    expect(record).not.toHaveProperty("snapshot");
    expect(record).not.toHaveProperty("publication");
    expect(createSceneArtifactRecord(source, options).key).toBe(record.key);
    expect(createSceneArtifactRecord(source, { ...options, target: "deep-native" }).key).not.toBe(record.key);
    expect(createSceneArtifactRecord(source, { ...options, renderer: "webgpu-preferred" }).key).not.toBe(record.key);
    expect(createSceneArtifactRecord(source, { ...options, toolbarVisible: true }).key).not.toBe(record.key);
    expect(createSceneArtifactRecord({ ...source, version: 4 }, options).key).not.toBe(record.key);
  });

  it.each([undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects unusable publication version %s", (version) => {
    const source = publication();
    if (version === undefined) delete source.version;
    else source.version = version;
    expect(() => createSceneArtifactRecord(source, options)).toThrow(/版本/);
  });

  it("rejects publication and snapshot identity mismatches", () => {
    const source = publication();
    for (const snapshot of [{ ...source.snapshot, id: "other" }, { ...source.snapshot, projectId: "other" }]) {
      expect(() => createSceneArtifactRecord({ ...source, snapshot }, options)).toThrow(/身份/);
    }
    const unknown = { ...source, snapshot: { ...source.snapshot, schemaVersion: 2 } } as unknown as PublishedSceneRecord;
    expect(() => createSceneArtifactRecord(unknown, options)).toThrow(/身份/);
  });

  it("selects the exact historical version instead of the newer publication and returns an isolated copy", () => {
    const source = publication(), record = createSceneArtifactRecord(source, options);
    const newer = { ...source, version: 4, publishedAt: "2026-09-16T12:00:00.000Z", snapshot: { ...source.snapshot, name: "新草稿" } };
    const resolved = resolveSceneArtifactPublication(record, [newer, source]);
    expect(resolved).toEqual(source); expect(resolved).not.toBe(source);
    resolved.snapshot.name = "调用方改动";
    expect(source.snapshot.name).toBe("发布场景");
  });

  it("refuses missing, duplicate and partially matching history entries", () => {
    const source = publication(), record = createSceneArtifactRecord(source, options);
    for (const history of [[], [source, structuredClone(source)], [{ ...source, version: 4 }],
      [{ ...source, sceneId: "other" }], [{ ...source, projectId: "other" }], [{ ...source, publishedAt: "2026-09-16T12:00:00.000Z" }]]) {
      expect(() => resolveSceneArtifactPublication(record, history)).toThrow(/唯一定位/);
    }
  });

  it("revalidates historical snapshot identity and rejects content drift", () => {
    const source = publication(), record = createSceneArtifactRecord(source, options);
    expect(() => resolveSceneArtifactPublication(record, [{ ...source, snapshot: { ...source.snapshot, id: "other" } }])).toThrow(/身份/);
    expect(() => resolveSceneArtifactPublication(record, [{ ...source, snapshot: { ...source.snapshot, name: "被替换" } }])).toThrow(/快照/);
    const reordered = Object.fromEntries(Object.entries(source.snapshot).reverse()) as unknown as typeof source.snapshot;
    expect(resolveSceneArtifactPublication(record, [{ ...source, snapshot: reordered }])).toEqual(source);
  });

  it.each(["preparing", "building"] as const)("recovers interrupted %s as a retryable failure without changing its publication", (status) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
    const record = { ...createSceneArtifactRecord(publication(), options), status, attemptId: 2 };
    vi.setSystemTime(new Date("2026-09-16T12:00:00.000Z"));
    const recovered = recoverSceneArtifactRecord(record);
    expect(recovered).toEqual({ ...record, status: "failed", errorCode: "interrupted", error: "上次打包已中断，请重试。", updatedAt: "2026-09-16T12:00:00.000Z" });
    expect(record.status).toBe(status);
  });

  it.each(["ready", "failed", "cancelled"] as const)("keeps terminal %s state and error details on recovery", (status) => {
    const record = { ...createSceneArtifactRecord(publication(), options), status, error: "原始错误", errorCode: "failure", attemptId: 2 };
    const recovered = recoverSceneArtifactRecord(record);
    expect(recovered).toEqual(record); expect(recovered).not.toBe(record);
  });

  it("rejects a task record whose key or status no longer matches its identity", () => {
    const record = createSceneArtifactRecord(publication(), options);
    expect(() => recoverSceneArtifactRecord({ ...record, key: "wrong" })).toThrow(/记录无效/);
    expect(() => resolveSceneArtifactPublication({ ...record, publicationVersion: 4 }, [publication()])).toThrow(/记录无效/);
    expect(() => recoverSceneArtifactRecord({ ...record, attemptId: -1 })).toThrow(/记录无效/);
    expect(() => recoverSceneArtifactRecord({ ...record, updatedAt: "invalid" })).toThrow(/记录无效/);
  });
});
