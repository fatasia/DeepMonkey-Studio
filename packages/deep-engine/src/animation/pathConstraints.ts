import type { SpatialItemId, SpatialVec3 } from "../spatial/types.js";
import { AnimationError } from "./types.js";

export type AnimationPathDriver<TNodeId extends SpatialItemId = string> =
  | { readonly kind: "linear"; readonly nodeId: TNodeId; readonly from: SpatialVec3; readonly to: SpatialVec3; readonly durationSeconds: number; }
  | { readonly kind: "polyline"; readonly nodeId: TNodeId; readonly points: readonly SpatialVec3[]; readonly durationSeconds: number; readonly loop?: boolean; };

export interface AnimationConstraint<TNodeId extends SpatialItemId = string> {
  readonly nodeId: TNodeId;
  readonly kind: "look-at" | "distance";
  readonly target: SpatialVec3;
  readonly axis?: "x" | "y" | "z";
  readonly minDistance?: number;
  readonly maxDistance?: number;
}

export interface AnimationPathSample {
  readonly nodeId: SpatialItemId;
  readonly position: SpatialVec3;
  readonly normalizedTime: number;
}

export interface AnimationConstraintResult {
  readonly position: SpatialVec3;
  readonly constrained: boolean;
  readonly distance: number;
}

/** Pure path sampling; state machine callers can feed the returned normalized time to clips. */
export function sampleAnimationPath<TNodeId extends SpatialItemId>(driver: AnimationPathDriver<TNodeId>, elapsedSeconds: number): AnimationPathSample {
  validateElapsed(elapsedSeconds);
  if (driver.kind === "linear") {
    validateDuration(driver.durationSeconds);
    const normalizedTime = normalized(elapsedSeconds, driver.durationSeconds, false);
    return Object.freeze({ nodeId: driver.nodeId, normalizedTime, position: lerp3(driver.from, driver.to, normalizedTime) });
  }
  validateDuration(driver.durationSeconds);
  if (!Array.isArray(driver.points) || driver.points.length < 2) throw new AnimationError("invalid-layer", "Polyline path requires at least two points.");
  const normalizedTime = normalized(elapsedSeconds, driver.durationSeconds, driver.loop === true);
  const segments = driver.points.length - 1;
  const scaled = normalizedTime * segments;
  const index = Math.min(Math.floor(scaled), segments - 1);
  const local = scaled - index;
  const from = driver.points[index]!;
  const to = driver.points[index + 1]!;
  return Object.freeze({ nodeId: driver.nodeId, normalizedTime, position: lerp3(from, to, local) });
}

/** Constraint hook kept pure and deterministic; transform writers remain in the scene graph layer. */
export function applyAnimationConstraint(constraint: AnimationConstraint, position: SpatialVec3): AnimationConstraintResult {
  if (!constraint || typeof constraint !== "object") throw new AnimationError("invalid-layer", "Animation constraint must be an object.");
  if (!Array.isArray(position) || position.length !== 3 || position.some((value) => !Number.isFinite(value))) throw new AnimationError("invalid-layer", "Animation constraint position is invalid.");
  const distance = Math.hypot(position[0]!, position[1]!, position[2]!);
  if (constraint.kind === "look-at") return Object.freeze({ position: tuple3(position[0]!, position[1]!, position[2]!), constrained: false, distance });
  const min = constraint.minDistance ?? 0;
  const max = constraint.maxDistance ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(min) || min < 0 || min > max || Number.isNaN(max)) throw new AnimationError("invalid-layer", "Animation distance constraint bounds are invalid.");
  if (distance === 0) return Object.freeze({ position: tuple3(min, 0, 0), constrained: min > 0, distance: min });
  const targetDistance = Math.min(Math.max(distance, min), max);
  const scale = targetDistance / distance;
  return Object.freeze({ position: tuple3(position[0]! * scale, position[1]! * scale, position[2]! * scale), constrained: targetDistance !== distance, distance: targetDistance });
}

function tuple3(x: number, y: number, z: number): SpatialVec3 { return Object.freeze([x, y, z]); }
function normalized(elapsed: number, duration: number, loop: boolean): number {
  if (duration === 0) return 1;
  if (loop) return ((elapsed % duration) + duration) % duration / duration;
  return Math.min(1, Math.max(0, elapsed / duration));
}
function lerp3(from: SpatialVec3, to: SpatialVec3, amount: number): SpatialVec3 {
  return Object.freeze([from[0]! + (to[0]! - from[0]!) * amount, from[1]! + (to[1]! - from[1]!) * amount, from[2]! + (to[2]! - from[2]!) * amount]);
}
function validateElapsed(value: number): void { if (!Number.isFinite(value) || Math.abs(value) > 1e15) throw new AnimationError("invalid-time", "Animation path elapsed time is invalid."); }
function validateDuration(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1e9) throw new AnimationError("invalid-time", "Animation path duration is invalid."); }
