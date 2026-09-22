import {
  expectArray,
  expectBoolean,
  expectNumber,
  expectObject,
  expectString,
  expectStringNumberOrBoolean,
  invalid,
  optional,
  required,
  requiredLiteral
} from "./applicationValidationPrimitives.js";

const PREFAB_KINDS = ["conveyor", "robot-arm", "person", "agv", "vehicle", "access-control", "display", "fence", "road", "machine", "utility", "electrical", "sensor", "camera", "storage"] as const;

export function validateIndustrialPrefabInstance(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["definitionId", "definitionVersion"] as const) required(object, key, expectString, path);
  requiredLiteral(object, "kind", PREFAB_KINDS, path);
  required(object, "parameters", validateParameterValues, path);
  requiredLiteral(object, "operatingState", ["idle", "running", "paused", "fault", "maintenance"], path);
  optional(object, "faultCode", expectString, path);
  optional(object, "motionRoute", validateMotionRoute, path);
  optional(object, "mediaSurface", validateMediaSurface, path);
  optional(object, "placementPath", validatePlacementPath, path);
}

function validatePlacementPath(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "points", (entries, entriesPath) =>
    expectArray(entries, entriesPath, validatePlacementPathPoint), path);
  const points = object.points as unknown[];
  if (points.length < 2 || points.length > 512) throw new Error(`${path}.points must contain 2..512 points`);
  const ids = new Set<string>();
  for (const [index, value] of points.entries()) {
    const id = (value as { id?: unknown }).id;
    if (typeof id !== "string" || !id || ids.has(id)) throw new Error(`${path}.points[${index}].id must be nonempty and unique`);
    ids.add(id);
  }
  requiredLiteral(object, "interpolation", ["linear", "catmull-rom"], path);
  required(object, "closed", expectBoolean, path);
  required(object, "snapToGround", expectBoolean, path);
  required(object, "seed", expectNumber, path);
  const seed = object.seed as number;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error(`${path}.seed must be a uint32`);
  }
  optional(object, "maxSlopeAngleDegrees", (value, valuePath) => {
    expectNumber(value, valuePath);
    const degrees = value as number;
    // 范围对齐导航 maxSlopeAngle 的归一化口径（0..89），垂直/倒悬不属于可铺设坡度。
    if (degrees < 0 || degrees > 89) invalid(valuePath, "必须在 0..89 度内");
  }, path);
}

function validatePlacementPathPoint(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "position", (position, positionPath) => {
    const vector = expectObject(position, positionPath);
    for (const axis of ["x", "y", "z"] as const) {
      required(vector, axis, expectNumber, positionPath);
      const coordinate = vector[axis] as number;
      if (!Number.isFinite(coordinate)) throw new Error(`${positionPath}.${axis} must be finite`);
    }
  }, path);
  // I3 道路 junction：路口标记是可选布尔；类型不对的标记在合同层即拒绝，不进几何链路。
  optional(object, "junction", expectBoolean, path);
}

function validateParameterValues(value: unknown, path: string): void {
  const parameters = expectObject(value, path);
  for (const [key, parameter] of Object.entries(parameters)) expectStringNumberOrBoolean(parameter, `${path}.${key}`);
}

function validateMotionRoute(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "enabled", expectBoolean, path);
  optional(object, "autoplay", expectBoolean, path);
  required(object, "points", (points, pointsPath) => expectArray(points, pointsPath, validateRoutePoint), path);
  for (const key of ["speedMps", "accelerationMps2", "startOffsetSeconds"] as const) required(object, key, expectNumber, path);
  requiredLiteral(object, "loopMode", ["once", "loop", "ping-pong"], path);
  required(object, "orientToPath", expectBoolean, path);
  optional(object, "trafficGroup", expectString, path);
}

function validateRoutePoint(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "position", (position, positionPath) => {
    const vector = expectObject(position, positionPath);
    for (const axis of ["x", "y", "z"] as const) required(vector, axis, expectNumber, positionPath);
  }, path);
  optional(object, "waitSeconds", expectNumber, path);
  optional(object, "speedOverrideMps", expectNumber, path);
}

function validateMediaSurface(value: unknown, path: string): void {
  const object = expectObject(value, path);
  requiredLiteral(object, "sourceKind", ["dashboard-page", "image", "video", "hls", "webrtc", "url"], path);
  optional(object, "source", expectString, path);
  for (const key of ["autoplay", "muted", "loop"] as const) required(object, key, expectBoolean, path);
  requiredLiteral(object, "fit", ["contain", "cover", "stretch"], path);
  required(object, "brightness", expectNumber, path);
}
