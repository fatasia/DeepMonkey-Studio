import { describe, expect, it } from "vitest";
import { validateScene } from "./sceneValidation";

const profile = { profileId: "ies-factory", format: "LM-63-2002", verticalAngles: [0, 45, 90],
  candela: [[1000, 500, 100]], horizontalSymmetry: 1, totalLumens: 1234.5 };
const scene = () => ({ id: "ies-scene", name: "IES", camera: { mode: "orbit",
  position: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 } }, models: [], primitives: [], measurements: [],
  lighting: { enabled: true, intensity: 1, lightProfiles: [profile], lights: [{ id: "spot", name: "Spot", type: "spot",
    enabled: true, color: "#ffffff", intensity: 4, position: { x: 0, y: 4, z: 0 }, target: { x: 0, y: 0, z: 0 },
    distance: 12, decay: 2, angle: .7, penumbra: .5, ies: { profileId: "ies-factory", rotationDeg: 45, scaleFactor: .75 } }] } });

describe("scene IES author contract", () => {
  it("accepts a closed, persistent spot-profile reference", () => {
    expect(() => validateScene(scene(), "scene")).not.toThrow();
  });

  it("rejects missing references, non-spot use and values outside the runtime grid", () => {
    const missing = scene(); missing.lighting.lights[0]!.ies.profileId = "missing";
    expect(() => validateScene(missing, "scene")).toThrow(/profileId/);
    const point = scene(); point.lighting.lights[0]!.type = "point";
    expect(() => validateScene(point, "scene")).toThrow(/仅支持聚光灯/);
    const rotation = scene(); rotation.lighting.lights[0]!.ies.rotationDeg = 45.25;
    expect(() => validateScene(rotation, "scene")).toThrow(/0\.5°/);
  });
});
