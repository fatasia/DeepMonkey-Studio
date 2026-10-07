/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { failWithResourceCleanup } from "../webgpu/resourceCleanup.js";
import { bvhTraverseCoreWgsl, BVH_BLAS_OCCLUDED_WGSL, BVH_INTERSECT_WGSL, BVH_SLAB_WGSL } from "../rayTracing/bvhTraverseWgsl.js";
import { TLAS_INSTANCE_STRUCT_WGSL, TLAS_LOCAL_RAY_WGSL, TLAS_OCCLUDED_WGSL } from "../rayTracing/bvhTraverseTlasWgsl.js";
import type { TlasPackedScene } from "../rayTracing/tlasLayout.js";
import { RAY_TRACE_WORKGROUP_SIZE } from "../rayTracing/rayTraceLayout.js";
import { DEEP_IES_SAMPLING_WGSL } from "./iesSamplingWgsl.js";
import { packIesShading, type PackedIesShading } from "./iesShading.js";
import { packMegaLights, MEGA_LIGHT_ABI_VERSION, MAX_MEGA_LIGHTS,
  MEGALIGHTS_RIS_CANDIDATES, type PackedMegaLights } from "./megaLights.js";
import { MEGA_LIGHTS_ABI_VERSION, MEGA_LIGHTS_BIND_GROUP, MEGA_LIGHTS_COLOR_BINDING,
  MEGA_LIGHTS_COLOR_HISTORY_BINDING, MEGA_LIGHTS_IES_BINDING, MEGA_LIGHTS_INDICES_BINDING,
  MEGA_LIGHTS_INSTANCES_BINDING, MEGA_LIGHTS_MOTION_BINDING, MEGA_LIGHTS_NODES_BINDING,
  MEGA_LIGHTS_OVERFLOW_BINDING, MEGA_LIGHTS_PARAMS_BYTES, MEGA_LIGHTS_PARAMS_BINDING,
  MEGA_LIGHTS_POOL_BINDING, MEGA_LIGHTS_RAY_STREAM_BINDING, MEGA_LIGHTS_RESERVOIRS_A_BINDING,
  MEGA_LIGHTS_RESERVOIRS_B_BINDING, MEGA_LIGHTS_ORDER_BINDING, MEGA_LIGHTS_SURFACES_BINDING,
  MEGA_LIGHTS_SURFACES_STRIDE_VEC4, MEGA_LIGHTS_VERTICES_BINDING,
  MEGA_LIGHTS_VISIBILITY_RAY_BIAS_RELATIVE, MEGA_LIGHTS_VIS_MASK_BINDING,
  MEGA_LIGHTS_VIS_PARAMS_BINDING, MEGA_LIGHTS_VIS_PARAMS_BYTES } from "./megaLightsAbi.js";
import { MEGA_LIGHTS_RIS_WGSL } from "./megaLightsRisWgsl.js";

/**
 * B2 MegaLights M1/M2 compute 运行时:两趟 RIS 直接光(buildReservoirs → reuseAndShade)。
 * 领地纪律:不触碰 webgpu/pbrOpaquePass|renderTargets|pipelines|pbrRendererFrames|
 * virtualShadow*|pbrDepthResolve|pbrMsaaCapability(MSAA/VSM 并行)——本通路自持
 * storage 资源(1x,无 MSAA 附件),主 pass 接入(wiring)由 pbrRendererFrames
 * 单点最小 diff 完成(MegaLightsFrameController)。
 *
 * == 组合顺序(WGSL 声明先于使用) ==
 * storage 声明 + E02 IES 单源 → 可见性取值函数(宿主注入,legacy 恒 1.0)→
 * BVH 遍历片段族(仅可见性档)→ RIS 库(引用上述符号)→ 胜者射线写出(仅可见性档,
 * 引用 RIS 库的 deepMegaLoad)→ uniform var + 三个 @compute 入口。
 *
 * == M2 胜者可见性射线(2026-10-05,构造项 visibility 开启时装配) ==
 * 三段管线,各段 storage 计数 ≤ 默认上限 8(布局按入口静态使用最小声明,聚合
 * 上限按管线布局逐管线校验,不做全集布局):
 *   build  (7 storage):RIS 趟一 + 胜者遮挡射线流写出(32B/像素,rayTraceLayout 同构;
 *          view→world 由 DeepMegaVisParams 的 viewToWorld 变换——灯池/表面均为视空间)。
 *   trace  (8 storage):逐像素取射线流 → shadowRayKernel 的 traceTwoLevelOccluded
 *          片段族两级 TLAS→BLAS any-hit → mask 写 color.w(1=可见/0=遮挡/溢出
 *          fail-closed 0 + 哨兵,合同与 shadow 家族逐字同源)。穷举/关闭帧零 dispatch。
 *   shade  (7 storage):RIS 趟二;deepMegaVisibilityAt 读 color.w —— self 路径乘
 *          本像素 mask,空间分支乘**源像素** mask(过相似门像素的可见性传递,
 *          ReSTIR DI visibility reuse 惯例)。可见性只乘 shade 侧,目标权重保持
 *          无遮挡口径(估计器合同,CPU 镜像 megaLightsRisCpu 同式同位)。
 * 可见性档关闭(缺省构造或 prepare 不带 visibility)→ params.visibilityEnabled=0:
 * trace 零 dispatch、visibilityAt 恒 1.0(×1.0 精确),帧输出与 M1 逐位一致。
 * 生产帧 TLAS 供给已收口(2026-10-05):MegaLightsFrameController 按帧上下文消费
 * pbrRendererFrames 复用 RT 阴影 staging 通道(rtShadows.packedScene)供给的场景,
 * 供给失败 fail-closed 恒 1 并经 FrameMetrics.megaLights.visibilitySource 披露;
 * 真机验收走 scripts/megaLightsGpuTest.mjs 可见性腿 + 渲染级 harness 供给腿。
 */

/** 趟一入口(buildReservoirs:K 候选 + 时域合并 → A [+ 胜者射线流])。 */
export const MEGA_LIGHTS_ENTRY_BUILD = "deepMegaBuildReservoirsFrame";
/** 趟二入口(reuseAndShade:5×5 空间合并 + 胜者着色 → B + color)。 */
export const MEGA_LIGHTS_ENTRY_SHADE = "deepMegaReuseAndShadeFrame";
/** 可见性入口(胜者遮挡射线;仅可见性档装配)。 */
export const MEGA_LIGHTS_ENTRY_VISIBILITY = "deepMegaTraceWinnerVisibility";
export const MEGA_LIGHTS_WORKGROUP_SIZE = 8;

export interface MegaLightsVisibilityOptions {
  /** f16 压缩节点档(需 device "shader-f16" feature;缺省 false,缺失即构造抛错)。 */
  readonly f16?: boolean;
}

export interface MegaLightsRuntimeOptions {
  /** M2 胜者可见性射线档(缺省关 = 既有 M1 逐位行为)。 */
  readonly visibility?: MegaLightsVisibilityOptions;
}

/** 宿主模板:绑定声明(槽位与 megaLightsAbi.ts 互钉)+ IES 单源 + 可见性装配 +
 * RIS 库 + 入口。 */
export function composeMegaLightsShader(options: MegaLightsRuntimeOptions = {}): string {
  const visibility = options.visibility !== undefined;
  const f16 = options.visibility?.f16 === true;
  return /* wgsl */ `
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_PARAMS_BINDING}) var<uniform> deepMegaFrame: DeepMegaParams;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_POOL_BINDING}) var<storage, read> deepMegaLights: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_SURFACES_BINDING}) var<storage, read> deepMegaSurfaces: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_MOTION_BINDING}) var<storage, read> deepMegaMotion: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_RESERVOIRS_A_BINDING}) var<storage, read_write> deepMegaReservoirsA: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_RESERVOIRS_B_BINDING}) var<storage, read_write> deepMegaReservoirsB: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_COLOR_BINDING}) var<storage, read_write> deepMegaColor: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_COLOR_HISTORY_BINDING}) var<storage, read_write> deepMegaColorHistory: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_IES_BINDING}) var<storage, read> deepIesShading: array<vec4<f32>>;
${visibility ? `
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_RAY_STREAM_BINDING}) var<storage, read_write> deepMegaRayStream: array<vec4<f32>>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_OVERFLOW_BINDING}) var<storage, read_write> stackOverflows: atomic<u32>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_NODES_BINDING}) var<storage, read> nodes: array<BvhNode>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_INSTANCES_BINDING}) var<storage, read> tlasInstances: array<TlasInstance>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_VERTICES_BINDING}) var<storage, read> vertices: array<f32>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_INDICES_BINDING}) var<storage, read> indices: array<u32>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_ORDER_BINDING}) var<storage, read> triangleOrder: array<u32>;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_VIS_PARAMS_BINDING}) var<uniform> deepMegaVis: DeepMegaVisParams;
@group(${MEGA_LIGHTS_BIND_GROUP}) @binding(${MEGA_LIGHTS_VIS_MASK_BINDING}) var<storage, read_write> deepMegaVisibilityMask: array<u32>;
struct DeepMegaVisParams {
  viewToWorld: mat4x4f,
  rayMask: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};
` : ""}
${DEEP_IES_SAMPLING_WGSL}${visibility ? `
// 胜者可见性取值(宿主注入;RIS 库在 shade 侧调用。可见性档关闭恒 1.0 →
// ×1.0 精确;开启时读 color.w 的胜者遮挡 mask,trace pass 在 build→shade 之间写入)。
fn deepMegaVisibilityAt(pixelIndex: u32) -> f32 {
  if (deepMegaFrame.visibilityEnabled == 0u) { return 1.0; }
  return f32(deepMegaVisibilityMask[pixelIndex]);
}
` : `
// M1 可见性恒 1.0(可见性档未构造;×1.0 精确,帧输出与 v1 逐位一致)。
fn deepMegaVisibilityAt(pixelIndex: u32) -> f32 { return 1.0; }
`}${visibility ? `${bvhTraverseCoreWgsl({ f16 })}${BVH_SLAB_WGSL}${BVH_INTERSECT_WGSL}${TLAS_INSTANCE_STRUCT_WGSL}${TLAS_LOCAL_RAY_WGSL}${BVH_BLAS_OCCLUDED_WGSL}${TLAS_OCCLUDED_WGSL}` : ""}${MEGA_LIGHTS_RIS_WGSL}${visibility ? `
// 胜者遮挡射线写出(趟一末尾;灯池/表面均为视空间 → 经 viewToWorld 拉回世界再发射,
// 与 shadow 家族的世界空间 TLAS 对齐)。origin 沿线外推 + tMax 双侧收缩(相对偏移,
// 同 rayTraceClosest 家族 bias 角色),胜者无效写 tMax=0 退化射线(trace 侧判 0 直通可见)。
fn deepMegaWriteWinnerRay(pixelIndex: u32, built: vec4f, positionView: vec3f) {
  let winnerWord = u32(built.y);
  let worldOrigin = deepMegaVis.viewToWorld * vec4f(positionView, 1.0);
  if (winnerWord == 0u) {
    deepMegaRayStream[pixelIndex * 2u] = vec4f(worldOrigin.xyz, 0.0);
    deepMegaRayStream[pixelIndex * 2u + 1u] = vec4f(1.0, 0.0, 0.0, 0.0);
    return;
  }
  let record = deepMegaLoad(winnerWord - 1u);
  let worldTarget = deepMegaVis.viewToWorld * vec4f(record.position, 1.0);
  let delta = worldTarget.xyz - worldOrigin.xyz;
  let distance = length(delta);
  if (!(distance > 0.0)) {
    deepMegaRayStream[pixelIndex * 2u] = vec4f(worldOrigin.xyz, 0.0);
    deepMegaRayStream[pixelIndex * 2u + 1u] = vec4f(1.0, 0.0, 0.0, 0.0);
    return;
  }
  let direction = delta / distance;
  let epsilon = distance * ${MEGA_LIGHTS_VISIBILITY_RAY_BIAS_RELATIVE};
  deepMegaRayStream[pixelIndex * 2u] = vec4f(worldOrigin.xyz + direction * epsilon, distance - epsilon - epsilon);
  deepMegaRayStream[pixelIndex * 2u + 1u] = vec4f(direction, 0.0);
}
` : ""}
@compute @workgroup_size(${MEGA_LIGHTS_WORKGROUP_SIZE}, ${MEGA_LIGHTS_WORKGROUP_SIZE})
fn ${MEGA_LIGHTS_ENTRY_BUILD}(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= deepMegaFrame.viewport.x || gid.y >= deepMegaFrame.viewport.y) { return; }
  let pixelIndex = gid.y * deepMegaFrame.viewport.x + gid.x;
  let surfaceA = deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u];
  let surfaceB = deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u + 1u];
  let surfaceC = deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u + 2u];
  let built = deepMegaBuildReservoir(deepMegaFrame, pixelIndex,
    surfaceA, surfaceB, surfaceC, deepMegaReservoirsB[pixelIndex], deepMegaMotion[pixelIndex].xy);
  deepMegaReservoirsA[pixelIndex] = built;
  ${visibility ? `if (deepMegaFrame.visibilityEnabled != 0u && deepMegaFrame.exhaustive == 0u) {
    deepMegaWriteWinnerRay(pixelIndex, built, surfaceA.xyz);
  }` : ""}
}

${visibility ? `@compute @workgroup_size(${RAY_TRACE_WORKGROUP_SIZE})
fn ${MEGA_LIGHTS_ENTRY_VISIBILITY}(@builtin(global_invocation_id) gid: vec3u) {
  let pixelIndex = gid.x;
  if (pixelIndex >= deepMegaFrame.viewport.x * deepMegaFrame.viewport.y) { return; }
  if (deepMegaFrame.visibilityEnabled == 0u || deepMegaFrame.exhaustive != 0u) { return; }
  let front = deepMegaRayStream[pixelIndex * 2u];
  if (front.w <= 0.0) { deepMegaVisibilityMask[pixelIndex] = 1u; return; }
  let back = deepMegaRayStream[pixelIndex * 2u + 1u];
  let dir = back.xyz;
  let inv = vec3f(1.0 / dir.x, 1.0 / dir.y, 1.0 / dir.z);
  var overflow: u32 = 0u;
  // 遮挡语义同 shadow 家族:hit=遮挡,miss=可见;栈溢出 fail-closed 写 0 并入哨兵。
  let occluded = traceTwoLevelOccluded(front.xyz, dir, inv, front.w, deepMegaVis.rayMask, &overflow);
  deepMegaVisibilityMask[pixelIndex] = select(1u, 0u, occluded || overflow != 0u);
}
` : ""}@compute @workgroup_size(${MEGA_LIGHTS_WORKGROUP_SIZE}, ${MEGA_LIGHTS_WORKGROUP_SIZE})
fn ${MEGA_LIGHTS_ENTRY_SHADE}(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= deepMegaFrame.viewport.x || gid.y >= deepMegaFrame.viewport.y) { return; }
  let pixelIndex = gid.y * deepMegaFrame.viewport.x + gid.x;
  let surfaceA = deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u];
  let surfaceB = deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u + 1u];
  let surfaceC = deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u + 2u];
  var center = deepMegaReservoirUnpack(deepMegaReservoirsA[pixelIndex]);
  let color = deepMegaReuseAndShade(deepMegaFrame, pixelIndex, surfaceA, surfaceB, surfaceC, &center);
  // 颜色时域 EMA(temporalEnabled 时按 alphaBlend 混合;首帧宿主传 1 全量替换):
  // M1 噪声下限控制——单帧 K=32 RIS 的方差由帧间指数窗口收敛,与生产 TAA/TSR 组合同职责。
  var blended = color;
  if (deepMegaFrame.temporalEnabled != 0u) {
    blended = mix(deepMegaColorHistory[pixelIndex].rgb, color, vec3f(deepMegaFrame.alphaBlend));
  }
  deepMegaColor[pixelIndex] = vec4f(blended, 0.0);
  deepMegaColorHistory[pixelIndex] = vec4f(blended, 0.0);
  deepMegaReservoirsB[pixelIndex] = deepMegaReservoirPack(center, -surfaceA.z);
}
`;
}

export interface MegaLightsFrameFlags {
  readonly temporalEnabled: boolean;
  readonly spatialEnabled: boolean;
  /** 穷举对拍模式(K≥N 遍历全灯,输出恒等于精确和;⑤ 退化一致性腿专用)。 */
  readonly exhaustive?: boolean;
}

/** M2 胜者可见性射线帧输入(仅可见性档构造时消费;缺省 = 关闭,帧逐位 M1)。 */
export interface MegaLightsFrameVisibilityInput {
  /** TLAS 打包场景(BLAS 段变化整体重传,同 shadow 家族 staging 合同)。 */
  readonly scene: TlasPackedScene;
  /** 列主序 view→world(16 f32;invertColumnMajor4x4 输出族)。 */
  readonly viewToWorld: Float32Array;
  /** TLAS 实例 mask(缺省全通 0xffffffff)。 */
  readonly rayMask?: number;
}

export interface MegaLightsPrepareInput extends MegaLightsFrameFlags {
  readonly width: number;
  readonly height: number;
  readonly lights: PackedMegaLights;
  /** 表面 storage 字节(像素 × 3 vec4,布局见 megaLightsAbi.ts)。 */
  readonly surfaces: Float32Array;
  /** 逐像素运动(motionUv.xy,像素 × 1 vec4);缺省全零 + 关时域。 */
  readonly motion?: Float32Array | undefined;
  /** E02 IES 载荷(packIesShading 输出);缺省最小 -1 行(因子恒 1)。 */
  readonly ies?: PackedIesShading | undefined;
  /** 帧种子(缺省递增;静态场景传固定值 → 逐位稳定,③ 闪烁门腿用)。 */
  readonly frameSeed?: number | undefined;
  /** 颜色 EMA 系数(temporalEnabled 时生效;首帧传 1 全量替换;缺省 1/32)。 */
  readonly alphaBlend?: number | undefined;
  /** 胜者可见性射线输入(仅可见性档;本帧缺省 = 关闭,trace 零 dispatch)。 */
  readonly visibility?: MegaLightsFrameVisibilityInput | undefined;
}

export interface MegaLightsFrameResources {
  readonly lightCount: number;
  readonly width: number;
  readonly height: number;
  /** 本帧可见性射线是否启用(trace pass 是否 dispatch)。 */
  readonly visibilityEnabled: boolean;
}

interface MegaLightsAllocation {
  readonly width: number;
  readonly height: number;
  readonly lightVec4s: number;
  readonly iesVec4s: number;
  readonly visibility: boolean;
  readonly params: GPUBuffer;
  readonly lights: GPUBuffer;
  readonly surfaces: GPUBuffer;
  readonly motion: GPUBuffer;
  readonly reservoirsA: GPUBuffer;
  readonly reservoirsB: GPUBuffer;
  readonly color: GPUBuffer;
  readonly colorHistory: GPUBuffer;
  readonly ies: GPUBuffer;
  /** 可见性档资源(legacy 恒 undefined;扩容路径整体替换,故可变)。 */
  rayStream?: GPUBuffer;
  overflows?: GPUBuffer;
  visParams?: GPUBuffer;
  visibilityMask?: GPUBuffer;
  sceneBuffers?: GPUBuffer[];
  /** 最近一次上传的场景引用(同引用跳过重传,同 shadow 家族 staging 语义)。 */
  stagedScene?: TlasPackedScene;
  /** legacy 单 bind group(可见性档 undefined;bind group 由各管线 auto 布局生成)。 */
  bindGroupLegacy?: GPUBindGroup;
  /** 可见性档按 auto 布局对象缓存的 bind group(缓冲身份稳定,分配期一次)。 */
  bindGroups?: Map<GPUBindGroupLayout, GPUBindGroup>;
}

const PIXEL_VEC4S = 16 / 4;
const SURFACE_VEC4S = MEGA_LIGHTS_SURFACES_STRIDE_VEC4;
/** 可见性档管线绑定布局(各入口静态使用最小声明;聚合 storage ≤ 默认上限 8):
 * build=7(shade=7,trace=8 —— trace 恰在默认上限,全集布局会爆,勿合并)。 */
const BUILD_VIS_BINDINGS = [MEGA_LIGHTS_PARAMS_BINDING, MEGA_LIGHTS_POOL_BINDING, MEGA_LIGHTS_SURFACES_BINDING,
  MEGA_LIGHTS_MOTION_BINDING, MEGA_LIGHTS_IES_BINDING, MEGA_LIGHTS_RESERVOIRS_A_BINDING,
  MEGA_LIGHTS_RESERVOIRS_B_BINDING, MEGA_LIGHTS_RAY_STREAM_BINDING, MEGA_LIGHTS_VIS_PARAMS_BINDING];
const SHADE_VIS_BINDINGS = [MEGA_LIGHTS_PARAMS_BINDING, MEGA_LIGHTS_POOL_BINDING, MEGA_LIGHTS_SURFACES_BINDING,
  MEGA_LIGHTS_IES_BINDING, MEGA_LIGHTS_RESERVOIRS_A_BINDING, MEGA_LIGHTS_RESERVOIRS_B_BINDING,
  MEGA_LIGHTS_COLOR_BINDING, MEGA_LIGHTS_COLOR_HISTORY_BINDING, MEGA_LIGHTS_VIS_MASK_BINDING];
const TRACE_VIS_BINDINGS = [MEGA_LIGHTS_PARAMS_BINDING, MEGA_LIGHTS_RAY_STREAM_BINDING,
  MEGA_LIGHTS_OVERFLOW_BINDING, MEGA_LIGHTS_NODES_BINDING, MEGA_LIGHTS_INSTANCES_BINDING,
  MEGA_LIGHTS_VERTICES_BINDING, MEGA_LIGHTS_INDICES_BINDING, MEGA_LIGHTS_ORDER_BINDING,
  MEGA_LIGHTS_VIS_PARAMS_BINDING, MEGA_LIGHTS_VIS_MASK_BINDING];

/**
 * MegaLights compute 运行时(资源按 2 的幂扩容;rollback-safe,沿 clusterCompute 纪律)。
 * encode 一帧 = 趟一 pass(读 prev/写 A [+ 射线流])→ [可见性 pass] → 趟二 pass
 * (读 A/写 B+color),pass 边界内存序为 WebGPU 规范强保证;固定角色双蓄水池
 * (A=本帧构建,B=本帧收束+下帧历史),无 ping-pong。
 */
export class MegaLightsRuntime {
  readonly layout: GPUBindGroupLayout;
  private readonly buildPipeline: GPUComputePipeline;
  private readonly shadePipeline: GPUComputePipeline;
  /** 可见性档(仅构造项 visibility 开启时非 undefined)。 */
  private readonly visibilityPipelines: {
    readonly buildLayout: GPUBindGroupLayout;
    readonly shadeLayout: GPUBindGroupLayout;
    readonly traceLayout: GPUBindGroupLayout;
    readonly buildPipeline: GPUComputePipeline;
    readonly shadePipeline: GPUComputePipeline;
    readonly tracePipeline: GPUComputePipeline;
  } | undefined;
  private resources: MegaLightsAllocation | undefined;
  private frameIndex = 0;
  private disposed = false;
  /** 表面上传跳过:同一 Float32Array 引用 + 同一分配 → 内容不变的 GBuffer 不重传
   * (1080p 表面 = 100MB/帧,逐帧重传是帧时主项;灯池每帧照传——动态灯是常态)。 */
  private uploadedSurfaces?: { readonly allocation: MegaLightsAllocation; readonly surfaces: Float32Array };

  /** 诊断面:shader 模块句柄(真机探针用 getCompilationInfo 抓 Tint 编译消息)。 */
  readonly shaderModule: GPUShaderModule;

  constructor(private readonly session: Pick<DeviceSession, "device" | "state" | "own" | "release">,
    options: MegaLightsRuntimeOptions = {}) {
    this.assertReady();
    const device = session.device;
    if (options.visibility?.f16 === true && !device.features.has("shader-f16")) {
      throw new Error("MegaLights visibility f16 variant requires the shader-f16 adapter feature.");
    }
    if (device.limits.maxStorageBuffersPerShaderStage < 8) {
      throw new Error("MegaLights requires eight storage buffers per shader stage.");
    }
    const visibility = options.visibility !== undefined;
    const module = device.createShaderModule({ label: "Deep MegaLights RIS compute",
      code: composeMegaLightsShader(options) });
    this.shaderModule = module;
    if (!visibility) {
      const entries: GPUBindGroupLayoutEntry[] = [{ binding: MEGA_LIGHTS_PARAMS_BINDING,
        visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }];
      for (const binding of [MEGA_LIGHTS_POOL_BINDING, MEGA_LIGHTS_SURFACES_BINDING, MEGA_LIGHTS_MOTION_BINDING,
        MEGA_LIGHTS_IES_BINDING]) {
        entries.push({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } });
      }
      for (const binding of [MEGA_LIGHTS_RESERVOIRS_A_BINDING, MEGA_LIGHTS_RESERVOIRS_B_BINDING,
        MEGA_LIGHTS_COLOR_BINDING, MEGA_LIGHTS_COLOR_HISTORY_BINDING]) {
        entries.push({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } });
      }
      this.layout = device.createBindGroupLayout({ label: "Deep MegaLights layout", entries });
      const pipelineLayout = device.createPipelineLayout({ label: "Deep MegaLights pipeline layout",
        bindGroupLayouts: [this.layout] });
      this.buildPipeline = device.createComputePipeline({ label: "Deep MegaLights build reservoirs",
        layout: pipelineLayout, compute: { module, entryPoint: MEGA_LIGHTS_ENTRY_BUILD } });
      this.shadePipeline = device.createComputePipeline({ label: "Deep MegaLights reuse and shade",
        layout: pipelineLayout, compute: { module, entryPoint: MEGA_LIGHTS_ENTRY_SHADE } });
      this.visibilityPipelines = undefined;
      return;
    }
    // 可见性档:三段管线各持"auto"布局(按入口静态使用自动裁决,聚合 storage
    // build=7/shade=7/trace=8,恰在默认上限内;全集布局会爆,勿合并)。
    const buildPipeline = device.createComputePipeline({ label: "Deep MegaLights build reservoirs (visibility)",
      layout: "auto", compute: { module, entryPoint: MEGA_LIGHTS_ENTRY_BUILD } });
    const shadePipeline = device.createComputePipeline({ label: "Deep MegaLights reuse and shade (visibility)",
      layout: "auto", compute: { module, entryPoint: MEGA_LIGHTS_ENTRY_SHADE } });
    const tracePipeline = device.createComputePipeline({ label: "Deep MegaLights trace winner visibility",
      layout: "auto", compute: { module, entryPoint: MEGA_LIGHTS_ENTRY_VISIBILITY } });
    this.visibilityPipelines = {
      buildLayout: buildPipeline.getBindGroupLayout(0),
      shadeLayout: shadePipeline.getBindGroupLayout(0),
      traceLayout: tracePipeline.getBindGroupLayout(0),
      buildPipeline, shadePipeline, tracePipeline,
    };
    this.buildPipeline = buildPipeline;
    this.shadePipeline = shadePipeline;
    this.layout = this.visibilityPipelines.buildLayout;
  }

  /** 上传输入并按需扩容;不编码(与 clusterCompute prepare/encode 两段同纪律)。 */
  prepare(input: MegaLightsPrepareInput): MegaLightsFrameResources {
    this.assertReady();
    const { width, height } = input;
    if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
      throw new Error("MegaLights viewport must be positive integers.");
    }
    const pixelCount = width * height;
    if (input.surfaces.length !== pixelCount * SURFACE_VEC4S * 4) {
      throw new Error(`MegaLights surfaces must hold ${pixelCount * SURFACE_VEC4S * 4} floats (3 vec4 per pixel).`);
    }
    if (input.motion !== undefined && input.motion.length !== pixelCount * PIXEL_VEC4S * 4) {
      throw new Error(`MegaLights motion must hold ${pixelCount * PIXEL_VEC4S * 4} floats (1 vec4 per pixel).`);
    }
    const lightCount = input.lights.count;
    if (lightCount > MAX_MEGA_LIGHTS) throw new Error(`MegaLights light count exceeds ${MAX_MEGA_LIGHTS}.`);
    if (input.visibility !== undefined && this.visibilityPipelines === undefined) {
      throw new Error("MegaLights visibility input requires a runtime constructed with the visibility option.");
    }
    if (input.visibility !== undefined
      && input.visibility.viewToWorld.length !== 16) {
      throw new Error("MegaLights visibility viewToWorld must hold 16 floats (column-major).");
    }
    const iesVec4s = Math.max(input.ies?.vec4Count ?? 1, 1);
    // 可见性资源随**构造档**分配(build 管线对 rayStream/visParams 是静态使用,逐帧
    // 开关位只落在 params.visibilityEnabled;关闭帧 build 不写射线、trace 不 dispatch)。
    const desired = { width, height, lightVec4s: Math.max(lightCount, 1) * 4, iesVec4s,
      visibility: this.visibilityPipelines !== undefined };
    const candidate = this.resources && this.sameCapacity(this.resources, desired) ? this.resources : this.allocate(desired);
    const replace = candidate !== this.resources;
    try {
      this.write(candidate, input);
    } catch (error) {
      if (replace) this.release(candidate);
      throw error;
    }
    if (replace) { const previous = this.resources; this.resources = candidate; if (previous) this.release(previous); }
    return { lightCount, width, height, visibilityEnabled: input.visibility !== undefined };
  }

  /** 编码一帧(可见性档三趟;legacy 两趟;pass 边界括夹,同 clusterLightCulling 真机定案)。 */
  encode(encoder: GPUCommandEncoder, resources: MegaLightsFrameResources): void {
    this.assertReady();
    const allocation = this.resources;
    if (!allocation || allocation.width !== resources.width || allocation.height !== resources.height) {
      throw new Error("MegaLights encode requires a matching prepare call.");
    }
    this.frameIndex += 1;
    const groupsX = Math.ceil(resources.width / MEGA_LIGHTS_WORKGROUP_SIZE);
    const groupsY = Math.ceil(resources.height / MEGA_LIGHTS_WORKGROUP_SIZE);
    if (this.visibilityPipelines !== undefined && allocation.visibility) {
      const pipelines = this.visibilityPipelines;
      const buildBinding = this.bindGroup(pipelines.buildLayout, allocation, BUILD_VIS_BINDINGS);
      const pass = encoder.beginComputePass({ label: "Deep MegaLights RIS direct lighting" });
      pass.setPipeline(pipelines.buildPipeline);
      pass.setBindGroup(MEGA_LIGHTS_BIND_GROUP, buildBinding);
      pass.dispatchWorkgroups(groupsX, groupsY);
      pass.end();
      if (resources.visibilityEnabled) {
        if (allocation.overflows === undefined) throw new Error("MegaLights visibility allocation is missing overflow sentinel.");
        this.session.device.queue.writeBuffer(allocation.overflows, 0, new Uint32Array([0]));
        const traceBinding = this.bindGroup(pipelines.traceLayout, allocation, TRACE_VIS_BINDINGS);
        const tracePass = encoder.beginComputePass({ label: "Deep MegaLights trace winner visibility" });
        tracePass.setPipeline(pipelines.tracePipeline);
        tracePass.setBindGroup(MEGA_LIGHTS_BIND_GROUP, traceBinding);
        tracePass.dispatchWorkgroups(Math.ceil((resources.width * resources.height) / RAY_TRACE_WORKGROUP_SIZE), 1);
        tracePass.end();
      }
      const shadeBinding = this.bindGroup(pipelines.shadeLayout, allocation, SHADE_VIS_BINDINGS);
      const shadePass = encoder.beginComputePass({ label: "Deep MegaLights reuse and shade" });
      shadePass.setPipeline(pipelines.shadePipeline);
      shadePass.setBindGroup(MEGA_LIGHTS_BIND_GROUP, shadeBinding);
      shadePass.dispatchWorkgroups(groupsX, groupsY);
      shadePass.end();
      return;
    }
    const pass = encoder.beginComputePass({ label: "Deep MegaLights RIS direct lighting" });
    pass.setPipeline(this.buildPipeline);
    pass.setBindGroup(MEGA_LIGHTS_BIND_GROUP, allocation.bindGroupLegacy!);
    pass.dispatchWorkgroups(groupsX, groupsY);
    pass.end();
    const shadePass = encoder.beginComputePass({ label: "Deep MegaLights reuse and shade" });
    shadePass.setPipeline(this.shadePipeline);
    shadePass.setBindGroup(MEGA_LIGHTS_BIND_GROUP, allocation.bindGroupLegacy!);
    shadePass.dispatchWorkgroups(groupsX, groupsY);
    shadePass.end();
  }

  /** 按入口 auto 布局装配 bind group(bindings 表驱动;分配期一次,按布局对象缓存)。 */
  private bindGroup(layout: GPUBindGroupLayout, allocation: MegaLightsAllocation,
    bindings: readonly number[]): GPUBindGroup {
    const cached = (allocation.bindGroups ??= new Map());
    const existing = cached.get(layout);
    if (existing) return existing;
    const resource = (binding: number): GPUBindGroupEntry["resource"] => {
      switch (binding) {
        case MEGA_LIGHTS_PARAMS_BINDING: return { buffer: allocation.params };
        case MEGA_LIGHTS_POOL_BINDING: return { buffer: allocation.lights };
        case MEGA_LIGHTS_SURFACES_BINDING: return { buffer: allocation.surfaces };
        case MEGA_LIGHTS_MOTION_BINDING: return { buffer: allocation.motion };
        case MEGA_LIGHTS_RESERVOIRS_A_BINDING: return { buffer: allocation.reservoirsA };
        case MEGA_LIGHTS_RESERVOIRS_B_BINDING: return { buffer: allocation.reservoirsB };
        case MEGA_LIGHTS_COLOR_BINDING: return { buffer: allocation.color };
        case MEGA_LIGHTS_COLOR_HISTORY_BINDING: return { buffer: allocation.colorHistory };
        case MEGA_LIGHTS_IES_BINDING: return { buffer: allocation.ies };
        case MEGA_LIGHTS_RAY_STREAM_BINDING: return { buffer: allocation.rayStream! };
        case MEGA_LIGHTS_OVERFLOW_BINDING: return { buffer: allocation.overflows! };
        case MEGA_LIGHTS_NODES_BINDING: return { buffer: allocation.sceneBuffers![0]! };
        case MEGA_LIGHTS_INSTANCES_BINDING: return { buffer: allocation.sceneBuffers![1]! };
        case MEGA_LIGHTS_VERTICES_BINDING: return { buffer: allocation.sceneBuffers![2]! };
        case MEGA_LIGHTS_INDICES_BINDING: return { buffer: allocation.sceneBuffers![3]! };
        case MEGA_LIGHTS_ORDER_BINDING: return { buffer: allocation.sceneBuffers![4]! };
        case MEGA_LIGHTS_VIS_PARAMS_BINDING: return { buffer: allocation.visParams! };
        case MEGA_LIGHTS_VIS_MASK_BINDING: return { buffer: allocation.visibilityMask! };
        default: throw new Error(`MegaLights visibility binding ${binding} has no resource.`);
      }
    };
    const group = this.session.device.createBindGroup({ label: "Deep MegaLights visibility bindings",
      layout, entries: bindings.map(binding => ({ binding, resource: resource(binding) })) });
    cached.set(layout, group);
    return group;
  }

  /** 颜色输出缓冲(探针 COPY_SRC 回读;生产 M2 由主 pass 消费)。 */
  get colorBuffer(): GPUBuffer {
    if (!this.resources) throw new Error("MegaLights runtime has no allocation until prepare.");
    return this.resources.color;
  }

  /** 表面 storage 缓冲(生产 M2 表面重建核直写目标;prepare 前无分配即抛)。 */
  get surfacesBuffer(): GPUBuffer {
    if (!this.resources) throw new Error("MegaLights runtime has no allocation until prepare.");
    return this.resources.surfaces;
  }

  /** 蓄水池 B(下一帧历史;诊断读回用)。 */
  get reservoirsBuffer(): GPUBuffer {
    if (!this.resources) throw new Error("MegaLights runtime has no allocation until prepare.");
    return this.resources.reservoirsB;
  }

  /** 可见性哨兵读回通道(验收/探针;生产帧循环不调,调用方自行 mapAsync)。 */
  readbackStackOverflows(encoder: GPUCommandEncoder, readback: GPUBuffer): void {
    const allocation = this.resources;
    if (allocation?.overflows === undefined) throw new Error("MegaLights visibility sentinel requires a visibility allocation.");
    encoder.copyBufferToBuffer(allocation.overflows, 0, readback, 0, 4);
  }

  /** 可见性档是否已装配(构造项 visibility 开启;帧控制器升级判定消费)。 */
  get visibilityLegReady(): boolean { return this.visibilityPipelines !== undefined; }

  get pixelCount(): number {
    if (!this.resources) throw new Error("MegaLights runtime has no allocation until prepare.");
    return this.resources.width * this.resources.height;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resources) { this.release(this.resources); this.resources = undefined; }
  }

  private sameCapacity(current: MegaLightsAllocation,
    desired: { width: number; height: number; lightVec4s: number; iesVec4s: number; visibility: boolean }): boolean {
    return current.width === desired.width && current.height === desired.height
      && current.lightVec4s >= desired.lightVec4s && current.iesVec4s >= desired.iesVec4s
      && current.visibility === desired.visibility;
  }

  private allocate(desired: { width: number; height: number; lightVec4s: number; iesVec4s: number;
    visibility: boolean }): MegaLightsAllocation {
    this.assertReady();
    const device = this.session.device;
    const pixelCount = desired.width * desired.height;
    const owned: GPUBuffer[] = [];
    const allocate = (size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer => {
      const buffer = this.session.own(device.createBuffer({ size, usage, label }));
      owned.push(buffer);
      return buffer;
    };
    try {
      const params = allocate(MEGA_LIGHTS_PARAMS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "Deep MegaLights params");
      // COPY_SRC:灯池诊断读回(pool drift 门);STORAGE 消费不受影响。
      const lights = allocate(desired.lightVec4s * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, "Deep MegaLights pool");
      const surfaces = allocate(pixelCount * SURFACE_VEC4S * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep MegaLights surfaces");
      const motion = allocate(pixelCount * PIXEL_VEC4S * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep MegaLights motion");
      const reservoirsA = allocate(pixelCount * PIXEL_VEC4S * 16, GPUBufferUsage.STORAGE, "Deep MegaLights reservoirs A");
      const reservoirsB = allocate(pixelCount * PIXEL_VEC4S * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, "Deep MegaLights reservoirs B");
      const color = allocate(pixelCount * PIXEL_VEC4S * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, "Deep MegaLights color");
      const colorHistory = allocate(pixelCount * PIXEL_VEC4S * 16, GPUBufferUsage.STORAGE, "Deep MegaLights color history");
      const ies = allocate(desired.iesVec4s * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep MegaLights IES shading");
      const allocation: MegaLightsAllocation = { ...desired, params, lights, surfaces, motion,
        reservoirsA, reservoirsB, color, colorHistory, ies };
      if (desired.visibility) {
        // 可见性档射线流:tMax=0 退化射线语义下全零初始化即"全可见",trace 侧零工作。
        // COPY_SRC:诊断读回(真机腿对拍 build 写出的射线;同灯池 COPY_SRC 先例)。
        const rayStream = allocate(pixelCount * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, "Deep MegaLights winner ray stream");
        device.queue.writeBuffer(rayStream, 0, new Uint8Array(pixelCount * 32));
        const overflows = allocate(4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, "Deep MegaLights visibility overflows");
        device.queue.writeBuffer(overflows, 0, new Uint32Array([0]));
        const visParams = allocate(MEGA_LIGHTS_VIS_PARAMS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "Deep MegaLights visibility params");
        // mask 全 1 初始化(可见):未 trace 的帧 shade 读 1 = M1 行为。
        // COPY_SRC:诊断读回(真机腿 mask 证据;同灯池/射线流先例)。
        const visibilityMask = allocate(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, "Deep MegaLights visibility mask");
        device.queue.writeBuffer(visibilityMask, 0, new Uint32Array(pixelCount).fill(1));
        allocation.rayStream = rayStream;
        allocation.overflows = overflows;
        allocation.visParams = visParams;
        allocation.visibilityMask = visibilityMask;
        allocation.sceneBuffers = [];
        allocation.bindGroups = new Map();
      } else {
        // legacy 单 bind group:构造期布局(this.layout)即全集,资源按 ABI 槽位装配。
        allocation.bindGroupLegacy = device.createBindGroup({ label: "Deep MegaLights bindings",
          layout: this.layout, entries: [
            { binding: MEGA_LIGHTS_PARAMS_BINDING, resource: { buffer: params } },
            { binding: MEGA_LIGHTS_POOL_BINDING, resource: { buffer: lights } },
            { binding: MEGA_LIGHTS_SURFACES_BINDING, resource: { buffer: surfaces } },
            { binding: MEGA_LIGHTS_MOTION_BINDING, resource: { buffer: motion } },
            { binding: MEGA_LIGHTS_RESERVOIRS_A_BINDING, resource: { buffer: reservoirsA } },
            { binding: MEGA_LIGHTS_RESERVOIRS_B_BINDING, resource: { buffer: reservoirsB } },
            { binding: MEGA_LIGHTS_COLOR_BINDING, resource: { buffer: color } },
            { binding: MEGA_LIGHTS_COLOR_HISTORY_BINDING, resource: { buffer: colorHistory } },
            { binding: MEGA_LIGHTS_IES_BINDING, resource: { buffer: ies } },
          ] });
      }
      return allocation;
    } catch (error) {
      failWithResourceCleanup(error, "MegaLights allocation rollback failed.", owned.map(buffer => () => this.session.release(buffer)));
      throw error;
    }
  }

  private write(allocation: MegaLightsAllocation, input: MegaLightsPrepareInput): void {
    const queue = this.session.device.queue;
    const surfacesUnchanged = this.uploadedSurfaces !== undefined
      && this.uploadedSurfaces.allocation === allocation && this.uploadedSurfaces.surfaces === input.surfaces;
    const frameSeed = input.frameSeed ?? this.frameIndex + 1;
    const words = new Float32Array(MEGA_LIGHTS_PARAMS_BYTES / 4);
    const flags = new Uint32Array(words.buffer);
    flags.set([allocation.width, allocation.height], 0);
    flags.set([input.lights.count, frameSeed >>> 0], 2);
    flags.set([input.spatialEnabled ? 1 : 0, input.temporalEnabled ? 1 : 0, input.exhaustive ? 1 : 0], 4);
    words.set([1.0], 7);
    words.set([input.alphaBlend ?? (1 / 32)], 8);
    // word 9 = visibilityEnabled(WGSL DeepMegaParams 自然 packing:visibilityEnabled
    // 紧跟 alphaBlend;vec2u reserved 随后。legacy 打包该字为 0 → 恒 1.0 因子)。
    flags.set([input.visibility !== undefined ? 1 : 0], 9);
    queue.writeBuffer(allocation.params, 0, words.buffer as ArrayBuffer);
    queue.writeBuffer(allocation.lights, 0, input.lights.data.buffer as ArrayBuffer, 0, input.lights.data.length * 4);
    if (!surfacesUnchanged) {
      queue.writeBuffer(allocation.surfaces, 0, input.surfaces.buffer as ArrayBuffer, 0, input.surfaces.length * 4);
      this.uploadedSurfaces = { allocation, surfaces: input.surfaces };
    }
    if (input.motion) {
      queue.writeBuffer(allocation.motion, 0, input.motion.buffer as ArrayBuffer, 0, input.motion.length * 4);
    }
    const ies = input.ies?.data ?? new Float32Array([-1, 0, 0, 0]);
    queue.writeBuffer(allocation.ies, 0, ies.buffer as ArrayBuffer, 0, ies.length * 4);
    const visibility = input.visibility;
    if (visibility !== undefined && allocation.visParams !== undefined && allocation.sceneBuffers !== undefined) {
      const visWords = new Float32Array(MEGA_LIGHTS_VIS_PARAMS_BYTES / 4);
      visWords.set(visibility.viewToWorld, 0);
      new Uint32Array(visWords.buffer).set([visibility.rayMask ?? 0xffffffff], 16);
      queue.writeBuffer(allocation.visParams, 0, visWords.buffer as ArrayBuffer);
      const staged = allocation.stagedScene;
      if (staged !== visibility.scene) {
        if (staged !== undefined
          && staged.blasNodeCount === visibility.scene.blasNodeCount
          && staged.triangleCount === visibility.scene.triangleCount) {
          // BLAS 段不变:增量 TLAS(实例/TLAS 节点段),同 shadow 家族 staging 合同。
          queue.writeBuffer(allocation.sceneBuffers[0]!, 0, visibility.scene.nodeBytes);
          queue.writeBuffer(allocation.sceneBuffers[1]!, 0, visibility.scene.recordBytes);
        } else {
          this.ensureSceneCapacity(allocation, visibility.scene);
          const [nodes, instances, vertices, indices, order] = allocation.sceneBuffers;
          queue.writeBuffer(nodes!, 0, visibility.scene.nodeBytes);
          queue.writeBuffer(instances!, 0, visibility.scene.recordBytes);
          queue.writeBuffer(vertices!, 0, visibility.scene.vertices.buffer,
            visibility.scene.vertices.byteOffset, visibility.scene.vertices.byteLength);
          queue.writeBuffer(indices!, 0, visibility.scene.indices.buffer,
            visibility.scene.indices.byteOffset, visibility.scene.indices.byteLength);
          queue.writeBuffer(order!, 0, visibility.scene.order.buffer,
            visibility.scene.order.byteOffset, visibility.scene.order.byteLength);
        }
        allocation.stagedScene = visibility.scene;
      }
    }
  }

  /** 场景五缓冲按需扩容(reallocate + bind group 失效;rollback 由上层 prepare 承担)。 */
  private ensureSceneCapacity(allocation: MegaLightsAllocation, scene: TlasPackedScene): void {
    const device = this.session.device;
    const owned: GPUBuffer[] = [];
    const make = (label: string, size: number): GPUBuffer => {
      const buffer = this.session.own(device.createBuffer({ label, size: Math.max(4, size),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      owned.push(buffer);
      return buffer;
    };
    const next = [make("Deep MegaLights visibility nodes", scene.nodeBytes.byteLength),
      make("Deep MegaLights visibility instances", scene.recordBytes.byteLength),
      make("Deep MegaLights visibility vertices", scene.vertices.byteLength),
      make("Deep MegaLights visibility indices", scene.indices.byteLength),
      make("Deep MegaLights visibility order", scene.order.byteLength)];
    for (const buffer of allocation.sceneBuffers ?? []) this.session.release(buffer);
    allocation.sceneBuffers = next;
    allocation.bindGroups?.clear();
  }

  private release(allocation: MegaLightsAllocation): void {
    const buffers = [allocation.params, allocation.lights, allocation.surfaces, allocation.motion,
      allocation.reservoirsA, allocation.reservoirsB, allocation.color, allocation.colorHistory,
      allocation.ies, allocation.rayStream, allocation.overflows, allocation.visParams,
      ...(allocation.sceneBuffers ?? [])];
    for (const buffer of buffers) { if (buffer) this.session.release(buffer); }
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("MegaLights runtime is disposed.");
    if (this.session.state !== "ready") throw new Error(`MegaLights runtime cannot use a ${this.session.state} GPU session.`);
  }
}

/** Pipeline key(遥测/缓存;ABI 或候选预算变化时递增)。 */
export const MEGA_LIGHTS_PIPELINE_KEY = `deep.megalights-ris.v${MEGA_LIGHTS_ABI_VERSION}.k${MEGALIGHTS_RIS_CANDIDATES}`;
