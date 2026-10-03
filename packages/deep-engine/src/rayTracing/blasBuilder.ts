/**
 * BLAS 构建（compute BVH 光追骨架波次1）：**binned SAH** 三角形 BVH，纯 CPU 确定性构建。
 * 与 rayTracing/bvhBuilder.ts（中位分裂，CPU 仲裁基准）同构的节点合同——BvhNode
 * （4 float bounds + leftFirst/count/rightChild，48B storage stride）——可直接喂
 * rayTraceLayout.serializeBvhNodes / tlasLayout 拼接，GPU 布局零新概念。
 *
 * == SAH 设计（binned SAH） ==
 * 每内部节点在 3 轴 × binCount 个均匀质心 bin 上做左/右两遍扫掠，取
 * cost = leftArea×leftCount + rightArea×rightCount 最小的（轴,bin 边界）；
 * cost ≥ 叶代价（count×节点面积）即截叶；空侧分裂与全轴退化（质心重合）一律拒分裂截叶。
 * 确定性：轴/平面平局取先者（x<y<z、低 entry 优先，严格 < 更新）；划分用与 buildBvh
 * 相同的稳定原地 partition（centroid < plane 入左）；无 RNG、无键序依赖 ⇒ 两次构建逐位一致。
 *
 * == 深度护栏（遍历栈合同） ==
 * maxDepth（默认 24）以下强截叶：SAH 树可能失衡，遍历 kernel 栈深固定
 * RAY_TRACE_STACK_CAPACITY=32（rayTraceLayout），24 < 32 保证 fail-closed 溢出不可达。
 *
 * == 预算 ==
 * 1 万三角形 < 100ms（验收①，vitest 计时门）；binCount 钳制 [2,64]。
 */

import type { BvhBuildInput, BvhBuildResult, BvhNode } from "./bvhBuilder.js";

export const SAH_BVH_DEFAULTS = Object.freeze({ maxLeafSize: 4, binCount: 16, maxDepth: 24 });
const MAX_BIN_COUNT = 64;

export interface SahBvhOptions {
  /** 叶最大三角形数（≥1；默认 4，与中位分裂基准同口径）。 */
  readonly maxLeafSize?: number;
  /** 每轴质心 bin 数（2..64；默认 16）。 */
  readonly binCount?: number;
  /** 递归深度上限（≥1；默认 24，保证 32 深遍历栈不可溢出）。 */
  readonly maxDepth?: number;
}

export interface SahBvhStats {
  readonly nodeCount: number;
  readonly leafCount: number;
  readonly maxReachedDepth: number;
  /** Σ leafArea×leafCount（f64；SAH 质量指标，非合同）。 */
  readonly leafAreaCost: number;
}

export interface SahBvhResult extends BvhBuildResult {
  readonly stats: SahBvhStats;
}

export function buildSahBvh(input: BvhBuildInput, options: SahBvhOptions = {}): SahBvhResult {
  const maxLeafSize = options.maxLeafSize ?? SAH_BVH_DEFAULTS.maxLeafSize;
  if (!Number.isSafeInteger(maxLeafSize) || maxLeafSize < 1) {
    throw new RangeError("SAH BVH maxLeafSize must be a positive integer.");
  }
  const binCount = Math.min(Math.max(options.binCount ?? SAH_BVH_DEFAULTS.binCount, 2), MAX_BIN_COUNT);
  const maxDepth = Math.max(options.maxDepth ?? SAH_BVH_DEFAULTS.maxDepth, 1);
  const triangles = input.indices.length / 3;
  if (triangles === 0) {
    return { nodes: Object.freeze([]), order: Object.freeze([]),
      stats: { nodeCount: 0, leafCount: 0, maxReachedDepth: 0, leafAreaCost: 0 } };
  }
  const centroids = new Float64Array(triangles * 3);
  const bounds = new Float64Array(triangles * 6);
  for (let triangle = 0; triangle < triangles; triangle++) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cx = 0, cy = 0, cz = 0;
    for (let corner = 0; corner < 3; corner++) {
      const v = input.indices[triangle * 3 + corner]! * 3;
      const x = input.vertices[v]!, y = input.vertices[v + 1]!, z = input.vertices[v + 2]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      cx += x; cy += y; cz += z;
    }
    centroids[triangle * 3] = cx / 3; centroids[triangle * 3 + 1] = cy / 3; centroids[triangle * 3 + 2] = cz / 3;
    bounds[triangle * 6] = minX; bounds[triangle * 6 + 1] = minY; bounds[triangle * 6 + 2] = minZ;
    bounds[triangle * 6 + 3] = maxX; bounds[triangle * 6 + 4] = maxY; bounds[triangle * 6 + 5] = maxZ;
  }
  const nodes: BvhNode[] = [];
  const order: number[] = Array.from({ length: triangles }, (_, i) => i);
  // bin 扫掠 scratch（跨节点/跨轴复用；binMin/Max 为 3 分量 × bins）。
  const binMin = new Float64Array(binCount * 3), binMax = new Float64Array(binCount * 3);
  const binCounts = new Uint32Array(binCount);
  const sweepMin = new Float64Array(binCount * 3), sweepMax = new Float64Array(binCount * 3);
  const sweepCount = new Uint32Array(binCount);
  let leafCount = 0, maxReachedDepth = 0, leafAreaCost = 0;

  const build = (first: number, count: number, depth: number): number => {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = first; i < first + count; i++) {
      const ox = order[i]! * 6;
      if (bounds[ox]! < minX) minX = bounds[ox]!;
      if (bounds[ox + 1]! < minY) minY = bounds[ox + 1]!;
      if (bounds[ox + 2]! < minZ) minZ = bounds[ox + 2]!;
      if (bounds[ox + 3]! > maxX) maxX = bounds[ox + 3]!;
      if (bounds[ox + 4]! > maxY) maxY = bounds[ox + 4]!;
      if (bounds[ox + 5]! > maxZ) maxZ = bounds[ox + 5]!;
    }
    const nodeIndex = nodes.length;
    nodes.push({ leftFirst: first, count, minX, minY, minZ, maxX, maxY, maxZ });
    if (depth > maxReachedDepth) maxReachedDepth = depth;
    const area = halfArea(minX, minY, minZ, maxX, maxY, maxZ);
    if (count <= maxLeafSize || depth >= maxDepth || area === 0) {
      leafCount++; leafAreaCost += area * count;
      return nodeIndex;
    }
    const split = bestSplit(first, count, centroids, bounds, order, binCount, binMin, binMax, binCounts,
      sweepMin, sweepMax, sweepCount, minX, minY, minZ, maxX, maxY, maxZ);
    if (split === undefined || split.cost >= count * area) {
      leafCount++; leafAreaCost += area * count;
      return nodeIndex;
    }
    let leftCount = partition(first, count, order, centroids, split.axis, split.plane);
    if (leftCount === 0 || leftCount === count) {
      // 划分粘边（质心相等密度高）的中位回退：保证递归推进且确定性。
      leftCount = Math.max(1, Math.min(count - 1, count >> 1));
    }
    const leftIndex = build(first, leftCount, depth + 1);
    const rightIndex = build(first + leftCount, count - leftCount, depth + 1);
    nodes[nodeIndex] = { leftFirst: leftIndex, rightChild: rightIndex, count: 0, minX, minY, minZ, maxX, maxY, maxZ };
    return nodeIndex;
  };
  build(0, triangles, 0);
  return { nodes: Object.freeze(nodes), order: Object.freeze(order),
    stats: { nodeCount: nodes.length, leafCount, maxReachedDepth, leafAreaCost } };
}

interface SahSplit { readonly axis: 0 | 1 | 2; readonly plane: number; readonly cost: number }

/** binned SAH：逐轴填 bin → 左扫掠落表 → 右扫掠逐 entry 评估；空侧 entry 拒绝；平局取先者。 */
function bestSplit(first: number, count: number, centroids: Float64Array, bounds: Float64Array, order: number[],
  bins: number, binMin: Float64Array, binMax: Float64Array, binCounts: Uint32Array,
  sweepMin: Float64Array, sweepMax: Float64Array, sweepCount: Uint32Array,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): SahSplit | undefined {
  const extents = [maxX - minX, maxY - minY, maxZ - minZ];
  let bestCost = Infinity, bestAxis: 0 | 1 | 2 = 0, bestEntry = -1;
  for (const axis of [0, 1, 2] as const) {
    const extent = extents[axis]!;
    if (!(extent > 0)) continue;
    const cMin = axis === 0 ? minX : axis === 1 ? minY : minZ;
    const scale = bins / extent;
    binCounts.fill(0);
    binMin.fill(Infinity); binMax.fill(-Infinity);
    for (let i = first; i < first + count; i++) {
      const c = centroids[order[i]! * 3 + axis]!;
      let slot = Math.floor((c - cMin) * scale);
      if (slot < 0) slot = 0; else if (slot >= bins) slot = bins - 1;
      const s = slot * 3, ox = order[i]! * 6;
      if (bounds[ox]! < binMin[s]!) binMin[s] = bounds[ox]!;
      if (bounds[ox + 1]! < binMin[s + 1]!) binMin[s + 1] = bounds[ox + 1]!;
      if (bounds[ox + 2]! < binMin[s + 2]!) binMin[s + 2] = bounds[ox + 2]!;
      if (bounds[ox + 3]! > binMax[s]!) binMax[s] = bounds[ox + 3]!;
      if (bounds[ox + 4]! > binMax[s + 1]!) binMax[s + 1] = bounds[ox + 4]!;
      if (bounds[ox + 5]! > binMax[s + 2]!) binMax[s + 2] = bounds[ox + 5]!;
      binCounts[slot]++;
    }
    // 左扫掠：sweep[b] = bin 0..b 的并。
    let l0 = Infinity, l1 = Infinity, l2 = Infinity, l3 = -Infinity, l4 = -Infinity, l5 = -Infinity;
    for (let b = 0; b < bins; b++) {
      const s = b * 3;
      if (binCounts[b]! > 0) {
        if (binMin[s]! < l0) l0 = binMin[s]!;
        if (binMin[s + 1]! < l1) l1 = binMin[s + 1]!;
        if (binMin[s + 2]! < l2) l2 = binMin[s + 2]!;
        if (binMax[s]! > l3) l3 = binMax[s]!;
        if (binMax[s + 1]! > l4) l4 = binMax[s + 1]!;
        if (binMax[s + 2]! > l5) l5 = binMax[s + 2]!;
      }
      sweepMin[s] = l0; sweepMin[s + 1] = l1; sweepMin[s + 2] = l2;
      sweepMax[s] = l3; sweepMax[s + 1] = l4; sweepMax[s + 2] = l5;
      sweepCount[b] = binCounts[b]!;
    }
    // 右扫掠评估 entry b（左 = bin 0..b，右 = bin b+1..bins-1）；b 从 bins-2 到 0。
    let r0 = Infinity, r1 = Infinity, r2 = Infinity, r3 = -Infinity, r4 = -Infinity, r5 = -Infinity, rCount = 0;
    for (let b = bins - 1; b >= 1; b--) {
      const s = b * 3;
      if (binCounts[b]! > 0) {
        if (binMin[s]! < r0) r0 = binMin[s]!;
        if (binMin[s + 1]! < r1) r1 = binMin[s + 1]!;
        if (binMin[s + 2]! < r2) r2 = binMin[s + 2]!;
        if (binMax[s]! > r3) r3 = binMax[s]!;
        if (binMax[s + 1]! > r4) r4 = binMax[s + 1]!;
        if (binMax[s + 2]! > r5) r5 = binMax[s + 2]!;
        rCount += binCounts[b]!;
      }
      const leftCount = sweepCount[b - 1]!;
      if (leftCount === 0 || rCount === 0) continue; // 空侧分裂拒绝（防 Inf 盒污染 cost）。
      const cost = halfArea(sweepMin[s - 3]!, sweepMin[s - 2]!, sweepMin[s - 1]!,
        sweepMax[s - 3]!, sweepMax[s - 2]!, sweepMax[s - 1]!) * leftCount
        + halfArea(r0, r1, r2, r3, r4, r5) * rCount;
      if (cost < bestCost) { bestCost = cost; bestAxis = axis; bestEntry = b - 1; }
    }
  }
  if (bestEntry < 0) return undefined; // 全轴退化（质心重合）：调用方截叶。
  const axisExtent = extents[bestAxis]!;
  const axisMin = bestAxis === 0 ? minX : bestAxis === 1 ? minY : minZ;
  return { axis: bestAxis, plane: axisMin + (bestEntry + 1) * axisExtent / binCount, cost: bestCost };
}

/** 与 buildBvh 同构的稳定原地 partition：centroid < plane 入左，返回左侧数量。 */
function partition(first: number, count: number, order: number[], centroids: Float64Array,
  axis: 0 | 1 | 2, plane: number): number {
  let left = first, right = first + count - 1;
  while (left <= right) {
    const centroid = centroids[order[left]! * 3 + axis]!;
    if (centroid < plane) { left += 1; continue; }
    const swap = order[left]!; order[left] = order[right]!; order[right] = swap; right -= 1;
  }
  return left - first;
}

function halfArea(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
  const x = maxX - minX, y = maxY - minY, z = maxZ - minZ;
  return x * y + y * z + z * x;
}
