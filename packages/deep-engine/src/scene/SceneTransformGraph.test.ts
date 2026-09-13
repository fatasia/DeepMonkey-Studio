import { describe, expect, it } from "vitest";
import { SceneTransformGraph } from "./SceneTransformGraph.js";
import { SceneTransformGraphError, type SceneLocalTransform } from "./types.js";

const unitBounds = Object.freeze({ min: [-1, -1, -1] as const, max: [1, 1, 1] as const });

describe("SceneTransformGraph evaluation", () => {
  it("flushes dirty nodes in stable topology and emits compact bounds updates", () => {
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "root", localTransform: translation(10, 0, 0), localBounds: unitBounds });
    graph.create({ id: "right", parent: "root", localTransform: translation(0, 2, 0), localBounds: unitBounds });
    graph.create({ id: "left", parent: "root", siblingIndex: 0, localTransform: translation(0, -2, 0), localBounds: unitBounds });
    const first = graph.flush();
    expect(first.changedNodeIds).toEqual(["root", "left", "right"]);
    expect(first.worldBoundsUpdates.map(({ id }) => id)).toEqual(["root", "left", "right"]);
    expect(graph.getNode("left")?.worldBounds).toEqual({ min: [9, -3, -1], max: [11, -1, 1] });
    expect(graph.flush()).toMatchObject({ revision: 1, changedNodeIds: [], removedNodeIds: [] });

    graph.create({ id: "other", localBounds: unitBounds });
    graph.flush();
    graph.update("root", { localTransform: translation(20, 0, 0) });
    expect(graph.flush().changedNodeIds).toEqual(["root", "left", "right"]);
  });

  it("limits bounds-only dirtiness to the edited node and reports clears", () => {
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "root", localBounds: unitBounds });
    graph.create({ id: "child", parent: "root", localBounds: unitBounds });
    graph.flush();
    graph.update("root", { localBounds: null });
    const result = graph.flush();
    expect(result.changedNodeIds).toEqual(["root"]);
    expect(result.boundsClearedNodeIds).toEqual(["root"]);
    expect(result.worldBoundsUpdates).toEqual([]);
  });

  it("keeps singular transforms renderable for bounds while marking normals unavailable", () => {
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "flat", localTransform: scale(-2, 3, 0), localBounds: unitBounds });
    const change = graph.flush().changes[0]!;
    expect(change.normalMatrix).toBeNull();
    expect(change.normalMatrixStatus).toBe("singular");
    expect(change.worldBounds).toEqual({ min: [-2, -3, 0], max: [2, 3, 0] });
  });

  it("preserves mirrored non-uniform scale and shear matrix semantics", () => {
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "mirrored", localTransform: scale(-2, 3, 4), localBounds: unitBounds });
    graph.create({
      id: "sheared",
      localTransform: { kind: "matrix", matrix: [1, 0, 0, 0, 2, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1] },
      localBounds: unitBounds,
    });
    const result = graph.flush();
    expect(result.changes[0]).toMatchObject({ normalMatrixStatus: "valid", worldBounds: { min: [-2, -3, -4], max: [2, 3, 4] } });
    expect(result.changes[0]?.normalMatrix).toEqual([-0.5, 0, 0, 0, 1 / 3, 0, 0, 0, 0.25]);
    expect(result.changes[1]).toMatchObject({ normalMatrixStatus: "valid", worldBounds: { min: [1, -1, -1], max: [7, 1, 1] } });
  });

  it("copies all input and freezes public results", () => {
    const translationInput = [1, 2, 3] as [number, number, number];
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "node", localTransform: { ...translation(translationInput[0], translationInput[1], translationInput[2]), translation: translationInput }, localBounds: bounds });
    translationInput[0] = 99;
    bounds.max[0] = 99;
    const snapshot = graph.getNode("node")!;
    expect(snapshot.localMatrix[12]).toBe(1);
    expect(snapshot.localBounds?.max[0]).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.children)).toBe(true);
    expect(Object.isFrozen(snapshot.localBounds?.max)).toBe(true);
    expect(Object.isFrozen(graph.flush().changes)).toBe(true);
  });
});

describe("SceneTransformGraph hierarchy mutation", () => {
  it("reparents with world preservation and stores an exact local matrix", () => {
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "a", localTransform: translation(10, 0, 0) });
    graph.create({ id: "b", localTransform: translation(-5, 0, 0) });
    graph.create({ id: "item", parent: "a", localTransform: translation(2, 0, 0), localBounds: unitBounds });
    const before = graph.getNode("item")!;
    graph.reparent("item", "b", { keepWorldTransform: true });
    const after = graph.getNode("item")!;
    expect(after.worldMatrix).toEqual(before.worldMatrix);
    expect(after.worldBounds).toEqual(before.worldBounds);
    expect(after.localTransform.kind).toBe("matrix");
    expect(after.localMatrix[12]).toBe(17);
  });

  it("fails cycles, dangling parents, depth, and singular keep-world atomically", () => {
    const graph = new SceneTransformGraph<string>({ maxDepth: 2 });
    graph.create({ id: "root" });
    graph.create({ id: "child", parent: "root" });
    graph.create({ id: "leaf", parent: "child" });
    graph.create({ id: "singular", localTransform: scale(0, 1, 1) });
    const generation = graph.generation;
    expectCode(() => graph.reparent("root", "leaf"), "cycle");
    expectCode(() => graph.reparent("leaf", "missing"), "missing-parent");
    expectCode(() => graph.reparent("root", "child"), "cycle");
    expectCode(() => graph.reparent("leaf", "singular", { keepWorldTransform: true }), "non-invertible-parent");
    expect(graph.generation).toBe(generation);
    expect(graph.getNode("leaf")?.parent).toBe("child");
  });

  it("rejects reparent depth overflow and keeps stable sibling order", () => {
    const graph = new SceneTransformGraph<string>({ maxDepth: 2 });
    graph.create({ id: "root" });
    graph.create({ id: "a", parent: "root" });
    graph.create({ id: "b", parent: "root" });
    graph.create({ id: "leaf", parent: "a" });
    graph.create({ id: "anchor" });
    graph.create({ id: "anchor-child", parent: "anchor" });
    expectCode(() => graph.reparent("a", "anchor-child"), "depth-exceeded");
    expect(graph.getNode("a")?.parent).toBe("root");
    graph.reparent("b", "root", { siblingIndex: 0 });
    expect(graph.getNode("root")?.children).toEqual(["b", "a"]);
    expect(graph.flush().changedNodeIds).toEqual(["root", "b", "a", "leaf", "anchor", "anchor-child"]);
  });

  it("removes subtrees iteratively and prevents id reuse until removal flush", () => {
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "root" });
    graph.create({ id: "a", parent: "root" });
    graph.create({ id: "leaf", parent: "a" });
    graph.create({ id: "b", parent: "root" });
    graph.flush();
    expect(graph.removeSubtree("a")).toEqual(["a", "leaf"]);
    expect(graph.has("leaf")).toBe(false);
    expectCode(() => graph.create({ id: "leaf" }), "duplicate-id");
    expect(graph.flush().removedNodeIds).toEqual(["a", "leaf"]);
    graph.create({ id: "leaf" });
    expect(graph.rootIds).toEqual(["root", "leaf"]);
  });
});

describe("SceneTransformGraph transactions and budgets", () => {
  it("commits a batch as one generation and fully rolls back failure", () => {
    const graph = new SceneTransformGraph<string>();
    graph.transaction((draft) => {
      draft.create({ id: "root" });
      draft.create({ id: "child", parent: "root" });
      draft.update("child", { localBounds: unitBounds });
    });
    expect(graph.generation).toBe(1);
    const before = graph.getNode("child");
    expect(() => graph.transaction((draft) => {
      draft.reparent("child", null);
      draft.removeSubtree("root");
      draft.create({ id: "bad", parent: "missing" });
    })).toThrowError(SceneTransformGraphError);
    expect(graph.generation).toBe(1);
    expect(graph.getNode("child")).toEqual(before);
    expect(graph.has("root")).toBe(true);
  });

  it("rejects nested and async transactions without retaining partial writes", () => {
    const graph = new SceneTransformGraph<string>();
    expectCode(() => graph.transaction((draft) => draft.transaction(() => undefined)), "transaction-active");
    expectCode(() => graph.transaction((draft) => {
      draft.create({ id: "temporary" });
      return Promise.resolve();
    }), "transaction-active");
    expect(graph.size).toBe(0);
  });

  it("enforces capacity and depth without partial mutation", () => {
    const capacity = new SceneTransformGraph<string>({ maxNodes: 1 });
    capacity.create({ id: "one" });
    expectCode(() => capacity.create({ id: "two" }), "capacity-exceeded");
    expect(capacity.rootIds).toEqual(["one"]);
    const depth = new SceneTransformGraph<string>({ maxDepth: 1 });
    depth.create({ id: "zero" });
    depth.create({ id: "one", parent: "zero" });
    expectCode(() => depth.create({ id: "two", parent: "one" }), "depth-exceeded");
    expect(depth.size).toBe(2);
    const rootsOnly = new SceneTransformGraph<string>({ maxDepth: 0 });
    rootsOnly.create({ id: "root" });
    expectCode(() => rootsOnly.create({ id: "child", parent: "root" }), "depth-exceeded");
  });

  it("bounds pending removal memory until a flush consumes tombstones", () => {
    const graph = new SceneTransformGraph<string>({ maxNodes: 2 });
    graph.create({ id: "a" });
    graph.create({ id: "b" });
    graph.removeSubtree("a");
    graph.create({ id: "c" });
    graph.removeSubtree("b");
    graph.create({ id: "d" });
    expectCode(() => graph.removeSubtree("c"), "capacity-exceeded");
    expect(graph.has("c")).toBe(true);
    expect(graph.flush().removedNodeIds).toEqual(["a", "b"]);
    expect(graph.removeSubtree("c")).toEqual(["c"]);
  });

  it("rejects non-finite input and derived world overflow without changing state", () => {
    const graph = new SceneTransformGraph<string>();
    expectCode(() => graph.create({ id: "nan", localTransform: translation(Number.NaN, 0, 0) }), "invalid-transform");
    graph.create({ id: "root" });
    graph.create({ id: "bounded", parent: "root", localTransform: scale(1e15, 1, 1), localBounds: unitBounds });
    const generation = graph.generation;
    expectCode(() => graph.update("root", { localTransform: scale(1e15, 1, 1) }), "invalid-transform");
    expect(graph.generation).toBe(generation);
    expect(graph.getNode("root")?.localMatrix[0]).toBe(1);
  });

  it("flushes and removes a 10k deep hierarchy without recursion", () => {
    const count = 10_000;
    const graph = new SceneTransformGraph<number>({ maxNodes: count, maxDepth: count });
    graph.transaction((draft) => {
      for (let id = 0; id < count; id += 1) draft.create({ id, parent: id === 0 ? null : id - 1 });
    });
    expect(graph.flush().changedNodeIds).toHaveLength(count);
    graph.update(0, { localTransform: translation(1, 0, 0) });
    expect(graph.flush().changedNodeIds).toHaveLength(count);
    expect(graph.getNode(count - 1)?.worldMatrix[12]).toBe(1);
    expect(graph.removeSubtree(0)).toHaveLength(count);
    expect(graph.size).toBe(0);
  });
});

function translation(x: number, y: number, z: number): SceneLocalTransform {
  return { kind: "trs", translation: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
}

function scale(x: number, y: number, z: number): SceneLocalTransform {
  return { kind: "trs", translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [x, y, z] };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("Expected operation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(SceneTransformGraphError);
    expect((error as SceneTransformGraphError).code).toBe(code);
  }
}
