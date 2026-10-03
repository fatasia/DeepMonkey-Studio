import { describe, expect, it } from "vitest";
import type { ModelRecord, SceneModelState } from "@bim-studio/contracts";
import { detectStaleAssetRevisions } from "./assetRevisionSnapshot";

const sceneState = (overrides: Partial<SceneModelState> = {}): SceneModelState => ({
  modelId: "instance-1", assetModelId: "asset-1", name: "泵", visible: true, opacity: 1,
  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  assetRevision: { packageId: "pkg:a", revision: 2, sourceHash: "a".repeat(64) },
  ...overrides,
} as SceneModelState);

const projectModel = (revision?: number): ModelRecord => ({
  id: "asset-1", projectId: "p", name: "bracket", format: "step", status: "ready",
  progress: 100, size: 1, message: "ready", sourceUrl: "/assets/a.step",
  createdAt: "2026-09-27", updatedAt: "2026-09-27",
  manifest: {
    schemaVersion: 1, modelId: "asset-1", sourceName: "bracket.step", sourceFormat: "step",
    createdAt: "2026-09-27T00:00:00Z",
    deepAssetPackage: revision === undefined ? undefined : {
      packageId: "pkg:a", revision, sourceHash: "b".repeat(64), entryScene: "scene:main",
      packageUrl: "/assets/deep-package.json",
    },
  },
} as ModelRecord);

describe("detectStaleAssetRevisions", () => {
  it("素材有更高修订时报告陈旧实例", () => {
    expect(detectStaleAssetRevisions([sceneState()], [projectModel(3)]))
      .toEqual([{
        modelId: "instance-1", assetModelId: "asset-1", packageId: "pkg:a",
        sceneRevision: 2, sceneSourceHash: "a".repeat(64),
        latestRevision: 3, latestSourceHash: "b".repeat(64),
      }]);
  });

  it("同修订、无快照、无资产包引用的实例不报告", () => {
    expect(detectStaleAssetRevisions([sceneState()], [projectModel(2)])).toEqual([]);
    const withoutSnapshot = sceneState();
    delete (withoutSnapshot as { assetRevision?: unknown }).assetRevision;
    expect(detectStaleAssetRevisions([withoutSnapshot], [projectModel(3)])).toEqual([]);
    expect(detectStaleAssetRevisions([sceneState()], [projectModel(undefined)])).toEqual([]);
  });

  it("多素材取最高修订，多实例逐一报告", () => {
    const older = projectModel(3), newer = projectModel(5);
    const report = detectStaleAssetRevisions(
      [sceneState(), sceneState({ modelId: "instance-2" })], [older, newer]);
    expect(report).toHaveLength(2);
    expect(report[0]!.latestRevision).toBe(5);
  });
});
