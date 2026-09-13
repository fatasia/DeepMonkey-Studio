import { describe, expect, it } from "vitest";
import { DEFAULT_PBR_BLOOM_OPTIONS } from "../webgpu/pbrPostProcessChain.js";
import { combineBloomLevels, extractBloomColor } from "./bloomCpu.js";
import { BLOOM_WGSL } from "./bloomWgsl.js";

describe("default HDR bloom energy", () => {
  it("keeps SDR white and both theme backgrounds out of the soft knee", () => {
    for (const color of [[1, 1, 1], [.847, .888, .905], [.003, .006, .007]] as const) {
      expect(extractBloomColor(color, DEFAULT_PBR_BLOOM_OPTIONS)).toEqual([0, 0, 0]);
    }
    expect(extractBloomColor([1.1, 1.1, 1.1], DEFAULT_PBR_BLOOM_OPTIONS)[0]).toBeGreaterThan(0);
    expect(extractBloomColor([4, 2, 1], DEFAULT_PBR_BLOOM_OPTIONS)[0]).toBeGreaterThan(2);
  });

  it("preserves a constant bright field across every supported pyramid depth", () => {
    const extracted = extractBloomColor([4, 2, 1], DEFAULT_PBR_BLOOM_OPTIONS);
    for (let levels = 1; levels <= 12; levels++) {
      let reconstructed = extracted;
      for (let index = 1; index < levels; index++) reconstructed = combineBloomLevels(extracted, reconstructed);
      expect(reconstructed).toEqual(extracted);
    }
    expect(BLOOM_WGSL).toContain("mix(high, low, 0.5)");
    expect(BLOOM_WGSL).not.toContain("vec4<f32>(high + low");
  });

  it("spreads HDR highlights without creating energy above either source", () => {
    expect(combineBloomLevels([4, 2, 0], [0, 0, 2])).toEqual([2, 1, 1]);
    expect(() => combineBloomLevels([Number.NaN, 0, 0], [1, 1, 1])).toThrow("finite");
    expect(() => combineBloomLevels([-1, 0, 0], [1, 1, 1])).toThrow("non-negative");
  });
});
