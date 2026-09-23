import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BenchmarkAssetManifest, BenchmarkLoadClass } from "./benchmarkAssetManifest";
import {
  buildBenchmarkReadinessInventory,
  DE26_REQUIRED_LOAD_CLASSES,
  type BenchmarkReadinessInput,
} from "./benchmarkReadiness";
import type { BenchmarkTrajectory } from "./benchmarkAssetTrajectory";

const fixtureRoot = path.resolve(fileURLToPath(import.meta.url), "../../fixtures/benchmark-assets");

function trajectory(id = "fixture.appearance.orbit-360"): BenchmarkTrajectory {
  return {
    schema: "deep-engine.benchmark-trajectory", schemaVersion: 1, id,
    name: "orbit", durationMs: 1000, frame: "asset-bounding-sphere",
    cameraKeys: [
      { timeMs: 0, position: [0, 0, 1], target: [0, 0, 0] },
      { timeMs: 1000, position: [1, 0, 0], target: [0, 0, 0] },
    ], actions: [],
  };
}

function manifest(id: string, primaryLoadClass: BenchmarkLoadClass, completeStats = true): BenchmarkAssetManifest {
  return {
    schema: "deep-engine.benchmark-asset-manifest", schemaVersion: 1, id, name: id,
    domain: primaryLoadClass === "heterogeneous-bim" ? "bim" : "factory", primaryLoadClass,
    source: { path: `${id}.glb`, bytes: 10, sha256: "a".repeat(64), format: "glb", formatVersion: "2.0" },
    units: "meters", license: { redistributable: false, evidence: "fixture: local-only" },
    ...(completeStats ? {
      stats: { triangles: 1, materials: 1, meshes: 1, textures: 1,
        bounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] }, measuredBy: "fixture" },
    } : {}),
    tasks: [
      { kind: "appearance", fixtureId: "fixture.appearance.orbit-360" },
      { kind: "animation", fixtureId: "fixture.animation.timeline" },
      { kind: "dashboard", fixtureId: "fixture.dashboard.component-count" },
    ],
    cacheConditions: ["cold", "warm"],
  };
}

function completeInput(): BenchmarkReadinessInput {
  const manifests = DE26_REQUIRED_LOAD_CLASSES.map((loadClass, index) => manifest(`asset.${index}`, loadClass));
  return {
    manifests,
    trajectories: [trajectory(), trajectory("fixture.animation.timeline")],
    observedSources: Object.fromEntries(manifests.map((item) => [item.id, { bytes: 10, sha256: "a".repeat(64) }])),
  };
}

describe("DE26 asset readiness inventory", () => {
  it("reports a complete synthetic six-class inventory as measured", () => {
    const report = buildBenchmarkReadinessInventory(completeInput());
    expect(report.status).toBe("measured");
    expect(report.checks.every((check) => check.status === "measured")).toBe(true);
    expect(report.assets.every((asset) => asset.status === "measured")).toBe(true);
  });

  it("keeps the checked-in fixture blocked after local industrial GLBs are withdrawn", () => {
    const manifests = JSON.parse(readFileSync(path.join(fixtureRoot, "manifests-v1.json"), "utf8"))
      .manifests as BenchmarkAssetManifest[];
    const trajectories = JSON.parse(readFileSync(path.join(fixtureRoot, "trajectories-v1.json"), "utf8"))
      .trajectories as BenchmarkTrajectory[];
    const report = buildBenchmarkReadinessInventory({ manifests, trajectories });
    expect(report.status).toBe("blocked");
    expect(report.checks.find((check) => check.id === "minimum-asset-count")?.status).toBe("blocked");
    expect(report.checks.find((check) => check.id === "required-load-classes")?.status).toBe("blocked");
    expect(report.checks.find((check) => check.id === "task-coverage")?.status).toBe("blocked");
    expect(report.checks.find((check) => check.id === "source-integrity")?.status).toBe("unverified");
    expect(report.checks.find((check) => check.id === "measured-stats")?.status).toBe("unverified");
  });

  it("fails closed on a source identity mismatch and dangling fixture", () => {
    const input = completeInput();
    const first = input.manifests[0]!;
    const changed = {
      ...first,
      tasks: [{ kind: "interaction" as const, fixtureId: "fixture.missing" }],
    };
    const observedSources = { ...input.observedSources!, [first.id]: { bytes: 11, sha256: "b".repeat(64) } };
    const report = buildBenchmarkReadinessInventory({ ...input, manifests: [changed, ...input.manifests.slice(1)], observedSources });
    expect(report.status).toBe("blocked");
    expect(report.assets[0]?.source.status).toBe("blocked");
    expect(report.assets[0]?.missingTrajectoryFixtures).toEqual(["fixture.missing"]);
    expect(report.checks.find((check) => check.id === "trajectory-references")?.status).toBe("blocked");
  });

  it("rejects malformed observed source identities", () => {
    const input = completeInput();
    const id = input.manifests[0]!.id;
    const report = buildBenchmarkReadinessInventory({
      ...input,
      observedSources: { ...input.observedSources!, [id]: { bytes: 0, sha256: "not-a-sha" } },
    });
    expect(report.assets[0]?.source.status).toBe("blocked");
    expect(report.assets[0]?.source.reason).toContain("invalid byte count");
  });

  it("rejects duplicate trajectory identities instead of choosing one silently", () => {
    const input = completeInput();
    const report = buildBenchmarkReadinessInventory({ ...input, trajectories: [trajectory(), trajectory()] });
    expect(report.checks.find((check) => check.id === "trajectory-identity")?.status).toBe("blocked");
  });

  it("does not upgrade incomplete geometry stats to measured", () => {
    const input = completeInput();
    const incomplete = manifest("asset.incomplete", "factory-instances", false);
    const report = buildBenchmarkReadinessInventory({
      ...input,
      manifests: [incomplete, ...input.manifests.slice(1)],
      observedSources: { ...input.observedSources!, [incomplete.id]: { bytes: 10, sha256: "a".repeat(64) } },
    });
    expect(report.checks.find((check) => check.id === "measured-stats")?.status).toBe("unverified");
    expect(report.assets[0]?.missingStats).toEqual(["triangles", "materials", "meshes", "textures", "bounds"]);
  });

  it("fails closed instead of throwing on malformed task data", () => {
    const input = completeInput();
    const malformed = { ...input.manifests[0]!, tasks: [null, { kind: "appearance", fixtureId: "fixture.appearance.orbit-360" }] };
    const report = buildBenchmarkReadinessInventory({ ...input, manifests: [malformed, ...input.manifests.slice(1)] });
    expect(report.status).toBe("blocked");
    expect(report.assets[0]?.taskFixtures).toEqual(["fixture.appearance.orbit-360"]);
  });
});
