import { describe, expect, it, vi } from "vitest";
import { packPbrFog } from "./pbrFog.js";
import { encodePbrSrgbColor } from "./pbrDisplayColor.js";
import { updatePbrFrameUniforms, type PbrFrameUniformResources } from "./pbrFrameUniforms.js";
import { CameraFrameHistory } from "./cameraFrameHistory.js";
import { DEFAULT_PBR_RENDERER_FEATURES } from "./pbrRendererFeatures.js";
import { validatePbrRenderView } from "./pbrRenderViewValidation.js";
import { sceneShader, outputShader } from "./pbrShader.js";
import { AUTHOR_GRID_WGSL } from "./authorGridResources.js";
import { packPanoramaBackground } from "./pbrPanoramaBackground.js";
import { pbrDirectDisplayClear } from "./pbrDirectDisplay.js";
import { renderPreparedFrame } from "./pbrRendererFrames.js";

const view = { eye: [0, 0, 5], target: [0, 0, 0], background: [0.2, 0.3, 0.4],
  floor: [0, 0, 0], exposure: 1.75, extent: 5, roughness: 1, width: 64, height: 64, pixelRatio: 1 } as const;

describe("Three author direct display domain", () => {
  it("keeps the 32-byte fog ABI and old values while using only its reserved lane", () => {
    for (const fog of [null, undefined, { kind: "exp2", color: [0.2, 0.3, 0.4], density: 0.01 }] as const) {
      const legacy = packPbrFog(fog), direct = packPbrFog(fog, true);
      expect(direct.byteLength).toBe(32);
      expect(direct.slice(0, 7)).toEqual(legacy.slice(0, 7));
      expect(direct[7]).toBe(1); expect(legacy[7]).toBe(0);
    }
    expect(() => packPbrFog(null, 1 as never)).toThrow("boolean");
  });

  it("switches output pass-through per frame and restores the original Composer settings", () => {
    const target: PbrFrameUniformResources = { frameBuffer: {} as GPUBuffer, outputBuffer: {} as GPUBuffer,
      groundInstance: {} as GPUBuffer, frameData: new Float32Array(96), outputData: new Float32Array(8), groundData: new Float32Array(36) };
    const run = (authorDirectDisplay: boolean) => updatePbrFrameUniforms({ writeBuffer: vi.fn() } as unknown as GPUQueue,
      new CameraFrameHistory(), { ...view, authorDirectDisplay }, 64, 64, false, target, undefined,
      { ...DEFAULT_PBR_RENDERER_FEATURES, toneMapping: "three-aces-r185" });
    expect(run(true).history.currentJitter).toEqual([0, 0]);
    expect(target.outputData[3]).toBe(-1); expect(target.outputData[2]).toBe(0);
    expect(target.frameData[91]).toBe(-1);
    run(false); expect(target.outputData[3]).toBe(1); expect(target.outputData[2]).toBe(0.25);
  });

  it("encodes backgrounds without exposure or tone mapping", () => {
    const reference = (x: number) => x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
    const rgb = encodePbrSrgbColor([0.002, 0.25, 2]);
    expect(rgb).toEqual([reference(0.002), reference(0.25), reference(2)]);
    expect(() => encodePbrSrgbColor([NaN, 0, 0])).toThrow();
  });

  it("keeps objects, fog and premultiplied grid in one display domain with no second conversion", () => {
    const functionStart = sceneShader.indexOf("fn deepApplySceneFog(");
    const body = sceneShader.slice(functionStart, sceneShader.indexOf("fn deepApplyAuthorFogDisplay", functionStart));
    expect(body.indexOf("deepDisplayColor(color, output)")).toBeLessThan(body.indexOf("deepApplyAuthorFogDisplay(display"));
    expect(body).toContain("if (flag(materialFlags, 32u)) { return display; }");
    expect(AUTHOR_GRID_WGSL).toContain("mix(deepLinearToSrgb(sampled.rgb), deepLinearToSrgb(settings.fogColor.rgb), fog) * sampled.a");
    expect(outputShader).toContain("if (settings.toneMapping < -0.5) { return vec4f(color, 1.0); }");
  });

  it("preserves panorama rotation ABI and activates the display branch only for the authored route", () => {
    const standard = packPanoramaBackground(view, {}, 1), direct = packPanoramaBackground({ ...view, authorDirectDisplay: true }, {}, 1);
    expect(direct.byteLength).toBe(standard.byteLength);
    expect(direct[15]).toBe(1.75); expect(direct[19]).toBe(1); expect(direct[23]).toBe(1);
    expect(standard[15]).toBe(0); expect(standard[19]).toBe(0); expect(standard[23]).toBe(0);
  });

  it("rejects HDR effects in a display-domain frame instead of interpreting them in the wrong domain", () => {
    expect(() => validatePbrRenderView({ ...view, authorDirectDisplay: true, postProcess: { bloom: true } })).toThrow("HDR");
    expect(() => validatePbrRenderView({ ...view, authorDirectDisplay: true, authorColorEffects: {} })).not.toThrow();
    expect(() => validatePbrRenderView({ ...view, authorDirectDisplay: true }, DEFAULT_PBR_RENDERER_FEATURES)).toThrow("HDR");
    expect(() => validatePbrRenderView({ ...view, authorDirectDisplay: true,
      postProcess: { ambientOcclusion: false, bloom: false, screenSpaceReflection: false, volumetricFog: false } },
    DEFAULT_PBR_RENDERER_FEATURES)).not.toThrow();
    expect(() => validatePbrRenderView({ ...view, authorDirectDisplay: 1 as never })).toThrow("boolean");
  });

  it("keeps direct author frames out of the fused tone-map path and rejects HDR canvases before encode", () => {
    const features = { ...DEFAULT_PBR_RENDERER_FEATURES, ambientOcclusion: false,
      temporalAa: false, spatialAa: false, occlusionCulling: false, screenSpaceReflection: false,
      bloom: false, vignette: false };
    expect(pbrDirectDisplayClear(view, features, false)).toBeDefined();
    expect(pbrDirectDisplayClear({ ...view, authorDirectDisplay: true }, features, false)).toBeUndefined();
    const host = { now: () => 0, session: { state: "ready", hasErrors: false, hdrCanvasActive: true } };
    expect(() => renderPreparedFrame(host as never, { ...view, authorDirectDisplay: true })).toThrow("SDR canvas");
  });
});
