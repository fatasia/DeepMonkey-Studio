import { describe, expect, it } from "vitest";
import { LOCAL_SPOT_SHADOW_ATLAS_QUALITY_PROFILES, estimateLocalSpotShadowAtlasDepthBytes,
  localSpotShadowAtlasOptionsForTier, resolveLocalSpotShadowAtlasTier } from "./localSpotShadowAtlasQuality.js";
import { SHARED_SHADOW_ATLAS_GUARD_TEXELS, planSharedShadowAtlas } from "./sharedShadowAtlas.js";

/** F7 图集多灯 opt-in 档的解析合同：默认零回归、fail-closed、16 灯规划镜像。 */
describe("local spot shadow atlas quality tiers", () => {
  it("keeps the published default options bit-identical under the standard tier", () => {
    // 默认零回归锚：与 F7 之前的 LOCAL_SPOT_SHADOW_ATLAS_OPTIONS 逐值一致。
    expect(localSpotShadowAtlasOptionsForTier("standard")).toEqual({
      requestedAtlasSize: 1024, tilesPerAxis: 2, maxShadowedLights: 4, maxShadowViews: 4,
    });
    const standard = LOCAL_SPOT_SHADOW_ATLAS_QUALITY_PROFILES.standard;
    expect(standard.effectiveTileTexels).toBe(1024 / 2 - SHARED_SHADOW_ATLAS_GUARD_TEXELS * 2);
    expect(standard.estimatedDepthTextureBytes).toBe(estimateLocalSpotShadowAtlasDepthBytes(1024));
    expect(resolveLocalSpotShadowAtlasTier("standard")).toMatchObject({
      requestedTier: "standard", selectedTier: "standard", downgraded: false });
  });

  it("exposes the F7 atlas-256 multi-light tier geometry at identical atlas bytes", () => {
    const options = localSpotShadowAtlasOptionsForTier("multi-light", { maxSpotShadowEntries: 16 });
    expect(options).toEqual({ requestedAtlasSize: 1024, tilesPerAxis: 4, maxShadowedLights: 16, maxShadowViews: 16 });
    const multi = LOCAL_SPOT_SHADOW_ATLAS_QUALITY_PROFILES["multi-light"];
    expect(multi.effectiveTileTexels).toBe(252);
    // 两档同一图集保留：分布选择而非更大的内存预算。
    expect(multi.estimatedDepthTextureBytes).toBe(4 * 1024 * 1024);
    expect(multi.estimatedDepthTextureBytes)
      .toBe(LOCAL_SPOT_SHADOW_ATLAS_QUALITY_PROFILES.standard.estimatedDepthTextureBytes);
  });

  it("fails closed on unknown tiers and invalid limits", () => {
    expect(() => resolveLocalSpotShadowAtlasTier("ultra" as never)).toThrow(/Unknown local spot shadow atlas tier/);
    expect(() => resolveLocalSpotShadowAtlasTier("standard", { maxSpotShadowEntries: 0 })).toThrow(/maximum spot shadow entries/);
    expect(() => resolveLocalSpotShadowAtlasTier("standard", { maxSpotShadowEntries: 1.5 })).toThrow(/maximum spot shadow entries/);
    expect(() => resolveLocalSpotShadowAtlasTier("standard", { maxTextureDimension2D: 0 })).toThrow(/maximum texture dimension/);
    expect(() => resolveLocalSpotShadowAtlasTier("standard", { maxDepthTextureBytes: -1 })).toThrow(/maximum depth bytes/);
    expect(() => resolveLocalSpotShadowAtlasTier("standard", { maxDepthTextureBytes: 1024 * 1024 }))
      .toThrow(/requires 4194304 depth bytes/);
    expect(() => localSpotShadowAtlasOptionsForTier("multi-light", { maxSpotShadowEntries: 15 }))
      .toThrow(/admits 16 shadowed lights/);
  });
  it("gates the multi-light tier on explicit spot uniform ABI limits instead of failing mid-frame", () => {
    // F7b：缺省 ABI（LOCAL_SPOT_SHADOW_MAX_LIGHTS = 16 条目/1536B）放行 multi-light。
    const admitted = resolveLocalSpotShadowAtlasTier("multi-light");
    expect(admitted.profile.options).toEqual({
      requestedAtlasSize: 1024, tilesPerAxis: 4, maxShadowedLights: 16, maxShadowViews: 16 });
    // fail-closed 回归：宿主显式收窄 ABI 时仍拒绝（静默接线会在 stageMetadata 越界）。
    expect(() => resolveLocalSpotShadowAtlasTier("multi-light", { maxSpotShadowEntries: 4 }))
      .toThrow(/multi-light tier admits 16 shadowed lights but the spot uniform ABI holds 4 entries/);
    const selection = resolveLocalSpotShadowAtlasTier("multi-light", { maxSpotShadowEntries: 16 });
    expect(selection.profile.options.maxShadowedLights).toBe(16);
    // standard 档灯容量字面钉死 4（2×2 tile 分布），不随 ABI 扩容抬高。
    expect(resolveLocalSpotShadowAtlasTier("standard").profile.options.maxShadowedLights).toBe(4);
  });

  it("mirrors the F7 legs through the product planner: 4/16 default versus 16/16 multi-light", () => {
    const requests = Array.from({ length: 16 }, (_, index) => ({
      key: `eval-spot-${index}`, kind: "spot" as const, importance: 16 - index }));
    const standard = planSharedShadowAtlas(requests, { maxTextureDimension2D: 1024,
      maxDepthTextureBytes: 4 * 1024 * 1024 }, localSpotShadowAtlasOptionsForTier("standard"));
    expect(standard.allocations).toHaveLength(4);
    expect(standard.rejected).toHaveLength(12);
    expect(standard.rejected.every(entry => entry.reason === "light-budget")).toBe(true);
    expect(standard.allocations[0]!.tiles[0]!.size).toBe(508);
    const multi = planSharedShadowAtlas(requests, { maxTextureDimension2D: 1024,
      maxDepthTextureBytes: 4 * 1024 * 1024 }, localSpotShadowAtlasOptionsForTier("multi-light", { maxSpotShadowEntries: 16 }));
    expect(multi.allocations).toHaveLength(16);
    expect(multi.rejected).toHaveLength(0);
    expect(multi.allocations.every(allocation => allocation.tiles[0]!.size === 252)).toBe(true);
    expect(multi.estimatedDepthTextureBytes).toBe(standard.estimatedDepthTextureBytes);
  });

  it("keeps profiles and resolved options frozen", () => {
    const selection = resolveLocalSpotShadowAtlasTier("standard");
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.profile)).toBe(true);
    expect(Object.isFrozen(selection.profile.options)).toBe(true);
    expect(Object.isFrozen(LOCAL_SPOT_SHADOW_ATLAS_QUALITY_PROFILES)).toBe(true);
    expect(() => { (selection.profile.options as { tilesPerAxis: number }).tilesPerAxis = 4; }).toThrow();
  });
});
