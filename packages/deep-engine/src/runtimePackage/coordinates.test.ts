import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RUNTIME_COORDINATE_PROFILE, runtimeLocalToWorld, runtimeWorldToLocal, validateRuntimeCoordinateFrame } from "./coordinates.js";
import { validateRuntimeSceneCamera } from "./camera.js";

const frame = () => ({ schemaVersion: 1 as const, profile: RUNTIME_COORDINATE_PROFILE, origin: { x: 1e9, y: -1e9, z: 1e9 } });
const camera = () => ({ schema: "deep-engine.scene-camera", schemaVersion: 2, id: "camera", revision: 1,
  position: [12, 8, 16], target: [0, 0, 0], near: 0.05, far: 10000, verticalFovDegrees: 50, coordinateFrame: frame() });

describe("runtime coordinate frame", () => {
  it("reads the real compiler camera shared with Native", () => {
    const value = validateRuntimeSceneCamera(JSON.parse(readFileSync(new URL("../../fixtures/runtime-camera-v2.json", import.meta.url), "utf8")));
    expect(runtimeLocalToWorld({ x: value.position[0], y: value.position[1], z: value.position[2] }, value.coordinateFrame!))
      .toEqual({ x: 1000000012, y: -999999992, z: 1000000016 });
  });
  it("keeps double world coordinates reversible across two local origins", () => {
    const world = { x: 1e9 + 12.125, y: -1e9 + 8.25, z: 1e9 + 16.5 };
    const first = validateRuntimeCoordinateFrame(frame()), second = validateRuntimeCoordinateFrame({ ...frame(), origin: { x: 1e9 + 1000, y: -1e9, z: 1e9 - 1000 } });
    expect(runtimeLocalToWorld(runtimeWorldToLocal(world, first), first)).toEqual(world);
    expect(runtimeLocalToWorld(runtimeWorldToLocal(world, second), second)).toEqual(world);
    expect(runtimeWorldToLocal(world, first)).not.toEqual(runtimeWorldToLocal(world, second));
  });
  it("retains the validated camera frame without aliasing caller data", () => {
    const input = camera(), result = validateRuntimeSceneCamera(input);
    input.coordinateFrame.origin.x = 0;
    expect(result.coordinateFrame!.origin.x).toBe(1e9);
    expect(result.schemaVersion).toBe(2);
  });
  it.each(["schema", "unknown", "budget", "unit", "origin-grid", "origin-infinite", "origin-unknown"])("rejects altered frame %s", kind => {
    const value: any = structuredClone(frame());
    if (kind === "schema") value.schemaVersion = 2;
    if (kind === "unknown") value.future = true;
    if (kind === "budget") value.profile.maxFloat32CoordinateError = 1;
    if (kind === "unit") value.profile.unit = "m";
    if (kind === "origin-grid") value.origin.x += 1;
    if (kind === "origin-infinite") value.origin.x = Infinity;
    if (kind === "origin-unknown") value.origin.w = 1;
    expect(() => validateRuntimeCoordinateFrame(value)).toThrow();
  });
  it("requires v2 frame and rejects a frame added to a v1 camera", () => {
    const { coordinateFrame, ...legacy } = camera();
    expect(() => validateRuntimeSceneCamera(legacy)).toThrow();
    expect(() => validateRuntimeSceneCamera({ ...legacy, schemaVersion: 1 })).not.toThrow();
    expect(() => validateRuntimeSceneCamera({ ...legacy, schemaVersion: 1, coordinateFrame })).toThrow();
  });
  it("does not accept off-grid origins rounded by division at large magnitudes", () => {
    const origin = 1e19 + 2048;
    expect((origin / 1000) % 1).toBe(0);
    expect(origin % 1000).toBe(48);
    expect(() => validateRuntimeCoordinateFrame({ ...frame(), origin: { x: origin, y: 0, z: 0 } })).toThrow("grid");
  });
  it("rejects local float32 loss and world roundtrip loss without relaxing the profile", () => {
    expect(() => runtimeWorldToLocal({ x: 1e9 + 100000.123, y: -1e9, z: 1e9 }, frame())).toThrow("precision");
    const distant = validateRuntimeCoordinateFrame({ ...frame(), origin: { x: 1e18, y: 0, z: 0 } });
    expect(() => runtimeLocalToWorld({ x: 0.125, y: 0, z: 0 }, distant)).toThrow("precision");
    expect(() => validateRuntimeSceneCamera({ ...camera(), coordinateFrame: distant })).toThrow("precision");
  });
});
