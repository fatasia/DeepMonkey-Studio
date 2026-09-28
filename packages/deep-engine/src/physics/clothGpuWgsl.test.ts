import { describe, expect, it } from "vitest";
import { ClothSolver } from "./clothSolver.js";
import { mirrorClothGpuStep, packClothGpuConstraints, packClothGpuParams, CLOTH_GPU_COMPUTE_WGSL,
  packClothGpuParticles } from "./clothGpuWgsl.js";

describe("T18 cloth GPU compute contract", () => {
  it("packs a stable SoA ABI and emits the production WGSL serial contract", () => {
    const particles = [{ position: [0, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 0 },
      { position: [1, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 1 }];
    const constraints = [{ a: 0, b: 1, restLength: 1 }];
    expect(packClothGpuParticles(particles)).toHaveLength(24);
    expect(packClothGpuConstraints(constraints, 2).byteLength).toBe(16);
    expect(packClothGpuParams({ particles, constraints, dtSeconds: 1 / 60, substeps: 2, compliance: 0, damping: 0.01, gravity: [0, -9.81, 0] }).byteLength).toBe(48);
    expect(CLOTH_GPU_COMPUTE_WGSL).toContain("workgroup_size(1, 1, 1)");
    expect(CLOTH_GPU_COMPUTE_WGSL).toContain("stepCloth");
  });
  it("keeps CPU mirror within the existing CPU solver tolerance for a fixed step", () => {
    const input = { particles: [
      { position: [0, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 0 },
      { position: [1, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 1 },
      { position: [0, 1, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 1 },
      { position: [1, 1, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 1 },
    ], constraints: [
      { a: 0, b: 1, restLength: 1 }, { a: 0, b: 2, restLength: 1 },
      { a: 0, b: 3, restLength: Math.SQRT2 }, { a: 1, b: 2, restLength: Math.SQRT2 },
      { a: 1, b: 3, restLength: 1 }, { a: 2, b: 3, restLength: 1 },
    ], dtSeconds: 1 / 60, substeps: 2,
    compliance: 0, damping: 0.01, gravity: [0, -9.81, 0] as const };
    const mirror = mirrorClothGpuStep(input);
    const solver = new ClothSolver({ columns: 2, rows: 2, spacing: 1, mass: 1, gravity: [0, -9.81, 0],
      dtSeconds: 1 / 60, substeps: 2, compliance: 0, damping: 0.01, perturbation: 0, seed: 1 });
    solver.setPinned(0, 0, true); solver.step();
    const pos = solver.capture();
    expect(Math.abs(mirror[12]! - pos.px[1]!)).toBeLessThan(2e-3);
    expect(Math.abs(mirror[13]! - pos.py[1]!)).toBeLessThan(2e-3);
    expect(Math.abs(mirror[14]! - pos.pz[1]!)).toBeLessThan(2e-3);
  });
});
