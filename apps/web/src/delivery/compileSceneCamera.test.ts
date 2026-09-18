import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { compileSceneCamera } from "./compileSceneCamera";
import { DEFAULT_CAMERA_CONSTRAINTS } from "../appDefaults";

const scene = (): SceneSnapshot => ({ schemaVersion: 1, id: "scene", projectId: "p", name: "scene", models: [], primitives: [], measurements: [],
  camera: { mode: "orbit", position: { x: 0, y: 0, z: 10 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "", updatedAt: "" });
describe("authored initial camera compilation", () => {
  it("selects the published default view and preserves source values", () => {
    const input = scene();
    input.cameraViews = [{ id: "view", name: "Saved", createdAt: "", camera: { ...input.camera, position: { x: 12, y: 8, z: 16 } } }];
    input.defaultCameraViewId = "view";
    const before = structuredClone(input);
    expect(compileSceneCamera(input).position).toEqual([12, 8, 16]);
    expect(input).toEqual(before);
    input.defaultCameraViewId = "missing";
    expect(compileSceneCamera(input).position).toEqual([0, 0, 10]);
  });
  it("uses the viewer's adaptive default orbit range", () => {
    const input = scene(); input.camera.position.z = 1;
    expect(compileSceneCamera(input)).toMatchObject({ near: 0.01, far: 100000, verticalFovDegrees: 50 });
    input.camera.position.z = 2000;
    expect(compileSceneCamera(input).far).toBe(200000);
  });
  it("honors authored clipping overrides and viewer normalization", () => {
    const input = scene();
    input.cameraConstraints = { ...DEFAULT_CAMERA_CONSTRAINTS, nearClip: 0.2, farClip: 800 };
    expect(compileSceneCamera(input)).toMatchObject({ near: 0.2, far: 800 });
    input.cameraConstraints.nearClip = -1;
    expect(compileSceneCamera(input).near).toBe(0.001);
    input.camera.mode = "firstPerson"; delete input.cameraConstraints;
    input.camera.position.z = 1;
    expect(compileSceneCamera(input).near).toBe(0.05);
  });
  it("rejects degenerate or out-of-budget views", () => {
    const input = scene(); input.camera.position = { ...input.camera.target };
    expect(() => compileSceneCamera(input)).toThrow();
    input.camera.position.z = 1e8;
    expect(() => compileSceneCamera(input)).toThrow();
  });
});
