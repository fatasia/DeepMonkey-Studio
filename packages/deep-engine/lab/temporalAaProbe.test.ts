import { describe, expect, it } from "vitest";
import { decodeFloat16Bits, encodeFloat16Bits } from "./temporalAaProbe.js";

describe("temporal AA real GPU probe helpers", () => {
  it("round-trips finite HDR colors and signed motion through the actual half-float upload ABI", () => {
    for (const value of [-1, -0.375, 0, 0.125, 0.25, 0.925, 1, 16]) {
      const decoded = decodeFloat16Bits(encodeFloat16Bits(value));
      expect(Number.isFinite(decoded)).toBe(true); expect(decoded).toBeCloseTo(value, 3);
    }
  });
});
