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
import type { PbrAutoExposureFrameMetrics, PbrAutoExposureOptions } from "./pbrAutoExposure.js";
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
  /**
   * G1-S1 簇级微多边形绘制槽位（opt-in，缺省 false = 零行为变化）：开启后可经
   * stageClusterLodScene 注入 bake DAG，默认帧 opaque pass 以 RenderBundle +
   * drawIndexedIndirect 执行 GPU 屏幕误差选层前沿（1px 感知阈值）。仅 plain HDR
   * 帧签名可执行；MRT/directDisplay 帧记录 sticky fallback 原因（不静默降级）。
   */
  readonly clusterLod?: boolean;
  /** Explicitly allocates GPU pose-stream pipelines; author support is negotiated separately. */
  readonly deformation?: boolean;
  readonly shadows?: CascadedShadowResourceOptions;
  /** C10 接触阴影资源配置;features.contactShadows 打开时生效,默认(不带)关闭。 */
  readonly contactShadows?: import("../shadows/contactShadowResources.js").ContactShadowResourceOptions;
  readonly features?: PbrRendererFeatureOptions;
  readonly environment?: PbrEnvironmentSource;
  /** Optional R12 capture transaction; omitted on normal production frames. */
  readonly frameCapture?: PbrFrameCaptureOptions;
  /** Off by default; uses bounded local telemetry and never disables scene content or interaction. */
  readonly adaptiveQuality?: AdaptiveQualityOptions;
  /** Omitted keeps probe GI off; present installs the DDGI/surface-cache runtime into the PBR loop. */
  readonly probeClipmap?: ProbeClipmapRuntimeOptions;
  /**
   * GI 探针方向数配置（G3-S1 门控）：`undefined` = 保持已发布默认 32（零配置画质口径）；
   * "standard"/16 与 "high"/32 显式选档；非法值经门 fail-closed 回 16。
   */
  readonly probeDirections?: import("../lighting/probeRadianceDirectionGate.js").DeepGiProbeDirectionPreset
    | import("../lighting/probeRadianceDirectionGate.js").DeepGiProbeDirectionCount;
  /** Optional GPU particle emitters; simulation runs one frame ahead and renders indirectly. */
  readonly particleEmitters?: readonly GpuParticleEmitter[];
  readonly particleRuntime?: GpuParticleEmitterRuntimeOptions;
  /**
   * F8 自动曝光(opt-in,缺省关闭 = 零行为变化):环境 mip 亮度静态代理(零 GPU
   * readback)→ ±EV 包络(默认 ±2)→ 时域平滑(时间常数参数化,帧间收敛上限
   * 防闪烁)。无可靠环境亮度(studio 程序环境 / 无源 / mip 解码失败)时 fail-closed
   * 回调用方 view.exposure 固定启发式,原因经 FrameMetrics.autoExposure 显式披露。
   * 默认切换(Z1 提案 P0)与桥接线(threeBridge renderer 字面量、rendererCapabilities
   * 快照白名单)留主线,模式同 t25-gpu-pass-timing。
   */
  readonly autoExposure?: PbrAutoExposureOptions;
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
  /**
   * F8 自动曝光遥测(`autoExposure` 开启时出现):active=本帧实际生效;降级帧给
   * fallbackReason(studio 程序环境/无源/解码失败),不伪零。未开启时整字段缺省。
   */
  readonly autoExposure?: PbrAutoExposureFrameMetrics;
  readonly meshletPasses?: number;
  readonly meshletDispatches?: number;
  readonly meshletFallbackReasons?: readonly string[];
  /**
   * G1-S1 簇级槽位遥测（`clusterLod` 开启且已 stage 时出现）：draws = 前沿 indirect
   * 命令数（GPU 真实绘制命令；bundle 本身在 drawCalls 计 1 次 executeBundles）。
   * stale = 选层在途（bundle 相对相机滞后 ≤1 帧）；warming = 尚无可用 bundle；
   * fallbackReason = fail-closed 原因（sticky，重 stage 恢复）。
   */
  readonly clusterLod?: import("./clusterLodRenderSlot.js").ClusterLodSlotMetrics;
  readonly frame: number; readonly cpuSubmitMs: number;
  readonly drawCalls: number; readonly triangles: number;
  readonly width: number; readonly height: number; readonly resources: number;
  /** Real RenderTargets allocation/reuse counters after this frame's queue submission. */
  readonly transientTextures?: PbrTransientTexturePoolStats;
  /** 同一 device 的已托管分配；已包含 transient，二者不能相加。 */
  readonly deviceResourceMemory?: DeviceResourceMemorySnapshot;
  readonly shadowUpdated: boolean; readonly cameraCut: boolean;
  /** C10 接触阴影遥测(opt-in 才存在)。 */
  readonly contactShadowTier?: "performance" | "balanced" | "quality";
  readonly contactShadowMaskBytes?: number;
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
