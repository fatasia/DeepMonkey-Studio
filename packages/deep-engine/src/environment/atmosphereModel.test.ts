import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_M } from "./skyReference.js";
import {
  ATMOSPHERE_GRID, ATMOSPHERE_REFERENCE_TURBIDITY, SUN_COSINE_TABLE_MIN,
  distanceToTop, mieScatteringCoefficient, opticalDepthToTop, rayleighPhaseFunction,
  singleScatteringSource, sunlit, viewMuFromTableU, viewRayHeight,
} from "./atmosphereModel.js";
import { RAYLEIGH_BETA_RGB } from "./skyReference.js";

/** I-C6 物理核心:球面几何/地影/单散射积分的解析对拍与守恒界。 */

describe("I-C6 atmosphereModel 球面几何", () => {
  it("天顶方向到大气顶的距离 ≈ 大气顶海拔(垂直弦长解析)", () => {
    expect(distanceToTop(0, 1)).toBeCloseTo(60000, 0);
  });

  it("地平方向弦长 = 球面几何解析解 sqrt((R+H)²-R²)", () => {
    const analytic = Math.sqrt((EARTH_RADIUS_M + 60000) ** 2 - EARTH_RADIUS_M ** 2);
    expect(distanceToTop(0, 0)).toBeCloseTo(analytic, 4);
  });

  it("视线弦上海拔单调且端点一致:起点 0、终点大气顶", () => {
    const viewMu = 0.7;
    const total = distanceToTop(0, viewMu);
    expect(viewRayHeight(0, viewMu)).toBeCloseTo(0, 6);
    expect(viewRayHeight(total, viewMu)).toBeCloseTo(60000, 3);
    expect(viewRayHeight(total / 2, viewMu)).toBeGreaterThan(0);
    expect(viewRayHeight(total / 2, viewMu)).toBeLessThan(60000);
  });

  it("地影:太阳在地平上恒照亮;地平下近点地影、足够高的点可被照亮(暮色物理)", () => {
    expect(sunlit(0, 0.1)).toBe(true);
    expect(sunlit(0, -0.01)).toBe(false);
    // 太阳 -5°:地面地影;几何判据 (R+z)·cos5° ≥ R → z ≥ R·(1/cos5°-1) ≈ 24.4 km。
    const sunMu = Math.sin(-5 * Math.PI / 180);
    expect(sunlit(20000, sunMu)).toBe(false);
    expect(sunlit(30000, sunMu)).toBe(true);
  });

  it("透射单调:太阳越高透射越高,蓝光消光强于红光(Rayleigh 1/λ⁴)", () => {
    const mie = mieScatteringCoefficient(ATMOSPHERE_REFERENCE_TURBIDITY);
    const at = (mu: number): readonly [number, number, number] => opticalDepthToTop(0, mu, mie);
    const high = at(1), mid = at(0.5);
    for (let channel = 0; channel < 3; channel += 1) expect(high[channel]!).toBeLessThan(mid[channel]!);
    expect(mid[2]!).toBeGreaterThan(mid[0]! * 2); // 蓝(450nm)消光 > 2× 红(680nm)
  });
});

describe("I-C6 atmosphereModel 单散射积分", () => {
  const mie = mieScatteringCoefficient(ATMOSPHERE_REFERENCE_TURBIDITY);

  it("源非负、蓝移(天顶视线 Rayleigh 源蓝通道最大),与 T09 同家族系数", () => {
    const source = singleScatteringSource(1, 0.8, mie, 0.8);
    for (const plane of [source.rayleigh, source.mie]) {
      for (const value of plane) expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(source.rayleigh[2]!).toBeGreaterThan(source.rayleigh[0]!);
    // 与 T09 RAYLEIGH_BETA_RGB 同源:Mie 系数 = β_R,g × 0.75 × (T/4)
    expect(mie).toBeCloseTo(RAYLEIGH_BETA_RGB[1]! * 0.75, 12);
  });

  it("太阳地平下(地影)源趋零;太阳升高源增大", () => {
    const night = singleScatteringSource(1, Math.sin(-5 * Math.PI / 180), mie, 0);
    const day = singleScatteringSource(1, 0.8, mie, 0.8);
    expect(night.rayleigh[1]!).toBeLessThan(day.rayleigh[1]! * 0.1);
  });

  it("地平视线(长路径)源大于天顶视线(路径长度效应,地平增亮)", () => {
    const zenith = singleScatteringSource(1, 0.5, mie, 0.5);
    const horizon = singleScatteringSource(viewMuFromTableU(0.02, ATMOSPHERE_GRID.viewExponent), 0.5, mie, 0.5);
    expect(horizon.rayleigh[1]!).toBeGreaterThan(zenith.rayleigh[1]! * 1.5);
  });

  it("确定性:同输入重积分逐位相同(无 RNG 构造)", () => {
    const a = singleScatteringSource(0.6, 0.7, mie, 0.3);
    const b = singleScatteringSource(0.6, 0.7, mie, 0.3);
    expect(a.rayleigh).toEqual(b.rayleigh);
    expect(a.mie).toEqual(b.mie);
  });

  it("Rayleigh 相函数:归一化(全立体角积分为 1)且 90° 最小", () => {
    // 解析:∫(3/16π)(1+cos²γ)dΩ = 1。
    expect(rayleighPhaseFunction(1)).toBeCloseTo(3 / (8 * Math.PI), 12);
    expect(rayleighPhaseFunction(0)).toBeCloseTo(3 / (16 * Math.PI), 12);
  });

  it("表域常数:太阳域下限覆盖民用暮光,网格计数与运行时共享", () => {
    expect(SUN_COSINE_TABLE_MIN).toBeLessThan(-0.25);
    expect(ATMOSPHERE_GRID.singleViewCount).toBeGreaterThan(8);
  });
});
