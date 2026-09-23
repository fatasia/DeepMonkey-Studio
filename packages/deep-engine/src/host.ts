/**
 * Deep Engine 统一宿主集成入口（F6 SDK 分层切片）。
 *
 * 面向宿主方（Deep Monkey Studio 与第三方集成者）的**稳定 facade**：把散落在
 * 子模块中的宿主消费能力按主题分组 re-export，并给出入口文档。约定：
 *
 * - 本入口只做分组导出与文档，**不承载实现**；实现仍在各自的源模块，
 *   主入口 `@bim-studio/deep-engine` 与 `./webgpu` 子入口继续可用，互不影响。
 * - 本入口的导出面按语义版本治理：只增不改删；若底层实现迁移，
 *   必须从这里保持同名可导入，或在重大版本中显式迁移。
 * - 渲染相关能力（PbrRenderer/GpuParticleRuntime/DeviceSession 等）依赖
 *   WebGPU 浏览器环境；能力探测组（`resolveRayTracingCapability` 等）用于
 *   在创建前判断目标环境是否支持，宿主应先探测后创建、按降级矩阵消费。
 *
 * 使用方式（包根子入口，开发态直连 src、发布态走 dist）：
 * ```ts
 * import {
 *   PbrRenderer, ProbeGridBakeService, GpuParticleRuntime,
 *   validateDeepRuntimePackage, validateDynamicSceneRuntime,
 *   resolveRayTracingCapability, validateHostCapabilities,
 * } from "@bim-studio/deep-engine/host";
 * ```
 */

/* ============================================================
 * 组 1：渲染后端创建与切换
 * PbrRenderer 为 WebGPU 渲染后端主体；DeviceSession 管理 GPU 设备
 * 生命周期；BackendSwitchCoordinator / BackendPreferenceController
 * 负责 WebGL↔WebGPU 后端切换编排与偏好持久化。
 * ============================================================ */
export { PbrRenderer } from "./webgpu/pbrRenderer.js";
export type { RenderView, FrameMetrics, PbrRendererOptions } from "./webgpu/pbrRenderer.js";
export { DEFAULT_PBR_RENDERER_FEATURES, resolvePbrRendererFeatures } from "./webgpu/pbrRendererFeatures.js";
export type { PbrRendererFeatureOptions, PbrRendererFeatures, PbrToneMapping } from "./webgpu/pbrRendererFeatures.js";
export { DeviceSession } from "./webgpu/deviceSession.js";
export type { DeviceEvent, DeviceState } from "./webgpu/deviceSession.js";
export { BackendSwitchCoordinator } from "./backendSwitch.js";
export type { BackendPreparation, BackendRevisionBarrier, BackendStateRevision,
  BackendSwitchResult, SwitchableBackend } from "./backendSwitch.js";
export { BackendPreferenceController } from "./backendPreference.js";
export type { BackendPreferenceResult, BackendPreferenceSnapshot,
  BackendPreferenceStore } from "./backendPreference.js";

/* ============================================================
 * 组 2：探针 GI / 粒子 / 烘焙服务
 * ProbeGridBakeService 为探针网格烘焙编排入口（GPU 捕获→读回→聚合）；
 * ProbeClipmapPbrController 把探针辐射接入 PBR 渲染；GpuParticleRuntime
 * 为 GPU 粒子运行时；类型与常量供宿主预分配缓冲与构造参数。
 * ============================================================ */
export { ProbeGridBakeService } from "./rayTracing/probeGridBakeService.js";
export type { ProbeGridBakeEvidence, ProbeGridBakeServiceOptions } from "./rayTracing/probeGridBakeService.js";
export type { ProbeGridBakeGrid } from "./rayTracing/probeGridBakeMath.js";
export type { ProbeRadianceLighting } from "./rayTracing/probeSceneRadianceProducer.js";
export { ProbeClipmapPbrController } from "./webgpu/probeClipmapPbrController.js";
export type { ProbeClipmapPbrControllerOptions, ProbeClipmapPbrTarget } from "./webgpu/probeClipmapPbrController.js";
export { DEFAULT_PROBE_CLIPMAP_RUNTIME_OPTIONS } from "./webgpu/probeClipmapRuntime.js";
export type { ProbeClipmapRuntimeDiagnostic, ProbeClipmapRuntimeFrameInput,
  ProbeClipmapRuntimeFrameResult, ProbeClipmapRuntimeOptions, ProbeClipmapRuntimeSnapshot,
  ProbeRelocationSnapshotEvidence } from "./webgpu/probeClipmapRuntime.js";
export { GpuParticleRuntime } from "./webgpu/gpuParticleRuntime.js";
export type { GpuParticleFrameResult, GpuParticleRenderBinding,
  GpuParticleRuntimeFrameInput, GpuParticleRuntimeOptions, GpuParticleSnapshot } from "./webgpu/gpuParticleRuntime.js";
export { GPU_PARTICLE_CAMERA_UNIFORM_BYTES, GPU_PARTICLE_DEFAULT_CAPACITY,
  GPU_PARTICLE_FLAG_LOOP, GPU_PARTICLE_FLAG_PULSE, GPU_PARTICLE_FRAME_UNIFORM_BYTES,
  GPU_PARTICLE_INDIRECT_BYTES, GPU_PARTICLE_MAX_CAPACITY, GPU_PARTICLE_STRIDE,
  GPU_PARTICLE_WORKGROUP_SIZE } from "./webgpu/gpuParticleTypes.js";
export type { GpuParticleCapacityEvidence, GpuParticleFrameInput, GpuParticleSeed,
  ParticleColor, ParticleVector3 } from "./webgpu/gpuParticleTypes.js";

/* ============================================================
 * 组 3：runtime-package 构建 / 校验 / 序列化 / 哈希
 * 宿主离线校验运行包的完整合同：结构校验（validateDeepRuntimePackage）、
 * 动态层校验（validateDynamicSceneRuntime）、序列化往返与规范哈希。
 * ============================================================ */
export { BUILTIN_RUNTIME_IBL_ID, validateDeepRuntimePackage } from "./runtimePackage/validation.js";
export { DYNAMIC_SCENE_RUNTIME_SCHEMA, DYNAMIC_SCENE_RUNTIME_VERSION,
  validateDynamicSceneRuntime } from "./runtimePackage/dynamicSceneRuntime.js";
export { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "./runtimePackage/serialization.js";
export { RUNTIME_CANONICAL_DOMAIN, runtimeContentSha256, runtimePackageSha256 } from "./runtimePackage/hash.js";
export { buildDeepRuntimePackage } from "./runtimePackage/builder.js";
export { RuntimePackageError } from "./runtimePackage/primitives.js";
export type { DeepRuntimePackage } from "./runtimePackage/types.js";

/* ============================================================
 * 组 4：能力探测与宿主合同
 * 创建后端前先探测：resolveRayTracingCapability / resolveRayTracingDecision
 * 给出光线追踪支持层级与降级路径；hostCapabilities 为宿主协议能力
 * 申报与会话权威协调的校验合同。
 * ============================================================ */
export { resolveRayTracingCapability } from "./rayTracingCapability.js";
export type { RayTracingBackend, RayTracingCapability } from "./rayTracingCapability.js";
export { resolveRayTracingDecision, validateRayTracingCapabilities } from "./rayTracingCapabilities.js";
export type { RayTracingCapabilities, RayTracingDecision, RayTracingFallback,
  RayTracingFeature, RayTracingTier } from "./rayTracingCapabilities.js";
export { HOST_CAPABILITIES_SCHEMA_VERSION, HOST_CAPABILITY_NAMES,
  HOST_PROTOCOL_BUDGETS, HOST_PROTOCOL_SCHEMA_VERSION } from "./hostCapabilities/types.js";
export type { HostCapabilitiesV1, HostCapabilityDeclaration, HostCapabilityName } from "./hostCapabilities/types.js";
export { validateHostCapabilities } from "./hostCapabilities/validation.js";
export { SessionAuthorityCoordinator, createSessionAuthorityCoordinator } from "./hostCapabilities/authority.js";

/* ============================================================
 * 组 5：渲染包准备合同
 * prepareRenderPacket 为宿主把资源包物化为可提交 GPU 的批次/纹理/
 * 材质描述的统一入口；prepareInstanceUpdate 用于实例级增量更新。
 * ============================================================ */
export { MAX_EMISSIVE_STRENGTH, prepareInstanceUpdate, prepareRenderPacket } from "./renderPacket.js";
export type { PbrMaterial, PreparedBatch, PreparedPacket, RenderInstance,
  RenderPacket } from "./renderPacket.js";
