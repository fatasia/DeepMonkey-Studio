import { describe, expect, it } from "vitest";
import type { SceneLinearPrefabPathState } from "@bim-studio/contracts";
import { linearPrefabSegments, stablePathGateIndex } from "./linearPrefabPath";

function path(patch: Partial<SceneLinearPrefabPathState> = {}): SceneLinearPrefabPathState {
  return { points: [{ id: "a", position: { x: 0, y: 0, z: 0 } },
    { id: "b", position: { x: 3, y: 0, z: 4 } }], interpolation: "linear", closed: false,
    snapToGround: true, seed: 17, ...patch };
}

describe("linear prefab structural path", () => {
  it("turns endpoints into exact finite segment transforms", () => {
    expect(linearPrefabSegments(path())).toEqual([{ index: 0,
      start: { x: 0, y: 0, z: 0 }, end: { x: 3, y: 0, z: 4 },
      midpoint: { x: 1.5, y: 0, z: 2 }, lengthM: 5, yawRadians: Math.atan2(4, 3) }]);
  });

  it("tessellates splines deterministically and bounds output", () => {
    const curved = path({ interpolation: "catmull-rom", points: [
      { id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 5, y: 0, z: 0 } },
      { id: "c", position: { x: 5, y: 0, z: 5 } }, { id: "d", position: { x: 10, y: 0, z: 5 } },
    ] });
    expect(linearPrefabSegments(curved)).toEqual(linearPrefabSegments(structuredClone(curved)));
    expect(linearPrefabSegments(curved).length).toBeGreaterThan(3);
    expect(linearPrefabSegments(curved).length).toBeLessThanOrEqual(512);
  });

  it("uses a fixed seed for one stable gate segment and rejects unsafe paths", () => {
    expect(stablePathGateIndex(path(), 5)).toBe(2);
    expect(() => linearPrefabSegments(path({ seed: -1 }))).toThrow("uint32");
    expect(() => linearPrefabSegments(path({ points: [
      { id: "same", position: { x: 0, y: 0, z: 0 } }, { id: "same", position: { x: 1, y: 0, z: 0 } },
    ] }))).toThrow("unique");
  });
});
