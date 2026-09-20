import { describe, expect, it } from "vitest";
import { pbrDirectDisplayClear } from "./pbrDirectDisplay.js";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";

describe("direct presentation pipeline eligibility", () => {
  const features = resolvePbrRendererFeatures({ ambientOcclusion: false, temporalAa: false, spatialAa: false,
    occlusionCulling: false, bloom: false, vignette: false });
  const view = { background: [0.1, 0.2, 0.3] as const, exposure: 1, eye: [1, 1, 1] as const,
    target: [0, 0, 0] as const, floor: [0.1, 0.1, 0.1] as const, extent: 10, roughness: 1 };
  it("keeps color-only static rendering eligible", () => {
    expect(pbrDirectDisplayClear(view, features, false, false)).toBeDefined();
  });
  it("keeps SSR on the HDR path even with all other effects disabled", () => {
    expect(pbrDirectDisplayClear(view, { ...features, screenSpaceReflection: true }, false)).toBeUndefined();
  });
  it("routes static packets through HDR when deformation capability requires MRT pipelines", () => {
    expect(pbrDirectDisplayClear(view, features, false, true)).toBeUndefined();
  });
});
