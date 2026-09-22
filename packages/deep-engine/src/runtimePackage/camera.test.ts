import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateRuntimeSceneCamera } from "./camera.js";

const fixture = () => JSON.parse(readFileSync(new URL("../../fixtures/runtime-camera-v1.json", import.meta.url), "utf8"));
describe("scene camera v1", () => {
  it("reads the shared Native fixture and isolates the validated snapshot", () => {
    const input = fixture(), result = validateRuntimeSceneCamera(input);
    expect(result).toEqual(input); input.position[0] = 999;
    expect(result.position[0]).toBe(12);
  });
  it.each([
    ["schemaVersion", 2], ["id", "A"], ["revision", 0], ["revision", 1.5],
    ["position", [1, 2]], ["position", [1e8, 0, 0]], ["target", [12, 8, 16]],
    ["verticalFovDegrees", 0], ["verticalFovDegrees", 180], ["near", 0],
    ["far", 0.04], ["far", 1e7], ["unknown", 1], ["near", NaN],
  ])("rejects invalid %s=%j", (key, value) => {
    expect(() => validateRuntimeSceneCamera({ ...fixture(), [key]: value })).toThrow();
  });
  it("rejects positions that collapse at float32 precision", () => {
    expect(() => validateRuntimeSceneCamera({ ...fixture(), position: [1e7, 0, 0], target: [1e7 - 0.01, 0, 0] })).toThrow("float32");
  });
  it("rejects missing and accessor fields without invoking them", () => {
    const input = fixture(); delete input.far;
    expect(() => validateRuntimeSceneCamera(input)).toThrow();
    Object.defineProperty(input, "far", { get() { throw new Error("getter executed"); }, enumerable: true });
    expect(() => validateRuntimeSceneCamera(input)).toThrow(/Accessor/);
  });
});

describe("scene camera v3 section plane", () => {
  const framed = () => ({ ...fixture(), schemaVersion: 3, clippingPlane: [1, 0, 0, -2] });
  it("reads the section plane and keeps v3 frame optional", () => {
    const result = validateRuntimeSceneCamera(framed());
    expect(result.clippingPlane).toEqual([1, 0, 0, -2]);
    const framedPlane = { ...framed(), coordinateFrame: { schemaVersion: 1, profile: { id: "scene-local-coordinates-v1", unit: "scene-unit",
      originGrid: 1000, maxRoundTripError: 0.000001, maxFloat32CoordinateError: 0.001 }, origin: { x: 1000000000, y: 1000000000, z: 1000000000 } } };
    expect(validateRuntimeSceneCamera(framedPlane).clippingPlane).toEqual([1, 0, 0, -2]);
  });
  it.each([
    ["schemaVersion", 2], ["clippingPlane", [1, 0, 0]], ["clippingPlane", [0, 0, 0, 1]],
    ["clippingPlane", [1, 0, 0, "x"]], ["clippingPlane", [1e8, 0, 0, 0]], ["clippingPlane", null],
  ])("rejects invalid %s=%j", (key, value) => {
    expect(() => validateRuntimeSceneCamera({ ...framed(), [key]: value })).toThrow();
  });
  it("keeps v1/v2 free of the section plane", () => {
    expect(() => validateRuntimeSceneCamera({ ...fixture(), clippingPlane: [1, 0, 0, -2] })).toThrow();
  });
});

describe("scene camera v4 controls", () => {
  const controls = () => ({ mode: "orbit", minDistance: 0.5, maxDistance: 100,
    minPolarAngleDegrees: 1, maxPolarAngleDegrees: 179, collisionEnabled: true,
    collisionRadius: 0.32, walkSpeed: 4, flySpeed: 5, sprintMultiplier: 2,
    eyeHeight: 1.68, gravity: 12, jumpSpeed: 5.4, stepHeight: 0.3,
    maxSlopeAngleDegrees: 50 });
  const controlled = () => ({ ...fixture(), schemaVersion: 4, controls: controls() });

  it("requires and isolates the complete navigation contract", () => {
    const input = controlled(), result = validateRuntimeSceneCamera(input);
    expect(result.controls).toEqual(controls());
    input.controls.walkSpeed = 40;
    expect(result.controls?.walkSpeed).toBe(4);
    const missing = controlled(); delete missing.controls;
    expect(() => validateRuntimeSceneCamera(missing)).toThrow();
  });

  it.each([
    ["mode", "fly"], ["minDistance", 0], ["maxDistance", 0.5],
    ["minPolarAngleDegrees", -1], ["maxPolarAngleDegrees", 181],
    ["collisionEnabled", 1], ["collisionRadius", 0], ["walkSpeed", 0],
    ["flySpeed", 101], ["sprintMultiplier", 0.9], ["eyeHeight", 5],
    ["gravity", -1], ["jumpSpeed", 31], ["stepHeight", 2],
    ["maxSlopeAngleDegrees", 90], ["unknown", 1],
  ])("rejects invalid control %s=%j", (key, value) => {
    expect(() => validateRuntimeSceneCamera({ ...controlled(), controls: { ...controls(), [key]: value } })).toThrow();
  });

  it("keeps controls out of legacy camera schemas", () => {
    expect(() => validateRuntimeSceneCamera({ ...fixture(), controls: controls() })).toThrow();
  });
});
