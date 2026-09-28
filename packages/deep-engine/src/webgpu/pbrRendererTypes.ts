import type { WorldClusteredLights } from "../lighting/worldLights.js";
import type { LodFrameBudget } from "../spatial/lodTypes.js";
import type { CascadedShadowResourceOptions } from "./cascadedShadowResources.js";
import type { PbrFrameUniformView } from "./pbrFrameUniforms.js";
import type { PbrRendererFeatureOptions } from "./pbrRendererFeatures.js";
import type { PbrEnvironmentSource } from "./pbrEnvironmentSource.js";
import type { EditorOverlaySnapshot } from "./editorOverlayTypes.js";
import type { AuthorGridView } from "./authorGridTypes.js";
import type { PbrTransientTexturePoolStats } from "./pbrTransientTexturePool.js";
import type { DeviceResourceMemorySnapshot } from "./deviceResourceMemory.js";
import type { PbrFrameCaptureOptions } from "./pbrFrameCapture.js";
import type { AdaptiveQualityHotspotSummary, AdaptiveQualityOptions, AdaptiveQualityState } from "./adaptiveQuality.js";
import type { ProbeClipmapRuntimeOptions } from "./probeClipmapRuntime.js";
import type { GpuParticleEmitter, GpuParticleEmitterRuntimeOptions } from "./gpuParticleEmitters.js";

export interface RenderView extends PbrFrameUniformView {
  readonly authorGrid?: AuthorGridView | undefined;
  readonly editorOverlay?: EditorOverlaySnapshot;
  readonly width: number; readonly height: number; readonly pixelRatio: number;
  readonly lights?: WorldClusteredLights; readonly lodBudget?: LodFrameBudget;
}

/** 首帧管线引导时序：不改变管线集合内容，只改变“发布前等待哪些变体”。
 * 每个开关独立可关，关闭即回到全量等待的旧时序。 */
export interface PbrPipelineBootstrapOptions {
  /** 首帧只等待关键 main 变体；其余 main 变体在 bootstrap 校验作用域关闭后排队。
   * 关键集合由后端从首帧包推导（firstFrameMainKeys），未推导时保持全量等待。 */
  readonly firstFrameSubset?: boolean;
  /** 后端推导出的首帧 main 管线键（由 threeBridge 填充；plain/ccw 恒含）。 */
  readonly firstFrameMainKeys?: readonly string[];
  /** 变形变体在 bootstrap 校验作用域关闭后才开始创建；含变形的包在 packet 边界
   * 等待其就绪，首个静态首帧不再为变形编译买单。 */
  readonly deferDeformation?: boolean;
}

export interface PbrRendererOptions {
  /** 显式的同设备托管资源估算上限；未知布局拒绝，非驱动物理 VRAM 上限。 */
  readonly deviceMemoryBudgetBytes?: number;
  /** 帧内目标的估算字节上限；不包含 history、阴影或流式几何。默认 512 MiB。 */
  readonly transientTextureBudgetBytes?: number;
  /** T07 动态内部分辨率策略；提供即启用帧时反馈的内部缩放（1 = 关闭等效上限）。 */
  readonly resolutionScalePolicy?: import("../postprocess/resolutionScaler.js").ResolutionScalePolicy;
  readonly meshlets?: boolean;
  /** Explicitly allocates GPU pose-stream pipelines; author support is negotiated separately. */
  readonly deformation?: boolean;
  readonly shadows?: CascadedShadowResourceOptions;
  readonly features?: PbrRendererFeatureOptions;
  readonly environment?: PbrEnvironmentSource;
  /** Optional R12 capture transaction; omitted on normal production frames. */
  readonly frameCapture?: PbrFrameCaptureOptions;
  /** Off by default; uses bounded local telemetry and never disables scene content or interaction. */
  readonly adaptiveQuality?: AdaptiveQualityOptions;
  /** Omitted keeps probe GI off; present installs the DDGI/surface-cache runtime into the PBR loop. */
  readonly probeClipmap?: ProbeClipmapRuntimeOptions;
  /** Optional GPU particle emitters; simulation runs one frame ahead and renders indirectly. */
  readonly particleEmitters?: readonly GpuParticleEmitter[];
  readonly particleRuntime?: GpuParticleEmitterRuntimeOptions;
  /** 首帧管线引导时序开关；缺省全部关闭 = 全量等待的旧时序。 */
  readonly pipelines?: PbrPipelineBootstrapOptions;
  /**
   * F1 逐 pass GPU 计时(opt-in 诊断):开启即启用诊断采样,并在每个 executed
   * mapped pass 上用 timestamp marker 括夹测量。设备不支持 timestamp-query、槽池
   * 耗尽或读回未完成时优雅降级(FrameMetrics.gpuPassTimings 显式 unavailable,
   * 帧级三段计时照旧),不报错、不伪零。
   */
  readonly gpuPassTiming?: boolean;
}

export interface FrameMetrics {
  /** Optional bounded Frame Graph execution coverage for diagnostics; per-pass GPU timings ride on gpuPassTimings. */
  readonly frameGraphReceipt?: import("./pbrFramePlanExecutor.js").PbrFrameExecutionReceipt;
  /**
   * F1 逐 pass GPU 计时(opt-in,`gpuPassTiming`):最新完成读回的一帧逐 pass
   * 毫秒数据。GPU 读回滞后 1-2 帧,实测帧号在 `frame` 字段内,不得当成本帧;
   * `gpuPassTiming` 未开启时整字段缺省(面板显示「未开启」)。
   */
  readonly gpuPassTimings?: import("./pbrFrameReceipt.js").PbrFramePassTimings;
  readonly meshletPasses?: number;
  readonly meshletDispatches?: number;
  readonly meshletFallbackReasons?: readonly string[];
  readonly frame: number; readonly cpuSubmitMs: number;
  readonly drawCalls: number; readonly triangles: number;
  readonly width: number; readonly height: number; readonly resources: number;
  /** Real RenderTargets allocation/reuse counters after this frame's queue submission. */
  readonly transientTextures?: PbrTransientTexturePoolStats;
  /** 同一 device 的已托管分配；已包含 transient，二者不能相加。 */
  readonly deviceResourceMemory?: DeviceResourceMemorySnapshot;
  readonly shadowUpdated: boolean; readonly cameraCut: boolean;
  readonly postProcessPasses: number; readonly weightedOit: boolean;
  readonly hiZMipLevels: number; readonly occlusionCulling: boolean;
  readonly frustumCulledBatches: number; readonly hiZOccludedBatches: number; readonly lodSelectionBatches: number; readonly lodIndirectDraws: number;
  readonly lightCount: number; readonly lightClusters: number; readonly shadowTier: string; readonly shadowDepthBytes: number;
  /** Required evidence for exact-profile consumers; optional for older preset runtimes. */
  readonly shadowMapSize?: number;
  readonly shadowCascadeCount?: number;
  /** Actual author LOD compute work for main, refreshed directional cascades, and local spots. */
  readonly authorFrustumPasses?: number;
  readonly authorFrustumDispatches?: number;
  readonly adaptiveQuality?: AdaptiveQualityState;
  readonly resolutionScale?: (import("../postprocess/resolutionScaler.js").InternalResolutionReport & { revision: number }) | undefined;
  readonly adaptiveHotspots?: readonly AdaptiveQualityHotspotSummary[];
}
