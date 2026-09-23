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

export interface PbrRendererOptions {
  /** 显式的同设备托管资源估算上限；未知布局拒绝，非驱动物理 VRAM 上限。 */
  readonly deviceMemoryBudgetBytes?: number;
  /** 帧内目标的估算字节上限；不包含 history、阴影或流式几何。默认 512 MiB。 */
  readonly transientTextureBudgetBytes?: number;
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
}

export interface FrameMetrics {
  /** Optional bounded Frame Graph execution coverage for diagnostics; pass timing remains unavailable until queried per pass. */
  readonly frameGraphReceipt?: import("./pbrFramePlanExecutor.js").PbrFrameExecutionReceipt;
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
  readonly adaptiveHotspots?: readonly AdaptiveQualityHotspotSummary[];
}
