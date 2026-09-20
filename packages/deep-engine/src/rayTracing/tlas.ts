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

export interface TlasInstanceBounds {
  readonly minX: number; readonly minY: number; readonly minZ: number;
  readonly maxX: number; readonly maxY: number; readonly maxZ: number;
}

export interface TlasBuildResult {
  readonly built: BvhBuildResult;
  /** 每实例（order 排列后索引即 order 值）的局部包围盒（BLAS bounds 原样，用于变换回世界验证）。 */
  readonly instances: readonly TlasInstanceDescriptor[];
  /** 参与构建的实例的世界 AABB（下标与 instances 对齐；空 BLAS 为 undefined）。
   *  由 localToWorld（worldToLocal 的逆）变换 BLAS 根节点 8 角后取轴对齐 min/max，分量
   *  以 f32 量化（fround）——合同即 f32 精度盒，与 GPU storage 记录逐位一致；CPU 遍历
   *  不读盒（保守下钻）不受影响，GPU TLAS 盒剪枝与打包以此为准。 */
  readonly instanceBounds: readonly (TlasInstanceBounds | undefined)[];
}

/** 行主序 3×4 仿射求逆（local = M × world ⇒ world = M⁻¹ × local）；3×3 奇异即抛错。 */
export function invertAffine3x4(m: readonly number[]): number[] {
  const a = m[0]!, b = m[1]!, c = m[2]!, d = m[4]!, e = m[5]!, f = m[6]!, g = m[8]!, h = m[9]!, i = m[10]!;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error("worldToLocal affine is singular.");
  const inverse = 1 / determinant;
  const i00 = (e * i - f * h) * inverse, i01 = (c * h - b * i) * inverse, i02 = (b * f - c * e) * inverse;
  const i10 = (f * g - d * i) * inverse, i11 = (a * i - c * g) * inverse, i12 = (c * d - a * f) * inverse;
  const i20 = (d * h - e * g) * inverse, i21 = (b * g - a * h) * inverse, i22 = (a * e - b * d) * inverse;
  const tx = m[3]!, ty = m[7]!, tz = m[11]!;
  return [i00, i01, i02, -(i00 * tx + i01 * ty + i02 * tz),
    i10, i11, i12, -(i10 * tx + i11 * ty + i12 * tz),
    i20, i21, i22, -(i20 * tx + i21 * ty + i22 * tz)];
}

export function buildTlas(instances: readonly TlasInstanceDescriptor[]): TlasBuildResult {
  const empty = { built: buildBvh({ vertices: new Float32Array(0), indices: new Uint32Array(0) }) };
  if (instances.length === 0) return { ...empty, instances: [], instanceBounds: [] };
  // 实例的"质心与包围盒"以其实际 BLAS bounds 经 localToWorld（实例正向变换）后的世界 AABB 表示；
  // 为确定性且免去 8 角变换误差，直接用三轴独立 min/max（与 BLAS bounds 变换等价的保守盒）。
  const instanceBounds: (TlasInstanceBounds | undefined)[] = instances.map(() => undefined);
  const fakeVertices: number[] = [];
  const fakeIndices: number[] = [];
  instances.forEach((instance, index) => {
    const scene = buildTracedScene(instance.blas);
    const node = scene.built.nodes[0];
    if (node === undefined) return; // 空 BLAS 不参与实例盒
    const localToWorld = invertAffine3x4(instance.worldToLocal);
    const corners: number[][] = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const x of [node.minX, node.maxX]) for (const y of [node.minY, node.maxY]) for (const z of [node.minZ, node.maxZ]) {
      const corner = applyTransform(localToWorld, [x, y, z]);
      corners.push(corner);
      minX = Math.min(minX, corner[0]!); maxX = Math.max(maxX, corner[0]!);
      minY = Math.min(minY, corner[1]!); maxY = Math.max(maxY, corner[1]!);
      minZ = Math.min(minZ, corner[2]!); maxZ = Math.max(maxZ, corner[2]!);
    }
    instanceBounds[index] = { minX: Math.fround(minX), minY: Math.fround(minY), minZ: Math.fround(minZ),
      maxX: Math.fround(maxX), maxY: Math.fround(maxY), maxZ: Math.fround(maxZ) };
    for (const corner of corners) fakeVertices.push(...corner);
    // fake 三角必须覆盖盒的三轴全距（角 0=min.x/min.y/min.z、7=max.x/max.y/max.z、
    // 5=max.x/min.y/max.z）：取 0/1/2 会三顶点共享 minX，使盒在 x 轴退化——CPU 遍历不读盒
    // 不受影响，但 GPU TLAS 盒剪枝会把整棵树剪光（真机实测）。
    fakeIndices.push(index * 8 + 0, index * 8 + 7, index * 8 + 5);
  });
  if (fakeIndices.length === 0) return { ...empty, instances, instanceBounds };
  const built = buildBvh({ vertices: new Float32Array(fakeVertices), indices: Uint32Array.from(fakeIndices) });
  return { built, instances, instanceBounds };
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
