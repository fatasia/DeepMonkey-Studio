import { describe, expect, it } from "vitest";
import {
  CpuVisibleWorkingSet,
  SpatialIndexError,
  spatialAabb,
  type LodCamera,
  type SpatialFrustum,
  type VisibleObjectLodLevel,
  type VisibleObjectRegistration,
} from "../index.js";

const VIEWPORT = { width: 1000, height: 1000 } as const;
const CAMERA: LodCamera = {
  projection: "perspective",
  position: [0, 0, 0],
  forward: [0, 0, 1],
  verticalFovRadians: Math.PI / 2,
  near: 0.1,
  far: 1000,
};
const FRUSTUM: SpatialFrustum = { planes: [
  [1, 0, 0, 200], [-1, 0, 0, 200],
  [0, 1, 0, 200], [0, -1, 0, 200],
  [0, 0, 1, 0], [0, 0, -1, 250],
] };
const LEVELS: readonly VisibleObjectLodLevel[] = [
  { geometryId: "geo-high", minProjectedDiameterPixels: 100, geometricError: 0, triangles: 100 },
  { geometryId: "geo-mid", minProjectedDiameterPixels: 30, geometricError: 0.25, triangles: 20 },
  { geometryId: "geo-low", minProjectedDiameterPixels: 0, geometricError: 1, triangles: 5 },
];

describe("CpuVisibleWorkingSet", () => {
  it("produces stable contiguous material/geometry/LOD batches and flat upload order", () => {
    const set = workingSet();
    set.register(object("b", 10, { materialId: "mat-a" }));
    set.register(object("a", 10, { materialId: "mat-a" }));
    set.register(object("c", 30, { materialId: "mat-b" }));
    const first = frame(set);
    const second = frame(set);

    expect(first.candidates.map(({ objectId }) => objectId)).toEqual(["a", "b", "c"]);
    expect(first.batches).toEqual([
      { materialId: "mat-a", geometryId: "geo-high", lodLevel: 0, firstCandidate: 0, candidateCount: 2, triangles: 200 },
      { materialId: "mat-b", geometryId: "geo-mid", lodLevel: 1, firstCandidate: 2, candidateCount: 1, triangles: 20 },
    ]);
    expect(second.candidates).toEqual(first.candidates);
    expect(second.batches).toEqual(first.batches);
    expect(first).toMatchObject({ revision: 1, generation: 3, renderedTriangles: 220 });
    expect(second.revision).toBe(2);
    expect(Object.isFrozen(first.candidates)).toBe(true);
    expect(() => (first.candidates as unknown[]).pop()).toThrow();
  });

  it("updates bounds, instance and material atomically without leaving stale handles", () => {
    const set = workingSet();
    set.register(object("pump", 10, { instanceId: "instance-old" }));
    frame(set);
    expect(set.update("pump", {
      bounds: boundsForDiameter(20),
      instanceId: "instance-new",
      materialId: "mat-updated",
    })).toBe(true);
    const updated = frame(set);
    expect(updated.candidates[0]).toMatchObject({
      objectId: "pump",
      instanceId: "instance-new",
      materialId: "mat-updated",
      geometryId: "geo-low",
      lodLevel: 2,
    });
    set.register(object("replacement", 20, { instanceId: "instance-old" }));
    expect(frame(set).candidates.map(({ instanceId }) => instanceId)).toContain("instance-old");
    expect(set.generation).toBe(3);
  });

  it("deletes registry, spatial, instance and hysteresis state together", () => {
    const set = workingSet();
    set.register(object("old", 10, { instanceId: 7 }));
    frame(set);
    expect(set.stats.trackedLodObjects).toBe(1);
    expect(set.remove("old")).toBe(true);
    expect(set.remove("old")).toBe(false);
    expect(set.stats).toMatchObject({ registeredObjects: 0, registeredInstances: 0, trackedLodObjects: 0 });
    set.register(object("new", 10, { instanceId: 7 }));
    expect(frame(set).candidates.map(({ objectId }) => objectId)).toEqual(["new"]);
  });

  it("propagates mask and priority through query, object and triangle budgets", () => {
    const set = workingSet();
    set.register(object("low", 10, { priority: 0, mask: 1 }));
    set.register(object("high", 10, { priority: 10, mask: 1 }));
    set.register(object("hidden", 10, { priority: 100, mask: 2 }));
    const queried = frame(set, { mask: 1, maxQueryCandidates: 1 });
    expect(queried.candidates.map(({ objectId }) => objectId)).toEqual(["high"]);
    expect(queried.query).toMatchObject({ matchedEntries: 2, submittedToLod: 1, truncated: true });

    const budgeted = frame(set, { mask: 3, maxQueryCandidates: 3, budget: { maxObjects: 2, maxTriangles: 120 } });
    const byId = new Map(budgeted.candidates.map((candidate) => [candidate.objectId, candidate]));
    expect([...byId.keys()].sort()).toEqual(["hidden", "high"]);
    expect(byId.get("hidden")?.lodLevel).toBe(0);
    expect(byId.get("high")?.lodLevel).toBe(1);
    expect(budgeted.renderedTriangles).toBe(120);
  });

  it("rejects incomplete metadata and rolls back failed register and update operations", () => {
    const set = workingSet({ maxEntries: 2 });
    set.register(object("stable", 10, { instanceId: "shared" }));
    set.register(object("peer", 10, { instanceId: "peer-instance" }));
    const before = set.stats;
    expectWorkingSetError(() => set.register({ id: "missing" } as never), "invalid-id");
    expectWorkingSetError(() => set.register({
      id: "missing-material", instanceId: "missing-material-instance", bounds: boundsForDiameter(100), levels: LEVELS,
    } as never), "invalid-handle");
    expectWorkingSetError(() => set.register(object("bad-geometry", 10, {
      levels: [{ ...LEVELS[0]!, geometryId: "" }, ...LEVELS.slice(1)],
    })), "invalid-handle");
    expectWorkingSetError(() => set.register(object("duplicate-instance", 10, { instanceId: "shared" })), "duplicate-instance");
    expectWorkingSetError(() => set.register(object("capacity", 10, { instanceId: "capacity-instance" })), "capacity-exceeded");
    expectWorkingSetError(() => set.register(object("stable", 10, { instanceId: "other" })), "duplicate-id");
    expectWorkingSetError(() => set.update("stable", { materialId: "" }), "invalid-handle");
    expectWorkingSetError(() => set.update("peer", { instanceId: "shared" }), "duplicate-instance");
    expectWorkingSetError(() => set.update("stable", { priority: undefined } as never), "missing-metadata");
    expectWorkingSetError(() => set.update("missing", { priority: 1 }), "missing-id");
    expect(set.stats).toEqual(before);
    expect(frame(set).candidates.find(({ objectId }) => objectId === "stable"))
      .toMatchObject({ objectId: "stable", instanceId: "shared", materialId: "mat" });
  });

  it("preserves movement hysteresis until an explicit camera jump reset", () => {
    const set = workingSet();
    set.register(objectWithBounds("machine", boundsForDiameter(110)));
    expect(frame(set).candidates[0]?.lodLevel).toBe(0);
    set.update("machine", { bounds: boundsForDiameter(95) });
    const held = frame(set);
    expect(held.candidates[0]).toMatchObject({ lodLevel: 0 });
    set.resetForCameraJump();
    const reset = frame(set);
    expect(reset.candidates[0]).toMatchObject({ lodLevel: 1 });
    expect(reset.revision).toBe(held.revision + 2);
  });

  it("resets only the changed object's hysteresis when its LOD profile changes", () => {
    const set = workingSet();
    set.register(objectWithBounds("a", boundsForDiameter(110)));
    set.register(objectWithBounds("b", boundsForDiameter(110)));
    frame(set);
    set.update("a", { bounds: boundsForDiameter(95) });
    set.update("b", { bounds: boundsForDiameter(95) });
    frame(set);
    const changed = LEVELS.map((level, index) => ({ ...level, geometricError: level.geometricError + index * 0.1 }));
    set.update("a", { levels: changed });
    const result = frame(set);
    expect(new Map(result.candidates.map(({ objectId, lodLevel }) => [objectId, lodLevel]))).toEqual(new Map([["a", 1], ["b", 0]]));
  });

  it("does not commit frame revision or LOD state after invalid frame input", () => {
    const set = workingSet();
    set.register(object("stable", 10));
    frame(set);
    const before = set.stats;
    expectWorkingSetError(() => frame(set, { camera: { ...CAMERA, verticalFovRadians: Number.NaN } }), "invalid-options");
    expectWorkingSetError(() => frame(set, { maxQueryCandidates: -1 }), "invalid-query");
    expect(set.stats).toEqual(before);
  });

  it("bounds a 10k visible registry by query, object, and triangle budgets", () => {
    const set = workingSet({ maxEntries: 12_000, maxNodes: 100_000 });
    for (let id = 0; id < 10_000; id += 1) {
      const x = id % 100 - 50;
      const y = Math.floor(id / 100) - 50;
      set.register({ ...objectWithBounds(id, spatialAabb([x, y, 49], [x + 0.5, y + 0.5, 50])), priority: id % 10 });
    }
    const result = frame(set, {
      maxQueryCandidates: 1000,
      budget: { maxObjects: 500, maxTriangles: 2500 },
    });
    expect(result.query).toMatchObject({ matchedEntries: 10_000, submittedToLod: 1000, truncated: true });
    expect(result.candidates).toHaveLength(500);
    expect(result.renderedTriangles).toBe(2500);
    expect(set.stats).toMatchObject({ registeredObjects: 10_000, registeredInstances: 10_000, trackedLodObjects: 1000 });
    expect(result.candidates.every(({ priority }) => priority === 9)).toBe(true);
  });

  it("returns an immutable empty working set and clears all owned state", () => {
    const set = workingSet();
    const empty = frame(set);
    expect(empty).toMatchObject({ candidates: [], batches: [], renderedTriangles: 0 });
    set.register(object("item", 10));
    frame(set);
    set.clear();
    expect(set.stats).toMatchObject({ registeredObjects: 0, registeredInstances: 0, trackedLodObjects: 0 });
    expect(frame(set).candidates).toEqual([]);
  });
});

function workingSet(options: { maxEntries?: number; maxNodes?: number } = {}) {
  return new CpuVisibleWorkingSet<string | number>({
    bounds: spatialAabb([-250, -250, -10], [250, 250, 260]),
    ...options,
  });
}

function object(
  id: string,
  z: number,
  overrides: Partial<VisibleObjectRegistration<string>> = {},
): VisibleObjectRegistration<string> {
  return objectWithBounds(id, boundsForDiameter(1000 / z), overrides);
}

function objectWithBounds<TId extends string | number>(
  id: TId,
  bounds: ReturnType<typeof spatialAabb>,
  overrides: Partial<VisibleObjectRegistration<TId>> = {},
): VisibleObjectRegistration<TId> {
  return { id, instanceId: `instance-${id}`, bounds, materialId: "mat", levels: LEVELS, ...overrides };
}

function boundsForDiameter(diameter: number) {
  const z = 1000 / diameter;
  return spatialAabb([-1, 0, z], [1, 0, z]);
}

function frame<TId extends string | number>(
  set: CpuVisibleWorkingSet<TId>,
  overrides: Partial<Parameters<CpuVisibleWorkingSet<TId>["buildFrame"]>[0]> = {},
) {
  return set.buildFrame({ frustum: FRUSTUM, camera: CAMERA, viewport: VIEWPORT, ...overrides });
}

function expectWorkingSetError(run: () => unknown, code: SpatialIndexError["code"]): void {
  try {
    run();
    throw new Error("Expected SpatialIndexError.");
  } catch (error) {
    expect(error).toBeInstanceOf(SpatialIndexError);
    expect((error as SpatialIndexError).code).toBe(code);
  }
}
