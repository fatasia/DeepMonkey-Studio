import { describe, expect, it } from "vitest";
import { buildHlodTree } from "./hlodCluster.js";
import { decideHlodFrame } from "./hlodDecision.js";
import { updateHlodTree } from "./hlodIncremental.js";
import { HLOD_CLUSTER_DEFAULTS, HlodError, type HlodClusterNode, type HlodClusterTree,
  type HlodInstanceInput } from "./hlodTypes.js";

const cube = (x: number, y: number, z: number, spacing = 2): HlodInstanceInput[] => {
  const instances: HlodInstanceInput[] = [];
  for (let iz = 0; iz < z; iz++) for (let iy = 0; iy < y; iy++) for (let ix = 0; ix < x; ix++) {
    instances.push({ id: `c${String(instances.length).padStart(4, "0")}`,
      position: [(ix - (x - 1) / 2) * spacing, (iy - (y - 1) / 2) * spacing, (iz - (z - 1) / 2) * spacing],
      radius: 0.5 });
  }
  return instances;
};

/** 树的规范摘要:与对象身份无关的逐位内容(增量 ≡ 全量重建的断言载体)。 */
const treeDigest = (tree: HlodClusterTree): string => JSON.stringify({
  algorithmVersion: tree.algorithmVersion, options: tree.options, rootCell: tree.rootCell,
  rootId: tree.rootId, stats: tree.stats,
  nodes: [...tree.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)).map(node => [node.id, node.level,
    node.cell, node.children, node.instanceIds, node.instanceCount, node.center, node.radius]),
  leaves: [...tree.leafByInstance.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  parents: [...tree.parentByNode.entries()].sort((a, b) => a[0].localeCompare(b[0])),
});

/** 前树中子树包含指定实例的全部节点 id(内容祖先闭包,含叶)。 */
const closureOf = (tree: HlodClusterTree, instanceIds: readonly string[]): Set<string> => {
  const wanted = new Set(instanceIds);
  const closure = new Set<string>();
  for (const [nodeId, node] of tree.nodes) {
    if (node.instanceIds.some(id => wanted.has(id))) closure.add(nodeId);
  }
  return closure;
};

/** 与构建器同一规则的下钻:position 将落入的胞元节点链(含终端聚合胞元)。 */
const descentPath = (tree: HlodClusterTree, position: readonly [number, number, number]): string[] => {
  const path: string[] = [];
  let node: HlodClusterNode = tree.nodes.get(tree.rootId!)!;
  for (;;) {
    path.push(node.id);
    const kids = node.children.map(id => tree.nodes.get(id)!);
    if (kids.length === 0) break;
    const octreeSplit = kids.length > 1 && kids.every(kid => kid.cell.side < node.cell.side);
    if (!octreeSplit) break; // 终端聚合(子=同胞元叶)或 tie-split:该胞元吸收变更
    const octant = (position[0] >= node.cell.center[0] ? 1 : 0)
      | (position[1] >= node.cell.center[1] ? 2 : 0) | (position[2] >= node.cell.center[2] ? 4 : 0);
    const child = kids.find(kid =>
      ((kid.cell.center[0] > node.cell.center[0] ? 1 : 0)
        | (kid.cell.center[1] > node.cell.center[1] ? 2 : 0)
        | (kid.cell.center[2] > node.cell.center[2] ? 4 : 0)) === octant);
    if (!child) break;
    node = child;
  }
  return path;
};

const union = (...sets: readonly Iterable<string>[]): Set<string> =>
  new Set(sets.flatMap(set => [...set]));

/** 落点胞元若已满(maxChildren):新增成员触发终端聚合分裂,其子树全部叶获得新子胞元。 */
const landingOverflow = (tree: HlodClusterTree, position: readonly [number, number, number],
  excludeInstanceId?: string): string[] => {
  const path = descentPath(tree, position);
  const last = tree.nodes.get(path[path.length - 1]!)!;
  if (last.children.length === 0 || last.instanceCount < HLOD_CLUSTER_DEFAULTS.maxChildren
    || (excludeInstanceId !== undefined && last.instanceIds.includes(excludeInstanceId))) return [];
  const ids: string[] = [];
  const walk = (nodeId: string): void => {
    ids.push(nodeId);
    for (const child of tree.nodes.get(nodeId)!.children) walk(child);
  };
  walk(last.id);
  return ids;
};

/** 计数守恒:复用 = 前树 − 预期变化集;重建 = 新树 − 复用。 */
const expectAccounting = (previous: HlodClusterTree, expected: Set<string>,
  tree: HlodClusterTree, delta: { reusedNodes: number; rebuiltNodes: number }): void => {
  expect(delta.reusedNodes).toBe(previous.stats.nodeCount - expected.size);
  expect(delta.rebuiltNodes).toBe(tree.stats.nodeCount - delta.reusedNodes);
};

describe("T26 incremental update: locality proof", () => {
  const previous = buildHlodTree(cube(8, 8, 8), { maxChildren: 8 });

  it("moves one instance in-bounds: rebuilds exactly the union of old and new cell paths, reuses the rest by reference", () => {
    const movedId = "c0207";
    const newPosition = [6, 6, 6] as const;
    const expected = union(closureOf(previous, [movedId]), descentPath(previous, newPosition),
      landingOverflow(previous, newPosition, movedId));
    expect(expected.size).toBeGreaterThanOrEqual(previous.stats.depth + 1);
    const { tree, delta } = updateHlodTree(previous,
      { moved: [{ id: movedId, position: newPosition, radius: 0.5 }] });
    expect(tree.rootCell).toEqual(previous.rootCell);
    for (const [nodeId, node] of previous.nodes) {
      if (expected.has(nodeId)) {
        // 成员集变化的胞元内容必变 → 旧 id 消失(新内容 ⇒ 新哈希)。
        expect(tree.nodes.has(nodeId)).toBe(false);
      } else {
        // 成员集不变的子树:边界几何与成员都不变 → **同一对象**复用。
        expect(tree.nodes.get(nodeId)).toBe(node);
      }
    }
    expectAccounting(previous, expected, tree, delta);
  });

  it("localizes a pure addition to the descent path of the new position", () => {
    const position = [2.5, -3.5, 0.5] as const;
    const expected = union(descentPath(previous, position), landingOverflow(previous, position));
    const { tree, delta } = updateHlodTree(previous, { added: [{ id: "probe", position, radius: 0.5 }] });
    for (const [nodeId, node] of previous.nodes) {
      if (expected.has(nodeId)) expect(tree.nodes.has(nodeId)).toBe(false);
      else expect(tree.nodes.get(nodeId)).toBe(node);
    }
    expectAccounting(previous, expected, tree, delta);
    expect(tree.leafByInstance.get("probe")).toBeDefined();
  });

  it("localizes a removal to the content closure of the removed instance", () => {
    const removedId = "c0404";
    const expected = closureOf(previous, [removedId]);
    const { tree, delta } = updateHlodTree(previous, { removed: [removedId] });
    for (const [nodeId, node] of previous.nodes) {
      if (expected.has(nodeId)) expect(tree.nodes.has(nodeId)).toBe(false);
      else expect(tree.nodes.get(nodeId)).toBe(node);
    }
    expectAccounting(previous, expected, tree, delta);
    expect(tree.leafByInstance.has(removedId)).toBe(false);
  });

  it("matches a from-scratch rebuild bit-for-bit after any change sequence", () => {
    const { tree } = updateHlodTree(previous,
      { moved: [{ id: "c0000", position: [6, -5, 7], radius: 0.75 }] });
    const fresh = buildHlodTree(cube(8, 8, 8).map(instance => instance.id === "c0000"
      ? { id: "c0000", position: [6, -5, 7], radius: 0.75 } : instance), { maxChildren: 8 });
    expect(treeDigest(tree)).toBe(treeDigest(fresh));

    const { tree: afterAdd } = updateHlodTree(previous,
      { added: [{ id: "new-1", position: [3, 3, 3], radius: 1 }] });
    expect(treeDigest(afterAdd)).toBe(treeDigest(buildHlodTree([...cube(8, 8, 8),
      { id: "new-1", position: [3, 3, 3], radius: 1 }], { maxChildren: 8 })));

    const { tree: afterRemove } = updateHlodTree(previous, { removed: ["c0404"] });
    expect(treeDigest(afterRemove)).toBe(treeDigest(buildHlodTree(
      cube(8, 8, 8).filter(instance => instance.id !== "c0404"), { maxChildren: 8 })));
  });

  it("reuses the entire tree verbatim for a no-op move (same object identity at the root)", () => {
    const original = previous.nodes.get(previous.rootId!)!;
    const old = previous.nodes.get(previous.leafByInstance.get("c0303")!)!;
    const { tree, delta } = updateHlodTree(previous,
      { moved: [{ id: "c0303", position: old.center, radius: 0.5 }] });
    expect(delta.rebuiltNodes).toBe(0);
    expect(delta.reusedNodes).toBe(previous.stats.nodeCount);
    expect(tree.nodes.get(tree.rootId!)).toBe(original);
    expect(treeDigest(tree)).toBe(treeDigest(previous));
  });

  it("keeps multiple moves local to the union of their old and new paths", () => {
    const movedIds = ["c0100", "c0222", "c0456"];
    const targets = [[6, -4, 5], [4, -6, 7], [5, -3, 6]] as const;
    const expected = union(...movedIds.map((id, index) => union(
      closureOf(previous, [id]),
      descentPath(previous, targets[index]!),
      landingOverflow(previous, targets[index]!, id))));
    const { tree, delta } = updateHlodTree(previous, { moved: movedIds.map((id, index) =>
      ({ id, position: targets[index]!, radius: 0.6 })) });
    for (const [nodeId, node] of previous.nodes) {
      if (expected.has(nodeId)) continue;
      expect(tree.nodes.get(nodeId)).toBe(node);
    }
    expectAccounting(previous, expected, tree, delta);
  });

  it("re-roots honestly when escaping the root cell: changed members always rebuild, aligned subtrees may converge and be reused", () => {
    const movedId = "c0000";
    const { tree, delta } = updateHlodTree(previous,
      { moved: [{ id: movedId, position: [40, 0, 0], radius: 0.5 }] });
    // 根胞元变化(边长升 2 的幂);重定根后结果仍 ≡ 全量重建。
    expect(tree.rootCell).not.toEqual(previous.rootCell);
    const fresh = buildHlodTree(cube(8, 8, 8).map(instance => instance.id === movedId
      ? { id: movedId, position: [40, 0, 0], radius: 0.5 } : instance), { maxChildren: 8 });
    expect(treeDigest(tree)).toBe(treeDigest(fresh));
    // 含变更实例的子树必重建(内容指纹变 → id 变):
    for (const [nodeId, node] of previous.nodes) {
      if (node.instanceIds.includes(movedId)) expect(tree.nodes.has(nodeId)).toBe(false);
    }
    // 压缩下探收敛:根网格对齐(center 同为 0、边长同为 2 的幂)时,不含变更实例的
    // 深子树最小包围胞元不变 → 部分复用(既非全树重建,也非零复用)。
    expect(delta.reusedNodes).toBeGreaterThan(0);
    expect(delta.reusedNodes).toBeLessThan(previous.stats.nodeCount);
  });

  it("drains to the empty tree and rebuilds on re-add", () => {
    const instances = cube(4, 4, 4);
    let current = buildHlodTree(instances);
    for (let index = 0; index < instances.length; index++) {
      const { tree } = updateHlodTree(current, { removed: [instances[index]!.id] });
      current = tree;
    }
    expect(current.rootId).toBeNull();
    expect(current.stats.nodeCount).toBe(0);
    const { tree: restored, delta } = updateHlodTree(current,
      { added: [{ id: "reborn", position: [0, 0, 0], radius: 1 }] });
    expect(restored.rootId).not.toBeNull();
    expect(restored.stats.leafCount).toBe(1);
    expect(delta.rebuiltNodes).toBe(1);
  });

  it("propagates decisions identically: incremental tree decides like the fresh rebuild", () => {
    const camera = { position: [0, 0, 500] as const, forward: [0, 0, -1] as const,
      viewportHeightPixels: 540, tanHalfFovY: Math.tan(Math.PI / 8), pixelThreshold: 1 };
    const { tree } = updateHlodTree(previous, { moved: [{ id: "c0111", position: [6, 1.5, -3], radius: 0.5 }] });
    const fresh = buildHlodTree(cube(8, 8, 8).map(instance => instance.id === "c0111"
      ? { id: "c0111", position: [6, 1.5, -3], radius: 0.5 } : instance), { maxChildren: 8 });
    expect(JSON.stringify(decideHlodFrame(tree, camera)))
      .toBe(JSON.stringify(decideHlodFrame(fresh, camera)));
  });

  it("fails closed on unknown/duplicate change targets", () => {
    expect(() => updateHlodTree(previous, { removed: ["ghost"] })).toThrow(HlodError);
    expect(() => updateHlodTree(previous, { moved: [{ id: "ghost", position: [0, 0, 0], radius: 1 }] }))
      .toThrow(HlodError);
    expect(() => updateHlodTree(previous, { added: [{ id: "c0000", position: [0, 0, 0], radius: 1 }] }))
      .toThrow(/already exists/);
  });

  it("accepts explicit option changes and stays identical to a fresh build under them", () => {
    const { tree } = updateHlodTree(previous, { added: [{ id: "extra", position: [1, 1, 1], radius: 0.5 }] },
      { maxChildren: 4, maxDepth: 32 });
    expect(tree.options).toEqual({ maxChildren: 4, maxDepth: 32 });
    expect(treeDigest(tree)).toBe(treeDigest(buildHlodTree([...cube(8, 8, 8),
      { id: "extra", position: [1, 1, 1], radius: 0.5 }], { maxChildren: 4, maxDepth: 32 })));
  });

  it("keeps node objects frozen and structurally consistent after incremental updates", () => {
    const { tree } = updateHlodTree(previous, { added: [{ id: "frozen", position: [2, 2, 2], radius: 0.5 }] });
    const sample = [...tree.nodes.values()][0] as HlodClusterNode;
    expect(Object.isFrozen(sample)).toBe(true);
    expect(tree.parentByNode.get(tree.rootId!)).toBeNull();
    for (const [nodeId, parent] of tree.parentByNode) {
      if (parent === null) { expect(nodeId).toBe(tree.rootId); continue; }
      expect(tree.nodes.get(parent)!.children).toContain(nodeId);
    }
  });
});
