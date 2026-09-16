import { describe, expect, it } from "vitest";
import { applyPbrColorGradingLinear, NEUTRAL_PBR_COLOR_GRADING,
  resolvePbrColorGrading, STUDIO_PBR_COLOR_GRADING } from "./pbrColorGrading.js";

describe("PBR single-pass color grading", () => {
  it("keeps the default exactly neutral and publishes an explicit studio preset", () => {
    const color = [0.01, 1, 32] as const;
    expect(applyPbrColorGradingLinear(color, resolvePbrColorGrading(undefined))).toEqual(color);
    expect(resolvePbrColorGrading("neutral")).toBe(NEUTRAL_PBR_COLOR_GRADING);
    expect(resolvePbrColorGrading("studio")).toBe(STUDIO_PBR_COLOR_GRADING);
  });

  it("keeps all legal grading extremes finite and bounded", () => {
    for (const grading of [
      resolvePbrColorGrading({ temperature: -1, tint: -1, contrast: 0.5, saturation: 0 }),
      resolvePbrColorGrading({ temperature: 1, tint: 1, contrast: 2, saturation: 2 }),
    ]) {
      const output = applyPbrColorGradingLinear([1e30, 0, 1e-30], grading);
      expect(output.every(value => Number.isFinite(value) && value >= 0 && value <= 65_504)).toBe(true);
    }
  });

  it("rejects non-finite, out-of-range, and misspelled controls", () => {
    for (const options of [{ temperature: Infinity }, { tint: -1.01 }, { contrast: 0.49 },
      { saturation: 2.01 }, { saturationn: 1 }]) {
      expect(() => resolvePbrColorGrading(options as never)).toThrow(/PBR color grading/);
    }
  });
});
