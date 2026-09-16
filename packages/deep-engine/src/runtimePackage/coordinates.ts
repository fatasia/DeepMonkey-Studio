import { fields, record, requireValue, snapshotJson } from "./primitives.js";

export interface RuntimeCoordinate { readonly x: number; readonly y: number; readonly z: number }
export const RUNTIME_COORDINATE_PROFILE = Object.freeze({ id: "scene-local-coordinates-v1", unit: "scene-unit",
  originGrid: 1000, maxRoundTripError: 0.000001, maxFloat32CoordinateError: 0.001 } as const);
export interface RuntimeCoordinateFrame {
  readonly schemaVersion: 1;
  readonly profile: typeof RUNTIME_COORDINATE_PROFILE;
  readonly origin: RuntimeCoordinate;
}

/** 坐标帧参与相机资源 hash；未知容差不能由包自行放宽。 */
export function validateRuntimeCoordinateFrame(input: unknown): RuntimeCoordinateFrame {
  const path = "$.camera.coordinateFrame", value = record(snapshotJson(input), path);
  fields(value, ["schemaVersion", "profile", "origin"], [], path);
  requireValue(value.schemaVersion === 1, path, "Unsupported coordinate frame schema.");
  const profile = record(value.profile, `${path}.profile`);
  fields(profile, Object.keys(RUNTIME_COORDINATE_PROFILE), [], `${path}.profile`);
  for (const [key, expected] of Object.entries(RUNTIME_COORDINATE_PROFILE)) {
    requireValue(profile[key] === expected, `${path}.profile.${key}`, "Unsupported coordinate precision profile.");
  }
  const origin = record(value.origin, `${path}.origin`);
  fields(origin, ["x", "y", "z"], [], `${path}.origin`);
  for (const axis of ["x", "y", "z"] as const) {
    const coordinate = origin[axis];
    requireValue(typeof coordinate === "number" && Number.isFinite(coordinate)
      && coordinate % RUNTIME_COORDINATE_PROFILE.originGrid === 0, `${path}.origin.${axis}`, "Invalid coordinate origin grid.");
  }
  return value as unknown as RuntimeCoordinateFrame;
}

export function runtimeWorldToLocal(world: RuntimeCoordinate, frame: RuntimeCoordinateFrame): RuntimeCoordinate {
  return transformCoordinate(world, frame, -1);
}
export function runtimeLocalToWorld(local: RuntimeCoordinate, frame: RuntimeCoordinateFrame): RuntimeCoordinate {
  return transformCoordinate(local, frame, 1);
}
function transformCoordinate(input: RuntimeCoordinate, frame: RuntimeCoordinateFrame, direction: 1 | -1): RuntimeCoordinate {
  const value = { x: 0, y: 0, z: 0 };
  for (const axis of ["x", "y", "z"] as const) {
    const source = input[axis], origin = frame.origin[axis], result = source + direction * origin;
    const local = direction === 1 ? source : result;
    if (![source, origin, result, Math.fround(local)].every(Number.isFinite)
      || Math.abs(Math.fround(local) - local) > RUNTIME_COORDINATE_PROFILE.maxFloat32CoordinateError
      || Math.abs(result - direction * origin - source) > RUNTIME_COORDINATE_PROFILE.maxRoundTripError) {
      throw new Error(`Coordinate ${axis} exceeds the fixed local precision budget.`);
    }
    value[axis] = Object.is(result, -0) ? 0 : result;
  }
  return value;
}
