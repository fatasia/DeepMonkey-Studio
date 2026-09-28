import { describe, expect, it } from "vitest";
import { simulateSmokeDiffusion, smokeAnalyticField, smokeDiffusionConvergence } from "./smokeDiffusion.js";

describe("smokeDiffusion NaN hygiene", () => {
  it("produces zero non-finite values on the closed boundary", () => {
    const result = simulateSmokeDiffusion({ resolution: 64, steps: 200, diffusion: 0.01, boundary: "closed" });
    expect(result.nonFiniteCount).toBe(0);
    const field = result;
    expect(Number.isFinite(field.mass)).toBe(true);
    expect(Number.isFinite(field.l2Error)).toBe(true);
  });

  it("rejects invalid parameters instead of diverging", () => {
    expect(() => simulateSmokeDiffusion({ resolution: 4, steps: 10, diffusion: 0.01 })).toThrow(RangeError);
    expect(() => simulateSmokeDiffusion({ resolution: 64, steps: 0, diffusion: 0.01 })).toThrow(RangeError);
    expect(() => simulateSmokeDiffusion({ resolution: 64, steps: 10, diffusion: -1 })).toThrow(RangeError);
    expect(() => simulateSmokeDiffusion({ resolution: 64, steps: 10,
      diffusion: Number.NaN })).toThrow(RangeError);
  });
});

describe("smokeDiffusion closed-boundary conservation", () => {
  it("keeps mass drift far below the 1% budget", () => {
    const result = simulateSmokeDiffusion({ resolution: 64, steps: 500, diffusion: 0.01, boundary: "closed" });
    expect(result.massDrift).toBeLessThanOrEqual(0.01);
    expect(result.massDrift).toBeLessThan(1e-12);
  });

  it("drains mass on absorbing (dirichlet) boundaries and states so", () => {
    const result = simulateSmokeDiffusion({ resolution: 64, steps: 2_000, diffusion: 0.02,
      boundary: "dirichlet" });
    expect(result.mass).toBeLessThan(result.initialMass);
    expect(result.nonFiniteCount).toBe(0);
  });
});

describe("smokeDiffusion resolution convergence", () => {
  it("decreases L2 error monotonically as resolution doubles", () => {
    const rows = smokeDiffusionConvergence([16, 32, 64, 128], 0.01, 0.5);
    expect(rows.map(row => row.resolution)).toEqual([16, 32, 64, 128]);
    for (let index = 1; index < rows.length; index++) {
      expect(rows[index]!.l2Error).toBeLessThan(rows[index - 1]!.l2Error);
    }
    // 二阶空间收敛:细化 8 倍至少带来一个数量级的误差下降。
    expect(rows[3]!.l2Error).toBeLessThan(rows[0]!.l2Error / 10);
  });

  it("matches the analytic gaussian solution within tight tolerance", () => {
    const result = simulateSmokeDiffusion({ resolution: 128, steps: 2_000, diffusion: 0.01,
      boundary: "closed" });
    expect(result.l2Error).toBeLessThan(0.01);
  });
});

describe("smokeAnalyticField", () => {
  it("keeps unit mass and spreads over time", () => {
    const early = smokeAnalyticField(64, 0.01, 0.1);
    const late = smokeAnalyticField(64, 0.01, 1.0);
    const massOf = (field: Float64Array) => {
      let total = 0;
      for (const value of field) total += value;
      return total;
    };
    expect(massOf(early)).toBeCloseTo(1, 12);
    expect(massOf(late)).toBeCloseTo(1, 12);
    const peakOf = (field: Float64Array) => Math.max(...field);
    expect(peakOf(late)).toBeLessThan(peakOf(early));
  });

  it("rejects invalid parameters", () => {
    expect(() => smokeAnalyticField(1, 0.01, 1)).toThrow(RangeError);
    expect(() => smokeAnalyticField(64, -1, 1)).toThrow(RangeError);
    expect(() => smokeAnalyticField(64, 0.01, -1)).toThrow(RangeError);
  });
});
