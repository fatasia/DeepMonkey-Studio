import type { WorldClusteredLights } from "../lighting/worldLights.js";
import type { LodFrameBudget } from "../spatial/lodTypes.js";
import type { CascadedShadowResourceOptions } from "./cascadedShadowResources.js";
import type { PbrFrameUniformView } from "./pbrFrameUniforms.js";
import type { PbrRendererFeatureOptions } from "./pbrRendererFeatures.js";
import type { PbrEnvironmentSource } from "./pbrEnvironmentSource.js";
import type { EditorOverlaySnapshot } from "./editorOverlayTypes.js";
import type { AuthorGridView } from "./authorGridTypes.js";
import type { PbrTransientTexturePoolStats } from "./pbrTransientTexturePool.js";

export interface RenderView extends PbrFrameUniformView {
  readonly authorGrid?: AuthorGridView | undefined;
  readonly editorOverlay?: EditorOverlaySnapshot;
  readonly width: number; readonly height: number; readonly pixelRatio: number;
  readonly lights?: WorldClusteredLights; readonly lodBudget?: LodFrameBudget;
}

export interface PbrRendererOptions {
  /** 帧内目标的估算字节上限；不包含 history、阴影或流式几何。默认 512 MiB。 */
  readonly transientTextureBudgetBytes?: number;
  readonly meshlets?: boolean;
  /** Explicitly allocates GPU pose-stream pipelines; author support is negotiated separately. */
  readonly deformation?: boolean;
  readonly shadows?: CascadedShadowResourceOptions;
  readonly features?: PbrRendererFeatureOptions;
  readonly environment?: PbrEnvironmentSource;
}

export interface FrameMetrics {
  readonly meshletPasses?: number;
  readonly meshletDispatches?: number;
  readonly meshletFallbackReasons?: readonly string[];
  readonly frame: number; readonly cpuSubmitMs: number;
  readonly drawCalls: number; readonly triangles: number;
  readonly width: number; readonly height: number; readonly resources: number;
  /** Real RenderTargets allocation/reuse counters after this frame's queue submission. */
  readonly transientTextures?: PbrTransientTexturePoolStats;
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
}
