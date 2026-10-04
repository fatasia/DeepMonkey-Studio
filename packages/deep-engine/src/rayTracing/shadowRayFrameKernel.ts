/// <reference types="@webgpu/types" />
/**
 * 方向光阴影光线帧内核(GBuffer 内联切片):`shadow_ray_mask_frame`。
 * 与探针内核(shadowRayKernel 的 rayStream 批量模式)不同,本内核从主帧循环的
 * depth 纹理逐像素重建着色点,沿均匀方向光发射两级(TLAS→BLAS)遮挡射线,
 * 写 r32float mask 纹理(1.0=可见/0.0=遮挡)供直接光 pass 采样——
 * **无 readback、无 mapAsync、每帧零缓冲重建**(帧循环内联合同)。
 *
 * == 片段拼装 ==
 * 遍历片段与探针内核逐字同源:bvhTraverseCoreWgsl/BVH_SLAB/BVH_INTERSECT/
 * TLAS 三片段原样拼装(f16 档透传,执行器侧 fail-closed 校验 shader-f16)。
 *
 * == 布局合同 ==
 * binding 0..4 与探针完全一致(tlasLayout 拼接);5 = depth(texture_depth_2d);
 * 6 = params uniform(96B:invViewProjection 64B + dirAndMax 16B + meta 16B);
 * 7 = mask 纹理(texture_storage_2d<r32float, write>);8 = 栈溢出哨兵(atomic)。
 * storage 计数 5(nodes/instances/vertices/indices/order… 注:order 并入 0..4),
 * 实际 storage 5 条 + depth 纹理 1 + storage 纹理 1 + uniform 1,均在默认上限内。
 *
 * == 语义 ==
 * mask 1.0=可见(miss)/0.0=遮挡(命中);背景(depth≥1)与栈溢出 fail-closed
 * 写 0.0/遮挡语义由调用方合同决定:背景写 1.0(无几何即无阴影接收者),
 * 栈溢出写 0.0(遮挡侧保守)并入全局哨兵由 CPU 侧校验拒绝该帧结果。
 */

import { bvhTraverseCoreWgsl, BVH_BLAS_OCCLUDED_WGSL, BVH_INTERSECT_WGSL, BVH_SLAB_WGSL } from "./bvhTraverseWgsl.js";
import { TLAS_INSTANCE_STRUCT_WGSL, TLAS_LOCAL_RAY_WGSL, TLAS_OCCLUDED_WGSL } from "./bvhTraverseTlasWgsl.js";

export const SHADOW_RAY_FRAME_ENTRY_POINT = "shadow_ray_mask_frame";

/** binding 合同(shadowRayFramePass 的 bindGroup 顺序必须逐项对应)。 */
export const SHADOW_RAY_FRAME_BINDINGS = Object.freeze([
  { binding: 0, name: "nodes", type: "read-only-storage" },
  { binding: 1, name: "tlasInstances", type: "read-only-storage" },
  { binding: 2, name: "vertices", type: "read-only-storage" },
  { binding: 3, name: "indices", type: "read-only-storage" },
  { binding: 4, name: "triangleOrder", type: "read-only-storage" },
  { binding: 5, name: "depth", type: "texture_depth_2d" },
  { binding: 6, name: "params", type: "uniform" },
  { binding: 7, name: "shadowMask", type: "storage-texture" },
  { binding: 8, name: "stackOverflows", type: "storage" },
] as const);

export interface ShadowRayFrameKernelOptions {
  /** f16 压缩节点档(需 shader-f16 feature;默认 false)。 */
  readonly f16?: boolean;
}

/** params uniform 字节数:mat4x4(64)+vec4f(16)+vec4u(16)=96。 */
export const SHADOW_RAY_FRAME_PARAMS_BYTES = 96;

export interface ShadowRayFrameParams {
  /** view 空间→世界空间的逆变换(invViewProjection,列主序 16 f32)。 */
  readonly invViewProjection: readonly [number, number, number, number, number, number, number, number,
    number, number, number, number, number, number, number, number];
  /** 单位化"指向光"方向(世界空间)。 */
  readonly lightDir: readonly [number, number, number];
  /** 遮挡射线最大距离(世界单位)。 */
  readonly tMax: number;
  /** 遮挡实例掩码(透传 traceTwoLevelOccluded)。 */
  readonly rayMask: number;
  /** 内部渲染分辨率(mask 纹理尺寸)。 */
  readonly width: number;
  readonly height: number;
}

/** 打包 params uniform(96B):invViewProjection + [dir,tMax] + [rayMask,width,height,0]。 */
export function packShadowRayFrameUniform(params: ShadowRayFrameParams): ArrayBuffer {
  const data = new ArrayBuffer(SHADOW_RAY_FRAME_PARAMS_BYTES);
  const f32 = new Float32Array(data);
  const u32 = new Uint32Array(data);
  for (let i = 0; i < 16; i++) f32[i] = params.invViewProjection[i]!;
  f32[16] = params.lightDir[0]!; f32[17] = params.lightDir[1]!; f32[18] = params.lightDir[2]!; f32[19] = params.tMax;
  u32[20] = params.rayMask >>> 0; u32[21] = params.width; u32[22] = params.height; u32[23] = 0;
  return data;
}

/** 发射帧循环阴影 mask 内核源码;f32/f16 两档各自确定性(sha256 合同见 shadowRayFrameKernel.test)。 */
export function emitShadowRayFrameKernelWgsl(options: ShadowRayFrameKernelOptions = {}): string {
  return /* wgsl */ `// Directional-light shadow ray visibility mask (frame-inline GBuffer variant).
// Same traversal fragments as the probe kernel (contracts in their headers); the ray
// origin is rebuilt from the main-frame depth, the result goes to an r32float mask
// texture consumed in-place by the direct-light pass — no readback, no per-frame buffers.
${bvhTraverseCoreWgsl(options)}${BVH_SLAB_WGSL}${BVH_INTERSECT_WGSL}${TLAS_INSTANCE_STRUCT_WGSL}struct FrameParams {
  invViewProjection: mat4x4f,
  dirAndMax: vec4f,
  meta: vec4u,
}

@group(0) @binding(0) var<storage, read> nodes: array<BvhNode>;
@group(0) @binding(1) var<storage, read> tlasInstances: array<TlasInstance>;
@group(0) @binding(2) var<storage, read> vertices: array<f32>;
@group(0) @binding(3) var<storage, read> indices: array<u32>;
@group(0) @binding(4) var<storage, read> triangleOrder: array<u32>;
@group(0) @binding(5) var depth: texture_depth_2d;
@group(0) @binding(6) var<uniform> params: FrameParams;
@group(0) @binding(7) var shadowMask: texture_storage_2d<r32float, write>;
@group(0) @binding(8) var<storage, read_write> stackOverflows: atomic<u32>;

${TLAS_LOCAL_RAY_WGSL}${BVH_BLAS_OCCLUDED_WGSL}${TLAS_OCCLUDED_WGSL}@compute @workgroup_size(8, 8, 1)
fn ${SHADOW_RAY_FRAME_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u) {
  let px = gid.xy;
  if (px.x >= params.meta.y || px.y >= params.meta.z) { return; }
  // 背景(depth≥1)无接收者:写可见,不发射射线。
  let depthSample = textureLoad(depth, px, 0);
  if (depthSample >= 1.0) {
    textureStore(shadowMask, px, vec4f(1.0, 1.0, 1.0, 1.0));
    return;
  }
  // NDC(uv*2-1, depth)→世界空间:invViewProjection 变换后透视除。
  let uv = (vec2f(f32(px.x), f32(px.y)) + vec2f(0.5, 0.5)) / vec2f(f32(params.meta.y), f32(params.meta.z));
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depthSample, 1.0);
  let world = params.invViewProjection * ndc;
  let origin = world.xyz / world.w;
  let dir = params.dirAndMax.xyz;
  let inv = vec3f(1.0 / dir.x, 1.0 / dir.y, 1.0 / dir.z);
  var overflow: u32 = 0u;
  // Occlusion semantics (spotShadowRayExtension): hit = occluded (0.0), miss = visible (1.0);
  // stack overflow fails closed to 0.0 (occluded) and raises the frame sentinel.
  let occluded = traceTwoLevelOccluded(origin, dir, inv, params.dirAndMax.w, params.meta.x, &overflow);
  // 全局哨兵由遍历片段内置 atomicAdd 累计(与探针内核同源),此处只消费局部标志。
  textureStore(shadowMask, px, vec4f(select(1.0, 0.0, occluded || overflow != 0u), 1.0, 1.0, 1.0));
}
`;
}
