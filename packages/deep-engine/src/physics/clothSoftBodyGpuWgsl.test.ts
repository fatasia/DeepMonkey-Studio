import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  CLOTH_GPU_COMPUTE_WGSL,
  mirrorClothGpuStep,
  packClothGpuConstraints,
  packClothGpuParams,
  packClothGpuParticles,
} from "./clothGpuWgsl.js";
import {
  SOFT_BODY_GPU_COMPUTE_WGSL,
  mirrorSoftBodyGpuStep,
  packSoftBodyGpuEdges,
  packSoftBodyGpuParams,
  packSoftBodyGpuParticles,
  packSoftBodyGpuTets,
} from "./softBodyGpuWgsl.js";

const NAGA = process.env.DEEP_SHADER_NAGA_BIN;
const particle = (position: readonly [number, number, number], inverseMass = 1) => ({
  position, velocity: [0, 0, 0] as const, inverseMass,
});

const CLOTH_INPUT = {
  particles: [particle([0, 0, 0], 0), particle([1.15, 0, 0])],
  constraints: [{ a: 0, b: 1, restLength: 1 }],
  dtSeconds: 1 / 60,
  substeps: 2,
  compliance: 0,
  damping: 0,
  gravity: [0, 0, 0] as const,
};

const SOFT_INPUT = {
  particles: [particle([0, 0, 0], 0), particle([1, 0, 0]), particle([0, 1, 0]), particle([0, 0, 1])],
  edges: [
    { a: 0, b: 1, restLength: 1 }, { a: 0, b: 2, restLength: 1 }, { a: 0, b: 3, restLength: 1 },
    { a: 1, b: 2, restLength: Math.SQRT2 }, { a: 1, b: 3, restLength: Math.SQRT2 }, { a: 2, b: 3, restLength: Math.SQRT2 },
  ],
  tets: [{ i0: 0, i1: 2, i2: 1, i3: 3, restVolume: 1 / 6 }],
  dtSeconds: 1 / 60,
  substeps: 2,
  complianceDistance: 0,
  complianceVolume: 0,
  damping: 0,
  gravity: [0, 0, 0] as const,
};

describe("T18 A3 GPU physics ABI", () => {
  it("packs aligned cloth buffers and params", () => {
    expect(packClothGpuParticles(CLOTH_INPUT.particles).byteLength).toBe(2 * 48);
    expect(packClothGpuConstraints(CLOTH_INPUT.constraints, 2).byteLength).toBe(16);
    expect(packClothGpuParams(CLOTH_INPUT).byteLength).toBe(48);
  });

  it("packs aligned soft-body buffers and params", () => {
    expect(packSoftBodyGpuParticles(SOFT_INPUT.particles).byteLength).toBe(4 * 48);
    expect(packSoftBodyGpuEdges(SOFT_INPUT.edges, 4).byteLength).toBe(6 * 16);
    expect(packSoftBodyGpuTets(SOFT_INPUT.tets, 4).byteLength).toBe(32);
    expect(packSoftBodyGpuParams(SOFT_INPUT).byteLength).toBe(48);
  });

  it("mirrors the cloth projection order, preserving the pinned particle", () => {
    const state = mirrorClothGpuStep(CLOTH_INPUT);
    expect(state[0]).toBe(0);
    expect(state[12]).toBeCloseTo(1, 5);
    expect(state[15]).toBe(1);
    expect(Array.from(state).every(Number.isFinite)).toBe(true);
  });

  it("keeps a zero-force tetrahedron stable and finite", () => {
    const state = mirrorSoftBodyGpuStep(SOFT_INPUT);
    expect(state[0]).toBe(0);
    expect(state[12]).toBeCloseTo(1, 5);
    expect(state[24]).toBeCloseTo(0, 5);
    expect(state[36]).toBeCloseTo(0, 5);
    expect(Array.from(state).every(Number.isFinite)).toBe(true);
  });

  it("rejects invalid references and non-finite dynamics", () => {
    expect(() => packClothGpuConstraints([{ a: 0, b: 2, restLength: 1 }], 2)).toThrow(/outside/);
    expect(() => packSoftBodyGpuTets([{ i0: 0, i1: 1, i2: 2, i3: 4, restVolume: 1 / 6 }], 4)).toThrow(/outside/);
    expect(() => mirrorClothGpuStep({ ...CLOTH_INPUT, dtSeconds: Number.NaN })).toThrow(/finite/);
    expect(() => mirrorSoftBodyGpuStep({ ...SOFT_INPUT, damping: 1 })).toThrow(/\[0,1\)/);
  });

  it.runIf(Boolean(NAGA))("passes Naga WGSL parsing and semantic validation", () => {
    for (const [name, source] of [["cloth", CLOTH_GPU_COMPUTE_WGSL], ["soft-body", SOFT_BODY_GPU_COMPUTE_WGSL]] as const) {
      const result = spawnSync(NAGA!, ["--stdin-file-path", `t18-a3-${name}.wgsl`, "--input-kind", "wgsl"], {
        input: source, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Validation successful");
    }
  });
});
