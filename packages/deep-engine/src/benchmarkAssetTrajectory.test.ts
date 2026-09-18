import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createBenchmarkTrajectory,
  sampleTrajectoryPose,
  trajectoryActionsInWindow,
  validateBenchmarkTrajectory,
  type BenchmarkTrajectory,
} from "./benchmarkAssetTrajectory";

const fixturePath = path.resolve(fileURLToPath(import.meta.url), "../../fixtures/benchmark-assets/trajectories-v1.json");

function trajectory(): BenchmarkTrajectory {
  return {
    schema: "deep-engine.benchmark-trajectory",
    schemaVersion: 1,
    id: "fixture.test.linear-fly",
    name: "test fly",
    durationMs: 1000,
    frame: "asset-bounding-sphere",
    cameraKeys: [
      { timeMs: 0, position: [0, 0, 0], target: [0, 0, 1] },
      { timeMs: 1000, position: [10, 20, 0], target: [0, 0, -1] },
    ],
    actions: [{ kind: "select", timeMs: 500, target: "pCube13" }],
  };
}

describe("benchmark trajectory contract", () => {
  it("accepts a minimal deterministic trajectory and the frozen fixture set", () => {
    expect(validateBenchmarkTrajectory(trajectory())).toEqual([]);
    const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as { trajectories: BenchmarkTrajectory[] };
    expect(fixtures.trajectories.length).toBeGreaterThanOrEqual(2);
    for (const frozen of fixtures.trajectories) {
      expect(validateBenchmarkTrajectory(frozen), frozen.id).toEqual([]);
      expect(() => createBenchmarkTrajectory(frozen), frozen.id).not.toThrow();
    }
    const ids = fixtures.trajectories.map(item => item.id);
    expect(ids).toContain("fixture.appearance.orbit-360");
    expect(ids).toContain("fixture.factory.select-clip");
  });

  it("fails closed on schema drift, unordered keys, out-of-range times and unknown easing", () => {
    const drifted = { ...trajectory(), schemaVersion: 2 } as unknown as BenchmarkTrajectory;
    expect(validateBenchmarkTrajectory(drifted).map(issue => issue.field)).toContain("schema");
    const unordered = trajectory();
    (unordered.cameraKeys as { timeMs: number }[])[1]!.timeMs = -1;
    expect(validateBenchmarkTrajectory(unordered).map(issue => issue.field)).toContain("cameraKeys[1].timeMs");
    const badEasing = trajectory();
    (badEasing.cameraKeys[1] as { easing: string }).easing = "bounce";
    expect(validateBenchmarkTrajectory(badEasing).map(issue => issue.field)).toContain("cameraKeys[1].easing");
    const badFov = trajectory();
    (badFov.cameraKeys[1] as { fovDeg: number }).fovDeg = 200;
    expect(validateBenchmarkTrajectory(badFov).map(issue => issue.field)).toContain("cameraKeys[1].fovDeg");
    const emptySelect = trajectory();
    (emptySelect.actions[0] as { target: string }).target = " ";
    expect(validateBenchmarkTrajectory(emptySelect).map(issue => issue.field)).toContain("actions[0].target");
    const unorderedActions = trajectory();
    (unorderedActions.actions as { timeMs: number }[])[0]!.timeMs = 2000;
    expect(validateBenchmarkTrajectory(unorderedActions).map(issue => issue.field)).toContain("actions[0].timeMs");
  });
});

describe("trajectory replay math", () => {
  it("interpolates linear segments and clamps outside the window", () => {
    const pose = sampleTrajectoryPose(trajectory(), 500);
    expect(pose.position).toEqual([5, 10, 0]);
    expect(pose.target).toEqual([0, 0, 0]);
    expect(pose.fovDeg).toBe(48);
    expect(sampleTrajectoryPose(trajectory(), -5).position).toEqual([0, 0, 0]);
    expect(sampleTrajectoryPose(trajectory(), 1500).position).toEqual([10, 20, 0]);
  });

  it("applies ease-in-out deterministically and keeps fov interpolation exact", () => {
    const eased: BenchmarkTrajectory = {
      ...trajectory(),
      cameraKeys: [
        { timeMs: 0, position: [0, 0, 0], target: [0, 0, 0], fovDeg: 40 },
        { timeMs: 1000, position: [10, 0, 0], target: [0, 0, 0], fovDeg: 60, easing: "ease-in-out" },
      ],
    };
    // smoothstep(0.25) = 0.15625 → 位置 1.5625,fov 43.125;纯函数,同输入同输出
    const quarter = sampleTrajectoryPose(eased, 250);
    expect(quarter.position[0]).toBeCloseTo(1.5625, 12);
    expect(quarter.fovDeg).toBeCloseTo(43.125, 12);
    expect(sampleTrajectoryPose(eased, 250)).toEqual(quarter);
    const half = sampleTrajectoryPose(eased, 500);
    expect(half.position[0]).toBeCloseTo(5, 12);
  });

  it("dispatches actions with [from, to) windows that partition without overlap", () => {
    const frozen = (JSON.parse(readFileSync(fixturePath, "utf8")) as { trajectories: BenchmarkTrajectory[] })
      .trajectories.find(item => item.id === "fixture.factory.select-clip")!;
    expect(trajectoryActionsInWindow(frozen, 0, 3500)).toHaveLength(0);
    const pick = trajectoryActionsInWindow(frozen, 3500, 3501);
    expect(pick.map(action => action.kind)).toEqual(["input", "select"]);
    const all = trajectoryActionsInWindow(frozen, 0, frozen.durationMs);
    expect(all).toHaveLength(frozen.actions.length);
    let covered = 0;
    for (let start = 0; start < frozen.durationMs; start += 100) {
      covered += trajectoryActionsInWindow(frozen, start, start + 100).length;
    }
    expect(covered).toBe(frozen.actions.length);
  });
});
