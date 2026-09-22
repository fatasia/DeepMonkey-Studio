import { describe, expect, it } from "vitest";
import type { ScenePostProcessingState } from "@bim-studio/contracts";
import { readStudioDeepColorEffects, readStudioDeepPostProcess } from "./studioDeepColorEffects";

const state: ScenePostProcessingState = { enabled: true, smaa: false, ssao: false,
  ssaoIntensity: 1, bloom: false, bloomStrength: 0.35, bloomThreshold: 0.9 };

describe("Studio author color effects", () => {
  it("turns default AO and bloom off unless those author passes are active", () => {
    expect(readStudioDeepPostProcess(state, true)).toEqual({ ambientOcclusion: false, screenSpaceReflection: false, bloom: false });
    const enabled = { ...state, ssao: true, bloom: true };
    expect(readStudioDeepPostProcess(enabled, true)).toEqual({ ambientOcclusion: true, screenSpaceReflection: false, bloom: true,
      authorBloom: { strength: 0.35, threshold: 0.9 } });
    expect(readStudioDeepPostProcess({ ...enabled, enabled: false }, true)).toEqual({ ambientOcclusion: false, screenSpaceReflection: false, bloom: false });
    expect(readStudioDeepPostProcess(enabled, false)).toEqual({ ambientOcclusion: false, screenSpaceReflection: false, bloom: false });
    expect(readStudioDeepPostProcess({ ...state, gtao: true }, true)).toEqual({ ambientOcclusion: true, screenSpaceReflection: false, bloom: false });
  });
  it("compiles bounded author SSR quality into the Deep per-frame profile", () => {
    const result = readStudioDeepPostProcess({ ...state, screenSpaceReflection: true,
      ssrSteps: 64, ssrThickness: 0.02, ssrMaxDistance: 3 }, true);
    expect(result).toMatchObject({ screenSpaceReflection: true,
      screenSpaceReflectionProfile: { steps: 64, thicknessScale: 0.02, maxDistanceScale: 3 } });
    expect(Object.isFrozen(result.screenSpaceReflectionProfile)).toBe(true);
  });
  it("snapshots exact Bloom strength/threshold, including zero, without substituting legacy defaults", () => {
    const source = { ...state, bloom: true, bloomStrength: 0, bloomThreshold: 0 };
    const result = readStudioDeepPostProcess(source, true);
    expect(result.authorBloom).toEqual({ strength: 0, threshold: 0 });
    source.bloomStrength = 3; source.bloomThreshold = 1;
    expect(result.authorBloom).toEqual({ strength: 0, threshold: 0 });
    expect(readStudioDeepPostProcess(source, true).authorBloom).toEqual({ strength: 3, threshold: 1 });
    expect(Object.isFrozen(result.authorBloom)).toBe(true);
  });
  it("passes exact author values without remapping Deep HDR contrast or saturation", () => {
    const source = { ...state, vignette: true, vignetteDarkness: 2, colorGrading: true,
      hue: -170, saturation: -0.4, brightness: 0.3, contrast: 0.6 };
    expect(readStudioDeepColorEffects(source, true)).toEqual({ vignette: { darkness: 2 },
      colorGrading: { hue: -170, saturation: -0.4, brightness: 0.3, contrast: 0.6, temperature: 0, tint: 0 } });
  });
  it("uses the same missing-value defaults as the author runtime", () => {
    expect(readStudioDeepColorEffects({ ...state, vignette: true, colorGrading: true }, true))
      .toEqual({ vignette: { darkness: 1.2 }, colorGrading: { hue: 0, saturation: 0, brightness: 0, contrast: 0, temperature: 0, tint: 0 } });
  });
  it("disables preview effects when the author disables postprocessing or Composer is not active", () => {
    const enabled = { ...state, vignette: true, colorGrading: true };
    expect(readStudioDeepColorEffects({ ...enabled, enabled: false }, true)).toEqual({});
    expect(readStudioDeepColorEffects(enabled, false)).toEqual({});
    expect(readStudioDeepColorEffects(state, true)).toEqual({});
  });
  it("snapshots the settings without mutating or sharing nested objects", () => {
    const source = { ...state, vignette: true, vignetteDarkness: 0, colorGrading: true, hue: 0 };
    const result = readStudioDeepColorEffects(source, true);
    source.hue = 180; source.vignetteDarkness = 3;
    expect(result.colorGrading?.hue).toBe(0);
    expect(result.vignette?.darkness).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.colorGrading)).toBe(true);
    expect(Object.isFrozen(result.vignette)).toBe(true);
  });
});
