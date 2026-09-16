import { describe, expect, it } from "vitest";
import { planSharedShadowAtlas, SHARED_SHADOW_ATLAS_PCF_SAMPLES } from "./sharedShadowAtlas.js";

const desktopLimits = { maxTextureDimension2D: 8192 };

describe("shared local-light shadow atlas", () => {
  it("uses a fixed automatic desktop budget and maps point faces deterministically", () => {
    const plan = planSharedShadowAtlas([
      { key: "fill", kind: "spot", importance: 2 },
      { key: "hero", kind: "point", importance: 5 },
    ], desktopLimits);

    expect(plan).toMatchObject({ atlasSize: 4096, tileSize: 512, guardTexels: 2,
      estimatedDepthTextureBytes: 64 * 1024 * 1024,
      pcfSampleCount: SHARED_SHADOW_ATLAS_PCF_SAMPLES, maxShadowedLights: 16, maxShadowViews: 32,
      allocatedViewCount: 7, downgraded: false });
    expect(plan.allocations.map(value => value.key)).toEqual(["hero", "fill"]);
    expect(plan.allocations[0]?.tiles.map(tile => tile.face)).toEqual(["+x", "-x", "+y", "-y", "+z", "-z"]);
    expect(plan.allocations[0]?.tiles[0]).toMatchObject({ slot: 0, x: 2, y: 2, size: 508,
      uvOffset: [2 / 4096, 2 / 4096], uvScale: [508 / 4096, 508 / 4096] });
    expect(plan.allocations[1]?.tiles[0]).toMatchObject({ slot: 6, x: 3074, y: 2 });
    expect(Object.isFrozen(plan.allocations[0]?.tiles)).toBe(true);
  });

  it("keeps the most important lights within joint light and view budgets", () => {
    const plan = planSharedShadowAtlas([
      { key: "low", kind: "spot", importance: 1 },
      { key: "point", kind: "point", importance: 10 },
      { key: "mid", kind: "spot", importance: 5 },
      { key: "tail", kind: "spot", importance: 0.5 },
    ], desktopLimits, { maxShadowedLights: 2, maxShadowViews: 7 });

    expect(plan.allocations.map(value => value.key)).toEqual(["point", "mid"]);
    expect(plan.rejected).toEqual([
      { key: "low", kind: "spot", requiredViews: 1, reason: "light-budget" },
      { key: "tail", kind: "spot", requiredViews: 1, reason: "light-budget" },
    ]);
  });

  it("skips an unaffordable cube and still fills later spot slots", () => {
    const plan = planSharedShadowAtlas([
      { key: "cube", kind: "point", importance: 10 },
      { key: "spot-a", kind: "spot", importance: 2 },
      { key: "spot-b", kind: "spot", importance: 1 },
    ], desktopLimits, { maxShadowViews: 2 });

    expect(plan.allocations.map(value => value.key)).toEqual(["spot-a", "spot-b"]);
    expect(plan.rejected).toContainEqual({ key: "cube", kind: "point", requiredViews: 6, reason: "view-budget" });
  });

  it("downgrades atlas dimensions to device and memory limits", () => {
    const constrained = planSharedShadowAtlas([{ key: "spot", kind: "spot", importance: 1 }], {
      maxTextureDimension2D: 3072,
      maxDepthTextureBytes: 8 * 1024 * 1024,
    }, { maxShadowViews: 128 });

    expect(constrained).toMatchObject({ atlasSize: 1024, tileSize: 128, estimatedDepthTextureBytes: 4 * 1024 * 1024,
      maxShadowViews: 64, downgraded: true });
  });

  it("rejects disabled requests and malformed or impossible input", () => {
    const disabled = planSharedShadowAtlas([{ key: "off", kind: "spot", importance: 0 }], desktopLimits);
    expect(disabled.rejected).toEqual([{ key: "off", kind: "spot", requiredViews: 1, reason: "zero-importance" }]);
    expect(() => planSharedShadowAtlas([
      { key: "same", kind: "spot", importance: 1 }, { key: "same", kind: "point", importance: 2 },
    ], desktopLimits)).toThrow("Duplicate shadow request key");
    expect(() => planSharedShadowAtlas([{ key: "bad", kind: "spot", importance: Number.NaN }], desktopLimits))
      .toThrow("Invalid shadow importance");
    expect(() => planSharedShadowAtlas([], { maxTextureDimension2D: 256 })).toThrow("requires at least");
    expect(() => planSharedShadowAtlas([], desktopLimits, { tilesPerAxis: 3 })).toThrow("power of two");
    expect(planSharedShadowAtlas([{ key: "disabled", kind: "spot", importance: 1 }], desktopLimits,
      { maxShadowedLights: 0, maxShadowViews: 0 }).allocations).toHaveLength(0);
  });
});
