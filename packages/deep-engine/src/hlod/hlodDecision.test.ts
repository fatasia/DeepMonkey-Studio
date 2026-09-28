import { describe, expect, it } from "vitest";
import { buildHlodTree } from "./hlodCluster.js";
import { decideHlodCluster, decideHlodFrame, hlodScreenErrorPixels,
  resolveHlodDecisionOptions } from "./hlodDecision.js";
import { HLOD_DECISION_DEFAULTS, HlodError, type HlodClusterNode,
  type HlodInstanceInput } from "./hlodTypes.js";
import type { ClusterLodCamera } from "../rayTracing/clusterLodSelection.js";

/** 沿 −z 注视原点的相机:depth = center.z 到 eye 的距离。 */
const cameraAt = (distance: number, overrides: Partial<ClusterLodCamera> = {}): ClusterLodCamera => ({
  position: [0, 0, distance],
  forward: [0, 0, -1],
  viewportHeightPixels: 540,
  tanHalfFovY: Math.tan(Math.PI / 8),
  pixelThreshold: 1,
  ...overrides,
});

const row = (count: number, spacing = 2): HlodInstanceInput[] =>
  Array.from({ length: count }, (_, index) =>
    ({ id: `n${String(index).padStart(3, "0")}`, position: [index * spacing, 0, 0], radius: 0.5 }));

/** 居中于原点的立方网格(决定性维序:x 最快,y 层最慢),供相机正对场景中心。 */
const cube = (x: number, y: number, z: number, spacing = 2): HlodInstanceInput[] => {
  const instances: HlodInstanceInput[] = [];
  for (let iz = 0; iz < z; iz++) for (let iy = 0; iy < y; iy++) for (let ix = 0; ix < x; ix++) {
    instances.push({ id: `c${String(instances.length).padStart(4, "0")}`,
      position: [(ix - (x - 1) / 2) * spacing, (iy - (y - 1) / 2) * spacing, (iz - (z - 1) / 2) * spacing],
      radius: 0.5 });
  }
  return instances;
};

const nodeOf = (tree: ReturnType<typeof buildHlodTree>, pathDown: number[]): HlodClusterNode => {
  let node = tree.nodes.get(tree.rootId!)!;
  for (const childIndex of pathDown) node = tree.nodes.get(node.children[childIndex]!)!;
  return node;
};

describe("T26 decision options and screen error formula", () => {
  it("resolves documented defaults and rejects out-of-domain values", () => {
    expect(resolveHlodDecisionOptions()).toEqual(HLOD_DECISION_DEFAULTS);
    expect(() => resolveHlodDecisionOptions({ targetPixelError: 0 })).toThrow(HlodError);
    expect(() => resolveHlodDecisionOptions({ hysteresisRatio: 0.5 })).toThrow(HlodError);
    expect(() => resolveHlodDecisionOptions(null as never)).toThrow(HlodError);
  });

  it("projects the cluster radius through the single-definition cluster screen error formula", () => {
    // radius 1 @ depth 10, fov π/4, 540px → 540/(2×10×tan(π/8)) ≈ 65.247px。
    const tree = buildHlodTree([{ id: "solo", position: [0, 0, 0], radius: 1 }]);
    const root = tree.nodes.get(tree.rootId!)!;
    const pixels = hlodScreenErrorPixels(root, cameraAt(10));
    expect(pixels).toBeCloseTo(540 / (20 * Math.tan(Math.PI / 8)), 9);
    // 决策与 clusterScreenError(逐式对应的 CPU/WGSL 参考)同值:边界构造。
    const probe = { boundsMin: [-1, -1, -1] as const, boundsMax: [1, 1, 1] as const, error: 1 };
    const camera = cameraAt(10);
    const depth = 10;
    expect(hlodScreenErrorPixels(root, camera))
      .toBeCloseTo(probe.error * camera.viewportHeightPixels / (2 * depth * camera.tanHalfFovY), 9);
  });
});

describe("T26 frame decision semantics", () => {
  // 8×8×8 立方(间距 2,半径 0.5):终端簇半径 ≈2m,根半径 ≈12.6m;
  // 每米投影像素 = 540/(2×d×tan(π/8)) ≈ 651.9/d → 距离 400:主体终端 3.3px 折叠、根 20.5px 下钻。
  const bodyTree = buildHlodTree(cube(8, 8, 8), { maxChildren: 8 });
  // 加一个远处离群点:其所在簇投影误差大 → 下钻渲染,主体折叠 → 混合前沿。
  const mixedTree = buildHlodTree([...cube(8, 8, 8),
    { id: "outlier", position: [400, 0, 0], radius: 0.5 }], { maxChildren: 8 });

  it("collapses the whole tree far away and renders every instance up close", () => {
    const far = decideHlodFrame(bodyTree, cameraAt(100_000));
    expect(far.collapsedNodes).toHaveLength(1);
    expect(far.collapsedNodes[0]!.nodeId).toBe(bodyTree.rootId);
    expect(far.renderedInstances).toBe(0);
    expect(far.hiddenInstances).toBe(512);
    expect(far.proxyCoverage).toBe(1);
    expect(far.visitedNodes).toBe(1);

    const near = decideHlodFrame(bodyTree, cameraAt(100));
    expect(near.collapsedNodes).toHaveLength(0);
    expect(near.renderedInstances).toBe(512);
    expect(near.hiddenInstances).toBe(0);
    expect(near.proxyCoverage).toBe(0);
  });

  it("produces a mixed frontier at intermediate distance with strict invariants", () => {
    const frame = decideHlodFrame(mixedTree, cameraAt(400));
    expect(frame.collapsedNodes.length).toBeGreaterThan(0);
    expect(frame.renderedInstances).toBeGreaterThan(0);
    expect(frame.hiddenInstances + frame.renderedInstances).toBe(513);
    expect(frame.visitedNodes).toBeLessThanOrEqual(mixedTree.stats.nodeCount);
    // 前沿不重叠:折叠簇覆盖的**叶**数 = hiddenInstances,且与渲染叶互斥(折叠即停的结构保证)。
    const collapsedIds = new Set(frame.collapsedNodes.map(decision => decision.nodeId));
    const hiddenLeaves = new Set<string>();
    const collectLeaves = (nodeId: string): void => {
      const node = mixedTree.nodes.get(nodeId)!;
      if (node.children.length === 0) { hiddenLeaves.add(nodeId); return; }
      for (const child of node.children) collectLeaves(child);
    };
    for (const id of collapsedIds) collectLeaves(id);
    expect(hiddenLeaves.size).toBe(frame.hiddenInstances);
    for (const leaf of frame.renderedLeaves) expect(hiddenLeaves.has(leaf)).toBe(false);
  });

  it("is monotone under retreat: hidden instances never decrease with distance", () => {
    let previousHidden = -1;
    for (const distance of [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096]) {
      const frame = decideHlodFrame(bodyTree, cameraAt(distance));
      expect(frame.hiddenInstances).toBeGreaterThanOrEqual(previousHidden);
      previousHidden = frame.hiddenInstances;
    }
  });

  it("is deterministic per (tree, camera, options, previousCollapsed)", () => {
    const camera = cameraAt(48);
    expect(JSON.stringify(decideHlodFrame(bodyTree, camera)))
      .toBe(JSON.stringify(decideHlodFrame(bodyTree, camera)));
  });

  it("applies hysteresis only to previously collapsed clusters and within the explicit band", () => {
    // 构造 screenError 恰落在 (threshold, (1+h)×threshold] 区间的簇。
    const threshold = 8;
    const hysteresis = 0.5;
    const options = { targetPixelError: threshold, hysteresisRatio: hysteresis };
    // depth 10 → radius 阈值 = threshold×2×depth×tanHalfFov/540;取 radius 使误差 = 1.2×threshold。
    const tanHalf = Math.tan(Math.PI / 8);
    const radius = 1.2 * threshold * 2 * 10 * tanHalf / 540;
    const clusterTree = buildHlodTree([
      { id: "l", position: [-radius, 0, 0], radius: 0 },
      { id: "r", position: [radius, 0, 0], radius: 0 },
    ], { maxChildren: 8 });
    const root = clusterTree.nodes.get(clusterTree.rootId!)!;
    const camera = cameraAt(10);
    expect(hlodScreenErrorPixels(root, camera)).toBeCloseTo(threshold * 1.2, 6);

    const strict = decideHlodCluster(root, camera, options);
    expect(strict.collapsed).toBe(false);
    expect(strict.heldByHysteresis).toBe(false);
    const held = decideHlodCluster(root, camera, options, true);
    expect(held.collapsed).toBe(true);
    expect(held.heldByHysteresis).toBe(true);
    // 超出 (1+h)× 阈值 → 即使上帧折叠也下钻:depth 7 → 误差 1.2T×10/7 ≈ 1.71T > 1.5T。
    const outside = decideHlodCluster(root, cameraAt(7), options, true);
    expect(outside.collapsed).toBe(false);
    expect(outside.heldByHysteresis).toBe(false);
  });

  it("renders leaves even when their own projected error exceeds the threshold", () => {
    const soloTree = buildHlodTree([{ id: "big", position: [0, 0, 0], radius: 1_000 }]);
    const frame = decideHlodFrame(soloTree, cameraAt(10));
    expect(frame.renderedLeaves).toHaveLength(1);
    expect(frame.collapsedNodes).toHaveLength(0);
    expect(frame.renderedInstances).toBe(1);
  });

  it("handles the empty tree and fails closed on invalid cameras", () => {
    const empty = buildHlodTree([]);
    const frame = decideHlodFrame(empty, cameraAt(10));
    expect(frame.renderedInstances).toBe(0);
    expect(frame.proxyCoverage).toBe(0);
    expect(frame.visitedNodes).toBe(0);
    expect(() => decideHlodFrame(bodyTree, cameraAt(10, { forward: [0, 0, 0] }))).toThrow(HlodError);
    expect(() => decideHlodFrame(bodyTree, cameraAt(10, { tanHalfFovY: -1 }))).toThrow(HlodError);
    expect(() => decideHlodFrame(bodyTree, cameraAt(Number.NaN))).toThrow(HlodError);
  });

  it("descends along deeper frontiers for taller trees without touching collapsed subtrees", () => {
    const tall = buildHlodTree([...cube(10, 10, 20), { id: "outlier", position: [500, 0, 0], radius: 0.5 }],
      { maxChildren: 4 });
    const mid = decideHlodFrame(tall, cameraAt(400));
    expect(mid.collapsedNodes.length).toBeGreaterThan(1);
    expect(new Set(mid.collapsedNodes.map(decision => decision.level)).size).toBeGreaterThan(0);
    // 中距下既有折叠簇又有渲染叶(混合前沿,层级 > 1)。
    expect(mid.renderedInstances).toBeGreaterThan(0);
    expect(tall.stats.depth).toBeGreaterThan(2);
  });

  it("keeps node reference navigation sound via nodeOf helper (self-check)", () => {
    expect(nodeOf(bodyTree, [0]).children.length).toBeGreaterThan(0);
  });
});
