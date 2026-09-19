import { describe, expect, it } from "vitest";
import { iesTotalLuminousFlux, parseIesProfile, summarizeIesProfile } from "./iesProfile";

/** 恒定 1000cd、0–90° 全角锥：解析解 Φ = I·2π·(1−cos90°) = 6283.19 lm。 */
function coneFixture(candela = 1000, steps = 9): string {
  const vertical = Array.from({ length: steps + 1 }, (_, i) => Number((i * (90 / steps)).toFixed(3)));
  const rows = Array.from({ length: 1 }, () => vertical.map(() => candela.toFixed(1)).join(" "));
  return [
    "IESNA:LM-63-2002",
    "[TEST] UT-CONE",
    "[MANUFAC] Deep Monkey Studio",
    "[LAMP] 合成检验光源",
    "TILT=NONE",
    "1 1000 1.0 10 1 1 1 1 1 0",
    "1.0 1.0 60",
    vertical.join(" "),
    "0",
    ...rows,
    "",
  ].join("\n");
}

describe("IES LM-63 profile", () => {
  it("parses metadata, header and the candela grid", () => {
    const profile = parseIesProfile(coneFixture());
    expect(profile.format).toBe("LM-63-2002");
    expect(profile.metadata.MANUFAC).toBe("Deep Monkey Studio");
    expect(profile.tilt).toBe("NONE");
    expect(profile.lampCount).toBe(1);
    expect(profile.verticalAngles).toHaveLength(10);
    expect(profile.horizontalAngles).toEqual([0]);
    expect(profile.candela).toHaveLength(1);
    expect(profile.candela[0]).toHaveLength(10);
    expect(profile.candela[0][0]).toBeCloseTo(1000, 3);
    expect(profile.inputWatts).toBe(60);
  });

  it("integrates a uniform cone to the analytic luminous flux", () => {
    const profile = parseIesProfile(coneFixture(1000));
    // 解析解 1000 × 2π × (cos0 − cos90°) = 6283.185 lm，数值积分应高度接近。
    expect(iesTotalLuminousFlux(profile)).toBeCloseTo(6283.185, 1);
    const summary = summarizeIesProfile(profile);
    expect(summary.maxCandela).toBe(1000);
    expect(summary.beamAngleDegrees).toBe(90);
  });

  it("applies symmetry factor 4 for 0-90 horizontal sweeps", () => {
    const text = [
      "IESNA:LM-63-2002",
      "TILT=NONE",
      "1 -1 1.0 3 3 1 1 1 1 0",
      "1.0 1.0 0",
      "0 45 90",
      "0 45 90",
      "500 500 500",
      "500 500 500",
      "500 500 500",
    ].join("\n");
    const profile = parseIesProfile(text);
    // 全交叉积分：Σ_h Δφ_h × Σ_v (cosθ₁−cosθ₂) = (π/2)×1，×4 对称 → 500×2π = 3141.59。
    expect(iesTotalLuminousFlux(profile)).toBeCloseTo(500 * 2 * Math.PI, 1);
  });

  it("rejects tilt data and malformed grids with precise errors", () => {
    expect(() => parseIesProfile(coneFixture().replace("TILT=NONE", "TILT=INCLUDE"))).toThrowError(/TILT=INCLUDE/);
    const shortGrid = [
      "IESNA:LM-63-2002",
      "TILT=NONE",
      "1 1000 1.0 2 1 1 1 1 1 0",
      "1.0 1.0 60",
      "0 90",
      "0",
      "1000.0",
    ].join("\n");
    expect(() => parseIesProfile(shortGrid)).toThrowError(/数值总数不符|坎德拉数据不足/);
    expect(() => parseIesProfile("not an ies file")).toThrowError(/无法识别的行|疑似非 IES 文件/);
  });

  it("rejects descending vertical angles", () => {
    const text = [
      "IESNA:LM-63-2002",
      "TILT=NONE",
      "1 1000 1.0 3 1 1 1 1 1 0",
      "1.0 1.0 60",
      "45 22.5 0",
      "0",
      "1000.0 1000.0 1000.0",
    ].join("\n");
    expect(() => parseIesProfile(text)).toThrowError(/非降序/);
  });
});
