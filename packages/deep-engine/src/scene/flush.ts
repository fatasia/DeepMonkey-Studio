import { evaluateNode, stableTopology } from "./graphHelpers.js";
import { multiplySceneMatrices } from "./math.js";
import type { TransformNode } from "./internals.js";
import type {
  SceneTransformChange,
  SceneTransformFlushResult,
  SceneTransformNodeId,
  SceneWorldBoundsUpdate,
} from "./types.js";

export function flushTransformGraph<TId extends SceneTransformNodeId>(
  nodes: ReadonlyMap<TId, TransformNode<TId>>,
  roots: readonly TId[],
  pendingRemoved: TId[],
  generation: number,
  revision: number,
): SceneTransformFlushResult<TId> {
  const changedIds: TId[] = [];
  const changes: SceneTransformChange<TId>[] = [];
  const boundsUpdates: SceneWorldBoundsUpdate<TId>[] = [];
  const boundsCleared: TId[] = [];
  for (const id of stableTopology(nodes, roots)) {
    const node = nodes.get(id)!;
    if (!node.worldDirty && !node.boundsDirty) continue;
    const previousBounds = node.worldBounds;
    if (node.worldDirty) {
      const parentWorld = node.parent === null ? null : nodes.get(node.parent)!.worldMatrix;
      node.worldMatrix = parentWorld === null ? node.localMatrix : multiplySceneMatrices(parentWorld, node.localMatrix);
    }
    const evaluated = evaluateNode(node, node.worldMatrix);
    node.normalMatrix = evaluated.normalMatrix;
    node.worldBounds = evaluated.worldBounds;
    node.worldDirty = false;
    node.boundsDirty = false;
    changedIds.push(id);
    changes.push(Object.freeze({ id, ...evaluated }));
    if (evaluated.worldBounds !== null) boundsUpdates.push(Object.freeze({ id, bounds: evaluated.worldBounds }));
    else if (previousBounds !== null) boundsCleared.push(id);
  }
  const removed = [...pendingRemoved];
  pendingRemoved.length = 0;
  const nextRevision = changedIds.length > 0 || removed.length > 0 ? revision + 1 : revision;
  return Object.freeze({
    revision: nextRevision,
    generation,
    changedNodeIds: Object.freeze(changedIds),
    changes: Object.freeze(changes),
    worldBoundsUpdates: Object.freeze(boundsUpdates),
    boundsClearedNodeIds: Object.freeze(boundsCleared),
    removedNodeIds: Object.freeze(removed),
  });
}
