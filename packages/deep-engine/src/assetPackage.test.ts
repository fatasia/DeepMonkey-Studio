import { describe, expect, it } from "vitest";
import {
  ASSET_FACETS,
  type AssetCompatibilityProfile,
  type AssetFacetEvidence,
} from "./assetCompatibility.js";
import { DEEP_ASSET_PACKAGE_BUDGETS, type DeepAssetPackage, type DeepAssetStoreSnapshot } from "./assetPackage.js";
import { planDeepAssetImport, validateDeepAssetPackage } from "./assetPackageValidation.js";

const hashes = { mesh: "a".repeat(64), scene: "b".repeat(64), missing: "c".repeat(64) } as const;

function compatibility(): AssetCompatibilityProfile {
  const verified = (): AssetFacetEvidence => ({ status: "verified", evidenceIds: ["fixture:v1"], reason: null });
  return {
    schemaVersion: 1,
    id: "gltf-native-v1",
    sourceKind: "model-file",
    format: "glb",
    importer: "direct-parser",
    runtimeArtifact: "deep-asset-package",
    importerVersion: "1.0.0",
    fixtureSetHash: "d".repeat(64),
    deterministic: true,
    facets: Object.fromEntries(ASSET_FACETS.map((facet) => [facet, verified()])) as AssetCompatibilityProfile["facets"],
  };
}

function candidate(): DeepAssetPackage {
  return {
    schemaVersion: 1,
    blobs: [
      { hash: hashes.mesh, byteLength: 36, mediaType: "application/vnd.deep.mesh" },
      { hash: hashes.scene, byteLength: 72, mediaType: "application/vnd.deep.scene" },
    ],
    manifest: {
      schemaVersion: 1,
      packageId: "factory.robot-cell",
      source: { kind: "model-file", logicalName: "imports/robot-cell.glb", contentHash: "e".repeat(64), byteLength: 108 },
      importer: { kind: "direct-parser", id: "deep.gltf", version: "1.0.0", recipeHash: "f".repeat(64), deterministic: true },
      compatibility: compatibility(),
      resources: [
        { id: "mesh/cube", kind: "mesh", logicalPath: "meshes/cube.bin", blobHash: hashes.mesh, dependencies: [] },
        { id: "scene/main", kind: "scene", logicalPath: "scenes/main.json", blobHash: hashes.scene, dependencies: ["mesh/cube"] },
      ],
      entryScene: "scene/main",
    },
  };
}

function snapshot(): DeepAssetStoreSnapshot {
  return { revision: 7, active: null, blobHashes: [hashes.mesh] };
}

function issueCodes(value: unknown) {
  return validateDeepAssetPackage(value).issues.map((issue) => issue.code);
}

describe("Deep Asset Package v1", () => {
  it("validates content addressed resources, provenance, facet evidence and dependency order", () => {
    const result = validateDeepAssetPackage(candidate());
    expect(result).toMatchObject({ valid: true, issues: [], resourceOrder: ["mesh/cube", "scene/main"] });
    expect(result.value?.manifest.compatibility.facets.geometry).toMatchObject({ status: "verified", evidenceIds: ["fixture:v1"] });
  });

  it.each([
    "../secret.glb",
    "/root/secret.glb",
    "C:/secret.glb",
    "safe/../secret.glb",
    "safe\\secret.glb",
  ])("rejects non-canonical or traversing logical path %s", (logicalName) => {
    const value = candidate() as unknown as { manifest: { source: { logicalName: string } } };
    value.manifest.source.logicalName = logicalName;
    expect(issueCodes(value)).toContain("invalid-value");
  });

  it("accepts NFC Unicode logical names and rejects canonically equivalent NFD spellings", () => {
    const unicode = candidate();
    (unicode.manifest.source as { logicalName: string }).logicalName = "导入/机器人-é.glb";
    expect(validateDeepAssetPackage(unicode).valid).toBe(true);
    (unicode.manifest.source as { logicalName: string }).logicalName = "导入/机器人-e\u0301.glb";
    expect(issueCodes(unicode)).toContain("invalid-value");
  });

  it("rejects uppercase digests and conflicting declarations for one blob hash", () => {
    const uppercase = candidate();
    (uppercase.blobs[0] as { hash: string }).hash = hashes.mesh.toUpperCase();
    expect(issueCodes(uppercase)).toEqual(expect.arrayContaining(["invalid-value", "missing-blob"]));

    const conflict = candidate();
    (conflict.blobs as Array<unknown>).splice(1, 0, { hash: hashes.mesh, byteLength: 99, mediaType: "application/octet-stream" });
    expect(issueCodes(conflict)).toContain("duplicate-hash-conflict");
  });

  it("rejects duplicate resource ids, missing blobs and missing dependencies", () => {
    const duplicate = candidate();
    (duplicate.manifest.resources as Array<unknown>).push(structuredClone(duplicate.manifest.resources[0]));
    expect(issueCodes(duplicate)).toContain("duplicate-id");

    const missing = candidate();
    const scene = missing.manifest.resources[1] as unknown as { blobHash: string; dependencies: string[] };
    scene.blobHash = hashes.missing;
    scene.dependencies = ["mesh/missing"];
    expect(issueCodes(missing)).toEqual(expect.arrayContaining(["missing-blob", "missing-dependency"]));
  });

  it("rejects duplicate logical paths independently of stable resource ids", () => {
    const value = candidate();
    (value.manifest.resources[1] as unknown as { logicalPath: string }).logicalPath = "meshes/cube.bin";
    expect(issueCodes(value)).toContain("duplicate-path");
  });

  it("rejects dependency cycles and entry points that are absent or not scenes", () => {
    const cyclic = candidate();
    (cyclic.manifest.resources[0] as unknown as { dependencies: string[] }).dependencies = ["scene/main"];
    expect(issueCodes(cyclic)).toContain("dependency-cycle");

    const wrongEntry = candidate();
    (wrongEntry.manifest as { entryScene: string }).entryScene = "mesh/cube";
    expect(issueCodes(wrongEntry)).toContain("invalid-entry-scene");
  });

  it("fails closed on unknown fields, non-canonical arrays and non-deterministic importers", () => {
    const unknown = candidate() as DeepAssetPackage & { extra: boolean };
    unknown.extra = true;
    expect(issueCodes(unknown)).toContain("unknown-field");

    const unordered = candidate();
    (unordered.manifest.resources as Array<unknown>).reverse();
    expect(issueCodes(unordered)).toContain("non-deterministic");

    const nonDeterministic = candidate();
    (nonDeterministic.manifest.importer as { deterministic: boolean }).deterministic = false;
    expect(issueCodes(nonDeterministic)).toContain("non-deterministic");
  });

  it.each([
    (value: DeepAssetPackage) => Object.assign(value.manifest, { extra: true }),
    (value: DeepAssetPackage) => Object.assign(value.manifest.source, { extra: true }),
    (value: DeepAssetPackage) => Object.assign(value.manifest.importer, { extra: true }),
    (value: DeepAssetPackage) => Object.assign(value.blobs[0]!, { extra: true }),
    (value: DeepAssetPackage) => Object.assign(value.manifest.resources[0]!, { extra: true }),
  ])("rejects unknown fields at every package nesting layer", (mutate) => {
    const value = candidate(); mutate(value);
    expect(issueCodes(value)).toContain("unknown-field");
  });

  it("rejects unordered facet evidence, sparse arrays, array properties and non-canonical numbers", () => {
    const evidence = candidate();
    (evidence.manifest.compatibility.facets.geometry.evidenceIds as string[]).push("fixture:a");
    expect(issueCodes(evidence)).toContain("non-deterministic");

    const sparse = candidate();
    (sparse.manifest.resources as Array<unknown>).length = 3;
    expect(issueCodes(sparse)).toContain("non-deterministic");

    const property = candidate();
    Object.assign(property.blobs, { named: true });
    expect(issueCodes(property)).toContain("non-deterministic");

    const negativeZero = candidate();
    (negativeZero.manifest.source as { byteLength: number }).byteLength = -0;
    expect(issueCodes(negativeZero)).toContain("non-deterministic");
  });

  it.each([
    { schemaVersion: 1, manifest: null, blobs: [] },
    { schemaVersion: 1, manifest: { schemaVersion: 1, resources: null }, blobs: [] },
    { schemaVersion: 1, manifest: { schemaVersion: 1, resources: [null] }, blobs: [] },
    { schemaVersion: 1, manifest: { schemaVersion: 1, resources: [{ id: "scene/main", dependencies: {} }] }, blobs: [] },
    { schemaVersion: 1, manifest: { schemaVersion: 1, resources: [{ id: "scene/main", dependencies: [{}] }] }, blobs: [] },
    { schemaVersion: 1, manifest: { schemaVersion: 1, compatibility: null, resources: [] }, blobs: [] },
    { schemaVersion: 1, manifest: {}, blobs: "bad" },
  ])("returns diagnostics instead of throwing for malformed decoded input", (value) => {
    expect(() => validateDeepAssetPackage(value)).not.toThrow();
    expect(validateDeepAssetPackage(value).valid).toBe(false);
  });

  it("rejects accessors without invoking them", () => {
    const value = candidate() as DeepAssetPackage & { surprise?: unknown };
    let invoked = false, arrayInvoked = false;
    Object.defineProperty(value, "surprise", { enumerable: true, get: () => { invoked = true; throw new Error("must not run"); } });
    expect(issueCodes(value)).toContain("non-deterministic");
    expect(invoked).toBe(false);

    const arrayValue = candidate();
    Object.defineProperty(arrayValue.blobs, "0", { enumerable: true, get: () => { arrayInvoked = true; throw new Error("must not run"); } });
    expect(issueCodes(arrayValue)).toContain("non-deterministic");
    expect(arrayInvoked).toBe(false);
  });

  it("caps diagnostics for adversarial packages", () => {
    const value = candidate() as DeepAssetPackage & Record<string, unknown>;
    for (let index = 0; index < DEEP_ASSET_PACKAGE_BUDGETS.maxIssues * 2; index += 1) value[`unknown${index}`] = true;
    const result = validateDeepAssetPackage(value);
    expect(result.issues).toHaveLength(DEEP_ASSET_PACKAGE_BUDGETS.maxIssues);
    expect(result.issues.at(-1)).toMatchObject({ code: "budget-exceeded", path: "$" });
  });

  it("plans an optimistic atomic commit and separates reused from new blobs", () => {
    const source = candidate(), state = snapshot();
    const sourceBefore = JSON.stringify(source), stateBefore = JSON.stringify(state);
    expect(planDeepAssetImport(source, state)).toEqual({
      status: "ready",
      issues: [],
      commit: {
        expectedRevision: 7,
        nextRevision: 8,
        nextActive: { packageId: "factory.robot-cell", sourceHash: "e".repeat(64), recipeHash: "f".repeat(64) },
        entryScene: "scene/main",
        resourceOrder: ["mesh/cube", "scene/main"],
        addBlobHashes: [hashes.scene],
        reuseBlobHashes: [hashes.mesh],
      },
    });
    expect(JSON.stringify(source)).toBe(sourceBefore);
    expect(JSON.stringify(state)).toBe(stateBefore);
  });

  it("returns no commit and does not mutate active state when validation fails", () => {
    const source = candidate(), state = snapshot(), stateBefore = JSON.stringify(state);
    (source.manifest.resources[1] as { blobHash: string }).blobHash = hashes.missing;
    expect(planDeepAssetImport(source, state)).toMatchObject({ status: "rejected", commit: null });
    expect(JSON.stringify(state)).toBe(stateBefore);
  });

  it("rejects invalid store snapshots before producing a commit", () => {
    const state = snapshot() as { revision: number; active: null; blobHashes: string[] };
    state.blobHashes = [hashes.scene, hashes.mesh];
    expect(planDeepAssetImport(candidate(), state)).toMatchObject({
      status: "rejected",
      commit: null,
      issues: expect.arrayContaining([expect.objectContaining({ code: "non-deterministic", path: "$snapshot.blobHashes" })]),
    });

    const exhausted = snapshot();
    (exhausted as { revision: number }).revision = Number.MAX_SAFE_INTEGER;
    expect(planDeepAssetImport(candidate(), exhausted)).toMatchObject({ status: "rejected", commit: null });
  });
});
