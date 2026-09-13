import { describe, expect, it } from "vitest";
import { DeepSceneState, DeepSceneStateError } from "./sceneState.js";

describe("DeepSceneState", () => {
  it("keeps stable generated identities and deterministic traversal", () => {
    const scene = new DeepSceneState();
    const root = scene.createObject({ name: "root" });
    const child = scene.createObject({ parent: root, name: "child" });
    scene.createObject({ parent: root, name: "second" });
    const visited: string[] = [];
    scene.traverse((id) => visited.push(id));
    expect(visited).toEqual([root, child, "object-3"]);
    expect(scene.stats.objectCount).toBe(3);
  });

  it("rejects hierarchy cycles and missing parents", () => {
    const scene = new DeepSceneState();
    const root = scene.createObject();
    const child = scene.createObject({ parent: root });
    expect(() => scene.attach(root, child)).toThrow(DeepSceneStateError);
    expect(() => scene.attach("missing", root)).toThrow(/does not exist/);
  });

  it("detaches a child without destroying it and removes only the target subtree", () => {
    const scene = new DeepSceneState();
    const root = scene.createObject();
    const child = scene.createObject({ parent: root });
    scene.detach(child);
    expect(scene.snapshot().rootIds).toEqual([root, child]);

    const grandchild = scene.createObject({ parent: child });
    const unrelated = scene.createObject({ parent: root });
    expect(scene.remove(child)).toEqual([child, grandchild]);
    expect(scene.snapshot().rootIds).toEqual([root]);
    expect(() => scene.setVisible(grandchild, false)).toThrow(DeepSceneStateError);
  });

  it("propagates transform dirtiness upward and records disposed ids", () => {
    const scene = new DeepSceneState();
    const root = scene.createObject();
    const child = scene.createObject({ parent: root });
    scene.setTransform(child, { position: [1, 2, 3] });
    expect(scene.isDirty(child)).toBe(true);
    expect(scene.isDirty(root)).toBe(true);
    scene.clearDirty([child, root]);
    expect(scene.stats.dirtyCount).toBe(0);
    scene.remove(child, { dispose: true });
    expect(scene.snapshot().disposedIds).toEqual([child]);
  });

  it("computes inherited visibility and returns immutable snapshots", () => {
    const scene = new DeepSceneState();
    const root = scene.createObject();
    const child = scene.createObject({ parent: root, visible: false });
    expect(scene.effectiveVisible(child)).toBe(false);
    scene.setVisible(child, true);
    expect(scene.effectiveVisible(child)).toBe(true);
    const snapshot = scene.snapshot();
    expect(() => {
      snapshot.objects[child]!.transform.position[0] = 10;
    }).toThrow();
  });
});
