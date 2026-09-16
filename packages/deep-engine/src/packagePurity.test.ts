import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASSET_FACETS, type AssetCompatibilityProfile, type AssetFacetEvidence } from "./assetCompatibility.js";
import type { DeepAssetPackage } from "./assetPackage.js";
import { auditDeepAssetPackagePurity, auditDeepPackagePurity, auditDeepRuntimePackagePurity,
  DEEP_PACKAGE_PURITY_LIMITS } from "./packagePurity.js";

const H = { scene: "a".repeat(64), mesh: "b".repeat(64), texture: "c".repeat(64), shader: "d".repeat(64) };
function compatibility(): AssetCompatibilityProfile {
  const evidence = (): AssetFacetEvidence => ({ status: "verified", evidenceIds: ["fixture:v1"], reason: null });
  return { schemaVersion: 1, id: "native-gltf-v1", sourceKind: "model-file", format: "glb",
    importer: "direct-parser", runtimeArtifact: "deep-asset-package", importerVersion: "1.0.0",
    fixtureSetHash: "e".repeat(64), deterministic: true,
    facets: Object.fromEntries(ASSET_FACETS.map(facet => [facet, evidence()])) as AssetCompatibilityProfile["facets"] };
}
function asset(): DeepAssetPackage {
  return { schemaVersion: 1, blobs: [
    { hash: H.scene, byteLength: 32, mediaType: "application/vnd.deep.scene" },
    { hash: H.mesh, byteLength: 64, mediaType: "application/vnd.deep.mesh" },
    { hash: H.texture, byteLength: 128, mediaType: "image/ktx2" },
    { hash: H.shader, byteLength: 48, mediaType: "text/wgsl" },
  ], manifest: { schemaVersion: 1, packageId: "factory.clean", source: { kind: "model-file",
    logicalName: "imports/unity-assets.glb", contentHash: "f".repeat(64), byteLength: 272 },
  importer: { kind: "direct-parser", id: "deep.native-import", version: "1.0.0",
    recipeHash: "1".repeat(64), deterministic: true }, compatibility: compatibility(), resources: [
      { id: "mesh/main", kind: "mesh", logicalPath: "mesh/main.mesh", blobHash: H.mesh, dependencies: [] },
      { id: "scene/main", kind: "scene", logicalPath: "scene/main.json", blobHash: H.scene,
        dependencies: ["mesh/main", "shader/main", "texture/main"] },
      { id: "shader/main", kind: "other", logicalPath: "shader/surface.wgsl", blobHash: H.shader, dependencies: [] },
      { id: "texture/main", kind: "texture", logicalPath: "texture/albedo.ktx2", blobHash: H.texture, dependencies: [] },
    ], entryScene: "scene/main" } };
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const runtime = () => JSON.parse(readFileSync(new URL("../../deep-engine-native/tests/fixtures/runtime-package-v1.json",
  import.meta.url), "utf8")) as Record<string, any>;

describe("Deep package release purity auditor", () => {
  it("allows native binary mesh, texture and WGSL resources without rejecting benign provenance", () => {
    const result = auditDeepPackagePurity(asset());
    expect(result).toMatchObject({ clean: true, packageKind: "asset", issues: [],
      evidence: { inspectedChunks: 4, truncated: false } });
    expect(auditDeepRuntimePackagePurity(runtime())).toMatchObject({ clean: true, packageKind: "runtime" });
    const benign = asset(); (benign.manifest.resources[0] as { logicalPath: string }).logicalPath = "docs/webglossary%20notes.mesh";
    expect(auditDeepAssetPackagePurity(benign)).toMatchObject({ clean: true, issues: [] });
  });

  it.each([
    ["Build/UnityLoader%2EJs", "forbidden-unity-runtime"],
    ["bin/UnityPlayer.dll", "forbidden-unity-runtime"],
    ["Editor/UnityEditor.CoreModule.dll", "forbidden-unity-runtime"],
    ["Runtime/WEBGL/mesh.bin", "forbidden-webgl"],
    ["Runtime/Chromium.pak", "forbidden-webview-runtime"],
    ["Runtime/browser-runtime/assets.bin", "forbidden-browser-runtime"],
    ["code/main.WaSm", "forbidden-wasm-runtime"],
    ["Build/game.DATA", "forbidden-unity-web-data"],
    ["Build/ＵｎｉｔｙＬｏａｄｅｒ．ｊｓ", "forbidden-unity-runtime"],
  ])("rejects disguised or case-varied path %s", (logicalPath, code) => {
    const value = asset(); (value.manifest.resources[0] as { logicalPath: string }).logicalPath = logicalPath;
    const result = auditDeepAssetPackagePurity(value);
    expect(result.issues).toContainEqual(expect.objectContaining({ code,
      path: "$.manifest.resources[0].logicalPath" }));
  });

  it("audits MIME, type, dependencies, and nested chunk metadata with stable paths", () => {
    const mime = asset(); (mime.blobs[1] as { mediaType: string }).mediaType = "application/javascript";
    expect(auditDeepAssetPackagePurity(mime).issues).toContainEqual(expect.objectContaining({
      code: "forbidden-script-runtime", path: "$.blobs[1].mediaType" }));
    const kind = asset(); (kind.manifest.resources[0] as { kind: string }).kind = "Unity-Player";
    expect(auditDeepAssetPackagePurity(kind).issues).toContainEqual(expect.objectContaining({
      code: "forbidden-unity-runtime", path: "$.manifest.resources[0].kind" }));
    const dependency = asset(); (dependency.manifest.resources[1] as { dependencies: string[] }).dependencies.push("webgl/runtime");
    expect(auditDeepAssetPackagePurity(dependency).issues).toContainEqual(expect.objectContaining({
      code: "forbidden-webgl", path: "$.manifest.resources[1].dependencies[3]" }));

    const nested = runtime(); nested.payloads["scene.main"].chunks = [{ id: "build",
      byteLength: DEEP_PACKAGE_PURITY_LIMITS.maxChunkBytes + 1,
      path: "Build/game.framework.js", mediaType: "application/javascript" }];
    const issues = auditDeepRuntimePackagePurity(nested).issues;
    expect(issues).toContainEqual(expect.objectContaining({ code: "forbidden-script-runtime",
      path: '$.payloads["scene.main"].chunks[0].path' }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "package-invalid" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "chunk-metadata-invalid",
      path: '$.payloads["scene.main"].chunks[0].byteLength' }));
  });

  it("fails closed on traversal and chunk budgets without inspecting binary payload arrays", () => {
    const limited = auditDeepAssetPackagePurity(asset(), { maxNodes: 8 });
    expect(limited).toMatchObject({ clean: false, evidence: { truncated: true } });
    expect(limited.issues).toContainEqual(expect.objectContaining({ code: "budget-exceeded" }));
    const oversized = asset(); (oversized.blobs[0] as { byteLength: number }).byteLength = DEEP_PACKAGE_PURITY_LIMITS.maxChunkBytes + 1;
    expect(auditDeepAssetPackagePurity(oversized).issues).toContainEqual(expect.objectContaining({
      code: "chunk-budget-exceeded", path: "$.blobs[0].byteLength" }));
    const value = runtime(); value.payloads["scene.main"].source = "// UnityLoader.js and WebGL are inert authored text";
    expect(auditDeepRuntimePackagePurity(value).issues.filter(issue => issue.code.startsWith("forbidden"))).toEqual([]);
  });

  it("returns deterministic machine-readable evidence regardless of object insertion order", () => {
    const reverse = (input: unknown): unknown => Array.isArray(input) ? input.map(reverse)
      : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).reverse()
        .map(([key, value]) => [key, reverse(value)])) : input;
    const expected = auditDeepAssetPackagePurity(asset());
    expect(auditDeepAssetPackagePurity(reverse(clone(asset())))).toEqual(expected);
    expect(auditDeepPackagePurity({ schema: "unknown", payload: "x" })).toMatchObject({
      clean: false, packageKind: "unknown", issues: [{ code: "package-invalid", path: "$" }] });
  });
});
