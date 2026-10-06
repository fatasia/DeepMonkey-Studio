import { describe, expect, it } from "vitest";
import { DEFAULT_PBR_RENDERER_FEATURES, resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";

describe("PBR renderer feature selection", () => {
  it("preserves the native high-quality defaults", () => {
    expect(resolvePbrRendererFeatures()).toEqual(DEFAULT_PBR_RENDERER_FEATURES);
    expect(DEFAULT_PBR_RENDERER_FEATURES.toneMapping).toBe("three-aces-r185");
  });
  it("keeps deep ACES available only by explicit selection", () => {
    expect(resolvePbrRendererFeatures({ toneMapping: "deep-aces" }).toneMapping).toBe("deep-aces");
  });
  it("creates an explicit comparison profile without mutating defaults", () => {
    expect(resolvePbrRendererFeatures({ environment: false, fog: false, groundGrid: false,
      ambientOcclusion: false, temporalAa: false, spatialAa: false, bloom: false, vignette: false,
      occlusionCulling: false, contactShadows: false, toneMapping: "three-aces-r185" })).toEqual({ environment: false, fog: false, groundPlane: true, groundGrid: false,
      ambientOcclusion: false, screenSpaceReflection: false, temporalAa: false, spatialAa: false, bloom: false, vignette: false,
      volumetricFog: false, visibilityBuffer: false, softRasterizeFallback: false, textureArrays: false, layeredMaterials: false,
      occlusionCulling: false, contactShadows: false, temporalUpscale: false, toneMapping: "three-aces-r185", debugForceFullRender: false, rayTracedShadows: false, sdfGi: false, megaLights: false, rayTracedReflections: false, ssgi: false, projectedTextures: false });
    expect(DEFAULT_PBR_RENDERER_FEATURES.environment).toBe(true);
  });
  it("keeps the soft-rasterize fallback opt-in and dependent on the visibility buffer", () => {
    expect(DEFAULT_PBR_RENDERER_FEATURES.softRasterizeFallback).toBe(false);
    expect(resolvePbrRendererFeatures().softRasterizeFallback).toBe(false);
    expect(resolvePbrRendererFeatures({}).softRasterizeFallback).toBe(false);
    expect(resolvePbrRendererFeatures({ softRasterizeFallback: true }).softRasterizeFallback).toBe(true);
    expect(() => resolvePbrRendererFeatures({ softRasterizeFallback: "on" as unknown as boolean })).toThrow(TypeError);
  });
  it("keeps screen-space reflection opt-in and honors explicit allocation", () => {
    expect(resolvePbrRendererFeatures().screenSpaceReflection).toBe(false);
    expect(resolvePbrRendererFeatures({ screenSpaceReflection: true }).screenSpaceReflection).toBe(true);
    expect(() => resolvePbrRendererFeatures({ screenSpaceReflection: 1 as never })).toThrow("must be boolean");
  });
  it("keeps F4 temporal upscale opt-in and inert without a resolution policy", () => {
    expect(resolvePbrRendererFeatures().temporalUpscale).toBe(false);
    expect(resolvePbrRendererFeatures({ temporalUpscale: true }).temporalUpscale).toBe(true);
    expect(() => resolvePbrRendererFeatures({ temporalUpscale: 1 as never })).toThrow("must be boolean");
  });
  it("keeps ray-traced shadows opt-in off by default and strictly boolean", () => {
    expect(resolvePbrRendererFeatures().rayTracedShadows).toBe(false);
    expect(resolvePbrRendererFeatures({ rayTracedShadows: true }).rayTracedShadows).toBe(true);
    expect(() => resolvePbrRendererFeatures({ rayTracedShadows: 1 as never })).toThrow("must be boolean");
  });
  it("keeps Brief-GI SDF GI opt-in off by default and strictly boolean", () => {
    expect(DEFAULT_PBR_RENDERER_FEATURES.sdfGi).toBe(false);
    expect(resolvePbrRendererFeatures().sdfGi).toBe(false);
    expect(resolvePbrRendererFeatures({ sdfGi: true }).sdfGi).toBe(true);
    expect(() => resolvePbrRendererFeatures({ sdfGi: 1 as never })).toThrow("must be boolean");
  });
  it("keeps P2 SSGI opt-in off by default and strictly boolean", () => {
    expect(DEFAULT_PBR_RENDERER_FEATURES.ssgi).toBe(false);
    expect(resolvePbrRendererFeatures().ssgi).toBe(false);
    expect(resolvePbrRendererFeatures({ ssgi: true }).ssgi).toBe(true);
    expect(() => resolvePbrRendererFeatures({ ssgi: 1 as never })).toThrow("must be boolean");
  });
  it("keeps P2 projected texture light opt-in off by default and strictly boolean", () => {
    expect(DEFAULT_PBR_RENDERER_FEATURES.projectedTextures).toBe(false);
    expect(resolvePbrRendererFeatures().projectedTextures).toBe(false);
    expect(resolvePbrRendererFeatures({ projectedTextures: true }).projectedTextures).toBe(true);
    expect(() => resolvePbrRendererFeatures({ projectedTextures: 1 as never })).toThrow("must be boolean");
  });
  it("keeps MegaLights RIS opt-in off by default and strictly boolean", () => {
    expect(DEFAULT_PBR_RENDERER_FEATURES.megaLights).toBe(false);
    expect(resolvePbrRendererFeatures().megaLights).toBe(false);
    expect(resolvePbrRendererFeatures({ megaLights: true }).megaLights).toBe(true);
    expect(() => resolvePbrRendererFeatures({ megaLights: 1 as never })).toThrow("must be boolean");
  });
  it("keeps the debug full-render comparison switch off by default and strictly boolean", () => {
    expect(resolvePbrRendererFeatures().debugForceFullRender).toBe(false);
    expect(resolvePbrRendererFeatures({ debugForceFullRender: true }).debugForceFullRender).toBe(true);
    expect(() => resolvePbrRendererFeatures({ debugForceFullRender: 1 as never })).toThrow("must be boolean");
  });
  it("keeps production volumetric fog opt-in", () => {
    expect(resolvePbrRendererFeatures().volumetricFog).toBe(false);
    expect(resolvePbrRendererFeatures({ volumetricFog: true })).toMatchObject({ volumetricFog: true, fog: false });
    expect(resolvePbrRendererFeatures({ volumetricFog: true, fog: true })).toMatchObject({ volumetricFog: true, fog: true });
    expect(() => resolvePbrRendererFeatures({ volumetricFog: 1 as never })).toThrow("must be boolean");
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
