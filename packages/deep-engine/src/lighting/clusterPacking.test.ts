import { describe, expect, it } from "vitest";
import { DIRECTIONAL_LIGHT_STRIDE, LOCAL_LIGHT_BOUNDS_STRIDE, packClusteredLights, POINT_LIGHT_STRIDE, SPOT_LIGHT_STRIDE } from "./clusterPacking.js";
import { FORWARD_PLUS_LIGHT_ABI_VERSION, FORWARD_PLUS_LIGHT_ABI_WGSL } from "./lightAbiWgsl.js";

describe("Forward+ compact light ABI", () => {
  it("packs directional, point, and spot shading rows without padding ambiguity", () => {
    expect(FORWARD_PLUS_LIGHT_ABI_VERSION).toBe(2);
    expect(FORWARD_PLUS_LIGHT_ABI_WGSL).toContain("radianceConeScale");
    const packed = packClusteredLights({
      directional: [{ directionView: [0, -2, 0], color: [1, 0.5, 0.25], intensity: 3 }],
      points: [{ positionView: [1, 2, -3], range: 4, color: [0.5, 0.25, 1], intensity: 2 }],
      spots: [{ positionView: [-1, 0, -5], range: 8, directionView: [0, 0, -2],
        outerConeCos: 0.5, innerConeCos: 0.75, color: [1, 0.5, 0.25], intensity: 4 }],
    });
    expect(packed.directional.byteLength).toBe(DIRECTIONAL_LIGHT_STRIDE);
    expect(Array.from(packed.directional)).toEqual([0, -1, 0, 3, 1, 0.5, 0.25, 0]);
    expect(packed.points.byteLength).toBe(POINT_LIGHT_STRIDE);
    expect(Array.from(packed.points)).toEqual([1, 2, -3, 4, 1, 0.5, 2, 0]);
    expect(packed.spots.byteLength).toBe(SPOT_LIGHT_STRIDE);
    expect(Array.from(packed.spots)).toEqual([-1, 0, -5, 8, 0, 0, -1, 0.5, 4, 2, 1, 4, 2, 0, 0, 0]);
    expect(packed.localBounds.byteLength).toBe(2 * LOCAL_LIGHT_BOUNDS_STRIDE);
    expect(Array.from(packed.localBounds)).toEqual([1, 2, -3, 4, -1, 0, -5, 8]);
  });

  it("fails closed on invalid ranges, radiance, directions, cones, and budgets", () => {
    expect(() => packClusteredLights({ points: [{ positionView: [0, 0, -1], range: -1, color: [1, 1, 1], intensity: 1 }] })).toThrow("range");
    expect(() => packClusteredLights({ directional: [{ directionView: [0, 0, 0], color: [1, 1, 1], intensity: 1 }] })).toThrow("nonzero");
    expect(() => packClusteredLights({ points: [{ positionView: [0, 0, -1], range: 1, color: [-1, 1, 1], intensity: 1 }] })).toThrow("nonnegative");
    expect(() => packClusteredLights({ points: [{ positionView: [0, 0, -1], range: 1, color: [1e30, 1, 1], intensity: 1e30 }] })).toThrow("finite float32");
    expect(() => packClusteredLights({ spots: [{ positionView: [0, 0, -1], range: 1, color: [1, 1, 1], intensity: 1,
      directionView: [0, 0, -1], outerConeCos: 0.8, innerConeCos: 0.7 }] })).toThrow("cone cosines");
    const directional = Array.from({ length: 17 }, () => ({ directionView: [0, 0, -1] as const, color: [1, 1, 1] as const, intensity: 1 }));
    expect(() => packClusteredLights({ directional })).toThrow("Directional light count");
  });
});
