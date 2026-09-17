import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { SceneTransformGraph } from "../scene/SceneTransformGraph.js";
import { applySceneChangeset, createSceneChangeset } from "../scene/SceneChangeset.js";
import { SceneChangesetProjection } from "./SceneChangesetProjection.js";

function fixture(count = 100) {
  const graph = new SceneTransformGraph(), root = new THREE.Group(), bindings = [];
  graph.create({ id: "root" }); bindings.push({ nodeId: "root", object: root });
  for (let index = 0; index < count; index++) {
    const id = `node-${index}`, object = new THREE.Group(); root.add(object);
    graph.create({ id, parent: "root" }); bindings.push({ nodeId: id, object });
  }
  graph.flush();
  return { graph, root, bindings, projection: new SceneChangesetProjection(bindings) };
}

describe("SceneChangeset Three dirty projection", () => {
  it("maps a one-percent leaf change without including unchanged siblings", () => {
    const f = fixture(), node = f.graph.getNode("node-42")!;
    const changeset = createSceneChangeset("move-42", f.graph.revision, [{ kind: "transform", nodeId: "node-42",
      expectedRevision: node.lastChangedRevision, transform: { kind: "trs", translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }]);
    const plan = f.projection.plan(changeset, applySceneChangeset(f.graph, changeset));
    expect(plan).toMatchObject({ status: "ready", metrics: { sourceCommandCount: 1, dirtyNodeCount: 1,
      dirtyObjectCount: 1, fullFallback: false } });
    if (plan.status !== "ready") throw new Error("expected plan");
    expect(plan.metrics.dirtyRatio).toBeCloseTo(1 / 101);
    expect(plan.objects).toEqual([f.root.children[42]]); expect(plan.acknowledge()).toBe(true);
  });

  it("includes descendants for parent transforms and visibility changes", () => {
    const f = fixture(2), nested = new THREE.Group(); f.root.children[0]!.add(nested);
    const node = f.graph.getNode("node-0")!;
    const changeset = createSceneChangeset("hide-parent", f.graph.revision, [{ kind: "hidden", nodeId: "node-0",
      expectedRevision: node.lastChangedRevision, hidden: true }]);
    const plan = f.projection.plan(changeset, applySceneChangeset(f.graph, changeset));
    if (plan.status !== "ready") throw new Error("expected plan");
    expect(plan.objects).toEqual([f.root.children[0], nested]);
  });

  it("deduplicates overlapping parent and child dirty domains", () => {
    const f = fixture(2), rootNode = f.graph.getNode("root")!, childNode = f.graph.getNode("node-0")!;
    const changeset = createSceneChangeset("move-parent-and-child", f.graph.revision, [
      { kind: "hidden", nodeId: "root", expectedRevision: rootNode.lastChangedRevision, hidden: true },
      { kind: "hidden", nodeId: "node-0", expectedRevision: childNode.lastChangedRevision, hidden: true },
    ]);
    const plan = f.projection.plan(changeset, applySceneChangeset(f.graph, changeset));
    if (plan.status !== "ready") throw new Error("expected plan");
    expect(plan.objects).toEqual([f.root, ...f.root.children]);
    expect(plan.metrics.dirtyObjectCount).toBe(3);
  });

  it("requests full fallback for missing and removed bindings", () => {
    const f = fixture(1), node = f.graph.getNode("node-0")!;
    const changeset = createSceneChangeset("remove-shape", f.graph.revision, [{ kind: "hidden", nodeId: "node-0",
      expectedRevision: node.lastChangedRevision, hidden: true }]);
    f.graph.removeSubtree("node-0");
    const flush = f.graph.flush();
    const outcome = { status: "applied" as const, revision: flush.revision, flush };
    expect(f.projection.plan(changeset, outcome)).toMatchObject({ status: "ready", metrics: {
      fullFallback: true, fallbackReason: "removed-node" } });
  });

  it("rejects stale plans and prevents late acknowledgements", () => {
    const f = fixture(2);
    const apply = (id: string) => {
      const node = f.graph.getNode(id)!;
      const changeset = createSceneChangeset(`move-${id}-${f.graph.revision}`, f.graph.revision, [{ kind: "transform", nodeId: id,
        expectedRevision: node.lastChangedRevision, transform: { kind: "trs", translation: [f.graph.revision + 1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }]);
      return f.projection.plan(changeset, applySceneChangeset(f.graph, changeset));
    };
    const old = apply("node-0"), current = apply("node-1");
    if (old.status !== "ready" || current.status !== "ready") throw new Error("expected plans");
    expect(old.acknowledge()).toBe(false); expect(current.acknowledge()).toBe(true);
    expect(f.projection.plan(createSceneChangeset("late", f.graph.revision, [{ kind: "hidden", nodeId: "node-0",
      expectedRevision: f.graph.getNode("node-0")!.lastChangedRevision, hidden: true }]),
      { status: "applied", revision: current.revision, flush: { revision: current.revision, generation: 0,
        changedNodeIds: [], changes: [], worldBoundsUpdates: [], boundsClearedNodeIds: [], removedNodeIds: [] } }))
      .toEqual({ status: "rejected", reason: "stale-revision" });
  });
});
