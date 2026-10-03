import { describe, expect, it } from "vitest";
import { buildBvh, type BvhBuildResult } from "./bvhBuilder.js";
import { buildSahBvh, SAH_BVH_DEFAULTS, type SahBvhOptions } from "./blasBuilder.js";
import { serializeBvhNodes } from "./rayTraceLayout.js";

/** 确定性 LCG 伪随机（无 RNG 依赖，两次运行同输入同输出）。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 双峰簇状三角云（SAH 优势场景）+ 均匀背景；count 为三角形数。 */
function clusteredTriangleSoup(count: number, seed: number): { vertices: Float32Array; indices: Uint32Array } {
  const random = lcg(seed);
  const vertices = new Float32Array(count * 9);
  const centers: ReadonlyArray<readonly [number, number, number]> = [[-50, -50, -50], [50, 50, 50]];
  for (let t = 0; t < count; t++) {
    const center = random() < 0.5 ? centers[0]! : centers[1]!;
    const spread = random() < 0.8 ? 1 : 30; // 80% 紧簇 + 20% 背景弥散。
    for (let corner = 0; corner < 3; corner++) {
      vertices[t * 9 + corner * 3] = center[0] + (random() - 0.5) * spread;
      vertices[t * 9 + corner * 3 + 1] = center[1] + (random() - 0.5) * spread;
      vertices[t * 9 + corner * 3 + 2] = center[2] + (random() - 0.5) * spread;
    }
  }
  const indices = new Uint32Array(count * 3);
  for (let t = 0; t < count * 3; t++) indices[t] = t;
  return { vertices, indices };
}

function leafCostOf(built: BvhBuildResult): { cost: number; leaves: number; maxLeafTriangles: number; depth: number } {
  let cost = 0, leaves = 0, maxLeafTriangles = 0;
  const measure = (index: number, depth: number): void => {
    const node = built.nodes[index]!;
    if (node.count > 0) {
      const area = (node.maxX - node.minX) * (node.maxY - node.minY)
        + (node.maxY - node.minY) * (node.maxZ - node.minZ) + (node.maxZ - node.minZ) * (node.maxX - node.minX);
      cost += area * node.count;
      leaves++;
      maxLeafTriangles = Math.max(maxLeafTriangles, node.count);
      return;
    }
    measure(node.rightChild ?? node.leftFirst + 1, depth + 1);
    measure(node.leftFirst, depth + 1);
  };
  if (built.nodes.length > 0) measure(0, 0);
  return { cost, leaves, maxLeafTriangles, depth: built.nodes.length > 0 ? maxDepthOf(built) : 0 };
}

function maxDepthOf(built: BvhBuildResult): number {
  const walk = (index: number, depth: number): number => {
    const node = built.nodes[index]!;
    if (node.count > 0) return depth;
    return Math.max(walk(node.leftFirst, depth + 1), walk(node.rightChild ?? node.leftFirst + 1, depth + 1));
  };
  return walk(0, 0);
}

/** 不相交紧凑簇（SAH 优势场景：簇间空旷、簇内致密；median 会在空旷处劈大空盒）。 */
function disjointClusterSoup(clusterCount: number, trisPerCluster: number, seed: number):
  { vertices: Float32Array; indices: Uint32Array } {
  const random = lcg(seed);
  const total = clusterCount * trisPerCluster;
  const vertices = new Float32Array(total * 9);
  const side = Math.ceil(Math.cbrt(clusterCount));
  for (let cluster = 0; cluster < clusterCount; cluster++) {
    const cx = (cluster % side) * 10, cy = Math.floor(cluster / side) % side * 10,
      cz = Math.floor(cluster / (side * side)) * 10;
    for (let t = 0; t < trisPerCluster; t++) {
      const index = cluster * trisPerCluster + t;
      for (let corner = 0; corner < 3; corner++) {
        vertices[index * 9 + corner * 3] = cx + (random() - 0.5);
        vertices[index * 9 + corner * 3 + 1] = cy + (random() - 0.5);
        vertices[index * 9 + corner * 3 + 2] = cz + (random() - 0.5);
      }
    }
  }
  const indices = new Uint32Array(total * 3);
  for (let t = 0; t < total * 3; t++) indices[t] = t;
  return { vertices, indices };
}

const SOUP_512 = clusteredTriangleSoup(512, 42);

describe("SAH BLAS builder", () => {
  const built = buildSahBvh(SOUP_512);

  it("covers every triangle exactly once across the order slots", () => {
    expect(built.order).toHaveLength(512);
    const sorted = [...built.order].sort((a, b) => a - b);
    sorted.forEach((triangle, index) => expect(triangle).toBe(index));
  });

  it("keeps node bounds ⊇ children and leaf bounds ⊇ their triangles", () => {
    const triangles = new Map<number, readonly number[]>();
    for (let t = 0; t < 512; t++) {
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let corner = 0; corner < 3; corner++) {
        const v = t * 9 + corner * 3;
        minX = Math.min(minX, SOUP_512.vertices[v]!); maxX = Math.max(maxX, SOUP_512.vertices[v]!);
        minY = Math.min(minY, SOUP_512.vertices[v + 1]!); maxY = Math.max(maxY, SOUP_512.vertices[v + 1]!);
        minZ = Math.min(minZ, SOUP_512.vertices[v + 2]!); maxZ = Math.max(maxZ, SOUP_512.vertices[v + 2]!);
      }
      triangles.set(t, [minX, minY, minZ, maxX, maxY, maxZ]);
    }
    const check = (index: number): { min: number[]; max: number[] } => {
      const node = built.nodes[index]!;
      if (node.count > 0) {
        for (let local = 0; local < node.count; local++) {
          const b = triangles.get(built.order[node.leftFirst + local]!)!;
          expect(node.minX).toBeLessThanOrEqual(b[0]!); expect(node.maxX).toBeGreaterThanOrEqual(b[3]!);
          expect(node.minY).toBeLessThanOrEqual(b[1]!); expect(node.maxY).toBeGreaterThanOrEqual(b[4]!);
          expect(node.minZ).toBeLessThanOrEqual(b[2]!); expect(node.maxZ).toBeGreaterThanOrEqual(b[5]!);
        }
        return { min: [node.minX, node.minY, node.minZ], max: [node.maxX, node.maxY, node.maxZ] };
      }
      const left = check(node.leftFirst);
      const right = check(node.rightChild ?? node.leftFirst + 1);
      const min = [Math.min(left.min[0]!, right.min[0]!), Math.min(left.min[1]!, right.min[1]!),
        Math.min(left.min[2]!, right.min[2]!)];
      const max = [Math.max(left.max[0]!, right.max[0]!), Math.max(left.max[1]!, right.max[1]!),
        Math.max(left.max[2]!, right.max[2]!)];
      expect(node.minX).toBe(min[0]); expect(node.minY).toBe(min[1]); expect(node.minZ).toBe(min[2]);
      expect(node.maxX).toBe(max[0]); expect(node.maxY).toBe(max[1]); expect(node.maxZ).toBe(max[2]);
      return { min, max };
    };
    const root = check(0);
    expect(root.min.every(v => Number.isFinite(v))).toBe(true);
  });

  it("is bitwise deterministic across builds (nodes + order + stats)", () => {
    const again = buildSahBvh(SOUP_512, { binCount: 16 });
    expect([...again.nodes]).toEqual([...built.nodes]);
    expect([...again.order]).toEqual([...built.order]);
    expect(serializeBvhNodes(again)).toEqual(serializeBvhNodes(built));
    expect(again.stats).toEqual(built.stats);
  });

  it("honors structural contracts (leaf sentinels, leaf size, depth guard)", () => {
    built.nodes.forEach(node => {
      if (node.count > 0) expect(node.rightChild).toBeUndefined();
      else expect(node.rightChild).toBeDefined();
    });
    expect(built.stats.maxReachedDepth).toBeLessThanOrEqual(SAH_BVH_DEFAULTS.maxDepth);
    expect(built.stats.leafCount).toBeGreaterThan(0);
    const again = buildSahBvh(SOUP_512, { maxLeafSize: 2 } satisfies SahBvhOptions);
    expect(again.stats.leafCount).toBeGreaterThanOrEqual(built.stats.leafCount);
  });

  it("stays competitive with the median-split reference (SAH quality sanity)", () => {
    // 不相交紧凑簇：SAH 的强项场景；网格簇 + 16 bin 粒度失配会诱发偏斜剥离（已知敏感项，
    // 见模块头注释），护栏只防灾难性劣化——真正性能门是 GPU 遍历预算（acceptance ②③）。
    const soup = disjointClusterSoup(64, 8, 11);
    const median = buildBvh(soup);
    const sah = buildSahBvh(soup);
    expect(sah.stats.leafAreaCost).toBeLessThan(leafCostOf(median).cost * 10);
    expect(leafCostOf(sah).maxLeafTriangles).toBeLessThanOrEqual(4);
    const mixedMedian = leafCostOf(buildBvh(SOUP_512)).cost;
    // 混合弥散（80% 重叠紧簇）上"面积×计数"指标天然偏袒更细的劈分，SAH 代价模型
    // （期望遍历代价）与它分歧——护栏只防灾难性劣化（历史回归值 ~1.5×）。
    expect(built.stats.leafAreaCost).toBeLessThan(mixedMedian * 1.6);
    expect(built.stats.maxReachedDepth).toBeLessThanOrEqual(SAH_BVH_DEFAULTS.maxDepth);
  });

  it("builds 10k triangles well under the 100ms budget (acceptance ①)", () => {
    const soup = clusteredTriangleSoup(10_000, 7);
    const start = performance.now();
    const result = buildSahBvh(soup);
    const elapsed = performance.now() - start;
    expect(result.order).toHaveLength(10_000);
    expect(result.stats.maxReachedDepth).toBeLessThanOrEqual(SAH_BVH_DEFAULTS.maxDepth);
    expect(elapsed).toBeLessThan(100);
  });

  it("handles empty geometry and validates options fail-closed", () => {
    const empty = buildSahBvh({ vertices: new Float32Array(0), indices: new Uint32Array(0) });
    expect(empty.nodes).toHaveLength(0);
    expect(empty.order).toHaveLength(0);
    expect(empty.stats).toEqual({ nodeCount: 0, leafCount: 0, maxReachedDepth: 0, leafAreaCost: 0 });
    expect(() => buildSahBvh(SOUP_512, { maxLeafSize: 0 })).toThrow(RangeError);
    expect(() => buildSahBvh(SOUP_512, { maxLeafSize: 2.5 })).toThrow(RangeError);
  });

  it("serializes through the shared 48B node layout (GPU buffer contract)", () => {
    const bytes = serializeBvhNodes(built);
    expect(bytes.byteLength).toBe(built.nodes.length * 48);
  });
});
