import { describe, expect, it } from "vitest";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { DEFAULT_ANIMATION, DEFAULT_CLIPPING, DEFAULT_PHYSICS, DEFAULT_ENVIRONMENT, DEFAULT_CAMERA_CONSTRAINTS } from "../appDefaults";
import { DEFAULT_SCENE_COORDINATES } from "../viewer/sceneCoordinates";
import { collectDeferredSceneFields, isInactiveSceneField } from "./sceneInactiveFields";
import { compileSceneRuntimePackage } from "./compileSceneRuntimePackage";
import { sceneCompilationSource } from "./sceneCompilationSource";
import { DEFAULT_DASHBOARD_STATE } from "../components/dashboardState";

const inactive: Record<string, unknown> = { animation: DEFAULT_ANIMATION, clipping: DEFAULT_CLIPPING,
  physics: DEFAULT_PHYSICS, coordinateSystem: DEFAULT_SCENE_COORDINATES };
describe("strict inactive scene fields", () => {
  it("keeps empty dashboards with page appearance deferred in compiler and archive field checks", async () => {
    const scene: SceneSnapshot = { schemaVersion: 1, id: "scene", projectId: "project", name: "static",
      models: [], primitives: [], measurements: [], createdAt: "", updatedAt: "",
      camera: { mode: "orbit", position: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 } },
      dashboard: structuredClone(DEFAULT_DASHBOARD_STATE) };
    // Migration preserves page appearance even when no data widgets exist.
    const before = structuredClone(scene);
    expect(isInactiveSceneField("dashboard", scene.dashboard)).toBe(false);
    expect(collectDeferredSceneFields(sceneCompilationSource(scene))).toEqual(["dashboard"]);
    const compiled = await compileSceneRuntimePackage(scene, { packageId: "scene.dashboard", packageVersion: "1.0.0",
      loadModel: async () => { throw new Error("unexpected asset"); } });
    expect(compiled.evidence.deferredSceneFields).toEqual(["dashboard"]);
    expect(scene).toEqual(before);
    expect(isInactiveSceneField("dashboard", { ...scene.dashboard, backgroundOpacity: 0 })).toBe(false);
  });
  it.each(Object.entries(inactive))("accepts complete inactive %s without mutation", (field, value) => {
    const copy = structuredClone(value);
    expect(isInactiveSceneField(field, copy)).toBe(true);
    expect(copy).toEqual(value);
    expect(isInactiveSceneField(field, { ...(copy as object), future: false })).toBe(false);
  });
  it.each([
    ["animation", { ...DEFAULT_ANIMATION, models: [{ modelId: "model" }] }],
    ["animation", { ...DEFAULT_ANIMATION, camera: [{}] }],
    ["animation", { ...DEFAULT_ANIMATION, autoplay: "false" }],
    ["animation", { ...DEFAULT_ANIMATION, loop: 0 }],
    ["animation", { ...DEFAULT_ANIMATION, duration: Infinity }],
    ["animation", { ...DEFAULT_ANIMATION, playbackSpeed: 0 }],
    ["animation", { ...DEFAULT_ANIMATION, frameRate: NaN }],
    ["animation", { ...DEFAULT_ANIMATION, cameraInterpolation: "unknown" }],
    ["animation", { ...DEFAULT_ANIMATION, modelInterpolation: "spline" }],
    ["clipping", { ...DEFAULT_CLIPPING, enabled: true }],
    ["clipping", { ...DEFAULT_CLIPPING, axis: "a" }],
    ["clipping", { ...DEFAULT_CLIPPING, mode: "unknown" }],
    ["clipping", { ...DEFAULT_CLIPPING, offset: "0" }],
    ["clipping", { ...DEFAULT_CLIPPING, inverted: undefined }],
    ["clipping", { ...DEFAULT_CLIPPING, showHelper: 1 }],
    ["clipping", { ...DEFAULT_CLIPPING, face: { normal: { x: 0, y: 0, z: 0 }, point: { x: 0, y: 0, z: 0 } } }],
    ["clipping", { ...DEFAULT_CLIPPING, box: { min: { x: 2, y: 0, z: 0 }, max: { x: 1, y: 0, z: 0 } } }],
    ["physics", { ...DEFAULT_PHYSICS, playing: true }],
    ["physics", { ...DEFAULT_PHYSICS, enabled: true }],
    ["physics", { ...DEFAULT_PHYSICS, gravity: { x: 0, y: NaN, z: 0 } }],
    ["physics", { ...DEFAULT_PHYSICS, gravity: { x: 0, y: 0, z: 0, future: 1 } }],
    ["coordinateSystem", { ...DEFAULT_SCENE_COORDINATES, unit: "mm" }],
    ["coordinateSystem", { ...DEFAULT_SCENE_COORDINATES, handedness: "left" }],
    ["coordinateSystem", { ...DEFAULT_SCENE_COORDINATES, upAxis: "z" }],
    ["coordinateSystem", { ...DEFAULT_SCENE_COORDINATES, epsg: "" }],
    ["coordinateSystem", { ...DEFAULT_SCENE_COORDINATES, origin: { x: 1, y: 0, z: 0 } }],
  ])("keeps invalid or active %s deferred: %j", (field, value) => {
    expect(isInactiveSceneField(field as string, value)).toBe(false);
  });
  it("does not discard unknown empty arrays or defaults that render", () => {
    expect(collectDeferredSceneFields({ future: [], measurements: [], ...inactive,
      environment: DEFAULT_ENVIRONMENT, cameraConstraints: DEFAULT_CAMERA_CONSTRAINTS, weather: "sunny" }))
      .toEqual(["cameraConstraints", "environment", "future", "weather"]);
  });
  it("keeps inactive values in the source and graph identity while runtime bytes stay static", async () => {
    const scene: SceneSnapshot = { schemaVersion: 1, id: "scene", projectId: "project", name: "static",
      models: [], primitives: [], measurements: [], camera: { mode: "orbit", position: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 } },
      createdAt: "", updatedAt: "", animation: structuredClone(DEFAULT_ANIMATION), clipping: structuredClone(DEFAULT_CLIPPING),
      physics: structuredClone(DEFAULT_PHYSICS), coordinateSystem: structuredClone(DEFAULT_SCENE_COORDINATES) };
    const options = { packageId: "scene.static", packageVersion: "1.0.0", loadModel: async () => { throw new Error("unexpected asset"); } };
    const first = await compileSceneRuntimePackage(scene, options);
    expect(first.evidence.deferredSceneFields).toEqual([]);
    expect(first.evidence.sourceSemanticHash).toBe(runtimeContentSha256(sceneCompilationSource(scene)));
    const changed = structuredClone(scene); changed.animation!.duration = 20;
    const second = await compileSceneRuntimePackage(changed, options);
    expect(second.packageJson).toBe(first.packageJson);
    expect(second.evidence.sourceSemanticHash).not.toBe(first.evidence.sourceSemanticHash);
    expect(second.evidence.compileGraphHash).not.toBe(first.evidence.compileGraphHash);
    Object.assign(changed.animation!, { future: true });
    const unknown = await compileSceneRuntimePackage(changed, options);
    expect(unknown.evidence.deferredSceneFields).toEqual(["animation"]);
  });
});
