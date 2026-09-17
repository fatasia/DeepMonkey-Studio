import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { applySceneChangeset, createSceneChangeset } from "../scene/SceneChangeset.js";
import { SceneTransformGraph } from "../scene/SceneTransformGraph.js";
import { SceneChangesetProjection } from "./SceneChangesetProjection.js";
import { accepted, bridge, mesh } from "./testFixture.js";

function fixture(count = 100, nested = false) {
  const graph = new SceneTransformGraph(), root = new THREE.Group(), parent = nested ? new THREE.Group() : root;
  graph.create({ id: "root" });
  const bindings: { nodeId: string; object: THREE.Object3D }[] = [{ nodeId: "root", object: root }];
  if (nested) { root.add(parent); graph.create({ id: "parent", parent: "root" }); bindings.push({ nodeId: "parent", object: parent }); }
  const objects: THREE.Mesh[] = [];
  for (let index = 0; index < count; index++) {
    const object = mesh(), id = `node-${index}`; parent.add(object); objects.push(object);
    graph.create({ id, parent: nested ? "parent" : "root" }); bindings.push({ nodeId: id, object });
  }
  graph.flush(); root.updateWorldMatrix(true, true);
  const target = bridge(), oracle = bridge();
  const first = accepted(target.project(root, { cameraLayerMask: 1 })); first.acknowledge();
  accepted(oracle.project(root, { cameraLayerMask: 1 })).acknowledge();
  return { graph, root, parent, objects, first, target, oracle, projection: new SceneChangesetProjection(bindings) };
}

function move(f: ReturnType<typeof fixture>, nodeId: string, x: number) {
  const node = f.graph.getNode(nodeId)!;
  const changeset = createSceneChangeset(`move-${nodeId}-${x}`, f.graph.revision, [{ kind: "transform", nodeId,
    expectedRevision: node.lastChangedRevision, transform: { kind: "trs", translation: [x, 0, 0],
      rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }]);
  return { changeset, outcome: applySceneChangeset(f.graph, changeset) };
}

function ready(projection: SceneChangesetProjection, changeset: Parameters<SceneChangesetProjection["plan"]>[0],
  outcome: Parameters<SceneChangesetProjection["plan"]>[1]) {
  const plan = projection.plan(changeset, outcome);
  if (plan.status !== "ready") throw new Error("expected ready dirty plan");
  return plan;
}

describe("ThreeProjectionBridge SceneChangeset cache consumption", () => {
  it("rebuilds one leaf and produces the same packet as a full projection", () => {
    const f = fixture(), update = move(f, "node-42", 7); f.objects[42]!.position.x = 7; f.root.updateWorldMatrix(true, true);
    const result = accepted(f.target.projectDirty(f.root, ready(f.projection, update.changeset, update.outcome), { cameraLayerMask: 1 }));
    const full = accepted(f.oracle.project(f.root, { cameraLayerMask: 1 }));
    expect(result.packet).toEqual(full.packet);
    expect(result.metrics).toEqual({ mode: "incremental", sourceObjectCount: 101, rebuiltObjectCount: 1,
      reusedObjectCount: 100, allocatedInstanceCount: 1 });
    const prior = new Map(f.first.packet.instances.map(instance => [instance.id, instance]));
    expect(result.packet.instances.filter(instance => prior.get(instance.id) === instance)).toHaveLength(99);
    expect(result.acknowledge()).toBe(true);
  });

  it("matches full projection for parent visibility and overlapping parent/child changes", () => {
    const hidden = fixture(5, true), parentNode = hidden.graph.getNode("parent")!;
    const hide = createSceneChangeset("hide-parent", hidden.graph.revision, [{ kind: "hidden", nodeId: "parent",
      expectedRevision: parentNode.lastChangedRevision, hidden: true }]);
    const hideOutcome = applySceneChangeset(hidden.graph, hide); hidden.parent.visible = false;
    const hiddenResult = accepted(hidden.target.projectDirty(hidden.root,
      ready(hidden.projection, hide, hideOutcome), { cameraLayerMask: 1 }));
    const hiddenFull = accepted(hidden.oracle.project(hidden.root, { cameraLayerMask: 1 }));
    expect(hiddenResult.packet).toEqual(hiddenFull.packet);
    expect(hiddenResult.packet.instances).toHaveLength(0); expect(hiddenResult.metrics.allocatedInstanceCount).toBe(0);
    expect(hiddenResult.acknowledge()).toBe(true); expect(hiddenFull.acknowledge()).toBe(true);
    const hiddenParent = hidden.graph.getNode("parent")!;
    const show = createSceneChangeset("show-parent", hidden.graph.revision, [{ kind: "hidden", nodeId: "parent",
      expectedRevision: hiddenParent.lastChangedRevision, hidden: false }]);
    const showOutcome = applySceneChangeset(hidden.graph, show); hidden.parent.visible = true; hidden.root.updateWorldMatrix(true, true);
    const shownResult = accepted(hidden.target.projectDirty(hidden.root,
      ready(hidden.projection, show, showOutcome), { cameraLayerMask: 1 }));
    expect(shownResult.packet).toEqual(accepted(hidden.oracle.project(hidden.root, { cameraLayerMask: 1 })).packet);
    expect(shownResult.packet.instances).toHaveLength(5);

    const overlap = fixture(5, true), p = overlap.graph.getNode("parent")!, child = overlap.graph.getNode("node-0")!;
    const changeset = createSceneChangeset("parent-child", overlap.graph.revision, [
      { kind: "transform", nodeId: "parent", expectedRevision: p.lastChangedRevision,
        transform: { kind: "trs", translation: [3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { kind: "hidden", nodeId: "node-0", expectedRevision: child.lastChangedRevision, hidden: true },
    ]);
    const outcome = applySceneChangeset(overlap.graph, changeset);
    overlap.parent.position.x = 3; overlap.objects[0]!.visible = false; overlap.root.updateWorldMatrix(true, true);
    const result = accepted(overlap.target.projectDirty(overlap.root,
      ready(overlap.projection, changeset, outcome), { cameraLayerMask: 1 }));
    expect(result.packet).toEqual(accepted(overlap.oracle.project(overlap.root, { cameraLayerMask: 1 })).packet);
    expect(result.metrics).toMatchObject({ mode: "incremental", rebuiltObjectCount: 6, allocatedInstanceCount: 4 });
  });

  it("updates a shared material without rebuilding the unchanged sibling instance", () => {
    const f = fixture(2); f.objects[1]!.geometry = f.objects[0]!.geometry; f.objects[1]!.material = f.objects[0]!.material;
    f.target.clear(); f.oracle.clear(); f.root.updateWorldMatrix(true, true);
    const first = accepted(f.target.project(f.root, { cameraLayerMask: 1 })); first.acknowledge();
    accepted(f.oracle.project(f.root, { cameraLayerMask: 1 })).acknowledge();
    const update = move(f, "node-0", 4); f.objects[0]!.position.x = 4; f.objects[0]!.material.roughness = 0.25;
    f.root.updateWorldMatrix(true, true);
    const result = accepted(f.target.projectDirty(f.root,
      ready(f.projection, update.changeset, update.outcome), { cameraLayerMask: 1 }));
    expect(result.packet).toEqual(accepted(f.oracle.project(f.root, { cameraLayerMask: 1 })).packet);
    expect(result.packet.geometries).toHaveLength(1); expect(result.packet.materials).toHaveLength(1);
    expect(result.packet.materials[0]!.roughness).toBe(0.25);
    expect(result.packet.instances[1]).toBe(first.packet.instances[1]);
  });

  it("retains active textures owned by unchanged objects", () => {
    const f = fixture(2);
    for (const [index, object] of f.objects.entries()) {
      const texture = new THREE.DataTexture(Uint8Array.from([index * 50, 80, 120, 255]), 1, 1,
        THREE.RGBAFormat, THREE.UnsignedByteType);
      texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true; object.material.map = texture;
    }
    f.target.clear(); f.oracle.clear(); f.root.updateWorldMatrix(true, true);
    const first = accepted(f.target.project(f.root, { cameraLayerMask: 1 })); first.acknowledge();
    accepted(f.oracle.project(f.root, { cameraLayerMask: 1 })).acknowledge();
    const update = move(f, "node-0", 5); f.objects[0]!.position.x = 5; f.root.updateWorldMatrix(true, true);
    const result = accepted(f.target.projectDirty(f.root,
      ready(f.projection, update.changeset, update.outcome), { cameraLayerMask: 1 }));
    expect(result.packet).toEqual(accepted(f.oracle.project(f.root, { cameraLayerMask: 1 })).packet);
    expect(result.packet.textures).toHaveLength(2);
    expect(result.packet.textures![1]).toBe(first.packet.textures![1]);
  });

  it("uses full projection for removed nodes and missing bindings", () => {
    const removed = fixture(2), update = move(removed, "node-0", 1);
    removed.graph.removeSubtree("node-0"); const flush = removed.graph.flush(); removed.root.remove(removed.objects[0]!);
    const removalPlan = ready(removed.projection, update.changeset,
      { status: "applied", revision: flush.revision, flush });
    const removal = accepted(removed.target.projectDirty(removed.root, removalPlan, { cameraLayerMask: 1 }));
    expect(removal.metrics.mode).toBe("full-fallback");
    expect(removal.packet).toEqual(accepted(removed.oracle.project(removed.root, { cameraLayerMask: 1 })).packet);

    const missing = fixture(2), projection = new SceneChangesetProjection([
      { nodeId: "root", object: missing.root }, { nodeId: "node-0", object: missing.objects[0]! },
    ]), missingUpdate = move(missing, "node-1", 2);
    missing.objects[1]!.position.x = 2; missing.root.updateWorldMatrix(true, true);
    const missingResult = accepted(missing.target.projectDirty(missing.root,
      ready(projection, missingUpdate.changeset, missingUpdate.outcome), { cameraLayerMask: 1 }));
    expect(missingResult.metrics.mode).toBe("full-fallback");
    expect(missingResult.packet).toEqual(accepted(missing.oracle.project(missing.root, { cameraLayerMask: 1 })).packet);
  });
});
