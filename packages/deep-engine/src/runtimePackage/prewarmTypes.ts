import type { DeepBakedResidencyBatch } from "../assetBakeResidency.js";
import type { PacketBoundsHlodEvidence, PacketBoundsHlodOptions } from "../packetBoundsHlod.js";
import type * as Core from "./resourcePrewarmTypes.js";
export { DEEP_RUNTIME_PREWARM_SCHEMA, DEEP_RUNTIME_PREWARM_SCHEMA_VERSION, DEEP_RUNTIME_PREWARM_LIMITS } from "./resourcePrewarmTypes.js";

export interface RuntimePackageBakeEvidence {
  readonly schemaVersion: 1;
  readonly quality: "performance" | "balanced" | "quality";
  readonly recipeVersion: string;
  readonly sourceHash: string;
  readonly cacheKey: string;
  readonly geometryPlans: readonly Readonly<{ id: string; sourceHash: string; meshletHash: string;
    vertexCount: number; triangleCount: number; meshletCount: number; expandedIndexCount: number }>[];
  readonly materialVariantKeys: readonly string[];
  readonly textureIds: readonly string[];
  /** Product HLOD policy compiled into this immutable bake. The author instance IDs remain unchanged. */
  readonly boundsHlod?: Readonly<{ readonly options: PacketBoundsHlodOptions;
    readonly evidence: PacketBoundsHlodEvidence }>;
  /** Offline LOD fallback and meshlet ranges consumed by the GPU LOD/indirect path. */
  readonly residencyBatches: readonly RuntimePackageBakeResidencyBatch[];
}

export type RuntimePackageBakeResidencyBatch = DeepBakedResidencyBatch;

export interface RuntimePackageBakeResidencyLevel {
  readonly geometry: string;
  readonly minProjectedDiameterPixels: number;
  readonly geometricError: number;
  readonly triangles: number;
  readonly resident: boolean;
  readonly meshletOffset: number;
  readonly meshletCount: number;
  readonly meshletHash: string;
}

export type RuntimePackageResourcePrewarmItem = Core.RuntimeResourcePrewarmResourceItem<RuntimePackageBakeEvidence>;
export type RuntimePackageShaderPipelinePrewarmItem = Core.RuntimeResourceShaderPipelinePrewarmItem;
export type RuntimePackagePrewarmItem = Core.RuntimeResourcePrewarmItem<RuntimePackageBakeEvidence>;
export type RuntimePackagePrewarmPlan = Core.RuntimeResourcePrewarmPlan<RuntimePackageBakeEvidence>;
export type RuntimePackagePrewarmResult = Core.RuntimeResourcePrewarmResult<RuntimePackageBakeEvidence>;
export type RuntimePackagePrewarmStatus = Core.RuntimeResourcePrewarmStatus;
export type RuntimePackagePrewarmBudgetEvidence = Core.RuntimeResourcePrewarmBudgetEvidence;
export type RuntimePackagePrewarmCandidate<TLoaded, TPrepared> = Core.RuntimeResourcePrewarmCandidate<TLoaded, TPrepared, RuntimePackageBakeEvidence>;
export type RuntimePackagePrewarmAdapter<TLoaded, TPrepared> = Core.RuntimeResourcePrewarmAdapter<TLoaded, TPrepared, RuntimePackageBakeEvidence>;
export interface RuntimePackagePrewarmPlanOptions extends Core.RuntimeResourcePrewarmPlanOptions {
  readonly bakeQuality?: "performance" | "balanced" | "quality";
  readonly bakeRecipeVersion?: string;
  /** Enabled by default for product packages; false preserves a fully authored packet. */
  readonly boundsHlod?: false | PacketBoundsHlodOptions;
}
export interface RuntimePackagePrewarmRunOptions extends RuntimePackagePrewarmPlanOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
}
