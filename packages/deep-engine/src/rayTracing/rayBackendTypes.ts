/**
 * RayBackend 合同 v0（波次1）：软件 WGSL compute 与 Native wgpu RT 的公共数据层。
 * 本文件只定义数据、预算与确定性语义；执行器（shader dispatch / GPU RT）在各自实现里。
 * 对拍纪律沿用 R2 DCIR：CPU 参考实现（bvhBuilder）与各后端输出逐值比对。
 */

export interface RayVec3 { readonly x: number; readonly y: number; readonly z: number }

export interface RayAabb { readonly min: RayVec3; readonly max: RayVec3 }

/** 一个 BLAS = 一段三角形集合（meshlet 分页的连续区间即可充当）。索引必须为 Uint32。 */
export interface RayBlasDescriptor {
  readonly id: string;
  /** 展开顶点（非索引化拷贝由构建方负责），3 float 每顶点。 */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

export interface RayInstanceDescriptor {
  readonly id: string;
  readonly blasId: string;
  /** 行主序 3x4 变换（仿射，世界→BLAS 局部的逆由构建方求取）。 */
  readonly transform: readonly [number, number, number, number,
    number, number, number, number,
    number, number, number, number];
  /** 掩码原样透传给查询；语义由消费者定义（如 shadow/ray 反射通道位）。 */
  readonly mask: number;
}

/** 批量射线；tMin 默认 0，tMax 必须 > tMin 且有限。 */
export interface RayBatchQuery {
  readonly origins: Float32Array;
  readonly directions: Float32Array;
  readonly tMax: Float32Array;
  readonly mask: number;
}

export interface RayHit {
  readonly index: number;
  readonly t: number;
  readonly instanceId: string;
  /** BLAS 内三角形全局索引（indices 数组下标，非三角序号）。 */
  readonly primitiveIndex: number;
  readonly barycentrics: readonly [number, number];
}

export const RAY_BACKEND_LIMITS = Object.freeze({
  maxBlasTriangles: 4_194_304,
  maxBlasBytes: 256 * 1024 * 1024,
  maxInstances: 262_144,
  maxBatchRays: 1_048_576,
});

export type RayBackendBuildStatus = "built" | "empty" | "budget-exceeded";

export interface RayBuildReport {
  readonly status: RayBackendBuildStatus;
  readonly blasNodeCount: number;
  readonly tlasInstanceCount: number;
  readonly rejectedReason?: string;
}

export function validateRayBlas(descriptor: RayBlasDescriptor): string | undefined {
  if (!descriptor.id || typeof descriptor.id !== "string") return "BLAS id is required.";
  if (!(descriptor.vertices instanceof Float32Array) || !(descriptor.indices instanceof Uint32Array)) {
    return "BLAS geometry must use typed arrays.";
  }
  if (descriptor.vertices.length % 3 !== 0 || descriptor.indices.length % 3 !== 0) {
    return "BLAS vertex/index streams must be whole float3 / whole triangles.";
  }
  const triangles = descriptor.indices.length / 3;
  if (triangles === 0) return undefined;
  if (triangles > RAY_BACKEND_LIMITS.maxBlasTriangles) return "BLAS exceeds triangle budget.";
  for (const index of descriptor.indices) {
    if (index * 3 + 2 >= descriptor.vertices.length) return "BLAS index out of vertex range.";
  }
  return undefined;
}
