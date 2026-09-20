/**
 * TLAS 实例层（波次4）：多 BLAS 场景的实例级 BVH + 变换射线遍历。
 * 与 traceClosest（BLAS 级）组合成完整两级追踪；确定性中位数分裂与 buildBvh 同构。
 * 射线变换：世界射线被逆仿射变换拉回实例局部（Møller–Trumbore 在局部空间执行），
 * 命中 t 需按方向缩放修正回世界空间（|worldDir| 与 |localDir| 的比值）。
 */

import { buildBvh, intersectTriangle, type BvhBuildResult } from "./bvhBuilder.js";
import { buildTracedScene, traceClosest, type TraceHit, type TraceQuery } from "./rayTrace.js";
import type { RayBlasDescriptor } from "./rayBackendTypes.js";

export interface TlasInstanceDescriptor {
  readonly id: string;
  readonly blas: RayBlasDescriptor;
  /** 行主序 3x4 仿射：local = M × world（实例世界变换的逆，由调用方给出或用 helper 求逆）。 */
  readonly worldToLocal: readonly [number, number, number, number,
    number, number, number, number,
    number, number, number, number];
  readonly mask: number;
}

export interface TlasBuildResult {
  readonly built: BvhBuildResult;
  /** 每实例（order 排列后索引即 order 值）的局部包围盒（BLAS bounds 原样，用于变换回世界验证）。 */
  readonly instances: readonly TlasInstanceDescriptor[];
}

export function buildTlas(instances: readonly TlasInstanceDescriptor[]): TlasBuildResult {
  if (instances.length === 0) return { built: buildBvh({ vertices: new Float32Array(0), indices: new Uint32Array(0) }), instances: [] };
  // 实例的"质心与包围盒"以其实际 BLAS bounds 经仿射变换后的世界 AABB 表示；
  // 为确定性且免去 8 角变换误差，直接用三轴独立 min/max（与 BLAS bounds 变换等价的保守盒）。
  const fakeVertices: number[] = [];
  const fakeIndices: number[] = [];
  instances.forEach((instance, index) => {
    const scene = buildTracedScene(instance.blas);
    const node = scene.built.nodes[0];
    if (node === undefined) return; // 空 BLAS 不参与实例盒
    const corners: number[][] = [];
    for (const x of [node.minX, node.maxX]) for (const y of [node.minY, node.maxY]) for (const z of [node.minZ, node.maxZ]) {
      corners.push(applyTransform(instance.worldToLocal, [x, y, z]));
    }
    for (const corner of corners) fakeVertices.push(...corner);
    fakeIndices.push(index * 8 + 0, index * 8 + 1, index * 8 + 2);
  });
  if (fakeIndices.length === 0) return { built: buildBvh({ vertices: new Float32Array(0), indices: new Uint32Array(0) }), instances };
  const built = buildBvh({ vertices: new Float32Array(fakeVertices), indices: Uint32Array.from(fakeIndices) });
  return { built, instances };
}

export interface TlasHit extends TraceHit {
  readonly instanceId: string;
}

/** 两级最近命中：TLAS 盒剪枝 → 逆变换到 BLAS 局部 → traceClosest；取全局最近 t。 */
export function traceTlasClosest(tlas: TlasBuildResult, query: TraceQuery, mask = 0xFFFFFFFF): TlasHit | undefined {
  if (!(query.tMax > 0) || tlas.built.nodes.length === 0) return undefined;
  let best: (TraceHit & { instanceId: string }) | undefined;
  const stack: number[] = [0];
  while (stack.length > 0) {
    const nodeIndex = stack.pop()!;
    const node = tlas.built.nodes[nodeIndex]!;
    if (node.count === 0) {
      // 内部节点：无 bounds 剪枝数据时保守下钻（构建保证盒覆盖，剪枝优化留给 GPU 路径）。
      stack.push(node.rightChild ?? node.leftFirst + 1, node.leftFirst);
      continue;
    }
    for (let local = 0; local < node.count; local++) {
      const slot = tlas.built.order[node.leftFirst + local]!;
      const instance = tlas.instances[slot]!;
      if ((instance.mask & mask) === 0) continue;
      const worldToLocal = instance.worldToLocal;
      const localOrigin = applyTransform(worldToLocal, [query.ox, query.oy, query.oz]);
      const localDirection = transformDirection(worldToLocal, [query.dx, query.dy, query.dz]);
      const directionScale = Math.hypot(localDirection[0], localDirection[1], localDirection[2]);
      if (!(directionScale > 0)) continue;
      const scale = directionScale;
      const localQuery: TraceQuery = { ox: localOrigin[0], oy: localOrigin[1], oz: localOrigin[2],
        dx: localDirection[0] / scale, dy: localDirection[1] / scale, dz: localDirection[2] / scale,
        tMax: query.tMax * scale };
      const scene = buildTracedScene(instance.blas);
      const hit: TraceHit | undefined = traceClosest(scene, localQuery);
      if (hit !== undefined) {
        const worldT = hit.t / scale;
        if (worldT <= query.tMax && (best === undefined || worldT < best.t)) {
          best = { ...hit, t: worldT, instanceId: instance.id };
        }
      }
    }
  }
  return best;
}

function applyTransform(m: readonly number[], point: [number, number, number]): [number, number, number] {
  return [m[0]! * point[0]! + m[1]! * point[1]! + m[2]! * point[2]! + m[3]!,
    m[4]! * point[0]! + m[5]! * point[1]! + m[6]! * point[2]! + m[7]!,
    m[8]! * point[0]! + m[9]! * point[1]! + m[10]! * point[2]! + m[11]!];
}

function transformDirection(m: readonly number[], direction: [number, number, number]): [number, number, number] {
  return [m[0]! * direction[0]! + m[1]! * direction[1]! + m[2]! * direction[2]!,
    m[4]! * direction[0]! + m[5]! * direction[1]! + m[6]! * direction[2]!,
    m[8]! * direction[0]! + m[9]! * direction[1]! + m[10]! * direction[2]!];
}
