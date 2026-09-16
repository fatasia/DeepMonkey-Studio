import { describe, expect, it } from "vitest";
import { evaluateLocalSpotShadowSamples } from "./localSpotShadowProbe.js";

describe("local spot shadow readback evaluation", () => {
  it("requires one dark and one lit sample, a stable repeat, and an all-lit disabled path", () => {
    expect(evaluateLocalSpotShadowSamples(
      [0, 255, 0, 255, 0, 255, 0, 255],
      [0, 255, 0, 255, 0, 255, 0, 255],
      [255, 255, 255, 255, 255, 255, 255, 255],
    )).toEqual({
      occludedAndLit: true, disabledFullyLit: true, atlasStableAcrossRepeat: true,
    });
    expect(evaluateLocalSpotShadowSamples(
      [0, 255, 0, 255, 120, 255, 0, 255],
      [0, 255, 0, 255, 0, 255, 0, 255],
      [255, 255, 255, 255, 255, 255, 0, 255],
    )).toEqual({
      occludedAndLit: false, disabledFullyLit: false, atlasStableAcrossRepeat: false,
    });
  });
});
