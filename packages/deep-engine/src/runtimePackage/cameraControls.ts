import { fields, record, requireValue } from "./primitives.js";

export type RuntimeCameraMode = "orbit" | "firstPerson" | "thirdPerson";

/** Author camera behavior frozen into a runtime package. Values use scene units, seconds and degrees. */
export interface RuntimeCameraControls {
  readonly mode: RuntimeCameraMode;
  readonly minDistance: number;
  readonly maxDistance: number;
  readonly minPolarAngleDegrees: number;
  readonly maxPolarAngleDegrees: number;
  readonly collisionEnabled: boolean;
  readonly collisionRadius: number;
  readonly walkSpeed: number;
  readonly flySpeed: number;
  readonly sprintMultiplier: number;
  readonly eyeHeight: number;
  readonly gravity: number;
  readonly jumpSpeed: number;
  readonly stepHeight: number;
  readonly maxSlopeAngleDegrees: number;
}

const KEYS = ["mode", "minDistance", "maxDistance", "minPolarAngleDegrees", "maxPolarAngleDegrees",
  "collisionEnabled", "collisionRadius", "walkSpeed", "flySpeed", "sprintMultiplier", "eyeHeight",
  "gravity", "jumpSpeed", "stepHeight", "maxSlopeAngleDegrees"] as const;

export function validateRuntimeCameraControls(input: unknown, path = "$.camera.controls"): RuntimeCameraControls {
  const value = record(input, path);
  fields(value, KEYS, [], path);
  requireValue(value.mode === "orbit" || value.mode === "firstPerson" || value.mode === "thirdPerson",
    `${path}.mode`, "Unsupported camera navigation mode.");
  requireValue(typeof value.collisionEnabled === "boolean", `${path}.collisionEnabled`, "Expected a boolean.");
  const bounded = (key: Exclude<(typeof KEYS)[number], "mode" | "collisionEnabled">, min: number, max: number) => {
    const item = value[key];
    requireValue(typeof item === "number" && Number.isFinite(item) && item >= min && item <= max,
      `${path}.${key}`, "Camera control number is out of range.");
    return item;
  };
  const minDistance = bounded("minDistance", 0.01, 10_000_000);
  const maxDistance = bounded("maxDistance", 0.02, 10_000_000);
  const minPolarAngleDegrees = bounded("minPolarAngleDegrees", 0, 179);
  const maxPolarAngleDegrees = bounded("maxPolarAngleDegrees", 0.1, 180);
  requireValue(maxDistance > minDistance, path, "Maximum camera distance must exceed the minimum.");
  requireValue(maxPolarAngleDegrees > minPolarAngleDegrees, path,
    "Maximum polar angle must exceed the minimum.");
  bounded("collisionRadius", 0.02, 10_000);
  bounded("walkSpeed", 0.1, 50); bounded("flySpeed", 0.1, 100);
  bounded("sprintMultiplier", 1, 6); bounded("eyeHeight", 0.3, 4);
  bounded("gravity", 0, 80); bounded("jumpSpeed", 0, 30);
  bounded("stepHeight", 0, 1.2); bounded("maxSlopeAngleDegrees", 0, 89);
  return value as unknown as RuntimeCameraControls;
}
