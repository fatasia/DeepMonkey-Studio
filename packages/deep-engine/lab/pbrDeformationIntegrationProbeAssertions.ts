import type { FrameMetrics } from "../src/webgpu/pbrRenderer.js";

type EffectsMetrics = Pick<FrameMetrics, "weightedOit" | "hiZMipLevels" | "postProcessPasses">;

/** One pass per HiZ mip, four AO, one TAA, two OIT and one spatial AA pass. */
export function integrationEffectsPassesComplete(metrics: EffectsMetrics): boolean {
  return metrics.weightedOit === true && Number.isSafeInteger(metrics.hiZMipLevels) && metrics.hiZMipLevels > 0
    && metrics.postProcessPasses === metrics.hiZMipLevels + 4 + 1 + 2 + 1;
}

export const INTEGRATION_EFFECTS_UNVERIFIED = Object.freeze([
  "TAA final output is captured for visual inspection but has no numeric history/ghosting reference; numeric reads observe HDR before TAA, motion and shadow depth.",
  "Texture bindings execute, but constant normal/MR/AO/emissive textures and strong emission do not isolate each slot's pixel contribution or prove UV1 selection; no per-slot on/off reference is applied.",
  "Transparent pose is stationary and separate from opaque geometry; transparent motion, overlap/order invariance and alpha-cutoff shadow equivalence are not established.",
]);
