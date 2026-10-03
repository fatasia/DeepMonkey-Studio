import { describe, expect, it } from "vitest";
import { colorClothConstraints } from "./clothConstraintColoring.js";
import { colorSoftBodyVolumes } from "./softBodyVolumeColoring.js";
import { mirrorSoftBodyParallelStep } from "./softBodyParallelMirror.js";

const input = {
  particles: [
    { position: [0, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 0 },
    { position: [1, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 1 },
  ],
  edges: [{ a: 0, b: 1, restLength: 0.5 }], tets: [],
  obstacles: [{ center: [0, 0, 0] as const, radius: 1, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, halfExtents: [0, 0, 0] as const }],
  dtSeconds: 1 / 60, substeps: 1, complianceDistance: 0, complianceVolume: 0, damping: 0,
  gravity: [0, 0, 0] as const,
};

describe("soft-body post-constraint contacts", () => {
  it("restores non-penetration after an edge pulls a particle inside an obstacle", () => {
    const result = mirrorSoftBodyParallelStep(input, colorClothConstraints([0], [1], 2), colorSoftBodyVolumes([], 2));
    expect(result[12]).toBe(1);
    expect([result[0], result[1], result[2]]).toEqual([0, 0, 0]);
    expect([result[16], result[17], result[18]]).toEqual([0, 0, 0]);
  });

  it("preserves the old unconstrained-obstacle-free result", () => {
    const { obstacles: _obstacles, ...without } = input;
    const result = mirrorSoftBodyParallelStep(without, colorClothConstraints([0], [1], 2), colorSoftBodyVolumes([], 2));
    expect(result[12]).toBe(0.5);
  });
});
