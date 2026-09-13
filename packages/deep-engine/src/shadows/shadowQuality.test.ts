import { describe, expect, it } from "vitest";
import { planCascadedShadows } from "./cascadedShadowPlanner.js";
import {
  CASCADED_SHADOW_QUALITY_PROFILES, estimateCascadedShadowDepthBytes, resolveCascadedShadowQuality,
} from "./shadowQuality.js";

const generous = { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256, maxDepthTextureBytes: 512 * 1024 * 1024 };
const camera = { eye: [0, 2, 8] as const, target: [0, 1, 0] as const, verticalFovRadians: Math.PI / 3,
  aspect: 16 / 9, near: 0.1, far: 1000 };

describe("cascaded shadow quality", () => {
  it("publishes frozen profiles with exact depth32float allocation estimates", () => {
    expect(CASCADED_SHADOW_QUALITY_PROFILES.performance.estimatedDepthTextureBytes).toBe(8 * 1024 * 1024);
    expect(CASCADED_SHADOW_QUALITY_PROFILES.balanced.estimatedDepthTextureBytes).toBe(27 * 1024 * 1024);
    expect(CASCADED_SHADOW_QUALITY_PROFILES.high.estimatedDepthTextureBytes).toBe(64 * 1024 * 1024);
    expect(CASCADED_SHADOW_QUALITY_PROFILES.ultra.estimatedDepthTextureBytes).toBe(256 * 1024 * 1024);
    expect(CASCADED_SHADOW_QUALITY_PROFILES.high.options).toMatchObject({ splitLambda: 0.7, blendRatio: 0.12 });
    expect(Object.isFrozen(CASCADED_SHADOW_QUALITY_PROFILES.high.options)).toBe(true);
    expect(estimateCascadedShadowDepthBytes(4, 2048)).toBe(67_108_864);
  });

  it("keeps a supported request and produces planner-ready options", () => {
    const selection = resolveCascadedShadowQuality("high", generous);
    expect(selection).toMatchObject({ requestedTier: "high", selectedTier: "high", downgraded: false, rejected: [] });
    const plan = planCascadedShadows(camera, [1, -2, 1], selection.profile.options);
    expect(plan.cascades).toHaveLength(4);
    expect(plan.shadowMapSize).toBe(2048);
    expect(plan.splitDepths.at(-1)).toBe(camera.far);
  });

  it("downgrades deterministically when the requested tier exceeds the memory budget", () => {
    const selection = resolveCascadedShadowQuality("high", { ...generous, maxDepthTextureBytes: 40 * 1024 * 1024 });
    expect(selection).toMatchObject({ requestedTier: "high", selectedTier: "balanced", downgraded: true });
    expect(selection.rejected).toEqual([{ tier: "high", constraints: ["memory-budget"] }]);
  });

  it("combines device dimension and array-layer constraints while searching lower tiers", () => {
    const selection = resolveCascadedShadowQuality("ultra", {
      maxTextureDimension2D: 1536, maxTextureArrayLayers: 2, maxDepthTextureBytes: 512 * 1024 * 1024,
    });
    expect(selection.selectedTier).toBe("performance");
    expect(selection.rejected).toEqual([
      { tier: "ultra", constraints: ["texture-dimension", "array-layers"] },
      { tier: "high", constraints: ["texture-dimension", "array-layers"] },
      { tier: "balanced", constraints: ["array-layers"] },
    ]);
  });

  it("never upgrades above the requested tier", () => {
    expect(resolveCascadedShadowQuality("balanced", generous).selectedTier).toBe("balanced");
    expect(resolveCascadedShadowQuality("performance", generous).selectedTier).toBe("performance");
  });

  it("fails closed when even the minimum tier cannot fit or inputs are invalid", () => {
    expect(() => resolveCascadedShadowQuality("performance", { ...generous, maxTextureArrayLayers: 1 }))
      .toThrow("require at least 1024px, 2 array layers");
    expect(() => resolveCascadedShadowQuality("high", { ...generous, maxDepthTextureBytes: 0 }))
      .toThrow("maximum shadow depth bytes");
    expect(() => resolveCascadedShadowQuality("cinematic" as "high", generous)).toThrow("Unknown");
    expect(() => estimateCascadedShadowDepthBytes(0, 1024)).toThrow("cascade count");
  });
});
