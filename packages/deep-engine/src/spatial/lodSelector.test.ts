import { describe, expect, it } from "vitest";
import {
  ScreenSpaceLodSelector,
  SpatialIndexError,
  spatialAabb,
  type LodCamera,
  type ScreenSpaceLodLevel,
  type ScreenSpaceLodObject,
} from "../index.js";

const VIEWPORT = { width: 1000, height: 1000 } as const;
const CAMERA: LodCamera = {
  projection: "perspective",
  position: [0, 0, 0],
  forward: [0, 0, 1],
  verticalFovRadians: Math.PI / 2,
  near: 0.1,
  far: 1000,
};
const LEVELS: readonly ScreenSpaceLodLevel[] = [
  { minProjectedDiameterPixels: 100, geometricError: 0, triangles: 100 },
  { minProjectedDiameterPixels: 30, geometricError: 0.25, triangles: 20 },
  { minProjectedDiameterPixels: 0, geometricError: 1, triangles: 5 },
];

describe("ScreenSpaceLodSelector", () => {
  it("selects perspective LODs from projected diameter and reports projected error", () => {
    const selector = new ScreenSpaceLodSelector({ defaultHysteresisRatio: 0 });
    const result = selector.selectFrame([
      objectAt("near", 10),
      objectAt("middle", 20),
      objectAt("far", 50),
    ], CAMERA, VIEWPORT);
    const byId = new Map(result.selections.map((selection) => [selection.id, selection]));
    expect(byId.get("near")?.projectedDiameterPixels).toBeCloseTo(100);
    expect(byId.get("near")).toMatchObject({ selectedLevel: 0, projectedErrorPixels: 0 });
    expect(byId.get("middle")?.projectedDiameterPixels).toBeCloseTo(50);
    expect(byId.get("middle")?.selectedLevel).toBe(1);
    expect(byId.get("middle")?.projectedErrorPixels).toBeCloseTo(6.25);
    expect(byId.get("far")?.projectedDiameterPixels).toBeCloseTo(20);
    expect(byId.get("far")?.selectedLevel).toBe(2);
    expect(byId.get("far")?.projectedErrorPixels).toBeCloseTo(10);
    expect(result).toMatchObject({ renderedObjects: 3, renderedTriangles: 125, trackedObjects: 3 });
  });

  it("fully supports orthographic projected size independent of depth", () => {
    const selector = new ScreenSpaceLodSelector({ defaultHysteresisRatio: 0 });
    const camera: LodCamera = {
      projection: "orthographic",
      position: [0, 0, 0],
      forward: [0, 0, 1],
      verticalSize: 20,
      near: 0.1,
      far: 500,
    };
    const result = selector.selectFrame([objectAt("close", 10), objectAt("distant", 400)], camera, VIEWPORT);
    expect(result.selections.map(({ projectedDiameterPixels, selectedLevel }) => [projectedDiameterPixels, selectedLevel]))
      .toEqual([[100, 0], [100, 0]]);
  });

  it("uses adjacent hysteresis bands to stop threshold oscillation", () => {
    const selector = new ScreenSpaceLodSelector({ defaultHysteresisRatio: 0.1 });
    expect(selectForDiameter(selector, 110)).toMatchObject({ baseLevel: 0, preferredLevel: 0 });
    expect(selectForDiameter(selector, 95)).toMatchObject({ baseLevel: 1, preferredLevel: 0 });
    expect(selectForDiameter(selector, 85)).toMatchObject({ baseLevel: 1, preferredLevel: 1 });
    expect(selectForDiameter(selector, 105)).toMatchObject({ baseLevel: 0, preferredLevel: 1 });
    expect(selectForDiameter(selector, 115)).toMatchObject({ baseLevel: 0, preferredLevel: 0 });
  });

  it("combines deterministic object and triangle budgets by explicit priority", () => {
    const objects = [
      objectAt("low", 10, 0),
      objectAt("high", 10, 2),
      objectAt("middle", 10, 1),
    ];
    const budget = { maxObjects: 2, maxTriangles: 120 };
    const first = new ScreenSpaceLodSelector({ defaultHysteresisRatio: 0 }).selectFrame(objects, CAMERA, VIEWPORT, budget);
    const second = new ScreenSpaceLodSelector({ defaultHysteresisRatio: 0 }).selectFrame([...objects].reverse(), CAMERA, VIEWPORT, budget);
    expect(first).toEqual(second);
    expect(first.selections).toEqual([
      expect.objectContaining({ id: "high", selectedLevel: 0, triangles: 100, reason: "preferred" }),
      expect.objectContaining({ id: "low", selectedLevel: null, triangles: 0, reason: "object-budget" }),
      expect.objectContaining({ id: "middle", selectedLevel: 1, triangles: 20, reason: "triangle-budget" }),
    ]);
    expect(first).toMatchObject({ renderedObjects: 2, renderedTriangles: 120 });
  });

  it("drops the lowest deterministic priority when coarsest meshes exceed triangle budget", () => {
    const objects = [objectAt("b", 10), objectAt("a", 10), objectAt("c", 10)];
    const result = new ScreenSpaceLodSelector({ defaultHysteresisRatio: 0 })
      .selectFrame(objects, CAMERA, VIEWPORT, { maxTriangles: 10 });
    expect(result.selections.map(({ id, selectedLevel, reason }) => [id, selectedLevel, reason])).toEqual([
      ["a", 2, "triangle-budget"],
      ["b", 2, "triangle-budget"],
      ["c", null, "triangle-budget"],
    ]);
    expect(result.renderedTriangles).toBe(10);
  });

  it("resets hysteresis for camera jumps, explicit removal, and disappeared objects", () => {
    const selector = new ScreenSpaceLodSelector({ defaultHysteresisRatio: 0.1 });
    selectForDiameter(selector, 110);
    expect(selectForDiameter(selector, 95).preferredLevel).toBe(0);
    selector.resetForCameraJump();
    expect(selectForDiameter(selector, 95).preferredLevel).toBe(1);
    expect(selector.remove("machine")).toBe(true);
    expect(selectForDiameter(selector, 105).preferredLevel).toBe(0);
    selector.selectFrame([], CAMERA, VIEWPORT);
    expect(selector.trackedObjects).toBe(0);
  });

  it("depth-rejects objects before consuming global budgets", () => {
    const selector = new ScreenSpaceLodSelector({ defaultHysteresisRatio: 0 });
    const result = selector.selectFrame([
      objectAt("behind", -10, 100),
      objectAt("visible", 10, 0),
      objectAt("past-far", 2000, 100),
    ], CAMERA, VIEWPORT, { maxObjects: 1, maxTriangles: 100 });
    expect(result.selections.map(({ id, selectedLevel, reason }) => [id, selectedLevel, reason])).toEqual([
      ["behind", null, "depth-range"],
      ["past-far", null, "depth-range"],
      ["visible", 0, "preferred"],
    ]);
  });

  it("keeps all state unchanged when camera, viewport, object, or level validation fails", () => {
    const selector = new ScreenSpaceLodSelector({ maxTrackedObjects: 2 });
    selector.selectFrame([objectAt("stable", 10)], CAMERA, VIEWPORT);
    const before = { revision: selector.revision, tracked: selector.trackedObjects };
    expectLodError(() => selector.selectFrame([objectAt("stable", 10)], { ...CAMERA, verticalFovRadians: Number.NaN }, VIEWPORT));
    expectLodError(() => selector.selectFrame([objectAt("stable", 10)], { ...CAMERA, near: 0 }, VIEWPORT));
    expectLodError(() => selector.selectFrame([objectAt("stable", 10)], CAMERA, { width: 1000, height: 0 }));
    expectLodError(() => selector.selectFrame([objectAt("stable", 10), objectAt("stable", 20)], CAMERA, VIEWPORT));
    expectLodError(() => selector.selectFrame([{ ...objectAt("stable", 10), levels: invalidThresholds() }], CAMERA, VIEWPORT));
    expectLodError(() => selector.selectFrame([objectAt("stable", 10)], CAMERA, VIEWPORT, { maxTriangles: Infinity }));
    expectLodError(() => selector.selectFrame([objectAt("a", 10), objectAt("b", 10), objectAt("c", 10)], CAMERA, VIEWPORT));
    expect({ revision: selector.revision, tracked: selector.trackedObjects }).toEqual(before);
    expect(selectForId(selector, "stable", 95).preferredLevel).toBe(0);
  });

  it("rejects non-finite inputs and invalid multi-level monotonicity", () => {
    const selector = new ScreenSpaceLodSelector();
    expectLodError(() => selector.selectFrame([{ ...objectAt("bad", 10), priority: Infinity }], CAMERA, VIEWPORT));
    expectLodError(() => selector.selectFrame([{ ...objectAt("bad", 10), bounds: {
      min: [Number.NaN, 0, 0], max: [1, 1, 1],
    } }], CAMERA, VIEWPORT));
    expectLodError(() => selector.selectFrame([{ ...objectAt("bad", 10),
      levels: [{ minProjectedDiameterPixels: 0, geometricError: Number.NaN, triangles: 1 }] }], CAMERA, VIEWPORT));
    expectLodError(() => selector.selectFrame([{ ...objectAt("bad", 10), levels: [
      { minProjectedDiameterPixels: 80, geometricError: 1, triangles: 100 },
      { minProjectedDiameterPixels: 30, geometricError: 0.5, triangles: 20 },
      { minProjectedDiameterPixels: 1, geometricError: 2, triangles: 5 },
    ] }], CAMERA, VIEWPORT));
    expectLodError(() => new ScreenSpaceLodSelector({ defaultHysteresisRatio: 0.5 }));
    expectLodError(() => selector.selectFrame([objectAt("bad", 10)], { projection: "fisheye" } as never, VIEWPORT));
  });

  it("bounds frame state and freezes empty and populated results", () => {
    const selector = new ScreenSpaceLodSelector();
    const empty = selector.selectFrame([], CAMERA, VIEWPORT);
    expect(empty).toMatchObject({ selections: [], renderedObjects: 0, renderedTriangles: 0, trackedObjects: 0 });
    expect(Object.isFrozen(empty)).toBe(true);
    const populated = selector.selectFrame([objectAt("b", 10), objectAt("a", 10)], CAMERA, VIEWPORT);
    expect(populated.selections.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(Object.isFrozen(populated.selections)).toBe(true);
    expect(() => (populated.selections as unknown[]).pop()).toThrow();
    selector.selectFrame([objectAt("a", 10)], CAMERA, VIEWPORT);
    expect(selector.trackedObjects).toBe(1);
  });
});

function objectAt(id: string, z: number, priority = 0): ScreenSpaceLodObject<string> {
  return {
    id,
    bounds: spatialAabb([-1, 0, z], [1, 0, z]),
    levels: LEVELS,
    priority,
  };
}

function selectForDiameter(selector: ScreenSpaceLodSelector<string>, diameter: number) {
  return selectForId(selector, "machine", diameter);
}

function selectForId(selector: ScreenSpaceLodSelector<string>, id: string, diameter: number) {
  const z = 1000 / diameter;
  return selector.selectFrame([objectAt(id, z)], CAMERA, VIEWPORT).selections[0]!;
}

function invalidThresholds(): readonly ScreenSpaceLodLevel[] {
  return [
    { minProjectedDiameterPixels: 100, geometricError: 0, triangles: 100 },
    { minProjectedDiameterPixels: 110, geometricError: 1, triangles: 20 },
  ];
}

function expectLodError(run: () => unknown): void {
  expect(run).toThrowError(SpatialIndexError);
}
