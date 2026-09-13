import { describe, expect, it } from "vitest";
import { DEFAULT_PBR_RENDERER_FEATURES, resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";

describe("PBR renderer feature selection", () => {
  it("preserves the native high-quality defaults", () => {
    expect(resolvePbrRendererFeatures()).toEqual(DEFAULT_PBR_RENDERER_FEATURES);
  });
  it("creates an explicit comparison profile without mutating defaults", () => {
    expect(resolvePbrRendererFeatures({ environment: false, fog: false, groundGrid: false,
      ambientOcclusion: false, temporalAa: false, bloom: false, vignette: false,
      toneMapping: "three-aces-r185" })).toEqual({ environment: false, fog: false, groundGrid: false,
      ambientOcclusion: false, temporalAa: false, bloom: false, vignette: false,
      toneMapping: "three-aces-r185" });
    expect(DEFAULT_PBR_RENDERER_FEATURES.environment).toBe(true);
  });
  it("rejects malformed feature values", () => {
    expect(() => resolvePbrRendererFeatures(null as never)).toThrow("must be an object");
    expect(() => resolvePbrRendererFeatures({ bloom: 1 as never })).toThrow("must be boolean");
    expect(() => resolvePbrRendererFeatures({ toneMapping: "unknown" as never })).toThrow("Unknown");
  });
});
