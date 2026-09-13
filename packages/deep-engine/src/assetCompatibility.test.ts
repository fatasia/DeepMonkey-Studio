import { describe, expect, it } from "vitest";
import {
  ASSET_FACETS,
  evaluateAssetCompatibility,
  type AssetCompatibilityProfile,
  type AssetFacet,
  type AssetFacetEvidence,
} from "./assetCompatibility.js";

const hash = "a".repeat(64);
const evidence = (status: AssetFacetEvidence["status"] = "verified"): AssetFacetEvidence => ({
  status,
  evidenceIds: status === "verified" ? ["fixture:verified"] : [],
  reason: status === "verified" || status === "unverified" ? null : "fixture coverage is incomplete",
});
const facets = (overrides: Partial<Record<AssetFacet, AssetFacetEvidence>> = {}) => Object.fromEntries(
  ASSET_FACETS.map((facet) => [facet, overrides[facet] ?? evidence()]),
) as Record<AssetFacet, AssetFacetEvidence>;
const glb: AssetCompatibilityProfile = {
  schemaVersion: 1,
  id: "gltf-2-native",
  sourceKind: "model-file",
  format: "glb",
  importer: "direct-parser",
  runtimeArtifact: "deep-asset-package",
  importerVersion: "1.0.0",
  fixtureSetHash: hash,
  deterministic: true,
  facets: facets(),
};
const viewer = { target: "native-viewer", requiredFacets: ["geometry", "hierarchy", "materials", "textures"] as const, requireDeterministicOutput: true } as const;

describe("asset compatibility claims", () => {
  it("accepts a native artifact only when every required facet has evidence", () => {
    expect(evaluateAssetCompatibility(glb, viewer)).toEqual({
      valid: true, eligible: true, issues: [], unsupported: [], partial: [], unverified: [],
    });
  });

  it("keeps partial and unverified facets out of native-ready claims", () => {
    const profile = { ...glb, facets: facets({ materials: evidence("partial"), textures: evidence("unverified") }) };
    expect(evaluateAssetCompatibility(profile, viewer)).toMatchObject({
      valid: true, eligible: false, partial: ["materials"], unverified: ["textures"],
    });
  });

  it.each(["webgl-zip", "webgpu-web-build"])("classifies Unity %s as a legacy runtime rather than a native asset", (format) => {
    const legacy = {
      ...glb,
      id: "unity-web-build",
      sourceKind: "unity-web-build",
      format,
      importer: "legacy-isolated",
      runtimeArtifact: "legacy-runtime",
    } as const;
    expect(evaluateAssetCompatibility(legacy, viewer)).toMatchObject({ valid: true, eligible: false });
    expect(evaluateAssetCompatibility({ ...legacy, runtimeArtifact: "deep-asset-package" }, viewer)).toMatchObject({
      valid: false,
      eligible: false,
      issues: expect.arrayContaining(["Unity Web builds are legacy opaque runtimes and cannot become a Deep native asset"]),
    });
  });

  it.each(["unity-project", "unity-asset-package", "unity-upm-package", "unity-asset-bundle", "unity-addressables"] as const)(
    "requires the isolated Unity Editor exporter for %s",
    (sourceKind) => {
      const invalid = { ...glb, sourceKind, format: sourceKind, importer: "direct-parser" };
      expect(evaluateAssetCompatibility(invalid, viewer)).toMatchObject({ valid: false, eligible: false });
      const migrated = { ...invalid, importer: "unity-editor-exporter" };
      expect(evaluateAssetCompatibility(migrated, viewer)).toMatchObject({ valid: true, eligible: true });
    },
  );

  it("fails closed on missing evidence and unknown fields", () => {
    const profile = { ...glb, extra: true, facets: facets({ geometry: { status: "verified", evidenceIds: [], reason: null } }) };
    const result = evaluateAssetCompatibility(profile, viewer);
    expect(result.valid).toBe(false);
    expect(result.eligible).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      "profile.extra is not part of asset compatibility v1",
      "profile.facets.geometry is verified without evidence",
    ]));
  });

  it("does not grant deterministic eligibility to non-deterministic converter output", () => {
    expect(evaluateAssetCompatibility({ ...glb, deterministic: false }, viewer)).toMatchObject({ valid: true, eligible: false });
  });
});
