import { describe, expect, it } from "vitest";
import { f16BitsToFloat, floatToF16Bits } from "./halfFloat.js";

/**
 * f16 转换合同（compute BVH 骨架 f16 节点压缩基座）：
 * nearest=最近偶数（roundtrip 逐位稳定）；outwardLow/High=**带符号值方向**的包容格
 * （存储盒 ⊇ 原盒 ⇒ GPU 剪枝只松不紧，命中与 f32 布局逐位一致——probe 对拍钉死）。
 */

describe("half float conversion", () => {
  it("round-trips exact f16 values bit-for-bit", () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [0, 0x0000], [-0, 0x8000], [1, 0x3c00], [-1, 0xbc00], [0.5, 0x3800], [2, 0x4000],
      [65504, 0x7bff], [-65504, 0xfbff], [6.103515625e-5, 0x0400], [2 ** -24, 0x0001],
      [0.333251953125, 0x3555], [NaN, 0x7e00], [Infinity, 0x7c00], [-Infinity, 0xfc00],
    ];
    for (const [value, bits] of cases) {
      expect(floatToF16Bits(value)).toBe(bits);
      if (!Number.isNaN(value)) expect(f16BitsToFloat(bits)).toBe(value);
    }
    expect(Number.isNaN(f16BitsToFloat(0x7e00))).toBe(true);
  });

  it("rounds to nearest even at grid ties and overflow boundaries", () => {
    expect(floatToF16Bits(2049)).toBe(floatToF16Bits(2048)); // 2048/2050 平局取偶 → 2048。
    expect(f16BitsToFloat(floatToF16Bits(2049))).toBe(2048);
    expect(f16BitsToFloat(floatToF16Bits(2049.9))).toBe(2050); // 更近 2050。
    expect(f16BitsToFloat(floatToF16Bits(65520))).toBe(Infinity); // ≥ 65520 → Inf。
    expect(f16BitsToFloat(floatToF16Bits(65519))).toBe(65504);
    expect(floatToF16Bits(6e-5)).toBe(0x03ef); // 6e-5 → 最近 denormal 格 1007×2^-24。
    expect(f16BitsToFloat(0x03ff)).toBeCloseTo(1023 * 2 ** -24, 15);
    expect(f16BitsToFloat(0x0001)).toBe(2 ** -24);
    expect(f16BitsToFloat(0x0006)).toBe(6 * 2 ** -24);
  });

  it("expands outward in signed value direction (min ≤ v ≤ max after conversion)", () => {
    const samples = [1, 1.0000001, -1.0000001, 0.1, -0.1, 1234.5678, -9876.5432, 3.3e-7, -3.3e-7, 2 ** -25];
    for (const value of samples) {
      const low = f16BitsToFloat(floatToF16Bits(value, "outwardLow"));
      const high = f16BitsToFloat(floatToF16Bits(value, "outwardHigh"));
      expect(low).toBeLessThanOrEqual(value);
      expect(high).toBeGreaterThanOrEqual(value);
      // 方向性：负数的 outwardLow 必须更负（数值方向而非尾数方向——sign-magnitude 回归）。
      if (value < 0) expect(low).toBeLessThanOrEqual(high);
    }
    expect(f16BitsToFloat(floatToF16Bits(-1.0000001, "outwardLow"))).toBeLessThan(-1);
    expect(f16BitsToFloat(floatToF16Bits(-1.0000001, "outwardHigh"))).toBe(-1);
  });

  it("handles f16 range overflow per rounding direction", () => {
    expect(floatToF16Bits(1e10)).toBe(0x7c00);
    expect(floatToF16Bits(1e10, "outwardLow")).toBe(0x7bff); // 有限最大值 65504 ≤ v。
    expect(floatToF16Bits(1e10, "outwardHigh")).toBe(0x7c00);
    expect(floatToF16Bits(-1e10, "outwardHigh")).toBe(0xfbff); // -65504 ≥ v。
    expect(floatToF16Bits(-1e10, "outwardLow")).toBe(0xfc00); // -Inf ≤ v。
  });

  it("keeps subnormals and tiny values on the denormal grid", () => {
    expect(floatToF16Bits(1e-8)).toBe(0x0000); // 0.17 格 → 最近 0。
    expect(f16BitsToFloat(floatToF16Bits(1e-8, "outwardHigh"))).toBe(2 ** -24);
    expect(floatToF16Bits(2 ** -25)).toBe(0x0000); // 0.5 格平局取偶 → 0。
    expect(floatToF16Bits(2 ** -25, "outwardHigh")).toBe(0x0001);
    expect(floatToF16Bits(0, "outwardHigh")).toBe(0x0000); // 零不外扩。
  });

  it("is deterministic across calls (bitwise)", () => {
    for (const value of [0.1, -2713.8234, 7.2e-7, 40000.5]) {
      for (const rounding of ["nearest", "outwardLow", "outwardHigh"] as const) {
        expect(floatToF16Bits(value, rounding)).toBe(floatToF16Bits(value, rounding));
      }
    }
  });
});
