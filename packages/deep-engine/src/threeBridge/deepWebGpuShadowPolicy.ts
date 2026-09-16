import { CASCADED_SHADOW_QUALITY_PROFILES, estimateCascadedShadowDepthBytes,
  type CascadedShadowQualityTier } from "../shadows/shadowQuality.js";
import type { FrameMetrics, PbrRendererOptions } from "../webgpu/pbrRenderer.js";

type Shadows = NonNullable<PbrRendererOptions["shadows"]>;
export interface DeepWebGpuShadowSelection {
  readonly selectedTier: CascadedShadowQualityTier | "exact";
  readonly estimatedDepthTextureBytes: number;
  readonly shadowMapSize?: number;
  readonly cascadeCount?: number;
}

function numberIn(value: number, min: number, max: number, name: string, integer = false): void {
  if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) {
    throw new RangeError(`Invalid exact shadow ${name}.`);
  }
}

export function snapshotShadows(shadows: Shadows): Shadows {
  if (!shadows || typeof shadows !== "object" || Array.isArray(shadows)) throw new TypeError("Deep WebGPU shadow options must be an object.");
  if (Object.keys(shadows).some(key => !["requestedTier", "maxDepthTextureBytes", "exactProfile"].includes(key))) {
    throw new TypeError("Unknown Deep WebGPU shadow option.");
  }
  if (shadows.requestedTier !== undefined && !Object.hasOwn(CASCADED_SHADOW_QUALITY_PROFILES, shadows.requestedTier)) {
    throw new RangeError(`Unknown cascaded shadow quality tier: ${String(shadows.requestedTier)}.`);
  }
  if (shadows.maxDepthTextureBytes !== undefined
    && (!Number.isSafeInteger(shadows.maxDepthTextureBytes) || shadows.maxDepthTextureBytes < 1)) {
    throw new RangeError("Invalid maximum shadow depth bytes.");
  }
  const exact = shadows.exactProfile;
  if (exact === undefined) return Object.freeze({ ...shadows });
  if (shadows.requestedTier !== undefined) throw new Error("Exact shadows cannot also request a quality tier.");
  if (!exact || typeof exact !== "object" || Array.isArray(exact)
    || Object.keys(exact).some(key => !["cascadeCount", "shadowMapSize", "splitLambda", "blendRatio", "depthBias", "receiverNormalBias"].includes(key))) {
    throw new TypeError("Invalid exact shadow profile.");
  }
  numberIn(exact.cascadeCount, 1, 8, "cascade count", true);
  numberIn(exact.shadowMapSize, 64, 16_384, "map size", true);
  numberIn(exact.splitLambda === undefined ? 0 : exact.splitLambda, 0, 1, "split lambda");
  numberIn(exact.blendRatio === undefined ? 0 : exact.blendRatio, 0, 0.5, "blend ratio");
  numberIn(exact.depthBias === undefined ? 0.00075 : exact.depthBias, 0, 0.1, "depth bias");
  if (exact.receiverNormalBias !== undefined && exact.receiverNormalBias !== "slope-scaled"
    && exact.receiverNormalBias !== "constant-one-texel") throw new Error("Invalid exact shadow receiver normal bias.");
  const bytes = estimateCascadedShadowDepthBytes(exact.cascadeCount, exact.shadowMapSize);
  if (shadows.maxDepthTextureBytes !== undefined && bytes > shadows.maxDepthTextureBytes) {
    throw new Error("Exact shadow profile exceeds its depth memory budget.");
  }
  return Object.freeze({ ...shadows, exactProfile: Object.freeze({ ...exact }) });
}

export function shadowSelection(frame: FrameMetrics, requested?: Shadows): DeepWebGpuShadowSelection {
  const exact = requested?.exactProfile;
  if (exact) {
    const expectedBytes = estimateCascadedShadowDepthBytes(exact.cascadeCount, exact.shadowMapSize);
    if (frame.shadowTier !== "exact" || frame.shadowMapSize !== exact.shadowMapSize
      || frame.shadowCascadeCount !== exact.cascadeCount || frame.shadowDepthBytes !== expectedBytes) {
      throw new Error("Deep runtime exact shadow allocation does not match the requested map size, layers and bytes.");
    }
    return Object.freeze({ selectedTier: "exact", estimatedDepthTextureBytes: expectedBytes,
      shadowMapSize: exact.shadowMapSize, cascadeCount: exact.cascadeCount });
  }
  if (!Object.hasOwn(CASCADED_SHADOW_QUALITY_PROFILES, frame.shadowTier)) {
    throw new Error(`Deep runtime reported an unknown shadow tier: ${String(frame.shadowTier)}.`);
  }
  const selectedTier = frame.shadowTier as CascadedShadowQualityTier;
  const expectedBytes = CASCADED_SHADOW_QUALITY_PROFILES[selectedTier].estimatedDepthTextureBytes;
  if (frame.shadowDepthBytes !== expectedBytes) {
    throw new Error(`Deep runtime reported ${frame.shadowDepthBytes} shadow bytes for ${selectedTier}; expected ${expectedBytes}.`);
  }
  return Object.freeze({ selectedTier, estimatedDepthTextureBytes: expectedBytes });
}
