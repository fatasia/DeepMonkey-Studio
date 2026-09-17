import type { SceneChangeset, SceneChangesetOutcome } from "../scene/SceneChangeset.js";
import type { ThreeObjectSource } from "./types.js";

export interface ThreeSceneNodeBinding {
  readonly nodeId: string;
  readonly object: ThreeObjectSource;
}

export interface ThreeProjectionDirtyMetrics {
  readonly boundNodeCount: number;
  readonly sourceCommandCount: number;
  readonly dirtyNodeCount: number;
  readonly dirtyObjectCount: number;
  readonly dirtyRatio: number;
  readonly fullFallback: boolean;
  readonly fallbackReason?: "missing-binding" | "removed-node" | "stale-revision";
}

export type ThreeProjectionDirtyPlan =
  | { readonly status: "rejected"; readonly reason: "changeset-rejected" | "stale-revision" }
  | { readonly status: "ready"; readonly revision: number; readonly objects: readonly ThreeObjectSource[];
      readonly metrics: ThreeProjectionDirtyMetrics; acknowledge(): boolean };

/** B01 → B02 boundary. It maps authoritative node changes to a bounded Three dirty domain. */
export class SceneChangesetProjection {
  private readonly byNode = new Map<string, ThreeObjectSource>();
  private readonly byObject = new WeakMap<object, string>();
  private generation = 0;
  private acceptedRevision = 0;

  constructor(bindings: readonly ThreeSceneNodeBinding[]) {
    if (!Array.isArray(bindings) || !bindings.length) throw new Error("Three scene projection requires node bindings.");
    for (const binding of bindings) {
      if (!binding || typeof binding.nodeId !== "string" || !binding.nodeId) throw new Error("Three scene projection node id is invalid.");
      if (!binding.object || typeof binding.object !== "object") throw new Error(`Three scene projection object is invalid for ${binding.nodeId}.`);
      if (this.byNode.has(binding.nodeId)) throw new Error(`Three scene projection node is bound twice: ${binding.nodeId}.`);
      if (this.byObject.has(binding.object as object)) throw new Error(`Three scene projection object is bound twice: ${binding.nodeId}.`);
      this.byNode.set(binding.nodeId, binding.object);
      this.byObject.set(binding.object as object, binding.nodeId);
    }
  }

  plan(changeset: SceneChangeset, outcome: SceneChangesetOutcome): ThreeProjectionDirtyPlan {
    const token = ++this.generation;
    if (outcome.status === "rejected") return { status: "rejected", reason: "changeset-rejected" };
    if (outcome.revision <= this.acceptedRevision) return { status: "rejected", reason: "stale-revision" };
    const commandNodes = new Set(changeset.commands.map(command => command.nodeId));
    const changedNodes = new Set(outcome.flush.changedNodeIds);
    const removedNodes = new Set(outcome.flush.removedNodeIds);
    let fallbackReason: ThreeProjectionDirtyMetrics["fallbackReason"];
    const objects: ThreeObjectSource[] = [], seen = new Set<ThreeObjectSource>();
    for (const nodeId of changedNodes) {
      const object = typeof nodeId === "string" ? this.byNode.get(nodeId) : undefined;
      if (!object) { fallbackReason ??= "missing-binding"; continue; }
      // Parent transform/visibility changes affect the complete descendant projection.
      this.collectSubtree(object, objects, seen);
    }
    if (removedNodes.size) fallbackReason ??= "removed-node";
    for (const nodeId of commandNodes) if (!this.byNode.has(nodeId)) fallbackReason ??= "missing-binding";
    const metrics: ThreeProjectionDirtyMetrics = Object.freeze({
      boundNodeCount: this.byNode.size,
      sourceCommandCount: changeset.commands.length,
      dirtyNodeCount: changedNodes.size + removedNodes.size,
      dirtyObjectCount: objects.length,
      dirtyRatio: objects.length / this.byNode.size,
      fullFallback: fallbackReason !== undefined,
      ...(fallbackReason ? { fallbackReason } : {}),
    });
    let settled = false;
    return { status: "ready", revision: outcome.revision, objects: Object.freeze(objects), metrics,
      acknowledge: () => {
        if (settled || token !== this.generation) return false;
        settled = true; this.acceptedRevision = outcome.revision; return true;
      } };
  }

  clear(): void { this.generation++; this.acceptedRevision = 0; }

  private collectSubtree(root: ThreeObjectSource, output: ThreeObjectSource[], seen: Set<ThreeObjectSource>): void {
    const stack = [root];
    const subtreeSeen = new Set<ThreeObjectSource>();
    while (stack.length) {
      const object = stack.pop()!;
      if (subtreeSeen.has(object)) throw new Error("Three scene projection binding contains a cycle or duplicate child.");
      subtreeSeen.add(object);
      // Multiple changed nodes can legitimately cover the same descendant domain.
      if (seen.has(object)) continue;
      seen.add(object); output.push(object);
      if (output.length > 32_768) throw new Error("Three scene projection dirty domain exceeds object limit.");
      if (!Array.isArray(object.children)) throw new Error("Three scene projection object children are invalid.");
      for (let index = object.children.length - 1; index >= 0; index--) stack.push(object.children[index]!);
    }
  }
}
