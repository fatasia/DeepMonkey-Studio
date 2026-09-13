import { describe, expect, it } from "vitest";
import { resolvePbrSceneLighting } from "./pbrSceneLighting.js";

describe("PBR scene lighting", () => {
  it("preserves the studio sun and fill light when no authored lights exist", () => {
    const result = resolvePbrSceneLighting();
    expect(result.primary.color).toEqual([2.5, 2.4, 2.25]);
    expect(result.primary.intensity).toBe(1);
    expect(result.clustered.directional).toHaveLength(1);
    expect(result.primary.surfaceToLightWorld[1]).toBeGreaterThan(0);
  });

  it("uses the first authored directional light as the sun without double lighting it", () => {
    const sun = { directionWorld: [0, -2, 0] as const, color: [0.8, 0.7, 0.6] as const, intensity: 3 };
    const fill = { directionWorld: [1, 0, 0] as const, color: [0.1, 0.2, 0.3] as const, intensity: 0.5 };
    const result = resolvePbrSceneLighting({ directional: [sun, fill], points: [{
      positionWorld: [1, 2, 3], range: 10, color: [1, 0, 0], intensity: 2,
    }] });
    expect(result.primary).toMatchObject({ rayDirectionWorld: [0, -1, 0], surfaceToLightWorld: [0, 1, 0],
      color: [0.8, 0.7, 0.6], intensity: 3 });
    expect(result.clustered.directional).toEqual([fill]);
    expect(result.clustered.points).toHaveLength(1);
  });

  it("keeps local lights and the default sun when no directional light is authored", () => {
    const points = [{ positionWorld: [0, 0, 0] as const, range: 5, color: [1, 1, 1] as const, intensity: 1 }];
    const result = resolvePbrSceneLighting({ points });
    expect(result.primary.color).toEqual([2.5, 2.4, 2.25]);
    expect(result.clustered.points).toBe(points);
    expect(result.clustered.directional).toBeUndefined();
  });

  it("fails before GPU work for malformed primary lights", () => {
    expect(() => resolvePbrSceneLighting({ directional: [{
      directionWorld: [0, 0, 0], color: [1, 1, 1], intensity: 1,
    }] })).toThrow("non-zero");
    expect(() => resolvePbrSceneLighting({ directional: [{
      directionWorld: [0, -1, 0], color: [-1, 1, 1], intensity: 1,
    }] })).toThrow("non-negative vec3");
    expect(() => resolvePbrSceneLighting({ directional: [{
      directionWorld: [0, -1, 0], color: [1, 1, 1], intensity: Number.NaN,
    }] })).toThrow("intensity");
  });
});
