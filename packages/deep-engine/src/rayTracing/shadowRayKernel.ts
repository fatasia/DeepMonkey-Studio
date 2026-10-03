/**
 * 方向光阴影光线 pass（compute BVH 光追骨架·最小可验切片）：`shadow_ray_mask_batch`。
 * 语义沿用 RT 阴影合同（spotShadowRayExtension：遮挡查询——命中=遮挡、miss=可见）：
 * 对每条"着色点→光"的遮挡射线做两级（TLAS→BLAS）any-hit 遍历，输出逐射线 u32 可见性
 * mask（1=可见/0=遮挡；栈溢出 fail-closed 写 0 并入全局哨兵，正常输入不可达）。
 *
 * == 片段拼装 ==
 * 核心/BLAS 遍历片段自 bvhTraverseWgsl、TLAS 遍历片段自 bvhTraverseTlasWgsl 按需拼装
 * （本内核只需 any-hit 路径，不发射 closest-hit/法线片段——死代码零发射）；f16 档透传
 * 给核心片段（需 device "shader-f16"，执行器侧 fail-closed 校验）。
 *
 * == 布局合同 ==
 * binding 0..4 与 rayTraceTlasKernel 完全一致（tlasLayout 拼接：nodes/instances/vertices/
 * indices/triangleOrder）；5 = 射线流（rayTraceLayout 32B/射线）；6 = 可见性 mask
 * （array<u32>，1 可见/0 遮挡）；7 = 栈溢出哨兵；8 = params uniform（16B）。
 * storage 共 8 条，恰在 maxStorageBuffersPerShaderStage 默认上限内。
 */

import { RAY_TRACE_WORKGROUP_SIZE } from "./rayTraceLayout.js";
import { BVH_BLAS_OCCLUDED_WGSL, BVH_INTERSECT_WGSL, BVH_SLAB_WGSL, bvhTraverseCoreWgsl } from "./bvhTraverseWgsl.js";
import { TLAS_INSTANCE_STRUCT_WGSL, TLAS_LOCAL_RAY_WGSL, TLAS_OCCLUDED_WGSL } from "./bvhTraverseTlasWgsl.js";

export const SHADOW_RAY_MASK_ENTRY_POINT = "shadow_ray_mask_batch";

/** binding 合同（shadowRayPass 的 bindGroup 顺序必须逐项对应）。 */
export const SHADOW_RAY_MASK_BINDINGS = Object.freeze([
  { binding: 0, name: "nodes", type: "read-only-storage" },
  { binding: 1, name: "tlasInstances", type: "read-only-storage" },
  { binding: 2, name: "vertices", type: "read-only-storage" },
  { binding: 3, name: "indices", type: "read-only-storage" },
  { binding: 4, name: "triangleOrder", type: "read-only-storage" },
  { binding: 5, name: "rayStream", type: "read-only-storage" },
  { binding: 6, name: "visibilityMasks", type: "storage" },
  { binding: 7, name: "stackOverflows", type: "storage" },
  { binding: 8, name: "params", type: "uniform" },
] as const);

export interface ShadowRayKernelOptions {
  /** f16 压缩节点档（需 shader-f16 feature；默认 false）。 */
  readonly f16?: boolean;
}

/** 发射阴影 mask 内核源码；f32/f16 两档各自确定性（sha256 合同见 shadowRayKernel.test）。 */
export function emitShadowRayMaskKernelWgsl(options: ShadowRayKernelOptions = {}): string {
  return /* wgsl */ `// Directional-light shadow ray visibility mask (compute BVH skeleton).
// Occlusion semantics: spotShadowRayExtension (hit=occluded, miss=visible); traversal
// fragments shared from bvhTraverseWgsl/bvhTraverseTlasWgsl (contracts in their headers).
${bvhTraverseCoreWgsl(options)}${BVH_SLAB_WGSL}${BVH_INTERSECT_WGSL}${TLAS_INSTANCE_STRUCT_WGSL}struct Params {
  rayCount: u32,
  rayMask: u32,
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<storage, read> nodes: array<BvhNode>;
@group(0) @binding(1) var<storage, read> tlasInstances: array<TlasInstance>;
@group(0) @binding(2) var<storage, read> vertices: array<f32>;
@group(0) @binding(3) var<storage, read> indices: array<u32>;
@group(0) @binding(4) var<storage, read> triangleOrder: array<u32>;
@group(0) @binding(5) var<storage, read> rayStream: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> visibilityMasks: array<u32>;
@group(0) @binding(7) var<storage, read_write> stackOverflows: atomic<u32>;
@group(0) @binding(8) var<uniform> params: Params;

${TLAS_LOCAL_RAY_WGSL}${TLAS_OCCLUDED_WGSL}@compute @workgroup_size(${RAY_TRACE_WORKGROUP_SIZE})
fn ${SHADOW_RAY_MASK_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u) {
  let rayIndex = gid.x;
  if (rayIndex >= params.rayCount) { return; }
  let front = rayStream[rayIndex * 2u];
  let back = rayStream[rayIndex * 2u + 1u];
  let origin = vec3f(front.x, front.y, front.z);
  let dir = vec3f(back.x, back.y, back.z);
  let tMax = front.w;
  let inv = vec3f(1.0 / dir.x, 1.0 / dir.y, 1.0 / dir.z);
  var overflow: u32 = 0u;
  // Occlusion query: hit = occluded (mask 0), miss = visible (mask 1); stack overflow
  // fails closed to 0 (occluded) and raises the batch sentinel -- never silently trusted.
  let occluded = traceTwoLevelOccluded(origin, dir, inv, tMax, params.rayMask, &overflow);
  visibilityMasks[rayIndex] = select(1u, 0u, occluded || overflow != 0u);
}
`;
}

/** params uniform（16B）：rayCount/rayMask + 双 pad。 */
export function packShadowRayUniform(rayCount: number, rayMask: number): ArrayBuffer {
  const data = new ArrayBuffer(16);
  new Uint32Array(data, 0, 4).set([rayCount, rayMask >>> 0, 0, 0]);
  return data;
}
