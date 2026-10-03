import { describe, expect, it } from "vitest";
import { createPathTraceCpuKernel } from "./pathTraceCpuKernel.js";
import type { PathTraceCpuKernelOptions, PathTraceCpuMaterial, PathTraceRgb } from "./pathTraceCpuTypes.js";

const lambert: PathTraceCpuMaterial = { model: "lambert", reflectance: [0.7, 0.5, 0.2] };
function options(material = lambert): PathTraceCpuKernelOptions {
  return { width: 1, height: 1,
    blas: { id: "plane", vertices: new Float32Array([-1e6, -1e6, 0, 1e6, -1e6, 0, 0, 1e6, 0]),
      indices: new Uint32Array([0, 1, 2]) }, materials: [material],
    camera: { origin: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], verticalFovDegrees: 0.001 },
    environment: [1, 2, 4], maxBounces: 4, rouletteStart: 64 };
}
function average(kernel: ReturnType<typeof createPathTraceCpuKernel>, count: number, seed = 17): number[] {
  const sum = [0, 0, 0];
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const rgb = kernel.traceSample(0, 0, ordinal, seed);
    for (let c = 0; c < 3; c++) sum[c]! += rgb[c]! / count;
  }
  return sum;
}

describe("real CPU path integration", () => {
  it("matches Lambert white furnace analytically for every sample", () => {
    const kernel = createPathTraceCpuKernel(options());
    for (let ordinal = 0; ordinal < 256; ordinal++) {
      expect(kernel.traceSample(0, 0, ordinal, 0)).toEqual([0.7, 1, 0.8]);
    }
  });
  it("evaluates primary environment with zero scattering budget", () => {
    const base = options();
    const kernel = createPathTraceCpuKernel({ ...base,
      blas: { id: "empty", vertices: new Float32Array(), indices: new Uint32Array() }, materials: [], maxBounces: 0 });
    expect(kernel.traceSample(0, 0, 0, 0)).toEqual([1, 2, 4]);
  });
  it("reaches an emissive second surface through a genuine diffuse bounce", () => {
    const base = options();
    const vertices = [...base.blas.vertices, -1e6, -1e6, 2, 1e6, -1e6, 2, 0, 1e6, 2];
    const kernel = createPathTraceCpuKernel({ ...base, environment: [0, 0, 0],
      blas: { id: "two-surfaces", vertices: new Float32Array(vertices), indices: new Uint32Array([0, 1, 2, 3, 4, 5]) },
      materials: [lambert, { model: "lambert", reflectance: [0, 0, 0], emission: [3, 2, 1] }] });
    for (let ordinal = 0; ordinal < 128; ordinal++) {
      const rgb = kernel.traceSample(0, 0, ordinal, 123);
      expect(rgb[0]).toBeCloseTo(2.1, 12); expect(rgb[1]).toBe(1); expect(rgb[2]).toBe(0.2);
    }
  });
  it.each([0.045, 0.25, 0.6, 1])("GGX white furnace conserves single-scatter energy at roughness %s", roughness => {
    const kernel = createPathTraceCpuKernel({ ...options({ model: "ggx-conductor", reflectance: [1, 1, 1], roughness }),
      environment: [1, 1, 1] });
    const rgb = average(kernel, 16384);
    expect(rgb[0]).toBeGreaterThan(0.25); expect(rgb[0]).toBeLessThanOrEqual(1.001);
    expect(rgb[1]).toBe(rgb[0]); expect(rgb[2]).toBe(rgb[0]);
  });
  it("converges to independent cosine integral 1/2 for L=z² across fixed seeds", () => {
    const kernel = createPathTraceCpuKernel({ ...options({ model: "lambert", reflectance: [1, 1, 1] }),
      environment: (d: PathTraceRgb): PathTraceRgb => [d[2] ** 2, d[2] ** 2, d[2] ** 2] });
    const rmse = (samples: number) => Math.sqrt(Array.from({ length: 16 }, (_, seed) =>
      (average(kernel, samples, seed)[0]! - 0.5) ** 2).reduce((a, b) => a + b) / 16);
    const low = rmse(16), high = rmse(4096);
    console.info("I-C16 Lambert L=z², analytic=0.5, 16-seed RMSE", { spp16: low, spp4096: high });
    expect(high).toBeLessThan(0.01); expect(high).toBeLessThan(low / 4);
  });
  it("replays pixel/sample/seed independently of call order and snapshots inputs", () => {
    const base = options();
    const kernel = createPathTraceCpuKernel({ ...base, environment: d => [Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])] });
    const expected = kernel.traceSample(0, 0, 42, 0xffffffff);
    kernel.traceSample(0, 0, 41, 0); base.blas.vertices.fill(999);
    expect(kernel.traceSample(0, 0, 42, 0xffffffff)).toEqual(expected);
    expect(kernel.traceSample(0, 0, 43, 0xffffffff)).not.toEqual(expected);
  });
  it("matches the independent normal-view GGX alpha=1 integral 1-ln(2)", () => {
    const kernel = createPathTraceCpuKernel({ ...options({ model: "ggx-conductor", reflectance: [1, 1, 1], roughness: 1 }),
      environment: [1, 1, 1] });
    const measured = average(kernel, 65536)[0]!, expected = 1 - Math.log(2);
    console.info("I-C16 GGX alpha=1 furnace", { samples: 65536, measured, expected, error: Math.abs(measured - expected) });
    expect(Math.abs(measured - expected)).toBeLessThan(0.005);
  });
  it("performs two scattering events before the terminal emissive hit", () => {
    const base = options();
    const kernel = createPathTraceCpuKernel({ ...base, maxBounces: 2, environment: [0, 0, 0],
      blas: { id: "bounce-room", vertices: new Float32Array([...base.blas.vertices,
        -1e6, -1e6, 2, 1e6, -1e6, 2, 0, 1e6, 2]), indices: new Uint32Array([0, 1, 2, 3, 4, 5]) },
      materials: [{ ...lambert, emission: [1, 1, 1] }, { model: "lambert", reflectance: [0.5, 0.5, 0.5] }] });
    for (let ordinal = 0; ordinal < 128; ordinal++) {
      expect(kernel.traceSample(0, 0, ordinal, 13)).toEqual([1.35, 1.25, 1.1]);
    }
  });
  it("Russian roulette preserves mean radiance rather than clamping throughput", () => {
    const kernel = createPathTraceCpuKernel({ ...options(), rouletteStart: 0 });
    const actual = average(kernel, 16384);
    for (const [channel, expected] of [0.7, 1, 0.8].entries()) {
      expect(Math.abs(actual[channel]! - expected)).toBeLessThan(0.015);
    }
  });
  it("rejects malformed geometry/material/camera and sample identifiers", () => {
    expect(() => createPathTraceCpuKernel({ ...options(), materials: [] })).toThrow(/material/);
    expect(() => createPathTraceCpuKernel(options({ model: "ggx-conductor", reflectance: [1, 1, 1], roughness: 0 }))).toThrow(/roughness/);
    expect(() => createPathTraceCpuKernel({ ...options(), camera: { ...options().camera, up: [0, 0, 1] } })).toThrow(/degenerate/);
    const kernel = createPathTraceCpuKernel(options());
    expect(() => kernel.traceSample(1, 0, 0, 0)).toThrow();
    expect(() => kernel.traceSample(0, 0, -1, 0)).toThrow();
    expect(() => kernel.traceSample(0, 0, 0, 0x100000000)).toThrow();
  });
});
