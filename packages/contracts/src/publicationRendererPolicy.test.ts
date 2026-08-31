import { describe, expect, it } from "vitest";
import { preferredPublicationRenderer, requiresWebGlPublicationEffects } from "./publicationRendererPolicy.js";

describe("publication renderer policy", () => {
  it("keeps WebGL for active post-processing but not for an empty enabled group", () => {
    const base = { enabled: true, smaa: false, fxaa: false, ssao: false, ssaoIntensity: 1, bloom: false, bloomStrength: 0.35, bloomThreshold: 0.9, outline: false, outlineStrength: 2.5 };
    expect(requiresWebGlPublicationEffects(base)).toBe(false);
    expect(requiresWebGlPublicationEffects({ ...base, bloom: true })).toBe(true);
  });

  it("selects the safe startup backend before a cloud page loads", () => {
    expect(preferredPublicationRenderer({ models: [], primitives: [] })).toBe("webgpu");
    expect(preferredPublicationRenderer({ models: [], primitives: [], postProcessing: {
      enabled: true, smaa: false, fxaa: true, ssao: false, ssaoIntensity: 1,
      bloom: false, bloomStrength: 0.35, bloomThreshold: 0.9, outline: false,
      outlineStrength: 2.5
    } })).toBe("webgl");
  });
});
