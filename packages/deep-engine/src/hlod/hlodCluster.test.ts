import { describe, expect, it } from "vitest";
import { buildHlodTree, contentHash64, enclosingSphere, resolveHlodClusterOptions,
  validateHlodInstances } from "./hlodCluster.js";
import { HLOD_ALGORITHM_VERSION, HLOD_CLUSTER_DEFAULTS, HlodError,
  type HlodClusterNode, type HlodInstanceInput } from "./hlodTypes.js";

const point = (id: string, x: number, y: number, z: number, radius = 0.5): HlodInstanceInput =>
  ({ id, position: [x, y, z], radius });

const grid = (count: number, spacing = 2): HlodInstanceInput[] => Array.from({ length: count }, (_, index) =>
  point(`i${String(index).padStart(5, "0")}`, (index % 16) * spacing, Math.floor(index / 256) * spacing,
    Math.floor(index / 16) % 16 * spacing));

describe("T26 HLOD cluster options and input validation", () => {
  it("resolves documented defaults and rejects out-of-domain options", () => {
    expect(resolveHlodClusterOptions()).toEqual(HLOD_CLUSTER_DEFAULTS);
    expect(resolveHlodClusterOptions({ maxChildren: 4, maxDepth: 32 }))
      .toEqual({ maxChildren: 4, maxDepth: 32 });
    expect(() => resolveHlodClusterOptions({ maxChildren: 1 })).toThrow(HlodError);
    expect(() => resolveHlodClusterOptions({ maxChildren: 65 })).toThrow(HlodError);
    expect(() => resolveHlodClusterOptions({ maxDepth: 0 })).toThrow(HlodError);
    expect(() => resolveHlodClusterOptions(null as never)).toThrow(HlodError);
  });

  it("fails closed on duplicate ids, non-finite inputs and negative radius", () => {
    expect(() => validateHlodInstances([point("a", 0, 0, 0), point("a", 1, 0, 0)]))
      .toThrow(/Duplicate HLOD instance id/);
    expect(() => validateHlodInstances([point("a", Number.NaN, 0, 0)])).toThrow(/finite/);
    expect(() => validateHlodInstances([{ id: "a", position: [0, 0] as never, radius: 1 }])).toThrow(/3 finite/);
    expect(() => validateHlodInstances([point("a", 0, 0, 0, -1)])).toThrow(/nonnegative/);
    expect(() => validateHlodInstances([{ id: "", position: [0, 0, 0], radius: 0 }])).toThrow(/non-empty/);
    expect(validateHlodInstances([])).toEqual([]);
    // 规范序:与输入顺序无关,按 id 升序返回。
    expect(validateHlodInstances([point("b", 1, 0, 0), point("a", 0, 0, 0)]).map(i => i.id)).toEqual(["a", "b"]);
  });
});

describe("T26 HLOD aggregation tree structure", () => {
  it("builds one leaf per instance with consistent structural invariants", () => {
    const instances = grid(1_000);
    const tree = buildHlodTree(instances, { maxChildren: 8 });
    expect(tree.algorithmVersion).toBe(HLOD_ALGORITHM_VERSION);
    expect(tree.stats.leafCount).toBe(1_000);
    expect(tree.leafByInstance.size).toBe(1_000);
    expect(tree.stats.nodeCount).toBe(tree.stats.leafCount + tree.stats.internalCount);
    expect(tree.stats.maxFanout).toBeLessThanOrEqual(8);
    for (const [instanceId, leafId] of tree.leafByInstance) {
      const leaf = tree.nodes.get(leafId)!;
      expect(leaf.children).toHaveLength(0);
      expect(leaf.instanceIds).toEqual([instanceId]);
      expect(leaf.level).toBe(0);
    }
    for (const node of tree.nodes.values()) {
      expect(node.instanceIds.length).toBe(node.instanceCount);
      if (node.children.length === 0) expect(node.instanceCount).toBe(1);
      else expect(node.instanceCount).toBe(node.children.reduce((sum, child) =>
        sum + tree.nodes.get(child)!.instanceCount, 0));
      for (const childId of node.children) expect(tree.nodes.get(childId)).toBeDefined();
      if (tree.parentByNode.get(node.id) === null) expect(node.id).toBe(tree.rootId);
    }
    expect(tree.parentByNode.size).toBe(tree.stats.nodeCount);
  });

  it("keeps every child sphere inside its parent sphere (conservative proxy bounds)", () => {
    const tree = buildHlodTree(grid(2_000), { maxChildren: 8 });
    for (const node of tree.nodes.values()) {
      if (node.children.length === 0) continue;
      for (const childId of node.children) {
        const child = tree.nodes.get(childId)!;
        const distance = Math.hypot(child.center[0] - node.center[0], child.center[1] - node.center[1],
          child.center[2] - node.center[2]);
        expect(distance + child.radius).toBeLessThanOrEqual(node.radius + 1e-9);
      }
      expect(node.level).toBe(Math.max(...node.children.map(child =>
        tree.nodes.get(child)!.level)) + 1);
    }
  });

  it("honours terminal aggregation: maxChildren leaves share one parent at depth 1", () => {
    const tree = buildHlodTree(grid(8), { maxChildren: 8 });
    expect(tree.rootId).not.toBeNull();
    const root = tree.nodes.get(tree.rootId!)!;
    expect(root.children).toHaveLength(8);
    expect(root.children.every(child => tree.nodes.get(child)!.children.length === 0)).toBe(true);
    expect(tree.stats.depth).toBe(1);
    expect(tree.stats.internalCount).toBe(1);
  });

  it("handles degenerate sets: empty, single instance and fully co-located points", () => {
    const empty = buildHlodTree([]);
    expect(empty.rootId).toBeNull();
    expect(empty.stats.nodeCount).toBe(0);
    expect(empty.stats.depth).toBe(0);

    const single = buildHlodTree([point("only", 1, 2, 3, 0.25)]);
    expect(single.stats.leafCount).toBe(1);
    expect(single.nodes.get(single.rootId!)!.children).toHaveLength(0);
    expect(single.stats.depth).toBe(0);

    const colocated = buildHlodTree([point("c", 5, 5, 5), point("a", 5, 5, 5), point("b", 5, 5, 5),
      point("d", 5, 5, 5), point("e", 5, 5, 5), point("f", 5, 5, 5), point("g", 5, 5, 5),
      point("h", 5, 5, 5), point("i", 5, 5, 5)], { maxChildren: 4 });
    expect(colocated.stats.leafCount).toBe(9);
    expect(colocated.stats.depth).toBeLessThanOrEqual(colocated.options.maxDepth);
    for (const leafId of colocated.leafByInstance.values()) {
      expect(colocated.nodes.get(leafId)!.radius).toBe(0.5);
    }
  });
});

describe("T26 HLOD determinism contract", () => {
  it("rebuilds the identical tree from identical input (byte-level)", () => {
    const digest = (nodes: ReadonlyMap<string, HlodClusterNode>): string => JSON.stringify(
      [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)).map(node => [node.id, node.level,
        node.cell, node.children, node.instanceIds, node.instanceCount, node.center, node.radius]));
    const first = buildHlodTree(grid(3_000));
    const second = buildHlodTree(grid(3_000));
    expect(digest(second.nodes)).toBe(digest(first.nodes));
    expect([...second.leafByInstance.entries()]).toEqual([...first.leafByInstance.entries()]);
  });

  it("is invariant to input permutation: same set in any order yields the same tree", () => {
    const instances = grid(600);
    const reference = buildHlodTree(instances);
    const permutations = [
      [...instances].reverse(),
      instances.slice(137).concat(instances.slice(0, 137)),
      instances.slice(0, 64).concat(instances.slice(64).reverse()),
    ];
    for (const permuted of permutations) {
      const tree = buildHlodTree(permuted);
      expect(tree.rootId).toBe(reference.rootId);
      expect(tree.stats).toEqual(reference.stats);
      for (const [id, node] of reference.nodes) expect(tree.nodes.get(id)).toEqual(node);
    }
  });

  it("derives content ids purely from content: identical subtrees hash identically", () => {
    expect(contentHash64("L\u0000a\u00001,2,3,0.5")).toBe(contentHash64("L\u0000a\u00001,2,3,0.5"));
    expect(contentHash64("L\u0000a\u00001,2,3,0.5")).not.toBe(contentHash64("L\u0000a\u00001,2,3,0.6"));
    expect(contentHash64("C\u0000x\u0000y")).not.toBe(contentHash64("C\u0000y\u0000x"));
  });
});

describe("T26 HLOD enclosing sphere", () => {
  it("computes the conservative enclosing sphere of child spheres deterministically", () => {
    const leafOf = (id: string, x: number, radius: number): HlodClusterNode =>
      buildHlodTree([point(id, x, 0, 0, radius)]).nodes.get(buildHlodTree([point(id, x, 0, 0, radius)]).rootId!)!;
    const leafA = leafOf("a", 0, 1);
    const leafB = leafOf("b", 4, 1);
    const sphere = enclosingSphere([leafA, leafB]);
    expect(sphere.center).toEqual([2, 0, 0]);
    expect(sphere.radius).toBe(3);
    // 半径 = max(‖center−child.center‖ + child.radius),恰好覆盖两球(AABB 中点 52):
    const stretched = enclosingSphere([leafA, leafOf("c", 100, 5)]);
    expect(stretched.center).toEqual([52, 0, 0]);
    expect(stretched.radius).toBe(53);
    expect(enclosingSphere([])).toEqual({ center: [0, 0, 0], radius: 0 });
  });
});
