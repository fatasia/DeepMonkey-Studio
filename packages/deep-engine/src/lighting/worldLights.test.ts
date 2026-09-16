import { describe, expect, it } from "vitest";
import { lookAt } from "../webgpu/cameraMath.js";
import { transformWorldLightsToView } from "./worldLights.js";

describe("world-space Forward+ light adapter", () => {
  it("transforms positions with camera translation while keeping directions translation-free", () => {
    const result = transformWorldLightsToView({
      directional: [{ directionWorld: [0, 0, -1], color: [1, 1, 1], intensity: 2 }],
      points: [{ positionWorld: [1, 2, 3], range: 8, color: [1, 0.5, 0.25], intensity: 4 }],
      spots: [{ positionWorld: [-1, 0, 4], directionWorld: [0, 0, -1], range: 10,
        color: [0.25, 0.5, 1], intensity: 3, innerConeCos: 0.9, outerConeCos: 0.7,
        shadow: { key: "authored-spot", importance: 5 } }],
    }, lookAt([0, 0, 10], [0, 0, 0]));

    expect(result.directional?.[0]).toMatchObject({ directionView: [0, 0, -1], intensity: 2 });
    expect(result.points?.[0]).toMatchObject({ positionView: [1, 2, -7], range: 8 });
    expect(result.spots?.[0]).toMatchObject({ positionView: [-1, 0, -6], directionView: [0, 0, -1],
      shadow: { key: "authored-spot", importance: 5 } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.points)).toBe(true);
  });

  it("rotates light vectors into a side-facing camera basis", () => {
    const result = transformWorldLightsToView({ directional: [{ directionWorld: [-1, 0, 0], color: [1, 1, 1], intensity: 1 }] },
      lookAt([10, 0, 0], [0, 0, 0]));
    expect(result.directional?.[0]?.directionView).toEqual([0, 0, -1]);
  });

  it("rejects non-finite and scaled matrices because ranges require a rigid view transform", () => {
    const lights = { points: [{ positionWorld: [0, 0, 0] as const, range: 1, color: [1, 1, 1] as const, intensity: 1 }] };
    expect(() => transformWorldLightsToView(lights, new Float32Array(15))).toThrow("finite 4x4");
    const scaled = new Float32Array([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(() => transformWorldLightsToView(lights, scaled)).toThrow("rigid affine");
    const invalid = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, Number.NaN, 0, 0, 1]);
    expect(() => transformWorldLightsToView(lights, invalid)).toThrow("finite 4x4");
  });
});
