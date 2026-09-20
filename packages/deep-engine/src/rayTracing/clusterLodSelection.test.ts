import { describe, expect, it } from "vitest";
import { bakeClusterLodDag } from "./clusterLodBake.js";
import { validateClusterLodDag, type ClusterLodDagDescriptor, type ClusterLodNodeDescriptor } from "./clusterLodDag.js";
import { CLUSTER_LOD_CAMERA_WORD, CLUSTER_LOD_CAMERA_UNIFORM_BYTES, CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD,
  CLUSTER_LOD_NODE_STRIDE_BYTES, CLUSTER_LOD_NODE_STRIDE_WORDS, CLUSTER_LOD_REFINE_SENTINEL,
  clusterScreenError, packClusterLodCamera, packClusterLodNodes, selectClusterLod,
  unpackClusterLodNodes, type ClusterLodCamera } from "./clusterLodSelection.js";

function gridMesh(cells: number): { vertices: Float32Array; indices: Uint32Array } {
  const stride = cells + 1;
  const vertices = new Float32Array(stride * stride * 3);
  for (let y = 0; y < stride; y++) for (let x = 0; x < stride; x++) {
    vertices.set([x, y, Math.sin(x * 13.7 + y * 7.3)], (y * stride + x) * 3);
  }
  const indices: number[] = [];
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const a = y * stride + x, b = a + 1, c = a + stride, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { vertices, indices: Uint32Array.from(indices) };
}

function bakedTerrain(cells = 16): ReturnType<typeof bakeClusterLodDag> {
  const mesh = gridMesh(cells);
  return bakeClusterLodDag({ geometryId: "selection-terrain", vertices: mesh.vertices,
    indices: mesh.indices, level0ClusterSize: 8 });
}

function cameraAt(depth: number, pixelThreshold = CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD): ClusterLodCamera {
  return { position: [8, 8, -depth], forward: [0, 0, 1],
    viewportHeightPixels: 1080, tanHalfFovY: 1, pixelThreshold };
}

/** 某叶子区域在前沿中被选中的祖先层级（前沿覆盖仲裁的区域探针）。 */
function frontierLevelFor(dag: ClusterLodDagDescriptor, frontier: readonly string[], leafId: string): number {
  const byId = new Map(dag.nodes.map(node => [node.id, node] as const));
  const subtree = new Map<string, Set<string>>();
  const collect = (node: ClusterLodNodeDescriptor): Set<string> => {
    const cached = subtree.get(node.id);
    if (cached) return cached;
    const ids = new Set<string>([node.id]);
    for (const child of node.children) for (const id of collect(byId.get(child)!)) ids.add(id);
    subtree.set(node.id, ids);
    return ids;
  };
  for (const id of frontier) {
    const node = byId.get(id);
    if (node && collect(node).has(leafId)) return node.level;
  }
  throw new Error(`Frontier does not cover leaf region ${leafId}.`);
}

describe("cluster lod selection packing", () => {
  it("round-trips bake dag nodes through the 64-byte stride layout", () => {
    const baked = bakedTerrain();
    const buffer = packClusterLodNodes(baked.dag);
    expect(buffer.byteLength).toBe(baked.dag.nodes.length * CLUSTER_LOD_NODE_STRIDE_BYTES);
    const perLevel = new Map<number, number>();
    for (const [index, node] of baked.dag.nodes.entries()) {
      const packed = unpackClusterLodNodes(buffer)[index]!;
      // f32 storage 量化合同：float 槽位以 Math.fround 为期望（与 WGSL f32 视图一致）。
      expect(packed.errorScalar).toBe(Math.fround(node.error));
      expect(packed.lodLevel).toBe(node.level);
      expect(packed.firstTriangle).toBe(node.firstTriangle);
      expect(packed.triangleCount).toBe(node.triangleCount);
      const expectedCluster = perLevel.get(node.level) ?? 0;
      perLevel.set(node.level, expectedCluster + 1);
      expect(packed.clusterIndex).toBe(expectedCluster);
      expect([packed.minX, packed.minY, packed.minZ]).toEqual([...node.boundsMin].map(Math.fround));
      expect([packed.maxX, packed.maxY, packed.maxZ]).toEqual([...node.boundsMax].map(Math.fround));
    }
  });

  it("keeps pad words zero and rejects malformed buffers fail-closed", () => {
    const baked = bakedTerrain(8);
    const words = new Uint32Array(packClusterLodNodes(baked.dag));
    for (let base = 0; base < words.length; base += CLUSTER_LOD_NODE_STRIDE_WORDS) {
      expect(words[base + 3]).toBe(0);
      expect(words[base + 7]).toBe(0);
      expect([words[base + 13], words[base + 14], words[base + 15]]).toEqual([0, 0, 0]);
    }
    expect(() => unpackClusterLodNodes(new ArrayBuffer(CLUSTER_LOD_NODE_STRIDE_BYTES - 4))).toThrow("multiple of");
  });

  it("packs the 48-byte camera uniform at the contracted word offsets", () => {
    const camera = cameraAt(3, 0.5);
    const floats = new Float32Array(packClusterLodCamera(camera, 7));
    const w = CLUSTER_LOD_CAMERA_WORD;
    expect(floats.length * 4).toBe(CLUSTER_LOD_CAMERA_UNIFORM_BYTES);
    expect([floats[w.camPosX], floats[w.camPosY], floats[w.camPosZ]]).toEqual([8, 8, -3]);
    expect(floats[w.tanHalfFovY]).toBe(1);
    expect([floats[w.forwardX], floats[w.forwardY], floats[w.forwardZ]]).toEqual([0, 0, 1]);
    expect(floats[w.pixelThreshold]).toBe(0.5);
    expect(floats[w.viewportHeightPixels]).toBe(1080);
    expect(floats[w.nodeCount]).toBe(7);
    expect([floats[w.pad0], floats[w.pad1]]).toEqual([0, 0]);
  });

  it("rejects invalid cameras and node counts fail-closed", () => {
    const base = cameraAt(3);
    expect(() => packClusterLodCamera({ ...base, forward: [0, 0, 0] }, 1)).toThrow("forward must be nonzero");
    expect(() => packClusterLodCamera({ ...base, viewportHeightPixels: 0 }, 1)).toThrow("viewportHeightPixels");
    expect(() => packClusterLodCamera({ ...base, tanHalfFovY: Number.NaN }, 1)).toThrow("tanHalfFovY");
    expect(() => packClusterLodCamera({ ...base, pixelThreshold: -1 }, 1)).toThrow("pixelThreshold");
    expect(() => packClusterLodCamera(base, -1)).toThrow("nodeCount");
    expect(() => packClusterLodCamera(base, Number.NaN)).toThrow("nodeCount");
  });
});

describe("cluster lod cpu reference selection", () => {
  it("selects finer levels near and coarser levels far (view-axis distance monotonic)", () => {
    const baked = bakedTerrain();
    const near = selectClusterLod(baked.dag, cameraAt(2));
    const far = selectClusterLod(baked.dag, cameraAt(1500));
    const coarsest = selectClusterLod(baked.dag, cameraAt(4000));
    // 近：level1 误差（约 2 世界单位）投影远超 1px → 前沿下钻到叶层。
    expect(frontierLevelFor(baked.dag, near.frontier, "l0-c0")).toBe(0);
    // d=1500：level1 投影 < 1px 而 level2（根）仍超阈 → 前沿停在 level1（更粗）。
    expect(frontierLevelFor(baked.dag, far.frontier, "l0-c0")).toBe(1);
    // d=4000：全部层过阈 → 前沿 = 最粗根层。
    expect(frontierLevelFor(baked.dag, coarsest.frontier, "l0-c0")).toBe(2);
    expect(frontierLevelFor(baked.dag, far.frontier, "l0-c0"))
      .toBeGreaterThanOrEqual(frontierLevelFor(baked.dag, near.frontier, "l0-c0"));
  });

  it("coarsens monotonically as the pixel threshold grows", () => {
    const baked = bakedTerrain();
    const fine = selectClusterLod(baked.dag, cameraAt(30, 0.25));
    const coarse = selectClusterLod(baked.dag, cameraAt(30, 40));
    expect(frontierLevelFor(baked.dag, fine.frontier, "l0-c1")).toBe(0);
    expect(frontierLevelFor(baked.dag, coarse.frontier, "l0-c1")).toBe(1);
    expect(coarse.frontier.length).toBeLessThan(fine.frontier.length);
  });

  it("keeps node selections monotone: farther selects more, deeper never unselects", () => {
    const baked = bakedTerrain();
    const near = selectClusterLod(baked.dag, cameraAt(2));
    const far = selectClusterLod(baked.dag, cameraAt(4000));
    const tight = selectClusterLod(baked.dag, cameraAt(30, 0.25));
    const loose = selectClusterLod(baked.dag, cameraAt(30, 32));
    const selected = (result: ReturnType<typeof selectClusterLod>, index: number): boolean =>
      result.selection[index] !== CLUSTER_LOD_REFINE_SENTINEL;
    for (let index = 0; index < baked.dag.nodes.length; index++) {
      if (selected(near, index)) expect(selected(far, index)).toBe(true);
      if (selected(tight, index)) expect(selected(loose, index)).toBe(true);
      const node = baked.dag.nodes[index]!;
      if (selected(loose, index)) {
        for (const child of node.children) {
          expect(selected(loose, baked.dag.nodes.findIndex(n => n.id === child))).toBe(true);
        }
      }
    }
  });

  it("closes the frontier: disjoint subtrees covering every leaf region exactly once", () => {
    const baked = bakedTerrain();
    const selection = selectClusterLod(baked.dag, cameraAt(30));
    const byId = new Map(baked.dag.nodes.map(node => [node.id, node] as const));
    const subtreeLeaves = new Map<string, Set<string>>();
    const leavesOf = (node: ClusterLodNodeDescriptor): Set<string> => {
      const cached = subtreeLeaves.get(node.id);
      if (cached) return cached;
      const leaves = new Set<string>();
      if (node.children.length === 0) leaves.add(node.id);
      for (const child of node.children) for (const leaf of leavesOf(byId.get(child)!)) leaves.add(leaf);
      subtreeLeaves.set(node.id, leaves);
      return leaves;
    };
    const covered = new Set<string>();
    for (const id of selection.frontier) {
      const leaves = leavesOf(byId.get(id)!);
      for (const leaf of leaves) expect(covered.has(leaf)).toBe(false);
      for (const leaf of leaves) covered.add(leaf);
    }
    const allLeaves = baked.dag.nodes.filter(node => node.level === 0).map(node => node.id);
    expect([...covered].sort()).toEqual([...allLeaves].sort());
  });

  it("computes screen errors matching the contracted formula", () => {
    const baked = bakedTerrain();
    const camera = cameraAt(10);
    const selection = selectClusterLod(baked.dag, camera);
    const node = baked.dag.nodes.find(candidate => candidate.level === 1)!;
    const index = baked.dag.nodes.indexOf(node);
    const center = [(node.boundsMin[0] + node.boundsMax[0]) / 2, (node.boundsMin[1] + node.boundsMax[1]) / 2,
      (node.boundsMin[2] + node.boundsMax[2]) / 2];
    const depth = Math.max(center[2] - camera.position[2], 1e-6);
    const expected = node.error * 1080 / (2 * depth * 1);
    // screenErrors 是 Float32Array（f32 诊断量化）；f64 参考值 fround 后逐位一致。
    expect(selection.screenErrors[index]).toBe(Math.fround(expected));
    expect(clusterScreenError(node, camera)).toBe(expected);
    // 叶层误差恒 0 → 恒选中（count>0）；roots 在中等距离保持下钻哨兵。
    const leafIndex = baked.dag.nodes.findIndex(candidate => candidate.level === 0);
    expect(selection.selection[leafIndex]).toBe(0);
  });

  it("fails closed on broken cameras, broken dag fields and error-monotonicity violations", () => {
    const baked = bakedTerrain(8);
    expect(() => selectClusterLod(baked.dag, cameraAt(10, Number.NaN))).toThrow("pixelThreshold");
    expect(() => selectClusterLod(baked.dag, { ...cameraAt(10), position: [Number.POSITIVE_INFINITY, 0, 0] }))
      .toThrow("position must be 3 finite numbers");
    const nonFinite: ClusterLodDagDescriptor = { ...baked.dag,
      nodes: baked.dag.nodes.map(node => node.level === 0
        ? { ...node, error: Number.NaN } : node) };
    expect(() => selectClusterLod(nonFinite, cameraAt(10))).toThrow("finite and nonnegative");
    const monotoneBroken: ClusterLodDagDescriptor = { ...baked.dag,
      nodes: baked.dag.nodes.map(node => node.level === 0
        ? { ...node, error: node.error + 5 } : node) };
    expect(validateClusterLodDag(monotoneBroken).valid).toBe(true);
    expect(() => selectClusterLod(monotoneBroken, cameraAt(10))).toThrow("monotonicity");
  });
});

describe("bake -> pack -> select smoke", () => {
  it("consumes bakeClusterLodDag output end to end", () => {
    const baked = bakedTerrain(12);
    expect(validateClusterLodDag(baked.dag)).toEqual({ valid: true });
    const packed = unpackClusterLodNodes(packClusterLodNodes(baked.dag));
    expect(packed.length).toBe(baked.dag.nodes.length);
    const camera = cameraAt(64);
    const selection = selectClusterLod(baked.dag, camera);
    expect(selection.selection.length).toBe(packed.length);
    expect(selection.frontier.length).toBeGreaterThan(0);
    // 每个选中槽位输出合法层级；下钻槽位为哨兵；两视图互相一致。
    for (let index = 0; index < selection.selection.length; index++) {
      const value = selection.selection[index]!;
      expect(value === CLUSTER_LOD_REFINE_SENTINEL || value === packed[index]!.lodLevel).toBe(true);
      expect((value !== CLUSTER_LOD_REFINE_SENTINEL) === (packed[index]!.triangleCount > 0
        && selection.screenErrors[index]! <= camera.pixelThreshold)).toBe(true);
    }
  });
});
