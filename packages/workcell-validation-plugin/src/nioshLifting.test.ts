import { describe, expect, it } from "vitest";
import { computeNioshLifting, NIOSH_LOAD_CONSTANT_KG, formatNioshMultiplierSet } from "./nioshLifting.js";

/** 35 lb 换算 kg(手册算例 2 的载荷)。 */
const LOAD_35_LB_KG = 35 * 0.45359237;

describe("NIOSH 1994 lifting equation (RWL/LI)", () => {
  it("returns the 23 kg load constant under all-ideal task conditions", () => {
    const score = computeNioshLifting({
      loadMassKg: 23,
      horizontalCm: 25,
      verticalOriginCm: 75,
      travelCm: 25,
      asymmetryDeg: 0,
      liftsPerMinute: 0.2,
      durationCategory: "short",
      coupling: "good",
    });
    expect(score.multipliers).toEqual({ hm: 1, vm: 1, dm: 1, am: 1, fm: 1, cm: 1 });
    expect(score.recommendedWeightLimitKg).toBe(23);
    expect(score.liftingIndex).toBe(1);
  });

  it("reproduces Applications Manual Example 2 (origin) within the imperial/metric rounding gap", () => {
    // 手册算例 2(94-110 第 59 页):15.88 kg 纸卷,H=15in(38.1cm),V=27in(68.58cm),
    // D=17in(43.18cm),A=0°,F<0.2(按 0.2),≤1h,差耦合;文献 RWL=28.0 lb(12.70 kg)。
    const score = computeNioshLifting({
      loadMassKg: LOAD_35_LB_KG,
      horizontalCm: 38.1,
      verticalOriginCm: 68.58,
      travelCm: 43.18,
      asymmetryDeg: 0,
      liftsPerMinute: 0.1,
      durationCategory: "short",
      coupling: "poor",
    });
    // 公制公式复算 = 23×(25/38.1)×(1−0.003|68.58−75|)×(0.82+4.5/43.18)×1×1×0.90 ≈ 12.31 kg(27.1 lb)。
    // 与文献 28.0 lb 的差 3.1%,来自手册工作表用英制乘数(25cm≠10in 的整散)取两位小数所致。
    expect(score.recommendedWeightLimitKg).toBeCloseTo(12.31, 1);
    expect(Math.abs(score.recommendedWeightLimitKg - 28.0 * 0.45359237) / (28.0 * 0.45359237)).toBeLessThan(0.05);
    // 手册 LI = 35/28.0 = 1.25 → 1.3;公制复算 15.88/12.31 = 1.29,同档。
    expect(score.liftingIndex).toBe(1.29);
  });

  it("reproduces Applications Manual Example 2 (destination) within tolerance", () => {
    // 同算例终点:H=20in(50.8cm),V=10in(25.4cm),D=17in,A=0,差耦合;文献 RWL=18.1 lb(8.21 kg)。
    const score = computeNioshLifting({
      loadMassKg: LOAD_35_LB_KG,
      horizontalCm: 50.8,
      verticalOriginCm: 25.4,
      travelCm: 43.18,
      asymmetryDeg: 0,
      liftsPerMinute: 0.2,
      durationCategory: "short",
      coupling: "poor",
    });
    expect(score.recommendedWeightLimitKg).toBeCloseTo(8.01, 1);
    expect(Math.abs(score.recommendedWeightLimitKg - 18.1 * 0.45359237) / (18.1 * 0.45359237)).toBeLessThan(0.05);
  });

  it("matches the printed multiplier arithmetic of the manual worksheet exactly (imperial, literature values)", () => {
    // 手册工作表(Figure 9)用两位小数英制乘数:起点 51×0.67×0.98×0.93×1.00×0.90 = 28.03 → "28.0 Lbs"。
    const origin = 51 * 0.67 * 0.98 * 0.93 * 1.0 * 0.9;
    expect(origin).toBeCloseTo(28.03, 2);
    expect(Number(origin.toFixed(1))).toBe(28.0);
    // 终点 51×0.50×0.85×0.93×1.00×0.90 = 18.14 → "18.1 Lbs";LI 35/28.0=1.3、35/18.1=1.9。
    const destination = 51 * 0.5 * 0.85 * 0.93 * 1.0 * 0.9;
    expect(Number(destination.toFixed(1))).toBe(18.1);
    expect(Number((35 / 28.0).toFixed(1))).toBe(1.3);
    expect(Number((35 / 18.1).toFixed(1))).toBe(1.9);
  });

  it("returns the documented FM table cells (94-110 Table 5, double-sourced)", () => {
    const base = { loadMassKg: 10, horizontalCm: 25, verticalOriginCm: 75, travelCm: 25, asymmetryDeg: 0, coupling: "good" as const };
    const fm = (liftsPerMinute: number, durationCategory: "short" | "moderate" | "long", verticalOriginCm: number) =>
      computeNioshLifting({ ...base, liftsPerMinute, durationCategory, verticalOriginCm }).multipliers.fm;
    // 同一数值在 1994 原书第 26 页扫描件与 Waters 2012 章节 Table 33.5 两处逐值一致。
    expect(fm(1, "short", 75)).toBe(0.94);
    expect(fm(1, "short", 50)).toBe(0.94);
    expect(fm(5, "moderate", 100)).toBe(0.6);
    expect(fm(9, "long", 100)).toBe(0.15);
    expect(fm(12, "short", 50)).toBe(0.37);
    expect(fm(13, "short", 100)).toBe(0.34);
    // 频率低于 0.2 按 0.2 处理(FM=1);未列出的频率向上取表内行(保守侧,2.5→3 行 0.88)。
    expect(fm(0.05, "short", 75)).toBe(1);
    expect(fm(2.5, "short", 75)).toBe(0.88);
  });

  it("zeroes the RWL on officially prohibited combinations and keeps the reason", () => {
    const base = { loadMassKg: 10, travelCm: 25, asymmetryDeg: 0, liftsPerMinute: 1, durationCategory: "short" as const, coupling: "good" as const };
    const horizontal = computeNioshLifting({ ...base, horizontalCm: 70, verticalOriginCm: 75 });
    expect(horizontal.recommendedWeightLimitKg).toBe(0);
    expect(horizontal.liftingIndex).toBeNull();
    expect(horizontal.prohibitedReason).toContain("63");

    const tooHigh = computeNioshLifting({ ...base, horizontalCm: 25, verticalOriginCm: 180 });
    expect(tooHigh.recommendedWeightLimitKg).toBe(0);
    expect(tooHigh.prohibitedReason).toContain("175");

    const twisted = computeNioshLifting({ ...base, horizontalCm: 25, verticalOriginCm: 75, asymmetryDeg: 140 });
    expect(twisted.recommendedWeightLimitKg).toBe(0);
    expect(twisted.prohibitedReason).toContain("135");

    const tooFrequent = computeNioshLifting({ ...base, horizontalCm: 25, verticalOriginCm: 75, liftsPerMinute: 16 });
    expect(tooFrequent.recommendedWeightLimitKg).toBe(0);
    expect(tooFrequent.prohibitedReason).toContain("15");

    // 表内 0 值组合:长时程(V<75cm)9 次/分官方 FM=0。
    const fmZero = computeNioshLifting({ ...base, horizontalCm: 25, verticalOriginCm: 50, liftsPerMinute: 9, durationCategory: "long" });
    expect(fmZero.recommendedWeightLimitKg).toBe(0);
    expect(fmZero.liftingIndex).toBeNull();
    expect(fmZero.prohibitedReason).toContain("FM");
  });

  it("clamps D below 25cm to the official minimum and decreases RWL monotonically with load", () => {
    const base = { loadMassKg: 10, horizontalCm: 30, verticalOriginCm: 75, asymmetryDeg: 0, liftsPerMinute: 1, durationCategory: "short" as const, coupling: "fair" as const };
    const clamped = computeNioshLifting({ ...base, travelCm: 10 });
    expect(clamped.multipliers.dm).toBe(1);
    const longer = computeNioshLifting({ ...base, travelCm: 100 });
    expect(longer.multipliers.dm).toBeLessThan(clamped.multipliers.dm!);
  });

  it("is deterministic and rejects invalid inputs", () => {
    const factors = { loadMassKg: 12, horizontalCm: 40, verticalOriginCm: 60, travelCm: 50, asymmetryDeg: 30, liftsPerMinute: 2, durationCategory: "moderate" as const, coupling: "fair" as const };
    expect(computeNioshLifting(factors)).toEqual(computeNioshLifting(factors));
    expect(() => computeNioshLifting({ ...factors, loadMassKg: Number.NaN })).toThrow();
    expect(() => computeNioshLifting({ ...factors, horizontalCm: -1 })).toThrow();
    expect(() => computeNioshLifting({ ...factors, loadMassKg: 5000 })).toThrow();
  });

  it("exposes the load constant and a readable multiplier summary", () => {
    expect(NIOSH_LOAD_CONSTANT_KG).toBe(23);
    const score = computeNioshLifting({ loadMassKg: 8, horizontalCm: 25, verticalOriginCm: 75, travelCm: 25, asymmetryDeg: 0, liftsPerMinute: 0.2, durationCategory: "short", coupling: "good" });
    expect(formatNioshMultiplierSet(score.multipliers)).toContain("FM=1");
  });
});
