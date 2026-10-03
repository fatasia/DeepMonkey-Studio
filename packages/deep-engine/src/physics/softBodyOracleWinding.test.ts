import { describe, expect, it } from "vitest";
import { colorClothConstraints } from "./clothConstraintColoring.js";
import { colorSoftBodyVolumes } from "./softBodyVolumeColoring.js";
import { mirrorSoftBodyParallelStep } from "./softBodyParallelMirror.js";
import { SoftBodySolver } from "./softBodySolver.js";

const positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;
const signed = (tet: readonly [number, number, number, number]) => {
  const [a, b, c, d] = tet.map(index => positions[index]!);
  const u = [b![0] - d![0], b![1] - d![1], b![2] - d![2]];
  const v = [c![0] - d![0], c![1] - d![1], c![2] - d![2]];
  const w = [a![0] - d![0], a![1] - d![1], a![2] - d![2]];
  return (w[0]! * (u[1]! * v[2]! - u[2]! * v[1]!) + w[1]! * (u[2]! * v[0]! - u[0]! * v[2]!) + w[2]! * (u[0]! * v[1]! - u[1]! * v[0]!)) / 6;
};

function step(tet: readonly [number, number, number, number]) {
  return mirrorSoftBodyParallelStep({
    particles: positions.map(position => ({ position, velocity: [0, 0, 0] as const, inverseMass: 1 })),
    edges: [], tets: [{ i0: tet[0], i1: tet[1], i2: tet[2], i3: tet[3], restVolume: Math.abs(signed(tet)) }],
    dtSeconds: 1 / 60, substeps: 1, complianceDistance: 0, complianceVolume: 0, damping: 0, gravity: [0, 0, 0],
  }, colorClothConstraints([], [], 4), colorSoftBodyVolumes([tet], 4));
}

function distance(state: Float32Array) {
  return Math.max(...positions.map((p, i) => Math.hypot(state[i * 12]! - p[0], state[i * 12 + 1]! - p[1], state[i * 12 + 2]! - p[2])));
}

describe("soft-body oracle fixture winding", () => {
  it("exposes a negative-winding GPU fixture with a positive rest target as a different physical problem", () => {
    expect(signed([0, 1, 2, 3])).toBeLessThan(0);
    expect(distance(step([0, 1, 2, 3]))).toBeGreaterThan(0.1);
    const golden = new SoftBodySolver({ positions, tets: [[0, 1, 2, 3]], mass: 1, pinned: [], gravity: [0, 0, 0],
      dtSeconds: 1 / 60, substeps: 1, complianceDistance: 0, complianceVolume: 0, damping: 0 });
    golden.step();
    expect(Array.from(golden.positionsInterleaved())).toEqual(positions.flat());
  });

  it("normalizing winding once during fixture construction matches the CPU rest equilibrium", () => {
    expect(signed([0, 2, 1, 3])).toBeGreaterThan(0);
    expect(distance(step([0, 2, 1, 3]))).toBe(0);
  });
});
