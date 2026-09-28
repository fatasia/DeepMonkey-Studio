import { describe, expect, it } from "vitest";
import { ATMOSPHERE_HEIGHT_M, EARTH_RADIUS_M, perezLuminanceDistribution, preethamZenithLuminanceKcd,
  rayleighPhase, sampleAnalyticSky, sampleSkyReference, solarTransmittance, solarVisibility,
  viewPathLengthMeters } from "./skyReference.js";
import type { SkyReferenceParameters, Vec3 } from "./skyReference.js";

const deg = (value: number): number => value * Math.PI / 180;
/** ENU 方向:方位角自北顺时针,仰角地平 0。 */
function enu(azimuthDeg: number, elevationDeg: number): Vec3 {
  const azimuth = deg(azimuthDeg);
  const elevation = deg(elevationDeg);
  const cosElevation = Math.cos(elevation);
  return [cosElevation * Math.sin(azimuth), cosElevation * Math.cos(azimuth), Math.sin(elevation)];
}

const clearNoon: SkyReferenceParameters = {
  mode: "analytic", turbidity: 3, sunDirectionEnu: enu(180, 45),
};
const clearNoonPerez: SkyReferenceParameters = { ...clearNoon, mode: "perez" };

describe("analytic single-scattering sky (structure & physics)", () => {
  it("is nonnegative everywhere on a daylit probe grid", () => {
    const parameters: SkyReferenceParameters = { ...clearNoon, sunDirectionEnu: enu(180, 20) };
    for (const azimuth of [0, 45, 90, 135, 180, 225, 270, 315]) {
      for (const elevation of [1, 10, 30, 60, 85]) {
        const sample = sampleSkyReference(parameters, enu(azimuth, elevation));
        for (const channel of sample.rgb) expect(channel).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it("is brighter at the horizon than the zenith (optically thin forward-scattering regime)", () => {
    const zenith = sampleSkyReference(clearNoon, enu(0, 89.9));
    const horizon = sampleSkyReference(clearNoon, enu(0, 1));
    expect(horizon.rgb[1]).toBeGreaterThan(zenith.rgb[1] * 1.5);
  });
  it("has a circumsolar peak: sun azimuth brighter than anti-solar at equal elevation", () => {
    const toward = sampleSkyReference(clearNoon, enu(180, 30));
    const away = sampleSkyReference(clearNoon, enu(0, 30));
    expect(toward.rgb[1]).toBeGreaterThan(away.rgb[1]);
  });
  it("produces a blue zenith at high sun and reddening at the horizon near sunset", () => {
    const zenith = sampleSkyReference(clearNoon, enu(0, 90));
    expect(zenith.rgb[2]).toBeGreaterThan(zenith.rgb[0]); // 蓝 > 红(瑞利 1/λ⁴)
    const parameters: SkyReferenceParameters = { ...clearNoon, sunDirectionEnu: enu(180, 1) };
    const sunsetHorizon = sampleSkyReference(parameters, enu(180, 1));
    expect(sunsetHorizon.rgb[0]).toBeGreaterThan(sunsetHorizon.rgb[2]); // 日落红 > 蓝(蓝被长路径消光)
  });
  it("decays to near-zero for deep night (sun below the twilight window)", () => {
    const night: SkyReferenceParameters = { ...clearNoon, sunDirectionEnu: enu(180, -6) };
    const sample = sampleSkyReference(night, enu(0, 45));
    expect(sample.rgb[1]).toBeLessThan(1e-12);
  });
  it("is bitwise deterministic for identical inputs", () => {
    const view = enu(33, 42);
    const first = sampleSkyReference(clearNoon, view);
    const second = sampleSkyReference({ ...clearNoon }, [...view] as Vec3);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("perez luminance model (Preetham'99 formulas)", () => {
  it("normalizes the zenith view to exactly 1 (F(θ,γ)/F(0,θs) per the paper) and stays nonnegative", () => {
    const sunZenith = deg(45);
    const zenithView = perezLuminanceDistribution(1, Math.cos(sunZenith), 3, sunZenith);
    expect(zenithView.relative).toBe(1);
    for (const elevation of [5, 20, 45, 70, 85]) {
      for (const gamma of [0, 30, 90, 180]) {
        const cosView = Math.sin(deg(90 - elevation));
        const cosGamma = Math.cos(deg(gamma));
        expect(perezLuminanceDistribution(cosView, cosGamma, 3, sunZenith).relative).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it("is horizon-bright and circumsolar for a clear turbidity-3 sky", () => {
    const parameters = clearNoonPerez;
    const zenithLuminance = sampleSkyReference(parameters, enu(0, 90)).luminanceKcdPerM2!;
    const horizonLuminance = sampleSkyReference(parameters, enu(0, 5)).luminanceKcdPerM2!;
    const circumsolar = sampleSkyReference(parameters, enu(180, 44)).luminanceKcdPerM2!;
    const antiSolar = sampleSkyReference(parameters, enu(0, 44)).luminanceKcdPerM2!;
    expect(horizonLuminance).toBeGreaterThan(zenithLuminance);
    expect(circumsolar).toBeGreaterThan(antiSolar);
    expect(zenithLuminance).toBeGreaterThan(0.1);
  });
  it("gives positive zenith luminance across the validity grid and flags the known overhead-sun artifact", () => {
    for (const turbidity of [2, 3, 5, 10]) {
      for (const sunElevation of [5, 20, 40, 60]) {
        const result = preethamZenithLuminanceKcd(turbidity, deg(90 - sunElevation));
        expect(result.valid).toBe(true);
        expect(result.kcd).toBeGreaterThan(0);
      }
    }
    // 已知限制(如实声明):太阳近天顶时 χ > π/2,论文式给负值或失控 → valid=false。
    for (const turbidity of [2, 3, 5, 10]) {
      expect(preethamZenithLuminanceKcd(turbidity, deg(90 - 85)).valid).toBe(false);
    }
    expect(preethamZenithLuminanceKcd(2, deg(90 - 89.5)).valid).toBe(false);
  });
  it("returns chroma ratios around 1 and an absolute luminance scale", () => {
    const sample = sampleSkyReference(clearNoonPerez, enu(90, 30));
    for (const channel of sample.rgb) {
      expect(channel).toBeGreaterThan(0);
      expect(channel).toBeLessThan(10);
    }
    expect(sample.luminanceKcdPerM2).not.toBeNull();
  });
});

describe("shared math", () => {
  it("rayleigh phase equals 3/(16π)(1+cos²γ) at the analytic limits", () => {
    expect(rayleighPhase(1)).toBeCloseTo(3 / (16 * Math.PI) * 2, 15);
    expect(rayleighPhase(0)).toBeCloseTo(3 / (16 * Math.PI), 15);
  });
  it("caps the horizon view path with earth curvature (~319 km for 8 km atmosphere)", () => {
    const expected = Math.sqrt(2 * EARTH_RADIUS_M * ATMOSPHERE_HEIGHT_M + ATMOSPHERE_HEIGHT_M ** 2);
    expect(viewPathLengthMeters(0)).toBeCloseTo(expected, 4);
    expect(viewPathLengthMeters(1)).toBeCloseTo(ATMOSPHERE_HEIGHT_M, 9);
  });
  it("fades the sun smoothly across the twilight window", () => {
    expect(solarVisibility(deg(1) * 0 + Math.sin(deg(2)))).toBe(1);
    expect(solarVisibility(Math.sin(deg(-4.5)))).toBe(0);
    expect(solarVisibility(Math.sin(deg(-2)))).toBeGreaterThan(0);
    expect(solarVisibility(Math.sin(deg(-2)))).toBeLessThan(1);
  });
  it("keeps solar transmittance in (0,1], channel-monotone, and redder at high air mass", () => {
    const high = solarTransmittance({ ...clearNoon, sunDirectionEnu: enu(180, 60) });
    for (const channel of high) {
      expect(channel).toBeGreaterThan(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
    const low = solarTransmittance({ ...clearNoon, sunDirectionEnu: enu(180, 2) });
    expect(low[0]).toBeGreaterThan(low[2]); // 高气团时红透射 > 蓝
    for (let channel = 0; channel < 3; channel += 1) expect(low[channel]).toBeLessThan(high[channel]);
  });
  it("rejects invalid turbidity and non-unit directions", () => {
    expect(() => sampleSkyReference({ ...clearNoon, turbidity: 1 }, enu(0, 45))).toThrow(/turbidity/);
    expect(() => sampleSkyReference({ ...clearNoon, turbidity: 20 }, enu(0, 45))).toThrow(/turbidity/);
    expect(() => sampleSkyReference(clearNoon, [2, 0, 0])).toThrow(/unit/);
    expect(() => sampleSkyReference({ ...clearNoon, sunDirectionEnu: [0, 0, 2] }, enu(0, 45))).toThrow(/unit/);
  });
});

describe("recorded golden grid (regression pin, f64)", () => {
  it("pins analytic and perez samples (recorded from this implementation)", () => {
    const view = enu(135, 30);
    const analytic = sampleSkyReference(clearNoon, view);
    expect(analytic.rgb[0]).toBeCloseTo(0.01702953303051129, 15);
    expect(analytic.rgb[1]).toBeCloseTo(0.02110122725495093, 15);
    expect(analytic.rgb[2]).toBeCloseTo(0.023953153313245663, 15);
    const perez = sampleSkyReference(clearNoonPerez, view);
    expect(perez.luminanceKcdPerM2).toBeCloseTo(1.1509592164594398, 12);
    expect(perez.rgb[0]).toBeCloseTo(2.5140175489515006, 12);
    expect(perez.rgb[2]).toBeCloseTo(1.999930315438936, 12);
  });
});
