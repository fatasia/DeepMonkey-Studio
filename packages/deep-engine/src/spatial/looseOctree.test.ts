import { describe, expect, it } from "vitest";
import {
  aabbIntersects,
  LooseOctreeIndex,
  spatialAabb,
  spatialAabbFromCenter,
  SpatialIndexError,
  transformSpatialAabb,
  type SpatialAabb,
  type SpatialFrustum,
} from "../index.js";

const ROOT = spatialAabb([-100, -100, -100], [100, 100, 100]);
const BOX_FRUSTUM: SpatialFrustum = {
  planes: [
    [1, 0, 0, 10], [-1, 0, 0, 10],
    [0, 1, 0, 10], [0, -1, 0, 10],
    [0, 0, 1, 10], [0, 0, -1, 10],
  ],
};

describe("LooseOctreeIndex", () => {
  it("returns exact candidates in stable insertion order with explicit truncation", () => {
    const index = new LooseOctreeIndex({ bounds: ROOT });
    index.insert("east", box(20, 0, 0));
    index.insert("west", box(-20, 0, 0));
    index.insert("center", box(0, 0, 0));
    index.update("east", box(21, 0, 0));

    const result = index.queryAabb(spatialAabb([-30, -2, -2], [30, 2, 2]), { limit: 2 });
    expect(result).toMatchObject({ ids: ["east", "west"], matchedEntries: 3, truncated: true });
    expect(() => (result.ids as string[]).push("mutated")).toThrow();
    expect(index.queryAabb(ROOT).ids).toEqual(["east", "west", "center"]);
  });

  it("prunes a large sparse scene before exact entry tests", () => {
    const index = new LooseOctreeIndex<number>({
      bounds: spatialAabb([-32, -32, -32], [32, 32, 32]),
      maxDepth: 7,
    });
    let id = 0;
    for (let z = -15; z <= 15; z += 2) {
      for (let y = -15; y <= 15; y += 2) {
        for (let x = -15; x <= 15; x += 2) index.insert(id++, box(x, y, z, 0.1));
      }
    }
    const result = index.queryAabb(box(1, 1, 1, 0.2));
    expect(index.size).toBe(4096);
    expect(result.ids).toHaveLength(1);
    expect(result.testedEntries).toBeLessThan(64);
    expect(result.visitedNodes).toBeLessThan(64);
  });

  it("relocates dynamic entries, prunes empty branches, and keeps no-op revisions stable", () => {
    const index = new LooseOctreeIndex({ bounds: ROOT, maxDepth: 6 });
    index.insert("robot", box(-60, 0, 0));
    const populatedNodes = index.stats.nodes;
    expect(populatedNodes).toBeGreaterThan(1);
    const revision = index.revision;
    expect(index.update("robot", box(-60, 0, 0))).toBe(false);
    expect(index.revision).toBe(revision);

    expect(index.update("robot", box(-59.9, 0, 0))).toBe(true);
    expect(index.stats.nodes).toBe(populatedNodes);
    expect(index.queryAabb(box(-59.9, 0, 0, 1)).ids).toEqual(["robot"]);

    expect(index.update("robot", box(60, 0, 0))).toBe(true);
    expect(index.queryAabb(box(-60, 0, 0, 2)).ids).toEqual([]);
    expect(index.queryAabb(box(60, 0, 0, 2)).ids).toEqual(["robot"]);
    expect(index.remove("robot")).toBe(true);
    expect(index.remove("robot")).toBe(false);
    expect(index.stats.nodes).toBe(1);
  });

  it("keeps out-of-root entries queryable and migrates them back into the tree", () => {
    const index = new LooseOctreeIndex({ bounds: spatialAabb([-10, -10, -10], [10, 10, 10]) });
    index.insert("remote", box(40, 0, 0));
    expect(index.stats.overflowEntries).toBe(1);
    expect(index.queryAabb(box(40, 0, 0, 2)).ids).toEqual(["remote"]);
    expect(index.queryAabb(box(0, 0, 0, 2)).testedEntries).toBe(1);

    index.update("remote", box(4, 0, 0));
    expect(index.stats.overflowEntries).toBe(0);
    expect(index.queryAabb(box(4, 0, 0, 2)).ids).toEqual(["remote"]);
  });

  it("preserves query metrics and insertion order across boundary moves, removal, and rebuild", () => {
    const index = new LooseOctreeIndex({
      bounds: spatialAabb([-10, -10, -10], [10, 10, 10]),
      maxDepth: 0,
    });
    index.insert("first", box(0, 0, 0));
    index.insert("second", box(40, 0, 0));
    index.insert("third", box(10, 0, 0));

    expect(index.queryAabb(spatialAabb([-100, -100, -100], [100, 100, 100]))).toMatchObject({
      ids: ["first", "second", "third"],
      visitedNodes: 1,
      testedEntries: 3,
    });
    index.update("first", box(50, 0, 0));
    index.remove("second");
    index.insert("fourth", box(40, 0, 0));
    index.rebuild();

    expect(index.queryAabb(spatialAabb([-100, -100, -100], [100, 100, 100])).ids)
      .toEqual(["first", "third", "fourth"]);
    expect(index.queryAabb(box(50, 0, 0, 1))).toMatchObject({
      ids: ["first"],
      visitedNodes: 0,
      testedEntries: 2,
      matchedEntries: 1,
      truncated: false,
    });
  });

  it("degrades conservatively at the node budget without losing candidates", () => {
    const index = new LooseOctreeIndex({ bounds: ROOT, maxDepth: 8, maxNodes: 1 });
    index.insert("a", box(-80, -80, -80));
    index.insert("b", box(80, 80, 80));
    expect(index.stats).toMatchObject({ entries: 2, nodes: 1, budgetLimitedEntries: 2 });
    expect(index.queryAabb(box(-80, -80, -80, 2)).ids).toEqual(["a"]);
    index.remove("a");
    expect(index.stats.budgetLimitedEntries).toBe(1);
    index.rebuild();
    expect(index.queryAabb(ROOT).ids).toEqual(["b"]);
  });

  it("honors the configured looseness when assigning overlapping child cells", () => {
    const bounds = spatialAabb([-8, -8, -8], [8, 8, 8]);
    const tight = new LooseOctreeIndex({ bounds, maxDepth: 1, looseness: 1 });
    const loose = new LooseOctreeIndex({ bounds, maxDepth: 1, looseness: 2 });
    const crossing = spatialAabb([-2.5, 0.1, 0.1], [3.5, 6.1, 6.1]);
    tight.insert("part", crossing);
    loose.insert("part", crossing);
    expect(tight.stats.nodes).toBe(1);
    expect(loose.stats.nodes).toBe(2);
    expect(loose.queryAabb(crossing).ids).toEqual(["part"]);
  });

  it("filters query categories with unsigned masks", () => {
    const index = new LooseOctreeIndex({ bounds: ROOT });
    index.insert("visible", box(0, 0, 0), { mask: 0b001 });
    index.insert("shadow", box(0, 0, 0), { mask: 0b010 });
    index.insert("disabled", box(0, 0, 0), { mask: 0 });
    expect(index.queryAabb(ROOT, { mask: 0b001 }).ids).toEqual(["visible"]);
    expect(index.queryAabb(ROOT, { mask: 0b011 }).ids).toEqual(["visible", "shadow"]);
    expect(index.queryAabb(ROOT, { mask: 0 }).testedEntries).toBe(0);
  });

  it("uses normalized six-plane frusta and rejects malformed planes", () => {
    const index = new LooseOctreeIndex({ bounds: ROOT });
    index.insert("inside", box(8, 0, 0, 3));
    index.insert("outside", box(20, 0, 0));
    const scaled: SpatialFrustum = { planes: BOX_FRUSTUM.planes.map(
      ([x, y, z, d]) => [x * 5, y * 5, z * 5, d * 5] as const,
    ) };
    expect(index.queryFrustum(scaled).ids).toEqual(["inside"]);
    expect(() => index.queryFrustum({ planes: [[0, 0, 0, 1]] })).toThrowError(SpatialIndexError);
  });

  it("computes conservative world bounds for mirrored, non-uniform affine transforms", () => {
    const local = spatialAabb([-1, -2, -3], [1, 2, 3]);
    const transform = [
      -2, 0, 0, 0,
      1, 3, 0, 0,
      0, 0, 0.5, 0,
      10, -5, 2, 1,
    ];
    expect(transformSpatialAabb(local, transform)).toEqual({ min: [6, -11, 0.5], max: [14, 1, 3.5] });
    expectSpatialError(() => transformSpatialAabb(local, [...transform.slice(0, 15), 0]), "invalid-transform");
  });

  it("closes failed mutations without changing content, statistics, or revision", () => {
    const index = new LooseOctreeIndex({ bounds: ROOT, maxEntries: 1 });
    const mutable = { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] } as unknown as SpatialAabb;
    index.insert("stable", mutable);
    (mutable.min as number[])[0] = -50;
    const before = index.stats;
    expectSpatialError(() => index.insert("overflow", box(1, 1, 1)), "capacity-exceeded");
    expectSpatialError(() => index.insert("stable", box(1, 1, 1)), "duplicate-id");
    expectSpatialError(
      () => index.update("stable", { min: [Number.NaN, 0, 0], max: [1, 1, 1] }),
      "invalid-bounds",
    );
    expectSpatialError(
      () => index.update("stable", { min: ["0", 0, 0], max: [1, 1, 1] } as unknown as SpatialAabb),
      "invalid-bounds",
    );
    expectSpatialError(() => index.update("missing", box(0, 0, 0)), "missing-id");
    expect(index.stats).toEqual(before);
    expect(index.getBounds("stable")).toEqual(box(0, 0, 0));
  });

  it("matches a deterministic brute-force reference across tree and overflow entries", () => {
    const random = seededRandom(0xdecafbad);
    const index = new LooseOctreeIndex<number>({ bounds: ROOT, maxDepth: 7 });
    const entries: SpatialAabb[] = [];
    for (let id = 0; id < 600; id += 1) {
      const bounds = box(random() * 380 - 190, random() * 380 - 190, random() * 380 - 190, random() * 4);
      entries.push(bounds);
      index.insert(id, bounds);
    }
    for (let queryIndex = 0; queryIndex < 80; queryIndex += 1) {
      const query = box(random() * 400 - 200, random() * 400 - 200, random() * 400 - 200, 5 + random() * 25);
      const expected = entries.flatMap((bounds, id) => aabbIntersects(bounds, query) ? [id] : []);
      expect(index.queryAabb(query).ids).toEqual(expected);
    }
  });

  it("validates construction and query budgets and clears retained state", () => {
    expectSpatialError(() => new LooseOctreeIndex({ bounds: ROOT, looseness: 2.1 }), "invalid-options");
    expectSpatialError(
      () => new LooseOctreeIndex({ bounds: spatialAabb([0, 0, 0], [0, 1, 1]) }),
      "invalid-bounds",
    );
    const index = new LooseOctreeIndex({ bounds: ROOT, maxEntries: 2 });
    const empty = index.queryAabb(ROOT);
    expect(empty).toEqual({ ids: [], visitedNodes: 0, testedEntries: 0, matchedEntries: 0, truncated: false });
    expect(Object.isFrozen(empty)).toBe(true);
    index.upsert("point", spatialAabb([0, 0, 0], [0, 0, 0]));
    expectSpatialError(() => index.queryAabb(ROOT, { limit: 3 }), "invalid-query");
    expect(index.upsert("point", box(1, 1, 1))).toBe("updated");
    index.clear();
    expect(index.stats).toMatchObject({ entries: 0, nodes: 1, overflowEntries: 0 });
  });
});

function box(x: number, y: number, z: number, half = 0.5): SpatialAabb {
  return spatialAabbFromCenter([x, y, z], [half, half, half]);
}

function expectSpatialError(run: () => unknown, code: SpatialIndexError["code"]): void {
  try {
    run();
    throw new Error("Expected a SpatialIndexError.");
  } catch (error) {
    expect(error).toBeInstanceOf(SpatialIndexError);
    expect((error as SpatialIndexError).code).toBe(code);
  }
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
