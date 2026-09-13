import type { WorldClusteredLights } from "../lighting/worldLights.js";
import type { LodFrameBudget } from "../spatial/lodTypes.js";
import type { CascadedShadowResourceOptions } from "./cascadedShadowResources.js";
import type { PbrFrameUniformView } from "./pbrFrameUniforms.js";
import type { PbrRendererFeatureOptions } from "./pbrRendererFeatures.js";
import type { PbrEnvironmentSource } from "./pbrEnvironmentSource.js";

export interface RenderView extends PbrFrameUniformView {
  readonly width: number; readonly height: number; readonly pixelRatio: number;
  readonly lights?: WorldClusteredLights; readonly lodBudget?: LodFrameBudget;
}

export interface PbrRendererOptions {
  readonly shadows?: CascadedShadowResourceOptions;
  readonly features?: PbrRendererFeatureOptions;
  readonly environment?: PbrEnvironmentSource;
}

export interface FrameMetrics {
  readonly frame: number; readonly cpuSubmitMs: number;
  readonly drawCalls: number; readonly triangles: number;
  readonly width: number; readonly height: number; readonly resources: number;
  readonly shadowUpdated: boolean; readonly cameraCut: boolean;
  readonly postProcessPasses: number; readonly weightedOit: boolean;
  readonly hiZMipLevels: number; readonly occlusionCulling: boolean;
  readonly frustumCulledBatches: number; readonly hiZOccludedBatches: number; readonly lodSelectionBatches: number; readonly lodIndirectDraws: number;
  readonly lightCount: number; readonly lightClusters: number; readonly shadowTier: string; readonly shadowDepthBytes: number;
}
