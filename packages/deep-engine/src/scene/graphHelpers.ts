import { multiplySceneMatrices, normalMatrixFromWorld, worldAabb } from "./math.js";
import type { TransformNode } from "./internals.js";
import { SceneTransformGraphError, type SceneMatrix4, type SceneTransformNodeId } from "./types.js";

export function stableTopology<TId extends SceneTransformNodeId>(
  nodes: ReadonlyMap<TId, TransformNode<TId>>,
  roots: readonly TId[],
): TId[] {
  const ordered: TId[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = nodes.get(id);
    if (!node) continue;
    ordered.push(id);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  return ordered;
}

export function collectSubtree<TId extends SceneTransformNodeId>(
  nodes: ReadonlyMap<TId, TransformNode<TId>>,
  rootId: TId,
): TId[] {
  const ordered: TId[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = nodes.get(id);
    if (!node) continue;
    ordered.push(id);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  return ordered;
}

export function markWorldDirty<TId extends SceneTransformNodeId>(
  nodes: ReadonlyMap<TId, TransformNode<TId>>,
  rootId: TId,
): void {
  const stack = [rootId];
  while (stack.length > 0) {
    const node = nodes.get(stack.pop()!);
    if (!node) continue;
    node.worldDirty = true;
    for (const child of node.children) stack.push(child);
  }
}

export function shiftSubtreeDepth<TId extends SceneTransformNodeId>(
  nodes: ReadonlyMap<TId, TransformNode<TId>>,
  rootId: TId,
  delta: number,
): void {
  const stack = [rootId];
  while (stack.length > 0) {
    const node = nodes.get(stack.pop()!)!;
    node.depth += delta;
    for (const child of node.children) stack.push(child);
  }
}

export function maxSubtreeDepth<TId extends SceneTransformNodeId>(
  nodes: ReadonlyMap<TId, TransformNode<TId>>,
  rootId: TId,
): number {
  let maximum = nodes.get(rootId)!.depth;
  const stack = [rootId];
  while (stack.length > 0) {
    const node = nodes.get(stack.pop()!)!;
    maximum = Math.max(maximum, node.depth);
    for (const child of node.children) stack.push(child);
  }
  return maximum;
}

export function calculateWorldMatrix<TId extends SceneTransformNodeId>(
  nodes: ReadonlyMap<TId, TransformNode<TId>>,
  id: TId,
): SceneMatrix4 {
  const chain: TransformNode<TId>[] = [];
  let node: TransformNode<TId> | undefined = nodes.get(id);
  while (node) {
    chain.push(node);
    node = node.parent === null ? undefined : nodes.get(node.parent);
  }
  let world = chain.pop()!.localMatrix;
  while (chain.length > 0) world = multiplySceneMatrices(world, chain.pop()!.localMatrix);
  return world;
}

export function evaluateNode<TId extends SceneTransformNodeId>(node: TransformNode<TId>, world: SceneMatrix4) {
  const normalMatrix = normalMatrixFromWorld(world);
  return {
    worldMatrix: world,
    normalMatrix,
    normalMatrixStatus: normalMatrix === null ? "singular" as const : "valid" as const,
    worldBounds: worldAabb(node.localBounds, world),
  };
}

export function assertSubtreeEvaluable<TId extends SceneTransformNodeId>(
  nodes: ReadonlyMap<TId, TransformNode<TId>>,
  rootId: TId,
  rootWorld: SceneMatrix4,
  rootBounds?: TransformNode<TId>["localBounds"],
): void {
  const stack: Array<readonly [TId, SceneMatrix4]> = [[rootId, rootWorld]];
  while (stack.length > 0) {
    const [id, world] = stack.pop()!;
    const node = nodes.get(id)!;
    try {
      worldAabb(id === rootId && rootBounds !== undefined ? rootBounds : node.localBounds, world);
    } catch (error) {
      if (error instanceof SceneTransformGraphError) throw error;
      throw new SceneTransformGraphError("invalid-transform", "Scene world transform exceeds the supported finite coordinate range.");
    }
    for (const childId of node.children) {
      const child = nodes.get(childId)!;
      stack.push([childId, multiplySceneMatrices(world, child.localMatrix)]);
    }
  }
}

export function primeSubtreeWorld<TId extends SceneTransformNodeId>(
  nodes: ReadonlyMap<TId, TransformNode<TId>>,
  rootId: TId,
  rootWorld: SceneMatrix4,
): void {
  const stack: Array<readonly [TId, SceneMatrix4]> = [[rootId, rootWorld]];
  while (stack.length > 0) {
    const [id, world] = stack.pop()!;
    const node = nodes.get(id)!;
    node.worldMatrix = world;
    for (const childId of node.children) {
      const child = nodes.get(childId)!;
      stack.push([childId, multiplySceneMatrices(world, child.localMatrix)]);
    }
  }
}
