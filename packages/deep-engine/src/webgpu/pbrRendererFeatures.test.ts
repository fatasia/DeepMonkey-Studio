import { describe, expect, it } from "vitest";
import { DEFAULT_PBR_RENDERER_FEATURES, resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";

describe("PBR renderer feature selection", () => {
  it("preserves the native high-quality defaults", () => {
    expect(resolvePbrRendererFeatures()).toEqual(DEFAULT_PBR_RENDERER_FEATURES);
  });
  it("creates an explicit comparison profile without mutating defaults", () => {
    expect(resolvePbrRendererFeatures({ environment: false, fog: false, groundGrid: false,
      ambientOcclusion: false, temporalAa: false, spatialAa: false, bloom: false, vignette: false,
      occlusionCulling: false, toneMapping: "three-aces-r185" })).toEqual({ environment: false, fog: false, groundPlane: true, groundGrid: false,
      ambientOcclusion: false, screenSpaceReflection: false, temporalAa: false, spatialAa: false, bloom: false, vignette: false,
      occlusionCulling: false, toneMapping: "three-aces-r185" });
    expect(DEFAULT_PBR_RENDERER_FEATURES.environment).toBe(true);
  });
  it("keeps screen-space reflection opt-in and honors explicit allocation", () => {
    expect(resolvePbrRendererFeatures().screenSpaceReflection).toBe(false);
    expect(resolvePbrRendererFeatures({ screenSpaceReflection: true }).screenSpaceReflection).toBe(true);
    expect(() => resolvePbrRendererFeatures({ screenSpaceReflection: 1 as never })).toThrow("must be boolean");
  });
  it("rejects malformed feature values", () => {
    expect(() => resolvePbrRendererFeatures(null as never)).toThrow("must be an object");
    expect(() => resolvePbrRendererFeatures({ bloom: 1 as never })).toThrow("must be boolean");
    expect(() => resolvePbrRendererFeatures({ groundPlane: 1 as never })).toThrow("must be boolean");
    for (const spatialAa of [null, 0, 1, "true", [], {}]) expect(() => resolvePbrRendererFeatures({ spatialAa: spatialAa as never })).toThrow("spatialAa must be boolean");
    expect(() => resolvePbrRendererFeatures({ occlusionCulling: "off" as never })).toThrow("must be boolean");
    expect(() => resolvePbrRendererFeatures({ toneMapping: "unknown" as never })).toThrow("Unknown");
  });
});
