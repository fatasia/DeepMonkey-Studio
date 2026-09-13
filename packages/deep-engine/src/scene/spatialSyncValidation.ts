import { sameAabb, validateSpatialAabb } from "../spatial/bounds.js";
import { validateSpatialId } from "../spatial/octreeInternals.js";
import type { SpatialAabb } from "../spatial/types.js";
import type { SceneMatrix4, SceneNormalMatrix3, SceneTransformFlushResult, SceneTransformNodeId } from "./types.js";
import {
  SceneSpatialSyncError,
  type SceneTransformRevisionRecord,
} from "./spatialSyncTypes.js";

export interface ValidatedSceneSpatialDelta<TId extends SceneTransformNodeId> {
  readonly revision: number;
  readonly generation: number;
  readonly changes: readonly SceneTransformRevisionRecord<TId>[];
  readonly boundsUpdates: readonly { readonly id: TId; readonly bounds: SpatialAabb }[];
  readonly boundsCleared: readonly TId[];
  readonly removed: readonly TId[];
}

export function validateSceneSpatialDelta<TId extends SceneTransformNodeId>(
  delta: SceneTransformFlushResult<TId>,
): ValidatedSceneSpatialDelta<TId> {
  if (!delta || typeof delta !== "object") throw invalid("Scene transform delta must be an object.");
  const revision = counter(delta.revision, "revision");
  const generation = counter(delta.generation, "generation");
  const changedIds = ids(delta.changedNodeIds, "changedNodeIds");
  if (!Array.isArray(delta.changes) || delta.changes.length !== changedIds.length) {
    throw invalid("Scene transform changes must align with changedNodeIds.");
  }
  const changes: SceneTransformRevisionRecord<TId>[] = delta.changes.map((change, index) => {
    if (!change || typeof change !== "object" || change.id !== changedIds[index]) {
      throw invalid("Scene transform changes must preserve changedNodeIds order.");
    }
    const worldMatrix = matrix(change.worldMatrix, 16, "worldMatrix") as unknown as SceneMatrix4;
    if (worldMatrix[3] !== 0 || worldMatrix[7] !== 0 || worldMatrix[11] !== 0 || worldMatrix[15] !== 1) {
      throw invalid("Scene world matrices must be affine column-major matrices.");
    }
    const status = change.normalMatrixStatus;
    if (status !== "valid" && status !== "singular") throw invalid("Scene normal matrix status is invalid.");
    const normalMatrix = change.normalMatrix === null ? null : matrix(change.normalMatrix, 9, "normalMatrix") as unknown as SceneNormalMatrix3;
    if ((status === "valid") !== (normalMatrix !== null)) throw invalid("Scene normal matrix and status disagree.");
    const worldBounds = change.worldBounds === null ? null : bounds(change.worldBounds);
    return Object.freeze({ id: change.id, sceneRevision: revision, sceneGeneration: generation,
      worldMatrix, normalMatrix, normalMatrixStatus: status, worldBounds });
  });
  const boundsUpdates = validateBoundsUpdates(delta.worldBoundsUpdates);
  const boundsCleared = ids(delta.boundsClearedNodeIds, "boundsClearedNodeIds");
  const removed = ids(delta.removedNodeIds, "removedNodeIds");
  assertDisjoint(changedIds, removed, "changed and removed node ids");
  assertDisjoint(boundsCleared, removed, "bounds-cleared and removed node ids");
  assertDisjoint(boundsUpdates.map(({ id }) => id), boundsCleared, "bounds-updated and bounds-cleared node ids");
  const changesById = new Map(changes.map((change) => [change.id, change]));
  const updatesById = new Map(boundsUpdates.map((update) => [update.id, update]));
  for (const change of changes) {
    const update = updatesById.get(change.id);
    if ((change.worldBounds === null) !== (update === undefined)
      || (update && change.worldBounds && !sameAabb(update.bounds, change.worldBounds))) {
      throw invalid("World bounds updates must exactly match changed nodes with bounds.");
    }
  }
  for (const id of boundsCleared) {
    if (changesById.get(id)?.worldBounds !== null) throw invalid("Cleared bounds must reference a changed node with null bounds.");
  }
  return Object.freeze({ revision, generation, changes: Object.freeze(changes), boundsUpdates,
    boundsCleared, removed });
}

function validateBoundsUpdates<TId extends SceneTransformNodeId>(value: SceneTransformFlushResult<TId>["worldBoundsUpdates"]) {
  if (!Array.isArray(value)) throw invalid("worldBoundsUpdates must be an array.");
  const seen = new Set<TId>();
  return Object.freeze(value.map((update) => {
    if (!update || typeof update !== "object") throw invalid("World bounds update is invalid.");
    try { validateSpatialId(update.id); } catch { throw invalid("World bounds update contains an invalid id."); }
    if (seen.has(update.id)) throw invalid("World bounds update ids must be unique.");
    seen.add(update.id);
    return Object.freeze({ id: update.id, bounds: bounds(update.bounds) });
  }));
}

function ids<TId extends SceneTransformNodeId>(value: readonly TId[], label: string): readonly TId[] {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array.`);
  const seen = new Set<TId>();
  const copy = value.map((id) => {
    try { validateSpatialId(id); } catch { throw invalid(`${label} contains an invalid id.`); }
    if (seen.has(id)) throw invalid(`${label} contains a duplicate id.`);
    seen.add(id);
    return id;
  });
  return Object.freeze(copy);
}

function matrix(value: ArrayLike<number>, length: number, label: string): readonly number[] {
  if (!Array.isArray(value) || value.length !== length || value.some((component) => !Number.isFinite(component))) {
    throw invalid(`${label} must contain ${length} finite numbers.`);
  }
  return Object.freeze([...value]);
}

function bounds(value: SpatialAabb): SpatialAabb {
  try { return validateSpatialAabb(value, { label: "Scene sync world bounds" }); }
  catch { throw invalid("Scene sync world bounds are invalid."); }
}

function counter(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`Scene ${label} must be a non-negative safe integer.`);
  return value;
}

function assertDisjoint<TId>(left: readonly TId[], right: readonly TId[], label: string): void {
  const values = new Set(left);
  if (right.some((id) => values.has(id))) throw invalid(`Scene delta has overlapping ${label}.`);
}

function invalid(message: string): SceneSpatialSyncError {
  return new SceneSpatialSyncError("invalid-delta", message);
}
