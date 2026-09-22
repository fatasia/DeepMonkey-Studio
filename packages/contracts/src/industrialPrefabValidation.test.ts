import { describe, expect, it } from "vitest";
import { validateIndustrialPrefabInstance } from "./industrialPrefabValidation";

describe("industrial prefab validation", () => {
  it("accepts an AGV with an editable motion route", () => {
    expect(() => validateIndustrialPrefabInstance({
      definitionId: "builtin.agv.tugger",
      definitionVersion: "1.0.0",
      kind: "agv",
      parameters: { maxSpeedMps: 1.5, loadKg: 500, obstacleAvoidance: true },
      operatingState: "running",
      motionRoute: {
        enabled: true,
        autoplay: true,
        points: [
          { id: "start", position: { x: 0, y: 0, z: 0 }, waitSeconds: 1 },
          { id: "station-a", position: { x: 10, y: 0, z: 4 }, speedOverrideMps: 0.8 }
        ],
        speedMps: 1.2,
        accelerationMps2: 0.6,
        loopMode: "loop",
        orientToPath: true,
        startOffsetSeconds: 0,
        trafficGroup: "workshop-a"
      }
    }, "prefab")).not.toThrow();
  });

  it("rejects non-primitive parameter values", () => {
    expect(() => validateIndustrialPrefabInstance({
      definitionId: "builtin.conveyor.straight",
      definitionVersion: "1.0.0",
      kind: "conveyor",
      parameters: { unsafe: { nested: true } },
      operatingState: "idle"
    }, "prefab")).toThrow("prefab.parameters.unsafe");
  });

  it("accepts the expanded manufacturing prefab kinds", () => {
    for (const kind of ["machine", "utility", "electrical", "sensor", "camera", "storage"] as const) {
      expect(() => validateIndustrialPrefabInstance({
        definitionId: `builtin.${kind}.sample`,
        definitionVersion: "1.0.0",
        kind,
        parameters: { enabled: true },
        operatingState: "idle",
      }, "prefab")).not.toThrow();
    }
  });

  it("accepts the road authoring prefab kind", () => {
    expect(() => validateIndustrialPrefabInstance({
      definitionId: "road.straight",
      definitionVersion: "1.0.0",
      kind: "road",
      parameters: {
        lengthM: 20,
        carriagewayWidthM: 7,
        laneCount: 2,
        shoulderWidthM: 0.75,
        surface: "asphalt",
        marking: "center",
      },
      operatingState: "idle",
      placementPath: {
        points: [
          { id: "start", position: { x: 0, y: 0, z: 0 } },
          { id: "end", position: { x: 20, y: 0, z: 5 } },
        ],
        interpolation: "catmull-rom",
        closed: false,
        snapToGround: true,
        seed: 1234,
      },
    }, "prefab")).not.toThrow();
  });

  it("rejects malformed or nondeterministic placement paths", () => {
    const value = {
      definitionId: "fence.modular", definitionVersion: "1.0.0", kind: "fence",
      parameters: {}, operatingState: "idle",
      placementPath: { points: [
        { id: "same", position: { x: 0, y: 0, z: 0 } },
        { id: "same", position: { x: 4, y: 0, z: 0 } },
      ], interpolation: "linear", closed: false, snapToGround: false, seed: 1 },
    };
    expect(() => validateIndustrialPrefabInstance(value, "prefab")).toThrow(/nonempty and unique/);
    expect(() => validateIndustrialPrefabInstance({ ...value, placementPath: { ...value.placementPath,
      points: [{ id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 1, y: 0, z: 0 } }], seed: -1 } }, "prefab"))
      .toThrow(/uint32/);
  });

  it("bounds the optional placement path slope limit to the navigation 0..89 degree range", () => {
    const value = {
      definitionId: "fence.modular", definitionVersion: "1.0.0", kind: "fence",
      parameters: {}, operatingState: "idle",
      placementPath: { points: [
        { id: "a", position: { x: 0, y: 0, z: 0 } },
        { id: "b", position: { x: 4, y: 0, z: 0 } },
      ], interpolation: "linear", closed: false, snapToGround: false, seed: 1 },
    };
    expect(() => validateIndustrialPrefabInstance({ ...value,
      placementPath: { ...value.placementPath, maxSlopeAngleDegrees: 50 } }, "prefab")).not.toThrow();
    expect(() => validateIndustrialPrefabInstance({ ...value,
      placementPath: { ...value.placementPath, maxSlopeAngleDegrees: 89 } }, "prefab")).not.toThrow();
    expect(() => validateIndustrialPrefabInstance({ ...value,
      placementPath: { ...value.placementPath, maxSlopeAngleDegrees: -1 } }, "prefab")).toThrow(/0\.\.89/);
    expect(() => validateIndustrialPrefabInstance({ ...value,
      placementPath: { ...value.placementPath, maxSlopeAngleDegrees: 90 } }, "prefab")).toThrow(/0\.\.89/);
    expect(() => validateIndustrialPrefabInstance({ ...value,
      placementPath: { ...value.placementPath, maxSlopeAngleDegrees: Number.NaN } }, "prefab")).toThrow(/有限数字/);
  });
});
