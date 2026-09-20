import { describe, expect, it } from "vitest";
import { hasClusteredLights, resolvePbrSceneLighting } from "./pbrSceneLighting.js";
import { transformWorldLightsToView, type WorldClusteredLights } from "./worldLights.js";

describe("PBR scene lighting", () => {
  it.each([2, 10])("preserves world coordinates and shadow identities with budget %s", maxLocalLights => {
    const lights: WorldClusteredLights = {
      directional: [{ directionWorld: [0, -1, 0], color: [1, 1, 1], intensity: 1 },
        { directionWorld: [1, 0, 0], color: [1, 1, 1], intensity: 2, castShadow: false }],
      points: [{ positionWorld: [2, 3, 4], color: [1, 1, 1], intensity: 5, range: 10,
        shadow: { key: "point-stable", importance: 3 } }],
      spots: [{ positionWorld: [1, 2, 3], directionWorld: [0, -1, 0], color: [1, 1, 1],
        intensity: 4, range: 8, innerConeCos: .9, outerConeCos: .7, shadow: { key: "spot-stable" } },
        { positionWorld: [100, 0, 0], directionWorld: [0, -1, 0], color: [1, 1, 1],
          intensity: .01, range: 1, innerConeCos: .9, outerConeCos: .7 }],
    };
    const result = resolvePbrSceneLighting(lights, { maxLocalLights }).clustered;
    expect(result.points![0]).toBe(lights.points![0]);
    expect(result.spots![0]).toBe(lights.spots![0]);
    expect(result.directional![0]).toBe(lights.directional![1]);
    expect(result.points![0]).not.toHaveProperty("positionView");
    expect(result.spots![0]).not.toHaveProperty("directionView");
    const view = transformWorldLightsToView(result, new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, -5,0,0,1]));
    expect(view.points![0].positionView).toEqual([-3, 3, 4]);
    expect(view.spots![0].directionView).toEqual([0, -1, 0]);
    expect(view.directional![0].directionView).toEqual([1, 0, 0]);
    expect(view.points![0].shadow).toEqual({ key: "point-stable", importance: 3 });
    expect(view.spots![0].shadow).toEqual({ key: "spot-stable" });
  });
  it("applies the Deep Lights local importance budget at the scene boundary", () => {
    const result = resolvePbrSceneLighting({ points: [
      { positionWorld: [0, 0, -1], range: 2, color: [1, 1, 1], intensity: 10 },
      { positionWorld: [0, 0, -10], range: 1, color: [1, 1, 1], intensity: 1 },
    ] }, { maxLocalLights: 1 });
    expect(result.clustered.points).toHaveLength(1);
    expect(result.clustered.points?.[0]?.intensity).toBe(10);
  });
  it("keeps the authored primary directional light outside the local budget", () => {
    const result = resolvePbrSceneLighting({ directional: [
      { directionWorld: [0, -1, 0], color: [1, 1, 1], intensity: 3 },
      { directionWorld: [1, -1, 0], color: [1, 1, 1], intensity: 1 },
    ], spots: [{ positionWorld: [0, 0, -1], directionWorld: [0, 0, -1], range: 2,
      color: [1, 1, 1], intensity: 2, innerConeCos: .9, outerConeCos: .7 }] }, { maxLocalLights: 0 });
    expect(result.primary.intensity).toBe(3);
    expect(result.clustered.directional).toHaveLength(1);
    expect(result.clustered.spots).toHaveLength(0);
  });
  it.each([undefined, true, false])("preserves authored castShadow=%s without changing radiance", castShadow => {
    const result = resolvePbrSceneLighting({ directional: [{ directionWorld: [0, -1, 0],
      color: [0.8, 0.7, 0.6], intensity: 3, ...(castShadow === undefined ? {} : { castShadow }) }] });
    expect(result.primary.castShadow).toBe(castShadow ?? true);
    expect(result.primary.intensity).toBe(3);
    expect(result.primary.color).toEqual([0.8, 0.7, 0.6]);
  });
  it.each([0, 1, null, "false"])("rejects malformed shadow switch %s", castShadow => {
    expect(() => resolvePbrSceneLighting({ directional: [{ directionWorld: [0, -1, 0],
      color: [1, 1, 1], intensity: 1, castShadow: castShadow as never }] })).toThrow("castShadow must be boolean");
  });
  it("detects whether the post-sun clustered set contains work", () => {
    expect(hasClusteredLights({})).toBe(false);
    expect(hasClusteredLights({ points: [] })).toBe(false);
    expect(hasClusteredLights({ points: [{ positionWorld: [0, 0, 0], range: 1,
      color: [1, 1, 1], intensity: 1 }] })).toBe(true);
  });
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

  it("does not inject a sun or fill when the authored directional set is explicitly empty", () => {
    const empty = resolvePbrSceneLighting({ directional: [] });
    expect(empty.primary.intensity).toBe(0);
    expect(hasClusteredLights(empty.clustered)).toBe(false);
    expect(empty.primary.rayDirectionWorld.every(Number.isFinite)).toBe(true);
    const points = [{ positionWorld: [0, 0, 0] as const, range: 5, color: [1, 1, 1] as const, intensity: 1 }];
    const localOnly = resolvePbrSceneLighting({ directional: [], points });
    expect(localOnly.primary.intensity).toBe(0);
    expect(localOnly.clustered.points).toBe(points);
    expect(hasClusteredLights(localOnly.clustered)).toBe(true);
  });
});
