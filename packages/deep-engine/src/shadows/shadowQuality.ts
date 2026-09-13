import type { CascadedShadowOptions } from "./types.js";

export type CascadedShadowQualityTier = "performance" | "balanced" | "high" | "ultra";
export type CascadedShadowQualityConstraint = "texture-dimension" | "array-layers" | "memory-budget";

export interface CascadedShadowQualityLimits {
  readonly maxTextureDimension2D: number;
  readonly maxTextureArrayLayers: number;
  readonly maxDepthTextureBytes?: number;
}

export interface CascadedShadowQualityProfile {
  readonly tier: CascadedShadowQualityTier;
  readonly options: Readonly<Required<Pick<CascadedShadowOptions,
    "cascadeCount" | "shadowMapSize" | "splitLambda" | "blendRatio">>>;
  /** Minimum storage for the depth32float cascade array; views and driver alignment are excluded. */
  readonly estimatedDepthTextureBytes: number;
}

export interface CascadedShadowQualityRejection {
  readonly tier: CascadedShadowQualityTier;
  readonly constraints: readonly CascadedShadowQualityConstraint[];
}

export interface CascadedShadowQualitySelection {
  readonly requestedTier: CascadedShadowQualityTier;
  readonly selectedTier: CascadedShadowQualityTier;
  readonly downgraded: boolean;
  readonly profile: CascadedShadowQualityProfile;
  readonly rejected: readonly CascadedShadowQualityRejection[];
}

const TIERS = ["performance", "balanced", "high", "ultra"] as const satisfies readonly CascadedShadowQualityTier[];

function profile(tier: CascadedShadowQualityTier, cascadeCount: number, shadowMapSize: number,
  splitLambda: number, blendRatio: number): CascadedShadowQualityProfile {
  return Object.freeze({
    tier,
    // Shadow distance stays a scene-scale setting; a quality tier must not clip large authored worlds.
    options: Object.freeze({ cascadeCount, shadowMapSize, splitLambda, blendRatio }),
    estimatedDepthTextureBytes: estimateCascadedShadowDepthBytes(cascadeCount, shadowMapSize),
  });
}

export const CASCADED_SHADOW_QUALITY_PROFILES: Readonly<Record<CascadedShadowQualityTier, CascadedShadowQualityProfile>> =
  Object.freeze({
    performance: profile("performance", 2, 1024, 0.65, 0.12),
    balanced: profile("balanced", 3, 1536, 0.7, 0.1),
    // High is the compatibility default used by the original fixed 4x2048 PBR path.
    high: profile("high", 4, 2048, 0.7, 0.12),
    ultra: profile("ultra", 4, 4096, 0.8, 0.08),
  });

/** Resolves the requested tier to the highest equal-or-lower profile supported by the device budget. */
export function resolveCascadedShadowQuality(requestedTier: CascadedShadowQualityTier,
  limits: CascadedShadowQualityLimits): CascadedShadowQualitySelection {
  const requestedIndex = TIERS.indexOf(requestedTier);
  if (requestedIndex < 0) throw new RangeError(`Unknown cascaded shadow quality tier: ${String(requestedTier)}.`);
  const validated = validateLimits(limits);
  const rejected: CascadedShadowQualityRejection[] = [];
  for (let index = requestedIndex; index >= 0; index -= 1) {
    const candidate = CASCADED_SHADOW_QUALITY_PROFILES[TIERS[index]!];
    const constraints = unsupportedConstraints(candidate, validated);
    if (constraints.length === 0) {
      return Object.freeze({ requestedTier, selectedTier: candidate.tier, downgraded: candidate.tier !== requestedTier,
        profile: candidate, rejected: Object.freeze(rejected) });
    }
    rejected.push(Object.freeze({ tier: candidate.tier, constraints: Object.freeze(constraints) }));
  }
  const minimum = CASCADED_SHADOW_QUALITY_PROFILES.performance;
  throw new RangeError(`Cascaded shadows require at least ${minimum.options.shadowMapSize}px, `
    + `${minimum.options.cascadeCount} array layers, and ${minimum.estimatedDepthTextureBytes} depth bytes.`);
}

export function estimateCascadedShadowDepthBytes(cascadeCount: number, shadowMapSize: number): number {
  positiveInteger(cascadeCount, "cascade count");
  positiveInteger(shadowMapSize, "shadow map size");
  const bytes = cascadeCount * shadowMapSize * shadowMapSize * 4;
  if (!Number.isSafeInteger(bytes)) throw new RangeError("Cascaded shadow depth allocation exceeds the safe integer range.");
  return bytes;
}

function validateLimits(limits: CascadedShadowQualityLimits): Required<CascadedShadowQualityLimits> {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) throw new TypeError("Shadow quality limits must be an object.");
  const maxTextureDimension2D = positiveInteger(limits.maxTextureDimension2D, "maximum texture dimension");
  const maxTextureArrayLayers = positiveInteger(limits.maxTextureArrayLayers, "maximum texture array layers");
  const maxDepthTextureBytes = limits.maxDepthTextureBytes === undefined ? Number.MAX_SAFE_INTEGER
    : positiveInteger(limits.maxDepthTextureBytes, "maximum shadow depth bytes");
  return { maxTextureDimension2D, maxTextureArrayLayers, maxDepthTextureBytes };
}

function unsupportedConstraints(profileValue: CascadedShadowQualityProfile,
  limits: Required<CascadedShadowQualityLimits>): CascadedShadowQualityConstraint[] {
  const constraints: CascadedShadowQualityConstraint[] = [];
  if (profileValue.options.shadowMapSize > limits.maxTextureDimension2D) constraints.push("texture-dimension");
  if (profileValue.options.cascadeCount > limits.maxTextureArrayLayers) constraints.push("array-layers");
  if (profileValue.estimatedDepthTextureBytes > limits.maxDepthTextureBytes) constraints.push("memory-budget");
  return constraints;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${label}.`);
  return value;
}
