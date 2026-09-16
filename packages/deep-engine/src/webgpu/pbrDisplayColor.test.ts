import { describe, expect, it } from "vitest";
import { DEFAULT_PBR_RENDERER_FEATURES } from "./pbrRendererFeatures.js";
import { pbrDirectDisplayClear } from "./pbrDirectDisplay.js";
import { encodePbrDisplayColor } from "./pbrDisplayColor.js";

const view = { eye: [0, 0, 5], target: [0, 0, 0], extent: 5,
  background: [0.018, 0.024, 0.034], floor: [0.1, 0.1, 0.1], exposure: 1, roughness: 1 } as const;
const directFeatures = { ...DEFAULT_PBR_RENDERER_FEATURES, ambientOcclusion: false, temporalAa: false, spatialAa: false,
  occlusionCulling: false, bloom: false, vignette: false } as const;

describe("PBR direct display output", () => {
  it("encodes finite background clears with both tone maps and grading", () => {
    for (const toneMapping of ["deep-aces", "three-aces-r185"] as const) {
      const color = encodePbrDisplayColor([0.018, 0.024, 0.034], {
        exposure: 1.25, toneMapping, colorGrading: "studio",
      });
      expect(color.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    }
  });

  it("uses one-pass output only when no effect or transparency needs HDR history", () => {
    expect(pbrDirectDisplayClear(view, directFeatures, false)).toEqual(
      encodePbrDisplayColor(view.background, { exposure: 1, toneMapping: "deep-aces" }));
    expect(pbrDirectDisplayClear(view, directFeatures, true)).toBeUndefined();
    for (const feature of ["ambientOcclusion", "temporalAa", "spatialAa", "occlusionCulling", "bloom", "vignette"] as const) {
      expect(pbrDirectDisplayClear(view, { ...directFeatures, [feature]: true }, false)).toBeUndefined();
    }
  });

  it("rejects invalid CPU display inputs before creating a render pass", () => {
    expect(() => encodePbrDisplayColor([0, Number.NaN, 0], { exposure: 1, toneMapping: "deep-aces" })).toThrow();
    expect(() => encodePbrDisplayColor([0, 0, 0], { exposure: 0, toneMapping: "deep-aces" })).toThrow();
  });
});
