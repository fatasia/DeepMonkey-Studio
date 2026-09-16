import { DEEP_SHADER_PACKAGE_BUDGETS } from "../shaderPackage/constants.js";
import { DEEP_RUNTIME_PACKAGE_BUDGETS, type DeepRuntimePackage, type RuntimeResourceKind } from "./types.js";

export const DEEP_RUNTIME_PREWARM_SCHEMA = "deep-engine.runtime-package-prewarm" as const;
export const DEEP_RUNTIME_PREWARM_SCHEMA_VERSION = 1 as const;
export const DEEP_RUNTIME_PREWARM_LIMITS = Object.freeze({
  items: DEEP_RUNTIME_PACKAGE_BUDGETS.resources
    + DEEP_RUNTIME_PACKAGE_BUDGETS.shaderPackages * DEEP_SHADER_PACKAGE_BUDGETS.maxPasses,
  estimatedBytes: DEEP_RUNTIME_PACKAGE_BUDGETS.inputBytes * 2,
  concurrency: 16,
});

export interface RuntimeResourcePrewarmResourceItem<TBake = never> {
  readonly order: number;
  readonly type: "resource";
  readonly cacheKey: string;
  readonly contentHash: string;
  readonly estimatedBytes: number;
  readonly resourceId: string;
  readonly resourceKind: RuntimeResourceKind;
  readonly revision: number;
  readonly bake?: TBake;
}

export interface RuntimeResourceShaderPipelinePrewarmItem {
  readonly order: number;
  readonly type: "shader-pipeline";
  readonly cacheKey: string;
  readonly contentHash: string;
  readonly estimatedBytes: number;
  readonly resourceId: string;
  readonly packageId: string;
  readonly passId: string;
  readonly techniqueId: string;
  readonly passKind: "forward" | "depth" | "shadow" | "picking";
  readonly moduleId: string;
  readonly entryPoints: Readonly<{ vertex: string; fragment: string | null }>;
  readonly pipeline: Readonly<{ passVariantId: string; attachmentProfileId: string;
    alphaMode: string; rasterMode: string }>;
}

export type RuntimeResourcePrewarmItem<TBake = never> = RuntimeResourcePrewarmResourceItem<TBake> | RuntimeResourceShaderPipelinePrewarmItem;

export interface RuntimeResourcePrewarmBudgetEvidence {
  readonly maxItems: number;
  readonly maxEstimatedBytes: number;
  /** Logical references retained in `items`, including aliases sharing one cache key. */
  readonly candidateItems: number;
  /** Unique load/prepare operations after cache-key deduplication. */
  readonly plannedItems: number;
  readonly deduplicatedItems: number;
  readonly resourceBytes: number;
  readonly shaderSourceBytes: number;
  readonly estimatedBytes: number;
  readonly withinLimits: true;
}

export interface RuntimeResourcePrewarmPlan<TBake = never> {
  readonly schema: typeof DEEP_RUNTIME_PREWARM_SCHEMA;
  readonly schemaVersion: typeof DEEP_RUNTIME_PREWARM_SCHEMA_VERSION;
  readonly packageId: string;
  readonly packageHash: string;
  readonly planHash: string;
  readonly items: readonly RuntimeResourcePrewarmItem<TBake>[];
  readonly budget: RuntimeResourcePrewarmBudgetEvidence;
}

export interface RuntimeResourcePrewarmPlanOptions {
  readonly maxItems?: number;
  readonly maxEstimatedBytes?: number;
}

export interface RuntimeResourcePrewarmCandidate<TLoaded, TPrepared, TBake = never> {
  readonly item: RuntimeResourcePrewarmItem<TBake>;
  readonly loaded: TLoaded;
  readonly prepared: TPrepared;
}

export interface RuntimeResourcePrewarmAdapter<TLoaded, TPrepared, TBake = never> {
  load(item: RuntimeResourcePrewarmItem<TBake>, packageValue: DeepRuntimePackage, signal: AbortSignal): Promise<TLoaded>;
  prepare(item: RuntimeResourcePrewarmItem<TBake>, loaded: TLoaded, signal: AbortSignal): Promise<TPrepared>;
  /** Publishes the complete ordered resource candidate synchronously.
   * The callback must not reenter publish/dispose: publish rejects; dispose throws without changing state.
   * A thrown commit must leave host publication unchanged.
   */
  commit(plan: RuntimeResourcePrewarmPlan<TBake>,
    candidates: readonly RuntimeResourcePrewarmCandidate<TLoaded, TPrepared, TBake>[]): void;
  release(item: RuntimeResourcePrewarmItem<TBake>, loaded: TLoaded, prepared: TPrepared | undefined): void;
}

export interface RuntimeResourcePrewarmRunOptions extends RuntimeResourcePrewarmPlanOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
}

export type RuntimeResourcePrewarmStatus = "committed" | "unchanged" | "superseded" | "aborted" | "failed";
export interface RuntimeResourcePrewarmResult<TBake = never> {
  readonly status: RuntimeResourcePrewarmStatus;
  readonly generation: number;
  readonly plan: RuntimeResourcePrewarmPlan<TBake>;
  readonly concurrency: number;
  readonly loadedItems: number;
  readonly preparedItems: number;
  readonly reusedItems: number;
  readonly committedItems: number;
  readonly releasedItems: number;
  readonly releaseFailures: readonly string[];
  readonly failure?: string;
}

/** Trusted host policy; resource validation and lifecycle remain owned by the executor. */
export interface RuntimeResourcePrewarmStrategy<TBake, TOptions extends RuntimeResourcePrewarmRunOptions> {
  buildPlan(value: DeepRuntimePackage, options: TOptions): RuntimeResourcePrewarmPlan<TBake>;
  matchesOptions(plan: RuntimeResourcePrewarmPlan<TBake>, options: TOptions): boolean;
}
