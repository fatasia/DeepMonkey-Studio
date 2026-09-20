import { describe, expect, it } from "vitest";
import { MESHLET_DRAW_INDEXED_INDIRECT_STRIDE } from "../webgpu/meshletIndirectTypes.js";
import { bakeClusterLodDag } from "./clusterLodBake.js";
import { validateClusterLodDag, type ClusterLodDagDescriptor } from "./clusterLodDag.js";
import { CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES, deriveClusterLodFrontier, planClusterLodIndirect,
  type ClusterLodLevelGeometrySummary } from "./clusterLodIndirectPlan.js";
import { CLUSTER_LOD_REFINE_SENTINEL, clusterScreenError, selectClusterLod, type ClusterLodCamera,
} from "./clusterLodSelection.js";

/**
 * 走廊网格 32×16（1024 三角形，8 条带状 cluster 沿 y 展开）。bake 的朴素父子链接产出
 * 「金字塔区（l2→l1→c0..c3）+ 自由叶区（c4..c7）」：自由区保持 L0，金字塔区随阈值
 * 0→1→2 粗化 —— 这给出真正的混合层级前沿（同帧同时绘粗层与细层）。
 */
function corridorMesh(): { vertices: Float32Array; indices: Uint32Array } {
  const nx = 32, ny = 16, strideX = nx + 1;
  const vertices = new Float32Array(strideX * (ny + 1) * 3);
  for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
    vertices.set([x, y, Math.sin(x * 0.35 + y * 0.9)], (y * strideX + x) * 3);
  }
  const indices: number[] = [];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const a = y * strideX + x, b = a + 1, c = a + strideX, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { vertices, indices: Uint32Array.from(indices) };
}

function bakedCorridor(): ReturnType<typeof bakeClusterLodDag> {
  const mesh = corridorMesh();
  return bakeClusterLodDag({ geometryId: "indirect-corridor", vertices: mesh.vertices,
    indices: mesh.indices, level0ClusterSize: 128, levelCount: 3 });
}

function levelSummaries(baked: ReturnType<typeof bakeClusterLodDag>): ClusterLodLevelGeometrySummary[] {
  return baked.levelGeometry.map(geometry => ({
    vertexCount: geometry.vertices.length / 3, indexCount: geometry.indices.length }));
}

function cameraAt(position: readonly [number, number, number], forward: readonly [number, number, number],
  pixelThreshold = 1): ClusterLodCamera {
  return { position, forward, viewportHeightPixels: 1080, tanHalfFovY: Math.tan(Math.PI / 6), pixelThreshold };
}

/** 相机在走廊近端沿 +y 看：自由叶区（c4..c7）在远端，是混合前沿的基准机位。 */
const CORRIDOR_CAMERA = cameraAt([16, -2, 0.5], [0, 1, 0]);
/** 案例有效性门槛：每中间层节点屏幕误差距阈值至少 5%（远超 f32 舍入，对拍非边界侥幸）。 */
const MIN_MARGIN = 0.05;

function assertCaseMargin(dag: ClusterLodDagDescriptor, camera: ClusterLodCamera): void {
  for (const node of dag.nodes) {
    if (node.level === 0) continue; // 叶层误差恒 0，远离边界。
    const margin = Math.abs(clusterScreenError(node, camera) - camera.pixelThreshold) / camera.pixelThreshold;
    expect(margin, `node ${node.id} threshold margin`).toBeGreaterThanOrEqual(MIN_MARGIN);
  }
}

describe("cluster lod indirect plan", () => {
  const baked = bakedCorridor();
  const levels = levelSummaries(baked);
  const errPx = (id: string): number => clusterScreenError(baked.dag.nodes.find(node => node.id === id)!, CORRIDOR_CAMERA);
  // 阈值自实际屏幕误差派生（夹具对 bake 数值漂移稳健），期望前沿语义硬编码。
  const REFINE_ALL = errPx("l1-c0") * 0.6;   // 金字塔区下钻到叶层
  const STOP_AT_L1 = errPx("l1-c0") * 1.08;  // l1 过阈、根未过阈
  const STOP_AT_ROOT = errPx("l2-c0") * 1.2; // 根过阈

  it("consumes a valid bake shape (8 leaves -> 1 -> 1 root, free leaf regions included)", () => {
    expect(validateClusterLodDag(baked.dag)).toEqual({ valid: true });
    expect(baked.dag.nodes.filter(node => node.level === 0)).toHaveLength(8);
    expect(baked.dag.nodes.filter(node => node.level === 1)).toHaveLength(1);
    expect(baked.dag.nodes.filter(node => node.level === 2)).toHaveLength(1);
  });

  it("plans every leaf cluster at level 0 for a near camera", () => {
    const camera = cameraAt([16, 8, 40], [0, 0, -1]);
    assertCaseMargin(baked.dag, camera);
    const selection = selectClusterLod(baked.dag, camera);
    const plan = planClusterLodIndirect(baked.dag, selection.selection, levels);
    expect(plan.drawCount).toBe(8);
    expect(plan.draws.map(draw => draw.level)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    for (const draw of plan.draws) {
      expect(draw.indirectCommand).toEqual([draw.triangleCount * 3, 1, draw.firstIndex, 0, 0]);
      expect(draw.firstIndex).toBe(draw.firstTriangle * 3);
    }
    expect(plan.coveredRegions).toBe(5); // 金字塔区 + 4 个自由叶区
  });

  it("plans the coarsest root plus free leaf regions far away, slots distinct from frontier", () => {
    const camera = cameraAt([16, 8, 200000], [0, 0, -1]);
    assertCaseMargin(baked.dag, camera);
    const selection = selectClusterLod(baked.dag, camera);
    const plan = planClusterLodIndirect(baked.dag, selection.selection, levels);
    expect(plan.draws.map(draw => [draw.nodeId, draw.level]))
      .toEqual([["l2-c0", 2], ["l0-c4", 0], ["l0-c5", 0], ["l0-c6", 0], ["l0-c7", 0]]);
    const rootSpan = plan.levelSpans[2]!;
    expect(plan.draws[0]!.firstIndex).toBe(rootSpan.firstIndexBase);
    expect(plan.draws[0]!.indirectCommand[3]).toBe(rootSpan.baseVertex);
    // 槽位 ≠ 前沿：屏幕误差判定下全树过阈（kernel 逐节点独立），前沿闭合只留根 + 自由叶区。
    // CPU frontier 按 dag.nodes 遍历序；plan.draws 是消费用的从粗到细序（上一断言）。
    expect([...selection.selection]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
    expect(selection.frontier).toEqual(["l0-c4", "l0-c5", "l0-c6", "l0-c7", "l2-c0"]);
  });

  it("plans a mixed coarse-to-fine frontier matching the CPU reference", () => {
    const camera = { ...CORRIDOR_CAMERA, pixelThreshold: STOP_AT_L1 };
    assertCaseMargin(baked.dag, camera);
    const selection = selectClusterLod(baked.dag, camera);
    const plan = planClusterLodIndirect(baked.dag, selection.selection, levels);
    // 从粗到细排序：level 降序，同层保持 dag.nodes 顺序 —— l1 在前、自由叶区在后。
    expect(plan.draws.map(draw => [draw.nodeId, draw.level]))
      .toEqual([["l1-c0", 1], ["l0-c4", 0], ["l0-c5", 0], ["l0-c6", 0], ["l0-c7", 0]]);
    expect(deriveClusterLodFrontier(baked.dag, selection.selection).map(index => baked.dag.nodes[index]!.id).sort())
      .toEqual([...selection.frontier].sort());
  });

  it("keeps the frontier level monotone as the pixel threshold grows", () => {
    const sweep = [REFINE_ALL, STOP_AT_L1, STOP_AT_ROOT].map(pixelThreshold =>
      selectClusterLod(baked.dag, { ...CORRIDOR_CAMERA, pixelThreshold }));
    const maxFrontierLevel = (result: ReturnType<typeof selectClusterLod>): number =>
      Math.max(...result.frontier.map(id => baked.dag.nodes.find(node => node.id === id)!.level));
    expect(sweep.map(maxFrontierLevel)).toEqual([0, 1, 2]);
    const selectedAt = (result: ReturnType<typeof selectClusterLod>, index: number): boolean =>
      result.selection[index] !== CLUSTER_LOD_REFINE_SENTINEL;
    for (let index = 0; index < baked.dag.nodes.length; index++) {
      for (let step = 1; step < sweep.length; step++) {
        if (selectedAt(sweep[step - 1]!, index)) expect(selectedAt(sweep[step]!, index)).toBe(true);
      }
    }
  });

  it("accumulates level spans in levelGeometry order and places draws inside them", () => {
    const selection = selectClusterLod(baked.dag, { ...CORRIDOR_CAMERA, pixelThreshold: STOP_AT_ROOT });
    const plan = planClusterLodIndirect(baked.dag, selection.selection, levels);
    expect(plan.levelSpans.map(span => span.level)).toEqual([0, 1, 2]);
    expect(plan.levelSpans[0]!.firstIndexBase).toBe(0);
    expect(plan.levelSpans[0]!.baseVertex).toBe(0);
    expect(plan.levelSpans[1]!.firstIndexBase).toBe(levels[0]!.indexCount);
    expect(plan.levelSpans[2]!.firstIndexBase).toBe(levels[0]!.indexCount + levels[1]!.indexCount);
    expect(plan.levelSpans[2]!.baseVertex).toBe(levels[0]!.vertexCount + levels[1]!.vertexCount);
    for (const draw of plan.draws) {
      const span = plan.levelSpans[draw.level]!;
      expect(draw.firstIndex).toBe(span.firstIndexBase + draw.firstTriangle * 3);
      expect(draw.indirectCommand[3]).toBe(span.baseVertex);
      expect(draw.firstIndex).toBeLessThan(span.firstIndexBase + span.indexCount);
    }
  });

  it("emits draw-indexed-indirect records matching the webgpu executor stride contract", () => {
    expect(CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES).toBe(MESHLET_DRAW_INDEXED_INDIRECT_STRIDE);
    expect(CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES).toBe(20);
    const selection = selectClusterLod(baked.dag, { ...CORRIDOR_CAMERA, pixelThreshold: STOP_AT_ROOT });
    const plan = planClusterLodIndirect(baked.dag, selection.selection, levels);
    expect(plan.commandsByteLength).toBe(plan.drawCount * 20);
    for (const draw of plan.draws) {
      expect(draw.indirectCommand).toHaveLength(5);
      expect(draw.indirectCommand[0]).toBe(draw.triangleCount * 3);
      expect(draw.indirectCommand[1]).toBe(1);
      expect(draw.indirectCommand[4]).toBe(0);
    }
  });

  it("keeps unselected empty leaves as indexCount-0 no-op draws for frontier parity", () => {
    const dag: ClusterLodDagDescriptor = { geometryId: "empty-leaf", leafTriangleTotal: 1,
      nodes: [
        { id: "r", level: 1, error: 1, firstTriangle: 0, triangleCount: 1, children: ["e"],
          boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] },
        { id: "e", level: 0, error: 0, firstTriangle: 0, triangleCount: 0, children: [],
          boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] },
      ] };
    const selection = selectClusterLod(dag, cameraAt([0.5, 0.5, 4], [0, 0, -1]));
    const plan = planClusterLodIndirect(dag, selection.selection,
      [{ vertexCount: 1, indexCount: 3 }, { vertexCount: 1, indexCount: 3 }]);
    expect(selection.frontier).toEqual(["e"]);
    expect(plan.draws.map(draw => draw.nodeId)).toEqual(["e"]);
    expect(plan.draws[0]!.indirectCommand[0]).toBe(0);
  });

  it("fails closed on slot contamination, bad levels, duplicate parents and broken closure", () => {
    const selection = selectClusterLod(baked.dag, { ...CORRIDOR_CAMERA, pixelThreshold: STOP_AT_ROOT }).selection;
    expect(() => planClusterLodIndirect(baked.dag, selection.subarray(0, 3), levels)).toThrow("does not match DAG node count");
    const poisoned = Uint32Array.from(selection); poisoned[2] = 7;
    expect(() => planClusterLodIndirect(baked.dag, poisoned, levels)).toThrow("expected sentinel or node level");
    const negativeLevel: ClusterLodDagDescriptor = { ...baked.dag, nodes: baked.dag.nodes
      .map((node, index) => index === 0 ? { ...node, level: -1 } : node) };
    expect(() => planClusterLodIndirect(negativeLevel, Uint32Array.from(selection), levels)).toThrow("invalid level");
    const twoParents: ClusterLodDagDescriptor = { geometryId: "two-parents", leafTriangleTotal: 4, nodes: [
      { id: "p", level: 2, error: 1, firstTriangle: 0, triangleCount: 4, children: ["a", "b"],
        boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] },
      { id: "q", level: 2, error: 1, firstTriangle: 0, triangleCount: 4, children: ["b"],
        boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] },
      { id: "a", level: 0, error: 0, firstTriangle: 0, triangleCount: 2, children: [],
        boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] },
      { id: "b", level: 0, error: 0, firstTriangle: 2, triangleCount: 2, children: [],
        boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] },
    ] };
    expect(() => planClusterLodIndirect(twoParents, Uint32Array.from([2, 2, 0, 0]), levels)).toThrow("claimed by both");
    const uncovered: ClusterLodDagDescriptor = { geometryId: "open", leafTriangleTotal: 2, nodes: [
      { id: "r", level: 1, error: 1, firstTriangle: 0, triangleCount: 2, children: ["a", "b"],
        boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] },
      { id: "a", level: 0, error: 0, firstTriangle: 0, triangleCount: 1, children: [],
        boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] },
      { id: "b", level: 0, error: 0, firstTriangle: 1, triangleCount: 1, children: [],
        boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] },
    ] };
    // 全哨兵槽位（kernel 空批场景）：叶规则使每个叶子成为 no-op 前沿绘制，与 CPU 前沿逐点一致；
    // 闭合校验（validateLeafCoverage）是防御纵深，对验证过的槽位结构成立。
    const allSentinel = Uint32Array.from([CLUSTER_LOD_REFINE_SENTINEL, CLUSTER_LOD_REFINE_SENTINEL, CLUSTER_LOD_REFINE_SENTINEL]);
    const cpuFrontier = selectClusterLod(uncovered, cameraAt([0.5, 0.5, 4], [0, 0, -1])).frontier;
    const plan = planClusterLodIndirect(uncovered, allSentinel,
      [{ vertexCount: 1, indexCount: 3 }, { vertexCount: 1, indexCount: 3 }]);
    expect(plan.draws.map(draw => draw.nodeId)).toEqual([...cpuFrontier]);
    expect(plan.draws.map(draw => draw.level)).toEqual([0, 0]);
    expect(plan.coveredLeafClusters).toBe(2);
    expect(() => planClusterLodIndirect(baked.dag, Uint32Array.from(selection), levels.slice(0, 2)))
      .toThrow("do not cover DAG level");
    expect(() => planClusterLodIndirect(baked.dag, Uint32Array.from(selection),
      [{ vertexCount: 1, indexCount: -1 }, ...levels.slice(1)])).toThrow("nonnegative safe integers");
  });
});
