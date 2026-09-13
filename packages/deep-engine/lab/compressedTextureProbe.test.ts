import { describe, expect, it } from "vitest";
import { evaluateBc1RedPixel } from "./compressedTextureProbe.js";

describe("compressed texture GPU probe evaluation", () => {
  it("accepts opaque red within unorm conversion tolerance", () => {
    expect(evaluateBc1RedPixel([255, 0, 0, 255])).toBe(true);
    expect(evaluateBc1RedPixel([240, 8, 8, 250])).toBe(true);
  });
  it("rejects clear, wrong-channel, truncated, and non-finite samples", () => {
    expect(evaluateBc1RedPixel([0, 0, 255, 255])).toBe(false);
    expect(evaluateBc1RedPixel([255, 0, 0])).toBe(false);
    expect(evaluateBc1RedPixel([Number.NaN, 0, 0, 255])).toBe(false);
  });
});
