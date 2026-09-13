import { validateSpatialAabb } from "../spatial/bounds.js";
import type { SpatialAabb, SpatialItemId, SpatialVec3 } from "../spatial/types.js";
import {
  SceneTransformGraphError,
  type SceneLocalTransform,
  type SceneMatrix4,
  type SceneQuaternion,
  type SceneTransformGraphOptions,
  type SceneTransformNodeId,
} from "./types.js";

const MAX_COMPONENT = 1e15;

export const DEEP_SCENE_TRANSFORM_LIMITS = Object.freeze({
  defaultMaxNodes: 250_000,
  hardMaxNodes: 1_000_000,
  defaultMaxDepth: 4_096,
  hardMaxDepth: 65_536,
});

export interface ResolvedSceneTransformGraphOptions {
  readonly maxNodes: number;
  readonly maxDepth: number;
}

export const IDENTITY_LOCAL_TRANSFORM: SceneLocalTransform = Object.freeze({
  kind: "trs",
  translation: Object.freeze([0, 0, 0]) as SpatialVec3,
  rotation: Object.freeze([0, 0, 0, 1]) as SceneQuaternion,
  scale: Object.freeze([1, 1, 1]) as SpatialVec3,
});

export function resolveGraphOptions(options: SceneTransformGraphOptions): ResolvedSceneTransformGraphOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new SceneTransformGraphError("invalid-options", "Scene transform graph options must be an object.");
  }
  return Object.freeze({
    maxNodes: limit(options.maxNodes, DEEP_SCENE_TRANSFORM_LIMITS.defaultMaxNodes, 1, DEEP_SCENE_TRANSFORM_LIMITS.hardMaxNodes, "maxNodes"),
    maxDepth: limit(options.maxDepth, DEEP_SCENE_TRANSFORM_LIMITS.defaultMaxDepth, 0, DEEP_SCENE_TRANSFORM_LIMITS.hardMaxDepth, "maxDepth"),
  });
}

export function validateNodeId<TId extends SceneTransformNodeId>(id: TId): TId {
  if ((typeof id === "string" && id.length > 0) || (typeof id === "number" && Number.isSafeInteger(id))) return id;
  throw new SceneTransformGraphError("invalid-id", "Scene node id must be a non-empty string or safe integer.");
}

export function validateLocalTransform(value: SceneLocalTransform | undefined): SceneLocalTransform {
  if (value === undefined) return IDENTITY_LOCAL_TRANSFORM;
  if (!value || typeof value !== "object") throw invalidTransform();
  if (value.kind === "trs") {
    const translation = vector(value.translation, "translation");
    const scale = vector(value.scale, "scale");
    const rotation = quaternion(value.rotation);
    return Object.freeze({ kind: "trs", translation, rotation, scale });
  }
  if (value.kind === "matrix") return Object.freeze({ kind: "matrix", matrix: matrix(value.matrix) });
  throw invalidTransform();
}

export function validateLocalBounds(value: SpatialAabb | null | undefined): SpatialAabb | null {
  if (value === undefined || value === null) return null;
  try {
    return validateSpatialAabb(value, { label: "Scene node local bounds" });
  } catch {
    throw new SceneTransformGraphError("invalid-bounds", "Scene node local bounds must be a finite ordered AABB.");
  }
}

export function validateSiblingIndex(index: number | undefined, length: number): number {
  if (index === undefined) return length;
  if (!Number.isSafeInteger(index) || index < 0 || index > length) {
    throw new SceneTransformGraphError("invalid-index", `Sibling index must be an integer between 0 and ${length}.`);
  }
  return index;
}

export function sameLocalTransform(left: SceneLocalTransform, right: SceneLocalTransform): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "matrix" && right.kind === "matrix") return sameArray(left.matrix, right.matrix);
  return left.kind === "trs" && right.kind === "trs"
    && sameArray(left.translation, right.translation)
    && sameArray(left.rotation, right.rotation)
    && sameArray(left.scale, right.scale);
}

function limit(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new SceneTransformGraphError("invalid-options", `${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return resolved;
}

function vector(value: SpatialVec3, name: string): SpatialVec3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some(invalidComponent)) {
    throw new SceneTransformGraphError("invalid-transform", `TRS ${name} must contain three supported finite numbers.`);
  }
  return Object.freeze([...value]) as unknown as SpatialVec3;
}

function quaternion(value: SceneQuaternion): SceneQuaternion {
  if (!Array.isArray(value) || value.length !== 4 || value.some(invalidComponent)) {
    throw new SceneTransformGraphError("invalid-transform", "TRS rotation must contain four supported finite numbers.");
  }
  const length = Math.hypot(...value);
  if (length <= Number.EPSILON) throw new SceneTransformGraphError("invalid-transform", "TRS rotation quaternion must be non-zero.");
  return Object.freeze(value.map((component) => component / length)) as unknown as SceneQuaternion;
}

function matrix(value: SceneMatrix4): SceneMatrix4 {
  if (!Array.isArray(value) || value.length !== 16 || value.some(invalidComponent)
    || value[3] !== 0 || value[7] !== 0 || value[11] !== 0 || value[15] !== 1) {
    throw new SceneTransformGraphError("invalid-transform", "Local matrix must be a finite column-major affine matrix.");
  }
  return Object.freeze([...value]) as unknown as SceneMatrix4;
}

function invalidComponent(value: number): boolean {
  return typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_COMPONENT;
}

function sameArray(left: readonly number[], right: readonly number[]): boolean {
  return left.every((value, index) => value === right[index]);
}

function invalidTransform(): SceneTransformGraphError {
  return new SceneTransformGraphError("invalid-transform", "Local transform must be a TRS or affine matrix value.");
}
