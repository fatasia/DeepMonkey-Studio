import { describe, expect, it, vi } from "vitest";
import { LooseOctreeIndex } from "../spatial/looseOctree.js";
import { CpuVisibleWorkingSet } from "../spatial/visibleWorkingSet.js";
import type { SpatialAabb, SpatialFrustum } from "../spatial/types.js";
import { SceneTransformGraph } from "./SceneTransformGraph.js";
import { SceneTransformSpatialBridge } from "./SceneTransformSpatialBridge.js";
import { SceneSpatialSyncError } from "./spatialSyncTypes.js";

const ROOT: SpatialAabb = { min: [-20_000, -20_000, -20_000], max: [20_000, 20_000, 20_000] };
const UNIT: SpatialAabb = { min: [-1, -1, -1], max: [1, 1, 1] };

describe("SceneTransformSpatialBridge octree synchronization", () => {
  it("touches only one dirty object after a 10k scene has been synchronized", () => {
    const count = 10_000;
    const graph = new SceneTransformGraph<number>({ maxNodes: count });
    graph.transaction((draft) => {
      for (let id = 0; id < count; id += 1) draft.create({ id, localBounds: UNIT });
    });
    const index = new LooseOctreeIndex<number>({ bounds: ROOT, maxEntries: count });
    const bridge = new SceneTransformSpatialBridge({ kind: "octree", target: index });
    expect(bridge.apply(graph.flush()).spatialTouchedNodeIds).toHaveLength(count);
    const upsert = vi.spyOn(index, "upsert");

    graph.update(5_000, { localTransform: translation(100, 0, 0) });
    const result = bridge.apply(graph.flush());
    expect(result.spatialTouchedNodeIds).toEqual([5_000]);
    expect(result.transformUpdates.map(({ id }) => id)).toEqual([5_000]);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(index.queryAabb({ min: [98, -2, -2], max: [102, 2, 2] }).ids).toEqual([5_000]);
    expect(bridge.getTransform(5_000)).toMatchObject({ sceneRevision: 2, sceneGeneration: 2 });
  });

  it("applies bounds clear, restoration, and subtree deletion without rebuilding", () => {
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "root", localBounds: UNIT });
    graph.create({ id: "child", parent: "root", localBounds: UNIT });
    const index = new LooseOctreeIndex<string>({ bounds: ROOT });
    const bridge = new SceneTransformSpatialBridge({ kind: "octree", target: index, mask: 0b10 });
    bridge.apply(graph.flush());
    expect(index.queryAabb(ROOT, { mask: 0b01 }).ids).toEqual([]);

    graph.update("child", { localBounds: null });
    expect(bridge.apply(graph.flush()).boundsClearedNodeIds).toEqual(["child"]);
    expect(index.has("child")).toBe(false);
    expect(bridge.getTransform("child")?.worldBounds).toBeNull();
    graph.update("child", { localBounds: UNIT });
    expect(bridge.apply(graph.flush()).boundsUpsertedNodeIds).toEqual(["child"]);
    expect(index.has("child")).toBe(true);

    graph.removeSubtree("root");
    const removed = bridge.apply(graph.flush());
    expect(removed.removedNodeIds).toEqual(["root", "child"]);
    expect(index.size).toBe(0);
    expect(bridge.getTransform("child")).toBeUndefined();
  });

  it("rolls target contents and transform revisions back after an injected target failure", () => {
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "a", localBounds: UNIT });
    graph.create({ id: "b", localBounds: UNIT });
    const index = new LooseOctreeIndex<string>({ bounds: ROOT });
    const bridge = new SceneTransformSpatialBridge({ kind: "octree", target: index });
    bridge.apply(graph.flush());
    const previousA = index.getBounds("a");
    const previousTransform = bridge.getTransform("a");
    graph.update("a", { localTransform: translation(10, 0, 0) });
    graph.update("b", { localTransform: translation(20, 0, 0) });
    const delta = graph.flush();
    const original = index.upsert.bind(index);
    vi.spyOn(index, "upsert")
      .mockImplementationOnce(original)
      .mockImplementationOnce(() => { throw new Error("injected failure"); });
    expectCode(() => bridge.apply(delta), "target-failed");
    expect(index.getBounds("a")).toEqual(previousA);
    expect(index.getBounds("b")).toEqual(UNIT);
    expect(bridge.getTransform("a")).toBe(previousTransform);
    expect(bridge.stats.sceneRevision).toBe(1);
  });

  it("preflights capacity and malformed or replayed deltas before mutation", () => {
    const index = new LooseOctreeIndex<string>({ bounds: ROOT, maxEntries: 1 });
    index.insert("keep", UNIT);
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "a", localBounds: UNIT });
    graph.create({ id: "b", localBounds: UNIT });
    const delta = graph.flush();
    const bridge = new SceneTransformSpatialBridge({ kind: "octree", target: index });
    expectCode(() => bridge.apply(delta), "capacity-exceeded");
    expect(index.queryAabb(ROOT).ids).toEqual(["keep"]);
    expect(bridge.stats).toMatchObject({ trackedTransforms: 0, sceneRevision: 0, appliedFlushes: 0 });

    const validIndex = new LooseOctreeIndex<string>({ bounds: ROOT });
    const validBridge = new SceneTransformSpatialBridge({ kind: "octree", target: validIndex });
    const result = validBridge.apply(delta);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.transformUpdates)).toBe(true);
    expectCode(() => validBridge.apply(delta), "stale-delta");
    const malformed = { ...delta, revision: 2, removedNodeIds: ["ghost", "ghost"] };
    expectCode(() => validBridge.apply(malformed), "invalid-delta");
    expect(validIndex.size).toBe(2);
  });

  it("retains singular transforms as packet revisions while indexing their finite bounds", () => {
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "flat", localBounds: UNIT, localTransform: scale(1, 0, -2) });
    const index = new LooseOctreeIndex<string>({ bounds: ROOT });
    const bridge = new SceneTransformSpatialBridge({ kind: "octree", target: index });
    const result = bridge.apply(graph.flush());
    expect(result.transformUpdates[0]).toMatchObject({ id: "flat", normalMatrix: null, normalMatrixStatus: "singular" });
    expect(index.getBounds("flat")).toEqual({ min: [-1, 0, -2], max: [1, 0, 2] });
  });
});

describe("SceneTransformSpatialBridge visible working-set synchronization", () => {
  it("suspends bounds without losing metadata, resumes, then deletes metadata", () => {
    const working = new CpuVisibleWorkingSet<string>({ bounds: ROOT });
    working.register(metadata("mesh"));
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "mesh", localBounds: UNIT, localTransform: translation(0, 0, -10) });
    const bridge = new SceneTransformSpatialBridge({ kind: "working-set", target: working });
    bridge.apply(graph.flush());
    expect(frameIds(working)).toEqual(["mesh"]);

    graph.update("mesh", { localBounds: null });
    bridge.apply(graph.flush());
    expect(working.has("mesh")).toBe(true);
    expect(working.hasSpatialBounds("mesh")).toBe(false);
    expect(frameIds(working)).toEqual([]);
    graph.update("mesh", { localBounds: UNIT });
    bridge.apply(graph.flush());
    expect(frameIds(working)).toEqual(["mesh"]);

    graph.removeSubtree("mesh");
    bridge.apply(graph.flush());
    expect(working.has("mesh")).toBe(false);
  });

  it("fails closed when render metadata is missing", () => {
    const working = new CpuVisibleWorkingSet<string>({ bounds: ROOT });
    const graph = new SceneTransformGraph<string>();
    graph.create({ id: "unknown", localBounds: UNIT });
    const bridge = new SceneTransformSpatialBridge({ kind: "working-set", target: working });
    expectCode(() => bridge.apply(graph.flush()), "missing-metadata");
    expect(working.size).toBe(0);
    expect(bridge.stats.appliedFlushes).toBe(0);
  });
});

function metadata(id: string) {
  return { id, instanceId: `${id}-instance`, bounds: UNIT, materialId: "steel", levels: [
    { geometryId: "cube", minProjectedDiameterPixels: 0, geometricError: 0, triangles: 12 },
  ] };
}

function frameIds(working: CpuVisibleWorkingSet<string>): readonly string[] {
  return working.buildFrame({
    frustum: FRUSTUM,
    camera: { projection: "perspective", position: [0, 0, 0], forward: [0, 0, -1], verticalFovRadians: Math.PI / 2, near: 0.1, far: 100 },
    viewport: { width: 800, height: 600 },
  }).candidates.map(({ objectId }) => objectId);
}

const FRUSTUM: SpatialFrustum = { planes: [
  [1, 0, 0, 100], [-1, 0, 0, 100], [0, 1, 0, 100], [0, -1, 0, 100], [0, 0, 1, 100], [0, 0, -1, 100],
] };

function translation(x: number, y: number, z: number) {
  return { kind: "trs" as const, translation: [x, y, z] as const, rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const };
}
function scale(x: number, y: number, z: number) {
  return { kind: "trs" as const, translation: [0, 0, 0] as const, rotation: [0, 0, 0, 1] as const, scale: [x, y, z] as const };
}
function expectCode(run: () => unknown, code: string): void {
  try { run(); throw new Error("Expected operation to fail."); }
  catch (error) {
    expect(error).toBeInstanceOf(SceneSpatialSyncError);
    expect((error as SceneSpatialSyncError).code).toBe(code);
  }
}
