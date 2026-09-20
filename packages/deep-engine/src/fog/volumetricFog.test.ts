import { describe, expect, it } from "vitest";
import {
  defaultTestMedium,
  henyeyGreensteinPhase,
  rayMarchVolumetricFog,
  type VolumetricVector3,
} from "./volumetricFog";

function lengthSq(value: VolumetricVector3): number {
  return value[0] * value[0] + value[1] * value[1] + value[2] * value[2];
}

describe("G7 volumetric fog ray march (slice 1)", () => {
  it("Henyey-Greenstein phase matches the analytic forward/backward limits", () => {
    // g=0 时退化为各向同性 1/4π。
    expect(henyeyGreensteinPhase(1, 0)).toBeCloseTo(1 / (4 * Math.PI), 6);
    // g→0.99 前向峰值远大于后向。
    const forward = henyeyGreensteinPhase(1, 0.9);
    const backward = henyeyGreensteinPhase(-1, 0.9);
    expect(forward).toBeGreaterThan(backward * 100);
  });

  it("no fog: zero extinction medium yields no inscatter and full transmittance", () => {
    const result = rayMarchVolumetricFog(
      { baseExtinction: 0, scaleHeight: 8, anisotropy: 0, albedo: 0.8 },
      { direction: [0, -1, 0], radiance: [1, 1, 1] },
      { rayOrigin: [0, 0, 0], rayDirection: [0, 0, -1], near: 0, far: 100, stepCount: 16, shadowAttenuation: () => 1 },
    );
    expect(lengthSq(result.inscatter)).toBe(0);
    expect(result.transmittance).toBe(1);
  });

  it("is deterministic for identical inputs", () => {
    const input = {
      rayOrigin: [0, 5, 0] as const,
      rayDirection: [0, -0.2, -1] as const,
      near: 0, far: 200, stepCount: 64, shadowAttenuation: () => 1,
    };
    const light = { direction: [0.3, -0.8, 0.2], radiance: [1, 0.95, 0.9] };
    const first = rayMarchVolumetricFog(defaultTestMedium(), light, input);
    const second = rayMarchVolumetricFog(defaultTestMedium(), light, input);
    expect(first.inscatter).toEqual(second.inscatter);
    expect(first.transmittance).toBe(second.transmittance);
  });

  it("longer paths through fog reduce transmittance (Beer-Lambert behavior)", () => {
    const light = { direction: [0, -1, 0], radiance: [1, 1, 1] };
    const short = rayMarchVolumetricFog(defaultTestMedium(), light,
      { rayOrigin: [0, 0, 0], rayDirection: [0, 0, -1], near: 0, far: 10, stepCount: 32, shadowAttenuation: () => 1 });
    const long = rayMarchVolumetricFog(defaultTestMedium(), light,
      { rayOrigin: [0, 0, 0], rayDirection: [0, 0, -1], near: 0, far: 200, stepCount: 64, shadowAttenuation: () => 1 });
    expect(long.transmittance).toBeLessThan(short.transmittance);
    expect(lengthSq(long.inscatter)).toBeGreaterThan(lengthSq(short.inscatter));
  });

  it("shadow attenuation hook scales inscatter (occluded light contributes nothing)", () => {
    const light = { direction: [0, -1, 0], radiance: [1, 1, 1] };
    const input = { rayOrigin: [0, 0, 0] as const, rayDirection: [0, 0, -1] as const, near: 0, far: 100, stepCount: 32 };
    const lit = rayMarchVolumetricFog(defaultTestMedium(), light, { ...input, shadowAttenuation: () => 1 });
    const shadowed = rayMarchVolumetricFog(defaultTestMedium(), light, { ...input, shadowAttenuation: () => 0 });
    expect(lengthSq(shadowed.inscatter)).toBe(0);
    expect(lengthSq(lit.inscatter)).toBeGreaterThan(0);
  });

  it("uniform medium matches the closed-form Beer-Lambert law (extinction regression)", () => {
    // 2026-09-19 量纲修复回归锁:均匀介质(h=0,scaleHeight→∞)下闭式 T = exp(-σ₀·L);
    // 修复前消光误再乘 σ₀,透过率被压到近乎 1,本断言会失败。
    const medium = { baseExtinction: 0.05, scaleHeight: 1e9, anisotropy: 0, albedo: 1 };
    const light = { direction: [0, -1, 0], radiance: [1, 1, 1] };
    const far = 40, stepCount = 16;
    const result = rayMarchVolumetricFog(medium, light,
      { rayOrigin: [0, 0, 0], rayDirection: [0, 0, -1], near: 0, far, stepCount, shadowAttenuation: () => 1 });
    expect(result.transmittance).toBeCloseTo(Math.exp(-0.05 * far), 12);
    // 均匀介质内散射的离散闭式(中点采样几何级数):inscatter = pA·L·(1-T)·[Δτ/(1-e^{-Δτ})]。
    const deltaTau = 0.05 * (far / stepCount);
    const expected = (1 - result.transmittance) * (1 / (4 * Math.PI)) * (deltaTau / (1 - Math.exp(-deltaTau)));
    expect(result.inscatter[0]).toBeCloseTo(expected, 12);
  });

  it("early-exits when transmittance falls below the numerical floor", () => {
    const dense = { baseExtinction: 5, scaleHeight: 1000, anisotropy: 0, albedo: 0.9 };
    const light = { direction: [0, -1, 0], radiance: [1, 1, 1] };
    const result = rayMarchVolumetricFog(dense, light,
      { rayOrigin: [0, 0, 0], rayDirection: [0, 0, -1], near: 0, far: 1000, stepCount: 512, shadowAttenuation: () => 1 });
    expect(result.transmittance).toBeLessThan(1e-4);
  });
});
