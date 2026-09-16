import { describe, expect, it } from "vitest";
import { authorBloomReference } from "./authorBloomReference.js";

describe("independent author Bloom half-float reference", () => {
  it("leaves a representable odd-sized HDR field unchanged at zero strength", () => {
    const pixels = new Float32Array(Array.from({ length: 15 }, () => [2, 0.5, 0.25, 1]).flat());
    expect(authorBloomReference({ width: 5, height: 3, pixels }, 0, 0).pixels).toEqual(pixels);
  });
  it("does not extract a saturated color merely because max RGB exceeds threshold", () => {
    const pixels = new Float32Array([1, 0, 0, 1]);
    expect(authorBloomReference({ width: 1, height: 1, pixels }, 3, 0.9).pixels).toEqual(pixels);
  });
  it("keeps all five 1px mips rather than truncating their weighted energy", () => {
    const pixels = new Float32Array([1, 1, 1, 1]);
    const result = authorBloomReference({ width: 1, height: 1, pixels }, 1, 0);
    expect(result.pixels[0]).toBeGreaterThan(9.5);
    expect(result.pixels[0]).toBeLessThan(10);
    expect([...result.pixels].every(Number.isFinite)).toBe(true);
  });
});
