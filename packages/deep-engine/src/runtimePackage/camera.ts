import { array, fields, record, requireValue, resourceId, revision, snapshotJson } from "./primitives.js";
import { validateRuntimeCoordinateFrame, runtimeLocalToWorld, type RuntimeCoordinateFrame } from "./coordinates.js";
import { validateRuntimeCameraControls, type RuntimeCameraControls } from "./cameraControls.js";

export interface RuntimeCameraView {
  readonly id: string;
  readonly name: string;
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

/** Y-up perspective camera; v2 adds local coordinates, v3 section planes, v4 author controls, and v5 saved views. */
export interface RuntimeSceneCamera {
  readonly schema: "deep-engine.scene-camera";
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5;
  readonly coordinateFrame?: RuntimeCoordinateFrame;
  readonly id: string;
  readonly revision: number;
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly verticalFovDegrees: number;
  readonly near: number;
  readonly far: number;
  /** Section plane [nx, ny, nz, d] in world space; fragments with dot(n, world) + d < 0 are discarded. v3 only. */
  readonly clippingPlane?: readonly [number, number, number, number];
  /** Navigation behavior authored by the scene. Required by v4. */
  readonly controls?: RuntimeCameraControls;
  /** Ordered author camera views. Required by v5 and kept in the scene-local frame. */
  readonly cameraViews?: readonly RuntimeCameraView[];
  readonly defaultCameraViewId?: string;
}

export function validateRuntimeSceneCamera(input: unknown): RuntimeSceneCamera {
  const path = "$.camera", value = record(snapshotJson(input), path);
  const framed = value.schemaVersion === 2 || value.schemaVersion === 3 || value.schemaVersion === 4 || value.schemaVersion === 5;
  const versioned = value.schemaVersion === 3 || value.schemaVersion === 4 || value.schemaVersion === 5;
  const controlled = value.schemaVersion === 4 || value.schemaVersion === 5;
  const savedViews = value.schemaVersion === 5;
  fields(value, ["schema", "schemaVersion", "id", "revision", "position", "target", "verticalFovDegrees", "near", "far",
    ...(value.schemaVersion === 2 ? ["coordinateFrame"] : []), ...(controlled ? ["controls"] : []),
    ...(savedViews ? ["cameraViews", "defaultCameraViewId"] : [])],
    [...(versioned ? ["coordinateFrame", "clippingPlane"] : [])], path);
  requireValue(value.schema === "deep-engine.scene-camera" && (value.schemaVersion === 1 || framed), path, "Unsupported scene camera schema.");
  requireValue(value.schemaVersion !== 2 || "coordinateFrame" in value, path, "Scene camera v2 requires the coordinate frame.");
  if (controlled) validateRuntimeCameraControls(value.controls);
  resourceId(value.id, `${path}.id`); revision(value.revision, `${path}.revision`);
  const finite = (item: unknown, minimum: number, maximum: number, name: string): number => {
    requireValue(typeof item === "number" && Number.isFinite(item) && item >= minimum && item <= maximum, `${path}.${name}`, "Camera number is out of range.");
    return item;
  };
  const vector = (name: "position" | "target"): number[] => {
    const items = array(value[name], `${path}.${name}`, 3);
    requireValue(items.length === 3, `${path}.${name}`, "Expected three coordinates.");
    return items.map((item, index) => Math.fround(finite(item, -10_000_000, 10_000_000, `${name}[${index}]`)));
  };
  const position = vector("position"), target = vector("target");
  if (savedViews) {
    const views = array(value.cameraViews, `${path}.cameraViews`, 32);
    requireValue(views.length > 0, `${path}.cameraViews`, "At least one saved camera view is required.");
    const ids = new Set<string>();
    for (const [index, input] of views.entries()) {
      const viewPath = `${path}.cameraViews[${index}]`, view = record(input, viewPath);
      fields(view, ["id", "name", "position", "target"], [], viewPath);
      requireValue(typeof view.id === "string" && view.id.length > 0 && view.id.length <= 256 && !ids.has(view.id),
        `${viewPath}.id`, "Saved camera view id is invalid or duplicated.");
      requireValue(typeof view.name === "string" && view.name.trim().length > 0 && view.name.length <= 128,
        `${viewPath}.name`, "Saved camera view name is invalid.");
      ids.add(view.id);
      const vectors = (["position", "target"] as const).map(key => {
        const items = array(view[key], `${viewPath}.${key}`, 3);
        requireValue(items.length === 3, `${viewPath}.${key}`, "Expected three coordinates.");
        return items.map((item, axis) => finite(item, -10_000_000, 10_000_000, `cameraViews[${index}].${key}[${axis}]`));
      });
      requireValue(Math.hypot(...vectors[0]!.map((item, axis) => Math.fround(item) - Math.fround(vectors[1]![axis]!))) >= 0.0001,
        viewPath, "Saved camera position and target must remain distinct in float32.");
    }
    requireValue(typeof value.defaultCameraViewId === "string" && ids.has(value.defaultCameraViewId),
      `${path}.defaultCameraViewId`, "Default camera view must reference a saved view.");
  }
  if (value.coordinateFrame !== undefined) {
    const frame = validateRuntimeCoordinateFrame(value.coordinateFrame);
    for (const vector of [value.position, value.target] as number[][]) {
      runtimeLocalToWorld({ x: vector[0]!, y: vector[1]!, z: vector[2]! }, frame);
    }
  }
  const distance = Math.hypot(...position.map((item, i) => item - target[i]!));
  requireValue(distance >= 0.0001, path, "Camera position and target must remain distinct in float32.");
  finite(value.verticalFovDegrees, 1, 179, "verticalFovDegrees");
  const near = finite(value.near, 0.0001, 10_000, "near");
  const far = finite(value.far, 0.0001, 10_000_000, "far");
  requireValue(Math.fround(far) > Math.fround(near) && far / near <= 10_000_000, path, "Invalid camera depth range.");
  if (versioned && value.clippingPlane !== undefined) {
    const plane = array(value.clippingPlane, `${path}.clippingPlane`, 4);
    requireValue(plane.length === 4 && plane.every((item): item is number => typeof item === "number" && Number.isFinite(item)
      && Math.abs(item) <= 10_000_000), `${path}.clippingPlane`, "Invalid section plane.");
    const length = Math.hypot(plane[0] as number, plane[1] as number, plane[2] as number);
    requireValue(length > 0.0001 && Math.fround(length) <= 10_000_000, `${path}.clippingPlane`, "Section plane normal must stay nonzero in float32.");
  }
  return value as unknown as RuntimeSceneCamera;
}
