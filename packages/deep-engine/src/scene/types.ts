import type { SpatialAabb, SpatialItemId, SpatialVec3 } from "../spatial/types.js";

export type SceneTransformNodeId = SpatialItemId;
export type SceneQuaternion = readonly [number, number, number, number];
export type SceneMatrix4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];
export type SceneNormalMatrix3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export interface SceneLocalTrs {
  readonly kind: "trs";
  readonly translation: SpatialVec3;
  readonly rotation: SceneQuaternion;
  readonly scale: SpatialVec3;
}

export interface SceneLocalMatrix {
  readonly kind: "matrix";
  readonly matrix: SceneMatrix4;
}

export type SceneLocalTransform = SceneLocalTrs | SceneLocalMatrix;

export interface SceneTransformGraphOptions {
  readonly maxNodes?: number;
  readonly maxDepth?: number;
}

export interface SceneTransformNodeInput<TId extends SceneTransformNodeId> {
  readonly id: TId;
  readonly parent?: TId | null;
  readonly siblingIndex?: number;
  readonly localTransform?: SceneLocalTransform;
  readonly localBounds?: SpatialAabb | null;
}

export interface SceneTransformNodePatch {
  readonly localTransform?: SceneLocalTransform;
  readonly localBounds?: SpatialAabb | null;
  /** 隐藏只影响消费方绘制/拾取过滤,不改世界矩阵;属于权威状态。 */
  readonly hidden?: boolean;
}

export interface SceneReparentOptions {
  readonly siblingIndex?: number;
  readonly keepWorldTransform?: boolean;
}

export type SceneNormalMatrixStatus = "valid" | "singular";

export interface SceneTransformNodeSnapshot<TId extends SceneTransformNodeId> {
  readonly id: TId;
  readonly parent: TId | null;
  readonly children: readonly TId[];
  readonly depth: number;
  readonly localTransform: SceneLocalTransform;
  readonly localMatrix: SceneMatrix4;
  readonly worldMatrix: SceneMatrix4;
  readonly normalMatrix: SceneNormalMatrix3 | null;
  readonly normalMatrixStatus: SceneNormalMatrixStatus;
  readonly localBounds: SpatialAabb | null;
  readonly worldBounds: SpatialAabb | null;
  readonly dirty: boolean;
  readonly hidden: boolean;
  /** 节点最近一次状态变更所在的全局 revision;0 表示创建后从未变更。 */
  readonly lastChangedRevision: number;
}

export interface SceneTransformChange<TId extends SceneTransformNodeId> {
  readonly id: TId;
  readonly worldMatrix: SceneMatrix4;
  readonly normalMatrix: SceneNormalMatrix3 | null;
  readonly normalMatrixStatus: SceneNormalMatrixStatus;
  readonly worldBounds: SpatialAabb | null;
}

export interface SceneWorldBoundsUpdate<TId extends SceneTransformNodeId> {
  readonly id: TId;
  readonly bounds: SpatialAabb;
}

export interface SceneTransformFlushResult<TId extends SceneTransformNodeId> {
  readonly revision: number;
  readonly generation: number;
  readonly changedNodeIds: readonly TId[];
  readonly changes: readonly SceneTransformChange<TId>[];
  readonly worldBoundsUpdates: readonly SceneWorldBoundsUpdate<TId>[];
  readonly boundsClearedNodeIds: readonly TId[];
  readonly removedNodeIds: readonly TId[];
}

export interface SceneTransformGraphStats {
  readonly nodes: number;
  readonly roots: number;
  readonly dirtyNodes: number;
  readonly pendingRemovedNodes: number;
  readonly generation: number;
  readonly revision: number;
}

export type SceneTransformGraphErrorCode =
  | "capacity-exceeded"
  | "cycle"
  | "depth-exceeded"
  | "duplicate-id"
  | "invalid-bounds"
  | "invalid-id"
  | "invalid-index"
  | "invalid-options"
  | "invalid-transform"
  | "missing-node"
  | "missing-parent"
  | "non-invertible-parent"
  | "transaction-active";

export class SceneTransformGraphError extends Error {
  readonly code: SceneTransformGraphErrorCode;

  constructor(code: SceneTransformGraphErrorCode, message: string) {
    super(message);
    this.name = "SceneTransformGraphError";
    this.code = code;
  }
}
