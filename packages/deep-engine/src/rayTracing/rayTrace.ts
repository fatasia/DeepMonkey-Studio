/**
 * CPU 参考 BVH 遍历（波次4 消费者接线的仲裁基准）。
 * 栈式 closest-hit / any-hit（遮挡）遍历；同输入逐位同输出，软件 WGSL 后端与
 * Native wgpu RT 都以本实现对拍。三角形精确相交语义与 bvhBuilder.intersectTriangle 一致。
 */

import { buildBvh, intersectTriangle, type BvhBuildResult } from "./bvhBuilder.js";
import type { RayBlasDescriptor } from "./rayBackendTypes.js";

export interface TracedScene {
  readonly blas: RayBlasDescriptor;
  readonly built: BvhBuildResult;
}

export function buildTracedScene(blas: RayBlasDescriptor): TracedScene {
  const error = blas.id === "" ? "BLAS id is required." : undefined;
  if (error !== undefined) throw new Error(`Cannot build traced scene: ${error}`);
  return { blas, built: buildBvh({ vertices: blas.vertices, indices: blas.indices }) };
}

export interface TraceQuery {
  readonly ox: number; readonly oy: number; readonly oz: number;
  readonly dx: number; readonly dy: number; readonly dz: number;
  readonly tMax: number;
}

export interface TraceHit {
  readonly t: number;
  /** indices 数组下标（全局三角索引）。 */
  readonly primitiveIndex: number;
  readonly barycentricU: number;
  readonly barycentricV: number;
}

const FLT_MAX = 3.402_823_466_385_288_6e38;

/** 栈式最近命中遍历；方向不必单位化（t 以方向长度计）。无命中返回 undefined。 */
export function traceClosest(scene: TracedScene, query: TraceQuery): TraceHit | undefined {
  if (!(query.tMax > 0) || scene.built.nodes.length === 0) return undefined;
  const invX = safeInverse(query.dx), invY = safeInverse(query.dy), invZ = safeInverse(query.dz);
  let best: TraceHit | undefined;
  const stack: number[] = [0];
  while (stack.length > 0) {
    const nodeIndex = stack.pop()!;
    const node = scene.built.nodes[nodeIndex]!;
    if (!overlapsBounds(scene, query, invX, invY, invZ, nodeIndex,
      best === undefined ? query.tMax : best.t)) continue;
    if (node.count > 0) {
      for (let local = 0; local < node.count; local++) {
        const primitiveIndex = scene.built.order[node.leftFirst + local]!;
        const i0 = scene.blas.indices[primitiveIndex * 3]! * 3;
        const i1 = scene.blas.indices[primitiveIndex * 3 + 1]! * 3;
        const i2 = scene.blas.indices[primitiveIndex * 3 + 2]! * 3;
        const t = intersectTriangle(query.ox, query.oy, query.oz, query.dx, query.dy, query.dz,
          scene.blas.vertices, i0 / 3, i1 / 3, i2 / 3);
        if (t >= 0 && t <= query.tMax && (best === undefined || t < best.t)) {
          best = { t, primitiveIndex, barycentricU: 0, barycentricV: 0 };
        }
      }
      continue;
    }
    stack.push(node.rightChild ?? node.leftFirst + 1, node.leftFirst);
  }
  return best;
}

/** 遮挡查询：任意命中即返回 true（早退，供阴影/可见性射线）。 */
export function traceOccluded(scene: TracedScene, query: TraceQuery): boolean {
  return traceClosest(scene, query) !== undefined;
}

function safeInverse(value: number): number {
  // 与 WGSL 常见实现一致：1/0 = ±Inf 由 IEEE 语义接管，NaN 方向拒绝（合同：方向必须有限）。
  return 1 / value;
}

interface BoundNode {
  readonly minX: number; readonly minY: number; readonly minZ: number;
  readonly maxX: number; readonly maxY: number; readonly maxZ: number;
}

function overlapsBounds(scene: TracedScene, query: TraceQuery,
  invX: number, invY: number, invZ: number, nodeIndex: number, tMax: number): boolean {
  const node = scene.built.nodes[nodeIndex] as unknown as BoundNode;
  // 零分量轴单独判定（0*Inf=NaN 会错误剪掉整棵子树）：射线与该轴平行时只要求起点在 slab 内。
  let entry = 0, exit = tMax;
  const slab = (origin: number, direction: number, inv: number,
    min: number, max: number): boolean => {
    if (direction !== 0) {
      let tNear = (min - origin) * inv, tFar = (max - origin) * inv;
      if (tNear > tFar) { const swap = tNear; tNear = tFar; tFar = swap; }
      if (tNear > entry) entry = tNear;
      if (tFar < exit) exit = tFar;
      return entry <= exit;
    }
    return origin >= min && origin <= max;
  };
  if (!slab(query.ox, query.dx, invX, node.minX, node.maxX)) return false;
  if (!slab(query.oy, query.dy, invY, node.minY, node.maxY)) return false;
  if (!slab(query.oz, query.dz, invZ, node.minZ, node.maxZ)) return false;
  return entry <= exit;
}
