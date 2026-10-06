/// <reference types="@webgpu/types" />
/**
 * 方向光之外的**反射 closest-hit 帧内核**(GBuffer 内联切片):`ray_trace_closest_frame`。
 * B3 光追双通道的 reflection 二通道:与阴影内核(shadowRayFrameKernel,遮挡 any-hit)
 * 互补,本内核从主帧 depth 逐像素重建着色点与深度差分世界法线,沿镜面反射方向发射
 * **两级(TLAS→BLAS)closest-hit 射线**,写 rgba32float 命中记录纹理
 * ([t, normal.xyz];miss = [-1,0,0,0])供消费端(SSR 屏外合成/环境采样)读取——
 * **无 readback、无 mapAsync、每帧零缓冲重建**(帧循环内联合同,与阴影内核同族)。
 *
 * == 片段拼装 ==
 * closest-hit 家族原样拼装:bvhTraverseCoreWgsl/BVH_SLAB/BVH_INTERSECT_NORMAL/
 * BVH_BLAS_CLOSEST/TLAS_INSTANCE_STRUCT/TLAS_LOCAL_RAY/TLAS_CLOSEST(f16 档透传,
 * 执行器侧 fail-closed 校验 shader-f16)。数值仲裁基准 = CPU traceTlasClosest(tlas.ts)
 * (真机对拍门 scripts/reflectionRayGpuTest.mjs:hit/miss 恒等 + t 相对容差 + 法线点积)。
 *
 * == 布局合同 ==
 * binding 0..4 与阴影内核逐字一致(tlasLayout 拼接);5 = depth(texture_depth_2d);
 * 6 = params uniform(112B:invViewProjection 64B + eyeAndMax 16B + bias 16B + meta 16B);
 * 7 = reflectionHit 纹理(texture_storage_2d<rgba32float, write>);
 * 8 = 栈溢出哨兵(atomic)。
 * 光照遮蔽档(illumination):params 128B(+lightDirection vec4f);9 = bounceShading
 * (rgba32float write,[albedo.rgb, visibility]);10 = instanceAlbedos(read-only
 * storage,下标 = 命中实例原始下标)。
 *
 * == 语义 ==
 * - 背景(depth≥1)无反射接收者:写 miss,不发射射线;
 * - 深度差分法线:右/下单邻域重建两点叉积,朝向相机翻转;邻域越界、邻域为背景、
 *   法线退化(长度 0/非有限)或表面背向相机(dot(incident,n) ≥ -1e-4)一律写 miss
 *   (fail-closed:宁可无反射,不发射方向可疑的射线);
 * - 自相交偏移:origin = p + reflectDir × bias(bias 由调用方按 extent 派生传入,
 *   CPU 参考同式同值);命中 t 为偏移后行程,消费端换算命中点 = origin + dir × t;
 * - 栈溢出 fail-closed:写 miss 并入全局哨兵,CPU 侧校验拒绝该帧结果。
 */

import { bvhTraverseCoreWgsl, BVH_BLAS_CLOSEST_WGSL, BVH_BLAS_OCCLUDED_WGSL, BVH_INTERSECT_NORMAL_WGSL,
  BVH_INTERSECT_WGSL, BVH_SLAB_WGSL } from "./bvhTraverseWgsl.js";
import { TLAS_INSTANCE_STRUCT_WGSL, TLAS_LOCAL_RAY_WGSL, TLAS_CLOSEST_WGSL,
  TLAS_OCCLUDED_WGSL } from "./bvhTraverseTlasWgsl.js";

export const RAY_TRACE_CLOSEST_FRAME_ENTRY_POINT = "ray_trace_closest_frame";

/** binding 合同(rayTraceClosestFramePass 的 bindGroup 顺序必须逐项对应)。 */
export const RAY_TRACE_CLOSEST_FRAME_BINDINGS = Object.freeze([
  { binding: 0, name: "nodes", type: "read-only-storage" },
  { binding: 1, name: "tlasInstances", type: "read-only-storage" },
  { binding: 2, name: "vertices", type: "read-only-storage" },
  { binding: 3, name: "indices", type: "read-only-storage" },
  { binding: 4, name: "triangleOrder", type: "read-only-storage" },
  { binding: 5, name: "depth", type: "texture_depth_2d" },
  { binding: 6, name: "params", type: "uniform" },
  { binding: 7, name: "reflectionHit", type: "storage-texture" },
  { binding: 8, name: "stackOverflows", type: "storage" },
] as const);

/** 光照遮蔽档 binding 合同(基线 9 槽 + 遮蔽记录/反照率表;顺序同执行器 entries)。 */
export const RAY_TRACE_CLOSEST_FRAME_ILLUMINATION_BINDINGS = Object.freeze([
  ...RAY_TRACE_CLOSEST_FRAME_BINDINGS,
  { binding: 9, name: "bounceShading", type: "storage-texture" },
  { binding: 10, name: "instanceAlbedos", type: "read-only-storage" },
] as const);

export interface RayTraceClosestFrameKernelOptions {
  /** f16 压缩节点档(需 shader-f16 feature;默认 false)。 */
  readonly f16?: boolean;
  /**
   * 光照遮蔽变体(P1 RT specular GI 切片):反射命中后再补一腿命中点→光源
   * traceTwoLevelOccluded 可见性,并从 per-instance 反照率表取命中材质反照率,
   * 写 rgba32float 遮蔽记录 [albedo.rgb, visibility](binding 9/10)供一次反弹
   * indirection 消费。默认 false = 遍历体逐字节与基线一致(f32/f16 sha 钉值不变)。
   */
  readonly illumination?: boolean;
}

/** params uniform 字节数(基线档):mat4x4(64)+vec4f(16)+vec4f(16)+vec4u(16)=112。 */
export const RAY_TRACE_CLOSEST_FRAME_PARAMS_BYTES = 112;
/** params uniform 字节数(光照遮蔽档):基线 112 + 光方向 vec4f(16)=128。 */
export const RAY_TRACE_CLOSEST_FRAME_ILLUMINATION_PARAMS_BYTES = 128;

export interface RayTraceClosestFrameParams {
  /** view 空间→世界空间的逆变换(invViewProjection,列主序 16 f32)。 */
  readonly invViewProjection: readonly [number, number, number, number, number, number, number, number,
    number, number, number, number, number, number, number, number];
  /** 相机世界位置(帧 eye;入射方向与法线朝向判定的单一来源)。 */
  readonly eye: readonly [number, number, number];
  /** 反射射线最大行程(世界单位)。 */
  readonly tMax: number;
  /** 自相交偏移(世界单位;调用方按 extent 派生,CPU 参考同式同值)。 */
  readonly bias: number;
  /** 遮挡实例掩码(透传 traceTwoLevelClosest)。 */
  readonly rayMask: number;
  /** 内部渲染分辨率(命中纹理尺寸)。 */
  readonly width: number;
  readonly height: number;
  /** 光照遮蔽档:表面→光源单位世界方向(主方向光;缺省 = 基线 112B 布局)。 */
  readonly lightDirectionWorld?: readonly [number, number, number];
  /** 光照遮蔽档:per-instance 反照率表条数(= 实例数;WGSL 侧越界回退中性反照率)。 */
  readonly albedoCount?: number;
}

/** 打包 params uniform(112B):invViewProjection + [eye,tMax] + [bias,0,0,0] + [rayMask,w,h,0]。 */
export function packRayTraceClosestFrameUniform(params: RayTraceClosestFrameParams): ArrayBuffer {
  const illumination = params.lightDirectionWorld !== undefined;
  const data = new ArrayBuffer(illumination ? RAY_TRACE_CLOSEST_FRAME_ILLUMINATION_PARAMS_BYTES
    : RAY_TRACE_CLOSEST_FRAME_PARAMS_BYTES);
  const f32 = new Float32Array(data);
  const u32 = new Uint32Array(data);
  for (let i = 0; i < 16; i++) f32[i] = params.invViewProjection[i]!;
  f32[16] = params.eye[0]!; f32[17] = params.eye[1]!; f32[18] = params.eye[2]!; f32[19] = params.tMax;
  f32[20] = params.bias; f32[21] = 0; f32[22] = 0; f32[23] = 0;
  if (illumination) {
    f32[24] = params.lightDirectionWorld![0]!; f32[25] = params.lightDirectionWorld![1]!;
    f32[26] = params.lightDirectionWorld![2]!; f32[27] = 0;
    u32[28] = params.rayMask >>> 0; u32[29] = params.width; u32[30] = params.height;
    u32[31] = params.albedoCount ?? 0;
  } else {
    u32[24] = params.rayMask >>> 0; u32[25] = params.width; u32[26] = params.height; u32[27] = 0;
  }
  return data;
}

/** miss 记录常量(t=-1 语义;与内核 miss 路径逐位一致,CPU 侧同样用它判 miss)。 */
export const RAY_TRACE_CLOSEST_FRAME_MISS_T = -1;

/** 发射帧循环反射 closest-hit 内核源码;f32/f16 两档各自确定性(sha256 合同见本测试)。 */
export function emitRayTraceClosestFrameKernelWgsl(options: RayTraceClosestFrameKernelOptions = {}): string {
  // 基线档(illumination 缺省)逐字节与 2026-10-05 B3 基线一致(f32/f16 sha 钉值不变);
  // 光照遮蔽档只做加法:额外注释/绑定/遮蔽片段/遮蔽腿,不改动基线遍历语义。
  const illumination = options.illumination === true;
  const illumHeader = illumination
    ? `// Illumination variant (P1 RT specular GI slice): after the reflection closest-hit, a
// second leg traces visibility from the hit point toward the primary light
// (traceTwoLevelOccluded, same fail-closed side as the shadow kernel) and the hit
// material albedo is fetched from a per-instance table. The extra rgba32float record
// [albedo.rgb, visibility] feeds the one-bounce indirection consumer.
`
    : "";
  const illumStructField = illumination
    ? `  // 光照遮蔽档:表面→光源单位方向(命中点遮蔽腿;pack 128B 布局合同)。
  lightDirection: vec4f,
`
    : "";
  const illumBindings = illumination
    ? `
@group(0) @binding(9) var bounceShading: texture_storage_2d<rgba32float, write>;
@group(0) @binding(10) var<storage, read> instanceAlbedos: array<vec4f>;`
    : "";
  const illumFragments = illumination
    ? `${BVH_INTERSECT_WGSL}${BVH_BLAS_OCCLUDED_WGSL}${TLAS_OCCLUDED_WGSL}`
    : "";
  const frameStoreMiss = illumination
    ? `fn frameStoreMiss(px: vec2u) {
  textureStore(reflectionHit, px, vec4f(${RAY_TRACE_CLOSEST_FRAME_MISS_T}.0, 0.0, 0.0, 0.0));
  textureStore(bounceShading, px, vec4f(0.0));
}`
    : `fn frameStoreMiss(px: vec2u) {
  textureStore(reflectionHit, px, vec4f(${RAY_TRACE_CLOSEST_FRAME_MISS_T}.0, 0.0, 0.0, 0.0));
}`;
  const illumShadingLeg = illumination
    ? `
  // 光照遮蔽腿:命中点沿表面→光源方向补一腿遮挡射线(any-hit 早退;遮挡/栈溢出
  // fail-closed 到 visibility=0,与阴影内核同保守侧),反照率取 per-instance 表
  // (下标 = 命中实例原始下标;越界回退中性 0.5),写 [albedo.rgb, visibility]。
  var bounceAlbedo = vec3f(0.5, 0.5, 0.5);
  if (hit.instanceIndex < params.frameMeta.w) {
    bounceAlbedo = clamp(instanceAlbedos[hit.instanceIndex].rgb, vec3f(0.0), vec3f(1.0));
  }
  var visibility = 1.0;
  let lightDir = params.lightDirection.xyz;
  if (dot(lightDir, lightDir) > 0.5) {
    let hitPosition = origin + reflectDir * hit.t;
    let shadowOrigin = hitPosition + lightDir * params.biasAndPad.x;
    let shadowInv = vec3f(1.0 / lightDir.x, 1.0 / lightDir.y, 1.0 / lightDir.z);
    var shadowOverflow: u32 = 0u;
    let occluded = traceTwoLevelOccluded(shadowOrigin, lightDir, shadowInv,
      params.eyeAndMax.w, params.frameMeta.x, &shadowOverflow);
    visibility = select(1.0, 0.0, occluded || shadowOverflow != 0u);
  }
  textureStore(bounceShading, px, vec4f(bounceAlbedo, visibility));`
    : "";
  return /* wgsl */ `// Reflection closest-hit ray record (frame-inline GBuffer variant).
// Complementary channel to the shadow occlusion kernel: same depth reconstruction,
// mirrored emitter pattern, closest-hit (TLAS -> BLAS) instead of any-hit. The output
// rgba32float record [t, normal.xyz] feeds offscreen reflection compositing consumers.
${illumHeader}${bvhTraverseCoreWgsl(options)}${BVH_SLAB_WGSL}${BVH_INTERSECT_NORMAL_WGSL}${BVH_BLAS_CLOSEST_WGSL}${TLAS_INSTANCE_STRUCT_WGSL}struct FrameParams {
  invViewProjection: mat4x4f,
  eyeAndMax: vec4f,
  biasAndPad: vec4f,
${illumStructField}  // "meta" is a WGSL reserved keyword (Dawn rejects at compile); frameMeta keeps the layout.
  frameMeta: vec4u,
}

@group(0) @binding(0) var<storage, read> nodes: array<BvhNode>;
@group(0) @binding(1) var<storage, read> tlasInstances: array<TlasInstance>;
@group(0) @binding(2) var<storage, read> vertices: array<f32>;
@group(0) @binding(3) var<storage, read> indices: array<u32>;
@group(0) @binding(4) var<storage, read> triangleOrder: array<u32>;
@group(0) @binding(5) var depth: texture_depth_2d;
@group(0) @binding(6) var<uniform> params: FrameParams;
@group(0) @binding(7) var reflectionHit: texture_storage_2d<rgba32float, write>;
@group(0) @binding(8) var<storage, read_write> stackOverflows: atomic<u32>;${illumBindings}

${TLAS_LOCAL_RAY_WGSL}${TLAS_CLOSEST_WGSL}${illumFragments}fn frameWorldPosition(px: vec2u) -> vec3f {
  let depthSample = textureLoad(depth, px, 0);
  let uv = (vec2f(f32(px.x), f32(px.y)) + vec2f(0.5, 0.5)) / vec2f(f32(params.frameMeta.y), f32(params.frameMeta.z));
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depthSample, 1.0);
  let world = params.invViewProjection * ndc;
  return world.xyz / world.w;
}

${frameStoreMiss}

@compute @workgroup_size(8, 8, 1)
fn ${RAY_TRACE_CLOSEST_FRAME_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u) {
  let px = gid.xy;
  if (px.x >= params.frameMeta.y || px.y >= params.frameMeta.z) { return; }
  // 背景(depth≥1)无反射接收者:写 miss,不发射射线。
  if (textureLoad(depth, px, 0) >= 1.0) {
    frameStoreMiss(px);
    return;
  }
  // 深度差分世界法线:右/下单邻域重建两点叉积(与 CPU 参考同式同分支;任一邻域
  // 越界/为背景/退化即 miss,fail-closed 不发射方向可疑的射线)。
  let right = px + vec2u(1u, 0u);
  let down = px + vec2u(0u, 1u);
  if (right.x >= params.frameMeta.y || down.y >= params.frameMeta.z) {
    frameStoreMiss(px);
    return;
  }
  if (textureLoad(depth, right, 0) >= 1.0 || textureLoad(depth, down, 0) >= 1.0) {
    frameStoreMiss(px);
    return;
  }
  let world = frameWorldPosition(px);
  let worldRight = frameWorldPosition(right);
  let worldDown = frameWorldPosition(down);
  var normal = cross(worldRight - world, worldDown - world);
  let normalLength = length(normal);
  if (!(normalLength > 0.0)) {
    frameStoreMiss(px);
    return;
  }
  normal = normal / normalLength;
  // 朝向相机先行(叉积手性随视角翻转;先定向再判掠射,顺序与 CPU 参考逐分支一致)。
  if (dot(normal, params.eyeAndMax.xyz - world) < 0.0) { normal = -normal; }
  let eye = params.eyeAndMax.xyz;
  var incident = world - eye;
  let incidentLength = length(incident);
  if (!(incidentLength > 0.0)) {
    frameStoreMiss(px);
    return;
  }
  incident = incident / incidentLength;
  // 掠射/轮廓处深度差分噪声不发射:反射方向将立即扎进表面。
  if (dot(incident, normal) >= -1e-4) {
    frameStoreMiss(px);
    return;
  }
  let reflectDir = incident - 2.0 * dot(incident, normal) * normal;
  let inv = vec3f(1.0 / reflectDir.x, 1.0 / reflectDir.y, 1.0 / reflectDir.z);
  let origin = world + reflectDir * params.biasAndPad.x;
  var overflow: u32 = 0u;
  var hit: TraverseHit;
  let found = traceTwoLevelClosest(origin, reflectDir, inv, params.eyeAndMax.w, params.frameMeta.x, &hit, &overflow);
  if (found == 0u || overflow != 0u) {
    // miss 与栈溢出同写 miss(无反射是保守侧:不产生虚假能量);溢出并入全局哨兵。
    frameStoreMiss(px);
    return;
  }
  textureStore(reflectionHit, px, vec4f(hit.t, hit.normal.x, hit.normal.y, hit.normal.z));${illumShadingLeg}
}
`;
}
