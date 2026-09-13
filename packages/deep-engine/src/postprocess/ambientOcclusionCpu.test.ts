import { describe, expect, it } from "vitest";
import { computeAmbientOcclusionCpu } from "./ambientOcclusionCpu.js";

const options = { verticalFovRadians: Math.PI / 2, radius: 3, thickness: 0.05, power: 1.5 } as const;
function normals(width: number, height: number): number[] { return Array.from({ length: width * height }, () => [0, 0, 1]).flat(); }

describe("ambient occlusion CPU reference", () => {
  it("keeps a flat view-space plane unoccluded at half resolution", () => {
    const input = { width: 8, height: 6, depth: Array(48).fill(4), normals: normals(8, 6) };
    const result = computeAmbientOcclusionCpu(input, options);
    expect([result.width, result.height]).toEqual([4, 3]);
    expect(Array.from(result.raw)).toEqual(Array(12).fill(1)); expect(Array.from(result.output)).toEqual(Array(12).fill(1));
  });

  it("detects a deterministic cavity and keeps bilateral output finite", () => {
    const depth = Array(64).fill(3); depth[3 * 8 + 3] = 4; depth[3 * 8 + 5] = 4;
    const input = { width: 8, height: 8, depth, normals: normals(8, 8) };
    const first = computeAmbientOcclusionCpu(input, options), second = computeAmbientOcclusionCpu(input, options);
    expect(first.output).toEqual(second.output); expect(Math.min(...first.raw)).toBeLessThan(0.99);
    // PI/2 projects the radius onto exact half-pixel boundaries after the GPU
    // parameter upload. The CPU reference must select the same texels as f32 WGSL.
    expect(first.raw[5]).toBeCloseTo(0.47678018, 6); expect(first.raw[6]).toBeCloseTo(0.43767604, 6);
    expect(first.output[5]).toBeCloseTo(0.46164757, 6); expect(first.output[6]).toBeCloseTo(0.45280865, 6);
    expect(Array.from(first.output).every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    expect(Array.from(first.output).filter((_value, index) => index !== 5 && index !== 6).every(value => value === 1)).toBe(true);
    const stronger = computeAmbientOcclusionCpu(input, { ...options, power: 3 });
    expect(Math.min(...stronger.output)).toBeLessThanOrEqual(Math.min(...first.output));
  });

  it("fails closed on ambiguous depth, invalid normals, sizes, or tuning", () => {
    expect(() => computeAmbientOcclusionCpu({ width: 2, height: 2, depth: [1], normals: normals(2, 2) }, options)).toThrow("depth");
    expect(() => computeAmbientOcclusionCpu({ width: 2, height: 2, depth: [1, 1, 1, 1], normals: [0] }, options)).toThrow("normals");
    expect(() => computeAmbientOcclusionCpu({ width: 2, height: 2, depth: [1, -1, 1, 1], normals: normals(2, 2) }, options)).toThrow("nonnegative");
    expect(() => computeAmbientOcclusionCpu({ width: 2, height: 2, depth: [1, 1, 1, 1], normals: normals(2, 2) }, { ...options, thickness: 4 })).toThrow("thickness");
  });
});
