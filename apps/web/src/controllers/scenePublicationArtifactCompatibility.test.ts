import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord, PublishedSceneRecord, ScenePublicationDependencies } from "@bim-studio/contracts";
import { selectSceneClientDependencyInputs } from "@bim-studio/studio-core";
import { scenePublicationDependencyIdentity } from "../delivery/sceneClientFrozenDependencies";
import { exportSceneClientPackage } from "../delivery/sceneClientPackage";
// 收集阶段加载真实编译器，避免把模块转换排队计入测试执行时间。
import "../delivery/nativeSceneClientPayload";
import { createSceneArtifactRecord, type SceneArtifactRecord } from "./scenePublicationArtifactRecord";
import { createSceneArtifactRunner } from "./scenePublicationArtifactRunner";

const mocks = vi.hoisted(() => ({ project: vi.fn(), applications: vi.fn(), history: vi.fn(), dependencies: vi.fn(),
  saveScene: vi.fn(), publishScene: vi.fn(), load: vi.fn(), download: vi.fn(), zip: vi.fn(), file: vi.fn(), generate: vi.fn() }));
vi.mock("../api", () => ({ api: { getProject: mocks.project, listApplications: mocks.applications,
  getScenePublicationDependencies: mocks.dependencies,
  listScenePublications: mocks.history, saveScene: mocks.saveScene, publishScene: mocks.publishScene } }));
vi.mock("../browserDownload", () => ({ downloadBlob: mocks.download }));
vi.mock("../viewer/viewerAssetTransport", () => ({ loadViewerAssetBuffer: mocks.load }));
vi.mock("jszip", () => ({ default: class { constructor() { mocks.zip(); } file = mocks.file; generateAsync = mocks.generate; } }));

const active: Array<{ cancel: () => void; promise: Promise<unknown> }> = [];
afterEach(async () => {
  for (const request of active) request.cancel();
  await Promise.allSettled(active.map(request => request.promise));
  active.length = 0;
  vi.clearAllMocks();
});

describe("historical Native artifact compatibility", () => {
  it("persists the real compiler gate failure and retries the same publication without downloading or publishing", async () => {
    const at = "2026-09-15T12:00:00.000Z";
    const publication: PublishedSceneRecord = { sceneId: "scene", projectId: "project", version: 1,
      name: "原发布", publishedAt: at, snapshot: { schemaVersion: 1, id: "scene", projectId: "project", name: "原发布",
        models: [], primitives: [], measurements: [], camera: { mode: "orbit", position: { x: 0, y: 2, z: 3 },
          target: { x: 0, y: 0, z: 0 } }, createdAt: at, updatedAt: at, publishedAt: at } };
    const project: ProjectRecord = { id: "project", name: "项目", description: "", models: [], createdAt: at, updatedAt: at };
    const frozen: ScenePublicationDependencies = { schemaVersion: 1, projectId: publication.projectId,
      sceneId: publication.sceneId, version: publication.version!, publishedAt: publication.publishedAt,
      publicationIdentity: await scenePublicationDependencyIdentity(publication),
      inputs: selectSceneClientDependencyInputs(project, publication.snapshot, []), resources: [] };
    mocks.dependencies.mockImplementation(async (projectId: string, sceneId: string, version: number) => {
      expect({ projectId, sceneId, version }).toEqual({ projectId: frozen.projectId, sceneId: frozen.sceneId, version: frozen.version });
      return structuredClone(frozen);
    });
    mocks.history.mockResolvedValue([publication]);
    const writes: SceneArtifactRecord[] = [];
    const runner = createSceneArtifactRunner({ loadHistory: mocks.history, exportPackage: exportSceneClientPackage,
      saveRecord: vi.fn(async (record) => { writes.push(structuredClone(record)); }) });
    const original = createSceneArtifactRecord(publication, { target: "deep-native", renderer: "webgl", toolbarVisible: true });
    const run = (record: SceneArtifactRecord) => {
      const promise = runner.run(record);
      active.push({ cancel: () => runner.cancel(record.key), promise });
      return promise;
    };

    const first = await run(original);
    expect(first.result).toBeUndefined();
    expect(first.record).toMatchObject({ status: "failed", attemptId: 1, publicationVersion: 1, publishedAt: at });
    expect(first.record.error).toContain("对象 scene · camera");
    expect(first.record.error).toContain("运行证据");
    expect(first.record.error).toContain("交付方式");
    expect(writes.map(record => record.status)).toEqual(["preparing", "building", "failed"]);
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith("project", "scene");

    // 当前历史已有新版本，重试仍精确解析 v1，不能回退到最新发布。
    mocks.history.mockResolvedValue([{ ...publication, version: 2, publishedAt: "2026-09-16T12:00:00.000Z",
      snapshot: { ...publication.snapshot, name: "新发布" } }, publication]);
    const retry = await run(first.record);
    expect(retry.result).toBeUndefined();
    expect(retry.record).toMatchObject({ status: "failed", attemptId: 2, key: original.key,
      publicationVersion: 1, publishedAt: at, snapshotFingerprint: original.snapshotFingerprint });
    expect(retry.record.error).toBe(first.record.error);
    expect(writes.map(record => record.status)).toEqual(["preparing", "building", "failed", "preparing", "building", "failed"]);
    expect(mocks.history).toHaveBeenCalledTimes(2);
    expect(mocks.dependencies).toHaveBeenCalledTimes(2);
    expect(mocks.project).not.toHaveBeenCalled();
    expect(mocks.applications).not.toHaveBeenCalled();
    expect(mocks.saveScene).not.toHaveBeenCalled();
    expect(mocks.publishScene).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.zip).not.toHaveBeenCalled();
    expect(mocks.file).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
