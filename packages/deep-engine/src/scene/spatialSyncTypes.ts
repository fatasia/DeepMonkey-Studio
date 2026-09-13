import type { CpuVisibleWorkingSet } from "../spatial/visibleWorkingSet.js";
import type { LooseOctreeIndex } from "../spatial/looseOctree.js";
import type { SpatialAabb, SpatialItemId } from "../spatial/types.js";
import type {
  SceneMatrix4,
  SceneNormalMatrix3,
  SceneNormalMatrixStatus,
  SceneTransformNodeId,
} from "./types.js";

export type SceneSpatialSyncTarget<TId extends SpatialItemId> =
  | {
    readonly kind: "octree";
    readonly target: LooseOctreeIndex<TId>;
    readonly mask?: number | ((id: TId) => number);
  }
  | {
    readonly kind: "working-set";
    readonly target: CpuVisibleWorkingSet<TId>;
  };

export interface SceneTransformRevisionRecord<TId extends SceneTransformNodeId> {
  readonly id: TId;
  readonly sceneRevision: number;
  readonly sceneGeneration: number;
  readonly worldMatrix: SceneMatrix4;
  readonly normalMatrix: SceneNormalMatrix3 | null;
  readonly normalMatrixStatus: SceneNormalMatrixStatus;
  readonly worldBounds: SpatialAabb | null;
}

export interface SceneSpatialSyncResult<TId extends SceneTransformNodeId> {
  readonly sceneRevision: number;
  readonly sceneGeneration: number;
  readonly targetRevision: number;
  readonly spatialTouchedNodeIds: readonly TId[];
  readonly boundsUpsertedNodeIds: readonly TId[];
  readonly boundsClearedNodeIds: readonly TId[];
  readonly removedNodeIds: readonly TId[];
  readonly transformUpdates: readonly SceneTransformRevisionRecord<TId>[];
}

export interface SceneSpatialSyncStats {
  readonly trackedTransforms: number;
  readonly sceneRevision: number;
  readonly sceneGeneration: number;
  readonly appliedFlushes: number;
}

export type SceneSpatialSyncErrorCode =
  | "capacity-exceeded"
  | "invalid-delta"
  | "invalid-target"
  | "missing-metadata"
  | "stale-delta"
  | "target-failed";

export class SceneSpatialSyncError extends Error {
  readonly code: SceneSpatialSyncErrorCode;

  constructor(code: SceneSpatialSyncErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SceneSpatialSyncError";
    this.code = code;
  }
}
