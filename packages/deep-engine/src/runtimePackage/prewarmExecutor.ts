import { RuntimeResourcePrewarmExecutor } from "./resourcePrewarmExecutor.js";
import type { PacketBoundsHlodOptions } from "../packetBoundsHlod.js";
import { buildValidatedRuntimePackagePrewarmPlan } from "./prewarmPlan.js";
import { DEEP_RUNTIME_PREWARM_LIMITS, type RuntimePackageBakeEvidence,
  type RuntimePackagePrewarmAdapter, type RuntimePackagePrewarmPlan,
  type RuntimePackagePrewarmRunOptions, type RuntimePackageResourcePrewarmItem } from "./prewarmTypes.js";

export class RuntimePackagePrewarmExecutor<TLoaded, TPrepared> extends RuntimeResourcePrewarmExecutor<
  TLoaded, TPrepared, RuntimePackageBakeEvidence, RuntimePackagePrewarmRunOptions> {
  constructor(adapter: RuntimePackagePrewarmAdapter<TLoaded, TPrepared>) {
    super(adapter, { buildPlan: buildValidatedRuntimePackagePrewarmPlan, matchesOptions });
  }
}

function matchesOptions(plan: RuntimePackagePrewarmPlan, options: RuntimePackagePrewarmRunOptions): boolean {
  const render = plan.items.find((item): item is RuntimePackageResourcePrewarmItem =>
    item.type === "resource" && item.resourceKind === "render-packet");
  return plan.budget.maxItems === (options.maxItems ?? DEEP_RUNTIME_PREWARM_LIMITS.items)
    && plan.budget.maxEstimatedBytes === (options.maxEstimatedBytes ?? DEEP_RUNTIME_PREWARM_LIMITS.estimatedBytes)
    && (!render?.bake || (render.bake.quality === (options.bakeQuality ?? "balanced")
      && render.bake.recipeVersion === (options.bakeRecipeVersion ?? "deep-bake-v1")
      && sameHlodOptions(render.bake.boundsHlod?.options, options.boundsHlod)));
}

function sameHlodOptions(actual: PacketBoundsHlodOptions | undefined,
requested: RuntimePackagePrewarmRunOptions["boundsHlod"]): boolean {
  if (requested === false) return actual === undefined;
  const expected = { spatialPartitions: 4, ...(requested ?? {}) };
  return JSON.stringify(actual) === JSON.stringify(expected);
}
