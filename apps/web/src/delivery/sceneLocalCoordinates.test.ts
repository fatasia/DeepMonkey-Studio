import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { createSceneLocalFrame, localizeSceneCoordinates, localToWorld, SCENE_LOCAL_COORDINATE_PROFILE, worldToLocal } from "./sceneLocalCoordinates";

const point = (x: number, y = x, z = x) => ({ x, y, z });
function fixture(offset = 1e9): SceneSnapshot {
  const transform = { position: point(offset + 0.125, offset - 2.25, offset + 10.5), rotation: point(0.1, 0.2, 0.3), scale: point(2, 3, 4) };
  return { schemaVersion: 1, id: "scene", projectId: "project", name: "Coordinates", createdAt: "now", updatedAt: "now", measurements: [],
    models: [{ modelId: "instance", assetModelId: "asset", name: "Model", visible: true, opacity: 1, transform }],
    primitives: [{ modelId: "box", name: "Box", kind: "box", color: "#808080", visible: false, opacity: 1, transform: structuredClone(transform) }],
    camera: { mode: "orbit", position: point(offset + 10, offset + 20, offset + 30), target: point(offset) } };
}

describe("static scene local coordinate profile", () => {
  it("freezes numerical tolerances in scene units without inventing a physical unit", () => {
    expect(SCENE_LOCAL_COORDINATE_PROFILE).toEqual({ id: "scene-local-coordinates-v1", unit: "scene-unit", originGrid: 1000,
      maxRoundTripError: 0.000001, maxFloat32CoordinateError: 0.001 });
    expect(Object.isFrozen(SCENE_LOCAL_COORDINATE_PROFILE)).toBe(true);
  });

  it.each([1e6, 1e9, -1e9])("preserves equivalent local geometry and camera at world offset %s", offset => {
    const input = fixture(offset), before = structuredClone(input);
    const { scene, frame } = localizeSceneCoordinates(input);
    expect(frame.origin).toEqual(point(offset));
    expect(scene.camera.target).toEqual(point(0));
    expect(scene.camera.position).toEqual(point(10, 20, 30));
    expect(scene.models[0]!.transform.position).toEqual(point(0.125, -2.25, 10.5));
    expect(scene.primitives[0]!.transform.position).toEqual(scene.models[0]!.transform.position);
    expect(localToWorld(scene.models[0]!.transform.position, frame.origin)).toEqual(input.models[0]!.transform.position);
    expect(scene.models[0]!.modelId).toBe("instance");
    expect(scene.models[0]!.assetModelId).toBe("asset");
    expect(scene.primitives[0]!.visible).toBe(false);
    expect(scene.models[0]!.transform.rotation).toEqual(input.models[0]!.transform.rotation);
    expect(scene.models[0]!.transform.scale).toEqual(input.models[0]!.transform.scale);
    expect(input).toEqual(before);
    scene.models[0]!.transform.rotation.x = 9;
    expect(input.models[0]!.transform.rotation.x).toBe(0.1);
  });

  it("uses the same selected default camera rule and shifts every stored camera", () => {
    const input = fixture(1e6);
    input.cameraViews = [
      { id: "first", name: "First", camera: { ...structuredClone(input.camera), target: point(1e6 + 100) } },
      { id: "selected", name: "Selected", camera: { ...structuredClone(input.camera), target: point(1e6 + 1600, 1e6 - 1600, 1e6 + 400) } },
    ] as NonNullable<SceneSnapshot["cameraViews"]>;
    input.defaultCameraViewId = "selected";
    const { scene, frame } = localizeSceneCoordinates(input);
    expect(frame.origin).toEqual(point(1e6 + 2000, 1e6 - 2000, 1e6));
    expect(scene.cameraViews![1]!.camera.target).toEqual(point(-400, 400, 400));
    for (const [index, view] of scene.cameraViews!.entries()) {
      expect(localToWorld(view.camera.position, frame.origin)).toEqual(input.cameraViews![index]!.camera.position);
      expect(localToWorld(view.camera.target, frame.origin)).toEqual(input.cameraViews![index]!.camera.target);
    }
    expect(localToWorld(scene.camera.target, frame.origin)).toEqual(input.camera.target);
    input.defaultCameraViewId = "missing";
    expect(createSceneLocalFrame(input).origin).toEqual(point(1e6));
  });

  it("honors a finite explicit origin without rounding or retaining caller references", () => {
    const origin = point(1e9 + 0.125, 1e9 - 0.25, 1e9 + 0.5);
    const { scene, frame } = localizeSceneCoordinates(fixture(), origin);
    expect(frame.origin).toEqual(origin);
    expect(scene.camera.target).toEqual(point(-0.125, 0.25, -0.5));
    origin.x = 0;
    expect(frame.origin.x).toBe(1e9 + 0.125);
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.origin)).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite origin, world and local coordinates: %s", value => {
    expect(() => createSceneLocalFrame(fixture(), point(value))).toThrow(/有限/);
    expect(() => worldToLocal(point(value), point(0))).toThrow(/有限/);
    expect(() => localToWorld(point(value), point(0))).toThrow(/有限/);
  });

  it("rejects overflow instead of converting it to a valid-looking local frame", () => {
    expect(() => worldToLocal(point(Number.MAX_VALUE), point(-Number.MAX_VALUE))).toThrow(/范围/);
    expect(() => worldToLocal(point(1e40), point(0))).toThrow(/Float32 范围/);
  });

  it("measures actual Float32 error and rejects coordinates beyond the frozen tolerance", () => {
    expect(() => worldToLocal(point(1e6 + 0.01), point(0))).toThrow(/Float32 误差/);
    expect(() => localToWorld(point(1e6 + 0.01), point(0))).toThrow(/Float32 误差/);
    const local = worldToLocal(point(1e9 + 0.01), point(1e9));
    expect(Math.abs(Math.fround(local.x) - local.x)).toBeLessThanOrEqual(SCENE_LOCAL_COORDINATE_PROFILE.maxFloat32CoordinateError);
  });

  it("rejects a numerically irreversible translation even when local Float32 is exact", () => {
    expect(() => worldToLocal(point(1), point(2 ** 60))).toThrow(/往返误差/);
    expect(() => localToWorld(point(1), point(2 ** 60))).toThrow(/往返误差/);
  });

  it("locates a failing root coordinate and leaves the source unchanged on failure", () => {
    const input = fixture(); input.models[0]!.transform.position.x = 1e9 + 1e6 + 0.01;
    const before = structuredClone(input);
    expect(() => localizeSceneCoordinates(input)).toThrow(/models\[instance\].position.x.*Float32 误差/);
    expect(input).toEqual(before);
  });

  it("keeps IDs across explicit origin changes and maps the same world position back", () => {
    const input = fixture(), first = localizeSceneCoordinates(input), second = localizeSceneCoordinates(input, point(1e9 + 1000));
    expect(first.scene.models[0]!.modelId).toBe(second.scene.models[0]!.modelId);
    expect(first.scene.models[0]!.transform.position).not.toEqual(second.scene.models[0]!.transform.position);
    expect(localToWorld(first.scene.models[0]!.transform.position, first.frame.origin))
      .toEqual(localToWorld(second.scene.models[0]!.transform.position, second.frame.origin));
  });

  it("canonicalizes signed zero in the origin and projected coordinates", () => {
    const input = fixture(0); input.camera.target = point(-0);
    const { scene, frame } = localizeSceneCoordinates(input);
    expect(Object.is(frame.origin.x, -0)).toBe(false);
    expect(Object.is(scene.camera.target.x, -0)).toBe(false);
  });
});
