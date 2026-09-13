import { describe, expect, it } from "vitest";
import { buildDrawProbePackage, decodeFloat16Bits, evaluateDrawPixel } from "./shaderPackageProbe.js";

describe("shader package draw probe", () => {
  it("builds a selected ABI v2 forward package with MSAA resolve", () => {
    const result = buildDrawProbePackage();
    expect(result.success).toBe(true);
    expect(result.value?.passes).toHaveLength(1);
    expect(result.value?.passes[0]).toMatchObject({
      id: "probe/forward",
      pipeline: {
        passVariantId: "forward-plain", attachmentProfileId: "forward-opaque",
        alphaMode: "OPAQUE", rasterMode: "double",
      },
    });
  });

  it("decodes rgba16float and rejects a clear pixel", () => {
    expect(decodeFloat16Bits(0x3000)).toBe(0.125);
    expect(decodeFloat16Bits(0x3800)).toBe(0.5);
    expect(decodeFloat16Bits(0x3b00)).toBe(0.875);
    expect(decodeFloat16Bits(0x3c00)).toBe(1);
    expect(evaluateDrawPixel([0x3000, 0x3800, 0x3b00, 0x3c00])).toMatchObject({
      verified: true, nonClear: true, maxAbsError: 0,
    });
    expect(evaluateDrawPixel([0x1a25, 0x1f2b, 0x21a2, 0x3c00])).toMatchObject({
      verified: false, nonClear: false,
    });
  });
});
