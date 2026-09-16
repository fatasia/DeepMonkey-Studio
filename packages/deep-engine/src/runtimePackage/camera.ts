import { array, fields, record, requireValue, resourceId, revision, snapshotJson } from "./primitives.js";
import { validateRuntimeCoordinateFrame, runtimeLocalToWorld, type RuntimeCoordinateFrame } from "./coordinates.js";

/** Y-up perspective camera; v2 positions are local to the explicit coordinate frame. */
export interface RuntimeSceneCamera {
  readonly schema: "deep-engine.scene-camera";
  readonly schemaVersion: 1 | 2;
  readonly coordinateFrame?: RuntimeCoordinateFrame;
  readonly id: string;
  readonly revision: number;
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly verticalFovDegrees: number;
  readonly near: number;
  readonly far: number;
}

export function validateRuntimeSceneCamera(input: unknown): RuntimeSceneCamera {
  const path = "$.camera", value = record(snapshotJson(input), path);
  const framed = value.schemaVersion === 2;
  fields(value, ["schema", "schemaVersion", "id", "revision", "position", "target", "verticalFovDegrees", "near", "far", ...(framed ? ["coordinateFrame"] : [])], [], path);
  requireValue(value.schema === "deep-engine.scene-camera" && (value.schemaVersion === 1 || framed), path, "Unsupported scene camera schema.");
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
  if (framed) {
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
  return value as unknown as RuntimeSceneCamera;
}
