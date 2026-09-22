import { describe, expect, it } from "vitest";
import type { BenchmarkTrajectory } from "@bim-studio/deep-engine";
import { createBenchmarkScene } from "./benchmarkScene.js";
import { createBenchmarkTrajectoryReplay } from "./benchmarkTrajectoryReplay.js";
import catalog from "../fixtures/benchmark-assets/trajectories-v1.json";

describe("frozen benchmark trajectory replay", () => {
  it("replays a closed full orbit and uses identical deterministic poses", () => {
    const replay = createBenchmarkTrajectoryReplay(createBenchmarkScene(1024), catalog.trajectories[0] as unknown as BenchmarkTrajectory);
    expect(replay(0, 9)).toEqual(replay(8, 9));
    expect(replay(2, 9).position[0]).toBeGreaterThan(replay(0, 9).position[0]);
    expect(replay(4, 9).position[2]).toBeLessThan(replay(0, 9).position[2]);
    expect(replay(4, 9)).toEqual(replay(4, 9));
  });
  it("rejects action-bearing trajectories rather than silently ignoring actions", () => {
    expect(() => createBenchmarkTrajectoryReplay(createBenchmarkScene(1024), catalog.trajectories[1] as unknown as BenchmarkTrajectory))
      .toThrow("camera trajectories only");
  });
});
