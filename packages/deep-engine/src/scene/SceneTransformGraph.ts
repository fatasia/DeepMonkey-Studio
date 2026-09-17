import { sameAabb } from "../spatial/bounds.js";
import {
  assertSubtreeEvaluable,
  collectSubtree,
  evaluateNode,
  markWorldDirty,
  maxSubtreeDepth,
  primeSubtreeWorld,
  shiftSubtreeDepth,
} from "./graphHelpers.js";
import { flushTransformGraph } from "./flush.js";
import { cloneGraphState, createTransformNode, frozenIds, removeStable, type GraphState, type TransformNode } from "./internals.js";
import { invertAffineSceneMatrix, localTransformMatrix, multiplySceneMatrices, sameMatrix } from "./math.js";
import {
  SceneTransformGraphError,
  type SceneLocalTransform,
  type SceneReparentOptions,
  type SceneTransformFlushResult,
  type SceneTransformGraphOptions,
  type SceneTransformGraphStats,
  type SceneTransformNodeId,
  type SceneTransformNodeInput,
  type SceneTransformNodePatch,
  type SceneTransformNodeSnapshot,
} from "./types.js";
import {
  resolveGraphOptions,
  sameLocalTransform,
  validateLocalBounds,
  validateLocalTransform,
  validateNodeId,
  validateSiblingIndex,
  type ResolvedSceneTransformGraphOptions,
} from "./validation.js";

/** Platform-neutral hierarchy with deterministic, incremental transform evaluation. */
export class SceneTransformGraph<TId extends SceneTransformNodeId = string> {
  readonly options: Readonly<ResolvedSceneTransformGraphOptions>;
  private readonly nodes = new Map<TId, TransformNode<TId>>();
  private readonly roots: TId[] = [];
  private readonly pendingRemoved: TId[] = [];
  private readonly pendingRemovedSet = new Set<TId>();
  private stateGeneration = 0;
  private stateRevision = 0;
  private transactionActive = false;
  private transactionMutated = false;

  constructor(options: SceneTransformGraphOptions = {}) {
    this.options = resolveGraphOptions(options);
  }

  get size(): number { return this.nodes.size; }
  get generation(): number { return this.stateGeneration; }
  get revision(): number { return this.stateRevision; }
  get rootIds(): readonly TId[] { return frozenIds(this.roots); }
  get stats(): SceneTransformGraphStats {
    let dirtyNodes = 0;
    for (const node of this.nodes.values()) if (node.worldDirty || node.boundsDirty) dirtyNodes += 1;
    return Object.freeze({
      nodes: this.nodes.size,
      roots: this.roots.length,
      dirtyNodes,
      pendingRemovedNodes: this.pendingRemoved.length,
      generation: this.stateGeneration,
      revision: this.stateRevision,
    });
  }

  has(id: TId): boolean { return this.nodes.has(id); }

  getNode(id: TId): SceneTransformNodeSnapshot<TId> | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    const evaluated = evaluateNode(node, node.worldMatrix);
    return Object.freeze({
      id: node.id,
      parent: node.parent,
      children: frozenIds(node.children),
      depth: node.depth,
      localTransform: node.localTransform,
      localMatrix: node.localMatrix,
      ...evaluated,
      localBounds: node.localBounds,
      dirty: node.worldDirty || node.boundsDirty,
      hidden: node.hidden,
      lastChangedRevision: node.lastChangedRevision,
    });
  }

  create(input: SceneTransformNodeInput<TId>): void {
    if (!input || typeof input !== "object") throw new SceneTransformGraphError("invalid-id", "Scene node input must be an object.");
    const id = validateNodeId(input.id);
    if (this.nodes.has(id) || this.pendingRemovedSet.has(id)) {
      throw new SceneTransformGraphError("duplicate-id", `Scene node already exists or awaits removal flush: ${String(id)}.`);
    }
    if (this.nodes.size >= this.options.maxNodes) {
      throw new SceneTransformGraphError("capacity-exceeded", `Scene node capacity ${this.options.maxNodes} was exceeded.`);
    }
    const parentId = input.parent ?? null;
    const parent = parentId === null ? null : (this.nodes.get(validateNodeId(parentId)) ?? null);
    if (parentId !== null && !parent) throw new SceneTransformGraphError("missing-parent", `Scene parent does not exist: ${String(parentId)}.`);
    const depth = parent === null ? 0 : parent.depth + 1;
    if (depth > this.options.maxDepth) throw new SceneTransformGraphError("depth-exceeded", `Scene depth ${depth} exceeds ${this.options.maxDepth}.`);
    const siblings = parent === null ? this.roots : parent.children;
    const siblingIndex = validateSiblingIndex(input.siblingIndex, siblings.length);
    const localTransform = validateLocalTransform(input.localTransform);
    const localBounds = validateLocalBounds(input.localBounds);
    const node = createTransformNode(id, parentId, depth, localTransform, localTransformMatrix(localTransform), localBounds);
    const proposedWorld = parent === null ? node.localMatrix : multiplySceneMatrices(parent.worldMatrix, node.localMatrix);
    // A temporary singleton map reuses the same validation path without exposing partial state.
    assertSubtreeEvaluable(new Map([[id, node]]), id, proposedWorld);
    this.nodes.set(id, node);
    node.worldMatrix = proposedWorld;
    siblings.splice(siblingIndex, 0, id);
    this.didMutate();
  }

  update(id: TId, patch: SceneTransformNodePatch): void {
    const node = this.requireNode(id);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new SceneTransformGraphError("invalid-transform", "Scene node patch must be an object.");
    const changesTransform = Object.prototype.hasOwnProperty.call(patch, "localTransform");
    const changesBounds = Object.prototype.hasOwnProperty.call(patch, "localBounds");
    const changesHidden = Object.prototype.hasOwnProperty.call(patch, "hidden");
    if (changesHidden && typeof patch.hidden !== "boolean") throw new SceneTransformGraphError("invalid-transform", "hidden must be a boolean when provided.");
    if (changesTransform && patch.localTransform === undefined) throw new SceneTransformGraphError("invalid-transform", "localTransform cannot be undefined.");
    if (changesBounds && patch.localBounds === undefined) throw new SceneTransformGraphError("invalid-bounds", "localBounds cannot be undefined.");
    const nextTransform = changesTransform ? validateLocalTransform(patch.localTransform) : node.localTransform;
    const nextBounds = changesBounds ? validateLocalBounds(patch.localBounds) : node.localBounds;
    const transformChanged = !sameLocalTransform(node.localTransform, nextTransform);
    const boundsChanged = !sameNullableBounds(node.localBounds, nextBounds);
    const hiddenChanged = changesHidden && node.hidden !== patch.hidden;
    if (!transformChanged && !boundsChanged && !hiddenChanged) return;
    const currentWorld = node.worldMatrix;
    const proposedWorld = transformChanged
      ? (node.parent === null ? localTransformMatrix(nextTransform) : multiplySceneMatrices(this.nodes.get(node.parent)!.worldMatrix, localTransformMatrix(nextTransform)))
      : currentWorld;
    assertSubtreeEvaluable(this.nodes, id, proposedWorld, nextBounds);
    if (transformChanged) {
      node.localTransform = nextTransform;
      node.localMatrix = localTransformMatrix(nextTransform);
      markWorldDirty(this.nodes, id);
      primeSubtreeWorld(this.nodes, id, proposedWorld);
    }
    if (boundsChanged) {
      node.localBounds = nextBounds;
      node.boundsDirty = true;
    }
    if (hiddenChanged) {
      node.hidden = patch.hidden as boolean;
      // Visibility is authoritative state too. Surface it through the same flush/revision
      // channel so CAS advances and renderer projections can re-read this node.
      node.worldDirty = true;
    }
    node.lastChangedRevision = this.stateRevision;
    this.didMutate();
  }

  reparent(id: TId, nextParentId: TId | null, options: SceneReparentOptions = {}): void {
    const node = this.requireNode(id);
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new SceneTransformGraphError("invalid-options", "Reparent options must be an object.");
    if (options.keepWorldTransform !== undefined && typeof options.keepWorldTransform !== "boolean") throw new SceneTransformGraphError("invalid-options", "keepWorldTransform must be boolean.");
    const nextParent = nextParentId === null ? null : (this.nodes.get(validateNodeId(nextParentId)) ?? null);
    if (nextParentId !== null && !nextParent) throw new SceneTransformGraphError("missing-parent", `Scene parent does not exist: ${String(nextParentId)}.`);
    this.assertNoCycle(id, nextParent);
    const nextSiblings = (nextParent === null ? this.roots : nextParent.children).filter((candidate) => candidate !== id);
    const targetIndex = options.siblingIndex === undefined
      ? (node.parent === nextParentId ? currentIndex(node, this.nodes, this.roots) : nextSiblings.length)
      : validateSiblingIndex(options.siblingIndex, nextSiblings.length);
    const boundedIndex = Math.min(targetIndex, nextSiblings.length);
    const nextDepth = nextParent === null ? 0 : nextParent.depth + 1;
    const relativeHeight = maxSubtreeDepth(this.nodes, id) - node.depth;
    if (nextDepth + relativeHeight > this.options.maxDepth) throw new SceneTransformGraphError("depth-exceeded", `Reparent would exceed scene depth ${this.options.maxDepth}.`);
    let nextLocal: SceneLocalTransform | null = null;
    if (options.keepWorldTransform && node.parent !== nextParentId) {
      const oldWorld = node.worldMatrix;
      if (nextParent === null) nextLocal = Object.freeze({ kind: "matrix", matrix: oldWorld });
      else {
        const inverseParent = invertAffineSceneMatrix(nextParent.worldMatrix);
        if (!inverseParent) throw new SceneTransformGraphError("non-invertible-parent", "Cannot preserve world transform under a singular parent.");
        nextLocal = Object.freeze({ kind: "matrix", matrix: multiplySceneMatrices(inverseParent, oldWorld) });
      }
    }
    const oldSiblings = node.parent === null ? this.roots : this.nodes.get(node.parent)!.children;
    const parentChanged = node.parent !== nextParentId;
    const orderChanged = parentChanged || oldSiblings.indexOf(id) !== boundedIndex;
    const localChanged = nextLocal !== null && !sameMatrix(node.localMatrix, nextLocal.matrix);
    if (!orderChanged && !localChanged) return;
    const proposedLocalMatrix = nextLocal?.matrix ?? node.localMatrix;
    const proposedWorld = nextParent === null
      ? proposedLocalMatrix
      : multiplySceneMatrices(nextParent.worldMatrix, proposedLocalMatrix);
    assertSubtreeEvaluable(this.nodes, id, proposedWorld);
    removeStable(oldSiblings, id);
    const actualSiblings = nextParent === null ? this.roots : nextParent.children;
    actualSiblings.splice(boundedIndex, 0, id);
    const depthDelta = nextDepth - node.depth;
    node.parent = nextParentId;
    if (depthDelta !== 0) shiftSubtreeDepth(this.nodes, id, depthDelta);
    if (nextLocal !== null) {
      node.localTransform = nextLocal;
      node.localMatrix = nextLocal.matrix;
    }
    if (parentChanged || localChanged || depthDelta !== 0) markWorldDirty(this.nodes, id);
    if (parentChanged || localChanged || depthDelta !== 0) primeSubtreeWorld(this.nodes, id, proposedWorld);
    this.didMutate();
  }

  removeSubtree(id: TId): readonly TId[] {
    const node = this.requireNode(id);
    const removed = collectSubtree(this.nodes, id);
    if (this.pendingRemoved.length + removed.length > this.options.maxNodes) {
      throw new SceneTransformGraphError("capacity-exceeded", "Pending scene removals reached the configured node budget; flush before removing more nodes.");
    }
    removeStable(node.parent === null ? this.roots : this.nodes.get(node.parent)!.children, id);
    for (const removedId of removed) {
      this.nodes.delete(removedId);
      this.pendingRemoved.push(removedId);
      this.pendingRemovedSet.add(removedId);
    }
    this.didMutate();
    return frozenIds(removed);
  }

  flush(): SceneTransformFlushResult<TId> {
    if (this.transactionActive) throw new SceneTransformGraphError("transaction-active", "Cannot flush an active scene transaction.");
    const result = flushTransformGraph(this.nodes, this.roots, this.pendingRemoved, this.stateGeneration, this.stateRevision);
    this.stateRevision = result.revision;
    for (const id of result.removedNodeIds) this.pendingRemovedSet.delete(id);
    return result;
  }

  transaction<TResult>(callback: (graph: this) => TResult): TResult {
    if (this.transactionActive) throw new SceneTransformGraphError("transaction-active", "Nested scene transactions are not supported.");
    if (typeof callback !== "function") throw new SceneTransformGraphError("invalid-options", "Scene transaction callback must be a function.");
    const snapshot = cloneGraphState(this.nodes, this.roots, this.pendingRemoved, this.pendingRemovedSet, this.stateGeneration, this.stateRevision);
    this.transactionActive = true;
    this.transactionMutated = false;
    try {
      const result = callback(this);
      if (isPromiseLike(result)) throw new SceneTransformGraphError("transaction-active", "Scene transactions must complete synchronously.");
      this.transactionActive = false;
      if (this.transactionMutated) this.stateGeneration = snapshot.generation + 1;
      return result;
    } catch (error) {
      this.restore(snapshot);
      this.transactionActive = false;
      throw error;
    } finally {
      this.transactionMutated = false;
    }
  }

  private requireNode(id: TId): TransformNode<TId> {
    const node = this.nodes.get(validateNodeId(id));
    if (!node) throw new SceneTransformGraphError("missing-node", `Scene node does not exist: ${String(id)}.`);
    return node;
  }

  private assertNoCycle(id: TId, parent: TransformNode<TId> | null): void {
    let cursor = parent;
    while (cursor) {
      if (cursor.id === id) throw new SceneTransformGraphError("cycle", "Reparent would create a scene hierarchy cycle.");
      cursor = cursor.parent === null ? null : this.nodes.get(cursor.parent)!;
    }
  }

  private didMutate(): void {
    if (this.transactionActive) this.transactionMutated = true;
    else this.stateGeneration += 1;
  }

  private restore(snapshot: GraphState<TId>): void {
    this.nodes.clear();
    for (const [id, node] of snapshot.nodes) this.nodes.set(id, node);
    this.roots.splice(0, this.roots.length, ...snapshot.roots);
    this.pendingRemoved.splice(0, this.pendingRemoved.length, ...snapshot.pendingRemoved);
    this.pendingRemovedSet.clear();
    for (const id of snapshot.pendingRemovedSet) this.pendingRemovedSet.add(id);
    this.stateGeneration = snapshot.generation;
    this.stateRevision = snapshot.revision;
  }
}

function sameNullableBounds(left: TransformNode<SceneTransformNodeId>["localBounds"], right: TransformNode<SceneTransformNodeId>["localBounds"]): boolean {
  return left === null ? right === null : right !== null && sameAabb(left, right);
}

function currentIndex<TId extends SceneTransformNodeId>(node: TransformNode<TId>, nodes: ReadonlyMap<TId, TransformNode<TId>>, roots: readonly TId[]): number {
  return (node.parent === null ? roots : nodes.get(node.parent)!.children).indexOf(node.id);
}

function isPromiseLike(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";
}
