import { describe, expect, it } from "vitest";
import { compactProbeBounds, ProbeSurfaceCache } from "./probeSurfaceCache.js";

const bounds = (minX: number, maxX: number) => ({ min: [minX, 0, 0], max: [maxX, 1, 1] } as const);

describe("probe surface-cache invalidation", () => {
  it("keeps dirty regions until commit and refreshes dynamic surfaces every frame", () => {
    const cache = new ProbeSurfaceCache();
    expect(cache.upsert({ id: "robot", revision: 1, bounds: bounds(0, 1), dynamic: true })).toBe(true);
    const first = cache.beginFrame();
    expect(first).toMatchObject({ revision: 1, dirtyBounds: [bounds(0, 1)], dynamicBounds: [bounds(0, 1)] });
    expect(cache.beginFrame()).toEqual(first);
    cache.commit(first);
    expect(cache.beginFrame()).toMatchObject({ dirtyBounds: [], dynamicBounds: [bounds(0, 1)] });
  });

  it("invalidates the union of old and new bounds and preserves newer work across an older commit", () => {
    const cache = new ProbeSurfaceCache();
    cache.upsert({ id: "pump", revision: 1, bounds: bounds(0, 1) });
    const stale = cache.beginFrame();
    cache.upsert({ id: "pump", revision: 2, bounds: bounds(4, 5) });
    expect(cache.beginFrame().dirtyBounds).toEqual([bounds(0, 5)]);
    cache.commit(stale);
    expect(cache.pendingCount).toBe(1);
    const current = cache.beginFrame();
    cache.commit(current);
    expect(cache.pendingCount).toBe(0);
  });

  it("invalidates removed coverage and rejects stale or inconsistent revisions", () => {
    const cache = new ProbeSurfaceCache();
    cache.upsert({ id: "tank", revision: 2, bounds: bounds(-2, 2) });
    cache.commit(cache.beginFrame());
    expect(cache.remove("tank")).toBe(true);
    expect(cache.beginFrame().dirtyBounds).toEqual([bounds(-2, 2)]);
    expect(cache.remove("tank")).toBe(false);

    cache.upsert({ id: "valve", revision: 2, bounds: bounds(0, 1) });
    expect(cache.upsert({ id: "valve", revision: 2, bounds: bounds(0, 1) })).toBe(false);
    expect(() => cache.upsert({ id: "valve", revision: 2, bounds: bounds(1, 2) })).toThrow(/without advancing/);
    expect(() => cache.upsert({ id: "valve", revision: 1, bounds: bounds(0, 1) })).toThrow(/regressed/);
    expect(() => cache.upsert({ id: "bad", revision: 1, bounds: bounds(2, 1) })).toThrow(/min/);
  });

  it("compacts large mutation sets into the planner budget without losing coverage", () => {
    const source = Array.from({ length: 130 }, (_, index) => bounds(index * 2, index * 2 + 1));
    const compacted = compactProbeBounds(source);
    expect(compacted).toHaveLength(64);
    expect(compacted[0]!.min[0]).toBe(0);
    expect(compacted.at(-1)!.max[0]).toBe(259);
    expect(() => compactProbeBounds(source, 65)).toThrow(/0\.\.64/);
  });

  it("snapshots occluder bounds in canonical id order for probe relocation", () => {
    const cache = new ProbeSurfaceCache();
    expect(cache.snapshotBounds()).toEqual([]);
    cache.upsert({ id: "b-wall", revision: 1, bounds: bounds(2, 3) });
    cache.upsert({ id: "a-wall", revision: 1, bounds: bounds(0, 1) });
    expect(cache.snapshotBounds()).toEqual([bounds(0, 1), bounds(2, 3)]);
    cache.remove("b-wall");
    expect(cache.snapshotBounds()).toEqual([bounds(0, 1)]);
  });
});
