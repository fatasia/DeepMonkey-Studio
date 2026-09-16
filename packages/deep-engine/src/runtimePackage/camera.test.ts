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
