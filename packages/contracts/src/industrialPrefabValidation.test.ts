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
});
