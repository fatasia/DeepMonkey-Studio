import { describe, expect, it } from "vitest";
import { preferredPublicationRenderer, requiresWebGlPublicationEffects, sceneRequiresWebGlPublicationEffects } from "./publicationRendererPolicy.js";

describe("publication renderer policy", () => {
  it("keeps WebGL for active post-processing but not for an empty enabled group", () => {
    const base = { enabled: true, smaa: false, fxaa: false, ssao: false, ssaoIntensity: 1, bloom: false, bloomStrength: 0.35, bloomThreshold: 0.9, outline: false, outlineStrength: 2.5 };
    expect(requiresWebGlPublicationEffects(base)).toBe(false);
    expect(requiresWebGlPublicationEffects({ ...base, bloom: true })).toBe(true);
  });

  it("does not force WebGL for object-level outline (Deep renders instance outline natively)", () => {
    const effects = { outline: true, glow: false, xray: false, scanline: false, heatmap: false, dissolve: 0, edgeLight: false, color: "#fff", intensity: 1 };
    const scene = {
      models: [{ modelId: "pump", name: "Pump", visible: true, opacity: 1, effects,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
      primitives: [],
    };
    expect(sceneRequiresWebGlPublicationEffects(scene as never)).toBe(false);
    expect(preferredPublicationRenderer(scene as never)).toBe("webgpu");
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
