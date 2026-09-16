import { describe, expect, it } from "vitest";
import { createBenchmarkAssetManifest, validateBenchmarkAssetManifest, type BenchmarkAssetManifest } from "./benchmarkAssetManifest";

function manifest(): BenchmarkAssetManifest {
  return {
    schema: "deep-engine.benchmark-asset-manifest",
    schemaVersion: 1,
    id: "asset.bim.snowdon-towers-arch",
    name: "Snowdon Towers Sample Architectural",
    domain: "bim",
    primaryLoadClass: "heterogeneous-bim",
    source: { path: "D:/test-model/Snowdon Towers Sample Architectural.rvt", bytes: 94_691_328,
      sha256: "3".repeat(64), format: "rvt", formatVersion: "unknown" },
    units: "feet",
    license: { redistributable: false, evidence: "Autodesk sample content; local benchmark use only" },
    tasks: [{ kind: "appearance", fixtureId: "fixture.appearance.orbit-360" }],
    cacheConditions: ["cold", "warm"],
  };
}

describe("benchmark asset manifest contract", () => {
  it("accepts a complete real-asset manifest", () => {
    expect(validateBenchmarkAssetManifest(manifest())).toEqual([]);
    expect(() => createBenchmarkAssetManifest(manifest())).not.toThrow();
  });

  it("fails closed on tampered hash, missing license evidence and unknown format", () => {
    const fields: Array<[keyof BenchmarkAssetManifest, unknown]> = [
      ["source", { path: "x.rvt", bytes: 10, sha256: "short", format: "rvt", formatVersion: "unknown" }],
      ["license", { redistributable: false, evidence: " " }],
    ];
    for (const [field, value] of fields) {
      const tampered = { ...manifest(), [field]: value } as BenchmarkAssetManifest;
      expect(validateBenchmarkAssetManifest(tampered).length).toBeGreaterThan(0);
    }
    const format = manifest();
    (format.source as { format: string }).format = "max";
    expect(validateBenchmarkAssetManifest(format).map(issue => issue.field)).toContain("source.format");
  });

  it("requires task fixtures, unique fixture ids and honest unit declarations", () => {
    const emptyTasks = manifest();
    (emptyTasks as { tasks: unknown[] }).tasks = [];
    expect(validateBenchmarkAssetManifest(emptyTasks).map(issue => issue.field)).toContain("tasks");
    const duplicates = manifest();
    (duplicates as { tasks: unknown }).tasks = [
      { kind: "appearance", fixtureId: "fixture.a" }, { kind: "animation", fixtureId: "fixture.a" }];
    expect(validateBenchmarkAssetManifest(duplicates).map(issue => issue.field)).toContain("tasks");
    const units = manifest();
    (units as { units: string }).units = " ";
    expect(validateBenchmarkAssetManifest(units).map(issue => issue.field)).toContain("units");
  });
});
