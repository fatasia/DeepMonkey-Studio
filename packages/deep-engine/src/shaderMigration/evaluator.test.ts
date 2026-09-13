import { describe, expect, it } from "vitest";
import { evaluateShaderMigration } from "./evaluator.js";
import { evidence, profile, requirement } from "./testFixtures.js";
import type { ShaderSourceKind } from "./types.js";

const directSources: readonly ShaderSourceKind[] = [
  "unity-standard", "unity-urp-lit", "unity-unlit", "unity-simple-lit", "unity-hdrp-lit",
  "three-mesh-standard", "three-mesh-physical",
];
const graphSources: readonly ShaderSourceKind[] = ["unity-shader-graph", "three-tsl"];
const codeSources: readonly ShaderSourceKind[] = [
  "unity-shaderlab-hlsl", "three-shader-material", "three-on-before-compile",
];

describe("shader migration strategy evaluator", () => {
  it.each(directSources)("routes verified %s coverage through a direct template", (sourceKind) => {
    expect(evaluateShaderMigration(profile(sourceKind), requirement())).toMatchObject({
      valid: true, eligible: true, strategy: "direct-template", automatic: true, lossless: true,
    });
  });

  it.each(graphSources)("routes verified %s coverage through graph translation", (sourceKind) => {
    expect(evaluateShaderMigration(profile(sourceKind), requirement())).toMatchObject({
      valid: true, eligible: true, strategy: "graph-translate", automatic: true, lossless: true,
    });
  });

  it.each(codeSources)("routes only evidenced %s coverage through the code subset", (sourceKind) => {
    expect(evaluateShaderMigration(profile(sourceKind), requirement())).toMatchObject({
      valid: true, eligible: true, strategy: "code-subset", automatic: true, lossless: true,
    });
  });

  it("keeps accepted partial graph coverage explicit", () => {
    const result = evaluateShaderMigration(
      profile("unity-shader-graph", { "surface-features": evidence("partial") }),
      requirement({ acceptPartial: true }),
    );
    expect(result).toMatchObject({
      valid: true, eligible: true, strategy: "graph-translate", automatic: true, lossless: false,
      partial: ["surface-features"],
    });
  });

  it("uses baking only for every explicitly bakeable degraded facet", () => {
    const result = evaluateShaderMigration(
      profile("unity-standard", {
        properties: evidence("partial"),
        "surface-features": evidence("unsupported"),
      }),
      requirement({ allowBake: true, bakeableFacets: ["properties", "surface-features"] }),
    );
    expect(result).toMatchObject({
      valid: true, eligible: true, strategy: "bake", automatic: true, lossless: false,
      partial: ["properties"], unsupported: ["surface-features"],
    });
  });

  it("chooses an explicit manual port when unsupported behavior cannot be baked", () => {
    const result = evaluateShaderMigration(
      profile("three-on-before-compile", { "custom-code": evidence("unsupported") }),
      requirement({ allowManualPort: true }),
    );
    expect(result).toMatchObject({
      valid: true, eligible: true, strategy: "manual-port", automatic: false, lossless: false,
      unsupported: ["custom-code"],
    });
  });

  it("rejects an unsupported facet when no safe route is authorized", () => {
    expect(evaluateShaderMigration(
      profile("three-mesh-physical", { passes: evidence("unsupported") }),
      requirement(),
    )).toMatchObject({
      valid: true, eligible: false, strategy: "rejected",
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "NO_SAFE_ROUTE" })]),
    });
  });

  it("never converts an unverified required facet into a fallback", () => {
    expect(evaluateShaderMigration(
      profile("unity-shaderlab-hlsl", { "source-mapping": evidence("unverified") }),
      requirement({ allowBake: true, bakeableFacets: ["source-mapping"], allowManualPort: true }),
    )).toMatchObject({
      valid: true, eligible: false, strategy: "rejected", unverified: ["source-mapping"],
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "UNVERIFIED_FACET" })]),
    });
  });

  it("rejects non-deterministic output when the target requires determinism", () => {
    expect(evaluateShaderMigration({ ...profile(), deterministic: false }, requirement())).toMatchObject({
      valid: true, eligible: false, strategy: "rejected",
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "NON_DETERMINISTIC" })]),
    });
  });

  it("aggregates stable evidence ids in lexical order", () => {
    const input = profile("unity-unlit", {
      compute: evidence("verified", "evidence:z"),
      properties: evidence("verified", "evidence:a"),
    });
    expect(evaluateShaderMigration(input, requirement()).evidenceIds).toEqual([
      "evidence:a", "evidence:z", "fixture:shader-v1",
    ]);
  });
});
