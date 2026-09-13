import type { SpatialAabb } from "../spatial/types.js";
import { IDENTITY_SCENE_MATRIX } from "./math.js";
import type {
  SceneLocalTransform,
  SceneMatrix4,
  SceneNormalMatrix3,
  SceneTransformNodeId,
} from "./types.js";

export interface TransformNode<TId extends SceneTransformNodeId> {
  readonly id: TId;
  parent: TId | null;
  children: TId[];
  depth: number;
  localTransform: SceneLocalTransform;
  localMatrix: SceneMatrix4;
  localBounds: SpatialAabb | null;
  worldMatrix: SceneMatrix4;
  normalMatrix: SceneNormalMatrix3 | null;
  worldBounds: SpatialAabb | null;
  worldDirty: boolean;
  boundsDirty: boolean;
}

export interface GraphState<TId extends SceneTransformNodeId> {
  readonly nodes: Map<TId, TransformNode<TId>>;
  readonly roots: TId[];
  readonly pendingRemoved: TId[];
  readonly pendingRemovedSet: Set<TId>;
  readonly generation: number;
  readonly revision: number;
}

export function createTransformNode<TId extends SceneTransformNodeId>(
  id: TId,
  parent: TId | null,
  depth: number,
  localTransform: SceneLocalTransform,
  localMatrix: SceneMatrix4,
  localBounds: SpatialAabb | null,
): TransformNode<TId> {
  return {
    id,
    parent,
    children: [],
    depth,
    localTransform,
    localMatrix,
    localBounds,
    worldMatrix: IDENTITY_SCENE_MATRIX,
    normalMatrix: IDENTITY_NORMAL_MATRIX,
    worldBounds: null,
    worldDirty: true,
    boundsDirty: true,
  };
}

export function cloneGraphState<TId extends SceneTransformNodeId>(
  nodes: Map<TId, TransformNode<TId>>,
  roots: TId[],
  pendingRemoved: TId[],
  pendingRemovedSet: Set<TId>,
  generation: number,
  revision: number,
): GraphState<TId> {
  const copies = new Map<TId, TransformNode<TId>>();
  for (const [id, node] of nodes) copies.set(id, { ...node, children: [...node.children] });
  return {
    nodes: copies,
    roots: [...roots],
    pendingRemoved: [...pendingRemoved],
    pendingRemovedSet: new Set(pendingRemovedSet),
    generation,
    revision,
  };
}

export function removeStable<T>(values: T[], value: T): void {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

export function frozenIds<T extends SceneTransformNodeId>(ids: readonly T[]): readonly T[] {
  return Object.freeze([...ids]);
}

const IDENTITY_NORMAL_MATRIX: SceneNormalMatrix3 = Object.freeze([
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
]);
