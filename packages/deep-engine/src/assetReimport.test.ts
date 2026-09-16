import { describe, expect, it } from "vitest";
import { ASSET_FACETS, type AssetCompatibilityProfile, type AssetFacetEvidence } from "./assetCompatibility.js";
import type { DeepAssetPackage, DeepAssetResource, DeepAssetStoreSnapshot } from "./assetPackage.js";
import { planDeepAssetReimport, type DeepAssetUserOverride } from "./assetReimport.js";

const H = { mesh: "a".repeat(64), material: "b".repeat(64), scene: "c".repeat(64),
  texture: "d".repeat(64), metadata: "e".repeat(64), source: "f".repeat(64),
  recipe: "1".repeat(64), nextSource: "2".repeat(64), override: "9".repeat(64), changed: "8".repeat(64) };

function compatibility(): AssetCompatibilityProfile {
  const evidence = (): AssetFacetEvidence => ({ status: "verified", evidenceIds: ["fixture:v1"], reason: null });
  return { schemaVersion: 1, id: "gltf-native-v1", sourceKind: "model-file", format: "glb",
    importer: "direct-parser", runtimeArtifact: "deep-asset-package", importerVersion: "1.0.0",
    fixtureSetHash: "7".repeat(64), deterministic: true,
    facets: Object.fromEntries(ASSET_FACETS.map(facet => [facet, evidence()])) as AssetCompatibilityProfile["facets"] };
}

function resource(id: string, kind: DeepAssetResource["kind"], blobHash: string,
  dependencies: readonly string[] = [], logicalPath = `${id}.bin`): DeepAssetResource {
  return { id, kind, logicalPath, blobHash, dependencies };
}

function packageValue(next = false): DeepAssetPackage {
  const resources = next ? [
    resource("material/main", "material", H.material, ["texture/color"]),
    resource("metadata/info", "metadata", H.metadata),
    resource("scene/main", "scene", H.scene, ["material/main", "metadata/info"]),
    resource("texture/color", "texture", H.texture, [], "textures/renamed-color.bin"),
  ] : [
    resource("material/main", "material", H.material, ["texture/color"]),
    resource("mesh/cube", "mesh", H.mesh),
    resource("scene/main", "scene", H.scene, ["material/main", "mesh/cube"]),
    resource("texture/color", "texture", H.texture, [], "textures/color.bin"),
  ];
  const hashes = next ? [H.material, H.scene, H.texture, H.metadata] : [H.mesh, H.material, H.scene, H.texture];
  return { schemaVersion: 1, blobs: hashes.sort().map(hash => ({ hash, byteLength: 16, mediaType: "application/octet-stream" })),
    manifest: { schemaVersion: 1, packageId: "factory.cell", source: { kind: "model-file",
      logicalName: "imports/cell.glb", contentHash: next ? H.nextSource : H.source, byteLength: 64 },
    importer: { kind: "direct-parser", id: "deep.gltf", version: "1.0.0", recipeHash: H.recipe, deterministic: true },
    compatibility: compatibility(), resources, entryScene: "scene/main" } };
}

function snapshot(): DeepAssetStoreSnapshot {
  const previous = packageValue();
  return { revision: 12, active: { packageId: previous.manifest.packageId,
    sourceHash: previous.manifest.source.contentHash, recipeHash: previous.manifest.importer.recipeHash },
    blobHashes: previous.blobs.map(value => value.hash) };
}

const override = (id: string, resourceId: string, baseBlobHash: string): DeepAssetUserOverride => ({
  id, resourceId, baseBlobHash, overrideHash: H.override, revision: 3,
});

describe("Deep Asset incremental reimport planner", () => {
  it("classifies stable GUID changes, preserves rename overrides, and emits safe rollback order", () => {
    const inputOverrides = [override("override/color", "texture/color", H.texture)];
    const plan = planDeepAssetReimport(packageValue(), packageValue(true), snapshot(),
      { generation: 41, overrides: inputOverrides });
    expect(plan.status).toBe("ready");
    expect(plan.diff).toEqual({ unchanged: ["material/main"], add: ["metadata/info"],
      update: [
        { id: "scene/main", changes: ["dependencies"], renamed: false },
        { id: "texture/color", changes: ["logicalPath"], renamed: true },
      ], remove: ["mesh/cube"] });
    expect(plan.preservedOverrides).toEqual(inputOverrides);
    expect(plan.execution).toEqual({
      stageOrder: ["texture/color", "material/main", "metadata/info", "scene/main"],
      publishOrder: ["texture/color", "material/main", "metadata/info", "scene/main"],
      removeOrder: ["mesh/cube"],
      rollbackOrder: ["scene/main", "metadata/info", "material/main", "texture/color"],
    });
    expect(plan.commit).toMatchObject({ expectedRevision: 12, nextRevision: 13 });
    expect(plan.version).toMatchObject({ generation: 41, expectedStoreRevision: 12, nextStoreRevision: 13,
      packageId: "factory.cell", baseSourceHash: H.source, nextSourceHash: H.nextSource });
    expect(Object.isFrozen(plan.execution?.stageOrder)).toBe(true);
  });

  it("fails closed on source/override conflict while retaining unambiguous overrides", () => {
    const next = packageValue(true), texture = next.manifest.resources.find(value => value.id === "texture/color")!;
    (next.manifest as { resources: DeepAssetResource[] }).resources = next.manifest.resources.map(value =>
      value.id === texture.id ? { ...value, blobHash: H.changed } : value);
    (next as { blobs: DeepAssetPackage["blobs"] }).blobs = [...next.blobs,
      { hash: H.changed, byteLength: 16, mediaType: "application/octet-stream" }].sort((a, b) => a.hash.localeCompare(b.hash));
    const overrides = [override("override/material", "material/main", H.material),
      override("override/texture", "texture/color", H.texture)];
    const plan = planDeepAssetReimport(packageValue(), next, snapshot(), { generation: 42, overrides });
    expect(plan).toMatchObject({ status: "conflicted", commit: null,
      preservedOverrides: [{ id: "override/material" }],
      conflicts: [{ overrideId: "override/texture", resourceId: "texture/color", reason: "source-changed",
        previousBlobHash: H.texture, nextBlobHash: H.changed }] });
    expect(plan.version?.generation).toBe(42);
  });

  it("rejects cycles, missing dependencies, stale bases, and invalid generations", () => {
    const cycle = packageValue(true) as unknown as { manifest: { resources: DeepAssetResource[] } };
    cycle.manifest.resources = cycle.manifest.resources.map(value => value.id === "texture/color"
      ? { ...value, dependencies: ["material/main"] } : value);
    expect(planDeepAssetReimport(packageValue(), cycle, snapshot(), { generation: 1 }).issues)
      .toContainEqual(expect.objectContaining({ code: "dependency-cycle" }));
    const missing = packageValue(true) as unknown as { manifest: { resources: DeepAssetResource[] } };
    missing.manifest.resources = missing.manifest.resources.map(value => value.id === "material/main"
      ? { ...value, dependencies: ["texture/missing"] } : value);
    expect(planDeepAssetReimport(packageValue(), missing, snapshot(), { generation: 1 }).issues)
      .toContainEqual(expect.objectContaining({ code: "missing-dependency" }));
    expect(planDeepAssetReimport(packageValue(), packageValue(true), { ...snapshot(), active: null }, { generation: 1 }))
      .toMatchObject({ status: "rejected", issues: [{ code: "stale-base" }] });
    expect(planDeepAssetReimport(packageValue(), packageValue(true), snapshot(), { generation: 0 }))
      .toMatchObject({ status: "rejected", issues: [{ code: "invalid-generation" }] });
    expect(planDeepAssetReimport(packageValue(), packageValue(true), { ...snapshot(), revision: -1 }, { generation: 1 }))
      .toMatchObject({ status: "rejected", issues: [{ path: "$snapshot.revision" }] });
  });

  it("is deterministic and stamps successive plans so an executor can enforce latest-wins", () => {
    const request = [packageValue(), packageValue(true), snapshot()] as const;
    const first = planDeepAssetReimport(...request, { generation: 100 });
    expect(planDeepAssetReimport(...request, { generation: 100 })).toEqual(first);
    const latest = planDeepAssetReimport(...request, { generation: 101 });
    expect(first.version).toMatchObject({ generation: 100, expectedStoreRevision: 12 });
    expect(latest.version).toMatchObject({ generation: 101, expectedStoreRevision: 12 });
    expect(latest.diff).toEqual(first.diff); expect(latest.execution).toEqual(first.execution);
  });
});
