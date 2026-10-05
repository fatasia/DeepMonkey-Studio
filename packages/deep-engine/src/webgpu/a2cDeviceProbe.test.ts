import { describe, expect, it } from "vitest";
import { judgeAlphaToCoverageDevicePixel } from "./a2cDeviceProbe.js";

describe("a2c device probe judge (scene-independent analytic criterion)", () => {
  it("reads 50% blend as effective (mask generated)", () => {
    // 融合 r = 0.5·G+0.5·B = 0.5;4×MSAA 全抖动在 0.4-0.6 均判 effective。
    expect(judgeAlphaToCoverageDevicePixel(0.5)).toBe("effective");
    expect(judgeAlphaToCoverageDevicePixel(0.4)).toBe("effective");
    expect(judgeAlphaToCoverageDevicePixel(0.6)).toBe("effective");
  });
  it("reads full geometry color as ineffective (descriptor accepted, mask not generated)", () => {
    expect(judgeAlphaToCoverageDevicePixel(1.0)).toBe("ineffective");
    expect(judgeAlphaToCoverageDevicePixel(0.95)).toBe("ineffective");
  });
  it("keeps the mid band inconclusive (fail-open, falls through to the scene probe)", () => {
    expect(judgeAlphaToCoverageDevicePixel(0.8)).toBe("inconclusive");
    expect(judgeAlphaToCoverageDevicePixel(Number.NaN)).toBe("inconclusive");
  });
  it("keeps the probe constants pinned (geometry red over green clear, 64px, 8-bit single target)", () => {
    // 合同字面锁定:判据界与场景无关——任何人改界必须连测试一起改并给出依据。
    expect(judgeAlphaToCoverageDevicePixel(0.75)).toBe("effective");
    expect(judgeAlphaToCoverageDevicePixel(0.9)).toBe("ineffective");
  });
});
