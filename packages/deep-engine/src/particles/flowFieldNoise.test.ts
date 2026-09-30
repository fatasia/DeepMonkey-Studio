import { describe, expect, it } from "vitest";
import { flowCurlVelocity, flowFade, flowGradientNoise } from "./flowFieldNoise.js";
import type { ParticleVector3 } from "../webgpu/gpuParticleTypes.js";
describe("f32 analytic curl field", () => {
  it("has exact fade endpoints and repeatable, seed-dependent samples", () => {
    expect(flowFade(0)).toEqual([0, 0]); expect(flowFade(1)).toEqual([1, 0]);
    const p = [.31, -1.27, 2.41] as const;
    expect(flowCurlVelocity(p, 41)).toEqual(flowCurlVelocity(p, 41));
    expect(flowCurlVelocity(p, 41)).not.toEqual(flowCurlVelocity(p, 42));
    for (const value of flowCurlVelocity([1e15, -1e15, 1e15], 1)) expect(Number.isFinite(value)).toBe(true);
  });
  it("matches numerical noise derivatives and has near-zero divergence away from lattice boundaries", () => {
    const p: ParticleVector3 = [.31, -.27, .41], h = .001, sample = flowGradientNoise(p, 17);
    let divergence = 0;
    for (let axis = 0; axis < 3; axis++) {
      const plus = [...p] as [number, number, number], minus = [...p] as [number, number, number];
      plus[axis]! += h; minus[axis]! -= h;
      const derivative = (flowGradientNoise(plus, 17).value - flowGradientNoise(minus, 17).value) / (2 * h);
      expect(derivative).toBeCloseTo([sample.dx, sample.dy, sample.dz][axis]!, 3);
      divergence += (flowCurlVelocity(plus, 17)[axis]! - flowCurlVelocity(minus, 17)[axis]!) / (2 * h);
    }
    expect(Math.abs(divergence)).toBeLessThan(.002);
  });
});
