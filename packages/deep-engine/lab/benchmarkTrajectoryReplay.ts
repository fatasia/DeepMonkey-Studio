import { createBenchmarkTrajectory, sampleTrajectoryPose, type BenchmarkTrajectory,
  type TrajectoryCameraPose } from "@bim-studio/deep-engine";
import type { BenchmarkSceneFixture } from "./benchmarkScene.js";
import { benchmarkPacketSphere } from "./benchmarkPacketBounds.js";

/** Replay the frozen orbit in the world-space bounding sphere of the complete instance set. */
export function createBenchmarkTrajectoryReplay(fixture: BenchmarkSceneFixture, trajectory: BenchmarkTrajectory) {
  createBenchmarkTrajectory(trajectory);
  if (trajectory.actions.length) throw new Error("This benchmark adapter accepts camera trajectories only; selection/clip actions require a capable adapter.");
  const sphere = benchmarkPacketSphere(fixture.packet);
  if (fixture.cameraFrame) { sphere.center.fromArray(fixture.cameraFrame.center); sphere.radius = fixture.cameraFrame.radius; }
  const transform = (value: readonly [number, number, number]): readonly [number, number, number] =>
    [sphere.center.x + value[0] * sphere.radius, sphere.center.y + value[1] * sphere.radius, sphere.center.z + value[2] * sphere.radius];
  return (frame: number, frameCount: number): TrajectoryCameraPose => {
    const elapsed = frameCount <= 1 ? trajectory.durationMs : frame / (frameCount - 1) * trajectory.durationMs;
    const pose = sampleTrajectoryPose(trajectory, elapsed);
    return { position: transform(pose.position), target: transform(pose.target), fovDeg: pose.fovDeg };
  };
}
