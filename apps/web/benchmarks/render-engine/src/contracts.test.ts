import { describe, expect, it } from "vitest";
import { babylonAvailability } from "./babylonAdapter";
import { exportBenchmarkResult, type RenderBenchmarkSnapshot } from "./contracts";

const snapshot: RenderBenchmarkSnapshot = {
  engine: "three-webgpu",
  workload: "dynamic",
  objectCount: 10,
  initializedMs: 4,
  firstFrameMs: 8,
  lastRebuildMs: 1,
  frames: { samples: 2, averageMs: 3, p50Ms: 3, p95Ms: 4, p99Ms: 4, maximumMs: 4 },
  drawCalls: 2,
  triangles: 120,
};

describe("render benchmark result contract", () => {
  it("exports a stable JSON-safe envelope", () => {
    expect(exportBenchmarkResult(snapshot, "2026-09-15T00:00:00.000Z")).toEqual({
      schemaVersion: 1,
      capturedAt: "2026-09-15T00:00:00.000Z",
      snapshot,
    });
  });

  it("reports unavailable Babylon without inventing a sample", () => {
    const result = babylonAvailability();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("未检测到");
  });
});
