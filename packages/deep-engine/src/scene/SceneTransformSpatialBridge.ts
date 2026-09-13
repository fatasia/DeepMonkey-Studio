import { validateSpatialMask } from "../spatial/octreeInternals.js";
import type { SpatialAabb, SpatialItemId } from "../spatial/types.js";
import type { VisibleObjectRegistration } from "../spatial/workingSetTypes.js";
import type { SceneTransformFlushResult } from "./types.js";
import { validateSceneSpatialDelta } from "./spatialSyncValidation.js";
import {
  SceneSpatialSyncError,
  type SceneSpatialSyncResult,
  type SceneSpatialSyncStats,
  type SceneSpatialSyncTarget,
  type SceneTransformRevisionRecord,
} from "./spatialSyncTypes.js";

/** Applies transform flush deltas to CPU culling state without rebuilding the scene index. */
export class SceneTransformSpatialBridge<TId extends SpatialItemId = string> {
  private readonly target: SceneSpatialSyncTarget<TId>;
  private readonly transforms = new Map<TId, SceneTransformRevisionRecord<TId>>();
  private lastSceneRevision = 0;
  private lastSceneGeneration = 0;
  private appliedFlushes = 0;

  constructor(target: SceneSpatialSyncTarget<TId>) {
    if (!target || typeof target !== "object" || (target.kind !== "octree" && target.kind !== "working-set")) {
      throw new SceneSpatialSyncError("invalid-target", "Scene spatial sync target is invalid.");
    }
    const candidate = target.target as unknown as Record<string, unknown>;
    const required = target.kind === "octree"
      ? ["has", "getBounds", "getMask", "upsert", "remove"]
      : ["has", "get", "hasSpatialBounds", "resumeSpatialBounds", "suspendSpatialBounds", "remove"];
    if (!candidate || required.some((name) => typeof candidate[name] !== "function")) {
      throw new SceneSpatialSyncError("invalid-target", `Scene ${target.kind} sync target does not implement the required contract.`);
    }
    this.target = target;
  }

  get stats(): SceneSpatialSyncStats {
    return Object.freeze({ trackedTransforms: this.transforms.size, sceneRevision: this.lastSceneRevision,
      sceneGeneration: this.lastSceneGeneration, appliedFlushes: this.appliedFlushes });
  }

  getTransform(id: TId): SceneTransformRevisionRecord<TId> | undefined {
    return this.transforms.get(id);
  }

  apply(delta: SceneTransformFlushResult<TId>): SceneSpatialSyncResult<TId> {
    const validated = validateSceneSpatialDelta(delta);
    this.assertFresh(validated.revision, validated.generation, validated.changes.length + validated.removed.length);
    const plan = this.planTarget(validated.boundsCleared, validated.removed, validated.boundsUpdates);
    const snapshots = this.capture(plan.allIds);
    let applied: AppliedTargetDelta<TId>;
    try {
      applied = this.applyTarget(plan);
    } catch (cause) {
      try { this.restore(snapshots); } catch { /* preserve the originating target failure */ }
      throw new SceneSpatialSyncError("target-failed", "Scene spatial target rejected a validated atomic delta.", { cause });
    }
    for (const id of validated.removed) this.transforms.delete(id);
    for (const change of validated.changes) this.transforms.set(change.id, change);
    this.lastSceneRevision = validated.revision;
    this.lastSceneGeneration = validated.generation;
    this.appliedFlushes += 1;
    return Object.freeze({
      sceneRevision: validated.revision,
      sceneGeneration: validated.generation,
      targetRevision: targetRevision(this.target),
      spatialTouchedNodeIds: Object.freeze(applied.touched),
      boundsUpsertedNodeIds: Object.freeze(applied.upserted),
      boundsClearedNodeIds: Object.freeze(applied.cleared),
      removedNodeIds: Object.freeze(applied.removed),
      transformUpdates: validated.changes,
    });
  }

  private assertFresh(revision: number, generation: number, operations: number): void {
    if (revision < this.lastSceneRevision || generation < this.lastSceneGeneration
      || (operations > 0 && revision <= this.lastSceneRevision)) {
      throw new SceneSpatialSyncError("stale-delta", "Scene transform delta is stale or has already been applied.");
    }
  }

  private planTarget(
    cleared: readonly TId[],
    removed: readonly TId[],
    updates: readonly { readonly id: TId; readonly bounds: SpatialAabb }[],
  ): TargetPlan<TId> {
    const allIds = unique([...removed, ...cleared, ...updates.map(({ id }) => id)]);
    const target = this.target;
    if (target.kind === "octree") {
      const masks = new Map<TId, number>();
      for (const { id } of updates) {
        try {
          const configured = typeof target.mask === "function" ? target.mask(id) : target.mask;
          masks.set(id, validateSpatialMask(configured ?? target.target.getMask(id) ?? 0xffff_ffff));
        }
        catch (cause) { throw new SceneSpatialSyncError("invalid-target", `Scene spatial mask is invalid for node ${String(id)}.`, { cause }); }
      }
      const removedExisting = unique([...removed, ...cleared]).filter((id) => target.target.has(id)).length;
      const inserted = updates.filter(({ id }) => !target.target.has(id)).length;
      if (target.target.size - removedExisting + inserted > target.target.options.maxEntries) {
        throw new SceneSpatialSyncError("capacity-exceeded", "Scene delta would exceed octree entry capacity.");
      }
      return { allIds, cleared, removed, updates, masks };
    }
    for (const { id } of updates) {
      if (!target.target.has(id)) throw new SceneSpatialSyncError("missing-metadata", `Visible object metadata is missing for scene node ${String(id)}.`);
    }
    const deactivated = unique([...removed, ...cleared]).filter((id) => target.target.hasSpatialBounds(id)).length;
    const resumed = updates.filter(({ id }) => !target.target.hasSpatialBounds(id)).length;
    if (target.target.stats.activeSpatialObjects - deactivated + resumed > target.target.configuration.maxEntries) {
      throw new SceneSpatialSyncError("capacity-exceeded", "Scene delta would exceed visible working-set capacity.");
    }
    return { allIds, cleared, removed, updates, masks: new Map() };
  }

  private applyTarget(plan: TargetPlan<TId>): AppliedTargetDelta<TId> {
    const touched: TId[] = [], removed: TId[] = [], cleared: TId[] = [], upserted: TId[] = [];
    if (this.target.kind === "octree") {
      for (const id of plan.removed) if (this.target.target.remove(id)) { touched.push(id); removed.push(id); }
      for (const id of plan.cleared) if (this.target.target.remove(id)) { touched.push(id); cleared.push(id); }
      for (const update of plan.updates) {
        if (this.target.target.upsert(update.id, update.bounds, { mask: plan.masks.get(update.id)! }) !== "unchanged") touched.push(update.id);
        upserted.push(update.id);
      }
    } else {
      for (const id of plan.removed) if (this.target.target.remove(id)) { touched.push(id); removed.push(id); }
      for (const id of plan.cleared) {
        if (this.target.target.has(id) && this.target.target.suspendSpatialBounds(id)) { touched.push(id); cleared.push(id); }
      }
      for (const update of plan.updates) {
        if (this.target.target.resumeSpatialBounds(update.id, update.bounds)) touched.push(update.id);
        upserted.push(update.id);
      }
    }
    return { touched, removed, cleared, upserted };
  }

  private capture(ids: readonly TId[]): readonly TargetSnapshot<TId>[] {
    const target = this.target;
    if (target.kind === "octree") return ids.map((id) => ({ id, bounds: target.target.getBounds(id), mask: target.target.getMask(id) }));
    return ids.map((id) => ({ id, registration: target.target.get(id), active: target.target.hasSpatialBounds(id) }));
  }

  private restore(snapshots: readonly TargetSnapshot<TId>[]): void {
    if (this.target.kind === "octree") {
      for (const snapshot of snapshots) this.target.target.remove(snapshot.id);
      for (const snapshot of snapshots) if ("bounds" in snapshot && snapshot.bounds) {
        this.target.target.insert(snapshot.id, snapshot.bounds, snapshot.mask === undefined ? {} : { mask: snapshot.mask });
      }
    } else {
      for (const snapshot of snapshots) this.target.target.remove(snapshot.id);
      for (const snapshot of snapshots) if ("registration" in snapshot && snapshot.registration) {
        this.target.target.register(snapshot.registration);
        if (!snapshot.active) this.target.target.suspendSpatialBounds(snapshot.id);
      }
    }
  }
}

interface TargetPlan<TId extends SpatialItemId> {
  readonly allIds: readonly TId[];
  readonly cleared: readonly TId[];
  readonly removed: readonly TId[];
  readonly updates: readonly { readonly id: TId; readonly bounds: SpatialAabb }[];
  readonly masks: ReadonlyMap<TId, number>;
}
interface AppliedTargetDelta<TId> { touched: TId[]; removed: TId[]; cleared: TId[]; upserted: TId[] }
type TargetSnapshot<TId extends SpatialItemId> =
  | { readonly id: TId; readonly bounds: SpatialAabb | undefined; readonly mask: number | undefined }
  | { readonly id: TId; readonly registration: VisibleObjectRegistration<TId> | undefined; readonly active: boolean };

function targetRevision<TId extends SpatialItemId>(target: SceneSpatialSyncTarget<TId>): number {
  return target.kind === "octree" ? target.target.revision : target.target.generation;
}
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
