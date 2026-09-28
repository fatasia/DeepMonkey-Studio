import { describe, expect, it } from "vitest";
import { WEATHER_ENVIRONMENT_PARAMS, srgbHexToLinearRgb, weatherEnvironment,
  weatherTransition, weatherTransitionDurationSeconds } from "./weatherStates.js";
import { equivalentBeerExtinction } from "./fogReference.js";

// 契约漂移哨兵:单点事实来源在 packages/contracts/src/sceneWeatherFog.ts(WEATHER_EXP2_FOG_V1,
// v1 冻结值,sceneWeatherFog.test.ts 守护合同侧)。deep-engine 不声明 contracts 依赖
// (零新依赖纪律),此处以逐位副本守候;合同任何改动都会让本表失配而变红,
// 届时必须同步引擎副本并复核等透射换算,不得静默跟随。
const CONTRACT_WEATHER_FOG_V1: Readonly<Record<string, { colorSrgbHex: string; density: number }>> = {
  sunny: { colorSrgbHex: "#9fc2d4", density: 0.0018 },
  cloudy: { colorSrgbHex: "#87939a", density: 0.0042 },
  rain: { colorSrgbHex: "#64717a", density: 0.008 },
  snow: { colorSrgbHex: "#c5cdd1", density: 0.006 },
  fog: { colorSrgbHex: "#aab4b7", density: 0.018 },
  storm: { colorSrgbHex: "#38454f", density: 0.012 },
};
const ALL_MODES: readonly WeatherModeUnion[] = ["sunny", "cloudy", "rain", "snow", "fog", "storm"];
type WeatherModeUnion = Parameters<typeof weatherEnvironment>[0];

describe("weather → environment parameter mapping", () => {
  it("matches the contracts sceneWeatherFog v1 frozen values bitwise (drift sentinel)", () => {
    for (const mode of ALL_MODES) {
      const contract = CONTRACT_WEATHER_FOG_V1[mode];
      const engine = weatherEnvironment(mode);
      expect(engine.fogColorSrgbHex).toBe(contract.colorSrgbHex);
      expect(engine.fogExp2Density).toBe(contract.density);
    }
  });
  it("derives volumetric baseExtinction by equal-transmittance conversion at the reference depth", () => {
    for (const mode of ALL_MODES) {
      const engine = weatherEnvironment(mode);
      expect(engine.volumetric.baseExtinction)
        .toBe(equivalentBeerExtinction(engine.fogExp2Density, 100));
      expect(engine.volumetric.scaleHeight).toBeGreaterThan(0);
      expect(engine.volumetric.albedo).toBeGreaterThan(0);
      expect(engine.volumetric.albedo).toBeLessThanOrEqual(1);
      expect(Math.abs(engine.volumetric.anisotropy)).toBeLessThan(0.99);
    }
    // 语义抽查:浓雾档消光比晴天档高两个量级。
    expect(weatherEnvironment("fog").volumetric.baseExtinction)
      .toBeGreaterThan(weatherEnvironment("sunny").volumetric.baseExtinction * 50);
  });
  it("keeps extension dimensions in physical ranges with the expected ordering", () => {
    for (const mode of ALL_MODES) {
      const params = WEATHER_ENVIRONMENT_PARAMS[mode];
      for (const scalar of [params.cloudiness, params.humidity, params.sunIntensityScale]) {
        expect(scalar).toBeGreaterThanOrEqual(0);
        expect(scalar).toBeLessThanOrEqual(1);
      }
      expect(params.precipitationRate).toBeGreaterThanOrEqual(0);
    }
    expect(weatherEnvironment("sunny").precipitationRate).toBe(0);
    expect(weatherEnvironment("storm").precipitationRate).toBeGreaterThan(weatherEnvironment("rain").precipitationRate);
    expect(weatherEnvironment("sunny").cloudiness).toBeLessThan(weatherEnvironment("cloudy").cloudiness);
    expect(weatherEnvironment("sunny").sunIntensityScale).toBeGreaterThan(weatherEnvironment("storm").sunIntensityScale);
  });
  it("is deterministic and throws on unknown modes", () => {
    expect(weatherEnvironment("fog")).toEqual(WEATHER_ENVIRONMENT_PARAMS.fog);
    expect(() => weatherEnvironment("hail" as WeatherMode)).toThrow(/Unknown weather/);
  });
});

describe("srgbHexToLinearRgb", () => {
  it("maps anchors exactly (black, white, and the 0.04045 pivot)", () => {
    expect(srgbHexToLinearRgb("#000000")).toEqual([0, 0, 0]);
    expect(srgbHexToLinearRgb("#ffffff")).toEqual([1, 1, 1]);
    expect(srgbHexToLinearRgb("#808080")[0]).toBeCloseTo(0.21586050011343005, 12);
  });
  it("rejects malformed hex", () => {
    expect(() => srgbHexToLinearRgb("#12345")).toThrow(/hex/);
    expect(() => srgbHexToLinearRgb("zzzzzz")).toThrow(/hex/);
  });
});

describe("weatherTransition (deterministic state machine)", () => {
  it("reproduces endpoints exactly at t=0 and t=1", () => {
    const start = weatherTransition("sunny", "fog", 0);
    const end = weatherTransition("sunny", "fog", 1);
    const sunny = weatherEnvironment("sunny");
    const foggy = weatherEnvironment("fog");
    expect(start.fogExp2Density).toBe(sunny.fogExp2Density);
    expect(start.volumetric.baseExtinction).toBe(sunny.volumetric.baseExtinction);
    expect(start.cloudiness).toBe(sunny.cloudiness);
    expect(end.fogExp2Density).toBe(foggy.fogExp2Density);
    expect(end.volumetric.baseExtinction).toBe(foggy.volumetric.baseExtinction);
    expect(end.humidity).toBe(foggy.humidity);
  });
  it("clamps t outside [0,1] and stays within endpoint ranges (density monotone in weight)", () => {
    expect(weatherTransition("sunny", "fog", -3).rawT).toBe(0);
    expect(weatherTransition("sunny", "fog", 7).rawT).toBe(1);
    const minDensity = Math.min(weatherEnvironment("sunny").fogExp2Density, weatherEnvironment("fog").fogExp2Density);
    const maxDensity = Math.max(weatherEnvironment("sunny").fogExp2Density, weatherEnvironment("fog").fogExp2Density);
    for (let step = 0; step <= 20; step += 1) {
      const sample = weatherTransition("sunny", "fog", step / 20);
      expect(sample.fogExp2Density).toBeGreaterThanOrEqual(minDensity);
      expect(sample.fogExp2Density).toBeLessThanOrEqual(maxDensity);
      expect(sample.cloudiness).toBeGreaterThanOrEqual(0);
      expect(sample.cloudiness).toBeLessThanOrEqual(1);
    }
  });
  it("interpolates density in log space (midpoint = geometric mean)", () => {
    const sunny = weatherEnvironment("sunny").fogExp2Density;
    const foggy = weatherEnvironment("fog").fogExp2Density;
    const midpoint = weatherTransition("sunny", "fog", 0.5);
    expect(midpoint.fogExp2Density).toBeCloseTo(Math.sqrt(sunny * foggy), 12);
    expect(midpoint.volumetric.baseExtinction)
      .toBeCloseTo(Math.sqrt(weatherEnvironment("sunny").volumetric.baseExtinction
        * weatherEnvironment("fog").volumetric.baseExtinction), 12);
  });
  it("is time-symmetric: swapped endpoints at complementary t give equal densities", () => {
    const forward = weatherTransition("cloudy", "storm", 0.3);
    const backward = weatherTransition("storm", "cloudy", 0.7);
    // smoothstep 权重和为 1;对数插值下 a^{1−w}·b^w 与 b^{1−(1−w)}·a^{1−w} 相等。
    expect(forward.weight + backward.weight).toBeCloseTo(1, 12);
    expect(forward.fogExp2Density).toBe(backward.fogExp2Density);
    expect(weatherTransition("rain", "fog", 0.42)).toEqual(weatherTransition("rain", "fog", 0.42));
  });
  it("interpolates color in linear space with sRGB endpoints", () => {
    const from = srgbHexToLinearRgb(weatherEnvironment("sunny").fogColorSrgbHex);
    const to = srgbHexToLinearRgb(weatherEnvironment("fog").fogColorSrgbHex);
    const mid = weatherTransition("sunny", "fog", 0.5);
    for (let channel = 0; channel < 3; channel += 1) {
      expect(mid.fogColorLinearRgb[channel]).toBeGreaterThanOrEqual(Math.min(from[channel], to[channel]) - 1e-12);
      expect(mid.fogColorLinearRgb[channel]).toBeLessThanOrEqual(Math.max(from[channel], to[channel]) + 1e-12);
    }
  });
  it("is identity for same-mode transitions", () => {
    const idle = weatherTransition("rain", "rain", 0.5);
    expect(idle.weight).toBe(0.5);
    expect(idle.fogExp2Density).toBe(weatherEnvironment("rain").fogExp2Density);
  });
});

describe("weatherTransitionDurationSeconds", () => {
  it("is zero for identical modes and bounded to [2, 8] otherwise", () => {
    expect(weatherTransitionDurationSeconds("fog", "fog")).toBe(0);
    for (const from of ALL_MODES) {
      for (const to of ALL_MODES) {
        if (from === to) continue;
        const duration = weatherTransitionDurationSeconds(from, to);
        expect(duration).toBeGreaterThanOrEqual(2);
        expect(duration).toBeLessThanOrEqual(8);
      }
    }
    expect(weatherTransitionDurationSeconds("sunny", "fog"))
      .toBeGreaterThan(weatherTransitionDurationSeconds("sunny", "cloudy"));
  });
});
