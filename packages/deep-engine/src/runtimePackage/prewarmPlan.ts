import { bakeRenderPacketForResidency } from "../assetBakeResidency.js";
import { materializeRuntimeRenderPacket } from "./renderPacket.js";
import { RuntimePackageError } from "./primitives.js";
import { buildValidatedRuntimeResourcePrewarmPlan, validateRuntimeResourcePrewarmBudget } from "./resourcePrewarmPlan.js";
import { validateDeepRuntimePackage } from "./validation.js";
import type { DeepRuntimePackage } from "./types.js";
import type { RuntimePackagePrewarmPlan, RuntimePackagePrewarmPlanOptions } from "./prewarmTypes.js";

export function buildRuntimePackagePrewarmPlan(input: unknown,
  options: RuntimePackagePrewarmPlanOptions = {}): RuntimePackagePrewarmPlan {
  const validation = validateDeepRuntimePackage(input);
  if (!validation.valid) throw new RuntimePackageError(validation.issues[0]!.path, validation.issues[0]!.message);
  return buildValidatedRuntimePackagePrewarmPlan(validation.value, options);
}

export function buildValidatedRuntimePackagePrewarmPlan(packageValue: DeepRuntimePackage,
  options: RuntimePackagePrewarmPlanOptions = {}): RuntimePackagePrewarmPlan {
  if (packageValue.schemaVersion === 5) return buildValidatedRuntimeResourcePrewarmPlan(packageValue, options);
  validateRuntimeResourcePrewarmBudget(options);
  const renderId = packageValue.entrypoints.renderPacket;
  const baked = bakeRenderPacketForResidency(materializeRuntimeRenderPacket(packageValue.payloads[renderId],
    `$.payloads.${renderId}`), {
    ...(options.bakeQuality ? { quality: options.bakeQuality } : {}),
    ...(options.bakeRecipeVersion ? { recipeVersion: options.bakeRecipeVersion } : {}),
  });
  const bake = { schemaVersion: baked.bake.schemaVersion, quality: baked.bake.quality, recipeVersion: baked.bake.recipeVersion,
    sourceHash: baked.sourceHash, cacheKey: baked.cacheKey, geometryPlans: baked.bake.geometryPlans,
    materialVariantKeys: [...baked.bake.materialVariantKeys].sort(), textureIds: baked.bake.textureIds,
    residencyBatches: baked.batches,
  } as const;
  return buildValidatedRuntimeResourcePrewarmPlan(packageValue, options, { cacheKey: baked.cacheKey, evidence: bake });
}
