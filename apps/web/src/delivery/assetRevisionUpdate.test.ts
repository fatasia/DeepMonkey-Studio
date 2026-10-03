import { describe, expect, it, vi } from "vitest";
import type { ModelRecord, SceneSnapshot } from "@bim-studio/contracts";
import { ASSET_FACETS, type AssetCompatibilityProfile, type AssetFacetEvidence, type DeepAssetPackage } from "@bim-studio/deep-engine";
import type { StaleAssetRevision } from "../viewer/assetRevisionSnapshot";
import { applyAssetRevisionToScenes, runAssetRevisionReimport } from "./assetRevisionUpdate";

const H = {
  blob: "b".repeat(64),
  source: "1".repeat(64),
  nextSource: "2".repeat(64),
  recipe: "3".repeat(64),
};

function compatibility(): AssetCompatibilityProfile {
  const evidence = (): AssetFacetEvidence => ({ status: "verified", evidenceIds: ["fixture:v1"], reason: null });
  return {
    schemaVersion: 1, id: "gltf-native-v1", sourceKind: "model-file", format: "glb",
    importer: "direct-parser", runtimeArtifact: "deep-asset-package", importerVersion: "1.0.0",
    fixtureSetHash: "4".repeat(64), deterministic: true,
    facets: Object.fromEntries(ASSET_FACETS.map(facet => [facet, evidence()])) as AssetCompatibilityProfile["facets"],
  };
}

function packageValue(): DeepAssetPackage {
  return {
    schemaVersion: 1,
    blobs: [{ hash: H.blob, byteLength: 16, mediaType: "application/octet-stream" }],
    manifest: {
      schemaVersion: 1,
      packageId: "pkg:a",
      source: { kind: "model-file", logicalName: "pump.glb", contentHash: H.nextSource, byteLength: 16 },
      importer: { kind: "direct-parser", id: "deep.gltf", version: "1.0.0", recipeHash: H.recipe, deterministic: true },
      compatibility: compatibility(),
      resources: [{ id: "scene/main", kind: "scene", logicalPath: "scene.json", blobHash: H.blob, dependencies: [] }],
      entryScene: "scene/main",
    },
  };
}

const model = (): ModelRecord => ({
  id: "asset-1", projectId: "p", name: "泵", format: "glb", status: "ready",
  progress: 100, size: 1, message: "ready", sourceUrl: "/pump.glb", createdAt: "now", updatedAt: "now",
  manifest: {
    schemaVersion: 1, modelId: "asset-1", sourceName: "pump.glb", sourceFormat: "glb", createdAt: "now",
    deepAssetPackage: { packageId: "pkg:a", revision: 3, sourceHash: H.nextSource, entryScene: "scene/main", packageUrl: "/deep-package.json" },
  },
} as ModelRecord);

const stale = (): StaleAssetRevision => ({
  modelId: "instance-1",
  assetModelId: "asset-1",
  packageId: "pkg:a",
  sceneRevision: 2,
  sceneSourceHash: H.source,
  latestRevision: 3,
  latestSourceHash: H.nextSource,
});

function scene(): SceneSnapshot {
  return {
    schemaVersion: 1, id: "scene-1", projectId: "p", name: "产线", camera: {} as SceneSnapshot["camera"],
    models: [{
      modelId: "instance-1", assetModelId: "asset-1", name: "泵", visible: true, opacity: 1,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      assetRevision: { packageId: "pkg:a", revision: 2, sourceHash: H.source },
    }],
    primitives: [], measurements: [], createdAt: "old", updatedAt: "old",
  } as unknown as SceneSnapshot;
}

describe("asset revision update wiring", () => {
  it("runs the DeepAssetReimportCoordinator before accepting a stale scene revision update", async () => {
    const loadJson = vi.fn().mockResolvedValue({ package: packageValue() });
    const result = await runAssetRevisionReimport(stale(), model(), { loadJson });
    expect(loadJson).toHaveBeenCalledWith("/deep-package.json", undefined);
    expect(result.status).toBe("committed");
    expect(result.plan?.version?.expectedStoreRevision).toBe(2);
    expect(result.plan?.version?.nextStoreRevision).toBe(3);
  });

  it("updates only stale scene model snapshots for the selected asset", () => {
    const update = applyAssetRevisionToScenes([scene()], model(), [stale()]);
    expect(update.changedSceneIds).toEqual(["scene-1"]);
    expect(update.updatedInstances).toBe(1);
    expect(update.scenes[0]!.models[0]!.assetRevision).toEqual({
      packageId: "pkg:a",
      revision: 3,
      sourceHash: H.nextSource,
    });
  });

  it("surfaces package loading failures instead of returning success-shaped fallbacks", async () => {
    await expect(runAssetRevisionReimport(stale(), model(), { loadJson: vi.fn().mockResolvedValue({}) }))
      .rejects.toThrow(/manifest 格式无效/);
  });
});
